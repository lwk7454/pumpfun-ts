import { Keypair, VersionedTransaction, Connection, ParsedTransactionWithMeta } from '@solana/web3.js'
import bs58 from 'bs58'
import { TradeAction } from '@/trader/interfaces.ts';
import { fetchWithRetry } from '@/shared/utils.ts';

export interface TradePortalOptions {
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

export class TradePortalService {
  private connection: Connection | null = null
  private keypair: Keypair | null = null

  constructor(private options: TradePortalOptions) {
    this.connection = new Connection(this.options.rpcEndpoint, "confirmed")
    this.keypair = Keypair.fromSecretKey(bs58.decode(this.options.walletSecretKey))
  }

  private normalizeTransaction(request: TradeRequest, tx: ParsedTransactionWithMeta): TradeAction {
    const solChange = (tx.meta?.postBalances[0] || 0) - (tx.meta?.preBalances[0] || 0)
    const tokenChange = (tx.meta?.postTokenBalances?.at(0)?.uiTokenAmount.uiAmount || 0) - (tx.meta?.preTokenBalances?.at(0)?.uiTokenAmount.uiAmount || 0)

    return {
      mint: request.mint,
      txType: request.action,
      tokenDelta: tokenChange,
      solDelta: solChange,
      newTokenBalance: tx.meta?.postTokenBalances?.at(0)?.uiTokenAmount.uiAmount || 0,
      marketCapSol: 0,
      timestamp: Date.now(),
    }
  }

  async trade(request: TradeRequest): Promise<TradeAction> {
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
    console.log("[TradePortalService] Transaction data:", data)
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

      console.log("[TradePortalService] Transaction confirmed:", confirmation)

      const txn = await connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
      })

      console.log("[TradePortalService] Transaction details:", txn)
      return this.normalizeTransaction(request, txn!)
    } catch (err) {
      throw new Error(`[TradePortalService] Transaction failed. Error: ${err}`)
    }
  }
}