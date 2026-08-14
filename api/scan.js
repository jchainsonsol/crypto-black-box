const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = globalThis.__blackBoxScanCache || new Map();
globalThis.__blackBoxScanCache = cache;

const PUBLIC_RPC_POOL = [
  'https://solana-rpc.publicnode.com',
  'https://solana.drpc.org',
  'https://api.mainnet.solana.com',
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

async function postRpc(endpoint, method, params) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: timeoutSignal()
  });

  if (!response.ok) {
    const error = new Error(`RPC HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }

  const json = await response.json();
  if (json?.error) {
    const error = new Error(json.error.message || 'Solana RPC error');
    error.rpcCode = json.error.code;
    throw error;
  }
  return json?.result;
}

async function firstWorking(method, params) {
  const failures = [];
  for (const endpoint of rpcPool()) {
    try {
      const result = await postRpc(endpoint, method, params);
      return { endpoint, result, failures };
    } catch (error) {
      failures.push({ endpoint, status: error.status || null, error: error.message });
    }
  }
  const error = new Error(`All public RPC endpoints failed for ${method}`);
  error.failures = failures;
  throw error;
}

async function optionalLargestAccounts(mint, preferredEndpoint) {
  const endpoints = [preferredEndpoint, ...rpcPool().filter(x => x !== preferredEndpoint)];
  const failures = [];

  for (const endpoint of endpoints) {
    try {
      const result = await postRpc(endpoint, 'getTokenLargestAccounts', [
        mint,
        { commitment: 'confirmed' }
      ]);
      return { endpoint, rows: result?.value || [], failures };
    } catch (error) {
      failures.push({ endpoint, status: error.status || null, error: error.message });
    }
  }

  return { endpoint: null, rows: [], failures };
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
    // These two calls are the minimum viable chain scan and are broadly supported.
    const accountRead = await firstWorking('getAccountInfo', [
      mint,
      { encoding: 'jsonParsed', commitment: 'confirmed' }
    ]);

    const parsed = accountRead.result?.value?.data?.parsed;
    if (!parsed || parsed.type !== 'mint') {
      return res.status(400).json({ error: 'Address is not a parsed SPL token mint' });
    }

    const supplyRead = await firstWorking('getTokenSupply', [
      mint,
      { commitment: 'confirmed' }
    ]);

    // Largest-account RPC is commonly disabled or heavily throttled on free public
    // gateways. Treat it as enrichment, never as a reason to fail the whole scan.
    const largestRead = await optionalLargestAccounts(mint, accountRead.endpoint);
    const rows = largestRead.rows;
    let owners = rows.map(() => null);

    if (rows.length && largestRead.endpoint) {
      try {
        const multi = await postRpc(largestRead.endpoint, 'getMultipleAccounts', [
          rows.map(x => x.address),
          { encoding: 'jsonParsed', commitment: 'confirmed' }
        ]);
        owners = (multi?.value || []).map(v => v?.data?.parsed?.info?.owner || null);
      } catch (_) {}
    }

    const data = {
      mint,
      mintInfo: parsed.info,
      programOwner: accountRead.result.value.owner,
      supply: supplyRead.result.value,
      largestAccounts: rows.map((x, i) => ({ ...x, owner: owners[i] || null })),
      holderAnalysisAvailable: rows.length > 0,
      holderAnalysisNote: rows.length
        ? null
        : 'Largest-account data is unavailable from the current public RPC pool; core mint checks still completed.',
      source: 'public-solana-rpc-failover',
      coreRpcEndpoint: new URL(accountRead.endpoint).hostname,
      holderRpcEndpoint: largestRead.endpoint ? new URL(largestRead.endpoint).hostname : null,
      fetchedAt: new Date().toISOString()
    };

    cache.set(mint, { timestamp: Date.now(), data });
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=1800');
    res.setHeader('X-Black-Box-Cache', 'MISS');
    return res.status(200).json(data);
  } catch (error) {
    console.error('core scan failed', error.failures || error);
    return res.status(503).json({
      error: 'Black Box could not reach Solana for the core token scan',
      detail: 'The public RPC pool could not complete the basic mint read. Retry shortly.',
      attempts: error.failures?.length || rpcPool().length
    });
  }
}
