/**
 * The kit as a Model Context Protocol server over stdio.
 *
 * Newline-delimited JSON-RPC 2.0 on stdin and stdout, nothing else on stdout
 * (logs go to stderr, or the client reads them as protocol and hangs up). The
 * tools are the same ones the command line runs, so an agent that learned one
 * door already knows the other.
 */
import { createInterface } from 'node:readline';
import { KIT_VERSION } from './client';
import type { Tool } from './tools';

const KNOWN_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

type Rpc = { jsonrpc: '2.0'; id?: number | string | null; method?: string; params?: any };

export async function serveMcp(tools: Tool[], opts: { instructions: string; onIdle?: () => Promise<void> }) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + '\n');
  const reply = (id: Rpc['id'], result: unknown) => send({ jsonrpc: '2.0', id, result });
  const fail = (id: Rpc['id'], code: number, message: string) => send({ jsonrpc: '2.0', id, error: { code, message } });

  /* Whatever can move money takes its turn, one at a time, so each sees what the last one left, and an owner's
     instruction never runs beside a move. */
  let turn: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = turn.then(fn, fn);
    turn = p.catch(() => undefined);
    return p;
  };

  /* Owner instructions (a recall, a pause) must reach a kit that sits idle
     between tool calls, so a live server checks in on its own. */
  let idle: ReturnType<typeof setInterval> | null = null;
  if (opts.onIdle) {
    const tick = () => inTurn(opts.onIdle!).catch((e) => process.stderr.write(`[ghosterdex] ${e?.message || e}\n`));
    idle = setInterval(tick, 60_000);
    setTimeout(tick, 3_000);
  }

  const handle = async (msg: Rpc) => {
    const { id, method, params } = msg;
    if (!method) return;
    const isRequest = id !== undefined && id !== null;
    try {
      switch (method) {
        case 'initialize': {
          const asked = String(params?.protocolVersion || '');
          reply(id, {
            protocolVersion: KNOWN_VERSIONS.includes(asked) ? asked : KNOWN_VERSIONS[1],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'ghosterdex', title: 'GhosterDex', version: KIT_VERSION },
            instructions: opts.instructions,
          });
          return;
        }
        case 'notifications/initialized':
        case 'notifications/cancelled':
          return;
        case 'ping':
          if (isRequest) reply(id, {});
          return;
        case 'tools/list':
          reply(id, {
            tools: tools.map((t) => ({
              name: t.name,
              title: t.title,
              description: t.description,
              inputSchema: t.input,
              annotations: { readOnlyHint: !!t.readOnly, destructiveHint: !t.readOnly && (!!t.movesMoney || !!t.givesPower), openWorldHint: true },
            })),
          });
          return;
        case 'tools/call': {
          const tool = byName.get(String(params?.name));
          if (!tool) {
            fail(id, -32602, `Unknown tool: ${params?.name}`);
            return;
          }
          try {
            const run = () => tool.run(params?.arguments || {});
            /* anything but a read may carry out an owner's instruction first, so it waits its turn with the moves */
            const out = await (tool.readOnly ? run() : inTurn(run));
            reply(id, {
              content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
              structuredContent: out && typeof out === 'object' && !Array.isArray(out) ? out : { result: out },
            });
          } catch (e: any) {
            const err = {
              error: e?.message || String(e),
              ...(e?.code ? { code: e.code } : {}),
              ...(e?.hint ? { hint: e.hint } : {}),
              ...(e?.data ? { data: e.data } : {}),
            };
            reply(id, { content: [{ type: 'text', text: JSON.stringify(err) }], isError: true });
          }
          return;
        }
        default:
          if (isRequest) fail(id, -32601, `Method not found: ${method}`);
      }
    } catch (e: any) {
      if (isRequest) fail(id, -32603, e?.message || String(e));
    }
  };

  /* Calls still running when the client hangs up get to finish and answer:
     exiting on close would cut a signed move off before it reports. */
  const inflight = new Set<Promise<void>>();
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const s = line.trim();
    if (!s) return;
    let msg: Rpc | Rpc[];
    try {
      msg = JSON.parse(s);
    } catch {
      fail(null, -32700, 'Parse error');
      return;
    }
    for (const m of Array.isArray(msg) ? msg : [msg]) {
      const p = handle(m).finally(() => inflight.delete(p));
      inflight.add(p);
    }
  });
  rl.on('close', async () => {
    if (idle) clearInterval(idle);
    while (inflight.size) await Promise.allSettled([...inflight]);
    process.exit(0);
  });
}
