import { Decision, Strategy, TokenEvent, TradeAction } from "@/trader/interfaces.ts"
import {logger, shorten, wait} from '@/shared/utils.ts'

type HealthReport = {
  growthRate: number
  volatility: number
  isHealthy: boolean
}

export class HealthyGrowthStrategy extends Strategy {

  LOSS_THRESHOLD = 0.9
  PROFIT_THRESHOLD = 1.25
  GROWTH_RATE_LOWER_BOUND = 2 // %
  GROWTH_RATE_UPPER_BOUND = 30 // %
  SELL_TIMEOUT = 1000 * 120
  SHARP_DROP_THRESHOLD = 0.1;    // 5% drop
  VOLATILITY_UPPER_BOUND = 2 // coefficient variance
  GRACE_PERIOD = 1000 * 600 // milliseconds
  LOOKBACK_PERIOD = 1000 * 30 // milliseconds

  private isBought: boolean = false
  private isSold: boolean = false

  constructor(events: TokenEvent[], actions: TradeAction[], baseBid: number) {
    super(events, actions, baseBid)
  }

  private getPrice(event: TokenEvent | TradeAction) {
    if ('tokenAmount' in event) {
      const e = event as TokenEvent
      return e.solAmount / e.tokenAmount
    } else {
      const e = event as TradeAction
      return e.tradePrice
    }
  }

  private hasBought() {
    if (this.isBought) return true
    return this.isBought = this.actions.some(action => action.txType === "buy")
  }

  private hasSold() {
    if (this.isSold) return true
    return this.isSold = this.actions.some(action => action.txType === "sell")
  }

  private getTokenAge() {
    const lastEvent = this.events.at(-1)!
    const firstEvent = this.events.at(0)!
    return lastEvent.timestamp - firstEvent.timestamp
  }

  private isHealthyGrowth(data: TokenEvent[]): HealthReport {
    if (data.length < 5) return {
      growthRate: 0,
      volatility: 0,
      isHealthy: false,
    }
    const growthRate = this.calculateGrowthRate(data)
    const volatility = this.calculateVolatility(data)
    const majorityBuys = this.hasMajorityBuys(data);
    const hasNoSharpDrop = this.hasNoSharpDrop(data);

    const isHealthy = (
        growthRate > this.GROWTH_RATE_LOWER_BOUND &&
        growthRate < this.GROWTH_RATE_UPPER_BOUND &&
        volatility < this.VOLATILITY_UPPER_BOUND &&
        majorityBuys &&
        hasNoSharpDrop
    )

    return {
      growthRate,
      volatility,
      isHealthy,
    }
  }

  /**
   * Checks if there has been a sharp drop in the last 15 seconds.
   * @param data Array of TokenEvent objects.
   * @returns A boolean indicating whether there has been no sharp drop.
   */
  private hasNoSharpDrop(data: TokenEvent[]): boolean {
    const initialPrice = this.getPrice(data[0])
    const finalPrice = this.getPrice(data.at(-1)!)

    if ((finalPrice - initialPrice) > 0) {
      return true;
    }

    const priceDrop = (initialPrice - finalPrice) / initialPrice;
    return priceDrop <= this.SHARP_DROP_THRESHOLD
  }

  private hasMajorityBuys(data: TokenEvent[]): boolean {
    const buyCount = data.filter(event => event.txType === "buy").length
    return buyCount > data.length / 2
  }

  private calculateGrowthRate(data: TokenEvent[]) {
    const initialPrice = this.getPrice(data[0])
    const finalPrice = this.getPrice(data.at(-1)!)
    return ((finalPrice - initialPrice) / initialPrice) * 100
  }

  private calculateVolatility(data: TokenEvent[]) {
    const prices = data.map(record => this.getPrice(record))
    const mean = prices.reduce((a, b) => a + b) / prices.length
    const variance = prices.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / prices.length
    return Math.sqrt(variance) / mean
  }

  onMarketCapUpdate(_event: TokenEvent): Decision {
    return this.onHeartbeat()
  }

  onInit(token: string): void {
    logger.info(`[DummyStrategy] Initialized for ${shorten(token)}.`)
  }

  onClose(token: string): void {
    logger.info(`[DummyStrategy] Closed for ${shorten(token)}.`)
  }

  onHeartbeat(): Decision {
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
    const thirtySecData = this.events.filter(record => {
      return (now - record.timestamp) <= this.LOOKBACK_PERIOD
    })
    const health = this.isHealthyGrowth(thirtySecData)

    if (health.isHealthy && !this.hasBought()) {
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
