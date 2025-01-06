import { logger } from '@/shared/utils.ts'
import { Decision, Strategy, TokenEvent, TradeAction } from "@/trader/interfaces.ts"
import { CoinComment } from '@/trader/services/pump_fun.ts'

type HealthReport = {
  growthRate: number
  volatility: number
  isHealthy: boolean
}

export class CommentsReaderStrategy extends Strategy {

  LOSS_THRESHOLD = 0.9
  PROFIT_THRESHOLD = 1.3
  GROWTH_RATE_LOWER_BOUND = 5 // %
  GROWTH_RATE_UPPER_BOUND = 1000 // %
  SELL_TIMEOUT = 1000 * 60 * 5
  VOLATILITY_UPPER_BOUND = 2 // coefficient variance
  GRACE_PERIOD = 1000 * 60 * 1 // milliseconds
  LOOKBACK_PERIOD = 1000 * 60 * 0.9 // milliseconds
  SCAM_KEY_WORDS = ["scam", "rug", "fake project", "fraud"]

  protected override MAX_IDLE_TIME: number = 1000 * 60 * 40

  private RAPID_INCREASE_THRESHOLD = 2.5;    // 250% increase
  private MIN_EVENTS_FOR_RAPID = 3;           // Minimum events to consider
  private MAX_EVENTS_FOR_RAPID = 8;           // Maximum events window size

  private comments: CoinComment[] | null = null
  private readCommentsResult: boolean | null = null

  constructor(events: TokenEvent[], actions: TradeAction[], baseBid: number) {
    super(events, actions, baseBid)
  }

  private isHealthyGrowth(data: TokenEvent[]): HealthReport {
    if (data.length < 2) return {
      growthRate: 0,
      volatility: 0,
      isHealthy: false,
    }
    const growthRate = this.calculateGrowthRate(data)
    const volatility = this.calculateVolatility(data)
    // const hasRapidIncrease = this.hasRapidMarketCapIncrease()
    // const notAllBuyInFirstTenPercent = this.notAllBuyInFirstTenPercent();

    const isHealthy = (
      growthRate > this.GROWTH_RATE_LOWER_BOUND &&
      growthRate < this.GROWTH_RATE_UPPER_BOUND &&
      volatility < this.VOLATILITY_UPPER_BOUND &&
      data[0].mint.endsWith("pump")
      // &&
      // !hasRapidIncrease &&
      // notAllBuyInFirstTenPercent
    )
    return {
      growthRate,
      volatility,
      isHealthy,
    }
  }

  private notAllBuyInFirstTenPercent(): boolean {
    const initialEvents = this.getFirstTenPercent(this.events);
    const buyCount = initialEvents.filter(event => event.txType === "buy").length
    return (buyCount / initialEvents.length > 0.2) && (buyCount / initialEvents.length < 0.85)
  }

  private getFirstTenPercent(data: TokenEvent[]): TokenEvent[] {
    if (data.length === 0) return [];

    // Calculate 10% of the array length and round up to nearest integer
    const tenPercentLength = Math.ceil(data.length * 0.1);

    // Return at least 1 event, but no more than 10% of the array
    return data.slice(0, Math.max(1, tenPercentLength));
  }

  private hasRapidMarketCapIncrease(): boolean {
    if (this.events.length < this.MIN_EVENTS_FOR_RAPID) {
      return false;
    }

    // Look for rapid increases in recent events
    for (let i = Math.max(0, this.events.length - this.MAX_EVENTS_FOR_RAPID); i < this.events.length - this.MIN_EVENTS_FOR_RAPID + 1; i++) {
      const windowEvents = this.events.slice(i, i + this.MIN_EVENTS_FOR_RAPID);
      const initialMarketCap = windowEvents[0].marketCapSol;
      const finalMarketCap = windowEvents[windowEvents.length - 1].marketCapSol;

      // Calculate percentage increase
      const percentageIncrease = (finalMarketCap - initialMarketCap) / initialMarketCap;

      // Check if increase rate is above threshold
      if (percentageIncrease >= this.RAPID_INCREASE_THRESHOLD) {
        // Additional validation: Ensure the increase is consistent
        const isConsistentIncrease = this.isConsistentIncrease(windowEvents);
        if (isConsistentIncrease) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Helper method to verify if the increase is consistent across events
   * rather than just a single spike
   * @param events Array of TokenEvent objects
   * @returns boolean indicating if the increase is consistent
   */
  private isConsistentIncrease(events: TokenEvent[]): boolean {
    for (let i = 1; i < events.length; i++) {
      const previousMarketCap = events[i - 1].marketCapSol;
      const currentMarketCap = events[i].marketCapSol;

      // Allow for small decreases (1% tolerance)
      if (currentMarketCap < previousMarketCap * 0.99) {
        return false;
      }
    }
    return true;
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
    const health = this.isHealthyGrowth(lookBackData)

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
    return true
    // if (isDryRun()) return true
    //
    // if (this.readCommentsResult !== null) return this.readCommentsResult
    // if (!this.comments) {
    //   this.comments = await getCoinComments(this.events[0].mint)
    // }
    //
    // const alertingComments = this.comments.filter(comment => this.SCAM_KEY_WORDS.some(word => comment.text.includes(word)))
    // const isScam = alertingComments.length >= 1 && alertingComments.length / this.comments.length > 0.2
    // this.readCommentsResult = !isScam
    // return this.readCommentsResult
  }
}
