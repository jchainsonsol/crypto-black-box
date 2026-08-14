# Black Box Owned Solana RPC

Crypto Black Box production architecture does **not** depend on Helius, QuickNode, Alchemy, or another commercial RPC provider.

## Architecture

```text
Browser
  -> Black Box web/API
  -> BLACKBOX_RPC_URL
  -> Black Box-owned Solana RPC node
  -> Solana network
```

There is deliberately no public-RPC fallback in application code. If the owned node is unavailable, Black Box reports that its chain node is offline rather than silently depending on a third party.

## Node software

Run the current Agave validator/RPC software maintained for the Solana validator ecosystem. This machine is intended as a non-voting RPC node for Black Box reads, not as a voting validator.

## Network exposure

Do not expose the RPC port openly to the internet. Put the node behind a reverse proxy/firewall and permit only the Black Box API host or private network/VPN. Configure the application with:

```text
BLACKBOX_RPC_URL=http(s)://<owned-node-endpoint>
```

## Data strategy

The API batches the initial mint queries and caches completed scans. The next indexing layer should persist token/account observations in Black Box-owned storage so repeated scans and historical intelligence do not repeatedly query the chain.

## Production direction

1. Dedicated Linux host for Agave RPC.
2. Fast local NVMe ledger/accounts storage.
3. Private RPC ingress.
4. Black Box-owned database/indexer alongside RPC.
5. API reads indexed/cached data first and RPC second.
6. Wallet graph and behavioral history are generated from Black Box's own indexed observations.

Vercel is currently only an application deployment convenience. The API can later move to the same owned infrastructure without changing the product contract: `BLACKBOX_RPC_URL` remains the chain-data boundary.
