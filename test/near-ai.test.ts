/**
 * How Private AI reads NEAR AI Cloud (worker/nearai.ts, worker/aimodels.ts). The fixture holds rows of NEAR AI's
 * public catalogue as it answered on 2026-11-04, plus one row with a broken price.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { NEAR_AI_BASE, NEAR_DEFAULT, parseCatalogue, shapeFor } from '../worker/nearai';
import { chargeMicro, pickModel, publicModel } from '../worker/aimodels';

const raw = JSON.parse(readFileSync(new URL('./fixtures/near-ai-catalogue.json', import.meta.url), 'utf8'));
const models = parseCatalogue(raw);
const byId = (id: string) => {
  const m = models.find((x) => x.id === id);
  assert.ok(m, `${id} should be offered`);
  return m;
};

test('Private AI talks to NEAR AI Cloud', () => {
  assert.equal(NEAR_AI_BASE, 'https://cloud-api.near.ai/v1');
});

test("a verifiable model on NEAR AI's own hardware reads as tee", () => {
  assert.equal(NEAR_DEFAULT, 'z-ai/glm-5.3-flash');
  assert.equal(byId(NEAR_DEFAULT).tier, 'tee');
  assert.equal(byId(NEAR_DEFAULT).net, 'near');
});

test("a verifiable model on a partner's hardware reads as partner", () => {
  assert.equal(byId('deepseek/deepseek-v3.2').tier, 'partner');
});

test('a model that is not verifiable reads as open, never as private', () => {
  const open = models.filter((m) => m.tier === 'open');
  assert.ok(open.length >= 1);
  for (const m of open) assert.notEqual(raw.models.find((r: any) => r.modelId === m.id).metadata.verifiable, true);
});

test('a price that is not a price drops the model', () => {
  assert.equal(models.some((m) => m.id === 'test/broken-price'), false);
});

test('prices are per million tokens, at cost', () => {
  const m = byId(NEAR_DEFAULT);
  assert.equal(m.inPerM, 0.08);
  assert.equal(m.outPerM, 0.5);
});

test('a charge is counted in micro-dollars and rounds up, never to free', () => {
  const m = byId(NEAR_DEFAULT);
  /* 810 tokens in and 52 out: 64.8 + 26 = 90.8 millionths of a dollar */
  assert.equal(chargeMicro(m, 810, 52), 91);
  assert.equal(chargeMicro(m, 1, 0), 1);
  assert.equal(chargeMicro(m, 0, 0), 0);
});

test('a broken price costs more than any balance, so it can never read as free', () => {
  assert.equal(chargeMicro({ inPerM: Number.NaN, outPerM: 1 }, 10, 10), Number.MAX_SAFE_INTEGER);
});

test('only an offered model can be picked', () => {
  assert.equal(pickModel(models, NEAR_DEFAULT)?.id, NEAR_DEFAULT);
  assert.equal(pickModel(models, 'nobody/not-a-model'), null);
});

test('what the app is told says where a model runs', () => {
  const shown = publicModel(byId(NEAR_DEFAULT)) as any;
  assert.equal(shown.id, NEAR_DEFAULT);
  assert.equal(shown.tier, 'tee');
});

test('in the chat, GLM is asked for a direct answer by reasoning effort low', () => {
  const body = shapeFor(byId(NEAR_DEFAULT), { messages: [], max_tokens: 200 }, { direct: true }) as any;
  assert.equal(body.max_tokens, 200);
  assert.equal(body.reasoning_effort, 'low');
});

test("an API caller's own word on thinking is never overridden", () => {
  const body = shapeFor(byId(NEAR_DEFAULT), { messages: [], reasoning_effort: 'high' }, { direct: true }) as any;
  assert.equal(body.reasoning_effort, 'high');
  assert.equal((shapeFor(byId(NEAR_DEFAULT), { messages: [] }) as any).reasoning_effort, undefined);
});
