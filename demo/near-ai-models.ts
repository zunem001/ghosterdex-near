/**
 * Reads NEAR AI Cloud's public catalogue through the code Private AI runs (worker/nearai.ts) and prints
 * what the app offers, by how private each model is. It needs no key, no account and no money.
 *
 *   npm run demo:models
 */
import { NEAR_CATALOGUE_URL, NEAR_DEFAULT, parseCatalogue } from '../worker/nearai';

const res = await fetch(NEAR_CATALOGUE_URL);
if (!res.ok) throw new Error(`NEAR AI's catalogue answered ${res.status}`);
const models = parseCatalogue(await res.json());

const tiers = [
  ['tee', "NEAR AI's own secure hardware"],
  ['partner', "a partner's secure hardware that NEAR AI attests"],
  ['open', "forwarded to the model's maker, not private"],
] as const;

console.log(`${NEAR_CATALOGUE_URL}\n${models.length} models after the app's filters\n`);
for (const [tier, label] of tiers) {
  const rows = models.filter((m) => m.tier === tier);
  console.log(`${tier}: ${rows.length}, ${label}`);
  if (tier !== 'open') {
    for (const m of rows) console.log(`  ${m.id}  $${m.inPerM}/M in  $${m.outPerM}/M out`);
  }
}
const d = models.find((m) => m.id === NEAR_DEFAULT);
console.log(`\nThe app's default, and the AI scan's model: ${NEAR_DEFAULT} (tier: ${d ? d.tier : 'not listed today'})`);
