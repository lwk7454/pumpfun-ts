import "jsr:@std/dotenv/load"

const INFLUXDB_URL = Deno.env.get("INFLUXDB_URL") || ''
const INFLUXDB_TOKEN = Deno.env.get("INFLUXDB_TOKEN") || ''
const INFLUXDB_ORG = Deno.env.get("INFLUXDB_ORG") || ''
const INFLUXDB_BUCKET = Deno.env.get("INFLUXDB_BUCKET") || ''

if (!INFLUXDB_URL || !INFLUXDB_TOKEN || !INFLUXDB_ORG || !INFLUXDB_BUCKET) {
  throw new Error("Missing one or more required InfluxDB environment variables.")
}

function toLineProtocol(
  tokenName: string,
  tradeType: string,
  price: number,
  volume: number,
): string {
  const timestampSeconds = Math.floor(Date.now() / 1000)

  // TODO: sanitize values
  return `token_trade,token_name=${tokenName},trade_type=${tradeType} price=${price},volume=${volume} ${timestampSeconds}`
}

async function writeMarketData(
  tokenName: string,
  tradeType: string,
  price: number,
  volume: number,
) {
  const line = toLineProtocol(tokenName, tradeType, price, volume)

  try {
    const url = `${INFLUXDB_URL}/api/v2/write?org=${encodeURIComponent(
      INFLUXDB_ORG,
    )}&bucket=${encodeURIComponent(INFLUXDB_BUCKET)}&precision=s`

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Token ${INFLUXDB_TOKEN}`,
        "Content-Type": "text/plain; charset=utf-8",
      },
      body: line,
    })

    if (!res.ok) {
      const errorText = await res.text()
      console.error("Failed to write data to InfluxDB:", errorText)
    } else {
      console.log("Data written to InfluxDB:", {
        tokenName,
        tradeType,
        price,
        volume,
      })
    }
  } catch (err) {
    console.error("Error sending data to InfluxDB:", err)
  }
}

/**
 * Connect to a remote WebSocket and listen for trade messages.
 */
function watchMarket(): Promise<void> {
  const WS_URL = "wss://pumpportal.fun/api/data"
  const socket = new WebSocket(WS_URL)
  const subscribedTokens = new Set<string>()

  return new Promise<void>((resolve, reject) => {
    // Called when the socket connects
    socket.onopen = () => {
      console.log("Connected to WebSocket.")

      // Subscribe to token trade events
      socket.send(
        // JSON.stringify({
        //   method: "subscribeNewToken",
        // }),
        JSON.stringify({
          method: "subscribeTokenTrade",
          keys: ['GXtCiv7ugFn485GZeyQJqcFkAjLzqEphE1bsBcMmpump'],
        }),
      )
    }

    // Handle each incoming message
    socket.onmessage = async (event) => {
      try {
        const data = JSON.parse(event.data)

        if (data.txType === "create") {
          // Token creation event
          const { name: token_name } = data
          // await writeMarketData(token_name, '', price, volume)

          if (!subscribedTokens.has(token_name)) {
            subscribedTokens.add(token_name)

            // Subscribe to trade events for the new token
            socket.send(
              JSON.stringify({
                method: "subscribeTokenTrade",
                keys: Array.from(subscribedTokens),
              }),
              
            )
            console.log("Subscribed to token trade events for:", token_name)
          }
        } else {
          console.dir({ data }, { depth: 100 })
          // Trade event
          const { token_name, trade_type, price, volume } = data

          // Write to InfluxDB (line protocol)
          // await writeMarketData(token_name, trade_type, price, volume)
        }
      } catch (err) {
        console.error("Error processing message:", err)
      }
    }

    // Handle errors
    socket.onerror = (err) => {
      console.error("WebSocket error:", err)
      // If desired, you could close or reject here
      // socket.close();
    }

    // Called when the socket closes (normal or error)
    socket.onclose = () => {
      console.log("WebSocket closed.")
      resolve()
    }
  })
}

await watchMarket()
console.log("Market watcher finished (WebSocket closed).")
