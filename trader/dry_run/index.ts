import dotenv from 'npm:dotenv'
import { FakeTime } from "@std/testing/time"
import { Master } from '@/trader/master.ts'
import { InfluxService, PumpPortalService } from '@/trader/services/index.ts';
import { DummyStrategy } from '@/trader/strategy/index.ts';
import { InfluxDataFeeder } from './data_feeders/influx_feeder.ts';
import { assert } from '@std/assert';

dotenv.config()
Deno.test('Dry run', async () => {
  const dryRun = true
  const RPC_ENDPOINT = 'https://api.mainnet-beta.solana.com'
  const WALLET_SECRET = ''
  const WALLET_PUBLIC_KEY = ''
  const startDate = new Date(Deno.env.get("START_DATE") || '2024-12-27T03:30:00Z')
  const endDate = new Date(Deno.env.get("END_DATE") || '2024-12-27T03:31:00Z')

  const influxDataFeeder = new InfluxDataFeeder(startDate, endDate)
  using time = new FakeTime(startDate);

  const influxService = new InfluxService()
  const pumpPortalService = new PumpPortalService({
    rpcEndpoint: RPC_ENDPOINT,
    walletSecretKey: WALLET_SECRET,
  }, true)

  const master = new Master({
    maxOpenPositions: 10,
    baseBid: 0.01,
    dryRun,
    influxService,
    pumpPortal: pumpPortalService,
    defaultStrategy: DummyStrategy,
    walletPublicKey: WALLET_PUBLIC_KEY,
    defaultSlippage: 10,
    priorityFee: 0.000001,
  })

  master.run();

  try {
    for await (const event of influxDataFeeder.nextEvent()) {
      // Advance the simulated time to the event's timestamp
      while (event.timestamp > time.now) {
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
  }

  assert(true)
})
