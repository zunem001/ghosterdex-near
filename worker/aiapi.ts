/**
 * Private AI's API: keys a person makes in Explore's AI services, used from
 * any tool that speaks OpenAI's chat completions, answered by Cocoon and paid
 * by the tokens used from the account's prepaid credit (owner, 2026-10-14:
 * "i would have preferred users been able to get cocoon api key", then "by
 * tokens used").
 *
 *   base     https://ghosterdex.com/api/ai/v1
 *   GET      /models
 *   POST     /chat/completions   (stream or not)
 *   auth     Authorization: Bearer gdxai_...
 *
 * A key is shown once and kept only as its SHA-256: aikey:<hash> in KV names
 * the account, and the account's ledger (worker/ailedger.ts) says whether the
 * key still works, so a revoked key stops at once. Every request holds the
 * most it can cost before it is sent (each token is at least one byte of what
 * was sent, and the answer is capped), and settles to the tokens the gateway
 * counted. Nothing of a request or an answer is logged or stored.
 *
 * Answered above index.ts's identity work: a key is its own identity, so
 * there is no Telegram or wallet session to resolve, and its limits are its
 * own (per key, and per address for keys that do not exist).
 */
import { costMicro, DEFAULT_PRICE, cleanPrice, ledgerOf, type AiLedgerNs, type AiPrice, type Ledger } from './ailedger';

export interface AiApiEnv {
  STATE: {
    get(key: string, type?: 'json'): Promise<any>;
    put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
    delete(key: string): Promise<void>;
  };
  AI_DO?: AiLedgerNs;
  PRIVATE_AI?: string;
  PRIVATE_AI_BASE?: string;
  PRIVATE_AI_MODEL?: string;
  PRIVATE_AI_PRICE_IN?: string;
  PRIVATE_AI_PRICE_OUT?: string;
  TONCONSOLE_COCOON_KEY?: string;
}

export const API_PREFIX = '/api/ai/v1';
export const API_MODEL = 'Qwen/Qwen3-32B';
/** the largest request body: a full 32k-token context with room to spare */
export const API_BODY_BYTES = 192_000;
export const API_LIMITS = {
  /** answer tokens when the request names none, and the most it may name */
  answerDefault: 1024,
  answerMax: 4096,
  messages: 256,
  /** requests a minute: per key, and per address while it shows keys that do not exist */
  perKey: 120,
  perAddressMisses: 30,
};

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
};

function oaiError(status: number, message: string, code: string, type = 'invalid_request_error'): Response {
  return new Response(JSON.stringify({ error: { message, type, param: null, code } }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS },
  });
}

/* ------------------------------------------------------------ keys */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function b64url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : '') + (i + 2 < bytes.length ? B64[n & 63] : '');
  }
  return s;
}
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

export const KEY_RE = /^gdxai_[A-Za-z0-9_-]{40}$/;

export async function sha256hex(s: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))));
}

/** A new key: 30 random bytes, its public id, and the hash KV keeps in its place. */
export async function newKey(): Promise<{ key: string; id: string; hash: string; last4: string }> {
  const key = `gdxai_${b64url(crypto.getRandomValues(new Uint8Array(30)))}`;
  return { key, id: `k${hex(crypto.getRandomValues(new Uint8Array(6)))}`, hash: await sha256hex(key), last4: key.slice(-4) };
}

export type KeyIndex = { uid: string; id: string; owner?: boolean };

/* ------------------------------------------------------------ price */

let _price: { at: number; p: AiPrice } | null = null;
/** The price per million tokens: the owner's (KV aiprice), else the vars, else the default. Kept 30 s per isolate. */
export async function aiPrice(env: AiApiEnv): Promise<AiPrice> {
  if (_price && Date.now() - _price.at < 30_000) return _price.p;
  const kv = cleanPrice(await env.STATE.get('aiprice', 'json').catch(() => null));
  const vars = cleanPrice({ inPerM: env.PRIVATE_AI_PRICE_IN, outPerM: env.PRIVATE_AI_PRICE_OUT });
  const p = kv || vars || DEFAULT_PRICE;
  _price = { at: Date.now(), p };
  return p;
}
export function forgetPrice() {
  _price = null;
}

/* ------------------------------------------------------------ requests */

const utf8 = new TextEncoder();
/** At most this many tokens: a token is at least one byte of what was sent, plus each message's markers. */
export function inputBound(texts: string[]): number {
  return texts.reduce((n, s) => n + utf8.encode(s).length + 8, 0) + 64;
}
/** A guess where the gateway counts nothing: about four bytes a token. */
export function tokenGuess(s: string): number {
  return Math.ceil(utf8.encode(s).length / 4);
}

type Clean = { up: Record<string, unknown>; texts: string[]; maxTokens: number; stream: boolean; wantUsage: boolean };

/** The request as it may be sent on: OpenAI's chat completions shape, text only, each knob held to its range. */
export function cleanRequest(b: any, model: string): Clean | { status: number; message: string; code: string } {
  const bad = (message: string, code = 'invalid_request') => ({ status: 400, message, code });
  if (!b || typeof b !== 'object') return bad('The request body must be JSON.');
  if (!Array.isArray(b.messages) || !b.messages.length) return bad('messages must be a non-empty array.');
  if (b.messages.length > API_LIMITS.messages) return bad(`At most ${API_LIMITS.messages} messages.`);
  if (b.n != null && Number(b.n) !== 1) return bad('n must be 1.');
  if (b.tools != null || b.functions != null || b.tool_choice != null) return bad('Tools are not supported yet.', 'unsupported');
  const messages: Array<{ role: string; content: string }> = [];
  for (const m of b.messages) {
    const role = m?.role;
    if (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'developer') return bad('Each message needs a role of system, user or assistant.');
    let content = m?.content;
    if (Array.isArray(content)) {
      if (content.some((p: any) => p?.type !== 'text' || typeof p?.text !== 'string')) return bad('Only text content is supported.', 'unsupported');
      content = content.map((p: any) => p.text).join('');
    }
    if (typeof content !== 'string') return bad('Each message needs text content.');
    messages.push({ role: role === 'developer' ? 'system' : role, content });
  }
  const asked = b.max_completion_tokens ?? b.max_tokens;
  let maxTokens = API_LIMITS.answerDefault;
  if (asked != null) {
    const n = Math.floor(Number(asked));
    if (!(n >= 1)) return bad('max_tokens must be a positive whole number.');
    maxTokens = Math.min(n, API_LIMITS.answerMax);
  }
  const up: Record<string, unknown> = { model, messages, max_tokens: maxTokens };
  const range = (k: string, lo: number, hi: number) => {
    if (b[k] == null) return true;
    const v = Number(b[k]);
    if (!(v >= lo && v <= hi)) return false;
    up[k] = v;
    return true;
  };
  if (!range('temperature', 0, 2) || !range('top_p', 0, 1) || !range('presence_penalty', -2, 2) || !range('frequency_penalty', -2, 2)) {
    return bad('A sampling setting is out of range.');
  }
  if (b.seed != null) {
    if (!Number.isInteger(Number(b.seed))) return bad('seed must be a whole number.');
    up.seed = Number(b.seed);
  }
  if (b.stop != null) {
    const stop = typeof b.stop === 'string' ? [b.stop] : b.stop;
    if (!Array.isArray(stop) || stop.length > 4 || stop.some((s: unknown) => typeof s !== 'string' || !s)) return bad('stop is a string or up to four strings.');
    up.stop = stop;
  }
  if (b.response_format != null) {
    const t = b.response_format?.type;
    if (t !== 'text' && t !== 'json_object') return bad('response_format may be text or json_object.', 'unsupported');
    up.response_format = { type: t };
  }
  const stream = b.stream === true;
  return { up, texts: messages.map((m) => m.content), maxTokens, stream, wantUsage: stream && b.stream_options?.include_usage === true };
}

/* ------------------------------------------------------------ the meter for a stream */

type Usage = { prompt_tokens?: number; completion_tokens?: number };

/**
 * Passes an event stream through as it arrives and reads the usage the gateway
 * reports at its end (asked for with include_usage). The usage event itself
 * reaches the caller only if the caller asked for it too. Settles once: at the
 * end, or with what was seen when the caller hangs up.
 */
export function meteredStream(
  upstream: ReadableStream<Uint8Array>,
  opts: { wantUsage: boolean; onEnd: (u: { tokensIn: number | null; tokensOut: number; seenChars: number; complete: boolean }) => Promise<void>; waitUntil?: (p: Promise<unknown>) => void },
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let buf = '';
  let usage: Usage | null = null;
  let seen = '';
  let ended = false;
  const finish = (complete: boolean) => {
    if (ended) return Promise.resolve();
    ended = true;
    const tokensOut = Number(usage?.completion_tokens);
    const tokensIn = Number(usage?.prompt_tokens);
    return opts
      .onEnd({ tokensIn: Number.isFinite(tokensIn) && tokensIn >= 0 ? tokensIn : null, tokensOut: Number.isFinite(tokensOut) && tokensOut >= 0 ? tokensOut : tokenGuess(seen), seenChars: seen.length, complete })
      .catch(() => {});
  };
  /* one line of the stream: kept, or dropped when it is the usage event nobody asked to see */
  const line = (raw: string): string | null => {
    const t = raw.trim();
    if (!t.startsWith('data:')) return raw;
    const data = t.slice(5).trim();
    if (!data || data === '[DONE]') return raw;
    try {
      const j = JSON.parse(data);
      if (j?.usage && typeof j.usage === 'object') usage = j.usage;
      const d = j?.choices?.[0]?.delta;
      if (typeof d?.content === 'string') seen += d.content;
      if (typeof d?.reasoning_content === 'string') seen += d.reasoning_content;
      if (!opts.wantUsage && j?.usage && (!Array.isArray(j.choices) || j.choices.length === 0)) return null;
    } catch {
      /* not ours to judge: passed on as it came */
    }
    return raw;
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (done) {
        if (buf) {
          const kept = line(buf);
          if (kept != null) controller.enqueue(enc.encode(kept));
          buf = '';
        }
        await finish(true);
        controller.close();
        return;
      }
      buf += dec.decode(value, { stream: true });
      let out = '';
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const raw = buf.slice(0, i + 1);
        buf = buf.slice(i + 1);
        const kept = line(raw.replace(/\n$/, ''));
        if (kept != null) out += `${kept}\n`;
      }
      if (out) controller.enqueue(enc.encode(out));
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => {});
      const p = finish(false);
      if (opts.waitUntil) opts.waitUntil(p);
      else await p;
    },
  });
}

/* ------------------------------------------------------------ the route */

async function readBody(req: Request, max: number): Promise<string | null> {
  const declared = Number(req.headers.get('content-length') || '0');
  if (declared > max) return null;
  const reader = req.body?.getReader();
  if (!reader) return '';
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.byteLength;
  }
  return new TextDecoder().decode(all);
}

export interface AiApiCtx {
  env: AiApiEnv;
  request: Request;
  path: string;
  ip: string;
  overLimit: (key: string, budget: number) => Promise<boolean>;
  waitUntil?: (p: Promise<unknown>) => void;
  fetcher?: typeof fetch;
  ledgerFor?: (uid: string) => Ledger | null;
}

/** Everything under /api/ai/v1, or null for any other path. */
export async function handleAiApi(ctx: AiApiCtx): Promise<Response | null> {
  const { env, request, path } = ctx;
  if (path !== API_PREFIX && !path.startsWith(`${API_PREFIX}/`)) return null;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (env.PRIVATE_AI !== '1' && env.PRIVATE_AI !== 'owner') return oaiError(404, 'Not found.', 'not_found');
  const sub = path.slice(API_PREFIX.length);

  const auth = request.headers.get('authorization') || '';
  const key = /^Bearer\s+(\S+)$/i.exec(auth)?.[1] || '';
  if (!key) return oaiError(401, 'Send your API key as Authorization: Bearer gdxai_...', 'invalid_api_key');
  if (!KEY_RE.test(key)) {
    if (await ctx.overLimit(`rl:aimiss:${ctx.ip}`, API_LIMITS.perAddressMisses)) return oaiError(429, 'Too many requests.', 'rate_limit_exceeded', 'rate_limit_error');
    return oaiError(401, 'That API key is not valid.', 'invalid_api_key');
  }
  const idx = (await env.STATE.get(`aikey:${await sha256hex(key)}`, 'json').catch(() => null)) as KeyIndex | null;
  if (!idx?.uid || !idx?.id) {
    if (await ctx.overLimit(`rl:aimiss:${ctx.ip}`, API_LIMITS.perAddressMisses)) return oaiError(429, 'Too many requests.', 'rate_limit_exceeded', 'rate_limit_error');
    return oaiError(401, 'That API key is not valid, or was revoked.', 'invalid_api_key');
  }
  if (env.PRIVATE_AI === 'owner' && !idx.owner) return oaiError(403, 'Private AI is not open to this account yet.', 'not_available', 'permission_error');
  if (await ctx.overLimit(`rl:aikey:${idx.id}`, API_LIMITS.perKey)) return oaiError(429, 'Too many requests for this key. Slow down.', 'rate_limit_exceeded', 'rate_limit_error');

  const model = String(env.PRIVATE_AI_MODEL || '').trim() || API_MODEL;
  if (sub === '/models' && request.method === 'GET') {
    return new Response(JSON.stringify({ object: 'list', data: [{ id: model, object: 'model', created: 1764460800, owned_by: 'cocoon' }] }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS },
    });
  }
  if (sub !== '/chat/completions' || request.method !== 'POST') return oaiError(404, 'Not found. The API offers GET /models and POST /chat/completions.', 'not_found');

  const base = String(env.PRIVATE_AI_BASE || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/\S+$/.test(base) || !env.TONCONSOLE_COCOON_KEY) return oaiError(503, 'The model is not connected yet. Try again later.', 'not_connected', 'server_error');

  const text = await readBody(request, API_BODY_BYTES);
  if (text === null) return oaiError(413, `The request is over ${API_BODY_BYTES} bytes.`, 'request_too_large');
  let b: unknown = null;
  try {
    b = JSON.parse(text);
  } catch {
    return oaiError(400, 'The request body must be JSON.', 'invalid_json');
  }
  const asked = typeof (b as any)?.model === 'string' ? (b as any).model : '';
  if (asked && asked !== model && asked !== 'default') return oaiError(404, `The model ${asked.slice(0, 80)} does not exist. Use ${model}.`, 'model_not_found');
  const clean = cleanRequest(b, model);
  if ('status' in clean) return oaiError(clean.status, clean.message, clean.code);

  const ledger = (ctx.ledgerFor || ((uid: string) => ledgerOf(env.AI_DO, uid)))(idx.uid);
  if (!ledger) return oaiError(503, 'Billing is not available right now.', 'unavailable', 'server_error');
  /* the owner's keys are free (marked when the owner made them), and still counted */
  const free = idx.owner === true;
  const price = await aiPrice(env);
  const inMax = inputBound(clean.texts);
  const hold = await ledger({ op: 'hold', micro: costMicro(price, inMax, clean.maxTokens), key: idx.id, free });
  if (!hold.ok) {
    if (hold.why === 'key_off') return oaiError(401, 'That API key was revoked.', 'invalid_api_key');
    if (hold.why === 'no_credit') return oaiError(429, 'Not enough credit for this request. Add credit in GhosterDex: Explore, AI services, Private AI.', 'insufficient_quota', 'insufficient_quota');
    return oaiError(503, 'Billing is not available right now.', 'unavailable', 'server_error');
  }
  const holdId = String(hold.hold);
  const settle = (tokensIn: number, tokensOut: number) =>
    ledger({ op: 'settle', hold: holdId, micro: costMicro(price, tokensIn, tokensOut), key: idx.id, tokensIn, tokensOut, free }).then(() => undefined);
  const release = () => ledger({ op: 'release', hold: holdId }).then(() => undefined);

  const upBody = clean.stream ? { ...clean.up, stream: true, stream_options: { include_usage: true } } : { ...clean.up, stream: false };
  const t0 = Date.now();
  let r: Response;
  try {
    r = await (ctx.fetcher || fetch)(`${base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.TONCONSOLE_COCOON_KEY}`, 'Content-Type': 'application/json', 'User-Agent': 'GhosterDex AI API' },
      body: JSON.stringify(upBody),
      signal: clean.stream ? undefined : AbortSignal.timeout(300_000),
    });
  } catch (e) {
    await release();
    const slow = (e as { name?: string })?.name === 'TimeoutError';
    console.log('[aiapi] gateway', slow ? 'timeout' : 'unreachable', Date.now() - t0, 'ms');
    return oaiError(slow ? 504 : 502, slow ? 'The model took too long to answer.' : 'The model could not be reached.', slow ? 'timeout' : 'upstream_error', 'server_error');
  }
  if (!r.ok || !r.body) {
    await release();
    console.log('[aiapi] gateway', r.status, Date.now() - t0, 'ms');
    if (r.status === 429) return oaiError(429, 'The model is busy. Try again shortly.', 'rate_limit_exceeded', 'rate_limit_error');
    if (r.status === 400) return oaiError(400, 'The model refused this request.', 'invalid_request');
    return oaiError(r.status === 404 ? 503 : 502, 'The model is unavailable right now. Try again later.', 'upstream_error', 'server_error');
  }

  if (clean.stream) {
    const inGuess = Math.ceil(inMax / 4);
    const body = meteredStream(r.body, {
      wantUsage: clean.wantUsage,
      waitUntil: ctx.waitUntil,
      onEnd: async (u) => {
        console.log('[aiapi] stream', u.complete ? 'ended' : 'hung up', Date.now() - t0, 'ms', u.tokensIn ?? `~${inGuess}`, '/', u.tokensOut, 'tokens');
        await settle(u.tokensIn ?? inGuess, u.tokensOut);
      },
    });
    return new Response(body, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', ...CORS } });
  }

  const j = (await r.json().catch(() => null)) as any;
  if (!j || !Array.isArray(j.choices)) {
    await release();
    return oaiError(502, 'The model answered in a form this API cannot read.', 'upstream_error', 'server_error');
  }
  const answer = j.choices.map((c: any) => String(c?.message?.content || '')).join('');
  const tokensIn = Number.isFinite(Number(j?.usage?.prompt_tokens)) ? Number(j.usage.prompt_tokens) : Math.ceil(inMax / 4);
  const tokensOut = Number.isFinite(Number(j?.usage?.completion_tokens)) ? Number(j.usage.completion_tokens) : tokenGuess(answer);
  await settle(tokensIn, tokensOut);
  console.log('[aiapi] answered', Date.now() - t0, 'ms', tokensIn, '/', tokensOut, 'tokens');
  return new Response(JSON.stringify(j), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS } });
}
