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
 *   release  the network did no work: the whole hold comes back
 *   (alarm)  a hold nobody settled within its life comes back; a stream's is spent
 *
 * The owner's own use is free but still counted,
 * so what an answer really costs is measured before anyone else pays for one.
 *
 * Keys live here too. KV keeps only the index from a key's hash to its account
 * (aikey:<sha256>, worker/aiapi.ts); every hold checks the key here, where a
 * revocation is the truth at once, whatever an edge cache of KV still says.
 *
 * The rules are pure functions over one plain record (applyOp), so the check
 * script runs them without a Durable Object at all.
 *
 * Each settled request also leaves one row in the usage history: the model, its tokens, what the cache
 * read, what it cost and where it came from. The rows live beside the record,
 * one storage key each in time order (u:<ms>:<rand>), written in the same
 * critical section as the charge, and the record keeps a total per day.
 */

export const MICRO = 1_000_000;
/** an unsettled hold comes back after this long: no answer takes a quarter of an hour */
export const HOLD_MS = 15 * 60_000;
/** a free question's hold: the chat stops waiting for its answer well before this */
export const FREE_HOLD_MS = 90_000;
/** A stream's hold. A stream runs as long as its reader reads, so its hold waits for its end, up to a day. */
export const STREAM_HOLD_MS = 24 * 3_600_000;
/** what a top-up may be, in dollars (index.ts /api/ai/credit/order): one list for the phone and the worker */
export { AI_TOPUPS, AI_CREDIT_MAX, AI_CREDIT_MIN, aiTopupOk } from '../src/lib/aiLimits';
/** active keys per account */
export const MAX_KEYS = 10;
/** kept for the screen: the latest top-ups, and revoked keys for a while */
const KEEP_TOPUPS = 20;
const KEEP_REVOKED = 20;
/** top-up references remembered, newest first; an order older than these can no longer be re-granted anyway */
const KEEP_REFS = 500;

/** the usage history keeps the newest USE_KEEP rows, none older than USE_KEEP_DAYS, and the record a total per day */
export const USE_KEEP = 5000;
export const USE_KEEP_DAYS = 90;
const KEEP_DAYS = 62;
/** rows past USE_KEEP before they are cleared, so a busy account clears in batches rather than on every request */
const USE_SLACK = 250;

/** hash is the key's SHA-256, kept so a revocation can delete its index; the key itself is never stored */
export type AiKey = { id: string; name: string; last4: string; created: number; revoked?: number; hash?: string };
export type AiUse = { n: number; in: number; out: number; micro: number; last: number };
/**
 * fb: the most a free request held under a day's cap may cost, counted against the cap until it settles
 * life: how long it stands, unless HOLD_MS; spend: a stream's, spent if nobody settles it, since its answer may have
 * been read; m: the model, for that row
 */
export type AiHold = { micro: number; at: number; key: string; fb?: number; life?: number; spend?: 1; m?: string; st?: 1 };
export type AiTopup = { at: number; micro: number; ref: string; note: string };

/**
 * One request in the usage history: micro-dollars and the network's own token counts.
 *   t settled at; k 'chat' or the key's id; m the model; i, o tokens in and out; c of the tokens in, read from cache
 *   $ charged; w what it was worth, where that differs ($ 0 when free, less where the balance ran short)
 *   f free: 1 the owner's own use, 2 the free chat; s streamed; ms how long the answer took
 *   x h: the caller hung up before the end; u: no count came back, so the most it could cost was charged
 */
export type AiRow = { t: number; k: string; m: string; i: number; o: number; c?: number; $: number; w?: number; f?: 1 | 2; s?: 1; ms?: number; x?: 'h' | 'u' };
/** A UTC day's totals: requests, tokens, charged, worth, and worth per source (k) and per model (m). */
export type AiDay = { n: number; i: number; o: number; c: number; $: number; w: number; k: Record<string, number>; m: Record<string, number> };

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
  /** what the account's free API keys spent on one UTC day (the owner's, worker/aiapi.ts) */
  free?: { day: string; micro: number };
  /** the account's free questions on one UTC day (worker/privateai.ts), counted one at a time */
  asks?: { day: string; n: number };
  /** the usage history's totals per UTC day, the newest KEEP_DAYS */
  days?: Record<string, AiDay>;
  /** rows the usage history holds, so the object knows when to clear the oldest */
  rows?: number;
}

export function emptyLedger(): LedgerRecord {
  return { bal: 0, holds: {}, keys: [], use: {}, topups: [], refs: [], shortfall: 0 };
}

/** what a request's row says beyond the charge: a settle without a model leaves no row (the house's free chat ledger) */
export type RowFacts = { model?: string; cached?: number; stream?: boolean; ms?: number; note?: 'h' | 'u' };

export type LedgerOp =
  | { op: 'state' }
  | { op: 'credit'; ref: string; micro: number; note?: string }
  | { op: 'hold'; micro: number; key: string; free?: boolean; id?: string; freeCap?: number; life?: number; spend?: boolean; model?: string }
  | { op: 'keep'; hold: string; model?: string }
  | ({ op: 'settle'; hold: string; micro: number; key: string; tokensIn: number; tokensOut: number; free?: boolean } & RowFacts)
  | { op: 'release'; hold: string }
  /* one of the account's free questions for the day, if any are left; unask gives back one the network did no work for */
  | { op: 'ask'; day: string; max: number }
  | { op: 'unask'; day: string }
  | { op: 'addKey'; key: AiKey }
  | { op: 'revokeKey'; id: string }
  | { op: 'expire' }
  /* a question the house paid for (the free chat): a row in the asker's history, worth micro, nothing charged */
  | ({ op: 'log'; key: string; micro: number; tokensIn: number; tokensOut: number } & RowFacts)
  /* the usage history, newest first: a page before `before`, since `from`, of one model or source; `span` also
     asks for every row since now - span, for a day's figures (the Durable Object answers it, not applyOp) */
  | { op: 'usage'; before?: string; from?: number; limit?: number; model?: string; key?: string; span?: number; live?: boolean };

export type LedgerReply = Record<string, unknown> & { ok: boolean };

const whole = (n: unknown) => (Number.isFinite(Number(n)) ? Math.max(0, Math.floor(Number(n))) : 0);

/** A key may be used: it exists here and was never revoked. 'chat' is the app's own chat, always allowed. */
function keyLive(l: LedgerRecord, key: string): boolean {
  if (key === 'chat' || key === 'scan') return true;
  const k = l.keys.find((x) => x.id === key);
  return Boolean(k && !k.revoked);
}

const dayOf = (now: number) => new Date(now).toISOString().slice(0, 10);
const lifeOf = (h: Pick<AiHold, 'life'>) => h.life ?? HOLD_MS;

/** What the free API keys have spent today: settled, plus the most each free request still on hold may cost. */
export function freeUsed(l: LedgerRecord, now: number): number {
  const settled = l.free?.day === dayOf(now) ? whole(l.free.micro) : 0;
  return settled + Object.values(l.holds).reduce((s, h) => s + whole(h.fb), 0);
}

function count(l: LedgerRecord, key: string, tokensIn: number, tokensOut: number, micro: number, now: number) {
  const u = l.use[key] || { n: 0, in: 0, out: 0, micro: 0, last: 0 };
  l.use[key] = { n: u.n + 1, in: u.in + whole(tokensIn), out: u.out + whole(tokensOut), micro: u.micro + whole(micro), last: now };
}

/** A model id as a row keeps it: printable, short. Anything else is no model, and no row. */
const MODEL_RE = /^[\w.:/@+-]{1,120}$/;

/** The row a request leaves, and its day's totals; null when the caller named no model (no row, as before). */
function rowOf(l: LedgerRecord, key: string, f: RowFacts, tokensIn: number, tokensOut: number, charged: number, worth: number, free: 0 | 1 | 2, now: number): AiRow | null {
  if (typeof f.model !== 'string' || !MODEL_RE.test(f.model)) return null;
  const i = whole(tokensIn);
  const cached = Math.min(whole(f.cached), i);
  const row: AiRow = { t: now, k: String(key).slice(0, 40), m: f.model, i, o: whole(tokensOut), $: whole(charged) };
  if (cached > 0) row.c = cached;
  if (whole(worth) !== row.$) row.w = whole(worth);
  if (free) row.f = free;
  if (f.stream) row.s = 1;
  if (whole(f.ms) > 0) row.ms = Math.min(whole(f.ms), 3_600_000);
  if (f.note === 'h' || f.note === 'u') row.x = f.note;
  const day = dayOf(now);
  const days = (l.days ||= {});
  const d = (days[day] ||= { n: 0, i: 0, o: 0, c: 0, $: 0, w: 0, k: {}, m: {} });
  const w = row.w ?? row.$;
  d.n += 1;
  d.i += row.i;
  d.o += row.o;
  d.c += row.c || 0;
  d.$ += row.$;
  d.w += w;
  d.k[row.k] = (d.k[row.k] || 0) + w;
  d.m[row.m] = (d.m[row.m] || 0) + w;
  for (const old of Object.keys(days).sort().slice(0, -KEEP_DAYS)) delete days[old];
  l.rows = whole(l.rows) + 1;
  return row;
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
      const bound = whole(o.micro);
      /* Free use spends no credit. Where the caller sets a day's cap (the owner's API keys), a day's free spend,
         with what is still on hold, stays under it: a key that leaks cannot spend the house's upstream credit
         without end. */
      const cap = o.free ? whole(o.freeCap) : 0;
      if (cap > 0) {
        const used = freeUsed(l, now);
        /* settled: what the day has truly spent, apart from what is only in flight */
        if (used + bound > cap) return { ok: false, why: 'free_cap', used, cap, settled: l.free?.day === dayOf(now) ? whole(l.free.micro) : 0 };
      }
      const micro = o.free ? 0 : bound;
      if (micro > l.bal) return { ok: false, why: 'no_credit', bal: l.bal, need: micro };
      const id = o.id || `h${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      l.bal -= micro;
      const life = Math.min(whole(o.life), STREAM_HOLD_MS);
      l.holds[id] = {
        micro,
        at: now,
        key: o.key,
        ...(cap > 0 ? { fb: bound } : {}),
        ...(life > 0 ? { life } : {}),
        ...(o.spend ? { spend: 1 as const, ...(typeof o.model === 'string' ? { m: o.model } : {}) } : {}),
      };
      return { ok: true, hold: id, bal: l.bal };
    }

    /* The network is streaming an answer, so from here the hold is what that answer may cost: it stands as long as a
       stream can run, and it is spent if nobody settles it. Before this, a request nothing came back for gets its hold back. */
    case 'keep': {
      const h = l.holds[String(o.hold)];
      if (!h) return { ok: false, why: 'no_hold' };
      h.life = STREAM_HOLD_MS;
      h.spend = 1;
      h.st = 1;
      if (typeof o.model === 'string') h.m = o.model;
      return { ok: true };
    }

    case 'settle': {
      const cost = o.free ? 0 : whole(o.micro);
      const h = l.holds[o.hold];
      /* a free request held under a day's cap: its true cost joins the day's free spend */
      if (o.free && h?.fb !== undefined) {
        const day = dayOf(now);
        l.free = { day, micro: (l.free?.day === day ? whole(l.free.micro) : 0) + whole(o.micro) };
      }
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
      /* its row in the usage history: nothing charged when free, and worth what it cost either way */
      const row = rowOf(l, o.key, o, o.tokensIn, o.tokensOut, o.free ? 0 : charged, o.micro, o.free ? 1 : 0, now);
      const short = cost - charged;
      return { ok: true, bal: l.bal, charged, ...(short > 0 ? { short } : {}), ...(row ? { row } : {}) };
    }

    case 'log': {
      const row = rowOf(l, o.key, o, o.tokensIn, o.tokensOut, 0, o.micro, 2, now);
      return row ? { ok: true, row } : { ok: false, why: 'bad_row' };
    }

    case 'release': {
      const h = l.holds[o.hold];
      if (h) {
        delete l.holds[o.hold];
        l.bal += h.micro;
      }
      return { ok: true, bal: l.bal };
    }

    case 'ask': {
      const n = l.asks?.day === o.day ? whole(l.asks.n) : 0;
      if (n >= whole(o.max)) return { ok: false, why: 'asked', n };
      l.asks = { day: o.day, n: n + 1 };
      return { ok: true, n: n + 1 };
    }

    case 'unask': {
      if (l.asks?.day === o.day && l.asks.n > 0) l.asks.n -= 1;
      return { ok: true };
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
      const rows: AiRow[] = [];
      for (const [id, h] of Object.entries(l.holds)) {
        if (now - h.at < lifeOf(h)) continue;
        delete l.holds[id];
        /* free use nobody settled: the most it may have cost joins the day's spend */
        if (h.fb !== undefined) {
          const day = dayOf(now);
          l.free = { day, micro: (l.free?.day === day ? whole(l.free.micro) : 0) + whole(h.fb) };
        }
        if (h.spend) {
          count(l, h.key, 0, 0, h.micro, now);
          const row = rowOf(l, h.key, { model: h.m, stream: h.st === 1, note: 'h' }, 0, 0, h.micro, h.micro, 0, now);
          if (row) rows.push(row);
        } else {
          l.bal += h.micro;
          back += h.micro;
        }
      }
      return { ok: true, back, next: Object.values(l.holds).reduce((m, h) => Math.min(m, h.at + lifeOf(h)), Infinity), ...(rows.length ? { rows } : {}) };
    }
  }
  return { ok: false, why: 'bad_op' };
}

/* ------------------------------------------------------------ the object */

export interface StorageLike {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(keys: string[]): Promise<number>;
  list<T>(o: { prefix?: string; start?: string; end?: string; reverse?: boolean; limit?: number }): Promise<Map<string, T>>;
  setAlarm(at: number): Promise<void>;
  getAlarm(): Promise<number | null>;
}
export interface StateLike {
  storage: StorageLike;
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
}

/* ------------------------------------------------------------ the usage history's rows */

/** a row's storage key: its time first, so the keys list in time order, and six letters so two never collide */
const pad = (t: number) => String(whole(t)).padStart(13, '0');
export const ROW_KEY = /^u:\d{13}:[a-z0-9]{6}$/;
const rowKey = (t: number) => `u:${pad(t)}:${Math.random().toString(36).slice(2, 8).padEnd(6, '0')}`;
/** rows read for one page at most, however few a filter keeps: a page is never a walk through the whole history */
export const SCAN_MAX = 2000;

/** The oldest rows past what is kept: older than USE_KEEP_DAYS, then past USE_KEEP. */
async function prune(s: StorageLike, l: LedgerRecord, now: number): Promise<void> {
  let gone = 0;
  const aged = `u:${pad(now - USE_KEEP_DAYS * 86_400_000)}`;
  for (;;) {
    const batch = await s.list<AiRow>({ prefix: 'u:', end: aged, limit: 128 });
    if (!batch.size) break;
    gone += await s.delete([...batch.keys()]);
    if (batch.size < 128) break;
  }
  let over = whole(l.rows) - gone - USE_KEEP;
  while (over > 0) {
    const batch = await s.list<AiRow>({ prefix: 'u:', limit: Math.min(128, over) });
    if (!batch.size) break;
    gone += await s.delete([...batch.keys()]);
    over -= batch.size;
  }
  l.rows = Math.max(0, whole(l.rows) - gone);
}

/**
 * A page of the usage history, newest first: since `from`, before the row `before`, of one model or source. `next`
 * continues it (null once nothing older is left). The day totals and the keys' names come with it, to label it,
 * and with `span`, every row since now - span (a day's figures are drawn from rows, not from day totals).
 */
async function usageOf(s: StorageLike, l: LedgerRecord, o: Extract<LedgerOp, { op: 'usage' }>, now: number): Promise<LedgerReply> {
  /* a key reading its own rows must still be a key, whatever an edge cache of KV says */
  if (o.live && !keyLive(l, String(o.key))) return { ok: false, why: 'key_off' };
  const limit = Math.min(200, Math.max(1, whole(o.limit) || 50));
  const start = `u:${pad(whole(o.from))}`;
  let end = typeof o.before === 'string' && ROW_KEY.test(o.before) ? o.before : 'u:~';
  const keep = (r: AiRow) => (!o.model || r.m === o.model) && (!o.key || r.k === o.key);
  const rows: Array<AiRow & { id: string }> = [];
  let scanned = 0;
  let next: string | null = null;
  page: for (;;) {
    const batch = await s.list<AiRow>({ prefix: 'u:', start, end, reverse: true, limit: 200 });
    for (const [id, r] of batch) {
      scanned += 1;
      end = id;
      if (keep(r)) rows.push({ ...r, id });
      if (rows.length >= limit || scanned >= SCAN_MAX) {
        next = id;
        break page;
      }
    }
    if (batch.size < 200) break;
  }
  const span = whole(o.span);
  const recent = span > 0 ? [...(await s.list<AiRow>({ prefix: 'u:', start: `u:${pad(now - span)}`, limit: USE_KEEP + USE_SLACK })).values()] : null;
  return {
    ok: true,
    rows,
    next,
    days: l.days || {},
    keys: l.keys.map((k) => ({ id: k.id, name: k.name, last4: k.last4, revoked: k.revoked || null })),
    ...(recent ? { recent } : {}),
  };
}

export class AiLedger {
  private state: StateLike;
  private clock: () => number;

  /** the runtime passes (state, env); a check passes its own clock as the third */
  constructor(state: StateLike, _env?: unknown, clock: () => number = Date.now) {
    this.state = state;
    this.clock = clock;
  }

  private async run(o: LedgerOp, now = this.clock()): Promise<LedgerReply> {
    let reply: LedgerReply = { ok: false };
    /* read, decide and write as one: no other movement on this account is delivered in between */
    await this.state.blockConcurrencyWhile(async () => {
      const s = this.state.storage;
      const l = (await s.get<LedgerRecord>('l')) || emptyLedger();
      if (o.op === 'usage') {
        reply = await usageOf(s, l, o, now);
        return;
      }
      reply = applyOp(l, o, now);
      /* the request's row, written with its charge; the oldest go in batches once past what is kept */
      const rows = [...(reply.row ? [reply.row as AiRow] : []), ...((reply.rows as AiRow[] | undefined) || [])];
      if (rows.length) {
        delete reply.row;
        delete reply.rows;
        for (const row of rows) await s.put(rowKey(row.t), row);
        const n = whole(l.rows);
        if (n > USE_KEEP + USE_SLACK || n % 500 === 0) await prune(s, l, now);
      }
      if (o.op !== 'state') await s.put('l', l);
      /* an outstanding hold always has an alarm to end it, no later than its own life */
      if (o.op === 'hold' && reply.ok) {
        const due = now + lifeOf(l.holds[String(reply.hold)]) + 5_000;
        const armed = await s.getAlarm();
        if (!armed || armed > due) await s.setAlarm(due);
      }
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
