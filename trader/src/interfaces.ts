export type Decision = {
  action: "buy" | "sell" | "hold" | "close"
  amount?: number // sol amount
}

export abstract class Strategy {
  constructor(private events: TokenEvent[], private actions: TradeAction[], private baseBid: number) {

  }

  abstract onMarketCapUpdate(event: TokenEvent): Decision
  abstract onHeartbeat(): Decision
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
  traderPublicKey?: string
}

// action record from the decision of a strategy
export type TradeAction = Pick<
  TradeEvent,
  "mint" | "txType" | "newTokenBalance" | "marketCapSol"
> & {
  timestamp: number
  tokenDelta: number
  solDelta: number
}
