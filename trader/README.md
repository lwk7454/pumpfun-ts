# Pump.Fun Trader (Deno + TypeScript)

## Overview
This repository demonstrates a prototype trading bot using:
- Deno 2 runtime
- InfluxDB for data persistence
- PumpPortal API for trades
- Redis (optional) for shared state / pub-sub

## Quick Start
1. Install Deno >= 2.0.0
2. Clone this repo
3. Set environment variables for your InfluxDB and wallet secrets:
   - `RPC_ENDPOINT`
   - `WALLET_SECRET_KEY`
   - `INFLUX_URL`
   - `INFLUX_TOKEN`
   - `INFLUX_ORG`
   - `INFLUX_BUCKET`
4. Run:
   \`\`\`
   deno run --allow-net --allow-env --allow-read master.ts
   \`\`\`
5. Observe logs in your console.

## TODO
- Implement real-time subscription from PumpPortal for market data (instead of example calls).
- Add concurrency controls in Master for multiple tokens.
- Integrate Redis for front-end communication.
- Write Dockerfile and orchestrate with Docker Compose or Kubernetes.
