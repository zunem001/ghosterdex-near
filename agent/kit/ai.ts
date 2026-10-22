/**
 * Private AI, for the agent itself (owner, 2026-10-21: "i hope the ai agents
 * using the agentic wallets can also use the new private ai and also api,
 * which means they can also fund themselves with the api from ghosterdex").
 *
 * GhosterDex's models, NEAR AI's and Cocoon's, asked from the kit, or from
 * anything that speaks OpenAI's chat completions with an API key this account
 * makes, and paid by the tokens used from credit this account buys with its
 * own money. Credit is a purchase like Stars or a gift: the owner's Purchases
 * switch, daily limit and approval size apply, checked by GhosterDex when the
 * order is placed and again as it is paid.
 *
 * A top-up is paid the two ways the app pays one:
 *  - from the vault, any coin: a private route into GhosterDex's account,
 *    landing as Tether, bound to its order before this key signs it, so a
 *    route the order would not take is never signed;
 *  - from the Gram wallet: Gram to GhosterDex's own wallet on chain with the
 *    order's memo, no bridge, or COCOON as itself at its discount. Where it
 *    goes and how much come from the order GhosterDex keeps (its gate), never
 *    from anything else.
 * GhosterDex adds the credit once the payment lands, even after this kit has
 * stopped watching.
 */
import { Address, beginCell, type Cell } from '@ton/core';
import { aiTopupOk, AI_CREDIT_MAX, AI_CREDIT_MIN } from '../../src/lib/aiLimits';
import { fromRaw } from './amounts';
import { ApiError } from './client';
import { KitError, normSymbol, type Balance, type Kit } from './kit';

export type AiModel = { id: string; name: string; net: string; tier: string; maker: string; inPerM: number; outPerM: number; ready: boolean; tag?: string; tools?: boolean; context?: number };

type AiKeyRow = { id: string; name: string; last4: string; created: number; revoked: number | null; requests: number; spent: number; lastUsed: number | null };

export type AiAccount = {
  free: boolean;
  balance: number;
  held: number;
  base: string;
  model: string;
  models: AiModel[];
  ready: boolean;
  keys: AiKeyRow[];
  chat: { requests: number; spent: number };
  topups: Array<{ at: number; usd: number; note: string }>;
  cocoon: { master: string; off: number } | null;
};

type CreditOrder = {
  ok?: boolean;
  orderId?: string;
  rail?: 'chain';
  assetId?: string;
  destAssetId?: string;
  amountRaw?: string;
  paySymbol?: string;
  payTo?: string;
  memo?: string;
  routeId?: string;
  coin?: 'jetton';
};

/** How the vault's route can cost over the credit: the worker sizes Tether out at half a percent over, then 1% more, and a price can move. */
export const VAULT_OVER = 1.03;
/** Gram held back for the network's fee on a Gram payment, and attached to a COCOON transfer (what the transfer does not burn comes back). */
const GRAM_FEE_NANO = 20_000_000n;
const JETTON_GAS_NANO = 50_000_000n;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Credit to the micro-dollar, as the ledger keeps it: a question costs a fraction of a cent, which cents would show as nothing. */
const exact = (n: unknown) => Math.round((Number(n) || 0) * 1e6) / 1e6;
const enc = encodeURIComponent;
const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null);

/** Only a model in secure hardware is private; a maker's own model, reached through NEAR AI, is not. */
export const isPrivate = (m: Pick<AiModel, 'tier'>) => m.tier !== 'open';

/** Where a model runs, said plainly. */
export function whereItRuns(m: Pick<AiModel, 'net' | 'tier' | 'maker'>): string {
  if (m.net === 'cocoon') return 'Cocoon, inside secure hardware';
  if (m.tier === 'tee') return 'NEAR AI, inside secure hardware';
  if (m.tier === 'partner') return "a partner's secure hardware, which NEAR AI checks";
  return `${m.maker}'s own servers, through NEAR AI: not private`;
}

/** Private AI's refusals, with what the agent can do about each. */
export function aiExplain(k: Kit, e: unknown): Error {
  if (e instanceof ApiError) {
    const code = String(e.body?.code || '');
    if (e.status === 404 && !code) return new KitError('Private AI is not open to this account yet.', { code: 'ai_closed' });
    const hints: Record<string, string> = {
      no_credit: `Add credit with ai_add_credit (from $${AI_CREDIT_MIN}), paid from your vault or your Gram wallet.`,
      busy: 'Wait a moment, then ask again.',
      not_connected: 'Try again later.',
      unavailable: 'Try again later, or pick another model (ai_models).',
      slow: 'Try again, or pick a faster model (ai_models).',
      too_long: 'Shorten it, or use the models through an API key (ai_new_key) for longer work.',
      secret: 'Never send a recovery phrase or a key to anyone, a model included.',
      too_many_keys: 'Revoke one with ai_revoke_key, then make another.',
      bad_amount: `Add from $${AI_CREDIT_MIN} to $${AI_CREDIT_MAX.toLocaleString('en-US')}, in whole cents.`,
    };
    if (hints[code]) return new KitError(e.message, { code, hint: hints[code] });
  }
  return k.explain(e);
}

/* The model list barely changes: one read serves a long-lived MCP server for a while. */
let modelsSeen: { at: number; list: AiModel[] } | null = null;

export async function aiAccount(k: Kit): Promise<AiAccount> {
  const a = await k.c.call<AiAccount>('/api/ai/account').catch((e) => {
    throw aiExplain(k, e);
  });
  if (Array.isArray(a?.models)) modelsSeen = { at: Date.now(), list: a.models };
  return a;
}

async function modelsOf(k: Kit): Promise<AiModel[]> {
  if (modelsSeen && Date.now() - modelsSeen.at < 10 * 60_000) return modelsSeen.list;
  return (await aiAccount(k)).models || [];
}

/** The account at a glance: credit, models, keys, and what to do next. */
export async function aiSummary(k: Kit) {
  const a = await aiAccount(k);
  const models = (a.models || []).filter((m) => m.ready);
  const live = (a.keys || []).filter((x) => !x.revoked);
  const keySpent = (a.keys || []).reduce((s, x) => s + (Number(x.spent) || 0), 0);
  const low = !a.free && a.balance < 0.05;
  return {
    credit: exact(a.balance),
    ...(a.held > 0 ? { heldForAnswersInFlight: exact(a.held) } : {}),
    ...(a.free ? { free: true } : {}),
    ready: a.ready,
    models: {
      default: a.model,
      private: models.filter(isPrivate).length,
      notPrivate: models.filter((m) => !isPrivate(m)).length,
      more: 'ai_models lists each one, where it runs and its price.',
    },
    api: {
      base: a.base,
      keys: live.map((x) => ({ id: x.id, name: x.name, endsWith: x.last4, requests: x.requests, spentUsd: exact(x.spent), lastUsed: iso(x.lastUsed) })),
      ...(live.length < (a.keys || []).length ? { revoked: (a.keys || []).length - live.length } : {}),
      how: 'OpenAI chat completions: base_url is base, api_key is a key from ai_new_key. Requests are paid from this credit.',
    },
    spent: { chatUsd: exact(a.chat?.spent || 0), chatRequests: a.chat?.requests || 0, apiUsd: exact(keySpent) },
    ...(a.topups?.length ? { topups: a.topups.slice(0, 5).map((t) => ({ at: iso(t.at), usd: t.usd, note: t.note })) } : {}),
    ...(a.cocoon ? { cocoonDiscountPercent: Math.round(a.cocoon.off * 100) } : {}),
    next: low
      ? `Add credit with ai_add_credit (from $${AI_CREDIT_MIN}), paid from your vault or your Gram wallet.`
      : 'Ask with ai_ask, or make an API key with ai_new_key for your own tools.',
  };
}

export async function aiModelList(k: Kit, a: { search?: unknown; private_only?: unknown }) {
  const acct = await aiAccount(k);
  const q = String(a.search ?? '').trim().toLowerCase();
  const privateOnly = a.private_only === true || a.private_only === 'true';
  const list = (acct.models || [])
    .filter((m) => m.ready && (!privateOnly || isPrivate(m)) && (!q || `${m.id} ${m.name} ${m.maker}`.toLowerCase().includes(q)))
    .sort((x, y) => Number(isPrivate(y)) - Number(isPrivate(x)) || x.inPerM + x.outPerM - (y.inPerM + y.outPerM));
  return {
    count: list.length,
    default: acct.model,
    models: list.map((m) => ({
      id: m.id,
      name: m.name,
      maker: m.maker,
      private: isPrivate(m),
      runs: whereItRuns(m),
      tools: m.tools === true,
      ...(m.context ? { contextTokens: m.context } : {}),
      usdPerMillionIn: m.inPerM,
      usdPerMillionOut: m.outPerM,
      ...(m.tag ? { tag: m.tag } : {}),
    })),
    note: 'Pass an id as model to ai_ask, or as model to the API. tools: true means it takes tools (function calling) through the API, so an agent can think with it. A model that is not private sees what you send it.',
  };
}

export async function aiAsk(k: Kit, a: { question?: unknown; model?: unknown }) {
  const question = String(a.question ?? '').trim();
  if (!question) throw new KitError('Ask a question.');
  const model = String(a.model ?? '').trim();
  const r = await k.c
    .call<{ reply: string; model: string; cut: boolean; balance?: number }>('/api/ai/chat', {
      body: { messages: [{ role: 'user', content: question }], ...(model ? { model } : {}) },
    })
    .catch((e) => {
      throw aiExplain(k, e);
    });
  const m = (await modelsOf(k).catch(() => [] as AiModel[])).find((x) => x.id === r.model);
  return {
    answer: r.reply,
    model: r.model,
    ...(m ? { private: isPrivate(m), runs: whereItRuns(m) } : {}),
    ...(model && model !== r.model ? { note: `${model} is not offered or cannot answer just now, so ${r.model} answered. ai_models lists the ids.` } : {}),
    ...(r.cut ? { cut: true } : {}),
    ...(typeof r.balance === 'number' ? { creditLeft: exact(r.balance) } : {}),
  };
}

export async function aiNewKey(k: Kit, a: { name?: unknown }) {
  const name = String(a.name ?? '').trim().slice(0, 40) || 'Agent key';
  const r = await k.c.call<{ key: string; id: string; name: string; last4: string }>('/api/ai/keys', { body: { name } }).catch((e) => {
    throw aiExplain(k, e);
  });
  const acct = await aiAccount(k).catch(() => null);
  const base = acct?.base || `${k.ks.server.replace(/^http:/, 'https:')}/api/ai/v1`;
  const model = acct?.model;
  return {
    key: r.key,
    id: r.id,
    name: r.name,
    base,
    ...(model ? { model } : {}),
    shownOnce: 'This is the only time the key is shown. GhosterDex keeps only its hash.',
    keep: "It spends this account's Private AI credit: keep it like a password, in an environment variable or a secret store, never in a public file, a chat or a prompt.",
    ...(model
      ? {
          use: {
            python: `from openai import OpenAI\nclient = OpenAI(base_url="${base}", api_key=os.environ["GHOSTERDEX_AI_KEY"])\nprint(client.chat.completions.create(model="${model}", messages=[{"role": "user", "content": "Hello"}]).choices[0].message.content)`,
            curl: `curl ${base}/chat/completions -H "Authorization: Bearer $GHOSTERDEX_AI_KEY" -H "Content-Type: application/json" -d '{"model": "${model}", "messages": [{"role": "user", "content": "Hello"}]}'`,
          },
        }
      : {}),
    note: 'Any tool that speaks OpenAI chat completions works, streaming and tool calls too (on models ai_models marks tools: true). Each request is paid from the same credit as ai_ask; ai shows what each key spent, and ai_revoke_key stops one at once.',
  };
}

export async function aiRevokeKey(k: Kit, a: { id?: unknown }) {
  const id = String(a.id ?? '').trim();
  if (!/^k[0-9a-f]{12}$/.test(id)) throw new KitError('That is not a key id.', { hint: 'ai lists your keys with their ids (they start with k).' });
  await k.c.call('/api/ai/keys/revoke', { body: { id } }).catch((e) => {
    throw aiExplain(k, e);
  });
  return { ok: true, revoked: id, note: 'The key stopped working at once.' };
}

/* ------------------------------------------------------------- credit */

export type CreditPayer = { purse: 'vault'; row: Balance } | { purse: 'gram' } | { purse: 'cocoon'; master: string };

/**
 * Which purse pays for credit, and with what. A coin named is the vault's
 * (GRAM falls back to the Gram wallet's own when the vault has too little);
 * "gram_wallet" is the Gram wallet's Gram and "cocoon" its COCOON. Nothing
 * named: a vault stablecoin, then the vault's Gram, then any vault coin that
 * covers it alone (one route spends one coin), then the Gram wallet. The
 * vault comes first because its route is private; the Gram wallet's is on
 * chain for anyone to see, and costs a little less.
 */
export function choosePayer(o: {
  usd: number;
  payWith?: unknown;
  vault: Balance[];
  /** the Gram wallet's Gram, in nanoGram, and Gram's price */
  gramNano: bigint;
  gramPrice: number;
  /** the Gram wallet's COCOON in dollars, and what is known of COCOON here (null: not offered) */
  cocoonUsd: number;
  cocoon: { master: string; off: number } | null;
}): CreditPayer {
  const named = String(o.payWith ?? '').trim();
  const sym = normSymbol(named).replace(/[\s_-]+/g, '');
  const spendable = o.vault.filter((b) => !b.rwa && !b.earn && b.usd > 0);
  const covers = (s?: string) =>
    spendable.filter((b) => (!s || b.symbol.toUpperCase() === s) && b.usd >= o.usd * VAULT_OVER).sort((x, y) => y.usd - x.usd)[0];
  const needNano = o.gramPrice > 0 ? BigInt(Math.ceil((o.usd / o.gramPrice) * 1e9)) + GRAM_FEE_NANO : null;
  const gramPays = needNano !== null && o.gramNano >= needNano;
  const gramShort = () =>
    new KitError(`The Gram wallet cannot pay $${o.usd} of credit${needNano !== null ? `: that takes about ${fromRaw(needNano, 9)} GRAM with the network fee, and it holds ${fromRaw(o.gramNano, 9)}` : ''}.`, {
      code: 'gram_short',
      hint: 'Add less, pay from the vault, or fund the Gram wallet.',
    });

  if (['GRAMWALLET', 'WALLET', 'PUBLIC', 'PUBLICWALLET'].includes(sym)) {
    if (!gramPays) throw gramShort();
    return { purse: 'gram' };
  }
  const vaultOnly = sym === 'VAULT';
  if (sym === 'COCOON') {
    if (!o.cocoon) throw new KitError('COCOON is not taken for credit right now.', { hint: 'Pay with a vault coin or the Gram wallet.' });
    if (o.cocoonUsd < o.usd * (1 - o.cocoon.off)) {
      throw new KitError(`The Gram wallet holds too little COCOON for $${o.usd} of credit.`, { code: 'insufficient', hint: 'Add less, or pay another way.' });
    }
    if (o.gramNano < JETTON_GAS_NANO + GRAM_FEE_NANO) {
      throw new KitError('Sending COCOON takes about 0.07 GRAM for its network fees, and the Gram wallet holds less.', { code: 'gram_short', hint: 'Fund the Gram wallet with a little Gram.' });
    }
    return { purse: 'cocoon', master: o.cocoon.master };
  }
  if (sym && !vaultOnly) {
    const row = covers(sym);
    if (row) return { purse: 'vault', row };
    if (sym === 'GRAM' && gramPays) return { purse: 'gram' };
    throw new KitError(`Not enough ${sym} in the vault to pay about $${(o.usd * VAULT_OVER).toFixed(2)} in one go.`, {
      code: 'insufficient',
      hint: 'Leave pay_with out to use whatever covers it, or add less.',
    });
  }
  for (const s of ['USDT', 'USDC', 'GRAM']) {
    const row = covers(s);
    if (row) return { purse: 'vault', row };
  }
  const any = covers();
  if (any) return { purse: 'vault', row: any };
  if (gramPays && !vaultOnly) return { purse: 'gram' };
  throw new KitError(`Nothing in this account can pay $${o.usd} of credit in one go.`, {
    code: 'insufficient',
    hint: 'Fund the vault (deposit_address) or the Gram wallet, or ask your owner to send some.',
  });
}

/** Two spellings of one TON address are one address. */
function sameAddress(a: string, b: string): boolean {
  try {
    return Address.parse(a).equals(Address.parse(b));
  } catch {
    return false;
  }
}

/** A text comment, the memo the box claims a payment by. */
function memoCell(memo: string): Cell {
  return beginCell().storeUint(0, 32).storeStringTail(memo).endCell();
}

/**
 * The order's route bound before anything is signed, as the app binds it: a
 * route the order refuses is never signed, and a bind that cannot be reached
 * is not signed over either. Asked three times, then nothing happens.
 */
async function bindFirst(k: Kit, orderId: string, routeId: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await k.c.call(`/api/ai/credit/status?orderId=${enc(orderId)}&routeId=${enc(routeId)}`);
      return;
    } catch (e) {
      if (e instanceof ApiError && e.body?.code === 'route_refused') {
        throw new KitError(`${e.message} Nothing was charged.`, { code: 'route_refused' });
      }
      if (attempt >= 2) throw new KitError('The order could not be confirmed. Nothing was charged. Try again.', { code: 'order_unconfirmed' });
      await sleep(800 * (attempt + 1));
    }
  }
}

/** Follows a credit order until the credit is added, it fails, or the wait runs out. */
async function followCredit(k: Kit, orderId: string, routeId: string, waitMs: number): Promise<{ status: string; message?: string }> {
  const until = Date.now() + waitMs;
  let status = 'PAYING';
  let message: string | undefined;
  while (Date.now() < until) {
    await sleep(3000);
    try {
      const s = await k.c.call<{ status: string; message?: string }>(`/api/ai/credit/status?orderId=${enc(orderId)}&routeId=${enc(routeId)}`);
      status = String(s.status || status);
      message = s.message;
      if (status === 'DELIVERED' || status === 'FAILED' || status === 'REFUNDED') break;
    } catch (e) {
      if (e instanceof ApiError && e.body?.code === 'route_refused') return { status: 'FAILED', message: e.message };
      /* a blip; keep following */
    }
  }
  return { status, message };
}

/** Buys `a.usd` dollars of credit with this account's own money, and follows it until the credit is added. */
export async function aiAddCredit(k: Kit, a: { usd?: unknown; pay_with?: unknown }, waitMs: number) {
  const amount = Number(String(a.usd ?? '').replace(/^\$/, '').trim());
  if (!aiTopupOk(amount)) {
    throw new KitError(`Add from $${AI_CREDIT_MIN} to $${AI_CREDIT_MAX.toLocaleString('en-US')} of credit, in whole cents.`, { code: 'bad_amount' });
  }
  const usdAmount = Math.round(amount * 100) / 100;
  const acct = await aiAccount(k);
  if (acct.free) {
    return { ok: true, added: false, note: "Private AI is free for this account, so there is nothing to add." };
  }

  /* what each purse holds; an unreadable vault is no vault for choosing, unless nothing else can pay */
  let vault: Balance[] = [];
  let vaultUnread: unknown = null;
  try {
    vault = await k.balances();
  } catch (e: any) {
    if (e?.code !== 'balance_unavailable') throw e;
    vaultUnread = e;
  }
  const snap = await k.gramSnapshot(true).catch(() => null);
  const gramNano = BigInt(snap?.account?.raw || '0');
  const cocoonRow = acct.cocoon ? (snap?.jettons || []).find((j) => sameAddress(j.master, acct.cocoon!.master)) : undefined;
  let payer: CreditPayer;
  try {
    payer = choosePayer({
      usd: usdAmount,
      payWith: a.pay_with,
      vault,
      gramNano,
      gramPrice: Number(snap?.gram?.price) || 0,
      cocoonUsd: Number(cocoonRow?.usd) || 0,
      cocoon: acct.cocoon,
    });
  } catch (e) {
    if (vaultUnread && (e as KitError)?.code === 'insufficient') throw vaultUnread;
    throw e;
  }

  const placed = (body: Record<string, unknown>) =>
    k.withApproval(() => k.c.call<CreditOrder>('/api/ai/credit/order', { body: { usd: usdAmount, ...body } }));
  let orderId = '';
  let routeId = '';
  let paid = '';
  let from: 'vault' | 'gram wallet';

  if (payer.purse === 'vault') {
    const row = payer.row;
    const order = await placed({ payAssetId: row.assetId });
    if (!order?.orderId || !order.assetId || !order.amountRaw || !order.destAssetId) throw new KitError('The order could not be placed. Nothing was charged.');
    if (order.assetId !== row.assetId) throw new KitError(`The order came back priced in another coin than ${row.symbol}. Nothing was charged.`);
    const need = BigInt(order.amountRaw);
    if (BigInt(row.raw) < need) {
      throw new KitError(`That takes ${fromRaw(need, row.decimals)} ${row.symbol}, and the vault holds ${fromRaw(row.raw, row.decimals)} on ${row.blockchain}. Nothing was charged.`, {
        code: 'insufficient',
        hint: 'Add less, or pay with another coin (pay_with).',
      });
    }
    const q = await k.withApproval(() =>
      k.c.call<{ quoteId: string; depositAddress?: string; signPayload?: string }>('/api/quote', {
        body: { kind: 'boxpay', originAssetId: order.assetId, destinationAssetId: order.destAssetId, amount: order.amountRaw, orderId: order.orderId, dry: false },
      }),
    );
    if (!q?.depositAddress || !q.signPayload) throw new KitError('The payment could not be prepared. Nothing was charged.');
    await bindFirst(k, order.orderId, q.depositAddress);
    await k.execute(q, 'boxpay');
    orderId = order.orderId;
    routeId = q.depositAddress;
    paid = `${fromRaw(need, row.decimals)} ${row.symbol}`;
    from = 'vault';
  } else {
    const master = payer.purse === 'cocoon' ? payer.master : '';
    const cocoon = Boolean(master);
    const order = await placed(cocoon ? { payFrom: 'gram', payMaster: master } : { payFrom: 'gram' });
    if (!order?.orderId || order.rail !== 'chain' || !order.amountRaw || !order.routeId) throw new KitError('The order could not be placed. Nothing was charged.');
    const need = BigInt(order.amountRaw);
    /* the key may sign, and the coin and the network's fee are there, before anything is counted or signed */
    const ctl = await k.gramControl().catch(() => null);
    if (ctl?.signatureAllowed === false) {
      throw new KitError("Your owner switched this Gram wallet's own key off. Only your owner can move it now. Nothing was sent.", { code: 'switched_off', hint: 'Pay from the vault instead.' });
    }
    const acctNow = await k.gramAccount();
    const gramNow = BigInt(acctNow.balance || '0');
    let jettonWallet = '';
    let decimals = 9;
    let symbol = 'GRAM';
    if (cocoon) {
      const fresh = await k.gramSnapshot(true);
      const j = (fresh.jettons || []).find((x) => sameAddress(x.master, master));
      if (!j || BigInt(j.raw || '0') < need) throw new KitError(`That takes ${fromRaw(need, j?.decimals ?? 9)} COCOON, and the Gram wallet holds ${j?.amount ?? 0}. Nothing was sent.`, { code: 'insufficient' });
      if (gramNow < JETTON_GAS_NANO + GRAM_FEE_NANO) throw new KitError('Sending COCOON takes about 0.07 GRAM for its network fees, and the Gram wallet holds less. Nothing was sent.', { code: 'gram_short' });
      jettonWallet = j.wallet;
      decimals = j.decimals;
      symbol = j.symbol || 'COCOON';
    } else if (gramNow < need + GRAM_FEE_NANO) {
      throw new KitError(`That takes ${fromRaw(need, 9)} GRAM and the network fee, and the Gram wallet holds ${fromRaw(gramNow, 9)}. Nothing was sent.`, {
        code: 'gram_short',
        hint: `Fund the Gram wallet at ${k.ks.friendly}, or pay from the vault.`,
      });
    }
    /* the owner's rules, on the order as GhosterDex keeps it; the payment goes where that record says, or nowhere */
    const g = await k.withApproval(() =>
      k.c.call<{ ok: boolean; payTo: string; memo: string; amountRaw: string; coin: string; master?: string }>('/api/agent/v1/gate', { body: { kind: 'order', order: order.orderId } }),
    );
    if (!g?.ok || g.memo !== order.memo || g.amountRaw !== order.amountRaw || !order.payTo || !sameAddress(g.payTo, order.payTo)) {
      throw new KitError('The order changed before it was paid. Nothing was sent.', { code: 'order_changed' });
    }
    if (cocoon) {
      const body = beginCell()
        .storeUint(0x0f8a7ea5, 32)
        .storeUint(BigInt(Date.now()), 64)
        .storeCoins(need)
        .storeAddress(Address.parse(g.payTo))
        .storeAddress(Address.parse(k.ks.friendly))
        .storeBit(0)
        .storeCoins(1n)
        .storeBit(1)
        .storeRef(memoCell(g.memo))
        .endCell();
      await k.gramSend([{ to: jettonWallet, value: JETTON_GAS_NANO, body, bounce: true }]);
    } else {
      await k.gramSend([{ to: g.payTo, value: need, body: memoCell(g.memo), bounce: false }]);
    }
    orderId = order.orderId;
    routeId = order.routeId;
    paid = `${fromRaw(need, decimals)} ${symbol}`;
    from = 'gram wallet';
  }

  const end = await followCredit(k, orderId, routeId, waitMs);
  const added = end.status === 'DELIVERED';
  const failed = end.status === 'FAILED' || end.status === 'REFUNDED';
  const now = added ? await aiAccount(k).catch(() => null) : null;
  return {
    ok: !failed,
    added,
    credit: `$${usdAmount.toFixed(2)}`,
    paid,
    from,
    orderId,
    ...(now ? { creditNow: exact(now.balance) } : {}),
    ...(end.message && !added ? { message: end.message } : {}),
    ...(added || failed
      ? {}
      : { note: 'Paid. The credit is added as soon as the payment lands, even if this kit stops watching. Check with ai, or track_order ai_credit <orderId>.' }),
  };
}
