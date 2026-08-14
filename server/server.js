const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8787);
const RPC_URL = process.env.SOLANA_RPC_URL || 'http://127.0.0.1:8899';
const ROOT = path.resolve(__dirname, '..');

const types = {'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};

function send(res, code, body, type='application/json; charset=utf-8') {
  res.writeHead(code, {'Content-Type':type,'Cache-Control':'no-store'});
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function rpc(method, params=[]) {
  const response = await fetch(RPC_URL, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
  if (!response.ok) throw new Error(`Upstream RPC HTTP ${response.status}`);
  const data = await response.json();
  if (data.error) throw new Error(data.error.message || 'Solana RPC error');
  return data.result;
}

async function scanMint(mint) {
  const [accountInfo,supplyInfo,largestInfo] = await Promise.all([
    rpc('getAccountInfo',[mint,{encoding:'jsonParsed',commitment:'confirmed'}]),
    rpc('getTokenSupply',[mint,{commitment:'confirmed'}]),
    rpc('getTokenLargestAccounts',[mint,{commitment:'confirmed'}])
  ]);
  const parsed = accountInfo?.value?.data?.parsed;
  if (!parsed || parsed.type !== 'mint') throw new Error('Address is not a parsed SPL token mint');
  const rawSupply = BigInt(supplyInfo.value.amount);
  const holders = (largestInfo?.value || []).map((h,i)=>({rank:i+1,account:h.address,amount:Number(h.uiAmountString),percentage:rawSupply>0n?Number(BigInt(h.amount)*1000000n/rawSupply)/10000:0}));
  if (holders.length) {
    try {
      const multi = await rpc('getMultipleAccounts',[holders.map(h=>h.account),{encoding:'jsonParsed',commitment:'confirmed'}]);
      holders.forEach((h,i)=>h.owner=multi?.value?.[i]?.data?.parsed?.info?.owner || null);
    } catch { holders.forEach(h=>h.owner=null); }
  }
  return {mint,info:parsed.info,supply:Number(supplyInfo.value.uiAmountString),holders,rpc:RPC_URL};
}

const server = http.createServer(async (req,res)=>{
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/api/health') {
      try { const version = await rpc('getVersion'); return send(res,200,{ok:true,rpc:RPC_URL,solana:version}); }
      catch(e) { return send(res,503,{ok:false,rpc:RPC_URL,error:e.message}); }
    }
    if (url.pathname.startsWith('/api/scan/')) {
      const mint = decodeURIComponent(url.pathname.slice('/api/scan/'.length)).trim();
      if (mint.length < 32 || mint.length > 50) return send(res,400,{error:'Invalid Solana mint address'});
      try { return send(res,200,await scanMint(mint)); }
      catch(e) { return send(res,502,{error:e.message}); }
    }
    let requested = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.normalize(path.join(ROOT, requested));
    if (!file.startsWith(ROOT)) return send(res,403,'Forbidden','text/plain');
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res,404,'Not found','text/plain');
    res.writeHead(200,{'Content-Type':types[path.extname(file)] || 'application/octet-stream'});
    fs.createReadStream(file).pipe(res);
  } catch(e) { send(res,500,{error:e.message}); }
});
server.listen(PORT,'0.0.0.0',()=>console.log(`Crypto Black Box: http://localhost:${PORT}\nSolana RPC: ${RPC_URL}`));
