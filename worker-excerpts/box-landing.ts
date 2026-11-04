/**
 * VERBATIM EXCERPT, to read and to test (test/landing.test.ts). This is not a module of the running service.
 * It comes from the GhosterDex worker, worker/index.ts, which is closed source:
 * private commits 9e1c694 and 310bc7b, 2026-10-22.
 */
const BOX_USDT_ASSET = 'nep245:v2_1.omni.hot.tg:1117_3tsdfyziyc7EJbP2aULWSKU4toBaAcN4FdTgfm5W1mC4ouR';

const GRAM_ASSET = 'nep245:v2_1.omni.hot.tg:1117_';

const BOX_NEAR_USDT_ASSET = 'nep141:usdt.tether-token.near';

export const isBoxUsdt = (assetId: unknown) => assetId === BOX_USDT_ASSET || assetId === BOX_NEAR_USDT_ASSET;

export async function boxLanding(
  quote: (destinationAsset: string) => Promise<any>,
  usual: string = BOX_USDT_ASSET,
): Promise<{ landing: string; q: any; paused: boolean }> {
  try {
    return { landing: usual, q: await quote(usual), paused: false };
  } catch (e) {
    if (!(e as { paused?: boolean })?.paused) return { landing: usual, q: null, paused: false };
    return { landing: BOX_NEAR_USDT_ASSET, q: await quote(BOX_NEAR_USDT_ASSET).catch(() => null), paused: true };
  }
}
