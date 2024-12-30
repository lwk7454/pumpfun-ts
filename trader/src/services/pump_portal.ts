import { callWithConnectionList } from '@/shared/solana.ts'
import { logger } from '@/shared/utils.ts'
import { TradeAction } from '@/trader/interfaces.ts'
import { Connection, ConnectionConfig, Keypair, ParsedTransactionWithMeta, VersionedTransaction } from '@solana/web3.js'
import bs58 from 'bs58'

export interface PumpPortalOptions {
  walletSecretKey: string   // Base58 string or other secure format
}

export interface TradeRequest {
  publicKey: string
  action: "buy" | "sell"
  mint: string
  denominatedInSol: "true" | "false"
  amount: number
  slippage: number
  priorityFee: number
  pool: "pump" | "raydium"
}

export class PumpPortalService {
  private connections: Record<string, Connection> = {}
  private keypair: Keypair | null = null

  constructor(private options: PumpPortalOptions, dryRun = false) {
    if (dryRun) return
    const connectionConfig: ConnectionConfig = {
      commitment: 'confirmed',
      disableRetryOnRateLimit: true,
    }
    this.connections = {
      solana: new Connection(Deno.env.get("RPC_SOLANA")!, connectionConfig),
      quicknode: new Connection(Deno.env.get("RPC_QUICKNODE")!, connectionConfig),
      drpc: new Connection(Deno.env.get("RPC_DRPC")!, connectionConfig),
      ankr: new Connection(Deno.env.get("RPC_ANKR")!, connectionConfig),
      solanatracker: new Connection(Deno.env.get("RPC_SOLANATRACKER")!, connectionConfig),
    }
    this.keypair = Keypair.fromSecretKey(bs58.decode(this.options.walletSecretKey))
  }

  private normalizeTransaction(
    request: TradeRequest,
    tx: ParsedTransactionWithMeta,
  ): TradeAction {
    const solChange =
      ((tx.meta?.postBalances?.[0] ?? 0) - (tx.meta?.preBalances?.[0] ?? 0)) / 1e9
    const preToken =
      tx.meta?.preTokenBalances?.find((b) => b.accountIndex === 1)?.uiTokenAmount.uiAmount || 0
    const postToken =
      tx.meta?.postTokenBalances?.find((b) => b.accountIndex === 1)?.uiTokenAmount.uiAmount || 0
    const tokenChange = postToken - preToken

    const gas = (tx.meta?.fee ?? 0) / 1e9
    const rent = 0.00203928
    const apiFeeRatio = 0.005
    const tradingFeeRatio = 0.01

    // 3) Prepare the result object
    const result: TradeAction = {
      mint: request.mint,
      txType: request.action, // "buy" or "sell"
      tokenAmount: Math.abs(tokenChange),
      solAmount: 0,    // fill below
      feeAmount: 0,    // fill below
      tradePrice: 0,   // fill below
      newTokenBalance: postToken,
      marketCapSol: 0,
      timestamp: Date.now(),
    }

    if (request.action === "buy") {
      result.solAmount = request.amount
      result.feeAmount = gas + (request.amount * tradingFeeRatio) + (request.amount * apiFeeRatio) + rent
      result.tradePrice = request.amount / Math.abs(tokenChange)
    } else {
      const solAmount = (solChange + gas - rent) / (1 - apiFeeRatio - tradingFeeRatio)
      const apiFee = solAmount * (apiFeeRatio + tradingFeeRatio)
      result.tradePrice = solAmount / Math.abs(tokenChange)
      result.solAmount = solAmount
      result.feeAmount = gas + apiFee - rent
    }

    return result
  }


  async trade(request: TradeRequest): Promise<TradeAction> {
    const keypair = this.keypair!

    logger.info("[PumpPortalService] Attempting to sign and send transaction", { request })

    // 1. Create transaction from pumpportal.fun
    let response: Response
    try {
      response = await fetch(`https://pumpportal.fun/api/trade-local`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      })
    } catch (err) {
      logger.error("[PumpPortalService] Failed to reach pumpportal.fun", { err })
      // Unique short error message for "creating transaction" step
      throw new Error("Failed to create transaction from pumpportal.fun")
    }

    // Check for rate limit or other HTTP errors
    if (response.status === 429) {
      logger.error("[PumpPortalService] Rate limit from pumpportal.fun", { status: response.status })
      throw new Error("Rate limit 429 error from pumpportal.fun")
    } else if (!response.ok) {
      logger.error("[PumpPortalService] HTTP error from pumpportal.fun", {
        status: response.status,
        statusText: response.statusText,
      })
      throw new Error(`HTTP ${response.status} from pumpportal.fun - ${response.statusText}`)
    }

    // 2. Parse transaction data
    let data: ArrayBuffer
    try {
      data = await response.arrayBuffer()
    } catch (err) {
      logger.error("[PumpPortalService] Failed to parse transaction buffer", { err })
      throw new Error("Failed to parse transaction data from pumpportal.fun")
    }

    // 3. Deserialize and sign transaction
    let tx: VersionedTransaction
    try {
      tx = VersionedTransaction.deserialize(new Uint8Array(data))
      tx.sign([keypair])
    } catch (err) {
      logger.error("[PumpPortalService] Failed to deserialize or sign transaction", { err })
      throw new Error("Failed to deserialize/sign transaction from pumpportal.fun")
    }

    // 4. Send transaction to Solana
    let signature: string
    try {
      const t = Date.now()
      signature = await callWithConnectionList(
        (connection) => connection.sendTransaction(tx),
        [
          this.connections.quicknode,
          this.connections.solana,
          this.connections.solanatracker,
        ],
      )
      console.log(`[PumpPortalService] Transaction sent in ${Date.now() - t}ms`)
    } catch (err: unknown) {
      const message = (err as Error).message?.toLowerCase() || ''
      // Check if it's specifically a "preflight simulation" error
      if (message.includes("simulation")) {

        if (message.includes("The bonding curve has completed")) {
          throw new Error("Closing Raydium token")
        } else if (message.includes("too much sol required")) {
          throw new Error("Too much volatility")
        } else {
          logger.error("[PumpPortalService] Transaction preflight simulation error", { err })
        }

        throw new Error("Solana transaction preflight simulation error")
      }
      // Otherwise, some other send/connection error
      logger.error("[PumpPortalService] Transaction send error", { err })
      throw new Error("Failed to send transaction to Solana network")
    }

    // 5. Confirm transaction
    try {
      logger.info("[PumpPortalService] Transaction sent:", signature)

      const t1 = Date.now()
      const latestBlockhash = await callWithConnectionList(
        (connection) => connection.getLatestBlockhash("confirmed"),
        [
          this.connections.solanatracker,
          this.connections.quicknode,
          this.connections.drpc,
          this.connections.solana,
        ],
      )
      console.log(`[PumpPortalService] Latest blockhash in ${Date.now() - t1}ms`)
      const confirmationStrategy = {
        signature,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      }
      const t2 = Date.now()
      const confirmation = await callWithConnectionList(
        (connection) => connection.confirmTransaction(confirmationStrategy),
        [
          this.connections.solanatracker,
          this.connections.solana,
          this.connections.quicknode,
        ],
      )
      console.log(`[PumpPortalService] Transaction confirmed in ${Date.now() - t2}ms`)
      if (confirmation.value.err) {
        throw new Error("Transaction failure on Solana chain")
      }

      logger.info("[PumpPortalService] Transaction confirmed:", signature)
    } catch (err) {
      logger.error("[PumpPortalService] Transaction confirmation error", { err })
      throw new Error("Failed to confirm transaction on Solana")
    }

    // 6. Retrieve the parsed transaction to build a final trade report
    try {
      const txn = await callWithConnectionList(
        async (connection) => {
          const txn = await connection.getParsedTransaction(signature, {
            maxSupportedTransactionVersion: 0,
          })
          if (!txn) throw new Error("next connection")
          return txn
        },
        [
          this.connections.quicknode,
          this.connections.solanatracker,
          this.connections.drpc,
          this.connections.ankr,
          this.connections.solana,
        ],
      )
      return this.normalizeTransaction(request, txn!)
    } catch (err) {
      logger.error("[PumpPortalService] Get parsed transaction error", { err })
      // Make sure to differentiate from the preflight error above
      throw new Error("Failed to get parsed transaction on Solana")
    }
  }
}
