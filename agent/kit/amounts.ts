/**
 * Money as exact integers. Every amount an agent types is a decimal string;
 * every amount the network moves is raw base units. Floats never sit between
 * them, because 0.1 + 0.2 is not a thing a wallet should get wrong.
 */

export function toRaw(amount: string | number, decimals: number): bigint {
  const s = String(amount).trim().replace(/_/g, '').replace(/,/g, '');
  if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') throw new Error(`"${amount}" is not an amount.`);
  const [whole, frac = ''] = s.split('.');
  if (frac.length > decimals) {
    throw new Error(`${amount} has more than ${decimals} decimal places, which this coin cannot hold.`);
  }
  return BigInt((whole || '0') + frac.padEnd(decimals, '0'));
}

export function fromRaw(raw: bigint | string, decimals: number): string {
  let v = BigInt(raw);
  const neg = v < 0n;
  if (neg) v = -v;
  const s = v.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const frac = decimals ? s.slice(s.length - decimals).replace(/0+$/, '') : '';
  return (neg ? '-' : '') + whole + (frac ? '.' + frac : '');
}

export function usd(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** "all", "max" and "everything" mean the whole balance. */
export function isAll(v: unknown): boolean {
  return /^(all|max|everything|100%)$/i.test(String(v ?? '').trim());
}
