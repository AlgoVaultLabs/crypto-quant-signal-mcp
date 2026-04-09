/**
 * OI Ranking — fetches top N Hyperliquid perps by notional open interest.
 * 1-hour in-memory cache to avoid hammering the HL API.
 */

const HL_INFO_URL = 'https://api.hyperliquid.xyz/info';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const TIMEOUT_MS = 5000;

interface OIAsset {
  coin: string;
  notionalOI: number;
  markPx: number;
  openInterest: number;
}

let cache: { assets: OIAsset[]; ts: number } | null = null;

export async function getTopAssetsByOI(limit: number = 50): Promise<OIAsset[]> {
  if (cache && Date.now() - cache.ts < CACHE_TTL_MS) {
    return cache.assets.slice(0, limit);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(HL_INFO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HL API ${res.status}`);

    const raw = (await res.json()) as [{ universe: { name: string }[] }, { openInterest: string; markPx: string }[]];
    const meta = raw[0];
    const ctxs = raw[1];

    const assets: OIAsset[] = meta.universe.map((a, i) => {
      const oi = parseFloat(ctxs[i].openInterest || '0');
      const px = parseFloat(ctxs[i].markPx || '0');
      return { coin: a.name, notionalOI: oi * px, markPx: px, openInterest: oi };
    });

    assets.sort((a, b) => b.notionalOI - a.notionalOI);
    cache = { assets, ts: Date.now() };
    return assets.slice(0, limit);
  } catch (err) {
    clearTimeout(timer);
    // Return stale cache if available
    if (cache) return cache.assets.slice(0, limit);
    throw err;
  }
}

export function getTopAssetNames(assets: OIAsset[]): string[] {
  return assets.map(a => a.coin);
}
