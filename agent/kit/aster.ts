/**
 * Perps on Aster, from a trading account of the agent's own.
 *
 * Aster credits whoever sends USDT to its vault on BNB Chain, and pays a
 * withdrawal only to the account's own address. So an agent trades from an
 * address of its own there, and money passes through it both ways: the vault
 * sends USDT to it privately and it sends that on to Aster; Aster pays it
 * back and it sends that on to a deposit route into the vault.
 *
 * Three keys, all derived here from the recovery phrase, so there is nothing
 * new to keep, and a sealed copy of the phrase covers them too:
 *   the trading key   owns the Aster account and the address, and signs the
 *                     transfers on BNB Chain;
 *   the order key     signs orders and reads, approved on Aster by the
 *                     trading key, with no right to withdraw;
 *   the withdraw key  may only withdraw, and only with the trading key's own
 *                     signature naming this address (src/perps/aster.ts).
 * The withdraw key comes from the trading key exactly as the browser's does
 * (src/perps/local.ts withdrawPriv), and every request is shaped by the same
 * code the app sends Aster, so what Aster accepted from the app is what goes
 * from here.
 *
 * The owner's rules hold where money leaves the vault: GhosterDex lets it go
 * to this address only with the owner's switch on, up to the owner's cap, and
 * above the approval size only after a tap (worker/agents.ts agentGate). The
 * leverage cap comes with the rules and is held here, because orders go from
 * this machine straight to Aster.
 *
 * A move that takes minutes is written down in ~/.ghosterdex/aster.json and
 * carried on by every later command (advance), so nothing depends on one
 * process staying up.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as secp from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import {
  ASTER_HOSTS,
  AsterOrderError,
  asterNonce,
  asterOrderParams,
  asterRules,
  asterSignedQuery,
  asterWithdrawQuery,
  signAsterApproval,
  signAsterWithdrawAgent,
  type AsterRules,
} from '../../src/perps/aster';
import { erc20Transfer, evmAddress, signEvmTx } from '../../src/perps/evmtx';
import { toHex } from '../../src/perps/eip712';
import { ApiError } from './client';
import { fromRaw, isAll, usd } from './amounts';
import { homeDir } from './wallet';
import { KitError, type Kit, type Token } from './kit';

/* ------------------------------------------------------------ constants */

const BSC_RPC = ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.binance.org'];
const BSC_CHAIN = 56;
/** USDT on BNB Chain, 18 decimals: the coin Aster is funded with */
const USDT = '0x55d398326f99059ff775485246999027b3197955';
/** Aster's vault: USDT sent here credits the sender's Aster account */
const ASTER_VAULT = '0x128463a60784c4d3f46c23af3f65ed859ba87974';
const WEI = 10n ** 18n;
/** below this much BNB the address cannot pay for a transfer (the app's floor) */
const GAS_FLOOR_WEI = 200_000_000_000_000n;
/** what goes from the vault in BNB when the address has none: dozens of transfers' worth */
const GAS_USD = 1;
/** Aster's smallest deposit, as the app says it */
export const IN_MIN_USD = 5;
/** the smallest withdrawal the kit asks Aster for: its fee is about 0.11 USDT */
export const OUT_MIN_USD = 2;
/** Aster's public fee estimate, the fee its documentation says to sign */
const FEE_URL =
  'https://www.asterdex.com/bapi/futures/v1/public/future/aster/estimate-withdraw-fee?chainId=56&network=EVM&currency=USDT&accountType=perp';
const APPROVAL_MS = 182 * 864e5;
/* sixteen characters at most: Aster refused longer names on its testnet */
const ORDER_KEY_NAME = 'gdx-kit';
const OUT_KEY_NAME = 'gdx-kit-out';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function host(): string {
  /* a stand-in Aster for tests; nothing else changes where orders go */
  const o = String(process.env.GDX_ASTER_HOST || '').trim();
  return /^https?:\/\/\S+$/.test(o) ? o.replace(/\/$/, '') : ASTER_HOSTS.mainnet;
}

/* ----------------------------------------------------------------- keys */

export type AsterKeys = {
  trade: Uint8Array;
  orders: Uint8Array;
  out: Uint8Array;
  /** the trading address: the Aster account, on BNB Chain */
  address: string;
  ordersAddress: string;
  outAddress: string;
};

function derive(from: Uint8Array, label: string): Uint8Array {
  const tail = new TextEncoder().encode(label);
  const joined = new Uint8Array(from.length + tail.length);
  joined.set(from, 0);
  joined.set(tail, from.length);
  let k = keccak_256(joined);
  /* a hash outside the curve's range is as rare as a collision; hash again rather than reduce */
  while (!secp.utils.isValidPrivateKey(k)) k = keccak_256(k);
  return k;
}

/** The three keys, from the Ed25519 seed (the first half of the phrase's secret key). */
export function asterKeysFrom(seed: Uint8Array): AsterKeys {
  if (seed.length !== 32) throw new Error('aster: the seed is 32 bytes');
  const trade = derive(seed, 'ghosterdex agent trading v1');
  const orders = derive(trade, 'ghosterdex agent aster orders v1');
  const out = derive(trade, 'ghosterdex aster withdraw v1');
  return { trade, orders, out, address: evmAddress(trade), ordersAddress: evmAddress(orders), outAddress: evmAddress(out) };
}

export async function asterKeys(k: Kit): Promise<AsterKeys> {
  const kp = await k.keys();
  return asterKeysFrom(new Uint8Array(kp.secretKey.subarray(0, 32)));
}

/** The one text the trading key signs to name its address to GhosterDex (worker/agents.ts asterAddressText). */
export function addressText(agentPk: string, address: string): string {
  return ['GhosterDex agent trading address', `Agent: ${agentPk}`, `Address: ${address.toLowerCase()}`].join('\n');
}

/** An Ethereum personal message signature (EIP-191): 0x + r + s + v. */
export function personalSign(text: string, priv: Uint8Array): string {
  const msg = new TextEncoder().encode(text);
  const head = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${msg.length}`);
  const joined = new Uint8Array(head.length + msg.length);
  joined.set(head, 0);
  joined.set(msg, head.length);
  const sig = secp.sign(keccak_256(joined), priv, { lowS: true });
  return toHex(sig.toCompactRawBytes()) + (27 + sig.recovery).toString(16).padStart(2, '0');
}

/* ---------------------------------------------------------------- state */

type InMove = {
  kind: 'in';
  at: number;
  usd: number;
  /** the vault's routes to the trading address: the USDT, and the gas when it went too */
  routes: string[];
  stage: 'crossing' | 'sending' | 'sent';
  /** Aster's wallet balance before: the credit is measured against it */
  base: number;
  /** what the route said would arrive, in USDT */
  expect: number;
  tx?: string;
  sentAt?: number;
  sent?: number;
};
type OutMove = {
  kind: 'out';
  at: number;
  usd: number;
  stage: 'requested' | 'sending' | 'sent';
  withdrawId?: string;
  /** the vault's deposit route the USDT is sent to */
  route?: string;
  tx?: string;
  sentAt?: number;
  gasRoute?: string;
};
export type AsterState = {
  v: 1;
  address: string;
  /** when GhosterDex took the address (POST /api/agent/v1/aster) */
  registered?: string;
  ordersUntil?: number;
  outUntil?: number;
  pending?: InMove | OutMove;
};

function statePath(): string {
  return join(homeDir(), 'aster.json');
}

export function loadAster(): AsterState | null {
  try {
    const p = statePath();
    if (!existsSync(p)) return null;
    const s = JSON.parse(readFileSync(p, 'utf8'));
    return s && s.v === 1 && typeof s.address === 'string' ? (s as AsterState) : null;
  } catch {
    return null;
  }
}

/** Atomic, like wallet.json: a crash mid-save never leaves half a record. */
function saveAster(st: AsterState): void {
  const p = statePath();
  const tmp = p + '.tmp';
  writeFileSync(tmp, JSON.stringify(st, null, 2), { mode: 0o600 });
  renameSync(tmp, p);
}

function stateFor(keys: AsterKeys): AsterState {
  const st = loadAster();
  if (st && st.address === keys.address) return st;
  /* a record for another phrase is not this account's */
  return { v: 1, address: keys.address };
}

/* ---------------------------------------------------------- BNB Chain */

async function bsc<T = any>(method: string, params: unknown[] = []): Promise<T> {
  let last: unknown = null;
  for (const url of BSC_RPC) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(20_000),
      });
      const j: any = await r.json();
      if (j?.error) throw new Error(String(j.error.message || 'BNB Chain refused that'));
      return j.result as T;
    } catch (e) {
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error('BNB Chain did not answer.');
}

export async function usdtOf(address: string): Promise<bigint> {
  const h = await bsc<string>('eth_call', [{ to: USDT, data: '0x70a08231' + address.slice(2).toLowerCase().padStart(64, '0') }, 'latest']);
  return BigInt(h && h !== '0x' ? h : '0x0');
}

export async function bnbOf(address: string): Promise<bigint> {
  return BigInt((await bsc<string>('eth_getBalance', [address, 'latest'])) || '0x0');
}

const asUsdt = (wei: bigint) => Number(wei) / 1e18;

/** Broadcast one USDT transfer from the trading address, signed here. Answers the hash; mined() says how it ended. */
async function sendUsdt(keys: AsterKeys, to: string, amount: bigint): Promise<string> {
  const data = erc20Transfer(to, amount);
  const [nonce, gp, est] = await Promise.all([
    bsc<string>('eth_getTransactionCount', [keys.address, 'pending']),
    bsc<string>('eth_gasPrice'),
    bsc<string>('eth_estimateGas', [{ from: keys.address, to: USDT, data }]).catch(() => '0x13880'),
  ]);
  const price = BigInt(gp);
  const raw = signEvmTx(
    {
      chainId: BSC_CHAIN,
      nonce: BigInt(nonce).toString(),
      /* BNB Chain's base fee is nought, so the tip is the whole price; twice it rides out a change */
      maxPriorityFeePerGas: price.toString(),
      maxFeePerGas: (price * 2n).toString(),
      gasLimit: ((BigInt(est) * 12n) / 10n).toString(),
      to: USDT,
      value: '0',
      data,
    },
    keys.trade,
  );
  try {
    return await bsc<string>('eth_sendRawTransaction', [raw]);
  } catch (e: any) {
    if (/insufficient funds/i.test(String(e?.message))) {
      throw new KitError('The trading address has no BNB for gas.', { code: 'aster_no_gas', hint: 'Run aster again: it sends a little BNB from the vault first.' });
    }
    throw e;
  }
}

/** A route's status from GhosterDex, asked once; a blip reads as still moving. */
export async function routeStatus(k: Kit, id: string | undefined): Promise<string> {
  if (!id) return 'PROCESSING';
  try {
    const s = await k.c.call<{ status?: string }>(`/api/status?depositAddress=${encodeURIComponent(id)}`);
    return String(s?.status || 'PROCESSING');
  } catch {
    return 'PROCESSING';
  }
}

/** 'ok', 'failed', or 'waiting' for a broadcast transfer. */
async function mined(hash: string): Promise<'ok' | 'failed' | 'waiting'> {
  const rc: any = await bsc('eth_getTransactionReceipt', [hash]).catch(() => null);
  if (rc?.status === '0x1') return 'ok';
  if (rc?.status === '0x0') return 'failed';
  return 'waiting';
}

/* -------------------------------------------------------------- Aster */

async function readJson(r: Response): Promise<any> {
  const text = await r.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { msg: text.slice(0, 200) };
  }
}

/* a KitError made at call time: kit.ts imports this file, so nothing here may touch its classes while the bundle loads */
function refusal(j: any, status: number): KitError {
  return new KitError(j?.msg ? `Aster: ${j.msg}` : `Aster answered ${status}`, { code: 'aster_refused', data: { asterCode: j?.code } });
}

async function pub(path: string, params?: Record<string, string>): Promise<any> {
  const q = params ? '?' + new URLSearchParams(params).toString() : '';
  const r = await fetch(host() + path + q, { signal: AbortSignal.timeout(20_000) });
  const j = await readJson(r);
  if (!r.ok || (j && typeof j.code === 'number' && j.code < 0)) throw refusal(j, r.status);
  return j;
}

/** A signed form to Aster (approvals and withdrawals carry their own signatures). */
async function postForm(path: string, body: string): Promise<any> {
  const r = await fetch(host() + path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  const j = await readJson(r);
  if (!r.ok || (j && typeof j.code === 'number' && j.code < 0)) throw refusal(j, r.status);
  return j;
}

/* Aster checks a request's time against its own; a machine whose clock runs off is carried by the difference */
let skewMs = 0;
let skewAt = 0;
async function syncClock(): Promise<void> {
  if (Date.now() - skewAt < 600_000) return;
  try {
    const j = await pub('/fapi/v1/time');
    if (Number(j?.serverTime) > 0) skewMs = Number(j.serverTime) - Date.now();
  } catch {
    /* the local clock, then */
  }
  skewAt = Date.now();
}

/** One request signed by the order key. */
async function signed(keys: AsterKeys, method: 'GET' | 'POST' | 'DELETE', path: string, params: Record<string, string> = {}): Promise<any> {
  await syncClock();
  const q = asterSignedQuery(params, { user: keys.address, signer: keys.ordersAddress }, keys.orders, asterNonce(skewMs));
  const url = host() + path + (method === 'GET' ? '?' + q : '');
  const r = await fetch(url, {
    method,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: method === 'GET' ? undefined : q,
    signal: AbortSignal.timeout(30_000),
  });
  const j = await readJson(r);
  if (!r.ok || (j && typeof j.code === 'number' && j.code < 0)) throw refusal(j, r.status);
  return j;
}

/** The order key, approved by the trading key: trading and reading, no withdrawals. Once, then remembered. */
async function ensureOrderKey(keys: AsterKeys, st: AsterState): Promise<void> {
  if (st.ordersUntil && st.ordersUntil > Date.now() + 864e5) return;
  const expired = Date.now() + APPROVAL_MS;
  const a = signAsterApproval({ user: keys.address, agentName: ORDER_KEY_NAME, agentAddress: keys.ordersAddress, expired }, keys.trade);
  const form = new URLSearchParams(a.params);
  form.append('signature', a.signature);
  await postForm('/fapi/v3/registerAndApproveAgent', form.toString()).catch((e) => {
    if (!/already exist/i.test(String(e?.message))) throw e;
  });
  st.ordersUntil = expired;
  saveAster(st);
}

/** The withdraw key, approved by the trading key: withdrawals only, to this address only. */
async function ensureWithdrawKey(keys: AsterKeys, st: AsterState): Promise<void> {
  if (st.outUntil && st.outUntil > Date.now() + 864e5) return;
  const expired = Date.now() + APPROVAL_MS;
  const a = signAsterWithdrawAgent({ user: keys.address, agentName: OUT_KEY_NAME, agentAddress: keys.outAddress, expired }, keys.trade);
  const form = new URLSearchParams(a.params);
  form.append('signature', a.signature);
  await postForm('/fapi/v3/registerAndApproveAgent', form.toString()).catch((e) => {
    if (!/already exist/i.test(String(e?.message))) throw e;
  });
  st.outUntil = expired;
  saveAster(st);
}

/** GhosterDex learns the trading address once, signed by its key; only then may vault money go there. */
async function ensureRegistered(k: Kit, keys: AsterKeys, st: AsterState): Promise<void> {
  if (st.registered) return;
  try {
    await k.c.call('/api/agent/v1/aster', { body: { address: keys.address, signature: personalSign(addressText(k.ks.publicKey, keys.address), keys.trade) } });
  } catch (e) {
    if (e instanceof ApiError && e.body?.code === 'agent_aster_set') {
      throw new KitError('GhosterDex has a different trading address on record for this agent.', {
        code: 'agent_aster_set',
        hint: 'This machine holds another recovery phrase than the one that first traded on Aster. Tell your owner.',
      });
    }
    throw k.explain(e);
  }
  st.registered = new Date().toISOString();
  saveAster(st);
}

/** The trading address named to GhosterDex, once: both venues trade from it (hyperliquid.ts too). */
export async function registerTradingAddress(k: Kit): Promise<void> {
  const keys = await asterKeys(k);
  await ensureRegistered(k, keys, stateFor(keys));
}

/* ----------------------------------------------------------- reading */

export type AsterPosition = {
  symbol: string;
  side: 'long' | 'short';
  size: string;
  entry: number;
  mark: number;
  pnl: number;
  leverage: number;
  liquidation: number;
};
export type AsterOrder = { symbol: string; orderId: number; side: string; type: string; price: string; size: string; filled: string; reduceOnly: boolean };
export type AsterAccount = {
  funded: boolean;
  wallet: number;
  equity: number;
  available: number;
  unrealized: number;
  positions: AsterPosition[];
  orders: AsterOrder[];
};

const EMPTY: AsterAccount = { funded: false, wallet: 0, equity: 0, available: 0, unrealized: 0, positions: [], orders: [] };

/**
 * The account as Aster says it. An account nobody has funded answers its
 * reads with "deposit first" or "No agent found", which is an empty account
 * here, never an error.
 */
export async function asterAccount(keys: AsterKeys): Promise<AsterAccount> {
  let open: any[];
  try {
    open = await signed(keys, 'GET', '/fapi/v3/openOrders');
  } catch (e: any) {
    if (/after deposit|no agent found/i.test(String(e?.message))) return { ...EMPTY };
    throw e;
  }
  const [acct, risk] = await Promise.all([signed(keys, 'GET', '/fapi/v3/account'), signed(keys, 'GET', '/fapi/v3/positionRisk')]);
  const n = (v: unknown) => Number(v) || 0;
  return {
    funded: true,
    wallet: n(acct?.totalWalletBalance),
    equity: n(acct?.totalMarginBalance),
    available: n(acct?.availableBalance),
    unrealized: n(acct?.totalUnrealizedProfit),
    positions: (Array.isArray(risk) ? risk : [])
      .filter((p: any) => n(p.positionAmt) !== 0)
      .map((p: any) => ({
        symbol: String(p.symbol),
        side: n(p.positionAmt) > 0 ? 'long' : 'short',
        size: String(p.positionAmt).replace(/^-/, ''),
        entry: n(p.entryPrice),
        mark: n(p.markPrice),
        pnl: n(p.unRealizedProfit),
        leverage: n(p.leverage),
        liquidation: n(p.liquidationPrice),
      })),
    orders: (Array.isArray(open) ? open : []).map((o: any) => ({
      symbol: String(o.symbol),
      orderId: Number(o.orderId),
      side: String(o.side),
      type: String(o.origType || o.type),
      price: String(o.price),
      size: String(o.origQty),
      filled: String(o.executedQty),
      reduceOnly: Boolean(o.reduceOnly),
    })),
  };
}

/* ----------------------------------------------------------- markets */

type SymbolInfo = { symbol: string; base: string; rules: AsterRules };
let infoMemo: { at: number; list: SymbolInfo[] } | null = null;

async function symbols(): Promise<SymbolInfo[]> {
  if (infoMemo && Date.now() - infoMemo.at < 10 * 60_000) return infoMemo.list;
  const j = await pub('/fapi/v1/exchangeInfo');
  const list: SymbolInfo[] = (Array.isArray(j?.symbols) ? j.symbols : [])
    .filter((s: any) => s && s.status === 'TRADING' && s.contractType === 'PERPETUAL')
    .map((s: any) => ({ symbol: String(s.symbol), base: String(s.baseAsset || ''), rules: asterRules(s.filters) }));
  infoMemo = { at: Date.now(), list };
  return list;
}

/** "btc", "BTC-PERP" or "BTCUSDT" to Aster's symbol, with its trading rules. */
export async function market(input: unknown): Promise<SymbolInfo> {
  const raw = String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/PERP$/, '');
  if (!raw) throw new KitError('Name a market, like BTC or ETHUSDT.', { code: 'aster_market' });
  const list = await symbols();
  const hit = list.find((s) => s.symbol === raw) || list.find((s) => s.symbol === raw + 'USDT') || list.find((s) => s.base === raw && s.symbol.endsWith('USDT'));
  if (hit) return hit;
  const near = list.filter((s) => s.symbol.includes(raw.slice(0, 3))).slice(0, 6).map((s) => s.symbol);
  throw new KitError(`Aster has no market called ${raw}.`, { code: 'aster_market', hint: near.length ? `Did you mean ${near.join(', ')}?` : 'aster_markets lists them.' });
}

async function markOf(symbol: string): Promise<number> {
  const j = await pub('/fapi/v1/premiumIndex', { symbol });
  return Number(j?.markPrice) || 0;
}

export async function asterMarkets(search?: string, limit = 25) {
  const [list, tick] = await Promise.all([symbols(), pub('/fapi/v1/ticker/24hr')]);
  const bySym = new Map<string, any>((Array.isArray(tick) ? tick : []).map((t: any) => [String(t.symbol), t]));
  const q = String(search || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return list
    .filter((s) => !q || s.symbol.includes(q) || s.base.includes(q))
    .map((s) => {
      const t = bySym.get(s.symbol) || {};
      return {
        market: s.symbol,
        price: Number(t.lastPrice) || null,
        change24hPct: t.priceChangePercent != null ? Number(t.priceChangePercent) : null,
        volume24hUsd: Math.round(Number(t.quoteVolume) || 0),
        minOrderUsd: s.rules.minNotional || null,
      };
    })
    .sort((a, b) => b.volume24hUsd - a.volume24hUsd)
    .slice(0, Math.max(1, Math.min(100, limit)));
}

/* ------------------------------------------------- the owner's rules */

export type PerpsRules = {
  offered: boolean;
  /** which venues are open to this agent (a server from before Hyperliquid names none: Aster alone) */
  venues?: { hyperliquid: boolean; aster: boolean };
  on: boolean;
  leverageMax: number;
  limitUsd: number | null;
  /** dollars in perps as the cap counts them, both venues together */
  onPerpsUsd?: number;
  onAsterUsd: number;
  leftUsd: number | null;
  address: string | null;
};

export async function perpsRules(k: Kit): Promise<{ perps: PerpsRules | null; paused: boolean; paired: boolean }> {
  const me = await k.me(true);
  const p = (me.rules as any)?.perps as PerpsRules | undefined;
  return { perps: p || null, paused: me.paused, paired: me.paired };
}

/** New exposure needs the venue open, the owner's switch on and the agent not paused; closing never does. */
export function mayOpen(r: { perps: PerpsRules | null; paused: boolean; paired: boolean }, venue: 'aster' | 'hyperliquid' = 'aster'): void {
  const name = venue === 'aster' ? 'Aster' : 'Hyperliquid';
  if (!r.paired) throw new KitError('Pair with your owner first: perps are theirs to turn on.', { code: 'agent_unpaired' });
  if (r.paused) throw new KitError('Your owner paused this agent. Closing positions still works.', { code: 'agent_paused' });
  const open = r.perps?.venues ? r.perps.venues[venue] : venue === 'aster' && Boolean(r.perps?.offered);
  if (!open) throw new KitError(`Perps on ${name} are not open to this agent yet.`, { code: 'agent_no_perps' });
  if (!r.perps!.on) {
    throw new KitError('Your owner has not turned on perps for this agent.', {
      code: 'agent_no_perps',
      hint: 'They can in GhosterDex, Explore, Agent Wallets, Settings. Closing positions and withdrawing still work.',
    });
  }
}

/** The leverage an opening order runs at: what was asked, never past the owner's cap. */
export function chooseLeverage(asked: unknown, current: number, cap: number): { set: number | null } {
  const max = Math.max(1, Math.floor(Number(cap) || 1));
  if (asked !== undefined && asked !== null && asked !== '') {
    const n = Math.floor(Number(String(asked).replace(/x$/i, '')));
    if (!(n >= 1)) throw new KitError('Leverage is a whole number, like 2 or 5.', { code: 'aster_leverage' });
    if (n > max) {
      throw new KitError(`Your owner allows up to ${max}x on Aster.`, { code: 'agent_perps_leverage', hint: `Use ${max}x or less, or ask your owner to raise it.` });
    }
    return { set: n === current ? null : n };
  }
  /* nothing asked: keep what the market is set to while it is inside the cap, else the cap */
  return { set: current >= 1 && current <= max ? null : Math.min(max, current >= 1 ? current : 1) };
}

/* ------------------------------------------------------------ orders */

let hedgeChecked = false;
async function oneWayMode(keys: AsterKeys): Promise<void> {
  if (hedgeChecked) return;
  const j = await signed(keys, 'GET', '/fapi/v3/positionSide/dual').catch(() => null);
  if (j?.dualSidePosition === true) {
    throw new KitError('This Aster account is in hedge mode, which the kit does not trade.', { code: 'aster_hedge', hint: 'Switch it to one-way mode on asterdex.com first.' });
  }
  hedgeChecked = true;
}

export async function asterOrder(
  k: Kit,
  o: { market: unknown; side: unknown; size?: unknown; usd?: unknown; price?: unknown; leverage?: unknown; reduceOnly?: boolean },
) {
  const side = String(o.side || '').toLowerCase();
  const S = side === 'buy' || side === 'long' ? 'BUY' : side === 'sell' || side === 'short' ? 'SELL' : null;
  if (!S) throw new KitError('The side is buy (long) or sell (short).', { code: 'aster_side' });
  const reduceOnly = Boolean(o.reduceOnly);
  const r = await perpsRules(k);
  if (!reduceOnly) mayOpen(r, 'aster');
  const keys = await asterKeys(k);
  const st = stateFor(keys);
  await ensureOrderKey(keys, st);
  await oneWayMode(keys);
  const m = await market(o.market);
  const mark = await markOf(m.symbol);
  if (!(mark > 0)) throw new KitError('Aster has no price for that market right now.', { code: 'aster_no_price' });

  const price = o.price !== undefined && o.price !== null && o.price !== '' ? Number(o.price) : undefined;
  if (price !== undefined && !(price > 0)) throw new KitError('A limit price is a number above zero.', { code: 'aster_price' });
  let qty = Number(o.size);
  if (!(qty > 0) && Number(o.usd) > 0) qty = Number(o.usd) / (price || mark);
  if (!(qty > 0)) throw new KitError('Give a size in the coin, or usd for a size in dollars.', { code: 'aster_size' });

  let leverage: number | null = null;
  if (!reduceOnly) {
    const risk = await signed(keys, 'GET', '/fapi/v3/positionRisk', { symbol: m.symbol }).catch(() => []);
    const row = (Array.isArray(risk) ? risk : []).find((x: any) => x.symbol === m.symbol);
    const current = Math.floor(Number(row?.leverage) || 0);
    const pick = chooseLeverage(o.leverage, current, Number(r.perps?.leverageMax) || 1);
    if (pick.set) {
      await signed(keys, 'POST', '/fapi/v3/leverage', { symbol: m.symbol, leverage: String(pick.set) });
      leverage = pick.set;
    } else leverage = current || null;
  }

  let params: Record<string, string>;
  try {
    params = asterOrderParams({ symbol: m.symbol, side: S, kind: price ? 'limit' : 'market', qty, price, mark, reduceOnly }, m.rules);
  } catch (e) {
    if (e instanceof AsterOrderError) throw new KitError(e.message, { code: 'aster_order' });
    throw e;
  }
  const res = await signed(keys, 'POST', '/fapi/v3/order', params);
  const filled = Number(res?.executedQty) || 0;
  return {
    ok: true,
    market: m.symbol,
    side: S === 'BUY' ? 'buy' : 'sell',
    type: price ? 'limit' : 'market',
    orderId: res?.orderId,
    status: String(res?.status || ''),
    size: params.quantity,
    ...(price ? { price: params.price } : {}),
    filled: String(filled),
    ...(Number(res?.avgPrice) > 0 ? { averagePrice: Number(res.avgPrice) } : {}),
    ...(leverage ? { leverage } : {}),
    reduceOnly,
    ...(!price && filled === 0 ? { note: 'Nothing filled within 1% of the price, so nothing was bought or sold.' } : {}),
  };
}

/** Every position closed at market, reduce-only, and every open order cancelled: one market, or all. */
export async function asterClose(k: Kit, which?: unknown) {
  const keys = await asterKeys(k);
  const st = stateFor(keys);
  await ensureOrderKey(keys, st);
  const acct = await asterAccount(keys);
  const only = which && !isAll(which) ? (await market(which)).symbol : null;
  const cancelled = await cancelOrders(keys, acct.orders.filter((x) => !only || x.symbol === only));
  const closed: unknown[] = [];
  const failed: string[] = [];
  for (const p of acct.positions.filter((x) => !only || x.symbol === only)) {
    try {
      const m = await market(p.symbol);
      const mark = await markOf(p.symbol);
      const params = asterOrderParams(
        { symbol: p.symbol, side: p.side === 'long' ? 'SELL' : 'BUY', kind: 'market', qty: Number(p.size), mark, reduceOnly: true, slippage: 0.02 },
        m.rules,
      );
      const res = await signed(keys, 'POST', '/fapi/v3/order', params);
      closed.push({ market: p.symbol, side: p.side, size: p.size, filled: String(res?.executedQty ?? ''), status: String(res?.status || '') });
    } catch (e: any) {
      failed.push(`${p.symbol}: ${e?.message || e}`);
    }
  }
  return { ok: failed.length === 0, closed, cancelled, ...(failed.length ? { failed } : {}) };
}

async function cancelOrders(keys: AsterKeys, list: AsterOrder[]): Promise<number> {
  let n = 0;
  for (const o of list) {
    await signed(keys, 'DELETE', '/fapi/v3/order', { symbol: o.symbol, orderId: String(o.orderId) })
      .then(() => {
        n++;
      })
      .catch(() => undefined);
  }
  return n;
}

export async function asterCancel(k: Kit, which?: unknown, orderId?: unknown) {
  const keys = await asterKeys(k);
  const st = stateFor(keys);
  await ensureOrderKey(keys, st);
  const acct = await asterAccount(keys);
  const only = which && !isAll(which) ? (await market(which)).symbol : null;
  const list = acct.orders.filter((x) => (!only || x.symbol === only) && (!orderId || String(x.orderId) === String(orderId)));
  if (!list.length) return { ok: true, cancelled: 0, note: 'No open orders matched.' };
  return { ok: true, cancelled: await cancelOrders(keys, list) };
}

/* -------------------------------------------------- money: in and out */

/** The two coins on BNB Chain a move to the trading address uses, from the catalogue. */
async function bscTokens(k: Kit): Promise<{ usdt: Token; bnb: Token }> {
  return { usdt: await k.destination('USDT', 'bsc'), bnb: await k.destination('BNB', 'bsc') };
}

/** Raw units of a vault coin worth about `dollars`. */
function rawWorth(t: Token, dollars: number): bigint {
  if (!(t.price > 0)) throw new KitError(`${t.symbol} has no price right now.`, { code: 'agent_unpriced' });
  const units = dollars / t.price;
  return BigInt(Math.ceil(units * 10 ** Math.min(t.decimals, 12))) * 10n ** BigInt(Math.max(0, t.decimals - 12));
}

/**
 * Money from the vault into Aster: USDT to the trading address privately
 * (with a little BNB first when it has none), then on to Aster's vault.
 * Answers once the deposit is in Aster or `waitMs` has passed; a deposit
 * still crossing is carried on by the next command.
 */
export async function asterDeposit(k: Kit, amount: unknown, coin: unknown, waitMs = 120_000) {
  const r = await perpsRules(k);
  mayOpen(r, 'aster');
  const keys = await asterKeys(k);
  const st = stateFor(keys);
  await ensureRegistered(k, keys, st);
  await ensureOrderKey(keys, st);
  if (st.pending) {
    await advance(k);
    const now = stateFor(keys);
    if (now.pending) {
      throw new KitError('Another move to or from Aster is still on its way.', { code: 'aster_busy', hint: 'Check it with aster, then try again.', data: { pending: view(now.pending) } });
    }
  }
  const src = await k.source(String(coin || 'USDT'), String(amount));
  if (src.token.rwa) throw new KitError('Stocks cannot go to Aster. Sell them first with swap.');
  const { usdt, bnb } = await bscTokens(k);
  const needGas = (await bnbOf(keys.address).catch(() => 0n)) < GAS_FLOOR_WEI;
  let raw = src.raw;
  const gasRaw = needGas ? rawWorth(src.token, GAS_USD) : 0n;
  if (needGas && isAll(String(amount))) raw -= gasRaw;
  if (raw <= 0n) throw new KitError('Nothing would be left to deposit after the gas.', { code: 'insufficient' });
  const dollars = (Number(raw) / 10 ** src.token.decimals) * src.token.price;
  if (dollars < IN_MIN_USD) throw new KitError(`Aster takes at least $${IN_MIN_USD}. This is about $${usd(dollars)}.`, { code: 'aster_min' });
  if (r.perps?.leftUsd !== null && r.perps?.leftUsd !== undefined && dollars > r.perps.leftUsd + 0.005) {
    throw new KitError(`Your owner allows $${usd(r.perps.leftUsd)} more in perps.`, { code: 'agent_perps_cap', hint: 'Deposit less, or bring money back first.' });
  }
  const before = await asterAccount(keys).catch(() => ({ ...EMPTY }));
  const routes: string[] = [];
  if (needGas) {
    const g = await k.route({ kind: 'withdraw', origin: src.token, dest: bnb, raw: gasRaw, recipient: keys.address, waitMs: 0 });
    routes.push(g.id);
  }
  const main = await k.route({ kind: 'withdraw', origin: src.token, dest: usdt, raw, recipient: keys.address, waitMs: 0 });
  routes.push(main.id);
  st.pending = {
    kind: 'in',
    at: Date.now(),
    usd: usd(dollars),
    routes,
    stage: 'crossing',
    base: before.wallet,
    expect: Number(main.quote.amountOutFormatted) || dollars * 0.99,
  };
  saveAster(st);
  return settle(k, keys, waitMs, {
    sent: `${fromRaw(raw, src.token.decimals)} ${src.token.symbol}`,
    ...(needGas ? { gas: `about $${GAS_USD} of BNB went first, for the trading address's fees` } : {}),
  });
}

/** The fee to sign: Aster's public estimate, else the one its withdraw info names. */
async function withdrawFee(info: any): Promise<string> {
  const plain = (v: unknown) => {
    const x = Number(v);
    if (!isFinite(x) || x < 0 || v === '' || v == null) return '';
    const s = x.toFixed(8);
    return s.replace(/0+$/, '').replace(/\.$/, '');
  };
  try {
    const r = await fetch(FEE_URL, { signal: AbortSignal.timeout(15_000) });
    const j: any = await r.json();
    const f = plain(j?.data?.gasCost);
    if (f) return f;
  } catch {
    /* the account's own figure, then */
  }
  return plain(info?.balances?.USDT?.chainBalances?.['56']?.withdrawFee);
}

/**
 * Money from Aster home to the vault: Aster pays the trading address, and
 * the trading key sends it on to a private deposit route into the vault.
 * Always allowed: it is money coming home.
 */
export async function asterWithdraw(k: Kit, amount: unknown, waitMs = 120_000) {
  const keys = await asterKeys(k);
  const st = stateFor(keys);
  await ensureOrderKey(keys, st);
  if (st.pending) {
    await advance(k);
    const now = stateFor(keys);
    if (now.pending) {
      throw new KitError('Another move to or from Aster is still on its way.', { code: 'aster_busy', hint: 'Check it with aster, then try again.', data: { pending: view(now.pending) } });
    }
  }
  await ensureWithdrawKey(keys, st);
  const info = await signed(keys, 'POST', '/fapi/v3/aster/user-withdraw-info').catch(() => null);
  const chain = info?.balances?.USDT?.chainBalances?.['56'];
  let max = Number(chain?.perpMaxWithdrawAmount ?? info?.balances?.USDT?.perpTotalWithdrawAmount);
  if (!(max >= 0)) max = (await asterAccount(keys)).available;
  const left = Number(info?.userRemainingDailyLimit);
  if (left >= 0 && left < max) max = left;
  const fee = await withdrawFee(info);
  if (!fee) throw new KitError('Aster has not said its withdrawal fee. Try again in a moment.', { code: 'aster_fee' });
  const want = isAll(String(amount ?? 'all')) ? Math.floor(max * 100) / 100 : Math.floor(Number(amount) * 100) / 100;
  if (!(want >= OUT_MIN_USD)) {
    throw new KitError(`At least $${OUT_MIN_USD} comes out of Aster at once (its fee is ${fee} USDT).`, {
      code: 'aster_min',
      hint: max >= OUT_MIN_USD ? undefined : `Aster can pay out $${usd(max)} now. Close positions or cancel orders to free more.`,
    });
  }
  if (want > max + 0.005) throw new KitError(`Aster can pay out up to $${usd(max)} now.`, { code: 'insufficient', hint: 'Close positions or cancel orders to free more.' });
  if (!(Number(fee) < want)) throw new KitError('The fee would take all of it.', { code: 'aster_min' });
  const plainAmount = want.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  await syncClock();
  const query = asterWithdrawQuery(
    { destination: keys.address, chainId: BSC_CHAIN, token: 'USDT', amount: plainAmount, fee, nonce: String(Date.now() * 1000), asterChain: 'Mainnet' },
    { user: keys.address, signer: keys.outAddress },
    keys.trade,
    keys.out,
    asterNonce(skewMs),
  );
  const res = await postForm('/fapi/v3/aster/user-withdraw', query);
  st.pending = { kind: 'out', at: Date.now(), usd: usd(want - Number(fee)), stage: 'requested', withdrawId: String(res?.withdrawId || '') || undefined };
  saveAster(st);
  return settle(k, keys, waitMs, { withdrew: `${plainAmount} USDT from Aster`, fee: `${fee} USDT` });
}

/** Carries the move on until it ends or the wait runs out, then says where it is. */
async function settle(k: Kit, keys: AsterKeys, waitMs: number, said: Record<string, unknown>) {
  const until = Date.now() + Math.max(0, waitMs);
  let step = await advance(k);
  while (stateFor(keys).pending && Date.now() < until) {
    await sleep(6000);
    step = await advance(k);
  }
  const left = stateFor(keys).pending;
  return {
    ok: true,
    ...said,
    status: left ? 'on its way' : 'done',
    ...(step?.note ? { note: step.note } : {}),
    ...(left ? { pending: view(left), next: 'It carries on by itself the next time the kit runs (any command). Check with aster.' } : {}),
  };
}

function view(p: InMove | OutMove) {
  const stage =
    p.kind === 'in'
      ? p.stage === 'crossing'
        ? 'crossing from your vault to the trading address'
        : p.stage === 'sending'
          ? 'on its way from the trading address to Aster'
          : 'waiting for Aster to credit it'
      : p.stage === 'requested'
        ? 'waiting for Aster to pay the trading address'
        : p.stage === 'sending'
          ? 'on its way from the trading address to your vault'
          : 'waiting for your vault to credit it';
  return { direction: p.kind === 'in' ? 'vault to Aster' : 'Aster to vault', usd: p.usd, stage, since: new Date(p.at).toISOString() };
}

/**
 * One step of whatever is moving, and no waiting: called by every command,
 * so a move nobody watches still finishes. USDT found at the trading address
 * with nothing on record goes home to the vault.
 */
export async function advance(k: Kit): Promise<{ note?: string } | null> {
  const st0 = loadAster();
  if (!st0) return null;
  const keys = await asterKeys(k);
  const st = stateFor(keys);
  const [usdtWei, bnbWei] = await Promise.all([usdtOf(keys.address).catch(() => null), bnbOf(keys.address).catch(() => null)]);
  if (usdtWei === null) return { note: 'BNB Chain did not answer; the move carries on next time.' };
  const gasOk = (bnbWei ?? 0n) >= GAS_FLOOR_WEI;

  /* money at the address with nothing on record: home to the vault, the safe way for it to go */
  if (!st.pending) {
    if (usdtWei < WEI) return null;
    st.pending = { kind: 'out', at: Date.now(), usd: usd(asUsdt(usdtWei)), stage: 'requested' };
    saveAster(st);
  }
  const p = st.pending!;

  if (p.kind === 'in') {
    if (p.stage === 'crossing') {
      const arrived = usdtWei >= WEI && asUsdt(usdtWei) >= Math.min(p.expect * 0.9, p.expect - 0.5);
      if (arrived && gasOk) {
        p.tx = await sendUsdt(keys, ASTER_VAULT, usdtWei);
        p.sent = usd(asUsdt(usdtWei));
        p.stage = 'sending';
        saveAster(st);
        return { note: `${p.sent} USDT is on its way to Aster.` };
      }
      const ended = await Promise.all(p.routes.map((id) => routeStatus(k, id)));
      if (ended.length && ended.every((s) => s === 'FAILED' || s === 'REFUNDED') && usdtWei < WEI) {
        delete st.pending;
        saveAster(st);
        return { note: 'The move from the vault did not go through; the money stayed in the vault.' };
      }
      return { note: arrived ? 'Waiting for the gas to arrive.' : 'Crossing from the vault.' };
    }
    if (p.stage === 'sending') {
      const m = await mined(p.tx || '');
      if (m === 'ok') {
        p.stage = 'sent';
        p.sentAt = Date.now();
        saveAster(st);
      } else if (m === 'failed' || Date.now() - (p.sentAt || p.at) > 30 * 60_000) {
        /* refused or dropped: the USDT is still at the address, so the next step sends it again */
        p.stage = 'crossing';
        delete p.tx;
        p.sentAt = Date.now();
        saveAster(st);
        return { note: 'The transfer to Aster did not go through; it is sent again next time.' };
      } else return { note: 'Confirming on BNB Chain.' };
    }
    if (p.stage === 'sent') {
      const acct = await asterAccount(keys).catch(() => null);
      if ((acct && acct.wallet >= p.base + (p.sent || p.usd) * 0.9) || Date.now() - (p.sentAt || p.at) > 20 * 60_000) {
        delete st.pending;
        saveAster(st);
        return { note: acct ? `In Aster: $${usd(acct.wallet)} in the account.` : 'Sent to Aster; it credits within minutes.' };
      }
      return { note: 'Waiting for Aster to credit it.' };
    }
    return null;
  }

  /* out: Aster to the vault */
  if (p.stage === 'requested') {
    if (usdtWei < WEI) return { note: 'Waiting for Aster to pay the trading address.' };
    if (!gasOk) {
      if (p.gasRoute) {
        const s = await routeStatus(k, p.gasRoute);
        if (s !== 'FAILED' && s !== 'REFUNDED') return { note: 'Waiting for gas to reach the trading address.' };
      }
      /* the day's gas top-up passes whatever the rules, so money can always come home (worker/agents.ts gasHome) */
      const held = await k.balances().catch(() => []);
      const payer = held.filter((b) => !b.rwa && b.price > 0 && b.usd >= GAS_USD * 1.2).sort((a, b) => b.usd - a.usd)[0];
      if (!payer) return { note: 'The trading address needs a little BNB for gas, and the vault has nothing to send it with.' };
      const { bnb } = await bscTokens(k);
      const g = await k.route({ kind: 'withdraw', origin: payer, dest: bnb, raw: rawWorth(payer, GAS_USD), recipient: keys.address, waitMs: 0 });
      p.gasRoute = g.id;
      saveAster(st);
      return { note: 'Sending a little BNB to the trading address for gas.' };
    }
    const { usdt } = await bscTokens(k);
    const q = await k.c.call<any>('/api/quote', {
      body: { kind: 'deposit', originAssetId: usdt.assetId, destinationAssetId: usdt.assetId, recipient: keys.address, refundTo: keys.address, dry: false },
    });
    const to = String(q?.depositAddress || '');
    if (!/^0x[0-9a-fA-F]{40}$/.test(to)) return { note: 'The vault gave no address on BNB Chain; it is asked again next time.' };
    if (String(q?.confidentiality || '') !== 'advanced') return { note: 'No private route into the vault right now; it is tried again next time.' };
    const min = Number(q?.minDepositFormatted) || 0;
    if (min && asUsdt(usdtWei) < min) return { note: `The vault takes at least ${min} USDT here; ${usd(asUsdt(usdtWei))} is waiting at the trading address.` };
    p.tx = await sendUsdt(keys, to, usdtWei);
    p.route = to;
    p.stage = 'sending';
    p.sentAt = Date.now();
    p.usd = usd(asUsdt(usdtWei));
    saveAster(st);
    return { note: `${p.usd} USDT is on its way to your vault.` };
  }
  if (p.stage === 'sending') {
    const m = await mined(p.tx || '');
    if (m === 'ok') {
      p.stage = 'sent';
      p.sentAt = Date.now();
      saveAster(st);
    } else if (m === 'failed' || Date.now() - (p.sentAt || p.at) > 30 * 60_000) {
      p.stage = 'requested';
      delete p.tx;
      saveAster(st);
      return { note: 'The transfer to the vault did not go through; it is sent again next time.' };
    } else return { note: 'Confirming on BNB Chain.' };
  }
  if (p.stage === 'sent') {
    const s = await routeStatus(k, p.route);
    if (s === 'SUCCESS') {
      delete st.pending;
      saveAster(st);
      return { note: `${p.usd} USDT is back in your vault.` };
    }
    if (s === 'FAILED' || s === 'REFUNDED') {
      /* refunded to the trading address: the next step sends it again */
      p.stage = 'requested';
      delete p.tx;
      delete p.route;
      saveAster(st);
      return { note: 'The vault route refunded to the trading address; it is sent again next time.' };
    }
    return { note: 'Waiting for your vault to credit it.' };
  }
  return null;
}

/** What the agent is told about its Aster account: the rules, the account, and anything moving. */
export async function asterStatus(k: Kit) {
  const r = await perpsRules(k);
  const keys = await asterKeys(k);
  const known = loadAster();
  const step = known ? await advance(k).catch((e) => ({ note: String((e as Error)?.message || e) })) : null;
  const st = stateFor(keys);
  let account: AsterAccount | null = null;
  if (st.ordersUntil) account = await asterAccount(keys).catch(() => null);
  const [usdtWei, bnbWei] = await Promise.all([usdtOf(keys.address).catch(() => null), bnbOf(keys.address).catch(() => null)]);
  return {
    tradingAddress: keys.address,
    rules: r.perps
      ? {
          perps: !r.perps.offered ? 'not open to this agent yet' : r.perps.on ? 'on' : 'off: your owner turns it on in Agent Wallets, Settings',
          leverageMax: r.perps.leverageMax,
          limitUsd: r.perps.limitUsd,
          onAsterUsd: r.perps.onAsterUsd,
          leftUsd: r.perps.leftUsd,
        }
      : 'pair with your owner first',
    account: account
      ? account.funded
        ? {
            walletUsd: usd(account.wallet),
            equityUsd: usd(account.equity),
            availableUsd: usd(account.available),
            unrealizedUsd: usd(account.unrealized),
            positions: account.positions,
            openOrders: account.orders,
          }
        : 'not funded yet: aster_deposit puts money in'
      : 'not set up yet: aster_deposit sets it up',
    atTradingAddress: {
      usdt: usdtWei === null ? null : String(usd(asUsdt(usdtWei))),
      bnb: bnbWei === null ? null : fromRaw(bnbWei, 18),
    },
    ...(st.pending ? { moving: view(st.pending) } : {}),
    ...(step?.note ? { note: step.note } : {}),
  };
}

/**
 * Everything on Aster, home to the vault: orders cancelled, positions closed
 * at market, the balance withdrawn, and each later run carrying it on. `done`
 * when nothing is left on Aster or at the trading address and nothing is
 * moving. An agent that never used Aster answers at once, without a call.
 */
export async function asterHome(k: Kit): Promise<{ done: boolean; note: string }> {
  if (!loadAster()) return { done: true, note: '' };
  const keys = await asterKeys(k);
  const st = stateFor(keys);
  if (!st.ordersUntil) {
    /* never traded: only money already at the address can be waiting */
    const step = await advance(k).catch(() => null);
    const left = stateFor(keys).pending;
    return { done: !left, note: left ? step?.note || 'Money from the trading address is on its way home.' : '' };
  }
  const acct = await asterAccount(keys);
  if (acct.positions.length || acct.orders.length) await asterClose(k, 'all');
  await advance(k).catch(() => null);
  if (!stateFor(keys).pending) {
    const now = acct.positions.length || acct.orders.length ? await asterAccount(keys) : acct;
    if (now.available >= OUT_MIN_USD) {
      await asterWithdraw(k, 'all', 0).catch(() => null);
    }
  }
  const after = stateFor(keys).pending;
  const rest = await asterAccount(keys).catch(() => null);
  const stillOnAster = rest ? rest.available >= OUT_MIN_USD || rest.positions.length > 0 : false;
  if (!after && !stillOnAster) return { done: true, note: '' };
  return {
    done: false,
    note: after ? `Aster money is coming home: ${view(after).stage}.` : 'Money is still on Aster; it is brought home on the next run.',
  };
}
