/**
 * Private AI's credit and API keys, one Durable Object per account (AI_DO,
 * idFromName(uid)); worker/privateai.ts and worker/aiapi.ts are its callers.
 *
 * An API key can be used from many machines at once, and KV has no
 * compare-and-swap: two requests reading one balance would both spend it, and
 * a top-up written beside a charge could erase it. Here every movement runs
 * inside one object, one at a time (blockConcurrencyWhile), so credit is never
 * spent twice and a paid top-up is never added twice or lost.
 *
 * Money is integer micro-dollars: $1 = 1,000,000. The balance never goes
 * below zero.
 *
 *   credit   a paid top-up (or an owner's grant), once per reference
 *   hold     before a question: the most it can cost leaves the balance at
 *            once, refused when the balance cannot cover it or the key is off
 *   settle   after the answer: its true cost stays, the rest comes back
 *   release  the question failed: the whole hold comes back
 *   (alarm)  a hold nobody settled within HOLD_MS comes back
 *
 * The owner's own use is free (the owner's word, 2026-10-14) but still counted,
 * so what an answer really costs is measured before anyone else pays for one.
 *
 * Keys live here too. KV keeps only the index from a key's hash to its account
 * (aikey:<sha256>, worker/aiapi.ts); every hold checks the key here, where a
 * revocation is the truth at once, whatever an edge cache of KV still says.
 *
 * The rules are pure functions over one plain record (applyOp), so the check
 * script runs them without a Durable Object at all.
 */

export const MICRO = 1_000_000;
/** an unsettled hold comes back after this long: no answer takes a quarter of an hour */
export const HOLD_MS = 15 * 60_000;
/** what a top-up may be, in dollars (index.ts /api/ai/credit/order): one list for the phone and the worker */
export { AI_TOPUPS } from '../src/lib/aiLimits';
/** active keys per account */
export const MAX_KEYS = 10;
/** kept for the screen: the latest top-ups, and revoked keys for a while */
const KEEP_TOPUPS = 20;
const KEEP_REVOKED = 20;
/** top-up references remembered, newest first; an order older than these can no longer be re-granted anyway */
const KEEP_REFS = 500;

/** hash is the key's SHA-256, kept so a revocation can delete its index; the key itself is never stored */
export type AiKey = { id: string; name: string; last4: string; created: number; revoked?: number; hash?: string };
export type AiUse = { n: number; in: number; out: number; micro: number; last: number };
export type AiHold = { micro: number; at: number; key: string };
export type AiTopup = { at: number; micro: number; ref: string; note: string };

export interface LedgerRecord {
  bal: number;
  holds: Record<string, AiHold>;
  keys: AiKey[];
  /** per key id, and 'chat' for the app's own chat */
  use: Record<string, AiUse>;
  topups: AiTopup[];
  refs: string[];
  /** cost an answer ran over its hold and the balance could not cover: the house's, never the person's */
  shortfall: number;
}

export function emptyLedger(): LedgerRecord {
  return { bal: 0, holds: {}, keys: [], use: {}, topups: [], refs: [], shortfall: 0 };
}

export type LedgerOp =
  | { op: 'state' }
  | { op: 'credit'; ref: string; micro: number; note?: string }
  | { op: 'hold'; micro: number; key: string; free?: boolean; id?: string }
  | { op: 'settle'; hold: string; micro: number; key: string; tokensIn: number; tokensOut: number; free?: boolean }
  | { op: 'release'; hold: string }
  | { op: 'addKey'; key: AiKey }
  | { op: 'revokeKey'; id: string }
  | { op: 'expire' };

export type LedgerReply = Record<string, unknown> & { ok: boolean };

const whole = (n: unknown) => (Number.isFinite(Number(n)) ? Math.max(0, Math.floor(Number(n))) : 0);

/** A key may be used: it exists here and was never revoked. 'chat' is the app's own chat, always allowed. */
function keyLive(l: LedgerRecord, key: string): boolean {
  if (key === 'chat') return true;
  const k = l.keys.find((x) => x.id === key);
  return Boolean(k && !k.revoked);
}

function count(l: LedgerRecord, key: string, tokensIn: number, tokensOut: number, micro: number, now: number) {
  const u = l.use[key] || { n: 0, in: 0, out: 0, micro: 0, last: 0 };
  l.use[key] = { n: u.n + 1, in: u.in + whole(tokensIn), out: u.out + whole(tokensOut), micro: u.micro + whole(micro), last: now };
}

/**
 * One movement, applied to the record in place. Pure apart from the record:
 * the Durable Object below wraps it in one critical section and one write.
 */
export function applyOp(l: LedgerRecord, o: LedgerOp, now: number): LedgerReply {
  switch (o.op) {
    case 'state':
      return { ok: true, bal: l.bal, held: Object.values(l.holds).reduce((s, h) => s + h.micro, 0), keys: l.keys, use: l.use, topups: l.topups };

    case 'credit': {
      const ref = String(o.ref || '');
      const micro = whole(o.micro);
      if (!ref || micro <= 0) return { ok: false, why: 'bad_credit' };
      /* once per reference: a payment polled twice, or granted by the cron and the app at once, adds once */
      if (l.refs.includes(ref)) return { ok: true, dup: true, bal: l.bal };
      l.bal += micro;
      l.refs = [ref, ...l.refs].slice(0, KEEP_REFS);
      l.topups = [{ at: now, micro, ref, note: String(o.note || '').slice(0, 80) }, ...l.topups].slice(0, KEEP_TOPUPS);
      return { ok: true, bal: l.bal };
    }

    case 'hold': {
      if (!keyLive(l, o.key)) return { ok: false, why: 'key_off' };
      const micro = o.free ? 0 : whole(o.micro);
      if (micro > l.bal) return { ok: false, why: 'no_credit', bal: l.bal, need: micro };
      const id = o.id || `h${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      l.bal -= micro;
      l.holds[id] = { micro, at: now, key: o.key };
      return { ok: true, hold: id, bal: l.bal };
    }

    case 'settle': {
      const cost = o.free ? 0 : whole(o.micro);
      const h = l.holds[o.hold];
      let charged = cost;
      if (h) {
        delete l.holds[o.hold];
        if (cost <= h.micro) l.bal += h.micro - cost;
        else {
          /* the answer ran over its hold (a usage figure the hold could not foresee): the rest from the balance,
             as far as it reaches, and never below zero */
          const extra = Math.min(cost - h.micro, l.bal);
          l.bal -= extra;
          charged = h.micro + extra;
          l.shortfall += cost - charged;
        }
      } else if (cost > 0) {
        /* its hold already came back (settled after HOLD_MS): charged now, as far as the balance reaches */
        charged = Math.min(cost, l.bal);
        l.bal -= charged;
        l.shortfall += cost - charged;
      }
      count(l, o.key, o.tokensIn, o.tokensOut, o.free ? whole(o.micro) : charged, now);
      return { ok: true, bal: l.bal, charged };
    }

    case 'release': {
      const h = l.holds[o.hold];
      if (h) {
        delete l.holds[o.hold];
        l.bal += h.micro;
      }
      return { ok: true, bal: l.bal };
    }

    case 'addKey': {
      const k = o.key;
      if (!k?.id || !/^k[0-9a-f]{12}$/.test(k.id)) return { ok: false, why: 'bad_key' };
      if (l.keys.some((x) => x.id === k.id)) return { ok: false, why: 'bad_key' };
      if (l.keys.filter((x) => !x.revoked).length >= MAX_KEYS) return { ok: false, why: 'too_many' };
      l.keys.push({ id: k.id, name: String(k.name || '').slice(0, 40), last4: String(k.last4 || '').slice(0, 4), created: now, ...(/^[0-9a-f]{64}$/.test(String(k.hash)) ? { hash: String(k.hash) } : {}) });
      return { ok: true };
    }

    case 'revokeKey': {
      const k = l.keys.find((x) => x.id === o.id);
      if (!k) return { ok: false, why: 'no_key' };
      if (!k.revoked) k.revoked = now;
      /* the newest revoked ones stay on the list for a while, the rest leave it (their spend stays in use) */
      const revoked = l.keys.filter((x) => x.revoked).sort((a, b) => (b.revoked || 0) - (a.revoked || 0));
      const drop = new Set(revoked.slice(KEEP_REVOKED).map((x) => x.id));
      l.keys = l.keys.filter((x) => !drop.has(x.id));
      return { ok: true };
    }

    case 'expire': {
      let back = 0;
      for (const [id, h] of Object.entries(l.holds)) {
        if (now - h.at < HOLD_MS) continue;
        delete l.holds[id];
        l.bal += h.micro;
        back += h.micro;
      }
      return { ok: true, back, next: Object.values(l.holds).reduce((m, h) => Math.min(m, h.at + HOLD_MS), Infinity) };
    }
  }
  return { ok: false, why: 'bad_op' };
}

/* ------------------------------------------------------------ the object */

interface StorageLike {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  setAlarm(at: number): Promise<void>;
  getAlarm(): Promise<number | null>;
}
interface StateLike {
  storage: StorageLike;
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
}

export class AiLedger {
  private state: StateLike;

  constructor(state: StateLike) {
    this.state = state;
  }

  private async run(o: LedgerOp, now = Date.now()): Promise<LedgerReply> {
    let reply: LedgerReply = { ok: false };
    /* read, decide and write as one: no other movement on this account is delivered in between */
    await this.state.blockConcurrencyWhile(async () => {
      const l = (await this.state.storage.get<LedgerRecord>('l')) || emptyLedger();
      reply = applyOp(l, o, now);
      if (o.op !== 'state') await this.state.storage.put('l', l);
      /* an outstanding hold always has an alarm to bring it back */
      if (o.op === 'hold' && reply.ok && !(await this.state.storage.getAlarm())) await this.state.storage.setAlarm(now + HOLD_MS + 5_000);
    });
    return reply;
  }

  async fetch(request: Request): Promise<Response> {
    const o = (await request.json().catch(() => null)) as LedgerOp | null;
    const reply = o && typeof o.op === 'string' ? await this.run(o) : { ok: false, why: 'bad_op' };
    return new Response(JSON.stringify(reply), { headers: { 'Content-Type': 'application/json' } });
  }

  async alarm(): Promise<void> {
    const r = await this.run({ op: 'expire' });
    const next = Number(r.next);
    if (Number.isFinite(next)) await this.state.storage.setAlarm(next + 5_000);
  }
}

/* ------------------------------------------------------------ its callers' handle */

export interface AiLedgerNs {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(url: string, init?: RequestInit): Promise<Response> };
}

export type Ledger = (o: LedgerOp) => Promise<LedgerReply>;

/** The account's ledger, or null where this worker has no AI_DO binding. A ledger that cannot be reached answers ok: false. */
export function ledgerOf(ns: AiLedgerNs | undefined, uid: string): Ledger | null {
  if (!ns || !uid) return null;
  const stub = ns.get(ns.idFromName(`ai:${uid}`));
  return async (o) => {
    try {
      const r = await stub.fetch('https://ai-ledger/op', { method: 'POST', body: JSON.stringify(o), headers: { 'Content-Type': 'application/json' } });
      return ((await r.json()) as LedgerReply) || { ok: false, why: 'unreachable' };
    } catch {
      return { ok: false, why: 'unreachable' };
    }
  };
}

/* ------------------------------------------------------------ price */

/** Dollars per million tokens, in and out. $0.50 per million tokens is half a micro-dollar per token. */
export type AiPrice = { inPerM: number; outPerM: number };

export const DEFAULT_PRICE: AiPrice = { inPerM: 0.5, outPerM: 1.5 };

/** What tokens cost, in whole micro-dollars, rounded up so a request is never free by rounding. */
export function costMicro(p: AiPrice, tokensIn: number, tokensOut: number): number {
  const c = whole(tokensIn) * p.inPerM + whole(tokensOut) * p.outPerM;
  return c > 0 ? Math.ceil(c - 1e-9) : 0;
}

/** A price the owner may set: positive, and under $100 per million either way. */
export function cleanPrice(p: unknown): AiPrice | null {
  const inPerM = Number((p as AiPrice)?.inPerM);
  const outPerM = Number((p as AiPrice)?.outPerM);
  if (!(inPerM > 0 && inPerM <= 100 && outPerM > 0 && outPerM <= 100)) return null;
  return { inPerM: Math.round(inPerM * 10_000) / 10_000, outPerM: Math.round(outPerM * 10_000) / 10_000 };
}
