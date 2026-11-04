/**
 * Checks, from scratch and with no key, that a NEAR AI model runs in the secure hardware the app says it does.
 * It follows NEAR AI's published rules: https://docs.near.ai/cloud/verification/reference/quote-nonce-signer
 *
 *   npm run demo:attestation
 *   npm run demo:attestation -- deepseek-ai/DeepSeek-V4.1-Flash-1017
 *   npm run demo:attestation -- --tamper          (also changes one byte of the quote, to see it refused)
 *
 * z-ai/glm-5.3-flash is the default for Private AI and for the AI scan. The script makes its own random nonce, so the
 * evidence it reads cannot be old. It verifies the Intel quote locally against Intel's collateral (with dcap-qvl) and
 * asks NVIDIA's attestation service about the GPUs. It reads NEAR AI's own `tee` models: NEAR AI reports partner models
 * in another shape.
 *
 * What this proves: this model's signing key lives in an Intel TDX machine running the launcher configuration printed
 * below, right now, and NVIDIA's service accepts fresh GPU evidence carrying the same nonce.
 * What it does not prove: which image serves the model, that those GPUs are attached to this machine, or that one
 * particular answer came from it. NEAR AI's response signatures do the last. It also does not judge the configuration:
 * read the images it names, or keep your own allowlist.
 */
import { createHash, randomBytes } from 'node:crypto';
import { INTEL_PCS_URL, getCollateral, verify } from '@phala/dcap-qvl';

const args = process.argv.slice(2);
const TAMPER = args.includes('--tamper');
const MODEL = args.find((a) => !a.startsWith('--')) || 'z-ai/glm-5.3-flash';
const API = 'https://cloud-api.near.ai/v1/attestation/report';
const NVIDIA = 'https://nras.attestation.nvidia.com/v3/attest/gpu';
/* what Intel can say of a platform whose quote verifies; a revoked one is refused by the verifier */
const TCB_OK = new Set(['UpToDate', 'OutOfDate', 'SWHardeningNeeded', 'ConfigurationNeeded', 'ConfigurationAndSWHardeningNeeded', 'OutOfDateConfigurationNeeded']);

let failed = 0;
let refused = false;
function check(name: string, ok: boolean, note = '') {
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${note ? `\n        ${note}` : ''}`);
}
const hex = (s: string) => Buffer.from(String(s).replace(/^0x/, ''), 'hex');
const jsonOf = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);

const nonce = randomBytes(32).toString('hex');
const url = new URL(API);
for (const [k, v] of Object.entries({ model: MODEL, provider: 'near', include_tls_fingerprint: 'false', signing_algo: 'ecdsa', nonce })) url.searchParams.set(k, v);
const res = await fetch(url, { headers: { accept: 'application/json', 'x-no-aliasing': 'true' } });
if (!res.ok) {
  console.log(`NEAR AI answered ${res.status} for ${MODEL}: ${(await res.text()).slice(0, 160)}`);
  console.log('This script reads NEAR AI\'s own tee models. Partner models report in another shape.');
  process.exit(1);
}
const report = (await res.json()) as { model_attestations?: any[] };
const candidates = report.model_attestations || [];

console.log(`${MODEL}\nYour nonce: ${nonce}\nReports to check: ${candidates.length}\n`);
if (!candidates.length) {
  console.log('NEAR AI returned no model evidence for this model, so nothing here can be called verified.');
  process.exit(1);
}

for (const a of candidates) {
  console.log(`Signing identity ${a.signing_address} (${a.signing_algo})`);

  /* 1. freshness, as echoed: the quote's own binding is checked in 4 */
  check('NEAR AI echoed the nonce made here', String(a.request_nonce).toLowerCase() === nonce);

  /* 2. the quote itself, against Intel's certificates and collateral. The verifier throws on anything it cannot accept. */
  const raw = hex(a.intel_quote);
  const collateral = await getCollateral(INTEL_PCS_URL, raw);
  const now = Math.floor(Date.now() / 1000);
  let td: any = null;
  try {
    const verdict: any = verify(raw, collateral, now);
    td = verdict?.report?.type === 'td10' ? verdict.report.data : null;
    const advisories: string[] = verdict?.advisory_ids || [];
    check("The Intel TDX quote verifies against Intel's collateral", Boolean(td) && TCB_OK.has(verdict?.status), `Intel's status for this platform: ${verdict?.status}${advisories.length ? `, advisories: ${advisories.join(', ')}` : ''}`);
  } catch (e) {
    check("The Intel TDX quote verifies against Intel's collateral", false, `Refused: ${(e as Error).message}`);
  }
  if (!td) {
    console.log('  The rest depends on a verified quote, so it is not checked.\n');
    continue;
  }

  /* --tamper: the same quote, verified above, with one byte of MR_TD changed. That byte is signed, and no later check reads it. */
  if (TAMPER) {
    const bad = Buffer.from(raw);
    bad[48 + 136] ^= 1;
    let why = '';
    try {
      verify(bad, collateral, now);
    } catch (e) {
      why = (e as Error).message;
    }
    if (why) refused = true;
    check('The same quote with one byte changed verifies', !why, why ? `Refused: ${why}` : 'It was accepted, so the verifier cannot be trusted.');
  }
  const hexOf = (b: Uint8Array) => Buffer.from(b).toString('hex');

  /* 3. a debuggable machine can be read by its host */
  check('The machine is not in debug mode', (td.tdAttributes[0] & 1) === 0);

  /* 4. the quote commits to this signing key and this nonce */
  const data = Buffer.from(td.reportData);
  const addr = hex(a.signing_address);
  const wantFirst = Buffer.concat([addr, Buffer.alloc(32 - addr.length)]);
  check('The quote binds this signing identity', data.subarray(0, 32).equals(wantFirst));
  check('The quote binds the nonce made here, so it is fresh', data.subarray(32, 64).toString('hex') === nonce);

  /* 5. the runtime log reproduces the measurement in the quote */
  let rtmr3 = Buffer.alloc(48);
  let digestsAgree = true;
  for (const e of (jsonOf(a.event_log) as any[]).filter((x) => x.imr === 3)) {
    const type = Buffer.alloc(4);
    type.writeUInt32LE(e.event_type >>> 0);
    const d = createHash('sha384').update(Buffer.concat([type, Buffer.from(':'), Buffer.from(String(e.event ?? ''), 'utf8'), Buffer.from(':'), hex(e.event_payload || '')])).digest();
    if (e.digest && d.toString('hex') !== String(e.digest).toLowerCase()) digestsAgree = false;
    rtmr3 = createHash('sha384').update(Buffer.concat([rtmr3, d])).digest();
  }
  check('The event log replays to the RTMR3 in the quote', digestsAgree && rtmr3.toString('hex') === hexOf(td.rtMr3));

  /* 6. the configuration that was measured is the one printed in the report */
  const tcb = jsonOf(a.info?.tcb_info) as { app_compose?: string };
  const compose = String(tcb?.app_compose ?? '');
  const hash = createHash('sha256').update(compose, 'utf8').digest();
  const wantConfig = Buffer.concat([Buffer.from([1]), hash, Buffer.alloc(15)]).toString('hex');
  check('The measured configuration hashes to MRCONFIGID', compose.length > 0 && wantConfig === hexOf(td.mrConfigId), `sha256 ${hash.toString('hex')}`);
  const images = [...new Set(compose.match(/[a-z0-9][a-z0-9./_-]*@sha256:[0-9a-f]{64}/g) || [])];
  for (const i of images) console.log(`        launcher runs ${i.slice(0, 88)}`);

  /* 7. the GPUs, judged by NVIDIA */
  if (!a.nvidia_payload) {
    check('NVIDIA GPU evidence is present', false);
  } else {
    const gpu = jsonOf(a.nvidia_payload) as { nonce?: string; evidence_list?: unknown[]; arch?: string };
    const sameNonce = String(gpu.nonce).toLowerCase() === nonce;
    check('The GPU evidence carries the nonce made here', sameNonce);
    if (sameNonce) {
      const r = await fetch(NVIDIA, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(gpu) });
      const body = (await r.json().catch(() => null)) as any;
      const claims = body?.[0]?.[1] ? JSON.parse(Buffer.from(String(body[0][1]).split('.')[1], 'base64url').toString('utf8')) : null;
      check("NVIDIA's attestation service says the GPUs attest", claims?.['x-nvidia-overall-att-result'] === true, `${gpu.evidence_list?.length ?? 0} GPUs, ${gpu.arch}`);
    }
  }
  console.log();
}

console.log('Not checked here: the images that serve the model itself, that those GPUs are attached to this machine, that one particular answer came from it (response signatures), and whether you trust the images above.');
if (failed) {
  console.log(TAMPER && refused && failed === candidates.length ? '\nThe changed quote was refused, as it should be. Everything else passed.' : `\n${failed} CHECK(S) FAILED. Do not call this model verified.`);
  process.exit(1);
}
console.log('Instances of a model share a signing key and can differ in configuration, so the hash above can change between runs.');
console.log('\nALL CHECKS PASSED.');
