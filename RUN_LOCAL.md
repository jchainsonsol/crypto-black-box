# Run Crypto Black Box Internally

Crypto Black Box now has its own dependency-free Node.js API server. The frontend no longer needs to call Solana RPC directly.

## Requirements

- Node.js 18+
- A Solana mainnet RPC node you control

The API defaults to `http://127.0.0.1:8899`.

## Start Black Box

```bash
node start.js
```

Open:

```text
http://localhost:8787
```

Health check:

```text
http://localhost:8787/api/health
```

## Point Black Box at your RPC

macOS/Linux:

```bash
SOLANA_RPC_URL=http://127.0.0.1:8899 node start.js
```

The application code contains no third-party RPC API key or hosted backend dependency.

## Important

A local `solana-test-validator` is useful for development but does not contain arbitrary Solana mainnet token state. For real mainnet scans, `SOLANA_RPC_URL` must point to a mainnet RPC node connected to the Solana network.
