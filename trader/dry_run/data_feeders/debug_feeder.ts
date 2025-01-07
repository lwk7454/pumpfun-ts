import { InfluxService } from '@/trader/services/index.ts'
import { BaseDataFeeder } from './base_feeder.ts'
import { TokenEvent } from '@/trader/interfaces.ts'

type InfluxRecord = {
  mint: string
  tx_type: 'buy' | 'sell'
  token_amount: number
  sol_amount: number
  market_cap_sol: number
  timestamp: number
}

export class DebugFeeder extends BaseDataFeeder {
  private influxService: InfluxService

  constructor(startDate: Date, endDate: Date) {
    super(startDate, endDate)
    this.influxService = new InfluxService()
  }

  async *nextEvent(): AsyncGenerator<TokenEvent> {
    let binStart = new Date(this.startDate.getTime())

    while (binStart < this.endDate) {
      const binEnd = new Date(
        Math.min(
          binStart.getTime() + 20 * 60 * 1000, // +20 minutes
          this.endDate.getTime()
        )
      )

      const fluxQuery = `
        |> range(start: ${binStart.toISOString()}, stop: ${binEnd.toISOString()})
        |> filter(fn: (r) => r._measurement == "market_data" and r.mint == "CFUrT5PT5kJT85dzJhJgVPgYNXmQYn2xcaMsvJZHpump")
        |> pivot(rowKey:["_time", "mint"], columnKey: ["_field"], valueColumn: "_value")
        |> filter(fn: (r) => r.market_cap_sol > 0 and r.tx_type != "create")
        |> group()
        |> sort(columns: ["_time"], desc: false)
      `
      const records = await this.influxService.fetchAllRecordsBrute<InfluxRecord>(fluxQuery)

      for (const record of records) {
        yield {
          mint: record.mint,
          txType: record.tx_type,
          tokenAmount: record.token_amount,
          solAmount: record.sol_amount,
          marketCapSol: record.market_cap_sol,
          timestamp: new Date(record._time).getTime(),
          tradePrice: record.sol_amount / record.token_amount,
        }
      }
      binStart = binEnd
    }
  }

}
