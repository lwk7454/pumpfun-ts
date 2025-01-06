export type Decision = {
  action: "buy" | "sell" | "hold" | "close"
  amount?: number // sol amount for buy, token amount for sell
}

export abstract class Strategy {
  protected startTime: number
  protected MAX_IDLE_TIME = 1000 * 60 * 5
  protected isBought: boolean = false
  protected isSold: boolean = false

  constructor(protected events: TokenEvent[], protected actions: TradeAction[], protected baseBid: number) {
    this.startTime = Date.now()
  }

  public abstract onMarketCapUpdate(event: TokenEvent): Promise<Decision>
  public async onHeartbeat(): Promise<Decision> {
    const timeElapsed = Date.now() - this.startTime
    if (!this.isBought && timeElapsed > this.MAX_IDLE_TIME) {
      return { action: "close" }
    }
    return { action: "hold" }
  }

  protected getTokenAge() {
    return Date.now() - this.startTime
  }

  protected hasBought() {
    if (this.isBought) return true
    return this.isBought = this.actions.some(action => action.txType === "buy")
  }

  protected hasSold() {
    if (this.isSold) return true
    return this.isSold = this.actions.some(action => action.txType === "sell")
  }

  protected getPrice(event: TokenEvent | TradeAction) {
    if(event.tradePrice) return event.tradePrice
    return event.solAmount / event.tokenAmount
  }
}

export interface StrategyConstructor {
  new(
    events: TokenEvent[],
    actions: TradeAction[],
    baseBid: number
  ): Strategy
}

// raw event from pump portal
export interface TradeEvent {
  signature: string
  mint: string
  traderPublicKey: string
  txType: "buy" | "sell"
  tokenAmount: number
  solAmount: number
  newTokenBalance: number
  bondingCurveKey: string
  vTokensInBondingCurve: number
  vSolInBondingCurve: number
  marketCapSol: number
}

// normalized event that is sent to strategy, could be sourced from anywhere (Live, DB, file...)
export type TokenEvent = Pick<
  TradeEvent,
  "mint" | "txType" | "tokenAmount" | "solAmount" | "marketCapSol"
  > & {
  tradePrice?: number
  traderPublicKey?: string
  timestamp: number
}

// action record from the decision of a strategy
export type TradeAction = Pick<
  TradeEvent,
  "mint" | "txType" | "newTokenBalance" | "marketCapSol"
> & {
  tradePrice: number
  timestamp: number
  tokenAmount: number
  solAmount: number
  feeAmount: number
}
