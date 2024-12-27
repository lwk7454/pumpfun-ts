import { InfluxDB, QueryApi, Point, WriteApi} from '@influxdata/influxdb-client'

// Define a generic interface for query results
export type QueryResult<T = Record<string, unknown>> ={
  _result: string
  _table: number
  _start: string
  _stop: string
  _time: string
  _value: number
  _field: string
  _measurement: string
  mint: string
} & T

export type BasePoint = Record<string, unknown> & {
  _measurement: string
  _time: string
}

// Pagination options interface
interface PaginationOptions {
  pageSize: number
  fluxQuery: string
}

const TAGS = [
  "traderPublicKey",
  "strategy",
  "token",
  "action",
]

export class InfluxService {
  public client: InfluxDB
  public queryApi: QueryApi
  private writeApi: WriteApi
  private bucket: string

  constructor(bucket?: string) {
    const url = Deno.env.get("INFLUX_URL") || "http://localhost:8086"
    const token = Deno.env.get("INFLUX_TOKEN")
    const org = Deno.env.get("INFLUX_ORG")
    bucket = bucket || Deno.env.get("INFLUX_BUCKET")

    if (!url || !token || !org || !bucket) {
      throw new Error("InfluxDB credentials are not set")
    }

    this.bucket = bucket
    this.client = new InfluxDB({ url, token })
    this.queryApi = this.client.getQueryApi(org)
    this.writeApi = this.client.getWriteApi(org, bucket, 's') // 's' for seconds precision
  }

  /**
   * Retrieves query results in paginated form.
   * @param options Pagination options including page size and Flux query.
   * @returns An async generator yielding pages of query results.
   */
  async *paginateQuery<T extends Record<string, unknown>>(options: PaginationOptions): AsyncGenerator<Array<QueryResult<T>>> {
    const { pageSize, fluxQuery } = options
    let hasMore = true
    let lastTime: string | null = null

    while (hasMore) {
      let paginatedQuery = `from(bucket: "${this.bucket}")` + fluxQuery
      if (lastTime) {
        paginatedQuery += ` |> filter(fn: (r) => r._time > ${lastTime})`
      }
      paginatedQuery += ` |> limit(n: ${pageSize})`

      const page: Array<QueryResult<T>> = []
      const rows = await this.queryApi.collectRows<QueryResult<T>>(paginatedQuery)
      page.push(...rows)

      if (page.length > 0) {
        lastTime = rows.at(-1)!._time
        yield page
      } else {
        console.log('No more pages: ', { page, pageSize })
        hasMore = false
      }
    }
  }

  /**
   * Executes a Flux query and processes each page of records using a callback function.
   * @param fluxQuery The Flux query string.
   * @param pageSize Number of records per page.
   * @param callback A function to process each page of query results.
   */
  async processRecords<T extends Record<string, unknown>>(
    fluxQuery: string,
    pageSize: number = 1000,
    callback: (page: Array<QueryResult<T>>) => Promise<void> | void
  ): Promise<void> {
    for await (const page of this.paginateQuery<T>({ fluxQuery, pageSize })) {
      await callback(page)
    }
  }

  /**
   * Executes a Flux query and retrieves all records in memory with pagination.
   * @param fluxQuery The Flux query string.
   * @param pageSize Number of records per page.
   * @returns An array containing all query results.
   */
  async fetchAllRecords<T extends Record<string, unknown>>(
    fluxQuery: string,
    pageSize: number = 1000
  ): Promise<Array<QueryResult<T>>> {
    const results: Array<QueryResult<T>> = []
    for await (const page of this.paginateQuery<T>({ fluxQuery, pageSize })) {
      results.push(...page)
    }
    console.log('Results: ', {results})
    return results
  }

  /**
 * Writes a trade event to InfluxDB.
 * @param record The trade event record to write.
 */
  async recordTradeEvent(record: BasePoint): Promise<void> {
    const point = new Point(record._measurement)
      .timestamp(new Date(record._time))
    // Add additional fields dynamically
    for (const key in record) {
      if (['_measurement', '_time'].includes(key)) continue
      const value = record[key]

      if (TAGS.includes(key)) {
        point.tag(key, String(value))
      } else if (typeof value === 'number') {
        point.floatField(key, value)
      } else if (typeof value === 'string') {
        point.stringField(key, value)
      } else if (typeof value === 'boolean') {
        point.booleanField(key, value)
      }
    }

    console.log('Writing point: ', point.toLineProtocol())

    this.writeApi.writePoint(point)
    await this.writeApi.flush()
  }
}
