import { Master } from '@/trader/master.ts';
import { InfluxService, PumpFunService } from '@/trader/services/index.ts';
import { FakeTime } from '@std/testing/time';
// import { DummyStrategy } from '@/trader/strategy/index.ts';
import { logger } from '@/shared/utils.ts';
import { HealthyGrowthStrategy } from '@/trader/strategy/healthy_growth_strategy.ts';
import { assert } from '@std/assert';
import { DebugFeeder } from './data_feeders/index.ts';

Deno.test('Debug run', async () => {
  Deno.env.set('DRY_RUN', 'true')
  const startDate = new Date('2025-01-11T10:30:00Z')
  const endDate = new Date('2025-01-11T23:32:00Z')
  using time = new FakeTime(startDate)
  const WALLET_SECRET = ''
  const WALLET_PUBLIC_KEY = ''
  const mint = '66621K724qqUcyj7RUrXHCfibZJNN581XbRuzidJpump'
  const influxDataFeeder = new DebugFeeder(startDate, endDate, mint)
  const influxService = new InfluxService()
  const pumpFun = new PumpFunService({ walletSecretKey: WALLET_SECRET })

  const master = new Master({
    maxOpenPositions: 8,
    baseBid: 0.1,
    influxService,
    pumpFun,
    defaultStrategy: HealthyGrowthStrategy,
    walletPublicKey: WALLET_PUBLIC_KEY,
    defaultSlippage: 90,
    priorityFee: 0.0001,
  })

  master.run()

  try {
    for await (const event of influxDataFeeder.nextEvent()) {
      // Advance the simulated time to the event's timestamp
      time.tick(event.timestamp - time.now)
      master.onEvent(event)
    }

    master['activeWorkers'].forEach((worker) => {
      const strategy = worker['strategy'] as HealthyGrowthStrategy
      const events = worker['events']
      const bins = strategy['getBins'](events)
      bins.map((bin) => {
        console.log(`avg: ${bin.avgMc}, vola: ${bin.volatility}`)
      })
    })

    time.tick(endDate.getTime() - time.now)
  } catch (error) {
    logger.error('Error processing events:', error)
  } finally {
    await master.close()
  }

  assert(true)
})
