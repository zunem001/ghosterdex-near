/**
 * NEAR AI Cloud in Private AI, beside Cocoon (owner, 2026-10-20: "i want you to add near ai to the private ai
 * aswell", then, asked: every model, the non-private ones too and clearly labelled; at cost; open to everyone
 * once it answers).
 *
 * NEAR AI speaks OpenAI's chat completions at https://cloud-api.near.ai/v1, behind a key the owner holds as
 * the secret NEAR_AI_API_KEY. Its public catalogue (GET /v1/model/list) names every model with its price per
 * token and its privacy, and this file turns that into the models Private AI offers:
 *
 *  - 'tee'      NEAR AI's own secure hardware (TEE GPUs, attested): nobody, NEAR included, sees a prompt.
 *  - 'partner'  a partner's secure hardware that NEAR AI attests (its catalogue's "Attested 3P").
 *  - 'open'     a model NEAR AI forwards to its maker (OpenAI, Anthropic, Google, xAI and others) under its
 *               own account: the maker learns no one's identity, but the model runs outside secure hardware,
 *               so the app labels it Not private everywhere it can be chosen.
 *
 * Only chat models are offered: text in and text out, a context of 8k tokens or more, and a cap on the answer
 * the model honours (max_tokens in its own list), since the hold on a person's credit is bounded by it. Each
 * request then carries only the settings that model takes. Prices are NEAR AI's own, plus the owner's margin
 * (KV aimargin, 0 by the owner's word), with cached input at NEAR AI's cached price. The catalogue is read at
 * most hourly and kept, so an outage of the list never empties the menu.
 */

export const NEAR_AI_BASE = 'https://cloud-api.near.ai/v1';
export const NEAR_CATALOGUE_URL = 'https://cloud-api.near.ai/v1/model/list?limit=200';

export type AiTier = 'tee' | 'partner' | 'open';
export type AiNet = 'near' | 'cocoon';
/** how a chat asks a model to answer directly instead of thinking aloud first: a chat_template_kwargs switch, or
    'effort' for reasoning_effort low */
export type AiThink = 'enable_thinking' | 'thinking' | 'effort' | null;

export interface AiModel {
  /** what a request names */
  id: string;
  /** what a person reads */
  name: string;
  net: AiNet;
  tier: AiTier;
  /** who made it: the group a Not private model is listed under */
  maker: string;
  /** dollars per million tokens, at the price a person pays */
  inPerM: number;
  outPerM: number;
  /** cached input, where the network discounts it */
  cachePerM?: number;
  ready: boolean;
  /** what it is good at, in one word (private models only) */
  tag?: string;
  /** the sampling settings it takes; anything else is left out of a request */
  params: string[];
  /** it thinks before it answers, which counts as answer tokens */
  reasons: boolean;
  think: AiThink;
  /** it takes tools (function calling), as its network lists the feature: what an agent needs of a model */
  tools?: boolean;
  /** the most tokens it reads in one request, as its network says; absent when not known */
  context?: number;
}

/** The private models by name, in the order the menu lists them, with what each is good at. Others keep NEAR AI's own name. */
const KNOWN: Record<string, { name: string; tag: string }> = {
  'z-ai/glm-5.3-flash': { name: 'GLM 5.3 Flash', tag: 'Fast' },
  'Qwen/Qwen3.8-27B': { name: 'Qwen 3.8 27B', tag: 'Balanced' },
  'Qwen/Qwen3.6-35B-A3B-FP8': { name: 'Qwen 3.6 35B', tag: 'Reasoning' },
  /* served in NEAR AI's own hardware since late October (before, through a maker's network as deepseek/deepseek-v4.1-flash-1017) */
  'deepseek-ai/DeepSeek-V4.1-Flash-1017': { name: 'DeepSeek V4.1 Flash', tag: 'Reasoning' },
  'Qwen/Qwen3-VL-30B-A3B-Instruct': { name: 'Qwen3 VL 30B', tag: 'Fast' },
  'deepseek/deepseek-v3.2': { name: 'DeepSeek V3.2', tag: 'Strong' },
  'qwen/qwen3.5-397b-a17b': { name: 'Qwen 3.5 397B', tag: 'Strong' },
  'moonshotai/kimi-k2.6': { name: 'Kimi K2.6', tag: 'Strong' },
  'moonshotai/kimi-k3': { name: 'Kimi K3', tag: 'Strongest' },
};
const ORDER = Object.keys(KNOWN);

const MAKERS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  'x-ai': 'xAI',
  deepseek: 'DeepSeek',
  'deepseek-ai': 'DeepSeek',
  qwen: 'Qwen',
  'z-ai': 'Z.ai',
  'zai-org': 'Z.ai',
  moonshotai: 'Moonshot AI',
  'meta-llama': 'Meta',
  mistralai: 'Mistral',
};

/** what the chat is offered by default: NEAR AI's fast private model */
export const NEAR_DEFAULT = 'z-ai/glm-5.3-flash';

/** never a chat model, whatever the catalogue says of its modalities */
const NOT_CHAT = /whisper|rerank|embedding|privacy-filter|moderation|jev-|flux/i;
/** a model with its refusals taken out, by NEAR AI's own words for red teaming: never offered in a wallet's assistant
    (owner, 2026-10-30, on Qwen 3.8 27B Abliterated and DeepSeek V4.1 Flash Abliterated) */
const NO_REFUSALS = /abliterat|uncensored/i;

/**
 * Models NEAR AI lists with no sampling parameters at all, so none shows the reply cap Private AI bills by. Each was
 * measured instead (owner, 2026-10-30: "do all three"): asked for three paragraphs
 * under a 48-token cap, each stopped there (finish "length") and said what it used, whole and streamed; given room,
 * each answered clean, the thinking ones in a field of their own. They are offered with max_tokens alone, and
 * `reasons` gives a thinker its room to think. A list of their own, if NEAR AI ever adds one, is used instead.
 */
const MEASURED: Readonly<Record<string, { reasons: boolean }>> = {
  'deepseek-ai/DeepSeek-V4.1-Flash-1017': { reasons: true },
  'moonshotai/kimi-k3.1-pro': { reasons: true },
  'google/gemini-3.8-flash': { reasons: true },
  'anthropic/claude-opus-4-8': { reasons: false },
};

/** no chat model costs more than this per million tokens: a price past it is a broken entry, never a bill */
export const MAX_PER_M = 1000;

/** A price per token ({amount, scale}, in dollars) as dollars per million; NaN unless it is dollars, finite and sane. */
const perM = (c: unknown): number => {
  const amount = Number((c as { amount?: unknown })?.amount);
  const scale = Number((c as { scale?: unknown })?.scale);
  const currency = (c as { currency?: unknown })?.currency;
  if (!Number.isFinite(amount) || !Number.isFinite(scale) || amount < 0) return NaN;
  if (currency !== undefined && currency !== 'USD') return NaN;
  const v = (amount / 10 ** scale) * 1e6;
  return Number.isFinite(v) && v <= MAX_PER_M ? v : NaN;
};
const round4 = (v: number) => Math.round(v * 10_000) / 10_000;

/**
 * How a family is asked to answer directly, as measured on NEAR AI on 2026-10-20: Qwen by enable_thinking, Kimi
 * by thinking, and GLM by reasoning_effort low. GLM's own enable_thinking switch leaks its thought into the answer
 * (the reply opened "The user is asking..." and ran to a closing </think>), and minimal still thinks.
 */
function thinkOf(id: string, tier: AiTier): AiThink {
  if (tier === 'open') return null;
  if (/^moonshotai\//i.test(id)) return 'thinking';
  if (/^(z-ai|zai-org)\//i.test(id)) return 'effort';
  if (/^qwen\//i.test(id)) return 'enable_thinking';
  return null;
}

/**
 * NEAR AI's catalogue as Private AI's models, at the price a person pays: NEAR AI's own times (1 + margin).
 * Models that are not chat, or whose answer cannot be capped, are left out.
 */
export function parseCatalogue(raw: unknown, margin = 0): AiModel[] {
  const list = (raw as { models?: unknown })?.models;
  if (!Array.isArray(list)) return [];
  const k = 1 + (Number.isFinite(margin) && margin > 0 ? margin : 0);
  const out: AiModel[] = [];
  for (const m of list) {
    const id = typeof m?.modelId === 'string' ? m.modelId : '';
    const md = m?.metadata || {};
    if (!id || NOT_CHAT.test(id)) continue;
    if (NO_REFUSALS.test(id) || NO_REFUSALS.test(String(md.modelDisplayName || ''))) continue;
    const ins: unknown[] = md?.architecture?.inputModalities || [];
    const outs: unknown[] = md?.architecture?.outputModalities || [];
    if (!ins.includes('text') || outs.length !== 1 || outs[0] !== 'text') continue;
    if (!(Number(md.contextLength) >= 8192)) continue;
    const listed: string[] = Array.isArray(md.supportedSamplingParameters) ? md.supportedSamplingParameters.filter((x: unknown) => typeof x === 'string') : [];
    const measured = listed.length ? undefined : MEASURED[id];
    const params: string[] = measured ? ['max_tokens'] : listed;
    if (!params.includes('max_tokens')) continue;
    const cin = perM(m.inputCostPerToken);
    const cout = perM(m.outputCostPerToken);
    if (!(cin >= 0) || !(cout > 0)) continue;
    const tier: AiTier = md.verifiable === true ? (md.providerType === 'vllm' ? 'tee' : 'partner') : 'open';
    const prefix = id.split('/')[0].toLowerCase();
    const known = KNOWN[id];
    const cache = perM(m.cacheReadCostPerToken);
    const features: unknown[] = Array.isArray(md.supportedFeatures) ? md.supportedFeatures : [];
    const maker = MAKERS[prefix] || (typeof md.ownedBy === 'string' && md.ownedBy) || prefix;
    /* listed under its maker, so the maker's name is not said twice ("OpenAI GPT-5" reads "GPT-5") */
    const shown = (typeof md.modelDisplayName === 'string' && md.modelDisplayName.trim()) || id.split('/').pop() || id;
    out.push({
      id,
      name: known?.name || (shown.toLowerCase().startsWith(`${maker.toLowerCase()} `) ? shown.slice(maker.length + 1) : shown),
      net: 'near',
      tier,
      maker,
      inPerM: round4(cin * k),
      outPerM: round4(cout * k),
      ...(cache > 0 && cache < cin ? { cachePerM: round4(cache * k) } : {}),
      ready: true,
      ...(known ? { tag: known.tag } : {}),
      params,
      reasons: features.includes('reasoning') || /^moonshotai\/kimi-k2/i.test(id) || Boolean(measured?.reasons),
      think: thinkOf(id, tier),
      tools: features.includes('tools'),
      context: Math.floor(Number(md.contextLength)),
    });
  }
  /* the private ones first, in the menu's own order; then every other by maker and name */
  const rank = (x: AiModel) => (x.tier === 'open' ? 2 : 0) + (ORDER.includes(x.id) ? 0 : 1);
  return out.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (ORDER.indexOf(a.id) + 1 || 999) - (ORDER.indexOf(b.id) + 1 || 999) ||
      a.maker.localeCompare(b.maker) ||
      a.name.localeCompare(b.name),
  );
}

export interface NearAiEnv {
  STATE: {
    get(key: string, type?: 'json'): Promise<any>;
    put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  };
  NEAR_AI_API_KEY?: string;
  /** the gateway, ending in /v1; NEAR AI's own unless told */
  NEAR_AI_BASE?: string;
}

export function nearReady(env: Pick<NearAiEnv, 'NEAR_AI_API_KEY'>): boolean {
  return Boolean(String(env.NEAR_AI_API_KEY || '').trim());
}

/** Where NEAR AI is asked, with the key: an https address on near.ai's own domain, or NEAR AI's gateway. */
export function nearBase(env: Pick<NearAiEnv, 'NEAR_AI_BASE'>): string {
  const b = String(env.NEAR_AI_BASE || '').trim().replace(/\/+$/, '');
  try {
    const u = new URL(b);
    if (u.protocol === 'https:' && !u.username && !u.password && (u.hostname === 'near.ai' || u.hostname.endsWith('.near.ai'))) return b;
  } catch {
    /* not an address: NEAR AI's own */
  }
  return NEAR_AI_BASE;
}

/** The owner's margin over NEAR AI's price, as a fraction: 0 (at cost) unless set, never above 2 (+200%). */
export async function nearMargin(env: Pick<NearAiEnv, 'STATE'>): Promise<number> {
  const v = Number((await env.STATE.get('aimargin', 'json').catch(() => null))?.margin);
  return Number.isFinite(v) && v >= 0 && v <= 2 ? v : 0;
}

export const CATALOGUE_KEY = 'nearai:catalogue';
const CATALOGUE_TTL_MS = 60 * 60_000;
/** a copy older than this is not used, even when the list cannot be read: its prices may no longer be NEAR AI's */
export const CATALOGUE_STALE_MS = 3 * 24 * 60 * 60_000;
/** what this isolate holds: the list (or that there was none) until `until`, and when NEAR AI gave that list */
let _cat: { until: number; raw: unknown; read: number } | null = null;
let _reading: Promise<unknown> | null = null;

/**
 * NEAR AI's catalogue as last read: hourly at most, kept in KV for every isolate. When the list cannot be read,
 * a copy up to three days old is used, so a passing outage never empties the menu and a long one never bills
 * at old prices. One read at a time per isolate, and a failed one is not tried again for a minute.
 */
export async function nearCatalogue(env: NearAiEnv, fetcher: typeof fetch = fetch, now = Date.now()): Promise<unknown> {
  if (_cat && now < _cat.until) return _cat.raw && now - _cat.read < CATALOGUE_STALE_MS ? _cat.raw : null;
  if (_reading) return _reading;
  _reading = readCatalogue(env, fetcher, now).finally(() => {
    _reading = null;
  });
  return _reading;
}

async function readCatalogue(env: NearAiEnv, fetcher: typeof fetch, now: number): Promise<unknown> {
  const hold = (raw: unknown, read: number, ms = 5 * 60_000) => {
    _cat = { until: now + ms, raw, read };
    return raw;
  };
  const kept = (await env.STATE.get(CATALOGUE_KEY, 'json').catch(() => null)) as { at?: number; raw?: unknown } | null;
  const keptAt = Number(kept?.at || 0);
  if (kept?.raw && now - keptAt < CATALOGUE_TTL_MS) return hold(kept.raw, keptAt);
  try {
    const r = await fetcher(NEAR_CATALOGUE_URL, { headers: { 'User-Agent': 'GhosterDex Private AI', Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const raw = await r.json();
      if (Array.isArray((raw as { models?: unknown })?.models) && (raw as { models: unknown[] }).models.length) {
        await env.STATE.put(CATALOGUE_KEY, JSON.stringify({ at: now, raw })).catch(() => {});
        return hold(raw, now);
      }
    }
    console.log('[nearai] catalogue', r.status);
  } catch (e) {
    console.log('[nearai] catalogue unreachable', String((e as { name?: string })?.name || e));
  }
  if (kept?.raw && now - keptAt < CATALOGUE_STALE_MS) return hold(kept.raw, keptAt);
  if (kept?.raw) console.log('[nearai] catalogue copy too old to use', Math.round((now - keptAt) / 3_600_000), 'h');
  return hold(null, 0, 60_000);
}
export function forgetCatalogue() {
  _cat = null;
  _reading = null;
}

/** NEAR AI's models at the price a person pays, each ready only when the key is set. */
export async function nearModels(env: NearAiEnv, fetcher: typeof fetch = fetch): Promise<AiModel[]> {
  const [raw, margin] = await Promise.all([nearCatalogue(env, fetcher), nearMargin(env)]);
  const ready = nearReady(env);
  return parseCatalogue(raw, margin).map((m) => ({ ...m, ready }));
}

/**
 * The request body for one model: only the settings it takes, and, for the chat, a direct answer from a
 * model that would otherwise think aloud first (its thinking is answer tokens the person pays for).
 */
export function shapeFor(model: AiModel, base: Record<string, unknown>, opts: { direct?: boolean } = {}): Record<string, unknown> {
  const body: Record<string, unknown> = { model: model.id, messages: base.messages };
  for (const [k, v] of Object.entries(base)) {
    if (k === 'model' || k === 'messages' || v === undefined) continue;
    if (k === 'stream' || k === 'stream_options' || k === 'response_format' || k === 'reasoning_effort' || k === 'chat_template_kwargs') {
      body[k] = v;
      continue;
    }
    /* an agent's tools go only to a model that takes them (the API refuses them for any other before this) */
    if (k === 'tools' || k === 'tool_choice' || k === 'parallel_tool_calls') {
      if (model.tools === true) body[k] = v;
      continue;
    }
    /* a sampling setting goes only to a model that lists it (NEAR AI's catalogue); a Cocoon model takes them all */
    if (model.net === 'cocoon' || model.params.includes(k)) body[k] = v;
  }
  /* the caller's own word on thinking, either way, is never overridden */
  if (opts.direct && model.think && body.chat_template_kwargs === undefined && body.reasoning_effort === undefined) {
    if (model.think === 'effort') body.reasoning_effort = 'low';
    else body.chat_template_kwargs = { [model.think]: false };
  }
  return body;
}
