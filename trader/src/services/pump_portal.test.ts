import { PumpPortalService, PumpPortalOptions, TradeRequest } from './pump_portal.ts'
import { txnBuy } from '@/mocks/txn_buy.ts'
import { txnSell } from '@/mocks/txn_sell.ts'
import { assert, assertAlmostEquals, assertEquals } from '@std/assert';
import { TradeAction } from '@/trader/interfaces.ts';

const options: PumpPortalOptions = {
  walletSecretKey: 'your-wallet-secret-key', // Use a valid base58 secret key for testing
}

const service = new PumpPortalService(options, true) // Initialize with dryRun=true to bypass connections

Deno.test("PumpPortalService.normalizeTransaction - Buy Transaction", () => {
  const buyRequest: TradeRequest = {
    publicKey: 'somePublicKey',
    action: 'buy',
    mint: 'Awt4iFZ6EKHgrvuQybKiwdENoLeAZYSo9wbXHCowWDFY',
    denominatedInSol: 'true',
    amount: 0.001,
    slippage: 10,
    priorityFee: 0.00001,
    pool: 'pump',
  }

  const tradeAction: TradeAction = service['normalizeTransaction'](buyRequest, txnBuy)

  const solChange =
    ((txnBuy.meta?.postBalances?.[0] ?? 0) - (txnBuy.meta?.preBalances?.[0] ?? 0)) / 1e9

  assertEquals(tradeAction.mint, buyRequest.mint, 'mint')
  assertEquals(tradeAction.txType, 'buy', 'txType')
  assertAlmostEquals(tradeAction.tokenAmount, 29799.294421, 1e-6, 'tokenAmount')
  assertAlmostEquals(tradeAction.solAmount, 0.001, 1e-8, 'solAmount')
  assertAlmostEquals(tradeAction.feeAmount, 
    0.000015 + // gas
    0.00001 + // pump.fun trading fee
    0.000004999 + // pumpportal API fee
    0.00203928 // rent cost
    , 1e-6, 'feeAmount')
  assertAlmostEquals(tradeAction.tradePrice, 0.001 / 29799.294421, 1e-9, 'tradePrice')
  assertAlmostEquals(tradeAction.newTokenBalance, 29799.294421, 1e-6, 'newTokenBalance')
  assertEquals(tradeAction.marketCapSol, 0, 'marketCapSol')
  assert(typeof tradeAction.timestamp === 'number', "timestamp should be a number")
  // solChange doesn't include priority fee (?)
  assertAlmostEquals(tradeAction.solAmount + tradeAction.feeAmount, -solChange, 1e-6, 'solAmount + feeAmount')
})

Deno.test("PumpPortalService.normalizeTransaction - Sell Transaction", () => {
  const sellRequest: TradeRequest = {
    publicKey: 'somePublicKey',
    action: 'sell',
    mint: 'FbGqkdq6ENfs7Sm5KLvgTeh5cs4i9k6Pn7dNxeVDpump',
    denominatedInSol: 'false',
    amount: 28994.417101,
    slippage: 10,
    priorityFee: 0.00001,
    pool: 'pump',
  }

  const tradeAction: TradeAction = service['normalizeTransaction'](sellRequest, txnSell)

  const solChange =
    ((txnSell.meta?.postBalances?.[0] ?? 0) - (txnSell.meta?.preBalances?.[0] ?? 0)) / 1e9

  assertEquals(tradeAction.mint, sellRequest.mint, 'mint')
  assertEquals(tradeAction.txType, 'sell', 'txType')
  assertAlmostEquals(tradeAction.tokenAmount, 28994.417101, 1e-6, 'tokenAmount')
  assertAlmostEquals(tradeAction.solAmount, 0.001055363, 1e-8, 'solAmount')
  assertAlmostEquals(tradeAction.feeAmount,
    0.000006 + // gas
    0.000010553 + // pump.fun trading fee
    0.000005319 - // pumpportal API fee
    0.00203928 // rent cost
    , 1e-6, 'feeAmount')
  assertAlmostEquals(tradeAction.tradePrice, 0.001055363 / 28994.417101, 1e-9, 'tradePrice')
  assertAlmostEquals(tradeAction.newTokenBalance, 0, 1e-6, 'newTokenBalance')
  assertEquals(tradeAction.marketCapSol, 0, 'marketCapSol')
  assert(typeof tradeAction.timestamp === 'number', "timestamp should be a number")
  // solChange doesn't include priority fee (?)
  assertAlmostEquals(tradeAction.solAmount - tradeAction.feeAmount, solChange, 1e-6, 'solAmount + feeAmount')
})
