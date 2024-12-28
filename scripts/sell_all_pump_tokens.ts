import { PumpPortalService } from '@/trader/services/index.ts'
import { Connection, PublicKey } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID } from "@solana/spl-token"
import { wait } from '@/shared/utils.ts';

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

const rpc = Deno.env.get("RPC_ENDPOINT") || ''
const walletSecretKey = Deno.env.get("PRIVATE_KEY") || ''
const walletPublicKey = Deno.env.get("PUBLIC_KEY") || ''

const pumpPortal = new PumpPortalService({
  rpcEndpoint: rpc,
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

// Iterate through the token accounts and extract balance info
const balances = tokenAccounts.value.map(({ pubkey, account }) => {
  const parsedInfo = account.data.parsed.info
  const mintAddress = parsedInfo.mint
  const { amount, decimals } = parsedInfo.tokenAmount

  // SPL token amounts are stored as integers—divide by 10^decimals
  const balance = Number(amount) / 10 ** decimals

  return {
    tokenAccount: pubkey.toBase58(),
    mintAddress,
    balance,
  }
})

const promises = []

for (const balance of balances) {
  if (balance.mintAddress.includes("pump")) {
    await wait(0.3)
    promises.push(pumpPortal.trade({
      publicKey: walletPublicKey,
      action: "sell",
      mint: balance.mintAddress,
      denominatedInSol: "false",
      amount: balance.balance,
      slippage: 10,
      priorityFee: 0.000001,
      pool: "pump",
    }))
  }
}

await Promise.all(promises)