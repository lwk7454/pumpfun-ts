// strategy/dummy_strategy.ts

import { Decision, Strategy, TokenEvent, TradeAction } from "@/trader/interfaces.ts"

export class DummyStrategy extends Strategy {

  constructor(events: TokenEvent[], actions: TradeAction[], baseBid: number) {
    super(events, actions, baseBid)
  }

  onMarketCapUpdate(event: TokenEvent): Decision {
    return { action: "hold" }
  }

  onInit(token: string): void {
    console.log(`[DummyStrategy] Initialized for ${token}.`)
  }

  onClose(token: string): void {
    console.log(`[DummyStrategy] Closed for ${token}.`)
  }

  onHeartbeat(): Decision {
    console.log(`[DummyStrategy] Heartbeat.`)
    return { action: "hold" }
  }
}
