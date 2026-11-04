/**
 * VERBATIM EXCERPT, to read. This is not a module of the running service.
 * It comes from the GhosterDex worker, worker/index.ts, which is closed source:
 * baseline code, unchanged in the window. It shows how a wallet's own signature moves a NEAR Intents balance. Taken at 42c9a8a.
 */
function classifyRoute(depositType: string, recipientType: string): RouteKind | null {
  if (depositType === 'ORIGIN_CHAIN' && recipientType === 'CONFIDENTIAL_INTENTS') return 'deposit';
  if (depositType === 'CONFIDENTIAL_INTENTS' && recipientType === 'CONFIDENTIAL_INTENTS') return 'swap';
  if (depositType === 'CONFIDENTIAL_INTENTS' && recipientType === 'DESTINATION_CHAIN') return 'withdraw';
  return null;
}

function routeConfidentiality(reply: unknown, asked: string): string {
  const said = (reply as { quoteRequest?: { confidentiality?: unknown } } | null)?.quoteRequest?.confidentiality;
  return typeof said === 'string' && said ? said : asked;
}

async function signTextFor(env: Env, depositAddress: string, signerId: string): Promise<string> {
  let lastErr: any;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const gen = await oneClick(env, '/generate-intent', {
        method: 'POST',
        body: JSON.stringify({ type: 'swap_transfer', depositAddress, signerId, standard: 'ton_connect' }),
      });
      const text = gen?.intent?.payload?.text ?? gen?.payload?.text;
      if (typeof text === 'string') return text;
    } catch (e: any) {
      lastErr = e;
      if (!e?.infra) throw e;
      await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
    }
  }
  throw lastErr || new Error('The payment network is briefly unavailable. Please try again in a moment.');
}

async function submitIntent(
  env: Env,
  signedData: Record<string, unknown>,
  signer: { by: 'owner-wallet'; verified: boolean } | { by: 'app-fulfilment-account' },
): Promise<unknown> {
  if (signer.by === 'owner-wallet' && !signer.verified) {
    // Unreachable by design; a throw is the point. Never downgrade this to a
    // log-and-continue: silently submitting would be the exact failure the
    // whole design exists to prevent.
    throw new Error('Refusing to move a user balance without that user\'s wallet signature.');
  }
  return oneClick(env, '/submit-intent', {
    method: 'POST',
    body: JSON.stringify({ type: 'swap_transfer', signedData }),
  });
}

function tonConnectSignedData(
  account: string,
  sig: WalletSigBody,
  payloadText: string,
): Record<string, unknown> {
  return {
    standard: 'ton_connect',
    // Raw form always, wallet apps may report the user-friendly (UQ…/EQ…)
    // form, but the verifier reconstructs the signed envelope from wc+hash.
    address: rawTonAddress(sig.address) || sig.address,
    domain: sig.domain || '',
    timestamp: new Date((sig.timestamp || 0) * 1000).toISOString(),
    payload: { type: 'text', text: payloadText },
    public_key: `ed25519:${bs58.encode(hexBytes(account))}`,
    signature: `ed25519:${bs58.encode(b64decode(sig.signature))}`,
  };
}
