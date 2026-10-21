/**
 * Every thing an agent can do with GhosterDex, once, for both doors: the
 * command line (gdx <tool> ...) and the MCP server (the same names).
 *
 * Answers are JSON an agent can read without guessing: amounts as decimal
 * strings, dollars as numbers, an `id` for anything that keeps moving after
 * the answer, and on refusal an `error`, a `code` and usually a `hint`.
 */
import { Address, beginCell, Cell, loadStateInit } from '@ton/core';
import { ApiError } from './client';
import { fromRaw, isAll, toRaw, usd } from './amounts';
import { Kit, KitError, normSymbol, type Balance, type Token } from './kit';
import { createKeystore, DEFAULT_SERVER, hasKeystore, loadKeystore, ownerGramWallets, saveKeystore } from './wallet';
import { KIT_VERSION } from './client';
import { pinOwner, sealingOff } from './seal';
import { perpsCancel, perpsClose, perpsDeposit, perpsMarkets, perpsOrder, perpsStatus, perpsWithdraw } from './perps';
import { aiAddCredit, aiAsk, aiModelList, aiNewKey, aiRevokeKey, aiSummary } from './ai';

type Schema = {
  type: 'object';
  properties: Record<string, { type: string | string[]; description: string; enum?: unknown[] }>;
  required?: string[];
  additionalProperties?: boolean;
};

export interface Tool {
  name: string;
  title: string;
  description: string;
  input: Schema;
  readOnly?: boolean;
  movesMoney?: boolean;
  /** CLI: which positional words fill which fields, in order */
  args?: string[];
  run(a: Record<string, any>): Promise<unknown>;
}

const S = (description: string) => ({ type: 'string', description });
const N = (description: string) => ({ type: ['number', 'string'], description });

function obj(properties: Schema['properties'], required: string[] = []): Schema {
  return { type: 'object', properties, required, additionalProperties: false };
}

const AMOUNT = N('How much, in the coin itself (for example "25" or "0.5"), or "all" for the whole balance.');

let kitCache: Kit | null = null;
function kit(): Kit {
  if (!kitCache) kitCache = new Kit(loadKeystore());
  return kitCache;
}

/** The kit, for a tool body. Owner instructions already ran (see buildTools). */
async function obeyed<T>(fn: (k: Kit) => Promise<T>): Promise<T> {
  return fn(kit());
}

/**
 * Owner instructions come before anything the agent asked for. Running any
 * command means the agent is online, so a waiting recall runs first, every
 * time: a money command then stops (the agent should look again before it
 * moves anything), and a read carries on and says what happened.
 */
function ownerFirst(t: Tool): Tool {
  if (t.name === 'setup' || t.name === 'pair' || t.name === 'approval') return t;
  return {
    ...t,
    async run(a) {
      const r = hasKeystore() ? await kit().obeyOwner() : null;
      if (r?.recalled) {
        const note = 'Your owner asked for everything back, so it was sent to them first.';
        if (t.movesMoney) return { recalled: r.recalled, note: `${note} Nothing else ran. Check status before moving money again.` };
        const out = await t.run(a);
        return { ...(out && typeof out === 'object' ? (out as object) : { result: out }), recalled: r.recalled, note };
      }
      if (r?.withdrew) {
        /* part of a coin went back first; the command still runs, on what is left */
        const out = await t.run(a);
        const note = 'Your owner asked for some money back, so it was sent to them first.';
        return { ...(out && typeof out === 'object' ? (out as object) : { result: out }), withdrew: r.withdrew, note };
      }
      return t.run(a);
    },
  };
}

function tidy(n: number | undefined, d = 6): string | undefined {
  if (n === undefined || n === null || !Number.isFinite(Number(n))) return undefined;
  return String(Number(Number(n).toFixed(d)));
}

function pickPayer(rows: Balance[], needUsd: number, prefer?: string): Balance {
  const usable = rows.filter((b) => !b.rwa && !b.earn && b.usd > 0);
  const want = prefer ? normSymbol(prefer) : '';
  const order = want ? [want] : ['GRAM', 'USDT', 'USDC'];
  for (const sym of order) {
    const hit = usable.filter((b) => b.symbol.toUpperCase() === sym && b.usd >= needUsd).sort((a, b) => b.usd - a.usd)[0];
    if (hit) return hit;
  }
  if (want) throw new KitError(`Not enough ${want} to pay about $${needUsd.toFixed(2)}.`, { code: 'insufficient' });
  const any = usable.filter((b) => b.usd >= needUsd).sort((a, b) => b.usd - a.usd)[0];
  if (!any) {
    throw new KitError(`Nothing in this account can pay about $${needUsd.toFixed(2)} in one go.`, {
      code: 'insufficient',
      hint: 'Fund the vault (deposit_address) or ask your owner to send some.',
    });
  }
  return any;
}

/** Pays a Stars, Premium or gift order from the vault and follows it until it lands. */
async function payOrder(
  k: Kit,
  product: 'stars' | 'premium' | 'gifts',
  order: { orderId?: string; payTo?: string; assetId?: string; amountRaw?: string; payKind?: string; destAssetId?: string; totalGram?: number; paySymbol?: string },
  waitMs: number,
) {
  if (!order.orderId || !order.assetId || !order.amountRaw) throw new KitError('The order could not be made. Nothing was charged.');
  const kind = order.payKind === 'boxpay' ? 'boxpay' : order.payKind === 'withdraw' ? 'withdraw' : 'send';
  const body: Record<string, unknown> =
    kind === 'boxpay'
      ? { kind, originAssetId: order.assetId, destinationAssetId: order.destAssetId, amount: order.amountRaw, dry: false }
      : kind === 'withdraw'
        ? { kind, originAssetId: order.assetId, destinationAssetId: order.destAssetId, amount: order.amountRaw, recipient: order.payTo, dry: false }
        : { kind, originAssetId: order.assetId, destinationAssetId: order.assetId, amount: order.amountRaw, recipient: order.payTo, dry: false };
  const q = await k.withApproval(() => k.c.call<any>('/api/quote', { body }));
  if (!q?.depositAddress || !q?.signPayload) throw new KitError('The payment could not be prepared. Nothing was charged.');
  await k.execute(q, kind);
  const routeId = q.depositAddress as string;
  const path = product === 'gifts' ? '/api/gifts/order/status' : `/api/${product}/order/status`;
  const until = Date.now() + waitMs;
  let status = 'PAYING';
  let message: string | undefined;
  /* the order binds to its payment when the status route is shown the route */
  do {
    try {
      const s = await k.c.call<{ status: string; message?: string }>(
        `${path}?orderId=${encodeURIComponent(order.orderId)}&routeId=${encodeURIComponent(routeId)}`,
      );
      status = s.status;
      message = s.message;
      if (['DELIVERED', 'FAILED', 'REFUNDED'].includes(status)) break;
    } catch {
      /* keep asking */
    }
    await new Promise((r) => setTimeout(r, 4000));
  } while (Date.now() < until);
  return {
    ok: status !== 'FAILED' && status !== 'REFUNDED',
    status,
    orderId: order.orderId,
    paid: `${tidy(order.totalGram)} ${order.paySymbol || ''}`.trim(),
    ...(message ? { message } : {}),
    ...(status === 'DELIVERED' ? {} : { note: 'Still on its way. Check again with track_order.' }),
  };
}

function gramAmountToNano(a: unknown): bigint {
  return toRaw(String(a), 9);
}

async function tokenOnTon(k: Kit, sym: string): Promise<{ address: string; symbol: string; decimals: number }> {
  const s = String(sym || '').trim();
  if (normSymbol(s) === 'GRAM') return { address: 'native', symbol: 'GRAM', decimals: 9 };
  try {
    Address.parse(s);
    const t = await k.c.call<any>(`/api/ton/token?id=${encodeURIComponent(s)}`);
    return { address: s, symbol: t?.symbol || s.slice(0, 6), decimals: Number(t?.decimals ?? 9) };
  } catch {
    /* a symbol */
  }
  const snap = await k.gramSnapshot().catch(() => null);
  const held = snap?.jettons?.find((j) => j.symbol.toUpperCase() === s.toUpperCase());
  if (held) return { address: held.master, symbol: held.symbol, decimals: held.decimals };
  const found = await k.c.call<any>(`/api/ton/tokens?q=${encodeURIComponent(s)}`);
  const list: any[] = Array.isArray(found) ? found : found?.tokens || found?.items || [];
  const exact = list.find((t) => String(t.symbol || '').toUpperCase() === s.toUpperCase()) || list[0];
  if (!exact?.address) throw new KitError(`No token called ${s} trades on the Gram side.`, { code: 'unknown_coin' });
  return { address: exact.address, symbol: exact.symbol, decimals: Number(exact.decimals ?? 9) };
}

export function buildTools(): Tool[] {
  const tools: Tool[] = [
    {
      name: 'setup',
      title: 'Create my GhosterDex account',
      description:
        "Creates this agent's own GhosterDex account: a private vault and a public Gram wallet whose key is made and kept on this machine (GhosterDex never sees it). Pass the pairing code your owner gave you (GDX-XXXX-XXXX) so they can see and guide the account. Run once; it refuses if an account already exists.",
      input: obj(
        {
          name: S('Your name as your owner will see it, up to 32 characters.'),
          pair_code: S('The pairing code from your owner, like GDX-7K3M-Q9TP. Optional.'),
          about: S('One line about what you do. Optional.'),
          client: S('Which agent you run in, for example claude-code, codex, openclaw, cursor. Optional.'),
        },
        ['name'],
      ),
      args: ['name'],
      async run(a) {
        if (hasKeystore()) {
          const ks = loadKeystore();
          throw new KitError(`This machine already has a GhosterDex account (${ks.name}).`, {
            code: 'exists',
            hint: 'Use status to see it, or pair to pair it with a code.',
          });
        }
        const ks = await createKeystore({ name: String(a.name || 'Agent').slice(0, 32), server: process.env.GHOSTERDEX_SERVER || DEFAULT_SERVER });
        saveKeystore(ks);
        kitCache = new Kit(ks);
        const k = kitCache;
        await k.c.login();
        /* the true-balance link: GhosterDex reads the vault's real figures with it,
           for this kit and for the owner's app alike; a read that finds it lapsed makes it again */
        await k.linkTrueBalance();
        const r = await k.c.call<any>('/api/agent/v1/register', {
          body: { name: ks.name, about: a.about, client: a.client, pair: a.pair_code || undefined },
        });
        if (r.pairing?.ok) pinOwner(ks, r.agent?.owner?.key, true);
        return {
          ok: true,
          account: r.agent,
          pairing: r.pairing?.ok ? 'paired with your owner' : r.pairing?.error || 'not paired yet; ask your owner for a code, then run pair',
          tell_your_owner: `My GhosterDex check code is ${r.agent?.check}. It should match the one on my card in GhosterDex, Explore.`,
          keep_safe: `Your recovery phrase is in ${process.env.GHOSTERDEX_HOME || '~/.ghosterdex'}/wallet.json. It IS the money: never print it, paste it, or send it anywhere.`,
        };
      },
    },
    {
      name: 'pair',
      title: 'Pair with my owner',
      description: 'Pairs this account with its owner using the code from GhosterDex, Explore, Agent Wallets. After pairing the owner sees this account and sets its rules.',
      input: obj({ code: S('The pairing code, like GDX-7K3M-Q9TP.') }, ['code']),
      args: ['code'],
      async run(a) {
        const r = await kit().c.call<any>('/api/agent/v1/pair', { body: { code: a.code } }).catch((e) => {
          throw kit().explain(e);
        });
        /* pairing is the one moment the owner's key may change: pin the one this code belongs to */
        pinOwner(kit().ks, r.agent?.owner?.key, true);
        return { ok: true, account: r.agent, tell_your_owner: `Paired. My check code is ${r.agent?.check}.` };
      },
    },
    {
      name: 'status',
      title: 'My account and my owner\'s rules',
      description:
        "Who this account is, whether it is paired, the owner's rules (trading, shopping, sending to others, daily limit and what is left today, approval threshold), whether it is paused, its check code and its two addresses. Read this before moving money.",
      input: obj({}),
      readOnly: true,
      async run() {
        const k = kit();
        const me = await k.me(true);
        const { owner, sealedTo, ...rest } = me;
        const ctl = owner ? await k.gramControl().catch(() => null) : null;
        let ownerGram = '';
        try {
          ownerGram = owner?.gramAddress ? Address.parse(owner.gramAddress).toRawString() : '';
        } catch {
          /* no owner wallet on record */
        }
        /* anyone else the chain lets move this Gram wallet, named as plainly as the owner is */
        const ownerWallets = ownerGramWallets(k.ks.owner?.key || '');
        const others = (ctl?.extensions || []).filter((x) => x !== ownerGram && !ownerWallets.includes(x));
        const previous = (x: string) => k.ks.owner?.via === 'pair' && (k.ks.ownerExt || []).some((e) => e.address === x && e.key !== k.ks.owner?.key);
        return {
          ...rest,
          owner: owner ? { vaultAddress: owner.vaultAddress, gramAddress: owner.gramAddress, since: owner.since } : null,
          /* said plainly, because it is the owner's power over this wallet */
          ownerControl: !owner
            ? undefined
            : ctl?.signatureAllowed === false
              ? "switched off by your owner: this Gram wallet's own key can no longer sign, and only your owner can move it"
              : ownerGram && ctl?.extensions.includes(ownerGram)
                ? 'on: your owner can move this Gram wallet, or switch its key off, from their own wallet at any time, without you'
                : 'not yet: it is set up the next time this kit runs with a little Gram (0.03 GRAM) in this Gram wallet',
          ...(others.length
            ? {
                alsoControlledBy: others.map((x) =>
                  previous(x)
                    ? `${x}: a previous owner's wallet, which can still move this Gram wallet; the kit removes it on its next run while you are not paused`
                    : `${x}: can also move this Gram wallet (not added by this kit)`,
                ),
              }
            : {}),
          instantWithdraw: !owner
            ? undefined
            : sealingOff()
              ? 'off on this machine (GDX_SEAL=off): your owner gets money back through this kit'
              : sealedTo?.length
                ? `ready on ${sealedTo.length} of your owner's devices`
                : 'not yet: it starts once your owner approves a device in GhosterDex',
          addresses: {
            vault: `${me.vaultAddress} (private: other GhosterDex accounts send here)`,
            gram: `${me.gramAddress} (public Gram wallet: send Gram and TON tokens here)`,
          },
          kit: KIT_VERSION,
        };
      },
    },
    {
      name: 'balance',
      title: 'What I hold',
      description: 'Everything this account holds: the private vault (every coin and network) and the public Gram wallet (Gram and tokens), with dollar values and totals.',
      input: obj({}),
      readOnly: true,
      async run() {
        const k = kit();
        const [vault, gram] = await Promise.all([k.balances(), k.gramSnapshot().catch(() => null)]);
        const vaultUsd = vault.reduce((s, b) => s + (b.usd || 0), 0);
        const gramRows = gram
          ? [
              ...(gram.account && gram.account.amount > 0 ? [{ coin: 'GRAM', amount: tidy(gram.account.amount, 9), usd: usd(gram.gram.usd) }] : []),
              ...(gram.jettons || []).filter((j) => j.amount > 0).map((j) => ({ coin: j.symbol, amount: tidy(j.amount), usd: usd(j.usd), token: j.master })),
            ]
          : [];
        return {
          totalUsd: usd(vaultUsd + (gram?.totalUsd || 0)),
          vault: {
            private: true,
            usd: usd(vaultUsd),
            coins: vault
              .sort((a, b) => b.usd - a.usd)
              .map((b) => ({
                coin: b.symbol,
                network: b.blockchain,
                amount: fromRaw(b.raw, b.decimals),
                usd: usd(b.usd),
                ...(b.rwa ? { stock: true } : {}),
                ...(b.earn ? { earning: true } : {}),
              })),
          },
          gram: { public: true, address: k.ks.friendly, usd: usd(gram?.totalUsd || 0), coins: gramRows, ...(gram ? {} : { note: 'Could not read the Gram wallet just now.' }) },
        };
      },
    },
    {
      name: 'coins',
      title: 'Coins and networks',
      description: 'The coins GhosterDex trades in the vault, the networks each lives on, and prices. Search by name or symbol. Stocks and Earn receipts are marked.',
      input: obj({ search: S('Part of a symbol, like "usd" or "sol". Optional.') }),
      args: ['search'],
      readOnly: true,
      async run(a) {
        const all = await kit().tokens();
        const q = String(a.search || '').trim().toUpperCase();
        const by = new Map<string, { coin: string; price: number; networks: string[]; stock?: boolean; earn?: boolean }>();
        for (const t of all) {
          if (q && !t.symbol.toUpperCase().includes(normSymbol(q))) continue;
          const row = by.get(t.symbol) || { coin: t.symbol, price: t.price, networks: [], ...(t.rwa ? { stock: true } : {}), ...(t.earn ? { earn: true } : {}) };
          row.networks.push(t.blockchain);
          by.set(t.symbol, row);
        }
        const coins = [...by.values()].sort((x, y) => y.networks.length - x.networks.length || x.coin.localeCompare(y.coin));
        return { count: coins.length, coins: coins.slice(0, q ? 60 : 200) };
      },
    },
    {
      name: 'deposit_address',
      title: 'Get money in',
      description:
        'An address that pays into the private vault from outside (any wallet or exchange), for one coin on one network. Valid for days; credited automatically. Send only that coin on that network.',
      input: obj({ coin: S('For example USDC, GRAM, SOL, BTC.'), network: S('For example base, eth, sol, ton, arb, near. Needed when the coin is on several.') }, ['coin']),
      args: ['coin', 'network'],
      async run(a) {
        return obeyed(async (k) => {
          const variants = await k.variants(a.coin);
          const net = k.network(a.network);
          if (!net && variants.length > 1) {
            throw new KitError(`${normSymbol(a.coin)} is on several networks. Name one.`, {
              code: 'need_network',
              hint: `One of: ${variants.map((v) => v.blockchain).join(', ')}.`,
            });
          }
          const t = net ? variants.find((v) => v.blockchain === net) : variants[0];
          if (!t) throw new KitError(`${normSymbol(a.coin)} is not on ${net} here.`, { hint: `It is on: ${variants.map((v) => v.blockchain).join(', ')}.` });
          if (t.rwa) throw new KitError('Stocks cannot be deposited. Buy them inside with swap.');
          const refund = t.blockchain === 'ton' ? k.ks.friendly : undefined;
          const q = await k.c
            .call<any>('/api/quote', { body: { kind: 'deposit', originAssetId: t.assetId, destinationAssetId: t.assetId, recipient: refund, refundTo: refund, dry: false } })
            .catch((e) => {
              throw k.explain(e);
            });
          return {
            coin: t.symbol,
            network: t.blockchain,
            address: q.depositAddress,
            ...(q.depositMemo ? { memo: q.depositMemo, memo_note: 'The memo is required. Without it the deposit is lost.' } : {}),
            minimum: q.minDepositFormatted ? `${q.minDepositFormatted} ${t.symbol}` : undefined,
            validUntil: q.validUntil,
            note: `Send only ${t.symbol} on ${t.blockchain}. It lands privately in your vault within minutes; check with balance or track.`,
            id: q.depositAddress,
          };
        });
      },
    },
    {
      name: 'quote',
      title: 'Price a swap',
      description: 'What a swap would give right now, with nothing moving. Works for any pair in the vault, across networks, including stocks.',
      input: obj(
        {
          amount: AMOUNT,
          from: S('The coin to sell, like USDC.'),
          to: S('The coin to buy, like GRAM.'),
          from_network: S('Which network of the coin to sell. Optional.'),
          to_network: S('Which network to receive on. Optional.'),
        },
        ['amount', 'from', 'to'],
      ),
      args: ['amount', 'from', 'to'],
      readOnly: true,
      async run(a) {
        const k = kit();
        let origin: Token;
        let raw: bigint;
        try {
          const s = await k.source(a.from, String(a.amount), a.from_network);
          origin = s.token;
          raw = s.raw;
        } catch {
          origin = await k.destination(a.from, a.from_network);
          if (isAll(a.amount)) throw new KitError('"all" needs a balance to measure. Give a number to price.');
          raw = toRaw(String(a.amount), origin.decimals);
        }
        const dest = await k.destination(a.to, a.to_network, origin.blockchain);
        const q = await k.c
          .call<any>('/api/quote', { body: { kind: 'swap', originAssetId: origin.assetId, destinationAssetId: dest.assetId, amount: raw.toString(), dry: true } })
          .catch((e) => {
            throw k.explain(e);
          });
        return {
          sell: `${fromRaw(raw, origin.decimals)} ${origin.symbol}`,
          receive: `${tidy(q.amountOutFormatted)} ${dest.symbol}`,
          atLeast: q.minAmountOutFormatted ? `${tidy(q.minAmountOutFormatted)} ${dest.symbol}` : undefined,
          usdIn: usd(q.amountInUsd),
          usdOut: usd(q.amountOutUsd),
          rate: q.rate ? `1 ${origin.symbol} = ${tidy(q.rate)} ${dest.symbol}` : undefined,
          networks: { from: origin.blockchain, to: dest.blockchain },
        };
      },
    },
    {
      name: 'swap',
      title: 'Swap coins privately',
      description:
        'Swaps inside the private vault: any coin to any coin, across networks, stocks included (stocks from $50, in New York market sessions). Signs with this account\'s key and follows the trade until it settles.',
      input: obj(
        {
          amount: AMOUNT,
          from: S('The coin to sell, like USDC.'),
          to: S('The coin to buy, like GRAM or NVDAon.'),
          from_network: S('Which network of the coin to sell. Optional; the kit picks the balance that covers it.'),
          to_network: S('Which network to receive on. Optional.'),
          slippage_percent: N('Most price movement to accept, in percent. Optional; default 0.1% (up to 3).'),
        },
        ['amount', 'from', 'to'],
      ),
      args: ['amount', 'from', 'to'],
      movesMoney: true,
      async run(a) {
        return obeyed(async (k) => {
          const src = await k.source(a.from, String(a.amount), a.from_network);
          const dest = await k.destination(a.to, a.to_network, src.token.blockchain);
          if (dest.assetId === src.token.assetId) throw new KitError('Pick a different coin to swap into.');
          const slip = a.slippage_percent ? Math.round(Number(a.slippage_percent) * 100) : undefined;
          const r = await k.route({ kind: 'swap', origin: src.token, dest, raw: src.raw, slippageBps: slip, waitMs: 120_000 });
          return {
            ok: r.status !== 'FAILED' && r.status !== 'REFUNDED',
            status: r.status,
            id: r.id,
            sold: `${fromRaw(src.raw, src.token.decimals)} ${src.token.symbol}`,
            expected: `${tidy(r.quote.amountOutFormatted)} ${dest.symbol}`,
            atLeast: r.quote.minAmountOutFormatted ? `${tidy(r.quote.minAmountOutFormatted)} ${dest.symbol}` : undefined,
            ...(r.status === 'SUCCESS' ? {} : { note: 'Still settling. Check with track.' }),
          };
        });
      },
    },
    {
      name: 'send',
      title: 'Send privately to a GhosterDex account',
      description:
        'A private transfer from the vault to another GhosterDex account: to "owner", or to a GhosterDex address (64 hex characters) or payment link. Nobody outside can see it. To reach an outside wallet use withdraw.',
      input: obj(
        {
          amount: AMOUNT,
          coin: S('Which coin, like USDC.'),
          to: S('"owner", a GhosterDex address (64 hex), or a https://t.me/GhosterdexBot?startapp=p_... link.'),
          network: S('Which network of the coin to send. Optional.'),
        },
        ['amount', 'coin', 'to'],
      ),
      args: ['amount', 'coin', 'to'],
      movesMoney: true,
      async run(a) {
        return obeyed(async (k) => {
          const to = await resolveGhoster(k, String(a.to || ''));
          const src = await k.source(a.coin, String(a.amount), a.network);
          if (src.token.rwa) throw new KitError('Stocks cannot be sent. Sell them first with swap.');
          const r = await k.route({ kind: 'send', origin: src.token, dest: src.token, raw: src.raw, recipient: to, waitMs: 60_000 });
          return {
            ok: r.status !== 'FAILED' && r.status !== 'REFUNDED',
            status: r.status,
            id: r.id,
            sent: `${fromRaw(src.raw, src.token.decimals)} ${src.token.symbol}`,
            to: String(a.to).toLowerCase() === 'owner' ? 'your owner' : to,
            private: true,
          };
        });
      },
    },
    {
      name: 'withdraw',
      title: 'Withdraw to an outside wallet',
      description:
        'Sends from the private vault to any outside address on its network (an exchange, a wallet). Irreversible: check the address and network. Your owner\'s rules decide whether this may go to anyone but them.',
      input: obj(
        {
          amount: AMOUNT,
          coin: S('Which coin, like USDC.'),
          address: S('The outside address to receive it.'),
          network: S('The address\'s network, like base, eth, sol, ton, arb, tron.'),
        },
        ['amount', 'coin', 'address', 'network'],
      ),
      args: ['amount', 'coin', 'address', 'network'],
      movesMoney: true,
      async run(a) {
        return obeyed(async (k) => {
          const dest = await k.destination(a.coin, a.network);
          if (dest.rwa) throw new KitError('Stocks cannot leave the vault. Sell them first with swap.');
          const src = await k.source(a.coin, String(a.amount));
          const r = await k.route({ kind: 'withdraw', origin: src.token, dest, raw: src.raw, recipient: String(a.address).trim(), waitMs: 45_000 });
          return {
            ok: r.status !== 'FAILED' && r.status !== 'REFUNDED',
            status: r.status,
            id: r.id,
            sent: `${fromRaw(src.raw, src.token.decimals)} ${src.token.symbol}`,
            arrives: `${tidy(r.quote.amountOutFormatted)} ${dest.symbol} on ${dest.blockchain}`,
            to: String(a.address).trim(),
            ...(r.status === 'SUCCESS' ? {} : { note: 'On its way; withdrawals take a few minutes. Check with track.' }),
          };
        });
      },
    },
    {
      name: 'track',
      title: 'Where is it now',
      description: 'The state of a swap, send, withdrawal or deposit, by the id an earlier answer gave.',
      input: obj({ id: S('The id from an earlier answer.') }, ['id']),
      args: ['id'],
      readOnly: true,
      async run(a) {
        const s = await kit().c.call<any>(`/api/status?depositAddress=${encodeURIComponent(String(a.id))}`);
        return { id: a.id, ...s };
      },
    },
    {
      name: 'track_order',
      title: 'A Stars, Premium, gift or credit order',
      description: 'The state of a Stars, Premium, gift or Private AI credit order.',
      input: obj(
        { product: { type: 'string', description: 'stars, premium, gifts or ai_credit', enum: ['stars', 'premium', 'gifts', 'ai_credit'] }, order_id: S('The orderId from the purchase.') },
        ['product', 'order_id'],
      ),
      args: ['product', 'order_id'],
      readOnly: true,
      async run(a) {
        const p = String(a.product);
        const path =
          p === 'ai_credit' ? '/api/ai/credit/status' : p === 'gifts' ? '/api/gifts/order/status' : `/api/${p === 'premium' ? 'premium' : 'stars'}/order/status`;
        return kit().c.call(`${path}?orderId=${encodeURIComponent(String(a.order_id))}`);
      },
    },
    {
      name: 'activity',
      title: 'What happened',
      description: 'Recent activity in the vault, newest first: swaps, sends, withdrawals, deposits, purchases, limit orders, and their states.',
      input: obj({ limit: N('How many, default 15, at most 50.') }),
      args: ['limit'],
      readOnly: true,
      async run(a) {
        const r = await kit().c.call<{ history: any[] }>('/api/history');
        const n = Math.min(50, Math.max(1, Number(a.limit) || 15));
        return {
          activity: (r.history || [])
            .slice()
            .sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt)))
            .slice(0, n)
            .map((h) => ({
              kind: h.kind,
              status: h.status,
              in: `${h.inAmount} ${h.inSymbol}`,
              out: h.outAmount ? `${h.outAmount} ${h.outSymbol}` : undefined,
              usd: usd(h.usd),
              at: h.createdAt,
              id: h.depositAddress,
            })),
        };
      },
    },
    {
      name: 'limit_order',
      title: 'Place a limit order',
      description:
        'Sells a coin for another only at your price or better, resting until it fills or expires. Price is how much of the coin to buy ONE of the coin sold must fetch (for example sell 100 USDC for GRAM at price 0.35 means 0.35 GRAM per USDC).',
      input: obj(
        {
          amount: AMOUNT,
          sell: S('The coin to sell.'),
          buy: S('The coin to get.'),
          price: N('Units of the coin bought per ONE coin sold.'),
          expires_hours: N('How long it rests, 1 to 2160 hours (90 days). Default 168 (a week).'),
          sell_network: S('Optional.'),
          buy_network: S('Optional.'),
        },
        ['amount', 'sell', 'buy', 'price'],
      ),
      args: ['amount', 'sell', 'buy', 'price'],
      movesMoney: true,
      async run(a) {
        return obeyed(async (k) => {
          const src = await k.source(a.sell, String(a.amount), a.sell_network);
          const dest = await k.destination(a.buy, a.buy_network, src.token.blockchain);
          const hours = Math.min(2160, Math.max(1, Number(a.expires_hours) || 168));
          const price = String(a.price).trim();
          if (!(Number(price) > 0)) throw new KitError('Give a price above zero.');
          const made = await k.withApproval(() =>
            k.c.call<any>('/api/limit/create', {
              body: { originAssetId: src.token.assetId, destinationAssetId: dest.assetId, amount: src.raw.toString(), price, expiresIn: Math.round(hours * 3600) },
            }),
          );
          if (!made?.signPayload) throw new KitError('The order could not be prepared.');
          await k.execute(made, 'limit');
          return {
            ok: true,
            orderId: made.orderId,
            selling: `${fromRaw(src.raw, src.token.decimals)} ${src.token.symbol}`,
            atLeast: `${tidy(made.minAmountOutFormatted)} ${dest.symbol}`,
            price: `${price} ${dest.symbol} per ${src.token.symbol}`,
            expires: made.deadline,
          };
        });
      },
    },
    {
      name: 'limit_orders',
      title: 'My limit orders',
      description: 'Open and recent limit orders with how much has filled.',
      input: obj({}),
      readOnly: true,
      async run() {
        return kit().c.call('/api/limit/orders?fresh=1');
      },
    },
    {
      name: 'cancel_limit_order',
      title: 'Cancel a limit order',
      description: 'Cancels a resting limit order; what has not filled comes back to the vault.',
      input: obj({ order_id: S('The orderId.') }, ['order_id']),
      args: ['order_id'],
      movesMoney: true,
      async run(a) {
        return kit().c.call('/api/limit/cancel', { body: { orderId: String(a.order_id) } }).catch((e) => {
          throw kit().explain(e);
        });
      },
    },
    {
      name: 'earn',
      title: 'Earn products',
      description: 'Where the vault can earn interest privately, with today\'s yearly rate and the coin each earns on. Start from $20.',
      input: obj({}),
      readOnly: true,
      async run() {
        const r = await kit().c.call<any>('/api/earn');
        return {
          products: (r.vault || []).map((p: any) => ({
            product: p.id,
            name: p.name,
            receipt: p.symbol,
            earnsOn: p.base,
            by: p.protocol,
            apyPercent: p.apy === null ? 'unknown right now' : Number(Number(p.apy).toFixed(2)),
          })),
          note: 'Start with earn_start; your share grows in place and earn_stop turns it back into the coin.',
        };
      },
    },
    {
      name: 'earn_start',
      title: 'Start earning',
      description: 'Moves coins into an Earn product (a private swap into its receipt, which grows as interest is paid). From $20.',
      input: obj({ product: S('The product, as earn lists it (for example its receipt symbol).'), amount: AMOUNT, network: S('Which network of the base coin to use. Optional.') }, ['product', 'amount']),
      args: ['product', 'amount'],
      movesMoney: true,
      async run(a) {
        return obeyed(async (k) => {
          const r = await k.c.call<any>('/api/earn');
          const want = String(a.product || '').toUpperCase();
          const p = (r.vault || []).find((x: any) => String(x.symbol).toUpperCase() === want || String(x.name).toUpperCase() === want || String(x.id).toUpperCase() === want);
          if (!p) throw new KitError(`No Earn product called ${a.product}.`, { hint: 'The earn tool lists them.' });
          const src = await k.source(p.base, String(a.amount), a.network);
          const dest: Token = { assetId: p.assetId, symbol: p.symbol, decimals: p.decimals, blockchain: '', price: 0, earn: true };
          const res = await k.route({ kind: 'swap', origin: src.token, dest, raw: src.raw, waitMs: 120_000 });
          return { ok: res.status !== 'FAILED', status: res.status, id: res.id, into: p.name, amount: `${fromRaw(src.raw, src.token.decimals)} ${src.token.symbol}` };
        });
      },
    },
    {
      name: 'earn_stop',
      title: 'Stop earning',
      description: 'Turns an Earn position back into its coin, all or part of it.',
      input: obj({ product: S('The product, as earn lists it.'), amount: AMOUNT }, ['product', 'amount']),
      args: ['product', 'amount'],
      movesMoney: true,
      async run(a) {
        return obeyed(async (k) => {
          const r = await k.c.call<any>('/api/earn');
          const want = String(a.product || '').toUpperCase();
          const p = (r.vault || []).find((x: any) => String(x.symbol).toUpperCase() === want || String(x.name).toUpperCase() === want || String(x.id).toUpperCase() === want);
          if (!p) throw new KitError(`No Earn product called ${a.product}.`);
          const src = await k.source(p.symbol, String(a.amount));
          const dest = await k.destination(p.base, undefined, src.token.blockchain);
          const res = await k.route({ kind: 'swap', origin: src.token, dest, raw: src.raw, waitMs: 120_000 });
          return { ok: res.status !== 'FAILED', status: res.status, id: res.id, back: `${tidy(res.quote.amountOutFormatted)} ${dest.symbol}` };
        });
      },
    },
    {
      name: 'stocks',
      title: 'Tokenized stocks',
      description: 'Stocks and ETFs held privately in the vault (Ondo), with prices. Buy and sell them with swap, for example swap 60 USDC NVDAon. Buys from $50, in New York sessions; not everywhere.',
      input: obj({}),
      readOnly: true,
      async run() {
        const all = await kit().tokens();
        return { stocks: all.filter((t) => t.rwa).map((t) => ({ symbol: t.symbol, price: t.price })) };
      },
    },
    {
      name: 'trade_factory',
      title: 'Trade Factory calls',
      description:
        "Trade Factory, GhosterDex's trading skills, runs Dr. Tad's two 4H systems (his 4H System and his 4H Exclusive) at every 4 hour close and makes calls, each naming its system, with a side, entry, stop and target (three times the risk). Some calls wait for a price first (entry_at). Each call says what your vault can do (act: buy, buy_at, hold, sell, avoid). It runs sealed on GhosterDex servers: you get its calls, never how it makes them. Buy with swap or a limit_order, take profit with a limit_order at the target, and check trade_factory again within the hour while you hold one, because no stop is placed for you. Open to agents whose owner has a Trade Factory pass or is a tester.",
      input: obj({}),
      readOnly: true,
      async run() {
        return kit().c.call('/api/agent/v1/factory');
      },
    },
    {
      name: 'ai',
      title: 'My Private AI',
      description:
        "Private AI: GhosterDex's models for you to use (NEAR AI's and Cocoon's), paid by the tokens used from credit this account buys with its own money. Shows the credit left, how many models are private, your API keys with what each spent, the API's address, and what to do next.",
      input: obj({}),
      readOnly: true,
      async run() {
        return aiSummary(kit());
      },
    },
    {
      name: 'ai_models',
      title: 'Private AI models',
      description:
        "Every model you can use, private ones first: where each runs (secure hardware, or its maker's own servers, which are not private) and its price in dollars per million tokens in and out. Filter by part of a name, or private_only.",
      input: obj({ search: S('Part of a model name or maker, like qwen or deepseek. Optional.'), private_only: { type: 'boolean', description: 'Only models that run in secure hardware.' } }),
      args: ['search'],
      readOnly: true,
      async run(a) {
        return aiModelList(kit(), a);
      },
    },
    {
      name: 'ai_ask',
      title: 'Ask Private AI',
      description:
        "One question to a model, private when the model is, paid by the tokens used from this account's credit (a short question costs a fraction of a cent). Up to 2,000 characters; for conversations and longer work, make an API key with ai_new_key. Never put a recovery phrase or a key in a question.",
      input: obj({ question: S('What to ask.'), model: S('A model id from ai_models. Optional; the default is private and quick.') }, ['question']),
      args: ['question'],
      async run(a) {
        return aiAsk(kit(), a);
      },
    },
    {
      name: 'ai_add_credit',
      title: 'Add Private AI credit',
      description:
        "Buys Private AI credit with this account's own money, $1 to $1,000, and follows it until the credit is added; ai_ask and your API keys spend it. Paid privately from the vault (a stablecoin first) unless the vault cannot cover it, then from the Gram wallet on chain. pay_with picks: a vault coin like USDC, vault, gram_wallet for the Gram wallet's Gram, or cocoon for its COCOON at a discount. A purchase under your owner's rules: Purchases, the daily limit and approvals apply.",
      input: obj({ usd: N('Dollars of credit, like 5 or 12.50.'), pay_with: S('A vault coin (USDC, USDT, GRAM...), vault, gram_wallet, or cocoon. Optional.') }, ['usd']),
      args: ['usd', 'pay_with'],
      movesMoney: true,
      async run(a) {
        return obeyed((k) => aiAddCredit(k, a, 150_000));
      },
    },
    {
      name: 'ai_new_key',
      title: 'Make a Private AI API key',
      description:
        "An API key for your own tools: OpenAI's chat completions at GhosterDex's address, any model from ai_models, streaming included, paid from this account's credit. Shown once; keep it like a password. Up to 10 keys.",
      input: obj({ name: S('A name to know it by, like "research bot". Optional.') }),
      args: ['name'],
      async run(a) {
        return aiNewKey(kit(), a);
      },
    },
    {
      name: 'ai_revoke_key',
      title: 'Revoke a Private AI API key',
      description: 'Stops an API key at once, by its id from ai.',
      input: obj({ id: S('The key id, like k1a2b3c4d5e6f.') }, ['id']),
      args: ['id'],
      async run(a) {
        return aiRevokeKey(kit(), a);
      },
    },
    {
      name: 'buy_stars',
      title: 'Buy Telegram Stars',
      description: 'Buys Telegram Stars for any Telegram @username, paid privately from the vault. 50 to 10,000,000 Stars.',
      input: obj({ username: S('The Telegram @username to receive them.'), stars: N('How many Stars, at least 50.'), pay_with: S('Which coin pays. Optional; Gram or a stablecoin is used first.') }, ['username', 'stars']),
      args: ['username', 'stars'],
      movesMoney: true,
      async run(a) {
        return obeyed(async (k) => {
          const stars = Math.floor(Number(a.stars) || 0);
          const gram = (await k.tokens()).find((t) => t.symbol === 'GRAM');
          const est = stars * 0.01 * (gram?.price || 0) * 1.05;
          const payer = pickPayer(await k.balances(), est, a.pay_with);
          const order = await k.c
            .call<any>('/api/stars/order', { body: { stars, recipient: String(a.username).replace(/^@/, ''), payAssetId: payer.assetId } })
            .catch((e) => {
              throw k.explain(e);
            });
          return { product: `${stars} Stars for @${String(a.username).replace(/^@/, '')}`, ...(await payOrder(k, 'stars', order, 150_000)) };
        });
      },
    },
    {
      name: 'buy_premium',
      title: 'Gift Telegram Premium',
      description: 'Buys Telegram Premium (3, 6 or 12 months) for any @username, paid privately from the vault.',
      input: obj({ username: S('The Telegram @username.'), months: { type: ['number', 'string'], description: '3, 6 or 12.', enum: [3, 6, 12, '3', '6', '12'] }, pay_with: S('Which coin pays. Optional.') }, ['username', 'months']),
      args: ['username', 'months'],
      movesMoney: true,
      async run(a) {
        return obeyed(async (k) => {
          const months = Number(a.months);
          const tier = ({ 3: 7.7, 6: 10.27, 12: 18.63 } as Record<number, number>)[months];
          if (!tier) throw new KitError('Premium comes in 3, 6 or 12 months.');
          const gram = (await k.tokens()).find((t) => t.symbol === 'GRAM');
          const payer = pickPayer(await k.balances(), tier * (gram?.price || 0) * 1.05, a.pay_with);
          const order = await k.c
            .call<any>('/api/premium/order', { body: { months, recipient: String(a.username).replace(/^@/, ''), payAssetId: payer.assetId } })
            .catch((e) => {
              throw k.explain(e);
            });
          return { product: `Premium, ${months} months, for @${String(a.username).replace(/^@/, '')}`, ...(await payOrder(k, 'premium', order, 150_000)) };
        });
      },
    },
    {
      name: 'gifts',
      title: 'Browse Telegram gifts',
      description: 'Collectible Telegram gifts for sale across markets, cheapest first. Filter by words or collection and a top price in Gram.',
      input: obj({ search: S('Words to match. Optional.'), collection: S('A collection name, like "Plush Pepe". Optional.'), max_price: N('Highest price in Gram. Optional.'), limit: N('How many, default 10, at most 30.') }),
      args: ['search'],
      readOnly: true,
      async run(a) {
        const body: Record<string, unknown> = { page: 1, per_page: Math.min(30, Math.max(1, Number(a.limit) || 10)), ordering: 'price_asc' };
        if (a.search) body.query = String(a.search);
        if (a.collection) body.collections = [String(a.collection)];
        /* the gift markets count in nanoGram, both ways (worker/mcp.ts, f5b701e) */
        if (a.max_price && Number(a.max_price) > 0) body.price_range = { max: String(Math.round(Number(a.max_price) * 1e9)) };
        const r = await kit().c.call<any>('/api/gifts/search', { body });
        return {
          count: r.count,
          gifts: (r.items || []).map((g: any) => ({
            name: `${g.collection} #${g.number}`,
            priceGram: Number.isFinite(Number(g.price)) ? Number((Number(g.price) / 1e9).toFixed(4)) : null,
            marketplace: g.marketplace,
            id: g.external_id,
            model: g.model?.name,
            backdrop: g.backdrop?.name,
            symbol: g.symbol?.name,
            image: g.image_url,
          })),
          note: 'Buy one with buy_gift using its marketplace and id.',
        };
      },
    },
    {
      name: 'buy_gift',
      title: 'Buy a Telegram gift',
      description:
        'Buys a collectible gift and delivers it to a Telegram profile, paid privately from the vault: your owner\'s profile unless you name a @username. The receiver must have written "Hi" to @thermos_vault in the last day and accept unique gifts; a gift that cannot be bought is refunded.',
      input: obj(
        {
          marketplace: S('From gifts.'),
          id: S('The gift id from gifts.'),
          username: S('The Telegram @username to receive it. Leave it out to send it to your owner, unless your owner named someone.'),
          pay_with: S('Which coin pays. Optional.'),
        },
        ['marketplace', 'id'],
      ),
      args: ['marketplace', 'id', 'username'],
      movesMoney: true,
      async run(a) {
        const to = giftRecipient(a.username);
        return obeyed(async (k) => {
          const check = await k.c.call<any>('/api/gifts/check', { body: { items: [{ marketplace: String(a.marketplace), externalId: String(a.id) }] } }).catch(() => null);
          const hit = check?.results?.[0];
          if (hit?.sold) throw new KitError('That gift has just been sold. Pick another.');
          const gram = (await k.tokens()).find((t) => t.symbol === 'GRAM');
          const priceTon = hit?.priceNano ? Number(hit.priceNano) / 1e9 : 0;
          const payer = pickPayer(await k.balances(), Math.max(1, (priceTon + 0.5) * (gram?.price || 0) * 1.08), a.pay_with);
          const order = await k.c
            .call<any>('/api/gifts/order', {
              /* no recipient: GhosterDex delivers to the owner's profile, from the pairing, never from here */
              body: { items: [{ marketplace: String(a.marketplace), externalId: String(a.id) }], ...(to.handle ? { recipient: to.handle } : {}), payAssetId: payer.assetId },
            })
            .catch((e) => {
              throw k.explain(e);
            });
          return { product: `A gift for ${to.label}`, ...(await payOrder(k, 'gifts', order, 180_000)) };
        });
      },
    },
    {
      name: 'gram_send',
      title: 'Send from the Gram wallet',
      description:
        'Sends Gram or a TON token from the public Gram wallet to a TON address or name (alice.ton, @alice). Public and on chain. Your owner\'s rules apply.',
      input: obj(
        {
          amount: AMOUNT,
          to: S('A TON address, alice.ton, alice.t.me or @alice.'),
          coin: S('GRAM (default) or a token symbol or master address held in the Gram wallet.'),
          comment: S('A public note on the transfer. Optional.'),
        },
        ['amount', 'to'],
      ),
      args: ['amount', 'to', 'coin'],
      movesMoney: true,
      async run(a) {
        return obeyed(async (k) => {
          const to = await k.resolveTon(String(a.to));
          const coin = normSymbol(a.coin || 'GRAM');
          const snap = await k.gramSnapshot(true);
          const comment = String(a.comment || '').replace(/\s+/g, ' ').trim().slice(0, 120);
          if (coin === 'GRAM') {
            const acct = await k.gramAccount();
            const balance = BigInt(acct.balance || '0');
            const value = isAll(a.amount) ? balance - 30_000_000n : gramAmountToNano(a.amount);
            if (value <= 0n) throw new KitError('Not enough Gram.');
            const usdValue = (Number(value) / 1e9) * (snap.gram?.price || 0);
            await k.gramGate('chain', usdValue, to, `Send ${fromRaw(value, 9)} GRAM to ${to.slice(0, 6)}…${to.slice(-4)}`);
            const dest = await k.gramAccount(to).catch(() => null);
            let bounce = dest?.status === 'active';
            try {
              const f = Address.parseFriendly(to);
              bounce = f.isBounceable && dest?.status === 'active';
            } catch {
              /* raw form */
            }
            const body = comment ? beginCell().storeUint(0, 32).storeStringTail(comment).endCell() : null;
            await k.gramSend([{ to, value, body, bounce }]);
            return { ok: true, sent: `${fromRaw(value, 9)} GRAM`, to, public: true, note: 'On chain in a few seconds. It shows in the Gram wallet balance shortly.' };
          }
          const j = (snap.jettons || []).find((x) => x.symbol.toUpperCase() === coin || x.master === a.coin);
          if (!j) throw new KitError(`The Gram wallet holds no ${coin}.`);
          const raw = isAll(a.amount) ? BigInt(j.raw) : toRaw(String(a.amount), j.decimals);
          if (raw > BigInt(j.raw)) throw new KitError(`The Gram wallet holds ${j.amount} ${j.symbol}.`);
          await k.gramGate('chain', (Number(raw) / 10 ** j.decimals) * (j.price || 0), to, `Send ${fromRaw(raw, j.decimals)} ${j.symbol} to ${to.slice(0, 6)}…${to.slice(-4)}`);
          const dest = Address.parse(to);
          const note = comment ? beginCell().storeUint(0, 32).storeStringTail(comment).endCell() : null;
          const body = beginCell()
            .storeUint(0x0f8a7ea5, 32)
            .storeUint(BigInt(Date.now()), 64)
            .storeCoins(raw)
            .storeAddress(dest)
            .storeAddress(Address.parse(k.ks.friendly))
            .storeBit(0)
            .storeCoins(1n);
          if (note) body.storeBit(1).storeRef(note);
          else body.storeBit(0);
          await k.gramSend([{ to: j.wallet, value: 50_000_000n, body: body.endCell(), bounce: true }]);
          return { ok: true, sent: `${fromRaw(raw, j.decimals)} ${j.symbol}`, to, public: true };
        });
      },
    },
    {
      name: 'gram_swap',
      title: 'Swap in the Gram wallet',
      description: 'Swaps Gram and TON tokens on chain from the public Gram wallet, at the best route GhosterDex finds across exchanges. Needs a little Gram for gas.',
      input: obj({ amount: AMOUNT, from: S('GRAM or a token symbol or master address.'), to: S('GRAM or a token symbol or master address.'), slippage_percent: N('Default 1.') }, ['amount', 'from', 'to']),
      args: ['amount', 'from', 'to'],
      movesMoney: true,
      async run(a) {
        return obeyed(async (k) => {
          const from = await tokenOnTon(k, a.from);
          const to = await tokenOnTon(k, a.to);
          let amount = String(a.amount);
          if (isAll(amount)) {
            const snap = await k.gramSnapshot(true);
            if (from.address === 'native') amount = fromRaw(BigInt(snap.account?.raw || '0') - 400_000_000n, 9);
            else amount = fromRaw(snap.jettons?.find((j) => j.master === from.address)?.raw || '0', from.decimals);
          }
          const q = await k.c.call<any>('/api/ton/swap/quote', { body: { from: from.address, to: to.address, amount } }).catch((e) => {
            throw k.explain(e);
          });
          if (q?.bridge) {
            throw new KitError(`No single route from ${from.symbol} to ${to.symbol}.`, { hint: `Swap ${from.symbol} to GRAM first, then GRAM to ${to.symbol}.` });
          }
          /* a swap is trading, not sending: the gate judges it as one */
          await k.gramGate('swap', Number(q.inputUsd) || 0, 'swap', `Swap ${amount} ${from.symbol} to ${to.symbol} in the Gram wallet`);
          const slippage = Math.min(0.5, Math.max(0.001, (Number(a.slippage_percent) || 1) / 100));
          const built = await k.c.call<any>('/api/ton/swap/build', { body: { sender: k.ks.friendly, slippage, paths: q.paths, dedust: q.dedust } }).catch((e) => {
            throw k.explain(e);
          });
          const msgs = (built.transactions || []).map((t: any) => ({
            to: t.address,
            value: BigInt(t.value),
            body: t.payload ? Cell.fromBase64(t.payload) : null,
            bounce: true,
            init: t.stateInit ? loadStateInit(Cell.fromBase64(t.stateInit).beginParse()) : null,
          }));
          await k.gramSend(msgs as any);
          return {
            ok: true,
            sold: `${amount} ${from.symbol}`,
            expected: `${tidy(q.outputAmount)} ${to.symbol}`,
            via: q.dexes,
            priceImpactPercent: q.priceImpactPct,
            note: 'Settles on chain in under a minute. Check with balance.',
          };
        });
      },
    },
    {
      name: 'perps',
      title: 'My perps accounts on Hyperliquid and Aster',
      description:
        "Your own trading account on Hyperliquid and on Aster (perpetual futures, one address for both): your owner's rules (on or off, which venues, leverage cap, how much may be in perps), what each venue holds, open positions and orders, and anything moving between them and your vault. It also carries an unfinished move on.",
      input: obj({}),
      async run() {
        return obeyed((k) => perpsStatus(k));
      },
    },
    {
      name: 'perps_markets',
      title: 'Perps markets on Hyperliquid and Aster',
      description: 'Perpetual markets on both venues, or one, with price, 24 hour change, volume and the smallest order, busiest first. Filter with part of a name, like BTC.',
      input: obj({ search: S('Part of a market name, like BTC. Optional.'), venue: S('hyperliquid or aster. Optional when only one is open to you.'), limit: N('How many, default 25, at most 100.') }),
      args: ['search'],
      readOnly: true,
      async run(a) {
        return { markets: await perpsMarkets(a.search, a.venue, Number(a.limit) || 25) };
      },
    },
    {
      name: 'perps_deposit',
      title: 'Move money from my vault into perps',
      description:
        "Funds your account on a venue from your private vault. Hyperliquid: one private route straight into the account, at least $2. Aster: the coin crosses to your trading address on BNB Chain as USDT (with about $1 of BNB for its fees the first time), then into Aster, at least $5. Needs your owner's perps switch on; their cap and approval size apply. A move still crossing when this answers carries on by itself the next time the kit runs.",
      input: obj({ amount: AMOUNT, coin: S('Which vault coin pays, like USDC or USDT.'), venue: S('hyperliquid or aster. Optional when only one is open to you.') }, ['amount', 'coin']),
      args: ['amount', 'coin', 'venue'],
      movesMoney: true,
      async run(a) {
        return obeyed((k) => perpsDeposit(k, a.amount, a.coin, a.venue, 50_000));
      },
    },
    {
      name: 'perps_order',
      title: 'Open or add to a perps position',
      description:
        "Places a perps order on Hyperliquid or Aster: buy (long) or sell (short), sized in the coin or in dollars (usd), at market (fills within 1% of the price, or not at all) or at a limit price. Leverage up to your owner's cap; left out, the market keeps its leverage if it is inside the cap. reduce_only only shrinks a position. New positions need your owner's perps switch on and the agent not paused.",
      input: obj(
        {
          market: S('The market, like BTC or ETH (Aster also takes BTCUSDT).'),
          side: S('buy (long) or sell (short).'),
          size: N('Size in the coin, like 0.002. Or give usd instead.'),
          usd: N('Size in dollars of position, like 25. Optional.'),
          price: N('A limit price. Leave it out for a market order.'),
          leverage: N("Leverage, like 3. Optional, and never above your owner's cap."),
          reduce_only: { type: 'boolean', description: 'Only shrink a position, never open or flip one.' },
          venue: S('hyperliquid or aster. Optional when only one is open to you.'),
        },
        ['market', 'side'],
      ),
      args: ['market', 'side', 'size'],
      movesMoney: true,
      async run(a) {
        return obeyed((k) =>
          perpsOrder(k, {
            market: a.market,
            side: a.side,
            size: a.size,
            usd: a.usd,
            price: a.price,
            leverage: a.leverage,
            reduceOnly: a.reduce_only === true || a.reduce_only === 'true',
            venue: a.venue,
          }),
        );
      },
    },
    {
      name: 'perps_close',
      title: 'Close perps positions',
      description: "Closes positions at market, reduce-only, and cancels the same markets' open orders: one market or all, on one venue or both. Always allowed, paused or not.",
      input: obj({ market: S('One market, or "all" (the default).'), venue: S('hyperliquid or aster. Left out: both.') }),
      args: ['market'],
      movesMoney: true,
      async run(a) {
        return obeyed((k) => perpsClose(k, a.market || 'all', a.venue));
      },
    },
    {
      name: 'perps_cancel',
      title: 'Cancel perps orders',
      description: "Cancels open orders: one by its id, one market's, or all, on one venue or both.",
      input: obj({ market: S('One market, or "all" (the default).'), order_id: S('One order id. Optional.'), venue: S('hyperliquid or aster. Left out: both.') }),
      args: ['market', 'order_id'],
      async run(a) {
        return obeyed((k) => perpsCancel(k, a.market || 'all', a.order_id, a.venue));
      },
    },
    {
      name: 'perps_withdraw',
      title: 'Bring money from perps to my vault',
      description:
        'Withdraws from a venue privately into your vault. Always allowed: it is money coming home. Hyperliquid pays the vault directly and keeps $1; Aster pays your trading address, which sends it on, and keeps about 0.11 USDT. At least $2. "all" takes what the venue can pay out now (close positions first to free the rest), and "all" with no venue brings both home.',
      input: obj({ amount: N('Dollars, like 20, or "all".'), venue: S('hyperliquid or aster. Left out with "all": both.') }),
      args: ['amount', 'venue'],
      movesMoney: true,
      async run(a) {
        return obeyed((k) => perpsWithdraw(k, a.amount ?? 'all', a.venue, 50_000));
      },
    },
    {
      name: 'return_to_owner',
      title: 'Give money back to my owner',
      description:
        'Sends coins back to the owner privately: one coin, part of one, or everything (the vault, the Gram wallet, and perps on Hyperliquid and Aster, whose positions are closed and balances brought home first). Always allowed, whatever the rules.',
      input: obj({ coin: S('One coin, or leave out for everything.'), amount: AMOUNT }),
      args: ['coin', 'amount'],
      movesMoney: true,
      async run(a) {
        const k = kit();
        const me = await k.me(true);
        if (!me.owner?.vaultAddress) throw new KitError('This account has no owner yet.', { hint: 'Pair first with the code your owner gives you.' });
        if (!a.coin) return k.returnEverything(me);
        const src = await k.source(a.coin, String(a.amount || 'all'));
        const r = await k.route({ kind: 'send', origin: src.token, dest: src.token, raw: src.raw, recipient: me.owner.vaultAddress, waitMs: 60_000 });
        return { ok: r.status !== 'FAILED', status: r.status, id: r.id, sent: `${fromRaw(src.raw, src.token.decimals)} ${src.token.symbol}`, to: 'your owner' };
      },
    },
    {
      name: 'approval',
      title: 'Is my request approved',
      description: 'Checks an approval your owner was asked for (the id from an earlier answer). When approved, run the same command again within 30 minutes.',
      input: obj({ id: S('The approval id.') }, ['id']),
      args: ['id'],
      readOnly: true,
      async run(a) {
        return kit().c.call(`/api/agent/v1/asks/${encodeURIComponent(String(a.id).toUpperCase())}`);
      },
    },
  ];
  return tools.map(ownerFirst);
}

/**
 * Who a gift goes to. Nobody named means the owner (the owner's rule,
 * 2026-09-26); a @username names a profile; a TON or GhosterDex address is
 * refused plainly, since a gift to an address is not offered yet.
 */
export function giftRecipient(username: unknown): { handle?: string; label: string } {
  const v = String(username ?? '').trim();
  if (!v || /^owner$/i.test(v)) return { label: 'your owner' };
  if (/^(EQ|UQ|kQ|0Q)[A-Za-z0-9_-]{46}$/.test(v) || /^-?\d+:[0-9a-f]{64}$/i.test(v) || /^(0x)?[0-9a-f]{64}$/i.test(v)) {
    throw new KitError('A gift goes to a Telegram profile, not an address.', {
      code: 'gift_recipient',
      hint: 'Give a Telegram @username, or leave it out to send the gift to your owner.',
    });
  }
  const handle = v.replace(/^@/, '').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 32);
  if (!handle) throw new KitError('That is not a Telegram @username.', { code: 'gift_recipient', hint: 'Give a @username, or leave it out to send the gift to your owner.' });
  return { handle, label: `@${handle}` };
}

/** "owner", a 64-hex GhosterDex address, or a payment link, to the 64-hex address. */
async function resolveGhoster(k: Kit, to: string): Promise<string> {
  const v = to.trim();
  if (/^owner$/i.test(v)) {
    const me = await k.me(true);
    if (!me.owner?.vaultAddress) throw new KitError('This account has no owner yet.', { hint: 'Pair first.' });
    return me.owner.vaultAddress;
  }
  const hex = v.replace(/^0x/i, '').toLowerCase();
  if (/^[0-9a-f]{64}$/.test(hex)) return hex;
  const m = v.match(/(?:startapp=)?p_([A-Za-z0-9_-]{43})/);
  if (m) {
    const b = Buffer.from(m[1].replace(/-/g, '+').replace(/_/g, '/') + '=', 'base64');
    if (b.length === 32) return b.toString('hex');
  }
  throw new KitError('That is not a GhosterDex address.', {
    hint: 'Use "owner", a 64 character GhosterDex address, or a GhosterDex payment link. For an outside wallet use withdraw.',
  });
}

export function errorOut(e: unknown) {
  if (e instanceof KitError) return { error: e.message, ...(e.code ? { code: e.code } : {}), ...(e.hint ? { hint: e.hint } : {}), ...(e.data ? { data: e.data } : {}) };
  if (e instanceof ApiError) return { error: e.message, code: `http_${e.status}` };
  return { error: (e as Error)?.message || String(e) };
}
