// worker.ts
import { Decision, StrategyConstructor, TradeAction } from '@/trader/interfaces.ts';
import { Strategy, TokenEvent } from "@/trader/interfaces.ts"
import { InfluxService } from "@/trader/services/influx_service.ts"
import { TradePortalService } from "@/trader/services/trade_portal.ts"

export interface WorkerConfig {
  initEvent: TokenEvent
  strategy: StrategyConstructor
  baseBid: number
  traderAddress: string   // Public key of your wallet
  defaultSlippage: number
  priorityFee: number
  influx: InfluxService
  tradePortal: TradePortalService
  dryRun: boolean
}

export type WorkerEvent = {
  type: "marketCapUpdate"
  event: TokenEvent
} | {
  type: "heartbeat"
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
  private eventQueue: WorkerEvent[] = [];
  private isProcessing = false;

  constructor(private config: WorkerConfig, private onComplete: () => void) {
    this.strategy = new config.strategy(this.events, this.actions, this.config.baseBid)
    this.tokenMint = this.config.initEvent.mint
    this.handleMarketCapUpdate(this.config.initEvent)
  }

  private async heartbeat(): Promise<void> {
    if (this.isComplete) return

    const decision = this.strategy.onHeartbeat()
    return await this.handleDecision(decision)
  }

  public enqueueEvent(event: WorkerEvent): void {
    this.eventQueue.push(event)
    if (!this.isProcessing) {
      this.processQueue()
    }
  }

  private async processQueue(): Promise<void> {
    this.isProcessing = true

    while (this.eventQueue.length > 0 && !this.isComplete) {
      const event = this.eventQueue.shift()!
      if (event.type === "marketCapUpdate") {
        await this.handleMarketCapUpdate(event.event)
      } else if (event.type === "heartbeat") {
        await this.heartbeat()
      }
    }

    this.isProcessing = false
  }

  private mapActionToEvent(action: TradeAction): TokenEvent {
    return {
      mint: action.mint,
      txType: action.txType,
      tokenAmount: Math.abs(action.tokenDelta),
      solAmount: Math.abs(action.solDelta),
      marketCapSol: action.marketCapSol,
      timestamp: action.timestamp,
    }
  }

  public async handleMarketCapUpdate(event: TokenEvent): Promise<void> {
    if (this.isComplete) return
    if (event.traderPublicKey === this.config.traderAddress) return

    const decision = this.strategy.onMarketCapUpdate(event)
    this.events.push(event)

    await this.handleDecision(decision)
  }

  private async handleDecision(decision: Decision): Promise<void> {
    let result = null
    const { action, amount } = decision
    if (action === "buy") {
      result = await this.buyToken(amount!)
    } else if (action === "sell") {
      result = await this.sellToken(amount!)
    } else if (action === "close") {
      this.onComplete()
    }

    if (result) {
      this.events.push(this.mapActionToEvent(result))
      this.actions.push(result)
    }
  }

  private async buyToken(solAmount: number): Promise<TradeAction | null> {
    if (this.config.dryRun) {
      console.log(`[TokenWorker] Dry-run: Simulated BUY for ${this.tokenMint}`)

      const lastEvent = this.events.at(-1)!
      const price = lastEvent.solAmount / lastEvent.tokenAmount
      const gasCost = 0.000006 // TODO: get from config
      const fees = lastEvent.solAmount * 0.015 + this.config.priorityFee + gasCost

      return {
        mint: this.tokenMint,
        txType: "buy",
        tokenDelta: solAmount / price,
        solDelta: -1 * solAmount - fees,
        newTokenBalance: 0, // TODO
        marketCapSol: 0, // TODO
        timestamp: Date.now(),
      }
    }

    try {
      const result = await this.config.tradePortal.trade({
        publicKey: this.config.traderAddress,
        action: "buy",
        mint: this.tokenMint,
        denominatedInSol: "true",
        amount: solAmount,
        slippage: this.config.defaultSlippage,
        priorityFee: this.config.priorityFee,
        pool: "pump",
      })

      console.log(`[TokenWorker] BUY transaction successful: ${result}`)

      await this.config.influx.recordTradeEvent({
        _measurement: "trade",
        _time: new Date().toISOString(),
        _field: "solDelta",
        _value: solAmount,
        token: this.tokenMint,
        strategy: this.config.strategy.constructor.name,
        action: "buy",
        tokenDelta: result.tokenDelta,
        timestamp: Date.now(),
      })
      return result
    } catch (err) {
      console.error(`[TokenWorker] Failed to BUY ${this.tokenMint}:`, err)
      return null
    }
  }

  private async sellToken(tokenAmount: number): Promise<TradeAction | null> {
    if (this.config.dryRun) {
      console.log(`[TokenWorker] Dry-run: Simulated SELL for ${this.tokenMint}`)

      const lastEvent = this.events.at(-1)!
      const price = lastEvent.solAmount / lastEvent.tokenAmount
      const gasCost = 0.000006 // TODO: get from config
      const fees = lastEvent.solAmount * 0.015 + this.config.priorityFee + gasCost

      return {
        mint: this.tokenMint,
        txType: "sell",
        tokenDelta: -1 * tokenAmount,
        solDelta: tokenAmount * price - fees,
        newTokenBalance: 0, // TODO
        marketCapSol: 0, // TODO
        timestamp: Date.now(),
      }
    }

    try {
      const result = await this.config.tradePortal.trade({
        publicKey: this.config.traderAddress,
        action: "sell",
        mint: this.tokenMint,
        denominatedInSol: "false",
        amount: tokenAmount,
        slippage: this.config.defaultSlippage,
        priorityFee: this.config.priorityFee,
        pool: "pump",
      })

      console.log(`[TokenWorker] SELL transaction successful: ${result}`)

      await this.config.influx.recordTradeEvent({
        _measurement: "trade",
        _time: new Date().toISOString(),
        _field: "solDelta",
        _value: result.solDelta,
        token: this.tokenMint,
        strategy: this.config.strategy.constructor.name,
        action: "sell",
        tokenDelta: result.tokenDelta,
        timestamp: Date.now(),
      })
      return result
    } catch (err) {
      console.error(`[TokenWorker] Failed to SELL ${this.tokenMint}:`, err)
      return null
    }
  }
}
