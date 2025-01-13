import { logger } from '@/shared/utils.ts'
import { Decision, Strategy, TokenEvent, TradeAction } from "@/trader/interfaces.ts"

interface BinData {
  startTime: number
  endTime: number
  avgMc: number
  volatility: number 
}

/**
 * Strategy:
 * Look for dev pump that MC has very consistent growth
 * Sell if growth slowed down
 * Most bins should have almost identical average increase
 * Total growth should be less than MAX_PUMP_RATIO since launch
 * Take profit at PROFIT_MARGIN or MAX_PUMP_RATIO
 * Watch out for high initial MC, use it to find bin growth ratio
 */

/**
 * Things to track:
 * Launch MC
 * Where it started constant growth
 * 
 */

export class HealthyGrowthStrategy extends Strategy {

  LOSS_THRESHOLD = 0.98
  MAX_PUMP_RATIO = 1.65 // from pump start to end. 
  PROFIT_MARGIN = 0.5
  SELL_TIMEOUT = 1000 * 60 * 5
  MIN_GROWTH_PER_BIN = 1.001
  MAX_WITHIN_BIN_VOLATILITY = 0.05 // coefficient of variance
  GRACE_PERIOD = 1000 * 60 * 2 // milliseconds
  MIN_EVENTS_IN_GRACE_PERIOD = 5
  LOOKBACK_PERIOD = 1000 * 60 * 5 - 10_000 // milliseconds
  BIN_SIZE_MS = 1000 * 20;
  MAX_BUY_MC = 400 / this.MAX_PUMP_RATIO  // don't buy if MC is close to migration

  protected override MAX_IDLE_TIME: number = 1000 * 60 * 40

  private bins: BinData[] = []

  constructor(events: TokenEvent[], actions: TradeAction[], baseBid: number) {
    super(events, actions, baseBid)
  }

  private easyClose(): boolean {
    return !this.events[0].mint.endsWith("pump")
  }

  private isSteadyGrowthNoPump(events: TokenEvent[]): boolean {
    if (events.length < this.MIN_EVENTS_IN_GRACE_PERIOD) return false

    // Split data into bins
    const bins = this.getBins(events)

    if (bins.length < 3) return false

    for (let i = 1; i < bins.length; i++) {
      const prev = bins[i - 1]
      const curr = bins[i]

      // Check strictly increasing
      if (curr.avgMc <= prev.avgMc || curr.avgMc / prev.avgMc < this.MIN_GROWTH_PER_BIN) {
        return false
      }

      // each bin's volatility should be under threshold
      if (curr.volatility > this.MAX_WITHIN_BIN_VOLATILITY) {
        return false
      }
    }

    // Pumped ratio should be less than max pump ratio - profit margin
    if (this.getPumpRatio() > this.MAX_PUMP_RATIO - this.PROFIT_MARGIN) {
      return false
    }

    return true
  }

  /**
   * Binning function:
   * Partitions into intervals of length binSizeMs.
   * Computes weighted average (and weighted volatility) for each bin.
   */
  private getBins(data: TokenEvent[]): BinData[] {
    const bins: BinData[] = []

    let binStartTime = data[0].timestamp
    let binEndTime = binStartTime + this.BIN_SIZE_MS
    let startIndex = 0
    const now = Date.now()

    while (binEndTime < now) {
      const binSlice: TokenEvent[] = []

      while (
        startIndex < data.length &&
        data[startIndex].timestamp < binEndTime
      ) {
        binSlice.push(data[startIndex])
        startIndex++
      }

      if (binSlice.length > 0) {
        const weightedMc = this.computeWeightedMarketCap(binSlice)
        const weightedVol = this.computeWeightedVolatility(binSlice, weightedMc)

        bins.push({
          startTime: binStartTime,
          endTime: binEndTime,
          avgMc: weightedMc,
          volatility: weightedVol,
        })
      } else {
        bins.push({
          startTime: binStartTime,
          endTime: binEndTime,
          avgMc: bins.at(-1)?.avgMc || 0,
          volatility: 0,
        })
      }

      // Move to next bin
      binStartTime = binEndTime
      binEndTime += this.BIN_SIZE_MS
    }

    this.bins = bins

    return bins
  }

  // from launch to current MC ratio
  private getPumpRatio(): number {
    return this.bins.at(-1)!.avgMc / this.bins[0]!.avgMc
  }

  private computeWeightedMarketCap(events: TokenEvent[]): number {
    if (!events.length) return 0;
  
    let numerator = 0;
    let denominator = 0;
  
    for (const e of events) {
      const weight = e.solAmount
      numerator += e.marketCapSol * weight;
      denominator += weight;
    }
  
    return denominator === 0 ? 0 : (numerator / denominator);
  }

  /**
   * Weighted volatility:
   * var_w = ( Σ(w_i * (x_i - x̄)^2 ) ) / Σ(w_i)
   * Then take sqrt(var_w) / mean to get the coefficient of variation.
   */
  private computeWeightedVolatility(events: TokenEvent[], meanMc: number): number {
    if (!events.length) return 0

    let weightedSquaredDiffSum = 0
    let totalWeight = 0

    for (const e of events) {
      const w = e.solAmount

      const diff = e.marketCapSol - meanMc
      weightedSquaredDiffSum += w * diff * diff
      totalWeight += w
    }

    if (totalWeight === 0) return 0

    const variance = weightedSquaredDiffSum / totalWeight
    // Coefficient of variation:
    const cv = meanMc === 0 ? 0 : (Math.sqrt(variance) / meanMc)

    return cv
  }

  async onMarketCapUpdate(_event: TokenEvent): Promise<Decision> {
    return await this.onHeartbeat()
  }

  override async onHeartbeat(): Promise<Decision> {
    const decision = await super.onHeartbeat()
    if (decision.action !== "hold") return decision

    if (
      this.easyClose() ||
      (this.hasBought() && this.hasSold())
    ) {
      return { action: "close" }
    }

    if (!this.hasBought() && this.getTokenAge() < this.GRACE_PERIOD) {  // grace period logic
      return { action: "hold" }
    }

    const firstEventTime = this.events[0].timestamp
    // Filter out first 10 seconds
    const lookBackData = this.events.filter(e => e.timestamp - firstEventTime > 10_000)
    const healthy = this.isSteadyGrowthNoPump(lookBackData)
    const underMaxBuyMc = this.events.at(-1)!.marketCapSol < this.MAX_BUY_MC

    if (healthy && underMaxBuyMc && !this.hasBought()) {
      return { action: "buy", amount: this.baseBid }
    } else if (this.hasBought()) {
      const buyEvent = this.actions.find(action => action.txType === "buy")!
      const tokenAmount = Math.abs(buyEvent.tokenAmount)
      const lastEvent = this.events.at(-1)!
      const profitRatio = this.getPrice(lastEvent) / this.getPrice(buyEvent)
      const prevBin = this.bins.at(-1)!
      const prevBinGrowth = lastEvent.marketCapSol / prevBin.avgMc

      if (prevBinGrowth < this.LOSS_THRESHOLD) {
        logger.info(`[HealthyGrowthStrategy] Unhealthy growth sell, ratio: ${profitRatio}. prevBinGrowth: ${prevBinGrowth}`)
        return { action: "sell", amount: tokenAmount }
      }

      if (this.getPumpRatio() > this.MAX_PUMP_RATIO) {
        logger.info(`[HealthyGrowthStrategy] Price profit sell, ratio: ${profitRatio}`)
        return { action: "sell", amount: tokenAmount }
      }

      if (Date.now() - lastEvent.timestamp > this.SELL_TIMEOUT) {
        logger.info(`[HealthyGrowthStrategy] Sell stale coin, ratio: ${profitRatio}`)
        return { action: 'sell', amount: tokenAmount }
      }
    } else {
      return { action: "close" }
    }

    return { action: "hold" }
  }

}
