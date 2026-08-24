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

function norm(v) { return String(v || '').toLowerCase(); }
function looksAddress(q) { return /^0x[a-fA-F0-9]{40}$/.test(q) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(q); }

function bestPair(pairs, query, preferredChain) {
  const q = norm(query).replace(/^\$/, '');
  let candidates = (pairs || []).filter(Boolean);
  if (preferredChain) candidates = candidates.filter(p => norm(p.chainId) === norm(preferredChain));
  candidates.sort((a, b) => {
    const aExact = [a.baseToken?.address, a.quoteToken?.address, a.baseToken?.symbol, a.baseToken?.name].some(x => norm(x) === q) ? 1 : 0;
    const bExact = [b.baseToken?.address, b.quoteToken?.address, b.baseToken?.symbol, b.baseToken?.name].some(x => norm(x) === q) ? 1 : 0;
    if (bExact !== aExact) return bExact - aExact;
    return Number(b?.liquidity?.usd || 0) - Number(a?.liquidity?.usd || 0);
  });
  return candidates[0] || null;
}

async function dexScreener(query, preferredChain) {
  const failures = [];

  // Contract/mint addresses should use DexScreener's direct token endpoint first.
  // It is chain-agnostic and materially more reliable than free-text search for fresh tokens.
  if (looksAddress(query)) {
    try {
      const direct = await getJson(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(query)}`);
      const directPair = bestPair(direct?.pairs || [], query, preferredChain);
      if (directPair) return { pair: directPair, resolver: 'direct-token' };
    } catch (e) { failures.push(`direct:${e.message}`); }
  }

  try {
    const search = await getJson(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`);
    const searchPair = bestPair(search?.pairs || [], query, preferredChain);
    if (searchPair) return { pair: searchPair, resolver: 'search' };
  } catch (e) { failures.push(`search:${e.message}`); }

  return { pair: null, resolver: null, failures };
}

const GECKO_NETWORK = {
  solana: 'solana', ethereum: 'eth', base: 'base', bsc: 'bsc', arbitrum: 'arbitrum',
  polygon: 'polygon_pos', avalanche: 'avax', optimism: 'optimism', linea: 'linea',
  fantom: 'ftm', celo: 'celo', blast: 'blast', scroll: 'scroll'
};

async function geckoChart(chainId, pairAddress) {
  const network = GECKO_NETWORK[norm(chainId)];
  if (!network || !pairAddress) return [];
  try {
    const url = `https://api.geckoterminal.com/api/v2/networks/${encodeURIComponent(network)}/pools/${encodeURIComponent(pairAddress)}/ohlcv/minute?aggregate=15&limit=96&currency=usd&token=base`;
    const json = await getJson(url, { accept: 'application/json;version=20230203' });
    const rows = json?.data?.attributes?.ohlcv_list || [];
    return rows.map(row => ({
      time: Number(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5])
    })).reverse();
  } catch (_) { return []; }
}

function tokenSide(pair, query) {
  if (!pair) return null;
  const q = norm(query);
  if (norm(pair.baseToken?.address) === q) return pair.baseToken;
  if (norm(pair.quoteToken?.address) === q) return pair.quoteToken;
  return pair.baseToken || null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const query = String(req.query.q || req.query.address || req.query.mint || '').trim();
  const preferredChain = String(req.query.chain || '').trim();
  if (!query || query.length < 2) return res.status(400).json({ error: 'Enter a token address, ticker, name, or pair.' });

  const key = `${preferredChain}:${query}`.toLowerCase();
  const cached = cache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    return res.status(200).json(cached.data);
  }

  try {
    const resolved = await dexScreener(query, preferredChain);
    const pair = resolved.pair;
    if (!pair) return res.status(200).json({ available: false, query, chart: [], resolverFailures: resolved.failures || [] });

    const token = tokenSide(pair, query);
    const tokenAddress = token?.address || pair.baseToken?.address || query;
    const chart = await geckoChart(pair.chainId, pair.pairAddress);
    const tx5m = pair.txns?.m5 || {}, tx1h = pair.txns?.h1 || {}, tx24h = pair.txns?.h24 || {};
    const data = {
      available: true,
      query,
      chainId: pair.chainId || null,
      tokenAddress,
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
      volume5m: Number(pair.volume?.m5 || 0), volume1h: Number(pair.volume?.h1 || 0), volume6h: Number(pair.volume?.h6 || 0), volume24h: Number(pair.volume?.h24 || 0),
      priceChange5m: Number(pair.priceChange?.m5 || 0), priceChange1h: Number(pair.priceChange?.h1 || 0), priceChange6h: Number(pair.priceChange?.h6 || 0), priceChange24h: Number(pair.priceChange?.h24 || 0),
      buys5m: Number(tx5m.buys || 0), sells5m: Number(tx5m.sells || 0), buys1h: Number(tx1h.buys || 0), sells1h: Number(tx1h.sells || 0), buys24h: Number(tx24h.buys || 0), sells24h: Number(tx24h.sells || 0),
      pairCreatedAt: pair.pairCreatedAt || null,
      chart,
      chartSource: chart.length ? 'geckoterminal' : 'momentum-fallback',
      resolver: resolved.resolver,
      source: 'multi-chain-market-enrichment'
    };
    cache.set(key, { timestamp: Date.now(), data });
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    return res.status(200).json(data);
  } catch (error) {
    return res.status(200).json({ available: false, query, chart: [], error: 'Market enrichment temporarily unavailable', detail: error.message });
  }
}
