import { FakeTime } from "@std/testing/time"

import { Master } from '@/trader/master.ts'
import { InfluxService, PumpFunService } from '@/trader/services/index.ts';
// import { DummyStrategy } from '@/trader/strategy/index.ts';
import { InfluxDataFeeder, DebugFeeder } from './data_feeders/index.ts';
import { assert } from '@std/assert';
import { logger } from '@/shared/utils.ts';
import { HealthyGrowthStrategy } from '@/trader/strategy/healthy_growth_strategy.ts';
import { CommentsReaderStrategy } from '@/trader/strategy/comments_reader_strategy.ts';

Deno.test('Dry run', async () => {
  Deno.env.set("DRY_RUN", "true")
  await logger.initFileLogger(`./logs/dry-run-${new Date().toISOString()}`)
  const startDate = new Date(Deno.env.get("START_DATE") || '2024-12-27T03:30:00Z')
  const endDate = new Date(Deno.env.get("END_DATE") || '2024-12-27T03:32:00Z')
  using time = new FakeTime(startDate);
  const WALLET_SECRET = ''
  const WALLET_PUBLIC_KEY = ''

  const influxDataFeeder = new InfluxDataFeeder(startDate, endDate)
  // const influxDataFeeder = new DebugFeeder(startDate, endDate)
  

  const influxService = new InfluxService()
  const pumpFun = new PumpFunService({
    walletSecretKey: WALLET_SECRET,
  })

  const master = new Master({
    maxOpenPositions: 20,
    baseBid: 0.03,
    influxService,
    pumpFun,
    defaultStrategy: HealthyGrowthStrategy,
    walletPublicKey: WALLET_PUBLIC_KEY,
    defaultSlippage: 90,
    priorityFee: 0.00001,
  })

  master.run();

  try {
    for await (const event of influxDataFeeder.nextEvent()) {
      // Advance the simulated time to the event's timestamp
      time.tick(event.timestamp - time.now)
      master.onEvent(event)
    }
    time.tick(endDate.getTime() - time.now)
  } catch (error) {
    logger.error("Error processing events:", error)
  } finally {
    await master.close()
  }

  assert(true)
})
