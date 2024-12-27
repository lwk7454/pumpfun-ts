import { Decision, Strategy, TokenEvent, TradeAction } from "@/trader/interfaces.ts"
import { logger } from '@/shared/utils.ts';

export class DummyStrategy extends Strategy {

  LOSS_THRESHOLD = 0.9
  BUY_THRESHOLD = 1.1
  PROFIT_THRESHOLD = 1.1
  TIMEOUT = 1000 * 30

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

  onMarketCapUpdate(_event: TokenEvent): Decision {
    if (this.hasBought() && this.hasSold()) {
      return { action: "close" }
    }

    if (this.events.length < 2) {
      return { action: "hold" }
    }

    if (!this.hasBought()) {
      const firstEvent = this.events[0]!
      const lastEvent = this.events.at(-1)!

      if (this.getPrice(lastEvent) / this.getPrice(firstEvent) > this.BUY_THRESHOLD) {
        return { action: "buy", amount: this.baseBid }
      }
    } else if (!this.hasSold()) {
      const buyEvent = this.actions.find(action => action.txType === "buy")!
      const lastEvent = this.events.at(-1)!
      const priceDiff = this.getPrice(lastEvent) / this.getPrice(buyEvent)

      if (priceDiff < this.LOSS_THRESHOLD || priceDiff > this.PROFIT_THRESHOLD) {
        logger.info(`[DummyStrategy] Price diff sell, ratio: ${priceDiff}`)
        return { action: "sell", amount: Math.abs(buyEvent.tokenAmount) }
      }
    }

    return { action: "hold" }
  }

  onInit(token: string): void {
    logger.info(`[DummyStrategy] Initialized for ${token.substring(0, 4)}.`)
  }

  onClose(token: string): void {
    logger.info(`[DummyStrategy] Closed for ${token.substring(0, 4)}.`)
  }

  onHeartbeat(): Decision {
    if (this.hasBought() && this.hasSold()) {
      return { action: "close" }
    } else if (this.hasBought()) {
      const buyEvent = this.actions.find(action => action.txType === "buy")!
      if (Date.now() - buyEvent.timestamp > this.TIMEOUT) {
        logger.info(`[DummyStrategy] Timeout sell`)
        return { action: 'sell', amount: Math.abs(buyEvent.tokenAmount) }
      }
    } else {
      const firstEvent = this.events.at(0)!
      if (Date.now() - firstEvent.timestamp > this.TIMEOUT) {
        return { action: 'close' }
      }
    }

    return { action: "hold" }
  }
}
