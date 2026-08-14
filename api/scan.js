const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = globalThis.__blackBoxScanCache || new Map();
globalThis.__blackBoxScanCache = cache;

// No accounts, API keys, or paid RPC dependencies. Black Box rotates through
// public Solana mainnet RPC endpoints and fails over automatically.
const PUBLIC_RPC_POOL = [
  'https://api.mainnet.solana.com',
  'https://api.mainnet-beta.solana.com',
  'https://rpc.ankr.com/solana'
];

function rpcPool() {
  const custom = String(process.env.PUBLIC_SOLANA_RPC_POOL || '')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);
  return custom.length ? custom : PUBLIC_RPC_POOL;
}

function timeoutSignal(ms = 9000) {
  return AbortSignal.timeout(ms);
}

async function postRpc(endpoint, body) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'accept': 'application/json',
      'user-agent': 'CryptoBlackBox/0.1'
    },
    body: JSON.stringify(body),
    signal: timeoutSignal()
  });

  if (!response.ok) {
    const error = new Error(`RPC HTTP ${response.status}`);
    error.status = response.status;
    error.retryAfter = response.headers.get('retry-after');
    throw error;
  }

  return response.json();
}

async function batchRpc(endpoint, calls) {
  const body = calls.map((call, index) => ({
    jsonrpc: '2.0',
    id: index + 1,
    method: call.method,
    params: call.params
  }));

  const json = await postRpc(endpoint, body);
  if (!Array.isArray(json)) throw new Error('RPC rejected batch request');

  const byId = new Map(json.map(item => [Number(item.id), item]));
  return calls.map((_, index) => {
    const item = byId.get(index + 1);
    if (!item) throw new Error('RPC omitted a batch response');
    if (item.error) throw new Error(item.error.message || 'Solana RPC error');
    return item.result;
  });
}

async function singleRpc(endpoint, method, params) {
  const json = await postRpc(endpoint, {
    jsonrpc: '2.0', id: 1, method, params
  });
  if (json.error) throw new Error(json.error.message || 'Solana RPC error');
  return json.result;
}

async function coreScanFromEndpoint(endpoint, mint) {
  const calls = [
    { method: 'getAccountInfo', params: [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }] },
    { method: 'getTokenSupply', params: [mint, { commitment: 'confirmed' }] },
    { method: 'getTokenLargestAccounts', params: [mint, { commitment: 'confirmed' }] }
  ];

  // Prefer one HTTP request. If an endpoint does not support JSON-RPC batches,
  // fall back to the three calls sequentially on that same endpoint.
  try {
    return await batchRpc(endpoint, calls);
  } catch (batchError) {
    if ([403, 429, 500, 502, 503, 504].includes(batchError.status)) throw batchError;
    const results = [];
    for (const call of calls) {
      results.push(await singleRpc(endpoint, call.method, call.params));
    }
    return results;
  }
}

async function scanWithFailover(mint) {
  const failures = [];

  for (const endpoint of rpcPool()) {
    try {
      const [account, supply, largest] = await coreScanFromEndpoint(endpoint, mint);
      return { endpoint, account, supply, largest, failures };
    } catch (error) {
      failures.push({ endpoint, error: error.message, status: error.status || null });
      // 403/429/5xx/timeouts are endpoint-level failures. Immediately try next.
      continue;
    }
  }

  const error = new Error('All public Solana RPC endpoints are temporarily unavailable');
  error.failures = failures;
  throw error;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const mint = String(req.query.mint || '').trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
    return res.status(400).json({ error: 'Invalid Solana mint address' });
  }

  const cached = cache.get(mint);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=1800');
    res.setHeader('X-Black-Box-Cache', 'HIT');
    return res.status(200).json(cached.data);
  }

  try {
    const { endpoint, account, supply, largest, failures } = await scanWithFailover(mint);
    const parsed = account?.value?.data?.parsed;

    if (!parsed || parsed.type !== 'mint') {
      return res.status(400).json({ error: 'Address is not a parsed SPL token mint' });
    }

    const rows = largest?.value || [];
    let owners = rows.map(() => null);

    // Owner resolution is useful but optional. Never fail the whole scan because
    // a second RPC request was rate-limited.
    if (rows.length) {
      try {
        const multi = await singleRpc(endpoint, 'getMultipleAccounts', [
          rows.map(x => x.address),
          { encoding: 'jsonParsed', commitment: 'confirmed' }
        ]);
        owners = (multi?.value || []).map(v => v?.data?.parsed?.info?.owner || null);
      } catch (_) {}
    }

    const data = {
      mint,
      mintInfo: parsed.info,
      programOwner: account.value.owner,
      supply: supply.value,
      largestAccounts: rows.map((x, i) => ({ ...x, owner: owners[i] || null })),
      source: 'public-solana-rpc-failover',
      rpcEndpoint: new URL(endpoint).hostname,
      failoversUsed: failures.length,
      fetchedAt: new Date().toISOString()
    };

    cache.set(mint, { timestamp: Date.now(), data });
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=1800');
    res.setHeader('X-Black-Box-Cache', 'MISS');
    return res.status(200).json(data);
  } catch (error) {
    console.error('scan failed', error, error.failures || []);
    return res.status(503).json({
      error: 'Solana public RPC network is temporarily busy',
      detail: 'Black Box tried every configured public endpoint. Please retry shortly.',
      attempts: error.failures?.length || rpcPool().length
    });
  }
}
