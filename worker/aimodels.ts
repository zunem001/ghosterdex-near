/**
 * Every model Private AI offers, and where each request goes: NEAR AI's (worker/nearai.ts) and Cocoon's
 * (TON Console). One list for the chat (worker/privateai.ts) and the API (worker/aiapi.ts), so the two can
 * never offer, price or route a model differently.
 */
import { DEFAULT_PRICE, cleanPrice, type AiPrice } from './ailedger';
import { NEAR_DEFAULT, nearBase, nearModels, nearReady, type AiModel, type NearAiEnv } from './nearai';

export type { AiModel };

export interface AiModelsEnv extends NearAiEnv {
  /** the Cocoon gateway's OpenAI-compatible base, ending in /v1; unset = Cocoon not connected */
  PRIVATE_AI_BASE?: string;
  /** the Cocoon model asked; Qwen3 32B unless told */
  PRIVATE_AI_MODEL?: string;
  TONCONSOLE_COCOON_KEY?: string;
  /** Cocoon's price per million tokens until the owner sets one in the app */
  PRIVATE_AI_PRICE_IN?: string;
  PRIVATE_AI_PRICE_OUT?: string;
  /** the chat's model until a person picks one; NEAR AI's GLM 5.3 Flash unless told */
  PRIVATE_AI_DEFAULT?: string;
}

export const COCOON_MODEL = 'Qwen/Qwen3-32B';

let _price: { at: number; p: AiPrice } | null = null;
/** Cocoon's price per million tokens: the owner's (KV aiprice), else the vars, else the default. Kept 30 s per isolate. */
export async function aiPrice(env: Pick<AiModelsEnv, 'STATE' | 'PRIVATE_AI_PRICE_IN' | 'PRIVATE_AI_PRICE_OUT'>): Promise<AiPrice> {
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

/** Cocoon can be asked: its gateway's address and TON Console's key are both set. */
export function cocoonReady(env: Pick<AiModelsEnv, 'PRIVATE_AI_BASE' | 'TONCONSOLE_COCOON_KEY'>): boolean {
  return /^https?:\/\/\S+$/.test(String(env.PRIVATE_AI_BASE || '').trim()) && Boolean(env.TONCONSOLE_COCOON_KEY);
}

/** Some network can answer: NEAR AI's key is set, or Cocoon is connected. */
export function anyReady(env: Pick<AiModelsEnv, 'PRIVATE_AI_BASE' | 'TONCONSOLE_COCOON_KEY' | 'NEAR_AI_API_KEY'>): boolean {
  return nearReady(env) || cocoonReady(env);
}

const pretty = (id: string) => (id.split('/').pop() || id).replace(/^Qwen3-(\d+)B$/i, 'Qwen3 $1B');

/**
 * Every model, NEAR AI's then Cocoon's, each with the price a person pays and whether it can answer now.
 * NEAR AI's catalogue is not even read until its key is set: before that its models could not answer.
 */
export async function aiModels(env: AiModelsEnv, fetcher: typeof fetch = fetch): Promise<AiModel[]> {
  const [near, price] = await Promise.all([nearReady(env) ? nearModels(env, fetcher) : Promise.resolve([] as AiModel[]), aiPrice(env)]);
  const id = String(env.PRIVATE_AI_MODEL || '').trim() || COCOON_MODEL;
  const cocoon: AiModel = {
    id,
    name: pretty(id),
    net: 'cocoon',
    tier: 'tee',
    maker: 'Cocoon',
    inPerM: price.inPerM,
    outPerM: price.outPerM,
    ready: cocoonReady(env),
    tag: 'Balanced',
    params: [],
    reasons: false,
    think: null,
  };
  /* one id names one model: should NEAR AI ever list Cocoon's, Cocoon's own entry is the one kept */
  return [...near.filter((m) => m.id !== id), cocoon];
}

/** The model a request names, if it is offered and can answer now; null otherwise (never a guess). */
export function pickModel(models: AiModel[], asked: unknown): AiModel | null {
  const id = typeof asked === 'string' ? asked.trim() : '';
  return (id && models.find((m) => m.id === id && m.ready)) || null;
}

/** The chat's model until a person picks one: the owner's choice, else GLM 5.3 Flash, else any private one, else any. */
export function defaultModel(models: AiModel[], env: Pick<AiModelsEnv, 'PRIVATE_AI_DEFAULT'>): AiModel | null {
  const want = String(env.PRIVATE_AI_DEFAULT || '').trim();
  return (
    pickModel(models, want) ||
    pickModel(models, NEAR_DEFAULT) ||
    models.find((m) => m.ready && m.tier !== 'open') ||
    models.find((m) => m.ready) ||
    null
  );
}

/** Where a model is asked, with whose key; null when its network is not connected. */
export function routeFor(env: AiModelsEnv, m: AiModel): { base: string; key: string } | null {
  if (m.net === 'near') return nearReady(env) ? { base: nearBase(env), key: String(env.NEAR_AI_API_KEY).trim() } : null;
  return cocoonReady(env) ? { base: String(env.PRIVATE_AI_BASE).trim().replace(/\/+$/, ''), key: String(env.TONCONSOLE_COCOON_KEY) } : null;
}

/**
 * What a request cost, in whole micro-dollars, rounded up: cached input at its own price where the network gives
 * one. A price that is not a number makes the request cost more than any balance, so its hold is refused: the
 * ledger reads a value it cannot count as nothing, and a broken price must never read as free.
 */
export function chargeMicro(m: Pick<AiModel, 'inPerM' | 'outPerM' | 'cachePerM'>, tokensIn: number, tokensOut: number, cached = 0): number {
  const whole = (n: number) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
  const tin = whole(tokensIn);
  const c = Math.min(whole(cached), tin);
  const v = (tin - c) * m.inPerM + c * (m.cachePerM ?? m.inPerM) + whole(tokensOut) * m.outPerM;
  if (!Number.isFinite(v) || ![m.inPerM, m.outPerM, m.cachePerM ?? 0].every((p) => Number.isFinite(p) && p >= 0)) return Number.MAX_SAFE_INTEGER;
  return v > 0 ? Math.min(Math.ceil(v - 1e-9), Number.MAX_SAFE_INTEGER) : 0;
}

/**
 * Tells the owner, at most once an hour per network, that it refused a question for want of the house's own
 * credit there (NEAR AI answers 402 "insufficient_credits"): every person's question fails until it is topped
 * up, and the person only reads "unavailable". Without an alert (tests, or no Telegram) it does nothing.
 */
export async function noteUpstreamCredit(env: Pick<AiModelsEnv, 'STATE'>, m: Pick<AiModel, 'net'>, alert?: (text: string) => Promise<unknown>): Promise<void> {
  if (!alert) return;
  const key = `aicredit:alerted:${m.net}`;
  if (await env.STATE.get(key).catch(() => null)) return;
  await env.STATE.put(key, String(Date.now()), { expirationTtl: 3600 }).catch(() => {});
  const where = m.net === 'near' ? 'NEAR AI' : 'Cocoon';
  await alert(
    `⚠️ <b>Private AI: ${where} is out of credit</b>\n${where} refused a question for want of the house's credit there, so every question to its models fails until it is topped up${m.net === 'near' ? ' at cloud.near.ai' : ''}.`,
  ).catch(() => {});
}

/** What a person sees of a model: never its sampling settings. */
export function publicModel(m: AiModel) {
  return {
    id: m.id,
    name: m.name,
    net: m.net,
    tier: m.tier,
    maker: m.maker,
    inPerM: m.inPerM,
    outPerM: m.outPerM,
    ready: m.ready,
    ...(m.tag ? { tag: m.tag } : {}),
  };
}
