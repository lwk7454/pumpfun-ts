// worker.ts
import { Decision, StrategyConstructor, TradeAction } from '@/trader/interfaces.ts'
import { Strategy, TokenEvent } from "@/trader/interfaces.ts"
import { InfluxService } from "./services/influx_db.ts"
import { CoinData, getCoinData, PumpFunService } from "./services/pump_fun.ts"
import { Master } from '@/trader/master.ts'
import { isDryRun, logger, shorten } from '@/shared/utils.ts'

export interface WorkerConfig {
  initEvent: TokenEvent
  strategy: StrategyConstructor
  baseBid: number
  traderAddress: string   // Public key of your wallet
  defaultSlippage: number
  priorityFee: number
  influx: InfluxService // trade bucket, not market bucket
  pumpFun: PumpFunService
}

export type WorkerCommand = {
  type: "marketCapUpdate"
  event: TokenEvent
} | {
  type: "heartbeat" | "force_close"
}

export type WorkerResult = {
  mint: string
  solDelta: number
  tokenDelta: number
  feeTotal: number
  tradedSol: number
}

export class TokenWorker {
  private strategy: Strategy
  private tokenMint: string
  private isComplete = false
  // All token events, including actions by worker
  private events: TokenEvent[] = []
  // Worker actions history triggered by strategy
  private actions: TradeAction[] = []

  // Queue related properties
  private commandQueue: WorkerCommand[] = []
  private isProcessing = false

  public boughtTokens: number = 0
  private coinData: CoinData | null = null
  private startTime: number = Date.now()

  constructor(private config: WorkerConfig, private master: Master) {
    this.strategy = new config.strategy(this.events, this.actions, this.config.baseBid)
    this.tokenMint = this.config.initEvent.mint
    this.events.push(this.config.initEvent)
    this.handleMarketCapUpdate(this.config.initEvent)
  }

  private updateBoughtTokenAmount(action: TradeAction): void {
    this.boughtTokens += (action.txType === "buy" ? action.tokenAmount : -action.tokenAmount)
    if (this.boughtTokens > 0) {
      this.master.openPosition(this)
    } else {
      this.master.closePosition(this)
    }
  }

  private async heartbeat(): Promise<void> {
    if (this.isComplete) return

    // if no actions, close after timeout
    const timeElapsed = Date.now() - this.startTime
    if (this.actions.length === 0 && timeElapsed > 1000 * 60 * 20) {
      this.handleDecision({ action: "close" })
    }

    const decision = await this.strategy.onHeartbeat()
    return await this.handleDecision(decision)
  }

  public enqueueCommand(command: WorkerCommand): void {
    this.commandQueue.push(command)
    if (!this.isProcessing) {
      this.processQueue()
    }
  }

  private async processQueue(): Promise<void> {
    this.isProcessing = true

    while (this.commandQueue.length > 0 && !this.isComplete) {
      const command = this.commandQueue.shift()!
      if (command.type === "marketCapUpdate") {
        this.events.push(command.event)
      } else if (command.type === "force_close") {
        if(this.boughtTokens > 0) await this.handleDecision({ action: "sell", amount: this.boughtTokens })
        await this.handleDecision({ action: "close" })
      }
      if (this.commandQueue.length !== 0) continue

      if (command.type === "marketCapUpdate") {
        await this.handleMarketCapUpdate(command.event)
      } else if (command.type === "heartbeat") {
        await this.heartbeat()
      }
    }

    this.isProcessing = false
  }

  private mapActionToEvent(action: TradeAction): TokenEvent {
    return {
      mint: action.mint,
      txType: action.txType,
      tokenAmount: action.tokenAmount,
      solAmount: action.solAmount,
      marketCapSol: action.marketCapSol,
      timestamp: action.timestamp,
    }
  }

  public async handleMarketCapUpdate(event: TokenEvent): Promise<void> {
    if (this.isComplete) return
    if (event.traderPublicKey === this.config.traderAddress) return
    const decision = await this.strategy.onMarketCapUpdate(event)

    await this.handleDecision(decision)
  }

  private async handleDecision(decision: Decision): Promise<void> {
    let result = null
    const { action, amount } = decision
    if (action === "buy" && this.master.allowBuy()) {
      result = await this.buyToken(amount!)
    } else if (action === "sell") {
      result = await this.sellToken(amount!)
    } else if (action === "close") {
      this.isComplete = true
      this.master.onWorkerComplete(this.generateReport())
    }

    if (result) {
      this.events.push(this.mapActionToEvent(result))
      this.actions.push(result)
      this.updateBoughtTokenAmount(result)
    }
  }

  private generateReport(): WorkerResult {
    let solDelta = 0
    let tokenDelta = 0
    let feeTotal = 0
    let tradedSol = 0
    this.actions.forEach(action => {
      // logger.info(`[TokenWorker] Token: ${this.tokenMint} Action: ${action.txType} Token: ${action.tokenAmount} Sol: ${action.solAmount} Fee: ${action.feeAmount}`)
      solDelta += (action.txType === "buy" ? -action.solAmount : action.solAmount) - action.feeAmount
      tokenDelta += (action.txType === "buy" ? action.tokenAmount : -action.tokenAmount)
      feeTotal += action.feeAmount
      tradedSol += action.solAmount
    })

    return {
      mint: this.tokenMint,
      solDelta,
      tokenDelta,
      feeTotal,
      tradedSol,
    }
  }

  private getPrice() {
    const lastEvent = this.events.at(-1)!
    return lastEvent.solAmount / lastEvent.tokenAmount
  }

  private async setCoinData(){
    try {
      const { bonding_curve, associated_bonding_curve } = await getCoinData(this.tokenMint)
      const { decimals } = await this.config.pumpFun.getMintInfo(this.tokenMint)
      this.coinData = {
        bonding_curve,
        associated_bonding_curve,
        decimals,
      }
    } catch (err) {
      logger.error(`[TokenWorker] Failed to set coin data for ${this.tokenMint}`, err)
      throw new Error(`[TokenWorker] Failed to set coin data for ${this.tokenMint}`)
    }
  }

  private async buyToken(solAmount: number): Promise<TradeAction | null> {
    if (isDryRun()) {

      const lastEvent = this.events.at(-1)!
      const lastPrice = lastEvent.solAmount / lastEvent.tokenAmount
      const gasCost = 0.00003 // TODO: get from config
      const fees = solAmount * 0.01 + this.config.priorityFee + gasCost

      logger.info(`[TokenWorker] ${new Date().toISOString()} Dry-run: BUY for ${shorten(this.tokenMint)} @ ${lastPrice}`)
      return {
        mint: this.tokenMint,
        txType: "buy",
        tokenAmount: solAmount / lastPrice,
        solAmount,
        feeAmount: fees,
        tradePrice: lastPrice,
        newTokenBalance: 0, // TODO
        marketCapSol: 0, // TODO
        timestamp: Date.now(),
      }
    }

    if (!this.coinData) await this.setCoinData()

    try {
      const result = await this.config.pumpFun.trade({
        publicKey: this.config.traderAddress,
        action: "buy",
        mint: this.tokenMint,
        solAmount,
        slippage: this.config.defaultSlippage,
        priorityFee: this.config.priorityFee,
        price: this.getPrice(),
        coinData: this.coinData!,
      })

      logger.info(`[TokenWorker] BUY transaction successful: `, result)

      await this.config.influx.recordTradeEvent({
        _measurement: "trade",
        _time: new Date().toISOString(),
        token: this.tokenMint,
        strategy: this.config.strategy.constructor.name,
        action: "buy",
        tokenAmount: result.tokenAmount,
        solAmount: result.solAmount,
        feeAmount: result.feeAmount,
        tradePrice: result.tradePrice,
        timestamp: Date.now(),
      })
      return result
    } catch (err) {
      const message = (err as Error).message?.toLowerCase() || ''
      if (message.includes("raydium token") || message.includes("bonding curve has completed")) {
        logger.error("[TokenWorker] Closing Raydium token", { mint: this.tokenMint })
        this.handleDecision({ action: "close" })
      } else if (message.includes("preflight simulation")) {
        logger.error("[TokenWorker] Closing worker because unable to buy", { mint: this.tokenMint })
        this.handleDecision({ action: "close" })
      } else if (message.includes("too much volatility")) {
        logger.error("[TokenWorker] Closing worker because too much volatility", { mint: this.tokenMint })
        this.handleDecision({ action: "close" })
      } else {
        logger.error(`[TokenWorker] Failed to BUY ${shorten(this.tokenMint)}:`, err)
        this.handleDecision({ action: "close" }) // should we close for unknown error?
      }
      return null
    }
  }

  private async sellToken(tokenAmount: number): Promise<TradeAction | null> {
    if (isDryRun()) {

      const lastEvent = this.events.at(-1)!
      const lastPrice = lastEvent.solAmount / lastEvent.tokenAmount
      const solAmount = tokenAmount * lastPrice
      const gasCost = 0.00003 // TODO: get from config
      const fees = solAmount * 0.01 + gasCost

      logger.info(`[TokenWorker] ${new Date().toISOString()} Dry-run: SELL for ${shorten(this.tokenMint)} @ ${lastPrice}`)
      return {
        mint: this.tokenMint,
        txType: "sell",
        tokenAmount,
        solAmount,
        feeAmount: fees,
        tradePrice: lastPrice,
        newTokenBalance: 0, // TODO
        marketCapSol: 0, // TODO
        timestamp: Date.now(),
      }
    }

    if (!this.coinData) await this.setCoinData()

    try {
      const result = await this.config.pumpFun.trade({
        publicKey: this.config.traderAddress,
        action: "sell",
        mint: this.tokenMint,
        tokenAmount,
        slippage: this.config.defaultSlippage,
        priorityFee: this.config.priorityFee,
        price: this.getPrice(),
        coinData: this.coinData!,
      })

      logger.info(`[TokenWorker] SELL transaction successful: `, result)

      await this.config.influx.recordTradeEvent({
        _measurement: "trade",
        _time: new Date().toISOString(),
        token: this.tokenMint,
        strategy: this.config.strategy.constructor.name,
        action: "sell",
        tokenAmount: result.tokenAmount,
        solAmount: result.solAmount,
        feeAmount: result.feeAmount,
        tradePrice: result.tradePrice,
        timestamp: Date.now(),
      })
      return result
    } catch (err) {
      const message = (err as Error).message?.toLowerCase() || ''

      // if transaction simulation failed, close this worker
      if (message.includes("preflight simulation")) {
        logger.warn(`[TokenWorker] Closing worker because unable to sell`, { mint: this.tokenMint })
        this.handleDecision({ action: "close" })
      } else if (message.includes("bonding curve has completed")) {
        logger.warn(`[TokenWorker] Bonding curve has completed`, { mint: this.tokenMint })
        this.handleDecision({ action: "close" })
      } else if (message.includes("token account not found")) {
        this.handleDecision({ action: "close" })
      } else {
        logger.error(`[TokenWorker] Failed to SELL ${shorten(this.tokenMint)}:`, err)
        this.handleDecision({ action: "close" }) // should we close for unknown error?
      }

      return null
    }
  }
}
