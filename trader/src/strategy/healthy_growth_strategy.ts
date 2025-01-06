import { Decision, Strategy, TokenEvent, TradeAction } from "@/trader/interfaces.ts"
import { logger, shorten } from '@/shared/utils.ts'


interface BinData {
  startTime: number
  endTime: number
  averagePrice: number
  volatility: number 
}

export class HealthyGrowthStrategy extends Strategy {

  LOSS_THRESHOLD = 0.98
  PROFIT_THRESHOLD = 1.3
  SELL_TIMEOUT = 1000 * 60 * 5
  VOLATILITY_UPPER_BOUND = 2 // coefficient variance
  GRACE_PERIOD = 1000 * 60 * 2 // milliseconds
  LOOKBACK_PERIOD = 1000 * 60 * 1.9 // milliseconds

  protected override MAX_IDLE_TIME: number = 1000 * 60 * 40

  constructor(events: TokenEvent[], actions: TradeAction[], baseBid: number) {
    super(events, actions, baseBid)
  }

  private BIN_SIZE_MS = 1000 * 20; // 10-second bins
  private MAX_ALLOWED_JUMP = 0.2; // e.g. 20% jump from one bin to the next
  private MAX_WITHIN_BIN_VOLATILITY = 0.03; // optional if you want to ensure each bin is stable

  private isSteadyGrowthNoPump(events: TokenEvent[]): boolean {
    if (events.length < 2) return false

    const now = Date.now()
    // Filter by lookback window
    const filtered = events.filter(e => now - e.timestamp <= this.LOOKBACK_PERIOD)
    if (filtered.length < 2) return false

    // Split data into bins
    const bins = this.getBins(filtered, this.BIN_SIZE_MS)
    if (bins.length < 2) return false

    for (let i = 1; i < bins.length; i++) {
      const prev = bins[i - 1]
      const curr = bins[i]

      // Check strictly increasing
      if (curr.averagePrice <= prev.averagePrice) {
        return false
      }
      // Check ratio to avoid suspicious pump or big dip
      const ratio = curr.averagePrice / prev.averagePrice
      if (ratio > 1 + this.MAX_ALLOWED_JUMP) return false   // too big a jump

      // each bin's volatility should be under threshold
      if (curr.volatility > this.MAX_WITHIN_BIN_VOLATILITY) {
        return false
      }
    }

    return true
  }

  /**
   * Binning function:
   * Sorts by timestamp, then partitions into intervals of length binSizeMs.
   * Computes weighted average (and weighted volatility) for each bin.
   */
  private getBins(data: TokenEvent[], binSizeMs: number): BinData[] {
    const sorted = [...data].sort((a, b) => a.timestamp - b.timestamp)
    const bins: BinData[] = []

    let binStartTime = sorted[0].timestamp
    let binEndTime = binStartTime + binSizeMs
    let startIndex = 0

    while (startIndex < sorted.length) {
      const binSlice: TokenEvent[] = []

      while (
        startIndex < sorted.length &&
        sorted[startIndex].timestamp < binEndTime
      ) {
        binSlice.push(sorted[startIndex])
        startIndex++
      }

      if (binSlice.length > 0) {
        // Weighted average price
        const weightedAvg = this.computeWeightedAveragePrice(binSlice)
        // Weighted volatility
        const weightedVol = this.computeWeightedVolatility(binSlice, weightedAvg)

        bins.push({
          startTime: binStartTime,
          endTime: binEndTime,
          averagePrice: weightedAvg,
          volatility: weightedVol,
        })
      }

      // Move to next bin
      binStartTime = binEndTime
      binEndTime += binSizeMs
    }

    return bins
  }

  /**
   * Weighted average price using marketCapSol as weight.
   * If you want a custom formula, replace `w = e.marketCapSol` with your own logic.
   */
  private computeWeightedAveragePrice(events: TokenEvent[]): number {
    if (!events.length) return 0

    let totalWeightedPrice = 0
    let totalWeight = 0

    for (const e of events) {
      // By default, let's treat marketCapSol as the weight.
      const w = e.marketCapSol
      // If the event doesn't have a direct price, you might derive it from solAmount/tokenAmount
      const price = this.getPrice(e)

      totalWeightedPrice += price * w
      totalWeight += w
    }

    return totalWeight === 0 ? 0 : (totalWeightedPrice / totalWeight)
  }

  /**
   * Weighted volatility:
   * var_w = ( Σ(w_i * (x_i - x̄)^2 ) ) / Σ(w_i)
   * Then take sqrt(var_w) / mean to get the coefficient of variation.
   */
  private computeWeightedVolatility(events: TokenEvent[], meanPrice: number): number {
    if (!events.length) return 0

    let weightedSquaredDiffSum = 0
    let totalWeight = 0

    for (const e of events) {
      const w = e.marketCapSol
      const price = this.getPrice(e)

      const diff = price - meanPrice
      weightedSquaredDiffSum += w * diff * diff
      totalWeight += w
    }

    if (totalWeight === 0) return 0

    const variance = weightedSquaredDiffSum / totalWeight
    // Coefficient of variation:
    return meanPrice === 0 ? 0 : (Math.sqrt(variance) / meanPrice)
  }

  async onMarketCapUpdate(_event: TokenEvent): Promise<Decision> {
    return await this.onHeartbeat()
  }

  override async onHeartbeat(): Promise<Decision> {
    const decision = await super.onHeartbeat()
    if (decision.action !== "hold") return decision

    if (this.hasBought() && this.hasSold()) {
      return { action: "close" }
    }

    if (this.events.length < 2) {
      return { action: "hold" }
    }

    if (!this.hasBought() && this.getTokenAge() < this.GRACE_PERIOD) {  // grace period logic
      return { action: "hold" }
    }

    const now = Date.now()
    const lookBackData = this.events.filter(record => {
      return (now - record.timestamp) <= this.LOOKBACK_PERIOD
    })
    const healthy = this.isSteadyGrowthNoPump(lookBackData)

    if (healthy && !this.hasBought()) {
      return { action: "buy", amount: this.baseBid }
    } else if (this.hasBought()) {
      const buyEvent = this.actions.find(action => action.txType === "buy")!
      const lastEvent = this.events.at(-1)!
      const priceDiff = this.getPrice(lastEvent) / this.getPrice(buyEvent)

      if (priceDiff < this.LOSS_THRESHOLD) {
        logger.info(`[DummyStrategy] Price loss sell, ratio: ${priceDiff}`)
        return { action: "sell", amount: Math.abs(buyEvent.tokenAmount) }
      } else if (priceDiff > this.PROFIT_THRESHOLD) {
        logger.info(`[DummyStrategy] Price profit sell, ratio: ${priceDiff}`)
        return { action: "sell", amount: Math.abs(buyEvent.tokenAmount) }
      } else if (Date.now() - lastEvent.timestamp > this.SELL_TIMEOUT) {
        logger.info(`[DummyStrategy] Sell stale coin, ratio: ${priceDiff}`)
        return { action: 'sell', amount: Math.abs(buyEvent.tokenAmount) }
      }
    }

    return { action: "hold" }
  }

}
