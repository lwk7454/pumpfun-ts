import dotenv from 'npm:dotenv'
import { FakeTime } from "@std/testing/time"
import { Master } from '@/trader/master.ts'
import { InfluxService, TradePortalService } from '@/trader/services/index.ts';
import { DummyStrategy } from '@/trader/strategy/index.ts';
import { InfluxDataFeeder } from './data_feeders/influx_feeder.ts';

dotenv.config()

async function main() {
  const dryRun = true
  const RPC_ENDPOINT = ''
  const WALLET_SECRET = ''
  const WALLET_PUBLIC_KEY = ''
  const startDate = new Date(Deno.env.get("START_DATE") || '2024-12-01')
  const endDate = new Date(Deno.env.get("END_DATE") || '2025-12-01')

  const influxDataFeeder = new InfluxDataFeeder(startDate, endDate)
  using time = new FakeTime(startDate);

  const influxService = new InfluxService()
  const tradePortalService = new TradePortalService({
    rpcEndpoint: RPC_ENDPOINT,
    walletSecretKey: WALLET_SECRET,
  })

  const master = new Master({
    maxOpenPositions: 10,
    baseBid: 0.01,
    dryRun,
    influxService,
    tradePortal: tradePortalService,
    defaultStrategy: DummyStrategy,
    walletPublicKey: WALLET_PUBLIC_KEY,
    defaultSlippage: 10,
    priorityFee: 0.000001,
  })

  master.run();

  try {
    for await (const event of influxDataFeeder.nextEvent()) {
      // Advance the simulated time to the event's timestamp
      const eventTime = new Date(event.timestamp).getTime()
      while (eventTime > time.now) {
        time.tick(100)
      }

      master.onEvent(event)
    }

    while (endDate.getTime() > time.now) {
      time.tick(100)
    }

  } catch (error) {
    console.error("Error processing events:", error)
  } finally {
    master.close()
    time.restore()
  }
}

await main()
