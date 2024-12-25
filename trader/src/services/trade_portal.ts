import { Keypair, VersionedTransaction, Connection } from '@solana/web3.js'
import { decode } from 'npm:base-58'

// For exponential backoff
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function fetchWithRetry(url: string, options: RequestInit, maxRetries = 3, backoffFactor = 2): Promise<Response> {
  let attempt = 0
  let delay = 1000 // 1 second base
  let lastError: unknown = null

  while (attempt < maxRetries) {
    try {
      const response = await fetch(url, options)
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} - ${response.statusText}`)
      }
      return response
    } catch (err) {
      attempt++
      lastError = err
      console.warn(`[TradePortalService] fetchWithRetry error on attempt ${attempt}: ${err}. Retrying in ${delay} ms...`)
      await wait(delay)
      delay *= backoffFactor
    }
  }
  throw new Error(`[TradePortalService] fetchWithRetry failed after ${maxRetries} attempts. Last error: ${lastError}`)
}

export interface TradePortalOptions {
  dryRun: boolean
  rpcEndpoint: string
  walletSecretKey: string   // Base58 string or other secure format
}

export interface TradeRequest {
  publicKey: string
  action: "buy" | "sell"
  mint: string
  denominatedInSol: boolean
  amount: number
  slippage: number
  priorityFee: number
  pool: "pump" | "raydium"
}

export class TradePortalService {
  private connection: Connection | null = null
  private keypair: Keypair | null = null
  private dryRun: boolean

  constructor(private options: TradePortalOptions) {
    this.dryRun = options.dryRun
    if (this.dryRun) return
    this.connection = new Connection(this.options.rpcEndpoint, "confirmed")
    this.keypair = Keypair.fromSecretKey(decode(this.options.walletSecretKey))
  }

  async trade(request: TradeRequest): Promise<string> {
    if (this.dryRun) {
      return "dry-run"
    }

    const keypair = this.keypair!
    const connection = this.connection!

    console.log("[TradePortalService] Attempting to sign and send transaction...")

    // Fetch transaction data with retry
    const response = await fetchWithRetry(
      `https://pumpportal.fun/api/trade-local`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      },
    )

    const data = await response.arrayBuffer()
    const tx = VersionedTransaction.deserialize(new Uint8Array(data))
    tx.sign([keypair])

    let signature: string | null = null

    try {
      // Send the transaction
      signature = await connection.sendTransaction(tx, {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
      })
      console.log("[TradePortalService] Transaction sent:", signature)

      // Fetch the latest blockhash for confirmation strategy
      const latestBlockhash = await connection.getLatestBlockhash('confirmed')

      // Create the confirmation strategy
      const confirmationStrategy = {
        signature,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      }

      // Await confirmation using the strategy
      const confirmation = await connection.confirmTransaction(confirmationStrategy)

      if (confirmation.value.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`)
      }

      console.log("[TradePortalService] Transaction confirmed:", signature)
      return signature
    } catch (err) {
      throw new Error(`[TradePortalService] Transaction failed. Error: ${err}`)
    }
  }
}