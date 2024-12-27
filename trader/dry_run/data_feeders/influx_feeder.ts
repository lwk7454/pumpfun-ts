import { InfluxService } from '@/trader/services/index.ts';
import { BaseDataFeeder } from './base_feeder.ts';
import { TokenEvent } from '@/trader/interfaces.ts';

type InfluxRecord = {
  mint: string
  tx_type: 'buy' | 'sell'
  token_amount: number
  sol_amount: number
  market_cap_sol: number
  timestamp: number
}

export class InfluxDataFeeder extends BaseDataFeeder {
  private influxService: InfluxService

  constructor(startDate: Date, endDate: Date) {
    super(startDate, endDate)
    this.influxService = new InfluxService()
  }

  async *nextEvent(): AsyncGenerator<TokenEvent> {
    const recordPages = this.influxService.paginateQuery<InfluxRecord>({
      fluxQuery: `
        |> range(start: ${this.startDate.toISOString()}, stop: ${this.endDate.toISOString()})
        |> filter(fn: (r) => r._measurement == "market_data")
        |> pivot(rowKey:["_time", "mint"], columnKey: ["_field"], valueColumn: "_value")
        |> filter(fn: (r) => r.market_cap_sol > 0 and r.tx_type != "create")
        |> sort(columns: ["_time"], desc: false)
      `,
      pageSize: 100,
    })

    for await (const page of recordPages) {
      for (const record of page) {
        yield {
          mint: record.mint,
          txType: record.tx_type,
          tokenAmount: record.token_amount,
          solAmount: record.sol_amount,
          marketCapSol: record.market_cap_sol,
          timestamp: record.timestamp,
        }
      }
    }
  }
}
