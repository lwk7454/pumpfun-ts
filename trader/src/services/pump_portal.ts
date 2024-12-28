import { Keypair, VersionedTransaction, Connection, ParsedTransactionWithMeta, sendAndConfirmRawTransaction } from '@solana/web3.js'
import bs58 from 'bs58'
import { TradeAction } from '@/trader/interfaces.ts'
import { logger } from '@/shared/utils.ts'
import { Buffer } from 'node:buffer'

export interface PumpPortalOptions {
  rpcEndpoint: string
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
  private connection: Connection | null = null
  private keypair: Keypair | null = null

  constructor(private options: PumpPortalOptions, dryRun = false) {
    if (dryRun) return
    this.connection = new Connection(this.options.rpcEndpoint, "confirmed")
    this.keypair = Keypair.fromSecretKey(bs58.decode(this.options.walletSecretKey))
  }

  private normalizeTransaction(
    request: TradeRequest,
    tx: ParsedTransactionWithMeta,
  ): TradeAction {
    const solChange =
      ((tx.meta?.postBalances[0] || 0) - (tx.meta?.preBalances[0] || 0)) / 10e9
    const tokenChange =
      (tx.meta?.postTokenBalances?.find(b => b.accountIndex === 1)?.uiTokenAmount.uiAmount || 0) -
      (tx.meta?.preTokenBalances?.find(b => b.accountIndex === 1)?.uiTokenAmount.uiAmount || 0)

    let solAmount = 0
    if (request.action === "buy") {
      solAmount = request.amount
    } else if (request.action === "sell") {
      const gasFee = (tx.meta?.fee || 0) / 10e9
      const priorityFee = request.priorityFee || 0
      solAmount = (solChange + gasFee + priorityFee) / 0.985
    }

    const result = {
      mint: request.mint,
      txType: request.action,
      tokenAmount: Math.abs(tokenChange),
      solAmount,
      feeAmount: Math.abs(solAmount - solChange),
      tradePrice: tokenChange ? (solAmount / Math.abs(tokenChange)) : 0,
      newTokenBalance: tx.meta?.postTokenBalances?.find(b => b.accountIndex === 1)?.uiTokenAmount.uiAmount || 0,
      marketCapSol: 0, // TODO
      timestamp: Date.now(),
    }

    return result
  }

  async trade(request: TradeRequest): Promise<TradeAction> {
    const keypair = this.keypair!
    const connection = this.connection!

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
      const rawTx = Buffer.from(tx.serialize())
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
      const tempSig = bs58.encode(tx.signatures[0])
      const confirmationStrategy = {
        blockhash,
        lastValidBlockHeight,
        signature: tempSig,
        //  `commitment`, `preflightCommitment`, etc.
      };

      signature = await sendAndConfirmRawTransaction(connection, rawTx, confirmationStrategy)

      logger.info("[PumpPortalService] Transaction confirmed:", signature)
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

    // 6. Retrieve the parsed transaction to build a final trade report
    try {
      const txn = await connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
      })

      return this.normalizeTransaction(request, txn!)
    } catch (err) {
      logger.error("[PumpPortalService] Transaction confirmation error", { err })
      // Make sure to differentiate from the preflight error above
      throw new Error("Failed to confirm transaction on Solana")
    }
  }
}
