export interface Strategy {
  /**
   * Called when there's a new market cap update for the token.
   * 
   * @param token - The token mint address.
   * @param newMarketCap - The current or updated market cap.
   * @returns "buy", "sell", or "hold" based on strategy logic.
   */
  onMarketCapUpdate(token: string, newMarketCap: number): "buy" | "sell" | "hold"
}
