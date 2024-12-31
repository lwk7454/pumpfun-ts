import dotenv from 'dotenv'
import { PumpFunService } from '@/trader/services/index.ts'
import { Connection, PublicKey } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID } from "@solana/spl-token"
import { logger, wait } from '@/shared/utils.ts';

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

const rpc = Deno.env.get("RPC_SOLANA") || ''
const walletSecretKey = Deno.env.get("PRIVATE_KEY") || ''
const walletPublicKey = Deno.env.get("PUBLIC_KEY") || ''

const skipTokens = [
  '7PAku7wvHd4sruRiXSo5ECTQ8GapbonaBfxvGThvpump'
]

const pumpFun = new PumpFunService({
  walletSecretKey
})

// Create a connection to the Solana cluster
const connection = new Connection(rpc, "confirmed")

// Convert the wallet address (string) to a PublicKey object
const ownerPublicKey = new PublicKey(walletPublicKey)

// Fetch all parsed token accounts owned by the wallet
const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
  ownerPublicKey,
  { programId: TOKEN_PROGRAM_ID }
)

logger.info('Found', tokenAccounts.value.length, 'token accounts')

// Iterate through the token accounts and extract balance info
const balances = tokenAccounts.value.map(({ pubkey, account }) => {
  const parsedInfo = account.data.parsed.info
  const mintAddress = parsedInfo.mint
  const { amount, decimals } = parsedInfo.tokenAmount

  // SPL token amounts are stored as integers—divide by 10^decimals
  const balance = Number(amount) / 10 ** decimals

  const result = {
    tokenAccount: pubkey.toBase58(),
    mintAddress,
    balance,
  }

  logger.info(result)

  return result
})

const promises = []

for (const balance of balances) {
  // logger.info(balance)
  // continue;

  if (skipTokens.includes(balance.mintAddress)) continue
  await wait(0.3)
  promises.push(pumpFun.trade({
    publicKey: walletPublicKey,
    action: "sell",
    mint: balance.mintAddress,
    tokenAmount: balance.balance,
    slippage: 50,
    priorityFee: 0.00002,
  }))

}

await Promise.all(promises)