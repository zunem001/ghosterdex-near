/**
 * Private AI, in Explore's AI services (src/screens/PrivateAi.tsx): a chat
 * answered by Cocoon, Telegram's confidential inference network, through TON
 * Console (owner, 2026-10-14: "can we build an ai inference with cocoon on the
 * explore ai services section").
 *
 * Cocoon runs the model inside attested hardware and is paid in Toncoin; TON
 * Console sells access with an API key that holds the Cocoon capability
 * (TONCONSOLE_COCOON_KEY, a secret only the owner has seen). The gateway
 * speaks the OpenAI chat completions API, so this file is a small, careful
 * client of it:
 *
 *  - who may ask: PRIVATE_AI. 'owner' while the owner tries it, free; '1' for
 *    every verified account once paid credits exist; anything else is off,
 *    and the route answers 404 as if it were not here.
 *  - where: PRIVATE_AI_BASE, the gateway's OpenAI base (ending in /v1).
 *    Unset, the door still shows and every question is refused as not
 *    connected, so the address is set later without a release.
 *  - what is sent: the last few turns of this conversation, and nothing about
 *    the wallet: no balance, no address, no name. A turn carrying a recovery
 *    phrase or a key is refused here exactly as the phone refuses it
 *    (src/lib/secretGuard.ts, one module for both).
 *  - what is kept: nothing of the conversation. No prompt or answer is logged
 *    or stored; only counts of messages and tokens (the account's ledger, and
 *    aiuse:<uid>:<day> for the owner's free use), to price what an answer costs.
 *  - what it costs: the tokens used, from the account's prepaid credit
 *    (worker/ailedger.ts), the same credit its API keys spend (worker/aiapi.ts).
 *    The owner's use is free and still counted.
 *
 * The account's side of the API lives here too: its credit and price
 * (/api/ai/account), making and revoking keys (/api/ai/keys), and the owner's
 * price and grants (/api/ai/price, /api/ai/grant). Top-ups are paid like a
 * Trade Factory pass (index.ts /api/ai/credit/order).
 */
import { looksLikeSecret } from '../src/lib/secretGuard';
import { AI_LIMITS, newestTurns, type AiTurn } from '../src/lib/aiLimits';
import { MICRO, cleanPrice, costMicro, ledgerOf, type AiKey, type AiLedgerNs, type AiUse, type Ledger } from './ailedger';
import { API_PREFIX, aiPrice, forgetPrice, inputBound, newKey, tokenGuess } from './aiapi';

export { AI_LIMITS, type AiTurn };

export interface PrivateAiEnv {
  STATE: {
    get(key: string, type?: 'json'): Promise<any>;
    put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
    delete(key: string): Promise<void>;
  };
  /** each account's credit and keys (worker/ailedger.ts) */
  AI_DO?: AiLedgerNs;
  /** dollars per million tokens until the owner sets a price in the app */
  PRIVATE_AI_PRICE_IN?: string;
  PRIVATE_AI_PRICE_OUT?: string;
  /** 'owner' the owner alone, '1' every verified account, else off */
  PRIVATE_AI?: string;
  /** the gateway's OpenAI-compatible base, ending in /v1; unset = not connected */
  PRIVATE_AI_BASE?: string;
  /** the model asked; Qwen3 32B unless told */
  PRIVATE_AI_MODEL?: string;
  /** TON Console's key with the Cocoon capability (a secret) */
  TONCONSOLE_COCOON_KEY?: string;
}

export const AI_MODEL = 'Qwen/Qwen3-32B';

/** The largest body /api/ai/chat accepts: a full context (the phone sends no more, src/lib/aiLimits.ts) of
 *  three-byte characters, with room to spare. Every other route keeps index.ts's MAX_BODY_BYTES. */
export const AI_BODY_BYTES = 32_000;

/** How long the gateway may take: a 32B model's longest answer, from cold. */
const ASK_MS = 60_000;

export type AiRefusal = { error: string; code: string; status: number };

/** The words for each refusal. The phone shows its own translation by `code`; these are the fallback. */
const SAID: Record<string, [number, string]> = {
  signin: [401, 'Connect your wallet to use Private AI.'],
  not_connected: [503, 'Private AI is not connected yet.'],
  empty: [400, 'Write a message first.'],
  bad_turns: [400, 'This conversation could not be read. Start a new chat.'],
  too_long: [400, 'Keep a message under 2,000 characters.'],
  secret: [400, 'This looks like a recovery phrase or a private key. It was not sent.'],
  busy: [429, 'Private AI is busy. Try again in a moment.'],
  daily: [429, 'Daily limit reached. Try again tomorrow.'],
  slow: [504, 'No answer in time. Try again.'],
  unavailable: [502, 'Private AI is unavailable right now. Try again later.'],
  no_answer: [502, 'No answer came back. Try again.'],
  withheld: [502, 'The answer contained a recovery phrase or a key, so it was withheld.'],
  no_credit: [402, 'Add credit to keep chatting.'],
  billing: [503, 'Credit cannot be read right now. Try again in a moment.'],
  too_many_keys: [400, 'You have 10 keys. Revoke one to make another.'],
  no_key: [404, 'That key does not exist.'],
  owner_only: [403, 'Only the owner can do that.'],
  bad_price: [400, 'A price is more than $0 and at most $100 per million tokens.'],
  bad_grant: [400, 'A grant is up to $100, to a Telegram or wallet account.'],
};

export function refusal(code: keyof typeof SAID | string): AiRefusal {
  const [status, error] = SAID[code] || SAID.unavailable;
  return { error, code: SAID[code] ? code : 'unavailable', status };
}

export function privateAiOn(env: Pick<PrivateAiEnv, 'PRIVATE_AI'>, isOwner: boolean): boolean {
  return env.PRIVATE_AI === 'owner' ? isOwner : env.PRIVATE_AI === '1';
}

/** Whether a question can be put at all: the gateway's address and the key are both set. */
export function privateAiReady(env: Pick<PrivateAiEnv, 'PRIVATE_AI_BASE' | 'TONCONSOLE_COCOON_KEY'>): boolean {
  return /^https?:\/\/\S+$/.test(String(env.PRIVATE_AI_BASE || '').trim()) && Boolean(env.TONCONSOLE_COCOON_KEY);
}

/**
 * The conversation as it may be sent: well formed, ending in the question,
 * with no secret in anything the person wrote, trimmed to the newest turns
 * that fit. Earlier turns the person wrote are checked again too, so a
 * conversation edited on the device cannot carry a phrase through.
 */
export function cleanTurns(raw: unknown): { turns: AiTurn[] } | AiRefusal {
  if (!Array.isArray(raw) || raw.length > 200) return refusal('bad_turns');
  const all: AiTurn[] = [];
  for (const x of raw) {
    const role = (x as { role?: unknown })?.role;
    const content = (x as { content?: unknown })?.content;
    if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string') return refusal('bad_turns');
    all.push({ role, content: content.replace(/\u0000/g, '').trim() });
  }
  const last = all[all.length - 1];
  if (!last || last.role !== 'user' || !last.content) return refusal('empty');
  if (last.content.length > AI_LIMITS.message) return refusal('too_long');
  if (all.some((t) => t.role === 'user' && looksLikeSecret(t.content))) return refusal('secret');
  return { turns: newestTurns(all) };
}

/** Qwen3 thinks aloud between <think> tags unless told not to; even told, it leaves an empty pair. Neither is the answer. */
export function stripThinking(text: string): string {
  return String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^\s*<think>[\s\S]*$/i, '')
    .trim();
}

/* What the model is told before every conversation. Short, because it is paid for with every question. */
const SYSTEM = [
  'You are Private AI, the assistant inside GhosterDex, a self-custody wallet app.',
  'You run on Cocoon, a confidential network that processes each request inside secure hardware.',
  'Answer clearly and briefly in the language of the question. Write plain text: short paragraphs and simple lists, no tables and no headings.',
  "You cannot see the person's wallet, balances, addresses or history, and you cannot send, swap or sign anything; when asked, say so and point to the app.",
  'Never ask for, and never generate, a recovery phrase, a private key or a password. If someone offers one, tell them never to share it.',
  'Do not give personalised investment advice or promise returns; general explanations are fine.',
].join(' ');

export type AskResult = { reply: string; model: string; tokensIn: number; tokensOut: number; cut: boolean } | AiRefusal;

/** One question to the gateway. Never logs what was asked or answered: only how the gateway replied. */
export async function askModel(env: PrivateAiEnv, turns: AiTurn[], fetcher: typeof fetch = fetch): Promise<AskResult> {
  if (!privateAiReady(env)) return refusal('not_connected');
  const base = String(env.PRIVATE_AI_BASE).trim().replace(/\/+$/, '');
  const model = String(env.PRIVATE_AI_MODEL || '').trim() || AI_MODEL;
  const t0 = Date.now();
  let r: Response;
  try {
    r = await fetcher(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.TONCONSOLE_COCOON_KEY}`,
        'Content-Type': 'application/json',
        'User-Agent': 'GhosterDex Private AI',
      },
      body: JSON.stringify({
        model,
        /* /no_think is Qwen3's own switch for a direct answer, read from the system message */
        messages: [{ role: 'system', content: `${SYSTEM} /no_think` }, ...turns],
        max_tokens: AI_LIMITS.answer,
        temperature: 0.6,
        stream: false,
      }),
      signal: AbortSignal.timeout(ASK_MS),
    });
  } catch (e) {
    const slow = (e as { name?: string })?.name === 'TimeoutError' || (e as { name?: string })?.name === 'AbortError';
    console.log('[privateai] gateway', slow ? 'timeout' : 'unreachable', Date.now() - t0, 'ms');
    return refusal(slow ? 'slow' : 'unavailable');
  }
  if (!r.ok) {
    /* the status says whose problem it is: 401/403 the key, 402 the console's balance, 404 the address */
    console.log('[privateai] gateway', r.status, Date.now() - t0, 'ms');
    return refusal(r.status === 429 ? 'busy' : r.status === 404 ? 'not_connected' : 'unavailable');
  }
  const j = (await r.json().catch(() => null)) as {
    model?: unknown;
    choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }>;
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
  } | null;
  const choice = j?.choices?.[0];
  const reply = stripThinking(typeof choice?.message?.content === 'string' ? choice.message.content : '');
  console.log('[privateai] gateway 200', Date.now() - t0, 'ms', reply ? 'answered' : 'empty');
  if (!reply) return refusal('no_answer');
  if (looksLikeSecret(reply)) return refusal('withheld');
  const cut = choice?.finish_reason === 'length';
  /* the gateway's own count where it gives one; else a guess from what was sent and answered */
  const sent = Number(j?.usage?.prompt_tokens);
  const got = Number(j?.usage?.completion_tokens);
  return {
    reply: cut ? `${reply} …` : reply,
    model: typeof j?.model === 'string' && j.model ? j.model : model,
    tokensIn: Number.isFinite(sent) && sent > 0 ? sent : tokenGuess(SYSTEM + turns.map((t) => t.content).join('')),
    tokensOut: Number.isFinite(got) && got > 0 ? got : tokenGuess(String(choice?.message?.content || '')),
    cut,
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Pragma: 'no-cache' },
  });
}
const refuse = (x: AiRefusal) => json({ error: x.error, code: x.code }, x.status);

type DayUse = { n: number; in: number; out: number };

const usd = (micro: unknown) => Math.round(Number(micro || 0)) / MICRO;

export interface PrivateAiCtx {
  env: PrivateAiEnv;
  request: Request;
  path: string;
  uid: string;
  /** a Telegram account or a wallet that proved itself, never a client-chosen id */
  verified: boolean;
  isOwner: boolean;
  /** index.ts's Durable Object limiter: true when `key` has spent `budget` this minute */
  overLimit: (key: string, budget: number) => Promise<boolean>;
  fetcher?: typeof fetch;
  ledgerFor?: (uid: string) => Ledger | null;
  /** COCOON pays a top-up as itself at this discount, as it pays a pass (worker/scout.ts) */
  cocoon?: { master: string; off: number };
  now?: number;
}

const ROUTES = new Set(['/api/ai/chat', '/api/ai/account', '/api/ai/keys', '/api/ai/keys/revoke', '/api/ai/price', '/api/ai/grant']);

/**
 *   POST /api/ai/chat          { messages } -> { reply, model, cut, balance }
 *   GET  /api/ai/account       the credit, the price, the keys and what each spent
 *   POST /api/ai/keys          { name } -> the new key, shown this once
 *   POST /api/ai/keys/revoke   { id }
 *   POST /api/ai/price         the owner's price per million tokens
 *   POST /api/ai/grant         the owner adds credit to an account
 * Null for any other path.
 */
export async function handlePrivateAi(ctx: PrivateAiCtx): Promise<Response | null> {
  const { env, uid, path } = ctx;
  if (!ROUTES.has(path)) return null;
  const want = path === '/api/ai/account' ? 'GET' : 'POST';
  if (ctx.request.method !== want || !privateAiOn(env, ctx.isOwner)) return json({ error: 'Not found.' }, 404);
  if (!ctx.verified) return refuse(refusal('signin'));
  const ledgerFor = ctx.ledgerFor || ((u: string) => ledgerOf(env.AI_DO, u));
  const ledger = ledgerFor(uid);
  const now = ctx.now ?? Date.now();
  const body = want === 'POST' ? ((await ctx.request.json().catch(() => null)) as Record<string, unknown> | null) : null;

  if (path === '/api/ai/account') {
    if (!ledger) return refuse(refusal('billing'));
    const st = await ledger({ op: 'state' });
    if (!st.ok) return refuse(refusal('billing'));
    const use = (st.use || {}) as Record<string, AiUse>;
    const keys = ((st.keys || []) as AiKey[]).map((k) => ({
      id: k.id,
      name: k.name,
      last4: k.last4,
      created: k.created,
      revoked: k.revoked || null,
      requests: use[k.id]?.n || 0,
      spent: usd(use[k.id]?.micro),
      lastUsed: use[k.id]?.last || null,
    }));
    return json({
      free: ctx.isOwner,
      balance: usd(st.bal),
      held: usd(st.held),
      price: await aiPrice(env),
      /* the API is served over https only (plain http is redirected), whatever scheme reached this request */
      base: `https://${new URL(ctx.request.url).host}${API_PREFIX}`,
      model: String(env.PRIVATE_AI_MODEL || '').trim() || AI_MODEL,
      ready: privateAiReady(env),
      keys,
      chat: { requests: use.chat?.n || 0, spent: usd(use.chat?.micro) },
      topups: ((st.topups || []) as Array<{ at: number; micro: number; note: string }>).map((t) => ({ at: t.at, usd: usd(t.micro), note: t.note })),
      cocoon: ctx.cocoon || null,
    });
  }

  if (path === '/api/ai/keys') {
    if (!ledger) return refuse(refusal('billing'));
    if (await ctx.overLimit(`rl:aikeys:${uid}`, 10)) return refuse(refusal('busy'));
    const name = String(body?.name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40) || 'API key';
    const k = await newKey();
    /* the index first: a key the ledger then refuses is taken back out at once */
    await env.STATE.put(`aikey:${k.hash}`, JSON.stringify({ uid, id: k.id, owner: ctx.isOwner }));
    const r = await ledger({ op: 'addKey', key: { id: k.id, name, last4: k.last4, created: now, hash: k.hash } });
    if (!r.ok) {
      await env.STATE.delete(`aikey:${k.hash}`).catch(() => {});
      return refuse(refusal(r.why === 'too_many' ? 'too_many_keys' : 'billing'));
    }
    return json({ key: k.key, id: k.id, name, last4: k.last4, created: now });
  }

  if (path === '/api/ai/keys/revoke') {
    if (!ledger) return refuse(refusal('billing'));
    const id = String(body?.id || '');
    if (!/^k[0-9a-f]{12}$/.test(id)) return refuse(refusal('no_key'));
    const st = await ledger({ op: 'state' });
    const hash = ((st.keys || []) as AiKey[]).find((k) => k.id === id)?.hash;
    const r = await ledger({ op: 'revokeKey', id });
    if (!r.ok) return refuse(refusal(r.why === 'no_key' ? 'no_key' : 'billing'));
    /* the ledger stopped it already; the index goes too, so the key is not even looked up again */
    if (hash) await env.STATE.delete(`aikey:${hash}`).catch(() => {});
    return json({ ok: true });
  }

  if (path === '/api/ai/price') {
    if (!ctx.isOwner) return refuse(refusal('owner_only'));
    const p = cleanPrice(body);
    if (!p) return refuse(refusal('bad_price'));
    await env.STATE.put('aiprice', JSON.stringify(p));
    forgetPrice();
    return json({ price: p });
  }

  if (path === '/api/ai/grant') {
    if (!ctx.isOwner) return refuse(refusal('owner_only'));
    const to = String(body?.uid || '');
    const amount = Number(body?.usd);
    if (!/^(tg-\d{1,20}|ton--?\d{1,3}-[0-9a-f]{64})$/.test(to) || !(amount > 0 && amount <= 100)) return refuse(refusal('bad_grant'));
    const theirs = ledgerFor(to);
    if (!theirs) return refuse(refusal('billing'));
    const r = await theirs({ op: 'credit', ref: `grant:${crypto.randomUUID()}`, micro: Math.round(amount * MICRO), note: 'Owner grant' });
    if (!r.ok) return refuse(refusal('billing'));
    return json({ ok: true, balance: usd(r.bal) });
  }

  /* /api/ai/chat */
  if (!privateAiReady(env)) return refuse(refusal('not_connected'));
  const clean = cleanTurns(body?.messages);
  if ('error' in clean) return refuse(clean);
  if (await ctx.overLimit(`rl:ai:${uid}`, AI_LIMITS.perMinute)) return refuse(refusal('busy'));
  if (!ledger) return refuse(refusal('billing'));
  const free = ctx.isOwner;
  /* the owner's free use keeps its daily cap, the one bound on what it can cost the house */
  const day = new Date(now).toISOString().slice(0, 10);
  const useKey = `aiuse:${uid}:${day}`;
  const used = free ? ((await env.STATE.get(useKey, 'json').catch(() => null)) as DayUse | null) || { n: 0, in: 0, out: 0 } : null;
  if (used && used.n >= AI_LIMITS.perDay) return refuse(refusal('daily'));
  const price = await aiPrice(env);
  const hold = await ledger({ op: 'hold', micro: costMicro(price, inputBound([SYSTEM, ...clean.turns.map((t) => t.content)]), AI_LIMITS.answer), key: 'chat', free });
  if (!hold.ok) return refuse(refusal(hold.why === 'no_credit' ? 'no_credit' : 'billing'));
  const holdId = String(hold.hold);
  const got = await askModel(env, clean.turns, ctx.fetcher);
  if ('error' in got) {
    /* nothing answered, nothing charged: a refusal, an outage and a withheld answer cost the person nothing */
    await ledger({ op: 'release', hold: holdId });
    return refuse(got);
  }
  const settled = await ledger({ op: 'settle', hold: holdId, micro: costMicro(price, got.tokensIn, got.tokensOut), key: 'chat', tokensIn: got.tokensIn, tokensOut: got.tokensOut, free });
  if (used) await env.STATE.put(useKey, JSON.stringify({ n: used.n + 1, in: used.in + got.tokensIn, out: used.out + got.tokensOut }), { expirationTtl: 45 * 86400 }).catch(() => {});
  return json({ reply: got.reply, model: got.model, cut: got.cut, ...(settled.ok && !free ? { balance: usd(settled.bal) } : {}) });
}
