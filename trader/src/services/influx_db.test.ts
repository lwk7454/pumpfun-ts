import { InfluxDB } from '@influxdata/influxdb-client'
import { OrgsAPI, BucketsAPI, DeleteAPI } from '@influxdata/influxdb-client-apis'
import { InfluxService, BasePoint } from './influx_db.ts'
import { assertEquals, assertNotEquals } from "@std/assert"
import { QueryResult } from '@/trader/services/index.ts';

console.log({ env: Deno.env.get("INFLUX_URL") })

function generateTestBucketName(): string {
  const timestamp = Date.now()
  const randomSuffix = Math.random().toString(36).substring(2, 8)
  return `test-bucket-${timestamp}-${randomSuffix}`
}

Deno.test('quick test', () => {
  console.log('quick test')
})

Deno.test("InfluxService", async (t) => {
  const INFLUX_URL = Deno.env.get("INFLUX_URL") || "http://localhost:8086"
  const INFLUX_TOKEN = Deno.env.get("INFLUX_TOKEN")
  const INFLUX_ORG = Deno.env.get("INFLUX_ORG")


  if (!INFLUX_TOKEN || !INFLUX_ORG) {
    throw new Error("Please set the INFLUX_TOKEN and INFLUX_ORG environment variables.")
  }

  const testBucketName = generateTestBucketName()

  let influxService: InfluxService
  let influxDB: InfluxDB
  let orgsAPI: OrgsAPI
  let bucketsAPI: BucketsAPI
  let deleteAPI: DeleteAPI
  let orgID: string

  await t.step("Setup Test Bucket", async () => {
    // Initialize InfluxDB Client
    influxDB = new InfluxDB({ url: INFLUX_URL, token: INFLUX_TOKEN })
    orgsAPI = new OrgsAPI(influxDB)
    bucketsAPI = new BucketsAPI(influxDB)
    deleteAPI = new DeleteAPI(influxDB)

    // Retrieve Organization ID
    const organizations = await orgsAPI.getOrgs()
    assertNotEquals(organizations.orgs?.length, 0, `Organization ${INFLUX_ORG} should exist.`)
    orgID = organizations.orgs![0].id!
    assertNotEquals(orgID, undefined, "Organization ID should be defined.")

    // Create Test Bucket
    await bucketsAPI.postBuckets({
      body: {
        orgID: orgID!,
        name: testBucketName,
      },
    })

    // Initialize InfluxService with the Test Bucket
    Deno.env.set("INFLUX_BUCKET", testBucketName)
    influxService = new InfluxService()
  })

  const clearBucket = async () => {
    const start = new Date(0).toISOString()
    const stop = new Date().toISOString()
    await deleteAPI.postDelete({
      bucket: testBucketName,
      org: INFLUX_ORG,
      body: {
        predicate: '_measurement != ""', // Deletes all data
        start: start,
        stop: stop,
      }
    })
  }

  await t.step("InfluxDB Connection", () => {
    assertNotEquals(influxService.client, undefined, "InfluxDB client should be initialized")
    assertNotEquals(influxService.queryApi, undefined, "Query API should be initialized")
  })

  await t.step("Write Data Successfully", async () => {
    await clearBucket()
    const sampleData: BasePoint = {
      _measurement: "test_measurement",
      _time: new Date().toISOString(),
      _value: 100,
      _field: "test_field",
      foo: "bar", // Additional Field
    }

    // Write Data to InfluxDB
    await influxService.recordTradeEvent(sampleData)

    // Define Flux Query to Verify Data
    const fluxQuery = `
      from(bucket: "${testBucketName}")
        |> range(start: -10m)
        |> filter(fn: (r) => r._measurement == "test_measurement")
    `

    // Fetch Records to Verify Write Operation
    const records = await influxService.fetchAllRecords<Record<string, unknown>>(fluxQuery, 10)
    assertEquals(records.length, 1, "There should be exactly one record written.")
    assertEquals(records[0]._value, 100, "The _value field should match the written value.")
    assertEquals(records[0].foo, "bar", "Additional fields should match.")
  })

  await t.step("Paginate Query Successfully", async () => {
    await clearBucket()
    // Insert Multiple Records for Pagination
    const numRecords = 25
    const baseTime = Date.now() - 1000_000
    for (let i = 0; i < numRecords; i++) {
      const record: BasePoint = {
        _measurement: "pagination_test",
        _time: new Date(baseTime + i).toISOString(), // Ensure Unique _time
        _value: i,
        _field: "test_field",
        index: i.toString(),
      }
      await influxService.recordTradeEvent(record)
    }

    // Optional: Wait for Data to Propagate
    await new Promise((resolve) => setTimeout(resolve, 1000))

    // Define Flux Query for Pagination
    const fluxQuery = `
      from(bucket: "${testBucketName}")
        |> range(start: 1970-01-01T00:00:00Z)
        |> filter(fn: (r) => r._measurement == "pagination_test")
    `

    // Initialize Counter for Fetched Records
    let totalFetched = 0

    // Iterate Through Paginated Results
    for await (const page of influxService.paginateQuery<{ index: string }>({ fluxQuery, pageSize: 5 })) {
      totalFetched += page.length
    }

    // Assert Total Fetched Records
    assertEquals(totalFetched, numRecords, `Total fetched records should be ${numRecords}`)
  })

  await t.step("Process Records with Callback", async () => {
    // Clear Bucket Before Test
    await clearBucket()

    // Insert Multiple Records for Processing
    const numRecords = 10
    const baseTime = Date.now()
    for (let i = 0; i < numRecords; i++) {
      const record: BasePoint = {
        _measurement: "process_test",
        _time: new Date(baseTime + i).toISOString(), 
        _value: i * 2,
        _field: "test_field",
        index: i.toString(),
      }
      await influxService.recordTradeEvent(record)
    }

    // Define Callback Function to Process Each Page
    let processedCount = 0
    const callback = (page: Array<QueryResult<unknown>>) => {
      processedCount += page.length
    }

    // Optional: Wait for Data to Propagate
    await new Promise((resolve) => setTimeout(resolve, 1000))

    // Define Flux Query for Processing
    const fluxQuery = `
      from(bucket: "${testBucketName}")
        |> range(start: 1970-01-01T00:00:00Z)
        |> filter(fn: (r) => r._measurement == "process_test")
    `

    // Process Records with Callback
    await influxService.processRecords<Record<string, unknown>>(fluxQuery, 3, callback)

    // Assert Processed Records Count
    assertEquals(processedCount, numRecords, `Processed records should be ${numRecords}`)
  })

  try {
    const bucket = await bucketsAPI!.getBuckets({ name: testBucketName })
    await bucketsAPI!.deleteBucketsID({ bucketID: bucket.buckets![0].id! })
  } catch (error) {
    console.error(`Error deleting bucket "${testBucketName}":`, error)
  }
})