/**
 * What a swap in the Gram wallet may sign. The route is built elsewhere (GhosterDex, and the exchange behind it), so
 * the messages are read here before the key signs them: a swap spends the coin asked for, and carries only the gas it
 * needs.
 */
import { Address, Cell } from '@ton/core';

/** the most Gram each message of a swap may carry beyond what is being sold, at least two messages' worth: gas that mostly comes back */
export const SWAP_GAS_NANO = 1_000_000_000n;
/** a route splits four ways at most, and each leg is a message or two */
const SWAP_MESSAGES_MAX = 8;
const JETTON_TRANSFER = 0x0f8a7ea5;

export type SwapMessage = { to: string; value: bigint; body: Cell | null };

export function sameAddress(a: unknown, b: unknown): boolean {
  try {
    return Address.parse(String(a)).equals(Address.parse(String(b)));
  } catch {
    return false;
  }
}

/** The coins a jetton transfer moves, or null when the body is not one. */
function jettonAmount(body: Cell | null): bigint | null {
  if (!body) return null;
  try {
    const s = body.beginParse();
    if (s.loadUint(32) !== JETTON_TRANSFER) return null;
    s.loadUintBig(64);
    return s.loadCoins();
  } catch {
    return null;
  }
}

/**
 * Why these messages must not be signed as this swap, or null when they are it.
 * Selling Gram: they carry at most the amount and the gas, and touch none of this wallet's token wallets.
 * Selling a token: they go only to this wallet's own wallet of that token, and move at most the amount.
 */
export function swapRefusal(
  msgs: SwapMessage[],
  o: { native: boolean; amountRaw: bigint; ownWalletOfCoin?: string; ownWallets: string[] },
): string | null {
  if (!msgs.length) return 'the route is empty';
  if (msgs.length > SWAP_MESSAGES_MAX) return 'it is more messages than a swap takes';
  const carried = msgs.reduce((n, m) => n + m.value, 0n);
  if (carried > (o.native ? o.amountRaw : 0n) + SWAP_GAS_NANO * BigInt(Math.max(2, msgs.length))) return 'it carries more Gram than this swap needs';
  if (o.native) {
    if (msgs.some((m) => o.ownWallets.some((w) => sameAddress(m.to, w)))) return 'it touches a token this swap does not sell';
    return null;
  }
  if (!o.ownWalletOfCoin) return "this wallet's own wallet of that coin is not known";
  let moved = 0n;
  for (const m of msgs) {
    if (!sameAddress(m.to, o.ownWalletOfCoin)) return 'it goes somewhere other than the coin being sold';
    const n = jettonAmount(m.body);
    if (n === null) return 'it is not a transfer of the coin being sold';
    moved += n;
  }
  /* a split route's parts are rounded, so their sum can land a hair over */
  if (moved > o.amountRaw + o.amountRaw / 1000n + 1n) return 'it sells more than was asked';
  return null;
}
