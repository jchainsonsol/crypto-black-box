const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = globalThis.__blackBoxEvmCache || new Map();
globalThis.__blackBoxEvmCache = cache;

const CHAINS = {
  ethereum: { name: 'Ethereum', rpcs: ['https://ethereum-rpc.publicnode.com','https://eth.drpc.org'] },
  base: { name: 'Base', rpcs: ['https://base-rpc.publicnode.com','https://base.drpc.org'] },
  bsc: { name: 'BNB Chain', rpcs: ['https://bsc-rpc.publicnode.com','https://bsc.drpc.org'] },
  arbitrum: { name: 'Arbitrum', rpcs: ['https://arbitrum-one-rpc.publicnode.com','https://arbitrum.drpc.org'] },
  polygon: { name: 'Polygon', rpcs: ['https://polygon-bor-rpc.publicnode.com','https://polygon.drpc.org'] },
  avalanche: { name: 'Avalanche', rpcs: ['https://avalanche-c-chain-rpc.publicnode.com','https://avalanche.drpc.org'] },
  optimism: { name: 'Optimism', rpcs: ['https://optimism-rpc.publicnode.com','https://optimism.drpc.org'] },
  linea: { name: 'Linea', rpcs: ['https://linea-rpc.publicnode.com','https://linea.drpc.org'] },
  scroll: { name: 'Scroll', rpcs: ['https://scroll-rpc.publicnode.com','https://scroll.drpc.org'] }
};

const ZERO = '0x0000000000000000000000000000000000000000';
const OWNER_SELECTOR = '0x8da5cb5b';
const TOTAL_SUPPLY_SELECTOR = '0x18160ddd';
const DECIMALS_SELECTOR = '0x313ce567';
const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e019a1a4c8a3f5a5f32c6f1f8f2f6f2f0';

async function rpc(endpoint, method, params) {
  const r = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(7000)
  });
  if (!r.ok) throw new Error(`RPC HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'RPC error');
  return j.result;
}

async function withFailover(chain, method, params) {
  const failures = [];
  for (const endpoint of chain.rpcs) {
    try { return { endpoint, result: await rpc(endpoint, method, params), failures }; }
    catch (e) { failures.push({ endpoint, error: e.message }); }
  }
  const err = new Error(`All ${chain.name} public RPC endpoints failed`);
  err.failures = failures;
  throw err;
}

function wordAddress(hex) {
  if (!hex || hex === '0x' || /^0x0+$/.test(hex)) return null;
  const clean = hex.replace(/^0x/,'').padStart(64,'0');
  return '0x' + clean.slice(-40);
}

function hexInt(hex) {
  if (!hex || hex === '0x') return null;
  try { return BigInt(hex).toString(); } catch { return null; }
}

async function optionalCall(chain, address, data) {
  try { return (await withFailover(chain, 'eth_call', [{ to: address, data }, 'latest'])).result; }
  catch { return null; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const address = String(req.query.address || '').trim();
  const chainId = String(req.query.chain || '').trim().toLowerCase();
  const chain = CHAINS[chainId];
  if (!chain) return res.status(400).json({ error: `EVM contract intelligence is not configured for ${chainId || 'this chain'}` });
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) return res.status(400).json({ error: 'Invalid EVM contract address' });

  const key = `${chainId}:${address.toLowerCase()}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) return res.status(200).json(cached.data);

  try {
    const codeRead = await withFailover(chain, 'eth_getCode', [address, 'latest']);
    const code = codeRead.result || '0x';
    const isContract = code !== '0x' && code.length > 2;
    if (!isContract) return res.status(400).json({ error: 'Address has no deployed contract bytecode on this chain' });

    const [ownerHex, supplyHex, decimalsHex, implHex] = await Promise.all([
      optionalCall(chain, address, OWNER_SELECTOR),
      optionalCall(chain, address, TOTAL_SUPPLY_SELECTOR),
      optionalCall(chain, address, DECIMALS_SELECTOR),
      withFailover(chain, 'eth_getStorageAt', [address, IMPLEMENTATION_SLOT, 'latest']).then(x=>x.result).catch(()=>null)
    ]);

    const owner = wordAddress(ownerHex);
    const implementation = wordAddress(implHex);
    const ownerRenounced = owner ? owner.toLowerCase() === ZERO : null;
    const data = {
      available: true,
      family: 'evm',
      chainId,
      chainName: chain.name,
      address,
      isContract,
      bytecodeBytes: Math.max(0, (code.length - 2) / 2),
      owner,
      ownerRenounced,
      ownershipReadable: ownerHex != null,
      proxyDetected: Boolean(implementation),
      implementation,
      totalSupplyRaw: hexInt(supplyHex),
      decimals: decimalsHex ? Number(BigInt(decimalsHex)) : null,
      mintability: 'unknown',
      taxes: 'unknown',
      honeypot: 'unknown',
      note: 'Black Box can verify deployed code, readable ownership and common EIP-1967 proxy structure from public RPC. Mintability, transfer taxes and honeypot behavior require deeper bytecode/simulation analysis and are not guessed.',
      rpcEndpoint: new URL(codeRead.endpoint).hostname,
      fetchedAt: new Date().toISOString()
    };
    cache.set(key, { timestamp: Date.now(), data });
    return res.status(200).json(data);
  } catch (e) {
    return res.status(503).json({ error: `${chain.name} public RPC is temporarily unavailable`, detail: e.message });
  }
}
