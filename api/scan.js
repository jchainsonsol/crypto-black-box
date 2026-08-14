const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = globalThis.__blackBoxScanCache || new Map();
globalThis.__blackBoxScanCache = cache;

// Keyless public Solana RPC endpoints. No paid account or API key required.
// Order matters: try community public gateways first, official public RPC last.
const PUBLIC_RPC_POOL = [
  'https://solana-rpc.publicnode.com',
  'https://solana.drpc.org',
  'https://api.mainnet-beta.solana.com'
];

function rpcPool() {
  const custom = String(process.env.PUBLIC_SOLANA_RPC_POOL || '')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);
  return custom.length ? custom : PUBLIC_RPC_POOL;
}

function timeoutSignal(ms = 7000) {
  return AbortSignal.timeout(ms);
}

async function postRpc(endpoint, body) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json'
    },
    body: JSON.stringify(body),
    signal: timeoutSignal()
  });

  if (!response.ok) {
    const error = new Error(`RPC HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }

  const json = await response.json();
  return json;
}

async function singleRpc(endpoint, method, params) {
  const json = await postRpc(endpoint, {
    jsonrpc: '2.0',
    id: 1,
    method,
    params
  });

  if (json?.error) throw new Error(json.error.message || 'Solana RPC error');
  return json?.result;
}

async function coreScanFromEndpoint(endpoint, mint) {
  // Use individual calls. Some public gateways reject JSON-RPC batch payloads
  // even though they support the same methods individually.
  const account = await singleRpc(endpoint, 'getAccountInfo', [
    mint,
    { encoding: 'jsonParsed', commitment: 'confirmed' }
  ]);

  const supply = await singleRpc(endpoint, 'getTokenSupply', [
    mint,
    { commitment: 'confirmed' }
  ]);

  const largest = await singleRpc(endpoint, 'getTokenLargestAccounts', [
    mint,
    { commitment: 'confirmed' }
  ]);

  return [account, supply, largest];
}

async function scanWithFailover(mint) {
  const failures = [];

  for (const endpoint of rpcPool()) {
    try {
      const [account, supply, largest] = await coreScanFromEndpoint(endpoint, mint);
      return { endpoint, account, supply, largest, failures };
    } catch (error) {
      failures.push({
        endpoint,
        status: error.status || null,
        error: error.message
      });
    }
  }

  const error = new Error('All configured public Solana RPC endpoints failed');
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

    // Owner lookup is optional; never fail the scan because of this extra request.
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
    console.error('scan failed', error.failures || error);
    return res.status(503).json({
      error: 'Black Box could not reach Solana right now',
      detail: 'All configured public RPC endpoints failed. Retry in a moment.',
      attempts: error.failures?.length || rpcPool().length
    });
  }
}
