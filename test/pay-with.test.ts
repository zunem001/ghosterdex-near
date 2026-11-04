/**
 * Which purse pays when an agent buys its own Private AI credit (agent/kit/ai.ts, choosePayer).
 * The vault comes first, because its route is private. The rule is pure, so it runs here with no
 * wallet, no account and no money.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { choosePayer } from '../agent/kit/ai';

const coin = (symbol: string, usd: number) =>
  ({ symbol, usd, assetId: `test:${symbol}`, raw: String(usd * 1e6), decimals: 6, blockchain: 'near' }) as any;

const base = { usd: 5, vault: [] as any[], gramNano: 0n, gramPrice: 2, cocoonUsd: 0, cocoon: null };

test('a vault stablecoin pays first', () => {
  const p = choosePayer({ ...base, vault: [coin('NEAR', 50), coin('USDT', 50)] });
  assert.equal(p.purse, 'vault');
  assert.equal((p as any).row.symbol, 'USDT');
});

test('any vault coin that covers it alone pays when no stablecoin does', () => {
  const p = choosePayer({ ...base, vault: [coin('NEAR', 50)] });
  assert.equal(p.purse, 'vault');
  assert.equal((p as any).row.symbol, 'NEAR');
});

test('one route spends one coin: two small coins do not add up', () => {
  assert.throws(() => choosePayer({ ...base, vault: [coin('USDT', 3), coin('USDC', 3)] }));
});

test('the Gram wallet pays last, when the vault cannot', () => {
  const p = choosePayer({ ...base, gramNano: 10_000_000_000n });
  assert.equal(p.purse, 'gram');
});

test('a coin named by the agent is the one asked for', () => {
  const p = choosePayer({ ...base, payWith: 'usdc', vault: [coin('USDT', 50), coin('USDC', 50)] });
  assert.equal(p.purse, 'vault');
  assert.equal((p as any).row.symbol, 'USDC');
});

test('nothing that can pay is an error, not a charge', () => {
  assert.throws(() => choosePayer({ ...base }));
});
