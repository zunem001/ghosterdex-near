/**
 * Where a payment from the vault lands (worker-excerpts/box-landing.ts).
 * Paying for Private AI credit, Trade Factory passes, gifts, Stars or Premium normally lands on the
 * Gram chain's Tether, or on Gram itself for Stars and Premium. When 1Click refuses that pair as
 * paused, the payment lands in Tether on NEAR itself, which has no bridge under it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boxLanding, isBoxUsdt } from '../worker-excerpts/box-landing';

const NEAR_TETHER = 'nep141:usdt.tether-token.near';
const paused = () => Object.assign(new Error('Quoting for this pair is not available'), { paused: true });

test('a working route keeps its usual landing', async () => {
  const asked: string[] = [];
  const r = await boxLanding(async (asset) => {
    asked.push(asset);
    return { amountIn: '1' };
  });
  assert.equal(r.paused, false);
  assert.notEqual(r.landing, NEAR_TETHER);
  assert.deepEqual(asked, [r.landing]);
  assert.deepEqual(r.q, { amountIn: '1' });
});

test('a paused route moves to Tether on NEAR', async () => {
  const asked: string[] = [];
  const r = await boxLanding(async (asset) => {
    asked.push(asset);
    if (asset !== NEAR_TETHER) throw paused();
    return { amountIn: '2' };
  });
  assert.equal(r.landing, NEAR_TETHER);
  assert.equal(r.paused, true);
  assert.deepEqual(r.q, { amountIn: '2' });
  assert.equal(asked.length, 2);
});

test('a quote that only flaked keeps the usual landing', async () => {
  const r = await boxLanding(async () => {
    throw new Error('Gateway timeout');
  });
  assert.notEqual(r.landing, NEAR_TETHER);
  assert.equal(r.paused, false);
  assert.equal(r.q, null);
});

test('a paused route still moves when the quote on NEAR flakes too', async () => {
  const r = await boxLanding(async (asset) => {
    if (asset !== NEAR_TETHER) throw paused();
    throw new Error('Gateway timeout');
  });
  assert.equal(r.landing, NEAR_TETHER);
  assert.equal(r.paused, true);
  assert.equal(r.q, null);
});

test("Stars and Premium name their own usual landing, and both Tethers count as the box's", async () => {
  const gram = 'nep245:v2_1.omni.hot.tg:1117_';
  const r = await boxLanding(async () => ({ ok: true }), gram);
  assert.equal(r.landing, gram);
  assert.equal(isBoxUsdt(NEAR_TETHER), true);
  assert.equal(isBoxUsdt(gram), false);
});
