/**
 * Asks the live GhosterDex connector (https://ghosterdex.com/mcp) what the wallet offers. It is read-only:
 * a price is not an order, and nothing moves. It needs no key, no account and no money.
 *
 *   npm run demo:wallet
 */
const MCP = 'https://ghosterdex.com/mcp';

async function rpc(method: string, params?: unknown) {
  const res = await fetch(MCP, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`${method} answered ${res.status}`);
  const text = await res.text();
  const line = text.split('\n').map((l) => l.replace(/^data: /, '')).find((l) => l.trim().startsWith('{'));
  return JSON.parse(line || text).result;
}
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await rpc('tools/call', { name, arguments: args });
  return JSON.parse(r.content[0].text);
};

const tools = await rpc('tools/list');
console.log(`Tools: ${tools.tools.map((t: { name: string }) => t.name).join(', ')}\n`);

const q = await call('quote', { from: 'NEAR', to: 'USDT', amount: '1' });
console.log(`A swap inside the vault, priced by NEAR Intents' solvers: ${q.rate}, at least ${q.atLeast}. ${q.note}\n`);

const earn = await call('earn');
console.log('Earn, with yearly rates today:');
for (const p of earn.products) console.log(`  ${p.name} by ${p.by}: ${p.apyPercent}% (${p.wallet})`);

const net = await call('network_status');
console.log(`\nNetworks: ${net.summary}`);
