const CACHE_TTL_MS = 60 * 1000;
const cache = globalThis.__blackBoxMarketCache || new Map();
globalThis.__blackBoxMarketCache = cache;

async function getJson(url, headers = {}) {
  const response = await fetch(url, {
    headers: { accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(7000)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function bestPair(pairs, mint) {
  const solana = (pairs || []).filter(p => p?.chainId === 'solana');
  const tokenPairs = solana.filter(p =>
    p?.baseToken?.address === mint || p?.quoteToken?.address === mint
  );
  return tokenPairs.sort((a, b) =>
    Number(b?.liquidity?.usd || 0) - Number(a?.liquidity?.usd || 0)
  )[0] || null;
}

async function dexScreener(mint) {
  const pairs = await getJson(`https://api.dexscreener.com/token-pairs/v1/solana/${encodeURIComponent(mint)}`);
  return bestPair(pairs, mint);
}

async function geckoChart(pairAddress) {
  if (!pairAddress) return [];
  try {
    const url = `https://api.geckoterminal.com/api/v2/networks/solana/pools/${encodeURIComponent(pairAddress)}/ohlcv/minute?aggregate=15&limit=96&currency=usd&token=base`;
    const json = await getJson(url, { 'accept': 'application/json;version=20230203' });
    const rows = json?.data?.attributes?.ohlcv_list || [];
    return rows.map(row => ({
      time: Number(row[0]),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5])
    })).reverse();
  } catch (_) {
    return [];
  }
}

function tokenSide(pair, mint) {
  if (!pair) return null;
  if (pair.baseToken?.address === mint) return pair.baseToken;
  if (pair.quoteToken?.address === mint) return pair.quoteToken;
  return pair.baseToken || null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const mint = String(req.query.mint || '').trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
    return res.status(400).json({ error: 'Invalid Solana mint address' });
  }

  const cached = cache.get(mint);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    return res.status(200).json(cached.data);
  }

  try {
    const pair = await dexScreener(mint);
    if (!pair) {
      return res.status(200).json({ available: false, mint, chart: [] });
    }

    const token = tokenSide(pair, mint);
    const chart = await geckoChart(pair.pairAddress);
    const tx5m = pair.txns?.m5 || {};
    const tx1h = pair.txns?.h1 || {};
    const tx24h = pair.txns?.h24 || {};

    const data = {
      available: true,
      mint,
      name: token?.name || null,
      symbol: token?.symbol || null,
      imageUrl: pair.info?.imageUrl || null,
      websites: pair.info?.websites || [],
      socials: pair.info?.socials || [],
      dex: pair.dexId || null,
      pairAddress: pair.pairAddress || null,
      pairUrl: pair.url || null,
      quoteSymbol: pair.quoteToken?.symbol || null,
      priceUsd: pair.priceUsd ? Number(pair.priceUsd) : null,
      priceNative: pair.priceNative ? Number(pair.priceNative) : null,
      marketCap: Number(pair.marketCap || 0) || null,
      fdv: Number(pair.fdv || 0) || null,
      liquidityUsd: Number(pair.liquidity?.usd || 0) || null,
      volume5m: Number(pair.volume?.m5 || 0),
      volume1h: Number(pair.volume?.h1 || 0),
      volume6h: Number(pair.volume?.h6 || 0),
      volume24h: Number(pair.volume?.h24 || 0),
      priceChange5m: Number(pair.priceChange?.m5 || 0),
      priceChange1h: Number(pair.priceChange?.h1 || 0),
      priceChange6h: Number(pair.priceChange?.h6 || 0),
      priceChange24h: Number(pair.priceChange?.h24 || 0),
      buys5m: Number(tx5m.buys || 0),
      sells5m: Number(tx5m.sells || 0),
      buys1h: Number(tx1h.buys || 0),
      sells1h: Number(tx1h.sells || 0),
      buys24h: Number(tx24h.buys || 0),
      sells24h: Number(tx24h.sells || 0),
      pairCreatedAt: pair.pairCreatedAt || null,
      chart,
      chartSource: chart.length ? 'geckoterminal' : 'momentum-fallback',
      source: 'market-enrichment'
    };

    cache.set(mint, { timestamp: Date.now(), data });
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    return res.status(200).json(data);
  } catch (error) {
    return res.status(200).json({
      available: false,
      mint,
      chart: [],
      error: 'Market enrichment temporarily unavailable'
    });
  }
}
