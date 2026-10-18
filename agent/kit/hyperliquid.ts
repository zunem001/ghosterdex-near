/**
 * Perps on Hyperliquid, from the agent's own trading account.
 *
 * The same trading key that owns the agent's Aster account (aster.ts) is its
 * Hyperliquid account: one address, both venues. Hyperliquid is the simpler
 * road. The vault delivers USDC straight into the account on HyperCore (the
 * app's own route, public/fund-pro.js HYPERCORE_USDC), with no gas and no
 * second step, and a withdrawal may pay any address, so it pays a private
 * deposit route into the vault directly, as the app's own withdrawal does
 * (fund-pro.js venueRelease).
 *
 * Orders, cancels and leverage are actions the trading key signs itself,
 * shaped and hashed by the app's own code (src/perps/agent.ts orderStruct,
 * src/perps/l1action.ts digestFor), exactly as the browser's trading key
 * signs them (src/perps/local.ts signL1). The owner's rules hold where money
 * leaves the vault (worker/agents.ts: USDC on HyperCore to the trading
 * address is a perps move), and the leverage cap is held here, as for Aster.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as secp from '@noble/secp256k1';
import { digestFor, type Packable } from '../../src/perps/l1action';
import { floatToWire, orderStruct } from '../../src/perps/agent';
import { digest as typedDigest, toHex, type TypedData } from '../../src/perps/eip712';
import { isAll, usd } from './amounts';
import { homeDir } from './wallet';
import { KitError, type Kit, type Token } from './kit';
import { asterKeys, chooseLeverage, mayOpen, perpsRules, registerTradingAddress, routeStatus, type AsterKeys } from './aster';

/** USDC on HyperCore, the router's own id: the app's direct road into a Hyperliquid account (fund-pro.js) */
export const HYPERCORE_USDC = '1cs_v1:hypercore:erc20:0xb88339CB7199b77E23DB6E890353E22632Ba630f';
/** USDC on Arbitrum: where a Hyperliquid withdrawal pays out, here into a deposit route */
export const ARB_USDC = 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near';
/** what Hyperliquid keeps from a withdrawal (fund-pro.js WITHDRAW_FEE) */
const WITHDRAW_FEE = 1;
/** the app's floors, both ways (fund-pro.js MIN_DEPOSIT and WITHDRAW_MIN) */
export const HL_IN_MIN = 2;
export const HL_OUT_MIN = 2;
/** Hyperliquid refuses an opening order under ten dollars of position */
const HL_MIN_ORDER_USD = 10;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function host(): string {
  /* a stand-in Hyperliquid for tests; nothing else changes where orders go */
  const o = String(process.env.GDX_HL_HOST || '').trim();
  return /^https?:\/\/\S+$/.test(o) ? o.replace(/\/$/, '') : 'https://api.hyperliquid.xyz';
}

/* ----------------------------------------------------------------- state */

type InMove = { kind: 'in'; at: number; usd: number; route: string; base: number };
type OutMove = { kind: 'out'; at: number; usd: number; route: string };
export type HlState = { v: 1; address: string; pending?: InMove | OutMove };

function statePath(): string {
  return join(homeDir(), 'hyperliquid.json');
}

export function loadHl(): HlState | null {
  try {
    const p = statePath();
    if (!existsSync(p)) return null;
    const s = JSON.parse(readFileSync(p, 'utf8'));
    return s && s.v === 1 && typeof s.address === 'string' ? (s as HlState) : null;
  } catch {
    return null;
  }
}

function saveHl(st: HlState): void {
  const p = statePath();
  const tmp = p + '.tmp';
  writeFileSync(tmp, JSON.stringify(st, null, 2), { mode: 0o600 });
  renameSync(tmp, p);
}

function stateFor(keys: AsterKeys): HlState {
  const st = loadHl();
  return st && st.address === keys.address ? st : { v: 1, address: keys.address };
}

/* --------------------------------------------------------- the venue */

async function info<T = any>(body: Record<string, unknown>): Promise<T> {
  const r = await fetch(host() + '/info', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new KitError(`Hyperliquid answered ${r.status}`, { code: 'hl_refused' });
  return (await r.json()) as T;
}

/* never the same nonce twice in one process: the venue refuses a repeat */
let lastNonce = 0;
function nextNonce(): number {
  let n = Date.now();
  if (n <= lastNonce) n = lastNonce + 1;
  lastNonce = n;
  return n;
}

type Sig = { r: string; s: string; v: number };

function sigOf(d: Uint8Array, priv: Uint8Array): Sig {
  const sig = secp.sign(d, priv, { lowS: true });
  const c = sig.toCompactRawBytes();
  return { r: toHex(c.slice(0, 32)), s: toHex(c.slice(32, 64)), v: 27 + sig.recovery };
}

/** An action signed by the trading key, as the browser's signL1 signs it. */
export function signAction(action: Packable, keys: AsterKeys): { action: Packable; nonce: number; signature: Sig } {
  const nonce = nextNonce();
  return { action, nonce, signature: sigOf(digestFor(action, BigInt(nonce)), keys.trade) };
}

async function exchange(body: { action: unknown; nonce: number; signature: Sig }, withVault = true): Promise<any> {
  const r = await fetch(host() + '/exchange', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(withVault ? { ...body, vaultAddress: null } : body),
    signal: AbortSignal.timeout(30_000),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || j?.status !== 'ok') {
    throw new KitError(`Hyperliquid: ${String(j?.response || j?.error || r.status).slice(0, 200)}`, { code: 'hl_refused' });
  }
  return j.response;
}

/* ----------------------------------------------------------- markets */

export type HlMarket = { name: string; index: number; szDecimals: number; maxLeverage: number };
let metaMemo: { at: number; list: HlMarket[] } | null = null;

async function universe(): Promise<HlMarket[]> {
  if (metaMemo && Date.now() - metaMemo.at < 10 * 60_000) return metaMemo.list;
  const m = await info<{ universe?: any[] }>({ type: 'meta' });
  const list: HlMarket[] = [];
  (m?.universe || []).forEach((u, i) => {
    if (u && !u.isDelisted) list.push({ name: String(u.name), index: i, szDecimals: Number(u.szDecimals) || 0, maxLeverage: Number(u.maxLeverage) || 1 });
  });
  metaMemo = { at: Date.now(), list };
  return list;
}

/** "btc", "BTC-PERP" or "BTCUSDT" to Hyperliquid's coin, with its index and rules. */
export async function hlMarket(input: unknown): Promise<HlMarket> {
  const asked = String(input || '').trim();
  if (!asked) throw new KitError('Name a market, like BTC or ETH.', { code: 'perps_market' });
  const list = await universe();
  const up = asked.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const bare = up.replace(/PERP$/, '').replace(/USDT$|USDC$|USD$/, '');
  const hit = list.find((m) => m.name.toUpperCase() === up) || list.find((m) => m.name.toUpperCase() === bare);
  if (hit) return hit;
  const near = list.filter((m) => m.name.toUpperCase().includes(bare.slice(0, 3))).slice(0, 6).map((m) => m.name);
  throw new KitError(`Hyperliquid has no market called ${asked}.`, { code: 'perps_market', hint: near.length ? `Did you mean ${near.join(', ')}?` : 'perps_markets lists them.' });
}

async function midOf(name: string): Promise<number> {
  const mids = await info<Record<string, string>>({ type: 'allMids' });
  return Number(mids?.[name]) || 0;
}

/**
 * A price Hyperliquid accepts: at most five significant figures (whole
 * numbers exempt) and at most 6 - szDecimals decimals, as the terminal's
 * hlPx writes it (public/perps-pro.js).
 */
export function hlPx(px: number, szDecimals: number): number {
  if (!isFinite(px) || px <= 0) return px;
  if (px === Math.round(px)) return px;
  const p = Number(px.toPrecision(5));
  return Number(p.toFixed(Math.max(0, 6 - szDecimals)));
}

/** A size on the market's grid, never larger than asked. */
export function hlSize(qty: number, szDecimals: number): number {
  const f = 10 ** szDecimals;
  return Math.floor(qty * f + 1e-9) / f;
}

export async function hlMarkets(search?: string, limit = 25) {
  const [meta, ctxs] = await info<[{ universe: any[] }, any[]]>({ type: 'metaAndAssetCtxs' });
  const q = String(search || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const rows = (meta?.universe || [])
    .map((u: any, i: number) => ({ u, c: (ctxs || [])[i] || {} }))
    .filter(({ u }) => u && !u.isDelisted && (!q || String(u.name).toUpperCase().includes(q)))
    .map(({ u, c }) => {
      const mark = Number(c.markPx) || null;
      const prev = Number(c.prevDayPx) || 0;
      return {
        venue: 'hyperliquid',
        market: String(u.name),
        price: mark,
        change24hPct: mark && prev ? Math.round((mark / prev - 1) * 10000) / 100 : null,
        volume24hUsd: Math.round(Number(c.dayNtlVlm) || 0),
        maxLeverage: Number(u.maxLeverage) || null,
        minOrderUsd: HL_MIN_ORDER_USD,
      };
    })
    .sort((a: any, b: any) => b.volume24hUsd - a.volume24hUsd);
  return rows.slice(0, Math.max(1, Math.min(100, limit)));
}

/* ----------------------------------------------------------- reading */

export type HlAccount = {
  equity: number;
  available: number;
  margin: number;
  positions: Array<{ market: string; side: 'long' | 'short'; size: string; entry: number; pnl: number; leverage: number; liquidation: number | null }>;
  orders: Array<{ market: string; orderId: number; side: string; price: string; size: string; reduceOnly: boolean }>;
};

export async function hlAccount(address: string): Promise<HlAccount> {
  const [ch, open] = await Promise.all([info<any>({ type: 'clearinghouseState', user: address }), info<any[]>({ type: 'openOrders', user: address })]);
  const ms = ch?.marginSummary || {};
  const n = (v: unknown) => Number(v) || 0;
  return {
    equity: n(ms.accountValue),
    available: n(ch?.withdrawable),
    margin: n(ms.totalMarginUsed),
    positions: (ch?.assetPositions || [])
      .map((a: any) => a?.position)
      .filter((p: any) => p && n(p.szi) !== 0)
      .map((p: any) => ({
        market: String(p.coin),
        side: n(p.szi) > 0 ? 'long' : 'short',
        size: String(p.szi).replace(/^-/, ''),
        entry: n(p.entryPx),
        pnl: n(p.unrealizedPnl),
        leverage: n(p.leverage?.value),
        liquidation: p.liquidationPx == null ? null : n(p.liquidationPx),
      })),
    orders: (Array.isArray(open) ? open : []).map((o: any) => ({
      market: String(o.coin),
      orderId: Number(o.oid),
      side: o.side === 'B' ? 'BUY' : 'SELL',
      price: String(o.limitPx),
      size: String(o.sz),
      reduceOnly: Boolean(o.reduceOnly),
    })),
  };
}

/**
 * Credits to the account, counted rather than summed: a funded account
 * always has a balance. The router's direct road arrives as an internal
 * send to this address, a bridge deposit as a deposit (fund-pro.js
 * depositLedger, seen live 2026-08-01).
 */
async function credits(address: string): Promise<number | null> {
  try {
    const list = await info<any[]>({ type: 'userNonFundingLedgerUpdates', user: address });
    const me = address.toLowerCase();
    return (Array.isArray(list) ? list : []).filter((u) => {
      const d = u?.delta || {};
      return d.type === 'deposit' || (d.type === 'send' && String(d.destination || '').toLowerCase() === me);
    }).length;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------ orders */

async function currentLeverage(address: string, coin: string): Promise<number> {
  const a = await info<any>({ type: 'activeAssetData', user: address, coin }).catch(() => null);
  return Math.floor(Number(a?.leverage?.value) || 0);
}

export async function hlOrder(
  k: Kit,
  o: { market: unknown; side: unknown; size?: unknown; usd?: unknown; price?: unknown; leverage?: unknown; reduceOnly?: boolean },
) {
  const side = String(o.side || '').toLowerCase();
  const isBuy = side === 'buy' || side === 'long' ? true : side === 'sell' || side === 'short' ? false : null;
  if (isBuy === null) throw new KitError('The side is buy (long) or sell (short).', { code: 'perps_side' });
  const reduceOnly = Boolean(o.reduceOnly);
  const r = await perpsRules(k);
  if (!reduceOnly) mayOpen(r, 'hyperliquid');
  const keys = await asterKeys(k);
  const m = await hlMarket(o.market);
  const mid = await midOf(m.name);
  if (!(mid > 0)) throw new KitError('Hyperliquid has no price for that market right now.', { code: 'perps_no_price' });
  const limit = o.price !== undefined && o.price !== null && o.price !== '' ? Number(o.price) : undefined;
  if (limit !== undefined && !(limit > 0)) throw new KitError('A limit price is a number above zero.', { code: 'perps_price' });
  let qty = Number(o.size);
  if (!(qty > 0) && Number(o.usd) > 0) qty = Number(o.usd) / (limit || mid);
  if (!(qty > 0)) throw new KitError('Give a size in the coin, or usd for a size in dollars.', { code: 'perps_size' });
  const size = hlSize(qty, m.szDecimals);
  if (!(size > 0)) throw new KitError(`The smallest size on ${m.name} is ${floatToWire(1 / 10 ** m.szDecimals)}.`, { code: 'perps_size' });
  /* market: a limit, immediate-or-cancel, one percent through the price, as the terminal sends it */
  const px = hlPx(limit ?? (isBuy ? mid * 1.01 : mid * 0.99), m.szDecimals);
  if (!reduceOnly && size * (limit || mid) < HL_MIN_ORDER_USD) {
    throw new KitError(`Hyperliquid's smallest order is $${HL_MIN_ORDER_USD}. This one is $${usd(size * (limit || mid))}.`, { code: 'perps_order' });
  }
  let leverage: number | null = null;
  if (!reduceOnly) {
    const current = await currentLeverage(keys.address, m.name);
    const pick = chooseLeverage(o.leverage, current, Number(r.perps?.leverageMax) || 1);
    const want = pick.set ?? current;
    if (want > m.maxLeverage) {
      throw new KitError(`Hyperliquid allows up to ${m.maxLeverage}x on ${m.name}.`, { code: 'perps_leverage' });
    }
    if (pick.set) await exchange(signAction({ type: 'updateLeverage', asset: m.index, isCross: true, leverage: pick.set }, keys));
    leverage = want || null;
  }
  const action: Packable = {
    type: 'order',
    orders: [orderStruct({ asset: m.index, isBuy, price: px, size, reduceOnly, tif: limit ? 'Gtc' : 'Ioc' })],
    grouping: 'na',
  };
  const res = await exchange(signAction(action, keys));
  const st = res?.data?.statuses?.[0] || {};
  if (st.error) throw new KitError(`Hyperliquid: ${String(st.error).slice(0, 200)}`, { code: 'perps_order' });
  const filled = st.filled ? String(st.filled.totalSz) : '0';
  return {
    ok: true,
    venue: 'hyperliquid',
    market: m.name,
    side: isBuy ? 'buy' : 'sell',
    type: limit ? 'limit' : 'market',
    orderId: st.filled?.oid ?? st.resting?.oid ?? null,
    status: st.filled ? 'filled' : st.resting ? 'resting' : 'unknown',
    size: floatToWire(size),
    price: floatToWire(px),
    filled,
    ...(st.filled?.avgPx ? { averagePrice: Number(st.filled.avgPx) } : {}),
    ...(leverage ? { leverage } : {}),
    reduceOnly,
    ...(!limit && !st.filled ? { note: 'Nothing filled within 1% of the price, so nothing was bought or sold.' } : {}),
  };
}

/** Positions closed at market, reduce-only, and their open orders cancelled: one market, or all. */
export async function hlClose(k: Kit, which?: unknown) {
  const keys = await asterKeys(k);
  const acct = await hlAccount(keys.address);
  const only = which && !isAll(which) ? (await hlMarket(which)).name : null;
  const cancelled = await cancelList(keys, acct.orders.filter((x) => !only || x.market === only));
  const closed: unknown[] = [];
  const failed: string[] = [];
  for (const p of acct.positions.filter((x) => !only || x.market === only)) {
    try {
      const m = await hlMarket(p.market);
      const mid = await midOf(p.market);
      const buy = p.side === 'short';
      const px = hlPx(buy ? mid * 1.02 : mid * 0.98, m.szDecimals);
      const res = await exchange(
        signAction({ type: 'order', orders: [orderStruct({ asset: m.index, isBuy: buy, price: px, size: Number(p.size), reduceOnly: true, tif: 'Ioc' })], grouping: 'na' }, keys),
      );
      const st = res?.data?.statuses?.[0] || {};
      if (st.error) throw new Error(String(st.error));
      closed.push({ market: p.market, side: p.side, size: p.size, filled: st.filled ? String(st.filled.totalSz) : '0' });
    } catch (e: any) {
      failed.push(`${p.market}: ${e?.message || e}`);
    }
  }
  return { ok: failed.length === 0, venue: 'hyperliquid', closed, cancelled, ...(failed.length ? { failed } : {}) };
}

async function cancelList(keys: AsterKeys, list: HlAccount['orders']): Promise<number> {
  if (!list.length) return 0;
  const idx = new Map((await universe()).map((m) => [m.name, m.index] as const));
  const cancels = list.filter((o) => idx.has(o.market)).map((o) => ({ a: idx.get(o.market)!, o: o.orderId }));
  if (!cancels.length) return 0;
  const res = await exchange(signAction({ type: 'cancel', cancels }, keys)).catch(() => null);
  const st: any[] = res?.data?.statuses || [];
  return st.filter((s) => s === 'success').length || (res ? cancels.length : 0);
}

export async function hlCancel(k: Kit, which?: unknown, orderId?: unknown) {
  const keys = await asterKeys(k);
  const acct = await hlAccount(keys.address);
  const only = which && !isAll(which) ? (await hlMarket(which)).name : null;
  const list = acct.orders.filter((x) => (!only || x.market === only) && (!orderId || String(x.orderId) === String(orderId)));
  if (!list.length) return { ok: true, venue: 'hyperliquid', cancelled: 0, note: 'No open orders matched.' };
  return { ok: true, venue: 'hyperliquid', cancelled: await cancelList(keys, list) };
}

/* ---------------------------------------------------- money in and out */

async function hypercoreToken(k: Kit): Promise<Token> {
  const t = (await k.tokens()).find((x) => x.assetId === HYPERCORE_USDC);
  return t || { assetId: HYPERCORE_USDC, symbol: 'USDC', decimals: 6, price: 1, blockchain: 'hypercore' };
}

/** Money from the vault into Hyperliquid: one private route, straight into the account. */
export async function hlDeposit(k: Kit, amount: unknown, coin: unknown, waitMs = 50_000) {
  const r = await perpsRules(k);
  mayOpen(r, 'hyperliquid');
  const keys = await asterKeys(k);
  await registerTradingAddress(k);
  const st = stateFor(keys);
  if (st.pending) {
    await hlAdvance(k);
    if (stateFor(keys).pending) {
      throw new KitError('Another move to or from Hyperliquid is still on its way.', { code: 'perps_busy', hint: 'Check it with perps, then try again.' });
    }
  }
  const src = await k.source(String(coin || 'USDC'), String(amount));
  if (src.token.rwa) throw new KitError('Stocks cannot go to Hyperliquid. Sell them first with swap.');
  const dollars = (Number(src.raw) / 10 ** src.token.decimals) * src.token.price;
  if (dollars < HL_IN_MIN) throw new KitError(`Hyperliquid takes at least $${HL_IN_MIN} from the vault. This is about $${usd(dollars)}.`, { code: 'perps_min' });
  if (r.perps?.leftUsd !== null && r.perps?.leftUsd !== undefined && dollars > r.perps.leftUsd + 0.005) {
    throw new KitError(`Your owner allows $${usd(r.perps.leftUsd)} more in perps.`, { code: 'agent_perps_cap', hint: 'Deposit less, or bring money back first.' });
  }
  const base = (await credits(keys.address)) ?? 0;
  const route = await k.route({ kind: 'withdraw', origin: src.token, dest: await hypercoreToken(k), raw: src.raw, recipient: keys.address, waitMs: 0 });
  st.pending = { kind: 'in', at: Date.now(), usd: usd(dollars), route: route.id, base };
  saveHl(st);
  return settle(k, keys, waitMs, { venue: 'hyperliquid', sent: `${usd(dollars)} dollars of ${src.token.symbol}` });
}

/** The withdrawal document, as the app signs it (fund-pro.js withdrawTyped). */
export function withdrawTyped(amountUsd: number, time: number, destination: string): { typed: TypedData; action: Record<string, unknown> } {
  const amount = Number(amountUsd).toFixed(2);
  const typed: TypedData = {
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      'HyperliquidTransaction:Withdraw': [
        { name: 'hyperliquidChain', type: 'string' },
        { name: 'destination', type: 'string' },
        { name: 'amount', type: 'string' },
        { name: 'time', type: 'uint64' },
      ],
    },
    primaryType: 'HyperliquidTransaction:Withdraw',
    domain: { name: 'HyperliquidSignTransaction', version: '1', chainId: 42161, verifyingContract: '0x0000000000000000000000000000000000000000' },
    message: { hyperliquidChain: 'Mainnet', destination, amount, time },
  };
  const action = { type: 'withdraw3', hyperliquidChain: 'Mainnet', signatureChainId: '0xa4b1', destination, amount, time };
  return { typed, action };
}

/**
 * Money from Hyperliquid home to the vault: the venue pays a private deposit
 * route into the vault directly. Always allowed: it is money coming home.
 */
export async function hlWithdraw(k: Kit, amount: unknown, waitMs = 50_000) {
  const keys = await asterKeys(k);
  const st = stateFor(keys);
  if (st.pending) {
    await hlAdvance(k);
    if (stateFor(keys).pending) {
      throw new KitError('Another move to or from Hyperliquid is still on its way.', { code: 'perps_busy', hint: 'Check it with perps, then try again.' });
    }
  }
  const acct = await hlAccount(keys.address);
  const max = acct.available;
  const want = isAll(String(amount ?? 'all')) ? Math.floor(max * 100) / 100 : Math.floor(Number(amount) * 100) / 100;
  if (!(want >= HL_OUT_MIN)) {
    throw new KitError(`At least $${HL_OUT_MIN} comes out of Hyperliquid at once (it keeps $${WITHDRAW_FEE}).`, {
      code: 'perps_min',
      hint: max >= HL_OUT_MIN ? undefined : `Hyperliquid can pay out $${usd(max)} now. Close positions or cancel orders to free more.`,
    });
  }
  if (want > max + 0.005) throw new KitError(`Hyperliquid can pay out up to $${usd(max)} now.`, { code: 'insufficient', hint: 'Close positions or cancel orders to free more.' });
  const q = await k.c.call<any>('/api/quote', {
    body: { kind: 'deposit', originAssetId: ARB_USDC, destinationAssetId: ARB_USDC, recipient: keys.address, refundTo: keys.address, dry: false },
  });
  const dest = String(q?.depositAddress || '');
  if (!/^0x[0-9a-fA-F]{40}$/.test(dest)) throw new KitError('The vault gave no address to withdraw to. Try again in a moment.', { code: 'perps_route' });
  if (String(q?.confidentiality || '') !== 'advanced') throw new KitError('No private route into the vault right now. Nothing moved. Try again.', { code: 'perps_route' });
  const min = Number(q?.minDepositFormatted) || 0;
  if (min && want - WITHDRAW_FEE < min) throw new KitError(`The vault takes at least ${min} USDC here, after Hyperliquid's $${WITHDRAW_FEE}.`, { code: 'perps_min' });
  const time = Date.now();
  const w = withdrawTyped(want, time, dest);
  await exchange({ action: w.action, nonce: time, signature: sigOf(typedDigest(w.typed), keys.trade) }, false);
  st.pending = { kind: 'out', at: time, usd: usd(want - WITHDRAW_FEE), route: dest };
  saveHl(st);
  return settle(k, keys, waitMs, { venue: 'hyperliquid', withdrew: `${w.action.amount} USDC from Hyperliquid`, fee: `$${WITHDRAW_FEE}` });
}

async function settle(k: Kit, keys: AsterKeys, waitMs: number, said: Record<string, unknown>) {
  const until = Date.now() + Math.max(0, waitMs);
  let step = await hlAdvance(k);
  while (stateFor(keys).pending && Date.now() < until) {
    await sleep(5000);
    step = await hlAdvance(k);
  }
  const left = stateFor(keys).pending;
  return {
    ok: true,
    ...said,
    status: left ? 'on its way' : 'done',
    ...(step?.note ? { note: step.note } : {}),
    ...(left ? { pending: view(left), next: 'It carries on by itself the next time the kit runs (any command). Check with perps.' } : {}),
  };
}

function view(p: InMove | OutMove) {
  return {
    venue: 'hyperliquid',
    direction: p.kind === 'in' ? 'vault to Hyperliquid' : 'Hyperliquid to vault',
    usd: p.usd,
    stage: p.kind === 'in' ? 'crossing from your vault into Hyperliquid' : 'crossing from Hyperliquid into your vault',
    since: new Date(p.at).toISOString(),
  };
}

/** One step of whatever is moving, and no waiting: called by every command. */
export async function hlAdvance(k: Kit): Promise<{ note?: string } | null> {
  const st0 = loadHl();
  if (!st0?.pending) return null;
  const keys = await asterKeys(k);
  const st = stateFor(keys);
  const p = st.pending;
  if (!p) return null;
  if (p.kind === 'in') {
    const n = await credits(keys.address);
    if (n !== null && n > p.base) {
      delete st.pending;
      saveHl(st);
      return { note: `In Hyperliquid: $${usd(p.usd)} arrived.` };
    }
    const s = await routeStatus(k, p.route);
    if (s === 'FAILED' || s === 'REFUNDED') {
      delete st.pending;
      saveHl(st);
      return { note: 'The move from the vault did not go through; the money stayed in the vault.' };
    }
    return { note: 'Crossing from the vault into Hyperliquid.' };
  }
  const s = await routeStatus(k, p.route);
  if (s === 'SUCCESS') {
    delete st.pending;
    saveHl(st);
    return { note: `$${usd(p.usd)} is back in your vault.` };
  }
  if (s === 'FAILED' || s === 'REFUNDED') {
    delete st.pending;
    saveHl(st);
    return { note: 'The vault route refunded to the trading address on Arbitrum. Tell your owner; their app can bring it home with your phrase.' };
  }
  return { note: 'Crossing from Hyperliquid into your vault.' };
}

export async function hlStatus(k: Kit) {
  const keys = await asterKeys(k);
  const step = await hlAdvance(k).catch((e) => ({ note: String((e as Error)?.message || e) }));
  const acct = await hlAccount(keys.address).catch(() => null);
  const st = stateFor(keys);
  return {
    account: acct
      ? { equityUsd: usd(acct.equity), availableUsd: usd(acct.available), marginUsd: usd(acct.margin), positions: acct.positions, openOrders: acct.orders }
      : 'Hyperliquid did not answer just now',
    ...(st.pending ? { moving: view(st.pending) } : {}),
    ...(step?.note ? { note: step.note } : {}),
  };
}

/**
 * Everything on Hyperliquid home to the vault: orders cancelled, positions
 * closed at market, the balance withdrawn. An agent that never used it
 * answers at once, without a call.
 */
export async function hlHome(k: Kit): Promise<{ done: boolean; note: string }> {
  if (!loadHl()) return { done: true, note: '' };
  const keys = await asterKeys(k);
  await hlAdvance(k).catch(() => null);
  const acct = await hlAccount(keys.address);
  if (acct.positions.length || acct.orders.length) await hlClose(k, 'all');
  if (!stateFor(keys).pending) {
    const now = acct.positions.length || acct.orders.length ? await hlAccount(keys.address) : acct;
    if (now.available >= HL_OUT_MIN) await hlWithdraw(k, 'all', 0).catch(() => null);
  }
  const left = stateFor(keys).pending;
  const rest = await hlAccount(keys.address).catch(() => null);
  const still = rest ? rest.available >= HL_OUT_MIN || rest.positions.length > 0 : false;
  if (!left && !still) return { done: true, note: '' };
  return { done: false, note: left ? `Hyperliquid money is coming home: ${view(left).stage}.` : 'Money is still on Hyperliquid; it is brought home on the next run.' };
}
