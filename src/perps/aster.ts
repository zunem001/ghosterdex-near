/**
 * Aster's signing, pure: the message a request puts its name to, that
 * message's EIP-712 digest, and the signature bytes Aster reads. No key lives
 * here. The agent key (./agent) and the browser master (./local) hold keys and
 * call in; public/perps-pro.js sends what they return.
 *
 * ## How Aster signs
 *
 * Every private request is `application/x-www-form-urlencoded` parameters,
 * then `nonce` (the time in microseconds), `user` (the account's own wallet)
 * and `signer` (an agent that wallet approved), in that order. That string is
 * the `msg` of an EIP-712 document `Message(string msg)` under the domain
 * `AsterSignTransaction` v1, chainId 1666, verifying contract zero; the agent
 * key signs its digest and the signature rides along as one more parameter.
 * An agent is approved by `registerAndApproveAgent`, whose message is laid
 * out in a fixed order and signed by the wallet itself under chainId 56.
 *
 * Proven against Aster's testnet on 2026-10-07 with throwaway keys: the
 * approval was accepted, and the agent's reads then failed only for want of a
 * deposit. scripts/check-aster.mts pins those exact bytes.
 *
 * ## What never comes through here
 *
 * The master never signs its own requests: Aster refuses a signer that is not
 * an approved agent, so a venue request is always an agent's. Approvals are
 * made with trading rights only; `canWithdraw` would also demand a fixed
 * server address, and money leaving Aster is the wallet's own signature, a
 * later step.
 */
import * as secp from '@noble/secp256k1';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { toHex, typedDigest } from './eip712';

/* The sync signer needs this wired; harmless when ./agent already did it. */
secp.etc.hmacSha256Sync = (k: Uint8Array, ...m: Uint8Array[]) =>
  hmac(sha256, k, secp.etc.concatBytes(...m));

export const ASTER_HOSTS = {
  mainnet: 'https://fapi.asterdex.com',
  testnet: 'https://fapi.asterdex-testnet.com',
};
/** The domain every signed request uses. */
export const ASTER_REQUEST_CHAIN = 1666;
/** The domain an EVM wallet approves an agent under (Solana wallets use 101). */
export const ASTER_APPROVAL_CHAIN = 56;
const DOMAIN_NAME = 'AsterSignTransaction';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** The host for this build's network, read the way the Hyperliquid signers read it. */
export function asterHost(): string {
  const net = (globalThis as unknown as { window?: { __GHOSTER_NET?: string } }).window?.__GHOSTER_NET;
  return net === 'testnet' ? ASTER_HOSTS.testnet : ASTER_HOSTS.mainnet;
}

/**
 * Parameters as the string Aster reconstructs and the string that is sent,
 * which must be one and the same: the order given, form-encoded.
 */
export function asterMessage(params: Record<string, string>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) q.append(k, v);
  return q.toString();
}

export function asterDigest(chainId: number, msg: string): Uint8Array {
  return typedDigest(
    { name: DOMAIN_NAME, version: '1', chainId, verifyingContract: ZERO_ADDRESS },
    { Message: [{ name: 'msg', type: 'string' }] },
    'Message',
    { msg },
  );
}

/** 0x + r + s + v: the one shape Aster reads, and the one fund-pro's splitSig slices. */
export function signAsterDigest(d: Uint8Array, priv: Uint8Array): string {
  const sig = secp.sign(d, priv, { lowS: true });
  return toHex(sig.toCompactRawBytes()) + (27 + sig.recovery).toString(16).padStart(2, '0');
}

/* Microseconds, and never twice the same: Aster keeps an agent's last hundred
   nonces and refuses a repeat or one older than the smallest it holds. */
let lastNonce = 0n;
export function asterNonce(skewMs = 0): string {
  let n = BigInt(Date.now() + Math.round(skewMs)) * 1000n;
  if (n <= lastNonce) n = lastNonce + 1n;
  lastNonce = n;
  return String(n);
}

const RESERVED = ['nonce', 'user', 'signer', 'signature'];

/**
 * The query an agent-signed request sends: the parameters, then nonce, user
 * and signer, then the signature over exactly that string. GET requests put
 * it after `?`; POST and DELETE send it as the form body.
 */
export function asterSignedQuery(
  params: Record<string, string>,
  who: { user: string; signer: string },
  priv: Uint8Array,
  nonce = asterNonce(),
): string {
  for (const k of RESERVED) {
    if (k in params) throw new Error(`aster: ${k} is added here, not by the caller`);
  }
  const msg = asterMessage({ ...params, nonce, user: who.user, signer: who.signer });
  return msg + '&signature=' + signAsterDigest(asterDigest(ASTER_REQUEST_CHAIN, msg), priv);
}

export interface AsterApproval {
  /** The wallet that owns the account. */
  user: string;
  agentName: string;
  agentAddress: string;
  /** When the agent stops working, in milliseconds. */
  expired: number;
  nonce?: string;
}

/**
 * The approval's parameters, in the order Aster's message lays them out.
 * Trading only: no spot, no withdrawal, no server addresses.
 */
export function asterApprovalParams(a: AsterApproval): Record<string, string> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(a.user)) throw new Error('aster: the user is not an address');
  if (!/^0x[0-9a-fA-F]{40}$/.test(a.agentAddress)) throw new Error('aster: the agent is not an address');
  // Sixteen characters at most: Aster's testnet refused a nineteen-letter name as an "illegal parameter".
  if (!/^[a-z0-9-]{1,16}$/.test(a.agentName)) throw new Error('aster: an agent needs a short plain name, 16 characters or fewer');
  if (!(a.expired > Date.now())) throw new Error('aster: the approval would already have expired');
  return {
    user: a.user,
    nonce: a.nonce ?? asterNonce(),
    agentName: a.agentName,
    agentAddress: a.agentAddress,
    expired: String(Math.round(a.expired)),
    signatureChainId: String(ASTER_APPROVAL_CHAIN),
    canSpotTrade: 'false',
    canPerpTrade: 'true',
    canWithdraw: 'false',
    ipWhitelist: '',
  };
}

/** The approval's message and its signature by the wallet's own key. */
export function signAsterApproval(a: AsterApproval, userPriv: Uint8Array): { params: Record<string, string>; signature: string } {
  const params = asterApprovalParams(a);
  const msg = asterMessage(params);
  return { params, signature: signAsterDigest(asterDigest(ASTER_APPROVAL_CHAIN, msg), userPriv) };
}

/* ── orders ──────────────────────────────────────────────────────────────────
 *
 * What an order sends, decided here and nowhere else, so the rules can be
 * held to Aster's own documentation by a gate (scripts/check-aster.mts)
 * rather than discovered one refusal at a time on someone's money.
 *
 * Aster is strict about the shape: a parameter that does not belong to an
 * order's type (a timeInForce on a stop-market, a price on a take-profit-
 * market, a workingType on a limit) is refused as PARAM_NOT_REQUIRED, not
 * ignored. And about the numbers: a price off the tick, a quantity off the
 * step, a notional under the floor or a limit outside the band around the
 * mark price is refused too. So prices and sizes are snapped in integers on
 * the symbol's own grid and checked against its filters here, and a reader
 * hears why in words before anything is signed.
 *
 * "Market" is what it is on the terminal's Hyperliquid side: a limit order,
 * immediate-or-cancel, one percent through the price. It fills what the book
 * holds within that and never further, and stays inside Aster's band around
 * the mark (PERCENT_PRICE), which a true market order on a thin book does not.
 */

/** A symbol's trading rules, from exchangeInfo's filters. Decimals stay strings; rounding happens in integers. */
export interface AsterRules {
  tick: string;
  minPrice: string;
  maxPrice: string;
  step: string;
  minQty: string;
  maxQty: string;
  /** MIN_NOTIONAL: the smallest quantity × price, reduce-only orders excepted */
  minNotional: number;
  /** PERCENT_PRICE: a buy at most mark × up, a sell at least mark × down */
  up: number;
  down: number;
}

type Filter = Record<string, unknown> & { filterType?: unknown };

export function asterRules(filters: ReadonlyArray<Filter> | null | undefined): AsterRules {
  const of = (type: string): Filter => (filters || []).find((x) => x && x.filterType === type) || {};
  const pf = of('PRICE_FILTER');
  const lf = of('LOT_SIZE');
  const nf = of('MIN_NOTIONAL');
  const pp = of('PERCENT_PRICE');
  const str = (v: unknown) => (v == null || v === '' ? '0' : String(v));
  return {
    tick: str(pf.tickSize),
    minPrice: str(pf.minPrice),
    maxPrice: str(pf.maxPrice),
    step: str(lf.stepSize),
    minQty: str(lf.minQty),
    maxQty: str(lf.maxQty),
    minNotional: Number(nf.notional ?? nf.minNotional) || 0,
    up: Number(pp.multiplierUp) || 0,
    down: Number(pp.multiplierDown) || 0,
  };
}

/** "0.0010" as 1 at scale 3. */
function decimal(s: string): { n: bigint; scale: number } {
  const m = /^(\d*)(?:\.(\d*))?$/.exec(String(s).trim());
  if (!m) throw new Error(`aster: not a decimal: ${s}`);
  const frac = (m[2] || '').replace(/0+$/, '');
  return { n: BigInt((m[1] || '0') + frac), scale: frac.length };
}

function atScale(d: { n: bigint; scale: number }, scale: number): bigint {
  return d.n * 10n ** BigInt(scale - d.scale);
}

/** An integer at a scale, written the way Aster reads decimals: no exponent, no trailing zeros. */
function written(n: bigint, scale: number): string {
  if (scale === 0) return n.toString();
  const s = n.toString().padStart(scale + 1, '0');
  const whole = s.slice(0, -scale);
  const frac = s.slice(-scale).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

export type AsterSnap = 'floor' | 'ceil' | 'round';

/**
 * A number snapped onto a grid that starts at `min` and moves in `step`, as a
 * decimal string. Float noise is forgiven (0.1 + 0.2 is on the grid of 0.1),
 * real remainders go the way asked.
 */
export function asterSnap(v: number, step: string, min: string, mode: AsterSnap): string {
  const st = decimal(step);
  const mn = decimal(min);
  if (st.n === 0n) {
    /* no grid: the value as it is, to as many places as the minimum shows */
    return String(v);
  }
  const scale = Math.max(st.scale, mn.scale);
  const stepN = atScale(st, scale);
  const minN = atScale(mn, scale);
  const x = v * 10 ** scale;
  const nearest = Math.round(x);
  const exact = Math.abs(x - nearest) <= Math.abs(x) * 1e-12 + 1e-9;
  const X = exact ? BigInt(nearest) : BigInt(mode === 'ceil' ? Math.ceil(x) : mode === 'floor' ? Math.floor(x) : nearest);
  const off = X - minN;
  let k = off / stepN; // truncates toward zero
  const rem = off - k * stepN;
  if (rem !== 0n) {
    if (mode === 'ceil' && rem > 0n) k += 1n;
    else if (mode === 'floor' && rem < 0n) k -= 1n;
    else if (mode === 'round' && rem * 2n >= stepN) k += 1n;
    else if (mode === 'round' && rem * 2n <= -stepN) k -= 1n;
  }
  return written(minN + k * stepN, scale);
}

export class AsterOrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AsterOrderError';
  }
}

export type AsterKind = 'limit' | 'market' | 'stop' | 'stopMarket' | 'takeProfit' | 'takeProfitMarket';

export interface AsterOrderSpec {
  symbol: string;
  side: 'BUY' | 'SELL';
  kind: AsterKind;
  /** in the coin; never with closePosition */
  qty?: number;
  /** the limit price (limit, stop, takeProfit); for market, the price the one-percent band is taken from */
  price?: number;
  /** the trigger (stop, stopMarket, takeProfit, takeProfitMarket) */
  stopPrice?: number;
  /** limit orders: GTC (the default), IOC, or GTX for post-only */
  tif?: 'GTC' | 'IOC' | 'GTX';
  reduceOnly?: boolean;
  /** stopMarket and takeProfitMarket only: close the whole position when it fires */
  closePosition?: boolean;
  /** the mark price now: the band and the notional floor are measured from it */
  mark: number;
  /** market only: how far through the price the order may fill, 0.01 for one percent */
  slippage?: number;
}

const TYPE: Record<AsterKind, string> = {
  limit: 'LIMIT',
  market: 'LIMIT',
  stop: 'STOP',
  stopMarket: 'STOP_MARKET',
  takeProfit: 'TAKE_PROFIT',
  takeProfitMarket: 'TAKE_PROFIT_MARKET',
};

function money(v: number): string {
  return v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : String(Number(v.toPrecision(4)));
}

/**
 * The parameters of one order, in the order they are signed and sent, or an
 * AsterOrderError whose message is for the reader.
 */
export function asterOrderParams(o: AsterOrderSpec, r: AsterRules): Record<string, string> {
  const buy = o.side === 'BUY';
  if (o.side !== 'BUY' && o.side !== 'SELL') throw new Error('aster: side is BUY or SELL');
  if (!/^[A-Z0-9]{2,30}$/.test(o.symbol)) throw new Error(`aster: not a symbol: ${o.symbol}`);
  if (!TYPE[o.kind]) throw new Error(`aster: not an order kind: ${o.kind}`);
  if (!(o.mark > 0)) throw new AsterOrderError('No price from Aster yet. Try again in a moment.');
  const conditional = o.kind !== 'limit' && o.kind !== 'market';
  const closeAll = !!o.closePosition;
  if (closeAll && o.kind !== 'stopMarket' && o.kind !== 'takeProfitMarket') {
    throw new Error('aster: closePosition is for stopMarket and takeProfitMarket');
  }

  let price: string | undefined;
  if (o.kind === 'market') {
    const ref = Number(o.price) > 0 ? Number(o.price) : o.mark;
    const slip = o.slippage ?? 0.01;
    let p = buy ? ref * (1 + slip) : ref * (1 - slip);
    if (buy && r.up > 0) p = Math.min(p, o.mark * r.up);
    if (!buy && r.down > 0) p = Math.max(p, o.mark * r.down);
    /* inward, so the band's own edge is never crossed by rounding */
    price = asterSnap(p, r.tick, r.minPrice, buy ? 'floor' : 'ceil');
  } else if (o.kind === 'limit' || o.kind === 'stop' || o.kind === 'takeProfit') {
    if (!(Number(o.price) > 0)) throw new AsterOrderError('Set a price first.');
    price = asterSnap(Number(o.price), r.tick, r.minPrice, 'round');
    if (o.kind === 'limit') {
      if (buy && r.up > 0 && Number(price) > o.mark * r.up) {
        throw new AsterOrderError(`Aster takes a buy at most ${money(o.mark * r.up)} on this market now, ${Math.round((r.up - 1) * 100)}% over the mark price.`);
      }
      if (!buy && r.down > 0 && Number(price) < o.mark * r.down) {
        throw new AsterOrderError(`Aster takes a sell at least ${money(o.mark * r.down)} on this market now, ${Math.round((1 - r.down) * 100)}% under the mark price.`);
      }
    }
  }

  let stopPrice: string | undefined;
  if (conditional) {
    if (!(Number(o.stopPrice) > 0)) throw new AsterOrderError('Set the trigger price first.');
    stopPrice = asterSnap(Number(o.stopPrice), r.tick, r.minPrice, 'round');
  }
  for (const v of [price, stopPrice]) {
    if (v == null) continue;
    if (!(Number(v) > 0) || (Number(r.minPrice) > 0 && Number(v) < Number(r.minPrice))) {
      throw new AsterOrderError(`That price is under the smallest Aster takes on ${o.symbol} (${r.minPrice}).`);
    }
    if (Number(r.maxPrice) > 0 && Number(v) > Number(r.maxPrice)) {
      throw new AsterOrderError(`That price is over the largest Aster takes on ${o.symbol} (${r.maxPrice}).`);
    }
  }

  let quantity: string | undefined;
  if (!closeAll) {
    if (!(Number(o.qty) > 0)) throw new AsterOrderError('Enter a size first.');
    /* down, never up: an order is never larger than the one asked for, nor a close larger than the position */
    quantity = asterSnap(Number(o.qty), r.step, r.minQty, 'floor');
    if (!(Number(quantity) > 0) || Number(quantity) < Number(r.minQty)) {
      throw new AsterOrderError(`The smallest order on ${o.symbol} is ${r.minQty}.`);
    }
    if (Number(r.maxQty) > 0 && Number(quantity) > Number(r.maxQty)) {
      throw new AsterOrderError(`The largest single order on ${o.symbol} is ${r.maxQty}.`);
    }
    const at = Number(price ?? stopPrice ?? o.mark);
    const notional = Number(quantity) * at;
    if (!o.reduceOnly && r.minNotional > 0 && notional + 1e-9 < r.minNotional) {
      throw new AsterOrderError(`Aster's smallest order is $${money(r.minNotional)}. This one is $${notional.toFixed(2)}.`);
    }
  }

  const p: Record<string, string> = { symbol: o.symbol, side: o.side, type: TYPE[o.kind] };
  if (o.kind === 'market') p.timeInForce = 'IOC';
  else if (o.kind === 'limit') p.timeInForce = o.tif || 'GTC';
  if (quantity) p.quantity = quantity;
  if (price) p.price = price;
  if (stopPrice) p.stopPrice = stopPrice;
  if (o.reduceOnly && !closeAll) p.reduceOnly = 'true';
  if (closeAll) p.closePosition = 'true';
  /* triggers read the mark price, as Hyperliquid's do and as the sheet says */
  if (conditional) p.workingType = 'MARK_PRICE';
  p.newOrderRespType = 'RESULT';
  return p;
}

/**
 * The trigger order that guards a position: a take profit or a stop loss, on
 * the side that closes it, for a size or (without one, at market) the whole
 * position. A trigger on the wrong side of the mark would fire at once, so it
 * is refused here in words rather than by Aster's -2021.
 */
export function asterBracketParams(
  o: { symbol: string; long: boolean; tp: boolean; trigger: number; mark: number; qty?: number; asLimit?: boolean },
  r: AsterRules,
): Record<string, string> {
  const above = o.trigger > o.mark;
  /* a long's take profit and a short's stop sit above the mark; the other two below */
  if (o.long === o.tp ? !above : above) {
    throw new AsterOrderError(`That ${o.tp ? 'take profit' : 'stop loss'} is on the wrong side of the mark price.`);
  }
  const kind: AsterKind = o.tp ? (o.asLimit ? 'takeProfit' : 'takeProfitMarket') : (o.asLimit ? 'stop' : 'stopMarket');
  const whole = !(Number(o.qty) > 0);
  if (whole && o.asLimit) throw new Error('aster: a limit bracket needs a size');
  return asterOrderParams({
    symbol: o.symbol,
    side: o.long ? 'SELL' : 'BUY',
    kind,
    qty: whole ? undefined : o.qty,
    price: o.asLimit ? o.trigger : undefined,
    stopPrice: o.trigger,
    reduceOnly: !whole,
    closePosition: whole,
    mark: o.mark,
  }, r);
}

/* ── withdrawals ─────────────────────────────────────────────────────────────
 *
 * Money leaves Aster by `POST /fapi/v3/aster/user-withdraw` (the API repo's
 * demo/aster-deposit-withdrawal.md, "withdraw by fapi[v3] [evm] [futures]"),
 * which takes two signatures: the account's own wallet signs an EIP-712
 * "Withdraw" (domain Aster v1 under the payout chain's id, verifying contract
 * zero) naming the receiver, the chain, the token, the amount and the fee; and
 * the request itself carries the usual v3 signature, by a key approved with
 * the right to withdraw. Aster wants such a key tied to an IP list, takes IPv4
 * only (it refused "::/0" and mixed lists on its testnet, 2026-10-08), and its
 * API has no IPv6 address, so "0.0.0.0/0" is every reader. That key is no
 * door on its own: every withdrawal still needs the wallet's own signature,
 * and the wallet here only ever names its own address.
 */

/** Aster's names for the chains it pays out on. */
export const ASTER_CHAIN_NAMES: Record<number, string> = { 1: 'ETH', 56: 'BSC', 42161: 'Arbitrum' };

export interface AsterWithdraw {
  /** where it lands: the account's own address */
  destination: string;
  /** the payout chain: 56 for BNB Chain */
  chainId: number;
  /** Aster's name for the token, "USDT" */
  token: string;
  /** in token units as Aster writes them, "2.5" */
  amount: string;
  /** Aster's fee in token units, "0.11" */
  fee: string;
  /** microseconds; the same value travels as userNonce */
  nonce: string;
  /** "Mainnet" (the testnet's own name otherwise) */
  asterChain: string;
}

const DECIMAL = /^(0|[1-9]\d{0,11})(\.\d{1,8})?$/;

/** The digest the wallet signs for one withdrawal, held to ethers' own encoder by check:aster. */
export function asterWithdrawDigest(w: AsterWithdraw): Uint8Array {
  const chainName = ASTER_CHAIN_NAMES[w.chainId];
  if (!chainName) throw new Error(`aster: no payout chain ${w.chainId}`);
  if (!/^0x[0-9a-fA-F]{40}$/.test(w.destination)) throw new Error('aster: the receiver is not an address');
  if (!DECIMAL.test(w.amount) || !(Number(w.amount) > 0)) throw new Error('aster: not an amount');
  if (!DECIMAL.test(w.fee)) throw new Error('aster: not a fee');
  if (!/^\d{1,20}$/.test(w.nonce)) throw new Error('aster: not a nonce');
  if (!/^[A-Z0-9]{2,12}$/.test(w.token)) throw new Error('aster: not a token');
  return typedDigest(
    { name: 'Aster', version: '1', chainId: w.chainId, verifyingContract: ZERO_ADDRESS },
    {
      Action: [
        { name: 'type', type: 'string' },
        { name: 'destination', type: 'address' },
        { name: 'destination Chain', type: 'string' },
        { name: 'token', type: 'string' },
        { name: 'amount', type: 'string' },
        { name: 'fee', type: 'string' },
        { name: 'nonce', type: 'uint256' },
        { name: 'aster chain', type: 'string' },
      ],
    },
    'Action',
    {
      type: 'Withdraw',
      destination: w.destination.toLowerCase(),
      'destination Chain': chainName,
      token: w.token,
      amount: w.amount,
      fee: w.fee,
      nonce: w.nonce,
      'aster chain': w.asterChain,
    },
  );
}

/**
 * The approval of a key that may only withdraw: no trading, no spot, any IPv4
 * reader. The same message and order as asterApprovalParams, the same checks.
 */
export function asterWithdrawAgentParams(a: AsterApproval): Record<string, string> {
  const p = asterApprovalParams(a);
  p.canPerpTrade = 'false';
  p.canWithdraw = 'true';
  p.ipWhitelist = '0.0.0.0/0';
  return p;
}

export function signAsterWithdrawAgent(a: AsterApproval, userPriv: Uint8Array): { params: Record<string, string>; signature: string } {
  const params = asterWithdrawAgentParams(a);
  const msg = asterMessage(params);
  return { params, signature: signAsterDigest(asterDigest(ASTER_APPROVAL_CHAIN, msg), userPriv) };
}

/**
 * The whole user-withdraw request: Aster's parameters with the wallet's
 * Withdraw signature among them, under the withdraw key's request signature.
 * It pays the account itself and nothing else.
 */
export function asterWithdrawQuery(
  w: AsterWithdraw,
  who: { user: string; signer: string },
  userPriv: Uint8Array,
  signerPriv: Uint8Array,
  nonce = asterNonce(),
): string {
  if (w.destination.toLowerCase() !== who.user.toLowerCase()) throw new Error('aster: a withdrawal pays the account itself');
  const userSignature = signAsterDigest(asterWithdrawDigest(w), userPriv);
  return asterSignedQuery(
    {
      chainId: String(w.chainId),
      asset: w.token,
      amount: w.amount,
      fee: w.fee,
      userNonce: w.nonce,
      receiver: w.destination,
      userSignature,
    },
    who,
    signerPriv,
    nonce,
  );
}
