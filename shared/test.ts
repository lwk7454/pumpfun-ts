import { PumpPortalService } from '@/trader/services/index.ts';

const pumpPortal = new PumpPortalService({
  rpcEndpoint: "https://api.mainnet-beta.solana.com",
  walletSecretKey: "YTYUBzSQQh1rs82kJq8ogPzZqAiv4w4hN3QHjjvkH9tsPcL27KRtku4roTs6WydCqufgibMXjDaGNa46KAApJaL",
})

const txn = await pumpPortal.trade({
  publicKey: "41A8cAh6VJGGoDkJbK1wecpSZ13tkRcjEBWRSUW4s6iU",
  action: "buy",
  mint: "FHC6PAkHE7bBg4NsShkZFZJg9VGfMS9a6FxTcrsjpump",
  denominatedInSol: "true",
  amount: 0.00001,
  slippage: 10,
  priorityFee: 0.000001,
  pool: "pump",
})

console.log("Transaction", txn)


