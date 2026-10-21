/**
 * The engine behind every command: finding coins, preparing a route, signing
 * it with the agent's own key, handing it in, and following it to the end.
 *
 * Each money move is the phone's three steps, unchanged: GhosterDex prepares
 * the exact intent (/api/quote), the key signs that text here and nowhere else
 * (TON Connect signData), and GhosterDex relays the signature (/api/execute).
 * The Gram wallet signs its own Wallet v5 transfers here too.
 */
import { Address, beginCell, external, internal, SendMode, storeMessage, type Cell } from '@ton/core';
import { ApiError, Client } from './client';
import { signText } from './sign';
import { keysOf, homeDir, ownerGramWallets, refreshTrust, saveKeystore, walletFor, type Keys, type Keystore } from './wallet';
import { fromRaw, isAll, toRaw, usd } from './amounts';
import { deviceApproved, pinOwner, sealFor, sealingOff, type OwnerDevice } from './seal';
import { strongBytes } from './entropy';
import { perpsAdvance, perpsHome } from './perps';

export class KitError extends Error {
  hint?: string;
  code?: string;
  data?: unknown;
  constructor(message: string, extra: { hint?: string; code?: string; data?: unknown } = {}) {
    super(message);
    Object.assign(this, extra);
  }
}

export type Token = {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  price: number;
  rwa?: boolean;
  earn?: boolean;
};

export type Balance = Token & { amount: number; usd: number; raw: string };

export type AgentMe = {
  name: string;
  check: string;
  vaultAddress: string;
  gramAddress: string;
  paired: boolean;
  owner: {
    vaultAddress: string | null;
    gramAddress: string | null;
    since: string | null;
    /** the owner's key as GhosterDex names it; the kit pins the first and checks against that */
    key?: string | null;
    /** devices the owner approved, each with the owner's signature, for the kit to check itself */
    devices?: OwnerDevice[];
  } | null;
  /** the devices GhosterDex holds a sealed copy of this key for */
  sealedTo?: string[];
  paused: boolean;
  rules: {
    trade: boolean;
    shop: boolean;
    sendToOthers: boolean;
    dailyLimitUsd: number | null;
    spentTodayUsd: number;
    leftTodayUsd: number | null;
    askAboveUsd: number | null;
    /** perps on Aster: whether the owner turned them on, the leverage cap, the cap on money there and what is left of it */
    perps?: {
      offered: boolean;
      on: boolean;
      leverageMax: number;
      limitUsd: number | null;
      onAsterUsd: number;
      leftUsd: number | null;
      address: string | null;
    } | null;
  } | null;
  /** recall: everything back; withdraw: part of one coin back ('all' is the whole coin) */
  instructions: Array<{ id: string; type: 'recall' | 'withdraw'; at: number; coin?: string; amount?: string }>;
};

type Quote = {
  quoteId: string;
  depositAddress?: string;
  depositMemo?: string;
  amountIn?: string;
  amountInFormatted?: number;
  amountInUsd?: number;
  amountOut?: string;
  amountOutFormatted?: number;
  amountOutUsd?: number;
  minAmountOutFormatted?: number;
  signPayload?: string;
  minDepositFormatted?: number | string;
  validUntil?: string;
  rate?: number;
  priceImpactPct?: number;
};

const NET_ALIAS: Record<string, string> = {
  ethereum: 'eth', mainnet: 'eth', erc20: 'eth',
  arbitrum: 'arb', 'arbitrum one': 'arb',
  solana: 'sol', spl: 'sol',
  polygon: 'pol', matic: 'pol',
  avalanche: 'avax',
  optimism: 'op',
  binance: 'bsc', bnb: 'bsc', 'bnb chain': 'bsc', bep20: 'bsc',
  bitcoin: 'btc',
  dogecoin: 'doge',
  ripple: 'xrp',
  tron: 'tron', trc20: 'tron',
  gram: 'ton', toncoin: 'ton',
  hyperliquid: 'hypercore',
  zcash: 'zec',
};

/** Where a destination lands when nobody named a network: common, cheap, deep. */
const NET_PREFERENCE = ['near', 'base', 'arb', 'eth', 'sol', 'ton', 'bsc', 'pol', 'op', 'avax', 'tron'];

const TERMINAL = new Set(['SUCCESS', 'FAILED', 'REFUNDED', 'EXPIRED']);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function normSymbol(s: unknown): string {
  const v = String(s || '').trim().toUpperCase().replace(/^\$/, '');
  /* the coin is Gram now; nothing in the catalogue is called TON */
  return v === 'TON' || v === 'TONCOIN' ? 'GRAM' : v;
}

export class Kit {
  ks: Keystore;
  c: Client;
  private _keys?: Keys;
  private _tokens?: { at: number; list: Token[] };
  private _me?: { at: number; me: AgentMe };
  /** set while the kit itself is returning money to the owner */
  private recalling = false;

  constructor(ks: Keystore) {
    this.ks = ks;
    this.c = new Client(ks);
  }

  async keys(): Promise<Keys> {
    if (!this._keys) this._keys = await keysOf(this.ks);
    return this._keys;
  }

  /* ------------------------------------------------------------ reads */

  async tokens(): Promise<Token[]> {
    if (this._tokens && Date.now() - this._tokens.at < 60_000) return this._tokens.list;
    const r = await this.c.call<{ tokens: Token[] }>('/api/tokens?stocks=1');
    this._tokens = { at: Date.now(), list: r.tokens || [] };
    return this._tokens.list;
  }

  /**
   * What the vault holds, as the venue says it does.
   *
   * GhosterDex answers with the venue's own figures through the true-balance
   * link, or says `unavailable` when it could not ask: never a guess, since a
   * figure nobody can spend is worse than none. An unavailable answer used to
   * read as an empty vault here, so a recall reported "nothing to send" over
   * money that was there. The link lasts a week from a signature, so a quiet
   * agent's may have lapsed: it is made again and the venue asked once more,
   * and only then is the read refused, with a code the caller can act on.
   */
  async balances(): Promise<Balance[]> {
    const read = () => this.c.call<{ confidential: Balance[]; balanceSource?: string }>('/api/balances');
    let r = await read();
    if (r.balanceSource === 'unavailable' && (await this.linkTrueBalance())) r = await read();
    if (r.balanceSource === 'unavailable') {
      throw new KitError('The vault balance could not be read right now, so nothing was moved.', {
        code: 'balance_unavailable',
        hint: 'Try again in a moment.',
      });
    }
    return (r.confidential || []).filter((b) => {
      try {
        return BigInt(b.raw || '0') > 0n;
      } catch {
        return false;
      }
    });
  }

  /**
   * The vault's true-balance link, made or renewed: with it GhosterDex reads
   * the venue's real figures for this account, for the kit and for the owner
   * alike. True when a usable link exists after this call (made now, or
   * GhosterDex says it already has one), false when it could not be made.
   */
  async linkTrueBalance(): Promise<boolean> {
    try {
      const ch = await this.c.call<{ message?: string }>('/api/confbal/challenge');
      if (!ch?.message) return false;
      const sig = signText(await this.keys(), this.ks.address, ch.message);
      await this.c.call('/api/confbal/link', { body: { walletSig: sig } });
      return true;
    } catch (e) {
      /* 409: already linked, or the link cannot be checked right now */
      return e instanceof ApiError && e.status === 409;
    }
  }

  async me(fresh = false): Promise<AgentMe> {
    if (!fresh && this._me && Date.now() - this._me.at < 15_000) return this._me.me;
    const me = await this.c.call<AgentMe>('/api/agent/v1/me');
    this._me = { at: Date.now(), me };
    return me;
  }

  network(n: unknown): string | undefined {
    const v = String(n || '').trim().toLowerCase();
    if (!v) return undefined;
    return NET_ALIAS[v] || v;
  }

  /** Every network a coin lives on in the catalogue. */
  async variants(symbol: string): Promise<Token[]> {
    const sym = normSymbol(symbol);
    const list = (await this.tokens()).filter((t) => t.symbol.toUpperCase() === sym);
    if (!list.length) {
      const near = (await this.tokens())
        .map((t) => t.symbol)
        .filter((s, i, a) => a.indexOf(s) === i && s.toUpperCase().includes(sym.slice(0, 3)))
        .slice(0, 8);
      throw new KitError(`GhosterDex does not list ${sym}.`, {
        code: 'unknown_coin',
        hint: near.length ? `Did you mean ${near.join(', ')}? The coins tool lists everything.` : 'The coins tool lists everything GhosterDex trades.',
      });
    }
    return list;
  }

  /** Where money of this coin should land, on this network or the best one. */
  async destination(symbol: string, network?: string, near?: string): Promise<Token> {
    const list = await this.variants(symbol);
    const net = this.network(network);
    if (net) {
      const t = list.find((x) => x.blockchain === net);
      if (!t) {
        throw new KitError(`${normSymbol(symbol)} is not on ${net} here.`, {
          code: 'unknown_network',
          hint: `It is on: ${list.map((x) => x.blockchain).join(', ')}.`,
        });
      }
      return t;
    }
    if (list.length === 1) return list[0];
    if (near) {
      const same = list.find((x) => x.blockchain === near);
      if (same) return same;
    }
    for (const p of NET_PREFERENCE) {
      const t = list.find((x) => x.blockchain === p);
      if (t) return t;
    }
    return list[0];
  }

  /**
   * The balance row a spend comes out of. One route spends one network's
   * coins, so this is the single row that covers the amount, the largest
   * first; a named network is taken as asked.
   */
  async source(symbol: string, amount: string, network?: string): Promise<{ token: Token; raw: bigint; held: bigint }> {
    const sym = normSymbol(symbol);
    const net = this.network(network);
    const rows = (await this.balances())
      .filter((b) => b.symbol.toUpperCase() === sym && (!net || b.blockchain === net))
      .map((b) => ({ b, held: BigInt(b.raw) }))
      .sort((a, b) => (a.held > b.held ? -1 : a.held < b.held ? 1 : 0));
    if (!rows.length) {
      throw new KitError(`There is no ${sym}${net ? ` on ${net}` : ''} in this account.`, {
        code: 'no_balance',
        hint: 'Check with the balance tool, or get a deposit address and fund it.',
      });
    }
    const pick = rows[0];
    const token: Token = { ...pick.b };
    if (isAll(amount)) return { token, raw: pick.held, held: pick.held };
    const raw = toRaw(amount, token.decimals);
    if (raw <= 0n) throw new KitError('The amount must be more than zero.');
    const cover = rows.find((r) => r.held >= raw);
    if (cover) return { token: { ...cover.b }, raw, held: cover.held };
    const total = rows.reduce((s, r) => s + r.held, 0n);
    if (total >= raw && rows.length > 1) {
      throw new KitError(
        `Your ${sym} is split across networks (${rows.map((r) => `${fromRaw(r.held, r.b.decimals)} on ${r.b.blockchain}`).join(', ')}), and one move spends one of them.`,
        { code: 'split_balance', hint: `Move up to ${fromRaw(rows[0].held, rows[0].b.decimals)} ${sym} at once, or name a network.` },
      );
    }
    throw new KitError(`That is more ${sym} than this account holds (${fromRaw(total, token.decimals)}).`, { code: 'insufficient' });
  }

  /* ----------------------------------------------------- owner and rules */

  /**
   * Owner instructions come first, before anything the agent asked for.
   * A recall runs the moment the kit sees it, and until it has run nothing
   * else may move.
   */
  async obeyOwner(): Promise<{ recalled?: unknown; withdrew?: unknown[] } | null> {
    if (this.recalling) return null;
    let me: AgentMe;
    try {
      me = await this.me(true);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null; // not registered yet
      throw e;
    }
    await this.keepSealed(me);
    await this.keepOwnerControl(me);
    /* a move to or from a perps venue that an earlier command started carries on here (perps.ts) */
    await perpsAdvance(this).catch(() => null);
    const recall = me.instructions.find((i) => i.type === 'recall');
    if (!recall) return this.giveBackParts(me);
    this.recalling = true;
    try {
      const result = await this.returnEverything(me);
      /* a vault that could not be read is no answer: the recall stays pending and runs again next time */
      if (!result.retry) {
        await this.c
          .call('/api/agent/v1/commands/ack', { body: { id: recall.id, ok: result.ok, note: result.note } })
          .catch(() => undefined);
      }
      return { recalled: result };
    } finally {
      this.recalling = false;
      this._me = undefined;
    }
  }

  /**
   * One sealed copy of this key with each device the owner approved, so the
   * owner can withdraw without this machine (seal.ts). Only the set changing
   * costs a call. Never throws: a copy that cannot be made now is made on the
   * next command.
   */
  async keepSealed(me: AgentMe): Promise<void> {
    try {
      if (!me.paired || !me.owner) return;
      const pin = pinOwner(this.ks, me.owner.key);
      const want =
        pin && !sealingOff()
          ? [...new Set((me.owner.devices || []).filter((d) => deviceApproved(pin, d)).map((d) => d.pk))].slice(0, 5)
          : [];
      const have = me.sealedTo || [];
      if (want.length === have.length && want.every((pk) => have.includes(pk))) return;
      const plain = Buffer.from(JSON.stringify({ v: 1, words: this.ks.mnemonic, pk: this.ks.publicKey, address: this.ks.address }), 'utf8');
      const random = want.length ? strongBytes(56 * want.length, homeDir()) : new Uint8Array(0);
      const blobs = want.map((pk, i) => sealFor(pk, plain, random.subarray(i * 56, i * 56 + 56)));
      plain.fill(0);
      random.fill(0);
      const r = await this.c.call<{ sealedTo: string[] }>('/api/agent/v1/seal', { body: { blobs } });
      if (this._me) this._me.me = { ...me, sealedTo: r.sealedTo || [] };
    } catch {
      /* the next command tries again */
    }
  }

  /**
   * The owner's own Gram wallet as one this Gram wallet lets act for it (a
   * wallet v5 extension), so the owner can move it, or switch this key off,
   * from their own wallet and without this machine: the way TON's agentic
   * wallets work (owner, 2026-09-26).
   *
   * The rules it keeps. The address is one this kit works out itself from the
   * owner key it pinned (ownerGramWallets); the server's word counts only
   * when it names one of those. It is installed once, only when missing on
   * chain, and recorded. A previous owner's is removed only after an explicit
   * pairing on this machine replaced the pin (never a pin made at first
   * sight, never on the server's word), and only one this kit recorded, so a
   * new owner is never sharing the wallet with the last one. The kit never
   * switches its own key off: that is the owner's. It waits for the wallet to
   * hold a little Gram, makes one change per command, and waits for the seqno
   * to move so the command's own send cannot collide with it. Never throws.
   */
  async keepOwnerControl(me: AgentMe): Promise<void> {
    try {
      if (!me.paired || !me.owner) return;
      refreshTrust(this.ks);
      const pin = pinOwner(this.ks, me.owner.key);
      if (!pin) return;
      const mine = ownerGramWallets(pin);
      let target = '';
      try {
        target = Address.parse(String(me.owner.gramAddress || '')).toRawString();
      } catch {
        /* no owner wallet on record yet */
      }
      if (!mine.includes(target)) target = '';
      const ctl = await this.gramControl(true);
      if (target && ctl.extensions.includes(target)) this.noteOwnerExt(pin, target);
      const stale =
        this.ks.owner?.via === 'pair'
          ? (this.ks.ownerExt || []).filter((e) => e.key !== pin && !mine.includes(e.address) && ctl.extensions.includes(e.address))
          : [];
      /* a pause lets only the owner's install through (worker ownerExtensionOnly), so a removal waits for the resume */
      const remove = !me.paused && stale.length ? stale[0].address : '';
      const install = !remove && target && !ctl.extensions.includes(target) ? target : '';
      if ((!remove && !install) || ctl.signatureAllowed === false) return;
      const acct = await this.gramAccount();
      if (BigInt(acct.balance || '0') < 30_000_000n) return; // the next command, once it holds Gram
      const keys = await this.keys();
      const wallet = walletFor(keys.publicKey);
      const seqno = acct.deployed ? Number(acct.seqno) || 0 : 0;
      const change = { seqno, secretKey: keys.secretKey, extensionAddress: Address.parse(remove || install), timeout: Math.floor(Date.now() / 1000) + 120 };
      const body = remove ? await wallet.createRemoveExtension(change) : await wallet.createAddExtension(change);
      const ext = external({ to: wallet.address, init: seqno === 0 ? wallet.init : undefined, body });
      await this.c.call('/api/ton/send', { body: { boc: beginCell().store(storeMessage(ext)).endCell().toBoc().toString('base64') } });
      for (let i = 0; i < 8; i++) {
        await sleep(3000);
        const now = await this.gramAccount().catch(() => null);
        if (now && Number(now.seqno) > seqno) break;
      }
      if (install) {
        const after = await this.gramControl(true).catch(() => null);
        if (after?.extensions.includes(install)) this.noteOwnerExt(pin, install);
      }
    } catch {
      /* the next command tries again */
    }
  }

  /** Who may act for this Gram wallet, on chain (worker /api/ton/w5control). */
  async gramControl(fresh = false): Promise<{ deployed: boolean; signatureAllowed: boolean | null; extensions: string[] }> {
    return this.c.call(`/api/ton/w5control?address=${encodeURIComponent(this.ks.friendly)}${fresh ? '&fresh=1' : ''}`);
  }

  private noteOwnerExt(key: string, address: string) {
    const had = this.ks.ownerExt || [];
    if (had.some((e) => e.key === key && e.address === address)) return;
    this.ks.ownerExt = [...had, { key, address, at: new Date().toISOString() }];
    saveKeystore(this.ks);
  }

  /** A Gram wallet whose owner switched its key off signs nothing: the chain would refuse it, fee-free, forever. */
  private async gramKeyOn(): Promise<void> {
    const ctl = await this.gramControl().catch(() => null);
    if (ctl?.signatureAllowed === false) {
      throw new KitError("Your owner switched this Gram wallet's own key off. Only your owner can move it now.", { code: 'switched_off' });
    }
  }

  /**
   * The owner's asks for part of one coin, oldest first, each sent back to
   * their vault privately and answered, done or not, so none waits forever.
   */
  private async giveBackParts(me: AgentMe): Promise<{ withdrew: unknown[] } | null> {
    const asks = me.instructions.filter((i) => i.type === 'withdraw').sort((x, y) => x.at - y.at);
    if (!asks.length) return null;
    this.recalling = true;
    const withdrew: unknown[] = [];
    try {
      for (const w of asks) {
        let ok = false;
        let note = '';
        try {
          const ownerVault = me.owner?.vaultAddress;
          if (!ownerVault) throw new KitError('the owner has no vault address on record');
          const src = await this.source(String(w.coin || ''), String(w.amount || 'all'));
          const r = await this.route({ kind: 'send', origin: src.token, dest: src.token, raw: src.raw, recipient: ownerVault, waitMs: 0 });
          ok = true;
          note = `${fromRaw(src.raw.toString(), src.token.decimals)} ${src.token.symbol} is on its way to you.`;
          withdrew.push({ coin: src.token.symbol, amount: fromRaw(src.raw.toString(), src.token.decimals), id: r.id });
        } catch (e: any) {
          /* a vault that could not be read is no answer: the ask waits for the next run */
          if (e?.code === 'balance_unavailable') break;
          note = String(e?.message || e);
        }
        await this.c.call('/api/agent/v1/commands/ack', { body: { id: w.id, ok, note } }).catch(() => undefined);
      }
      return { withdrew };
    } finally {
      this.recalling = false;
      this._me = undefined;
    }
  }

  /**
   * Send every coin back to the owner: the vault privately, the Gram wallet
   * on chain. `retry` means nothing was decided: the vault could not be read,
   * so the recall is left pending for the next run rather than answered.
   */
  async returnEverything(me: AgentMe): Promise<{ ok: boolean; note: string; moves: unknown[]; retry?: true }> {
    const moves: unknown[] = [];
    const notes: string[] = [];
    let ok = true;
    /* Perps first, both venues: positions closed, orders cancelled, balances
       withdrawn, and every later run carrying them home (perps.ts perpsHome).
       Until it is all in the vault the recall stays open, so what lands is
       sent on too. */
    const aster = await perpsHome(this).catch((e: any) => ({ done: false, note: `Perps: ${e?.message || e}` }));
    const ownerVault = me.owner?.vaultAddress;
    if (ownerVault) {
      let held: Balance[];
      try {
        held = await this.balances();
      } catch (e: any) {
        if (e?.code !== 'balance_unavailable') throw e;
        return { ok: false, retry: true, note: 'The vault balance could not be read, so nothing was sent yet. It will be tried again on the next run.', moves };
      }
      for (const b of held) {
        if (b.rwa) {
          notes.push(`${b.symbol} is a stock and cannot be sent; sell it first`);
          ok = false;
          continue;
        }
        if (b.usd > 0 && b.usd < 0.05) continue; // dust costs more to move than it is worth
        try {
          const r = await this.route({
            kind: 'send',
            origin: b,
            dest: b,
            raw: BigInt(b.raw),
            recipient: ownerVault,
            waitMs: 0,
          });
          moves.push({ coin: b.symbol, amount: fromRaw(b.raw, b.decimals), id: r.id });
        } catch (e: any) {
          ok = false;
          notes.push(`${b.symbol}: ${e?.message || e}`);
        }
      }
    } else {
      ok = false;
      notes.push('the owner has no vault address on record');
    }
    const ownerGram = me.owner?.gramAddress;
    if (ownerGram) {
      try {
        const g = await this.gramSweep(ownerGram);
        if (g) moves.push(g);
      } catch (e: any) {
        ok = false;
        notes.push(`Gram wallet: ${e?.message || e}`);
      }
    }
    const note = moves.length
      ? `${moves.length} move${moves.length === 1 ? '' : 's'} on the way to you${notes.length ? `. ${notes.join('. ')}` : ''}.`
      : notes.length
        ? notes.join('. ') + '.'
        : 'There was nothing to send.';
    if (!aster.done) return { ok: false, retry: true, note: `${aster.note} ${moves.length ? note : 'The rest follows when it lands.'}`.trim(), moves };
    return { ok, note, moves };
  }

  /* ---------------------------------------------------------- the vault */

  /**
   * One private route, end to end: prepare, sign here, hand in, follow.
   * `waitMs` is how long to follow it before answering with its id.
   */
  async route(o: {
    kind: 'swap' | 'send' | 'withdraw' | 'boxpay';
    origin: Token;
    dest: Token;
    raw: bigint;
    recipient?: string;
    slippageBps?: number;
    waitMs?: number;
    approvalWaitMs?: number;
  }): Promise<{ id: string; status: string; quote: Quote }> {
    const body: Record<string, unknown> = {
      kind: o.kind,
      originAssetId: o.origin.assetId,
      destinationAssetId: o.dest.assetId,
      amount: o.raw.toString(),
      dry: false,
    };
    if (o.recipient) body.recipient = o.recipient;
    if (o.slippageBps) body.slippageTolerance = o.slippageBps;

    const q = await this.withApproval(() => this.c.call<Quote>('/api/quote', { body }), o.approvalWaitMs);
    if (!q.depositAddress || !q.signPayload) {
      throw new KitError('GhosterDex did not prepare this move for signing. Try again in a moment.');
    }
    await this.execute(q, o.kind, o.approvalWaitMs);
    const status = o.waitMs ? await this.follow(q.depositAddress, o.waitMs) : 'PROCESSING';
    return { id: q.depositAddress, status, quote: q };
  }

  /** Sign the prepared text with this key, then hand the signature in. */
  async execute(q: { quoteId: string; depositAddress?: string; signPayload?: string }, kind: string, approvalWaitMs?: number) {
    const keys = await this.keys();
    const sig = signText(keys, this.ks.address, q.signPayload!);
    return this.withApproval(
      () =>
        this.c.call<{ ok: boolean; status?: string; orderId?: string }>('/api/execute', {
          body: {
            quoteId: q.quoteId,
            depositAddress: q.depositAddress,
            kind,
            walletSig: sig,
            walletBind: { address: this.ks.address, publicKey: this.ks.publicKey },
          },
        }),
      approvalWaitMs,
    );
  }

  /**
   * Runs `fn`; if the owner's rules want an approval first, waits for the
   * owner's tap (up to `waitMs`) and runs it once more.
   */
  async withApproval<T>(fn: () => Promise<T>, waitMs = 90_000): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof ApiError) || e.body?.code !== 'agent_needs_approval') throw this.explain(e);
      const ask = e.body.ask as { id: string };
      const verdict = await this.waitForApproval(ask.id, waitMs);
      if (verdict !== 'approved') {
        throw new KitError(
          verdict === 'declined'
            ? 'Your owner declined this.'
            : verdict === 'expired'
              ? 'Your owner did not answer in time, so this did not happen.'
              : 'Waiting for your owner to approve this in GhosterDex.',
          {
            code: verdict === 'pending' ? 'approval_pending' : `approval_${verdict}`,
            data: { approvalId: ask.id },
            hint: verdict === 'pending' ? `Check later with: approval ${ask.id}, then run the same command again.` : undefined,
          },
        );
      }
      try {
        return await fn();
      } catch (e2) {
        throw this.explain(e2);
      }
    }
  }

  async waitForApproval(id: string, waitMs: number): Promise<string> {
    const until = Date.now() + Math.max(0, waitMs);
    for (;;) {
      const a = await this.c.call<{ status: string }>(`/api/agent/v1/asks/${id}`);
      if (a.status !== 'pending' || Date.now() >= until) return a.status;
      await sleep(4000);
    }
  }

  /** The server's refusals, with the codes an agent can act on. */
  explain(e: unknown): Error {
    if (e instanceof ApiError) {
      const code = e.body?.code as string | undefined;
      const hints: Record<string, string> = {
        agent_paused: 'Tell your owner; they can resume you in GhosterDex, Explore.',
        agent_owner_only: 'Send to your owner instead (to: "owner"), or ask them to allow sending to others.',
        agent_daily_limit: 'Wait until tomorrow (UTC), or ask your owner to raise the daily limit.',
        agent_no_trade: 'Ask your owner to turn trading on in GhosterDex, Explore.',
        agent_no_shop: 'Ask your owner to turn purchases on in GhosterDex, Explore.',
      };
      return new KitError(e.message, { code: code || `http_${e.status}`, hint: code ? hints[code] : undefined, data: e.body });
    }
    return e as Error;
  }

  /** Follows a route until it ends or the wait runs out. */
  async follow(id: string, waitMs: number, memo?: string): Promise<string> {
    const until = Date.now() + waitMs;
    let last = 'PROCESSING';
    while (Date.now() < until) {
      try {
        const s = await this.c.call<{ status: string }>(
          `/api/status?depositAddress=${encodeURIComponent(id)}${memo ? `&depositMemo=${encodeURIComponent(memo)}` : ''}`,
        );
        last = String(s.status || last);
        if (TERMINAL.has(last)) return last;
      } catch {
        /* a blip; keep following */
      }
      await sleep(3000);
    }
    return last;
  }

  /* ----------------------------------------------------- the Gram wallet */

  async gramAccount(address = this.ks.friendly) {
    return this.c.call<{ status: string; deployed: boolean; seqno: number; balance: string; isWallet: boolean }>(
      `/api/ton/account?address=${encodeURIComponent(address)}`,
    );
  }

  async gramSnapshot(fresh = false) {
    return this.c.call<{
      address: string;
      gram: { price: number; usd: number };
      account: { raw: string; amount: number } | null;
      jettons: Array<{ master: string; wallet: string; symbol: string; name: string; decimals: number; raw: string; amount: number; price: number; usd: number; verified: boolean }> | null;
      totalUsd: number;
    }>(`/api/ton/wallet?address=${encodeURIComponent(this.ks.friendly)}${fresh ? '&fresh=1' : ''}`);
  }

  /** alice.ton, alice.t.me, @alice or an address, to an address. */
  async resolveTon(to: string): Promise<string> {
    const v = to.trim();
    try {
      Address.parse(v);
      return v;
    } catch {
      /* a name */
    }
    const name = v.startsWith('@') ? `${v.slice(1)}.t.me` : v;
    if (!/\.(ton|t\.me)$/i.test(name)) throw new KitError(`"${to}" is not a TON address or name.`);
    const r = await this.c.call<{ address: string | null }>(`/api/ton/resolve?name=${encodeURIComponent(name)}`);
    if (!r.address) throw new KitError(`No wallet is set for ${name}.`);
    return r.address;
  }

  /**
   * Signs and hands in one Wallet v5 transaction with these messages.
   * Nothing is sent that the wallet cannot fund: the balance is read first.
   */
  async gramSend(messages: Array<{ to: string; value: bigint; body?: Cell | null; bounce?: boolean; init?: { code: Cell; data: Cell } | null }>) {
    if (!messages.length) throw new KitError('Nothing to send.');
    await this.gramKeyOn();
    const keys = await this.keys();
    const wallet = walletFor(keys.publicKey);
    const acct = await this.gramAccount();
    const balance = BigInt(acct.balance || '0');
    const need = messages.reduce((s, m) => s + m.value, 0n);
    if (balance < need + 10_000_000n) {
      throw new KitError(`The Gram wallet holds ${fromRaw(balance, 9)} GRAM, not enough for this and its network fee.`, {
        code: 'gram_short',
        hint: `Fund the Gram wallet at ${this.ks.friendly}.`,
      });
    }
    const seqno = acct.deployed ? Number(acct.seqno) || 0 : 0;
    const transfer = wallet.createTransfer({
      seqno,
      secretKey: keys.secretKey,
      sendMode: SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS,
      messages: messages.map((m) =>
        internal({
          to: Address.parse(m.to),
          value: m.value,
          body: m.body || undefined,
          bounce: m.bounce ?? false,
          init: m.init || undefined,
        }),
      ),
      timeout: Math.floor(Date.now() / 1000) + 120,
    });
    const ext = external({ to: wallet.address, init: seqno === 0 ? wallet.init : undefined, body: transfer });
    const boc = beginCell().store(storeMessage(ext)).endCell().toBoc().toString('base64');
    await this.c.call('/api/ton/send', { body: { boc } });
    return { seqno, from: this.ks.friendly };
  }

  /** The owner's rules, applied to an on-chain move before it is signed. */
  async gramGate(kind: 'chain' | 'swap', usdValue: number, recipient: string, title: string) {
    await this.c
      .call('/api/agent/v1/gate', { body: { kind, usd: usdValue, recipient, title } })
      .catch((e) => {
        throw this.explain(e);
      });
  }

  /** Everything in the Gram wallet, to one address, in one transaction. */
  async gramSweep(to: string): Promise<unknown> {
    const snap = await this.gramSnapshot(true).catch(() => null);
    const acct = await this.gramAccount();
    const balance = BigInt(acct.balance || '0');
    const jettons = (snap?.jettons || []).filter((j) => BigInt(j.raw || '0') > 0n && j.wallet);
    if (balance < 30_000_000n) return null;
    await this.gramKeyOn();
    const keys = await this.keys();
    const wallet = walletFor(keys.publicKey);
    const seqno = acct.deployed ? Number(acct.seqno) || 0 : 0;
    const dest = Address.parse(to);
    const msgs = jettons.slice(0, 200).map((j) =>
      internal({
        to: Address.parse(j.wallet),
        value: 50_000_000n,
        bounce: true,
        body: beginCell()
          .storeUint(0x0f8a7ea5, 32)
          .storeUint(BigInt(Date.now()), 64)
          .storeCoins(BigInt(j.raw))
          .storeAddress(dest)
          .storeAddress(dest)
          .storeBit(0)
          .storeCoins(1n)
          .storeBit(0)
          .endCell(),
      }),
    );
    const jettonGas = BigInt(msgs.length) * 50_000_000n;
    if (balance <= jettonGas + 20_000_000n && msgs.length) {
      throw new KitError('Not enough Gram to pay for sending the tokens back.', { code: 'gram_short' });
    }
    const transfer = wallet.createTransfer({
      seqno,
      secretKey: keys.secretKey,
      sendMode: SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS,
      messages: msgs,
      timeout: Math.floor(Date.now() / 1000) + 120,
    });
    const txs: string[] = [];
    if (msgs.length) {
      const ext = external({ to: wallet.address, init: seqno === 0 ? wallet.init : undefined, body: transfer });
      await this.c.call('/api/ton/send', { body: { boc: beginCell().store(storeMessage(ext)).endCell().toBoc().toString('base64') } });
      txs.push('tokens');
      await sleep(12_000);
    }
    /* then the Gram itself: carry everything that is left */
    const acct2 = await this.gramAccount();
    const seq2 = Number(acct2.seqno) || (msgs.length ? seqno + 1 : seqno);
    const all = wallet.createTransfer({
      seqno: seq2,
      secretKey: keys.secretKey,
      sendMode: SendMode.CARRY_ALL_REMAINING_BALANCE + SendMode.IGNORE_ERRORS,
      messages: [internal({ to: dest, value: 0n, bounce: false })],
      timeout: Math.floor(Date.now() / 1000) + 120,
    });
    const ext2 = external({ to: wallet.address, init: seq2 === 0 ? wallet.init : undefined, body: all });
    await this.c.call('/api/ton/send', { body: { boc: beginCell().store(storeMessage(ext2)).endCell().toBoc().toString('base64') } });
    txs.push('gram');
    return { wallet: 'gram', to, tokens: jettons.map((j) => `${j.amount} ${j.symbol}`), gram: fromRaw(balance, 9), sent: txs };
  }

  money(n: number) {
    return usd(n);
  }
}
