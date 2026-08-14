const CACHE_TTL_MS = 30_000;
const cache = globalThis.__blackBoxScanCache || new Map();
globalThis.__blackBoxScanCache = cache;

function getRpcEndpoint() {
  const endpoint = process.env.BLACKBOX_RPC_URL || process.env.SOLANA_RPC_URL;
  if (!endpoint) {
    const error = new Error('Black Box RPC node is not configured');
    error.code = 'RPC_NOT_CONFIGURED';
    throw error;
  }
  return endpoint;
}

async function rpcBatch(endpoint, calls) {
  const body = calls.map((call, index) => ({
    jsonrpc: '2.0',
    id: index + 1,
    method: call.method,
    params: call.params
  }));

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(12_000)
  });

  if (!response.ok) throw new Error(`Black Box RPC HTTP ${response.status}`);
  const json = await response.json();
  if (!Array.isArray(json)) throw new Error('Black Box RPC returned an invalid batch response');

  const byId = new Map(json.map(item => [item.id, item]));
  return calls.map((_, index) => {
    const item = byId.get(index + 1);
    if (!item) throw new Error('Black Box RPC omitted a response');
    if (item.error) throw new Error(item.error.message || 'Black Box RPC error');
    return item.result;
  });
}

async function rpc(endpoint, method, params) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(12_000)
  });
  if (!response.ok) throw new Error(`Black Box RPC HTTP ${response.status}`);
  const json = await response.json();
  if (json.error) throw new Error(json.error.message || 'Black Box RPC error');
  return json.result;
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
    res.setHeader('X-Black-Box-Cache', 'HIT');
    return res.status(200).json(cached.data);
  }

  let endpoint;
  try {
    endpoint = getRpcEndpoint();
  } catch (error) {
    return res.status(503).json({
      error: 'Black Box chain node offline',
      detail: 'The application is configured to use only Black Box-owned RPC infrastructure. Connect BLACKBOX_RPC_URL to the owned node.'
    });
  }

  try {
    const [account, supply, largest] = await rpcBatch(endpoint, [
      { method: 'getAccountInfo', params: [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }] },
      { method: 'getTokenSupply', params: [mint, { commitment: 'confirmed' }] },
      { method: 'getTokenLargestAccounts', params: [mint, { commitment: 'confirmed' }] }
    ]);

    const parsed = account?.value?.data?.parsed;
    if (!parsed || parsed.type !== 'mint') {
      return res.status(400).json({ error: 'Address is not a parsed SPL token mint' });
    }

    const rows = largest?.value || [];
    let owners = [];
    if (rows.length) {
      try {
        const multi = await rpc(endpoint, 'getMultipleAccounts', [
          rows.map(x => x.address),
          { encoding: 'jsonParsed', commitment: 'confirmed' }
        ]);
        owners = (multi?.value || []).map(v => v?.data?.parsed?.info?.owner || null);
      } catch (_) {
        owners = rows.map(() => null);
      }
    }

    const data = {
      mint,
      mintInfo: parsed.info,
      programOwner: account.value.owner,
      supply: supply.value,
      largestAccounts: rows.map((x, i) => ({ ...x, owner: owners[i] || null })),
      source: 'black-box-owned-rpc',
      fetchedAt: new Date().toISOString()
    };

    cache.set(mint, { timestamp: Date.now(), data });
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');
    res.setHeader('X-Black-Box-Cache', 'MISS');
    return res.status(200).json(data);
  } catch (error) {
    console.error('scan failed', error);
    return res.status(502).json({
      error: 'Black Box chain node unavailable',
      detail: error.message
    });
  }
}
