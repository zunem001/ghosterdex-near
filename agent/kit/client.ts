/**
 * Talking to GhosterDex as the agent's own wallet.
 *
 * Every request carries the same identity headers the app sends, and a
 * signed-in session from a ton_proof the agent's key made. A session lasts
 * thirty days; the kit renews it quietly when it is close to running out or
 * when the server says it is gone, so an agent never has to think about it.
 */
import { tonProof } from './sign';
import { keysOf, saveKeystore, type Keystore } from './wallet';

export const KIT_VERSION = '1.7.0';
const RENEW_BEFORE_S = 2 * 24 * 3600;

export class ApiError extends Error {
  status: number;
  body: any;
  constructor(message: string, status: number, body: any) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export class Client {
  ks: Keystore;
  constructor(ks: Keystore) {
    this.ks = ks;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = {
      'content-type': 'application/json',
      'user-agent': `GhosterDexAgent/${KIT_VERSION} (+https://ghosterdex.com/agent.md)`,
      'x-ghoster-uid': this.ks.uid,
      'x-ghoster-mode': 'live',
      'x-ghoster-wallet': this.ks.address,
      'x-ghoster-agent': KIT_VERSION,
    };
    if (this.ks.session?.token) h['x-ghoster-tonauth'] = this.ks.session.token;
    /* a local worker (wrangler dev) redirects plain HTTP unless told the edge saw https */
    if (this.ks.server.startsWith('http://')) h['cf-visitor'] = '{"scheme":"https"}';
    return { ...h, ...extra };
  }

  /** A bare call. Throws ApiError with the server's own words on refusal. */
  async raw<T = any>(path: string, init: { method?: string; body?: unknown; auth?: boolean } = {}): Promise<T> {
    const send = () =>
      fetch(this.ks.server + path, {
        method: init.method || (init.body === undefined ? 'GET' : 'POST'),
        headers: this.headers(),
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(60_000),
      });
    /* One retry for a connection that dropped before any answer: a long-lived
       MCP server reuses sockets the far end has already closed. Repeating is
       safe on every route here: a quote is only a quote, and a signed intent
       or a Gram message sent twice is refused the second time by its nonce. */
    let res: Response;
    try {
      res = await send();
    } catch (e: any) {
      if (e?.name === 'TimeoutError') throw new Error('GhosterDex did not answer in time. Try again.');
      await new Promise((r) => setTimeout(r, 400));
      res = await send();
    }
    const text = await res.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { error: text.slice(0, 300) };
    }
    if (!res.ok) {
      const msg = (body && (body.error || body.message)) || `GhosterDex answered ${res.status}`;
      throw new ApiError(String(msg), res.status, body);
    }
    return body as T;
  }

  /** A signed-in call: renews the session first when it is missing or old. */
  async call<T = any>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    await this.ensureSession();
    try {
      return await this.raw<T>(path, init);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || /session|sign in|verify your wallet/i.test(e.message))) {
        await this.login();
        return await this.raw<T>(path, init);
      }
      throw e;
    }
  }

  async ensureSession(): Promise<void> {
    const s = this.ks.session;
    const now = Math.floor(Date.now() / 1000);
    if (s?.token && s.exp - now > RENEW_BEFORE_S) return;
    await this.login();
  }

  /** challenge, ton_proof, verify: the same dance the phone does at start. */
  async login(): Promise<void> {
    const keys = await keysOf(this.ks);
    const ch = await this.raw<{ payload: string }>('/api/tonproof/challenge');
    if (!ch?.payload) throw new Error('GhosterDex did not issue a sign-in challenge.');
    const proof = tonProof(keys, this.ks.address, ch.payload);
    const v = await this.raw<{ token?: string; error?: string }>('/api/tonproof/verify', {
      body: { address: this.ks.address, publicKey: this.ks.publicKey, proof },
    });
    if (!v?.token) throw new Error(v?.error || 'GhosterDex refused the sign-in.');
    const exp = Number(String(v.token).split('.')[1]) || Math.floor(Date.now() / 1000) + 29 * 24 * 3600;
    this.ks.session = { token: v.token, exp };
    saveKeystore(this.ks);
  }
}
