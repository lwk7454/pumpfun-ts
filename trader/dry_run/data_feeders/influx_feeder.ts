import { InfluxService } from '@/trader/services/index.ts';
import { BaseDataFeeder } from './base_feeder.ts';
import { TokenEvent } from '@/trader/interfaces.ts';

export class InfluxDataFeeder extends BaseDataFeeder {
  private influxService: InfluxService

  constructor(startDate: Date, endDate: Date) {
    super(startDate, endDate)
    this.influxService = new InfluxService()
  }

  async *nextEvent(): AsyncGenerator<TokenEvent> {

    const recordPages = this.influxService.paginateQuery<TokenEvent>({
      fluxQuery: `
        |> range(start: ${this.startDate.toISOString()}, stop: ${this.endDate.toISOString()})
        |> filter(fn: (r) => r._measurement == "market_data")
      `,
      pageSize: 100,
    })

    for await (const page of recordPages) {
      for (const record of page) {
        yield {
          mint: record.mint,
          marketCapSol: record.marketCapSol,
          timestamp: record.timestamp,
        }
      }
    }
  }
}
