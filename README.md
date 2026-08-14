# Crypto Black Box

**Verify. Don't trust.**

Crypto Black Box is an on-chain token intelligence platform beginning with Solana. The goal is not to dump blockchain data on users — it is to explain what the data means.

## MVP v0.1

- Live Solana mint scanning
- Mint authority check
- Freeze authority check
- Supply analysis
- Largest token accounts
- Holder concentration metrics
- Explainable 0–100 token health score
- Plain-English risk signals
- Local token watchlist
- Mobile-friendly interface

## Architecture

The current proof of concept is a static frontend using Solana JSON-RPC. Public RPC endpoints can rate-limit browser requests. Production will move RPC/indexer access behind a Black Box backend/API so credentials remain private and deeper intelligence can be computed server-side.

## Roadmap

1. Black Box API/backend
2. Dedicated Solana RPC/indexer
3. Wallet funding graph + clustering
4. Liquidity/pool intelligence
5. Historical holder movements
6. Verified treasury/team wallet registry
7. Behavioral alerts
8. Telegram `/scan` and `/watch` bot
9. Black Box Verified transparency dashboards
10. Developer/API access

## Product principle

> Raw blockchain data is not the product. The explanation is the product.

## Disclaimer

Crypto Black Box provides blockchain intelligence, not financial advice. Risk signals and scores are analytical heuristics and do not guarantee token safety, legitimacy, performance, or intent.