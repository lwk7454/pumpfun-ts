import dotenv from "dotenv"
import { assert } from '@std/assert';
import {
  Connection,
  Keypair,
  VersionedTransaction,
} from "npm:@solana/web3.js"
import bs58 from 'bs58'

dotenv.config()

/**
 * You can list as many RPC endpoints as you like.
 * For demonstration, we've included a few common ones.
 */
const RPC_ENDPOINTS = [
  Deno.env.get("RPC_QUICKNODE")!,
  Deno.env.get("RPC_CHAINSTACK")!,
  Deno.env.get("RPC_DRPC")!,
  Deno.env.get("RPC_ANKR")!,
  Deno.env.get("RPC_SOLANATRACKER")!,
  Deno.env.get("RPC_SOLANA")!,
]

async function checkRpcSync() {
  console.log("Checking latest block from each RPC...")

  const portalRequest = getPumpPortalTransaction()

  // Fetch block heights in parallel
  const rpcResults = RPC_ENDPOINTS.map(async (url) => {
    const connection = new Connection(url, "confirmed")
    const slot = await connection.getSlot()
    return { url, slot }
  })

  const validResults = await Promise.all(rpcResults)
  await portalRequest

  const maxBlockHeight = Math.max(...validResults.map((r) => r.slot))

  // Print a summary
  console.log("RPC Sync Status:")
  console.log("---------------------------------------------------")
  validResults.forEach((r) => {
    if ("error" in r) {
      // Something went wrong
      console.log(`❌ ${r.url} -- ERROR: ${r.error}`)
    } else {
      // Show how far behind (or 0 if it's the max)
      const behind = maxBlockHeight - r.slot
      const behindStr = behind === 0 ? "latest" : `${behind} block(s) behind`
      console.log(`✅ ${r.url} -- blockHeight: ${r.slot} (${behindStr})`)
    }
  })
  console.log("---------------------------------------------------")
  console.log(`Highest blockHeight found: ${maxBlockHeight}`)
}


async function getPumpPortalTransaction() {
  const connection = new Connection(Deno.env.get("RPC_QUICKNODE")!, "confirmed")
  const response = await fetch(`https://pumpportal.fun/api/trade-local`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      "publicKey": Deno.env.get("PUBLIC_KEY")!,
      "action": "sell",
      "mint": "42tXBZnu4vgSAFke3PynBHgbYQQToy77q2VXNmK3pump",
      "denominatedInSol": "false",
      "amount": 47300.388954,
      "slippage": 10,
      "priorityFee": 0.00001,
      "pool": "pump"
    })
  })

  if (response.status === 200) {
    const data = await response.arrayBuffer()
    const tx = VersionedTransaction.deserialize(new Uint8Array(data))
    const signerKeyPair = Keypair.fromSecretKey(bs58.decode(Deno.env.get("PRIVATE_KEY")!))
    tx.sign([signerKeyPair])
    const signature = await connection.sendTransaction(tx)
    console.log("Transaction: https://solscan.io/tx/" + signature);
    return signature
  } else {
    console.log("Error response code:", response.status, response.statusText)
    // If you also want to see the text of an error response
    const errText = await response.text()
    console.log("Error response body:", errText)
  }
}
await checkRpcSync()

// Deno.test("getPumpPortalTransaction", async () => {
//   await getPumpPortalTransaction()
//   assert(true)
// })
