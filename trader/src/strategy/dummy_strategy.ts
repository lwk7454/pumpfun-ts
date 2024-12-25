// strategy/dummy_strategy.ts

import { Strategy } from "../interfaces.ts"

/**
 * A very simple / placeholder strategy.
 * - Buys on the first market cap update
 * - Sells on the second update
 * - Then it finishes
 */
export class DummyStrategy implements Strategy {
  private updateCount = 0;

  onMarketCapUpdate(token: string, _newMarketCap: number): "buy" | "sell" | "hold" {
    this.updateCount++
    if (this.updateCount === 1) {
      console.log(`[DummyStrategy] First update for ${token}. Deciding to BUY.`)
      return "buy"
    } else if (this.updateCount === 2) {
      console.log(`[DummyStrategy] Second update for ${token}. Deciding to SELL.`)
      return "sell"
    }
    return "hold"
  }
}
