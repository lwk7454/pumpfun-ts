import { PumpPortalService } from '@/trader/services/pump_portal.ts';
import { logger } from '@/shared/utils.ts';
import { Connection } from '@solana/web3.js';

Deno.test("pump portal", async () => {
  const pumpPortal = new PumpPortalService({
    walletSecretKey: Deno.env.get("PRIVATE_KEY")!,
  })
  const result = await pumpPortal.trade({
    publicKey: "41A8cAh6VJGGoDkJbK1wecpSZ13tkRcjEBWRSUW4s6iU",
    action: "sell",
    mint: "CKzbHtoE4UJUorh9WJDtsgLnzRpwGM1rqoXgqK1dpump",
    denominatedInSol: "false",
    amount: 892719908.10182,
    slippage: 10,
    priorityFee: 0.00001,
    pool: "pump"
  })
  logger.info(result)

})

Deno.test("connection", async () => {
  const connection = new Connection("https://api.mainnet-beta.solana.com", "confirmed")
  const txn = await connection.getParsedTransaction('5ak14f3MtrgYmBqSQahXtVfpwGrEPkSitjiAT3KW1wtWouELcnrCrnzHnsVbuWh8m6pVY8TD5KyMqDhU2fKfd9Ry', {
    maxSupportedTransactionVersion: 0,
  })
  logger.info(txn)
})
