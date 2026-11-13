/**
 * Perps for an agent, Hyperliquid and Aster combined.
 *
 * One trading account, one address on both venues (aster.ts asterKeys), one
 * set of owner rules over both: a switch, a leverage cap, and a cap on the
 * dollars in perps that counts both venues together (worker/agents.ts). This
 * file only routes: each venue's own module does the work.
 *
 * A venue left out is the only one open to the agent, or, for reads and for
 * bringing money home, both; for anything that opens a position or sends
 * money in, a choice between two open venues is the agent's to make.
 */
import { KitError, type Kit } from './kit';
import {
  advance as asterAdvance,
  asterCancel,
  asterClose,
  asterDeposit,
  asterHome,
  asterMarkets,
  asterOrder,
  asterStatus,
  asterWithdraw,
  asterAccount,
  asterKeys,
  loadAster,
  perpsRules,
  type PerpsRules,
} from './aster';
import { hlAccount, hlAdvance, hlCancel, hlClose, hlDeposit, hlHome, hlMarkets, hlOrder, hlStatus, hlWithdraw, loadHl } from './hyperliquid';
import { isAll } from './amounts';

export type Venue = 'hyperliquid' | 'aster';
export const VENUES: Venue[] = ['hyperliquid', 'aster'];
const NAME: Record<Venue, string> = { hyperliquid: 'Hyperliquid', aster: 'Aster' };

/** "hl", "hyperliquid", "aster": a venue, or null when none was named. */
export function venueOf(v: unknown): Venue | null {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return null;
  if (s === 'hl' || s === 'hyperliquid' || s === 'hyper') return 'hyperliquid';
  if (s === 'aster' || s === 'asterdex') return 'aster';
  throw new KitError('The venue is hyperliquid or aster.', { code: 'perps_venue' });
}

/** The venues open to this agent, from its owner's rules (an older server names only Aster). */
export function venuesOpen(p: PerpsRules | null): Venue[] {
  if (!p) return [];
  if (p.venues) return VENUES.filter((v) => p.venues![v]);
  return p.offered ? ['aster'] : [];
}

async function pick(k: Kit, venue: unknown, what: string): Promise<Venue> {
  const named = venueOf(venue);
  if (named) return named;
  const open = venuesOpen((await perpsRules(k)).perps);
  if (open.length === 1) return open[0];
  if (!open.length) throw new KitError('Perps are not open to this agent yet.', { code: 'agent_no_perps' });
  throw new KitError(`Name a venue for ${what}: hyperliquid or aster.`, { code: 'perps_venue', hint: 'Add --venue hyperliquid or --venue aster.' });
}

/** Both venues, or the one named: for reads and for closing, which never need a choice. */
async function both(k: Kit, venue: unknown): Promise<Venue[]> {
  const named = venueOf(venue);
  if (named) return [named];
  const open = venuesOpen((await perpsRules(k)).perps);
  /* money already on a venue counts as open for closing it, whatever the rules say now */
  if (loadHl() && !open.includes('hyperliquid')) open.push('hyperliquid');
  if (loadAster() && !open.includes('aster')) open.push('aster');
  return open.length ? open : ['hyperliquid'];
}

/** Whether money sits on a venue. A venue that does not answer counts only when this machine has used it. */
export async function perpsHolds(k: Kit): Promise<boolean> {
  const keys = await asterKeys(k);
  const hl = await hlAccount(keys.address).catch(() => null);
  if (hl ? hl.equity >= 0.5 : Boolean(loadHl())) return true;
  if (!loadAster()) return false;
  const aster = await asterAccount(keys).catch(() => null);
  return !aster || aster.equity >= 0.5;
}

export async function perpsStatus(k: Kit) {
  const r = await perpsRules(k);
  const p = r.perps;
  const open = venuesOpen(p);
  const out: Record<string, unknown> = {
    rules: p
      ? {
          perps: !open.length ? 'not open to this agent yet' : p.on ? `on, on ${open.map((v) => NAME[v]).join(' and ')}` : 'off: your owner turns it on in Agent Wallets, Settings',
          leverageMax: p.leverageMax,
          limitUsd: p.limitUsd,
          inPerpsUsd: p.onPerpsUsd ?? p.onAsterUsd,
          leftUsd: p.leftUsd,
        }
      : 'pair with your owner first',
  };
  if (open.includes('hyperliquid') || loadHl()) out.hyperliquid = await hlStatus(k).catch((e) => ({ error: String((e as Error)?.message || e) }));
  if (open.includes('aster') || loadAster()) out.aster = await asterStatus(k).catch((e) => ({ error: String((e as Error)?.message || e) }));
  return out;
}

export async function perpsMarkets(search?: string, venue?: unknown, limit = 25) {
  const named = venueOf(venue);
  const lists = await Promise.all([
    !named || named === 'hyperliquid' ? hlMarkets(search, limit).catch(() => []) : Promise.resolve([]),
    !named || named === 'aster' ? asterMarkets(search, limit).then((l) => l.map((m) => ({ venue: 'aster', ...m }))).catch(() => []) : Promise.resolve([]),
  ]);
  return lists
    .flat()
    .sort((a: any, b: any) => (b.volume24hUsd || 0) - (a.volume24hUsd || 0))
    .slice(0, Math.max(1, Math.min(100, limit)));
}

export async function perpsDeposit(k: Kit, amount: unknown, coin: unknown, venue: unknown, waitMs = 50_000) {
  const v = await pick(k, venue, 'a deposit');
  return v === 'aster' ? asterDeposit(k, amount, coin, waitMs) : hlDeposit(k, amount, coin, waitMs);
}

export async function perpsOrder(
  k: Kit,
  o: { market: unknown; side: unknown; size?: unknown; usd?: unknown; price?: unknown; leverage?: unknown; reduceOnly?: boolean; venue?: unknown },
) {
  const v = await pick(k, o.venue, 'an order');
  if (v === 'aster') return { venue: 'aster', ...(await asterOrder(k, o)) };
  return hlOrder(k, o);
}

export async function perpsClose(k: Kit, market: unknown, venue: unknown) {
  const out: unknown[] = [];
  for (const v of await both(k, venue)) {
    out.push(v === 'aster' ? { venue: 'aster', ...(await asterClose(k, market || 'all')) } : await hlClose(k, market || 'all'));
  }
  return out.length === 1 ? out[0] : { ok: out.every((x: any) => x?.ok !== false), venues: out };
}

export async function perpsCancel(k: Kit, market: unknown, orderId: unknown, venue: unknown) {
  const out: unknown[] = [];
  for (const v of await both(k, venue)) {
    out.push(v === 'aster' ? { venue: 'aster', ...(await asterCancel(k, market || 'all', orderId)) } : await hlCancel(k, market || 'all', orderId));
  }
  return out.length === 1 ? out[0] : { ok: true, venues: out };
}

export async function perpsWithdraw(k: Kit, amount: unknown, venue: unknown, waitMs = 50_000) {
  /* "all" without a venue brings both home; a figure needs to say where it comes from */
  if (!venueOf(venue) && isAll(String(amount ?? 'all'))) {
    const out: unknown[] = [];
    for (const v of await both(k, null)) {
      out.push(await (v === 'aster' ? asterWithdraw(k, 'all', waitMs) : hlWithdraw(k, 'all', waitMs)).catch((e) => ({ venue: v, error: String((e as Error)?.message || e), code: (e as any)?.code })));
    }
    return out.length === 1 ? out[0] : { ok: true, venues: out };
  }
  const v = await pick(k, venue, 'a withdrawal');
  return v === 'aster' ? asterWithdraw(k, amount ?? 'all', waitMs) : hlWithdraw(k, amount ?? 'all', waitMs);
}

/** A move under way on either venue, carried one step on (every command runs this). */
export async function perpsAdvance(k: Kit): Promise<void> {
  if (loadAster()?.pending) await asterAdvance(k).catch(() => null);
  if (loadHl()?.pending) await hlAdvance(k).catch(() => null);
}

/** Everything in perps home to the vault, both venues; done when nothing is left there or moving. */
export async function perpsHome(k: Kit): Promise<{ done: boolean; note: string }> {
  const [a, h] = await Promise.all([
    asterHome(k).catch((e: any) => ({ done: false, note: `Aster: ${e?.message || e}` })),
    hlHome(k).catch((e: any) => ({ done: false, note: `Hyperliquid: ${e?.message || e}` })),
  ]);
  return { done: a.done && h.done, note: [h.note, a.note].filter(Boolean).join(' ') };
}

