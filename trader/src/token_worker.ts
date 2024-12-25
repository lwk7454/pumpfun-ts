// worker.ts
import { Strategy } from "@/trader/interfaces.ts"
import { InfluxService } from "@/trader/services/influx_service.ts"
import { TradePortalService } from "@/trader/services/trade_portal.ts"

export interface WorkerConfig {
  tokenMint: string
  strategy: Strategy
  traderAddress: string   // Public key of your wallet
  denominatedInSol: boolean
  defaultSlippage: number
  priorityFee: number
  pool: "pump" | "raydium"
  influx: InfluxService
  tradePortal: TradePortalService
  dryRun: boolean
}

export class TokenWorker {
  private bought = false;
  private sold = false;

  constructor(private config: WorkerConfig) { }

  public isComplete(): boolean {
    // Example logic: the worker is "complete" once it has sold 
    // or otherwise decided it's done with trading.
    return this.sold
  }

  /**
   * Called externally (e.g., from the Master) each time there's a new market cap update.
   */
  public async handleMarketCapUpdate(newMarketCap: number): Promise<void> {
    if (this.sold) return // Already done with this token.

    const decision = this.config.strategy.onMarketCapUpdate(
      this.config.tokenMint,
      newMarketCap,
    )

    // If we haven't bought yet and strategy says buy:
    if (!this.bought && decision === "buy") {
      await this.buyToken()
    }
    // If we've bought and strategy says sell:
    else if (this.bought && !this.sold && decision === "sell") {
      await this.sellToken()
    }
  }

  private async buyToken(): Promise<void> {
    if (this.config.dryRun) {
      console.log(`[TokenWorker] Dry-run: Simulated BUY for ${this.config.tokenMint}`)
      this.bought = true
      await this.config.influx.recordTradeEvent({
        token: this.config.tokenMint,
        strategy: this.config.strategy.constructor.name,
        action: "buy",
        amount: 1000, // Hard-coded for demo
        timestamp: Date.now(),
      })
      return
    }

    try {
      const signature = await this.config.tradePortal.trade({
        publicKey: this.config.traderAddress,
        action: "buy",
        mint: this.config.tokenMint,
        denominatedInSol: this.config.denominatedInSol,
        amount: 1000,
        slippage: this.config.defaultSlippage,
        priorityFee: this.config.priorityFee,
        pool: this.config.pool,
      })

      console.log(`[TokenWorker] BUY transaction successful: ${signature}`)
      this.bought = true

      await this.config.influx.recordTradeEvent({
        token: this.config.tokenMint,
        strategy: this.config.strategy.constructor.name,
        action: "buy",
        amount: 1000,
        timestamp: Date.now(),
      })
    } catch (err) {
      console.error(`[TokenWorker] Failed to BUY ${this.config.tokenMint}:`, err)
    }
  }

  private async sellToken(): Promise<void> {
    if (this.config.dryRun) {
      console.log(`[TokenWorker] Dry-run: Simulated SELL for ${this.config.tokenMint}`)
      this.sold = true
      await this.config.influx.recordTradeEvent({
        token: this.config.tokenMint,
        strategy: this.config.strategy.constructor.name,
        action: "sell",
        amount: 1000,
        timestamp: Date.now(),
        profitLoss: 123.45,
      })
      return
    }

    try {
      const signature = await this.config.tradePortal.trade({
        publicKey: this.config.traderAddress,
        action: "sell",
        mint: this.config.tokenMint,
        denominatedInSol: this.config.denominatedInSol,
        amount: 1000,
        slippage: this.config.defaultSlippage,
        priorityFee: this.config.priorityFee,
        pool: this.config.pool,
      })

      console.log(`[TokenWorker] SELL transaction successful: ${signature}`)
      this.sold = true

      // In real usage, compute actual P/L
      await this.config.influx.recordTradeEvent({
        token: this.config.tokenMint,
        strategy: this.config.strategy.constructor.name,
        action: "sell",
        amount: 1000,
        timestamp: Date.now(),
        profitLoss: 123.45,
      })
    } catch (err) {
      console.error(`[TokenWorker] Failed to SELL ${this.config.tokenMint}:`, err)
    }
  }
}
