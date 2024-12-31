import { PumpFunService } from '@/trader/services/index.ts'
import dotenv from 'dotenv'
import { Connection, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { logger } from '@/shared/utils.ts';

dotenv.config()

// Global Unhandled Rejection Handler
addEventListener("unhandledrejection", (event) => {
  console.error(
    "Global: Unhandled Rejection at:",
    event.promise,
    "reason:",
    event.reason,
  )
  event.preventDefault()
})

// Global Uncaught Exception Handler
addEventListener("error", (event) => {
  console.error("Global: Uncaught Exception thrown:", event.error)
  event.preventDefault()
})

const walletSecretKey = Deno.env.get("PRIVATE_KEY") || ''
const walletPublicKey = Deno.env.get("PUBLIC_KEY") || ''
const ownerPublicKey = new PublicKey(walletPublicKey)
const tokenMint = "Cqyjee7Y74rqkkeNEvYKWJvAo3R8JzS4WHNJ1BPqpump"
const action = "sell"
const solAmount = 0.01

const pumpFun = new PumpFunService({
  walletSecretKey
})

const findTokenAmount = async (tokenMint: string) => {
  const connection = new Connection(Deno.env.get("RPC_QUICKNODE")!, "confirmed")
  const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
    ownerPublicKey,
    { programId: TOKEN_PROGRAM_ID }
  )
  // find token amount in tokenAccounts
  const tokenAccount = tokenAccounts.value.find(({ account }) => {
    const parsedInfo = account.data.parsed.info
    return parsedInfo.mint === tokenMint
  })

  if (!tokenAccount) {
    throw new Error("Token account not found")
  }
  const parsedInfo = tokenAccount.account.data.parsed.info
  const { amount, decimals } = parsedInfo.tokenAmount

  return Number(amount) / 10 ** decimals
}

const result = await pumpFun.trade({
  publicKey: walletPublicKey,
  action,
  mint: tokenMint,
  solAmount: action === "buy" ? solAmount : undefined,
  tokenAmount: action !== "buy" ? await findTokenAmount(tokenMint) : undefined,
  slippage: 10,
  priorityFee: 0.00002,
})

logger.info(result)

