import { Buffer } from 'node:buffer'
import { callWithConnectionList, getKeyPairFromPrivateKey } from '@/shared/solana.ts'
import { logger } from '@/shared/utils.ts'
import { TradeAction } from '@/trader/interfaces.ts'
import {
  Connection,
  ConnectionConfig,
  Keypair,
  ParsedTransactionWithMeta,
  PublicKey,
  VersionedTransaction,
  SystemProgram,
} from '@solana/web3.js'
import bs58 from 'bs58'
import { createAssociatedTokenAccountInstruction, getAssociatedTokenAddress } from '@solana/spl-token'
import { Transaction } from '@solana/web3.js'
import { LAMPORTS_PER_SOL } from '@solana/web3.js'
import { bufferFromUInt64 } from '@/shared/solana.ts'
import { TransactionInstruction } from '@solana/web3.js'
import { createVersionedTransaction } from '@/shared/solana.ts'

export interface PumpFunOptions {
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

export enum TransactionMode {
  Simulation,
  Execution
}

export const GLOBAL = new PublicKey("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf")
export const FEE_RECIPIENT = new PublicKey("CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM")
export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
export const ASSOC_TOKEN_ACC_PROG = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
export const RENT = new PublicKey("SysvarRent111111111111111111111111111111111")
export const PUMP_FUN_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P")
export const PUMP_FUN_ACCOUNT = new PublicKey("Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1")
export const SYSTEM_PROGRAM_ID = SystemProgram.programId

export class PumpFunService {
  private connections: Record<string, Connection> = {}
  private keypair: Keypair | null = null

  constructor(private options: PumpFunOptions, dryRun = false) {
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


  async sendAndConfirmTransactionWrapper(tx: VersionedTransaction): Promise<ParsedTransactionWithMeta> {
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

    // Confirm transaction
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

    // Retrieve the parsed transaction to build a final trade report
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
      return txn
    } catch (err) {
      logger.error("[PumpPortalService] Get parsed transaction error", { err })
      // Make sure to differentiate from the preflight error above
      throw new Error("Failed to get parsed transaction on Solana")
    }
  }

  async pumpFunBuy(request: TradeRequest): Promise<TradeAction> {
    const { mint: mintStr, amount, slippage, priorityFee } = request

    const mint = new PublicKey(mintStr)
    const coinData = await getCoinData(mintStr)
    if (!coinData) {
      throw new Error("Failed to retrieve coin data...")
    }

    const payer = await getKeyPairFromPrivateKey(this.options.walletSecretKey)
    const owner = payer.publicKey

    const txBuilder = new Transaction()

    const tokenAccountAddress = await getAssociatedTokenAddress(
      mint,
      owner,
      false
    )

    const tokenAccountInfo = await callWithConnectionList(
      (connection) => connection.getAccountInfo(tokenAccountAddress),
      [
        this.connections.drpc,
        this.connections.quicknode,
        this.connections.solana,
        this.connections.solanatracker,
      ],
    )

    let tokenAccount: PublicKey
    if (!tokenAccountInfo) {
      txBuilder.add(
        createAssociatedTokenAccountInstruction(
          payer.publicKey,
          tokenAccountAddress,
          payer.publicKey,
          mint
        )
      )
      tokenAccount = tokenAccountAddress
    } else {
      tokenAccount = tokenAccountAddress
    }

    const solInLamports = amount * LAMPORTS_PER_SOL
    const tokenOut = Math.floor(solInLamports * coinData["virtual_token_reserves"] / coinData["virtual_sol_reserves"])

    const solInWithSlippage = amount * (1 + (slippage / 100))
    const maxSolCost = Math.floor(solInWithSlippage * LAMPORTS_PER_SOL)
    const ASSOCIATED_USER = tokenAccount
    const USER = owner
    const BONDING_CURVE = new PublicKey(coinData['bonding_curve'])
    const ASSOCIATED_BONDING_CURVE = new PublicKey(coinData['associated_bonding_curve'])

    const keys = [
      { pubkey: GLOBAL, isSigner: false, isWritable: false },
      { pubkey: FEE_RECIPIENT, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: BONDING_CURVE, isSigner: false, isWritable: true },
      { pubkey: ASSOCIATED_BONDING_CURVE, isSigner: false, isWritable: true },
      { pubkey: ASSOCIATED_USER, isSigner: false, isWritable: true },
      { pubkey: USER, isSigner: false, isWritable: true },
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: RENT, isSigner: false, isWritable: false },
      { pubkey: PUMP_FUN_ACCOUNT, isSigner: false, isWritable: false },
      { pubkey: PUMP_FUN_PROGRAM, isSigner: false, isWritable: false },
    ]

    const data = Buffer.concat([
      bufferFromUInt64("16927863322537952870"),
      bufferFromUInt64(tokenOut),
      bufferFromUInt64(maxSolCost)
    ])

    const instruction = new TransactionInstruction({
      keys: keys,
      programId: PUMP_FUN_PROGRAM,
      data: data
    })
    txBuilder.add(instruction)

    const transaction = await callWithConnectionList(
      (connection) => createVersionedTransaction(connection, txBuilder.instructions, payer.publicKey, priorityFee),
      [
        this.connections.quicknode,
        this.connections.solanatracker,
        this.connections.solana,
      ],
    )

    const txn = await this.sendAndConfirmTransactionWrapper(transaction)
    return this.normalizeTransaction(request, txn)
  }


  async pumpFunSell(request: TradeRequest): Promise<TradeAction> {
    const { mint: mintStr, amount, slippage, priorityFee } = request

    const mint = new PublicKey(mintStr)
    const coinData = await getCoinData(mintStr)
    if (!coinData) {
      throw new Error("Failed to retrieve coin data...")
    }

    const payer = await getKeyPairFromPrivateKey(this.options.walletSecretKey)
    const owner = payer.publicKey

    const txBuilder = new Transaction()

    const tokenAccountAddress = await getAssociatedTokenAddress(
      mint,
      owner,
      false
    )

    const tokenAccountInfo = await callWithConnectionList(
      (connection) => connection.getAccountInfo(tokenAccountAddress),
      [
        this.connections.drpc,
        this.connections.quicknode,
        this.connections.solana,
        this.connections.solanatracker,
      ],
    )

    let tokenAccount: PublicKey
    if (!tokenAccountInfo) {
      txBuilder.add(
        createAssociatedTokenAccountInstruction(
          payer.publicKey,
          tokenAccountAddress,
          payer.publicKey,
          mint
        )
      )
      tokenAccount = tokenAccountAddress
    } else {
      tokenAccount = tokenAccountAddress
    }

    // Calculate minimum SOL output based on slippage
    const slippageDecimal = slippage / 100
    const tokenBalance = amount // Ensure 'amount' represents the token balance to sell
    const minSolOutput = Math.floor(
      tokenBalance * (1 - slippageDecimal) * coinData["virtual_sol_reserves"] / coinData["virtual_token_reserves"]
    )

    const keys = [
      { pubkey: GLOBAL, isSigner: false, isWritable: false },
      { pubkey: FEE_RECIPIENT, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: new PublicKey(coinData['bonding_curve']), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(coinData['associated_bonding_curve']), isSigner: false, isWritable: true },
      { pubkey: tokenAccount, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: true },
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOC_TOKEN_ACC_PROG, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: PUMP_FUN_ACCOUNT, isSigner: false, isWritable: false },
      { pubkey: PUMP_FUN_PROGRAM, isSigner: false, isWritable: false }
    ]

    const data = Buffer.concat([
      bufferFromUInt64("12502976635542562355"), // Instruction identifier for 'sell' action
      bufferFromUInt64(tokenBalance),
      bufferFromUInt64(minSolOutput)
    ])

    const instruction = new TransactionInstruction({
      keys: keys,
      programId: PUMP_FUN_PROGRAM,
      data: data
    })
    txBuilder.add(instruction)

    // Create a VersionedTransaction using the updated utility function
    const transaction = await callWithConnectionList(
      (connection) => createVersionedTransaction(connection, txBuilder.instructions, payer.publicKey, priorityFee),
      [
        this.connections.quicknode,
        this.connections.solana,
        this.connections.solanatracker,
      ],
    )

    // Send and confirm the transaction
    const txn = await this.sendAndConfirmTransactionWrapper(transaction)
    return this.normalizeTransaction(request, txn)
  }
}

export async function getCoinData(mintStr: string) {
  try {
    const url = `https://frontend-api.pump.fun/coins/${mintStr}`
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.5",
        "Accept-Encoding": "gzip, deflate, br",
        "Referer": "https://www.pump.fun/",
        "Origin": "https://www.pump.fun",
        "Connection": "keep-alive",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "cross-site",
        "If-None-Match": 'W/"43a-tWaCcS4XujSi30IFlxDCJYxkMKg"'
      }
    })

    // Check if the response is OK (status in 200–299 range)
    if (!response.ok) {
      logger.error(`Failed to retrieve coin data: ${response.status} ${response.statusText}`)
      return null
    }

    // Parse and return JSON
    const data = await response.json()
    return data
  } catch (error) {
    logger.error("Error fetching coin data:", error)
    return null
  }
}