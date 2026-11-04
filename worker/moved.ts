/**
 * Assets NEAR Intents has moved to a new id (owner, 2026-10-30: "do all three, start with the btc fix").
 *
 * Bitcoin's own BTC is the first. The catalogue now lists it as "BTC(OMNI)", 1cs_v1:btc:native:coin, and the old
 * bridged asset, nep141:btc.omft.near, is one way: solvers still take it (sell, withdraw, switch to the new one) but
 * none sells it, so buying it answers "No liquidity available". Measured with dry quotes in the vault's own
 * confidential types on 2026-10-30: the new one deposits, buys, sells and withdraws; the old one does all but buy.
 *
 * The new id is offered under the coin's own symbol, and the old one stays in the list only so holdings of it can
 * still leave, marked retired, and only while its successor is listed. A retired asset is listed last, so whatever
 * takes the first of a coin (an app built before the mark, a lookup by symbol) takes the current one.
 */

export const MOVED: Readonly<Record<string, { to: string; symbol: string }>> = {
  'nep141:btc.omft.near': { to: '1cs_v1:btc:native:coin', symbol: 'BTC' },
};

/** The successors, admitted under the coin's own symbol whatever the catalogue calls them. */
export const SUCCESSORS: Readonly<Record<string, string>> = Object.fromEntries(Object.values(MOVED).map((m) => [m.to, m.symbol]));

/** Marks each moved asset retired while its successor is listed, and lists the retired last. */
export function retireMoved<T extends { assetId: string; retired?: boolean }>(tokens: T[]): T[] {
  const listed = new Set(tokens.map((t) => t.assetId));
  const out = tokens.map((t) => (MOVED[t.assetId] && listed.has(MOVED[t.assetId].to) ? { ...t, retired: true } : t));
  return [...out.filter((t) => !t.retired), ...out.filter((t) => t.retired)];
}

/**
 * An id the catalogue lists ahead of its chain. Miden's five coins joined it between 2026-10-30 and 2026-11-04 as NEAR
 * coins (nep141:miden-...omft.near, blockchain "near"), though no such account exists on NEAR: a deposit answers "tokenIn
 * is not valid", every swap "No liquidity available", and near.com does not list them. Shown, they read as a second ETH,
 * USDT and WBTC on NEAR, and as SOL and USDCx on NEAR, which a deposit then refuses. Once one carries a chain of its own
 * this stops matching, and it takes the usual road for a new chain.
 */
export function aheadOfItsChain(t: { assetId: string; blockchain?: string }): boolean {
  return t.blockchain === 'near' && t.assetId.startsWith('nep141:miden-');
}

/**
 * Why a route into a retired asset is refused, or null. A retired asset can be sold, switched, withdrawn or sent as
 * it is; nothing new goes into it: no deposit, and no route from another coin.
 */
export function retiredRefusal(kind: string, origin: { assetId: string }, dest: { assetId: string; symbol: string; retired?: boolean }): string | null {
  if (!dest.retired) return null;
  if (kind === 'deposit' || origin.assetId !== dest.assetId) return `This ${dest.symbol} is being retired: it can be sold or withdrawn, not bought. Pick ${dest.symbol} again for the current one.`;
  return null;
}
