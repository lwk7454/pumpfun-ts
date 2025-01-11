# Pump.fun Typescript Monorepo

## Dev Setup
- Install Node.js >= 20.0.0
- Install Deno >= 2.0.0
- Copy `.env.example` to `.env` and fill in the values
- Run `deno install --allow-scripts`
- Requires InfluxDB running

## Trader

Every run will result in logs in `logs/`

### Dry Run
- At monorepo root, run `deno task trader:dry-run`
- Runner is at `trader/dry_run/index.ts` for config
- Logs are in `logs/dry-run-<time>/`

### Live mode
WORK IN PROGRESS
- run `deno task trader:live`
