import dotenv from 'npm:dotenv'
import { FakeTime } from "@std/testing/time"
import { Master } from '@/trader/master.ts'
import { InfluxService, TradePortalService } from '@/trader/services/index.ts';
import { DummyStrategy } from '@/trader/strategy/index.ts';

dotenv.config()

async function main() {
  using time = new FakeTime();
  
  const dryRun = true
  const RPC_ENDPOINT = ''
  const WALLET_SECRET = ''
  const WALLET_PUBLIC_KEY = ''
  const startDate = new Date(Deno.env.get("START_DATE") || '2024-12-01')
  const endDate = new Date(Deno.env.get("END_DATE") || '2025-12-01')

  const influxService = new InfluxService()
  const tradePortalService = new TradePortalService({
    rpcEndpoint: RPC_ENDPOINT,
    walletSecretKey: WALLET_SECRET,
  })

  const master = new Master({
    maxOpenPositions: 10,
    baseBid: 0.1,
    dryRun,
    influxService,
    tradePortal: tradePortalService,
    defaultStrategy: DummyStrategy,
    walletPublicKey: WALLET_PUBLIC_KEY,
    defaultSlippage: 10,
    priorityFee: 0.00001,
  })

  await master.run();

  // get all records from influx withing the time range with 1000 as page size, with a loop that gets the next page until there are no more pages
  // const records = await influxService.getRecords(INFLUX_BUCKET, INFLUX_ORG, INFLUX_TOKEN, INFLUX_URL, time.now(), time.now(), 1000)
  // console.log(records)

}

await main()
