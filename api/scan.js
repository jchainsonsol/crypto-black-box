const DEFAULT_RPC = 'https://api.mainnet-beta.solana.com';

async function rpc(endpoint, method, params) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params })
  });
  if (!response.ok) throw new Error(`Upstream RPC HTTP ${response.status}`);
  const json = await response.json();
  if (json.error) throw new Error(json.error.message || 'Solana RPC error');
  return json.result;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=30');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const mint = String(req.query.mint || '').trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return res.status(400).json({ error: 'Invalid Solana mint address' });

  const endpoint = process.env.SOLANA_RPC_URL || DEFAULT_RPC;
  try {
    const [account, supply, largest] = await Promise.all([
      rpc(endpoint, 'getAccountInfo', [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }]),
      rpc(endpoint, 'getTokenSupply', [mint, { commitment: 'confirmed' }]),
      rpc(endpoint, 'getTokenLargestAccounts', [mint, { commitment: 'confirmed' }])
    ]);
    const parsed = account?.value?.data?.parsed;
    if (!parsed || parsed.type !== 'mint') return res.status(400).json({ error: 'Address is not a parsed SPL token mint' });

    const rows = largest?.value || [];
    let owners = [];
    if (rows.length) {
      try {
        const multi = await rpc(endpoint, 'getMultipleAccounts', [rows.map(x => x.address), { encoding: 'jsonParsed', commitment: 'confirmed' }]);
        owners = (multi?.value || []).map(v => v?.data?.parsed?.info?.owner || null);
      } catch (_) { owners = rows.map(() => null); }
    }

    return res.status(200).json({
      mint,
      mintInfo: parsed.info,
      programOwner: account.value.owner,
      supply: supply.value,
      largestAccounts: rows.map((x, i) => ({ ...x, owner: owners[i] || null })),
      fetchedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('scan failed', error);
    return res.status(502).json({ error: 'Blockchain data provider failed', detail: error.message });
  }
}
