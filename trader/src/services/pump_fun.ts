import { bufferFromUInt64, callWithConnectionList, createVersionedTransaction } from '@/shared/solana.ts'
import { fetchWithProxy, isDryRun, logger } from '@/shared/utils.ts'
import { TradeAction } from '@/trader/interfaces.ts'
import {
  createAssociatedTokenAccountInstruction,
  createCloseAccountInstruction,
  getAssociatedTokenAddress,
  getMint,
  Mint
} from '@solana/spl-token'
import {
  AccountMeta,
  Connection,
  ConnectionConfig,
  Keypair,
  LAMPORTS_PER_SOL,
  ParsedTransactionWithMeta,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js'
import bs58 from 'bs58'
import { Buffer } from 'node:buffer'

export interface PumpFunOptions {
  walletSecretKey: string   // Base58 string or other secure format
}

export interface TradeRequest {
  publicKey: string
  action: "buy" | "sell"
  mint: string
  solAmount?: number
  tokenAmount?: number
  price?: number
  slippage: number
  priorityFee: number
  coinData?: CoinData
}

export enum TransactionMode {
  Simulation,
  Execution
}

export interface CoinData {
  bonding_curve: string
  associated_bonding_curve: string
  decimals: number
  virtual_sol_reserves?: number
  virtual_token_reserves?: number
}

export interface CoinComment {
  id: string
  text: string,
  user: string,
  timestamp: number,
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

  constructor(private options: PumpFunOptions) {
    if (isDryRun()) return
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
      chainstack: new Connection(Deno.env.get("RPC_CHAINSTACK")!, connectionConfig),
    }
    this.keypair = Keypair.fromSecretKey(bs58.decode(this.options.walletSecretKey))
  }

  public trade(request: TradeRequest): Promise<TradeAction> {
    if (request.action === "buy") {
      return this.pumpFunBuy(request)
    } else {
      return this.pumpFunSell(request)
    }
  }

  private normalizeTransaction(
    request: TradeRequest,
    tx: ParsedTransactionWithMeta,
  ): TradeAction {
    const publicKey = this.keypair!.publicKey.toBase58()
    const solChange =
      ((tx.meta?.postBalances?.[0] ?? 0) - (tx.meta?.preBalances?.[0] ?? 0)) / 1e9
    const preToken =
      tx.meta?.preTokenBalances?.find((b) => b.owner === publicKey)?.uiTokenAmount.uiAmount || 0
    const postToken =
      tx.meta?.postTokenBalances?.find((b) => b.owner === publicKey)?.uiTokenAmount.uiAmount || 0
    const tokenChange = postToken - preToken

    const gas = (tx.meta?.fee ?? 0) / 1e9
    const rent = 0.00203928
    const apiFeeRatio = 0
    const tradingFeeRatio = 0.01

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
      result.solAmount = request.solAmount!
      result.feeAmount = gas + (request.solAmount! * tradingFeeRatio) + (request.solAmount! * apiFeeRatio) + rent
      result.tradePrice = request.solAmount! / Math.abs(tokenChange)
    } else {
      const solAmount = (solChange + gas - rent) / (1 - apiFeeRatio - tradingFeeRatio)
      const apiFee = solAmount * (apiFeeRatio + tradingFeeRatio)
      result.tradePrice = solAmount / Math.abs(tokenChange)
      result.solAmount = solAmount
      result.feeAmount = gas + apiFee - rent
    }

    return result
  }

  private async sendAndConfirmTransactionWrapper(tx: VersionedTransaction): Promise<ParsedTransactionWithMeta> {
    let signature: string
    try {
      const t = Date.now()
      signature = await callWithConnectionList(
        (connection) => connection.sendTransaction(tx, {
          skipPreflight: false,
        }),
        [
          this.connections.quicknode,
          this.connections.solana,
          this.connections.solanatracker,
          this.connections.chainstack,
        ],
      )
      logger.info(`[PumpPortalService] Transaction sent in ${Date.now() - t}ms`)
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
        (connection) => connection.getLatestBlockhash('processed'),
        [
          this.connections.quicknode,
          this.connections.solanatracker,
          this.connections.solana,
          this.connections.chainstack,
          this.connections.drpc,
        ],
      )
      logger.info(`[PumpPortalService] Latest blockhash in ${Date.now() - t1}ms`)
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
          this.connections.chainstack,
        ],
      )
      logger.info(`[PumpPortalService] Transaction confirmed in ${Date.now() - t2}ms`)
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
          this.connections.solanatracker,
          this.connections.quicknode,
          this.connections.solana,
          this.connections.drpc,
          this.connections.ankr,
        ],
      )
      return txn
    } catch (err) {
      logger.error("[PumpPortalService] Get parsed transaction error", { err })
      // Make sure to differentiate from the preflight error above
      throw new Error("Failed to get parsed transaction on Solana")
    }
  }

  private async pumpFunBuy(request: TradeRequest): Promise<TradeAction> {
    const { mint: mintStr, solAmount, slippage, priorityFee } = request
    let coinData = request.coinData ?? null

    if (
      !mintStr ||
      solAmount === undefined ||
      slippage === undefined ||
      priorityFee === undefined
    ) {
      throw new Error('Missing required trade parameters.')
    }

    const mint = new PublicKey(mintStr)

    const payer = this.keypair!
    const owner = payer.publicKey
    const txBuilder = new Transaction()
    let tokenAccount: PublicKey
    
    const tokenAccountAddress = await getAssociatedTokenAddress(
      mint,
      owner,
      false
    )

    const tokenAccountInfo = await callWithConnectionList(
      (connection) => connection.getAccountInfo(tokenAccountAddress),
      [
        this.connections.quicknode,
        this.connections.solana,
        this.connections.solanatracker,
        this.connections.drpc,
      ],
    )

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

    const solInLamports = solAmount! * LAMPORTS_PER_SOL
    let price
    if (!request.price) {
      const coin = await getCoinData(mintStr)
      const mint = await this.getMintInfo(mintStr)
      coinData = {
        ...coin,
        decimals: mint.decimals,
      }
      price = coinData.virtual_sol_reserves! / coinData.virtual_token_reserves!
    } else {
      price = request.price * (LAMPORTS_PER_SOL / 10 ** coinData!.decimals)
    }
    const tokenOut = Math.floor(solInLamports / price)

    const solInWithSlippage = solAmount! * (1 + (slippage / 100))
    const maxSolCost = Math.floor(solInWithSlippage * LAMPORTS_PER_SOL)
    const ASSOCIATED_USER = tokenAccount
    const USER = owner
    const BONDING_CURVE = new PublicKey(coinData!.bonding_curve)
    const ASSOCIATED_BONDING_CURVE = new PublicKey(coinData!.associated_bonding_curve)

    const keys: AccountMeta[] = [
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

    const blockhash = await this.getBlockHashFromPumpPortal(request)
    const transaction = createVersionedTransaction(blockhash, txBuilder.instructions, payer.publicKey, priorityFee, 80_000)
    transaction.sign([payer])
    const txn = await this.sendAndConfirmTransactionWrapper(transaction)
    return this.normalizeTransaction(request, txn)
  }


  private async pumpFunSell(request: TradeRequest): Promise<TradeAction> {
    const { mint: mintStr, tokenAmount, slippage, priorityFee } = request
    let coinData = request.coinData ?? null

    // Validate inputs
    if (
      !mintStr ||
      tokenAmount === undefined ||
      slippage === undefined ||
      priorityFee === undefined
    ) {
      throw new Error('Missing required trade parameters.')
    }


    const mint = new PublicKey(mintStr)

    const payer = this.keypair!
    const owner = payer.publicKey

    const tokenAccounts = await callWithConnectionList(
      (connection) => connection.getParsedTokenAccountsByOwner(
        owner,
        { programId: TOKEN_PROGRAM_ID }
      ),
      [
        this.connections.quicknode,
        this.connections.solanatracker,
        this.connections.drpc,
        this.connections.solana,
      ],
    )

    const tokenAccount = tokenAccounts.value.find(({ account }) => {
      const parsedInfo = account.data.parsed.info
      return parsedInfo.mint === mintStr
    })
    if (!tokenAccount) {
      logger.error("Token account not found", { tokenAccounts, mint })
      throw new Error("Token account not found")
    }
    const parsedTokenInfo = tokenAccount.account.data.parsed.info
    const { amount: tokenBalanceString, decimals: tokenDecimals } = parsedTokenInfo.tokenAmount
    const tokenBalance = Number(tokenBalanceString)
    const tokenAmountRaw = Math.floor(tokenAmount * 10 ** tokenDecimals)
    logger.info({
      tokenBalance,
      tokenAmountRaw,
    })

    // Calculate minimum SOL output based on slippage
    const slippageDecimal = slippage / 100
    let price
    if (!request.price) {
      const coin = await getCoinData(mintStr)
      coinData = {
        ...coin,
        decimals: tokenDecimals,
      }
      price = coinData.virtual_sol_reserves! / coinData.virtual_token_reserves!
    } else {
      price = request.price * (LAMPORTS_PER_SOL / (10 ** tokenDecimals))
    }

    const minSolOutput = Math.floor(
      tokenAmountRaw * (1 - slippageDecimal) * price
    )

    const txBuilder = new Transaction()

    if (tokenBalance === 0) {
      logger.info("Closing empty token account: ", tokenAccount.pubkey.toBase58())
      txBuilder.add(
        createCloseAccountInstruction(
          tokenAccount.pubkey,
          payer.publicKey,
          payer.publicKey,
        )
      )
    } else {
      const keys: AccountMeta[] = [
        { pubkey: GLOBAL, isSigner: false, isWritable: false },
        { pubkey: FEE_RECIPIENT, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: new PublicKey(coinData!.bonding_curve), isSigner: false, isWritable: true },
        { pubkey: new PublicKey(coinData!.associated_bonding_curve), isSigner: false, isWritable: true },
        { pubkey: tokenAccount.pubkey, isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: false, isWritable: true },
        { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: ASSOC_TOKEN_ACC_PROG, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: PUMP_FUN_ACCOUNT, isSigner: false, isWritable: false },
        { pubkey: PUMP_FUN_PROGRAM, isSigner: false, isWritable: false }
      ]

      const data = Buffer.concat([
        bufferFromUInt64("12502976635542562355"), // Instruction identifier for 'sell' action
        bufferFromUInt64(tokenAmountRaw),
        bufferFromUInt64(minSolOutput)
      ])

      const instruction = new TransactionInstruction({
        keys: keys,
        programId: PUMP_FUN_PROGRAM,
        data: data
      })
      txBuilder.add(instruction)

      if (tokenBalance === tokenAmountRaw) {
        logger.info("Closing token account: ", tokenAccount.pubkey.toBase58())
        txBuilder.add(
          createCloseAccountInstruction(
            tokenAccount.pubkey,
            payer.publicKey,
            payer.publicKey,
          )
        )
      }
    }

    const blockhash = await this.getBlockHashFromPumpPortal(request)
    const transaction = createVersionedTransaction(blockhash, txBuilder.instructions, payer.publicKey, priorityFee, 60_000)
    transaction.sign([payer])
    const txn = await this.sendAndConfirmTransactionWrapper(transaction)
    return this.normalizeTransaction(request, txn)
  }

  async getSolBalance(): Promise<number> {
    const balance = await this.connections.quicknode.getBalance(this.keypair!.publicKey)
    return balance / LAMPORTS_PER_SOL
  }

  async getMintInfo(mint: string): Promise<Mint> {
    return await callWithConnectionList(
      (connection) => getMint(connection, new PublicKey(mint), 'processed', TOKEN_PROGRAM_ID),
      [
        this.connections.quicknode,
        this.connections.solanatracker,
        this.connections.solana,
        this.connections.drpc,
      ],
    )
  }


  async getBlockHashFromPumpPortal(request: TradeRequest) {
    const response = await fetch(`https://pumpportal.fun/api/trade-local`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        "publicKey": this.keypair!.publicKey.toBase58(),
        "action": request.action,
        "mint": request.mint,
        "denominatedInSol": request.action === "buy" ? "true" : "false",
        "amount": (request.action === "buy" ? request.solAmount : request.tokenAmount) || 0.01,
        "slippage": request.slippage,
        "priorityFee": request.priorityFee,
        "pool": "pump"
      })
    })

    if (response.status === 200) {
      const data = await response.arrayBuffer()
      const tx = VersionedTransaction.deserialize(new Uint8Array(data))
      return tx.message.recentBlockhash
    } else {
      logger.error("PumpPortal error", { status: response.status, statusText: response.statusText, body: await response.text() })
      throw new Error("Failed to get block hash from pump portal")
    }
  }
}

export async function getCoinData(mintStr: string): Promise<CoinData> {
  try {
    const url = `https://frontend-api.pump.fun/coins/${mintStr}`
    const response = await fetch(url, {
      headers: {
        "Accept-Language": "en-US,en;q=0.5",
        "Accept-Encoding": "gzip, deflate, br",
        "Referer": "https://www.pump.fun/",
        "Origin": "https://www.pump.fun",
        "Connection": "keep-alive",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "cross-site",
      }
    })

    // Check if the response is OK (status in 200–299 range)
    if (!response.ok) {
      if (response.status === 429 || response.statusText.toLocaleLowerCase().includes("too many requests")) {
        const proxyResponse = await fetchWithProxy(url, { headers: response.headers })
        const data = await JSON.parse(proxyResponse) as CoinData
        return data
      } else {
        logger.error(`Failed to retrieve coin data: ${response.status} ${response.statusText}`)
        throw new Error("Failed to retrieve coin data")
      }
    } else {
      const data = await response.json() as CoinData
      return data
    }
  } catch (error) {
    logger.error("Error fetching coin data:", error)
    throw new Error("Failed to retrieve coin data")
  }
}

export async function getCoinComments(mintStr: string): Promise<CoinComment[]> {
  try {
    const url = `https://frontend-api-v2.pump.fun/replies/${mintStr}?limit=1000&offset=0`
    const response = await fetch(url, {
      headers: {
        "Accept-Language": "en-US,en;q=0.5",
        "Accept-Encoding": "gzip, deflate, br",
        "Referer": "https://www.pump.fun/",
        "Origin": "https://www.pump.fun",
        "Connection": "keep-alive",
      }
    })

    let data: { replies: CoinComment[] }
    // Check if the response is OK (status in 200–299 range)
    if (!response.ok) {
      if (response.status === 429 || response.statusText.toLocaleLowerCase().includes("too many requests")) {
        const proxyResponse = await fetchWithProxy(url, { headers: response.headers })
        data = await JSON.parse(proxyResponse)
      } else {
        logger.error(`Failed to retrieve coin data: ${response.status} ${response.statusText}`)
        throw new Error("Failed to retrieve coin data")
      }
    } else {
      data = await response.json()
    }

    return data.replies
  } catch (error) {
    logger.error("Error fetching coin data:", error)
    throw new Error("Failed to retrieve coin data")
  }
}