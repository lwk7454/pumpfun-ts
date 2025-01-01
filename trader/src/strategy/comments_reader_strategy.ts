import { Decision, Strategy, TokenEvent, TradeAction } from "@/trader/interfaces.ts"
import { isDryRun, logger } from '@/shared/utils.ts'
import { CoinComment, getCoinComments } from '@/trader/services/pump_fun.ts';

type HealthReport = {
  growthRate: number
  volatility: number
  isHealthy: boolean
}

export class CommentsReaderStrategy extends Strategy {

  LOSS_THRESHOLD = 0.98
  PROFIT_THRESHOLD = 1.40
  GROWTH_RATE_LOWER_BOUND = 5 // %
  GROWTH_RATE_UPPER_BOUND = 100 // %
  SELL_TIMEOUT = 1000 * 120
  VOLATILITY_UPPER_BOUND = 2 // coefficient variance
  GRACE_PERIOD = 1000 * 120 // milliseconds
  LOOKBACK_PERIOD = 1000 * 30 // milliseconds
  SCAM_KEY_WORDS = ["scam", "rugg", "rug.pics", "Rug pull alert", "a known rugger", "fake project", "fraud"]

  private isBought: boolean = false
  private isSold: boolean = false
  private comments: CoinComment[] | null = null
  private readCommentsResult: boolean | null = null

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
    if (data.length < 2) return {
      growthRate: 0,
      volatility: 0,
      isHealthy: false,
    }
    const growthRate = this.calculateGrowthRate(data)
    const volatility = this.calculateVolatility(data)
    const isHealthy = (
      growthRate > this.GROWTH_RATE_LOWER_BOUND &&
      growthRate < this.GROWTH_RATE_UPPER_BOUND &&
      volatility < this.VOLATILITY_UPPER_BOUND &&
      data[0].mint.endsWith("pump")
    )
    return {
      growthRate,
      volatility,
      isHealthy,
    }
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

  async onMarketCapUpdate(_event: TokenEvent): Promise<Decision> {
    return await this.onHeartbeat()
  }

  async onHeartbeat(): Promise<Decision> {
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
      const commentsResult = await this.readComments()
      if (commentsResult) {
        return { action: "buy", amount: this.baseBid }
      } else {
        logger.info(`[CommentsReaderStrategy] Scam detected, closing. ${this.events[0].mint}`)
        return { action: "close" }
      }
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

  private async readComments(): Promise<boolean> {
    if (isDryRun()) return true

    if (this.readCommentsResult !== null) return this.readCommentsResult
    if (!this.comments) {
      this.comments = await getCoinComments(this.events[0].mint)
    }

    const alertingComments = this.comments.filter(comment => this.SCAM_KEY_WORDS.some(word => comment.text.includes(word)))
    const isScam = alertingComments.length >= 2 && alertingComments.length / this.comments.length > 0.2
    this.readCommentsResult = !isScam
    return this.readCommentsResult
  }
}
