import { Decision, Strategy, TokenEvent, TradeAction } from "@/trader/interfaces.ts"
import { logger, shorten } from '@/shared/utils.ts'

export class DummyStrategy extends Strategy {

  LOSS_THRESHOLD = 0.9
  BUY_THRESHOLD = 1.1
  PROFIT_THRESHOLD = 1.3
  TIMEOUT = 1000 * 120
  GRACE_PERIOD = 1000 * 30
  VOLATILITY_THRESHOLD = 2 // x100% ratio of changes

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

  private getTokenAge() {
    const lastEvent = this.events.at(-1)!
    const firstEvent = this.events.at(0)!
    return lastEvent.timestamp - firstEvent.timestamp
  }

  // Determine volatility by finding out the total changes in the past 15 seconds
  private getTokenVolatility() {
    const lastEvent = this.events.at(-1)!
    const recentEvents = this.events.filter(e => e.timestamp > lastEvent.timestamp - this.GRACE_PERIOD)

    const totalPricePercentageChange = recentEvents.reduce((prev, curr, idx) => {
      if (idx === 0) return prev
      return prev + Math.abs(1 - (this.getPrice(curr) / this.getPrice(recentEvents[idx - 1])))
    }, 0)

    return totalPricePercentageChange
  }

  private hasBought() {
    if (this.isBought) return true
    return this.isBought = this.actions.some(action => action.txType === "buy")
  }

  private hasSold() {
    if (this.isSold) return true
    return this.isSold = this.actions.some(action => action.txType === "sell")
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

    if (!this.hasBought()) {  // buying logic
      const firstEvent = this.events[0]!
      const lastEvent = this.events.at(-1)!
      const priceDiff = this.getPrice(lastEvent) / this.getPrice(firstEvent)

      if (this.getTokenVolatility() > this.VOLATILITY_THRESHOLD) {
        logger.info(`[DummyStrategy] Volatility too high, closing`)
        return { action: "close" }
      }

      if (
        this.getTokenAge() > this.GRACE_PERIOD &&
        priceDiff > this.BUY_THRESHOLD
      ) {
        logger.info(`[DummyStrategy] Buying token, ratio: ${priceDiff}`)
        return { action: "buy", amount: this.baseBid }
      }
    } else if (!this.hasSold()) {  // selling logic
      const buyEvent = this.actions.find(action => action.txType === "buy")!
      const lastEvent = this.events.at(-1)!
      const priceDiff = this.getPrice(lastEvent) / this.getPrice(buyEvent)

      if (priceDiff < this.LOSS_THRESHOLD || priceDiff > this.PROFIT_THRESHOLD) {
        logger.info(`[DummyStrategy] Price diff sell, ratio: ${priceDiff}`)
        return { action: "sell", amount: Math.abs(buyEvent.tokenAmount) }
      } else if (Date.now() - lastEvent.timestamp > this.TIMEOUT) {
        logger.info(`[DummyStrategy] Inactive sell`)
        return { action: 'sell', amount: Math.abs(buyEvent.tokenAmount) }
      }
    }

    return { action: "hold" }
  }
}
