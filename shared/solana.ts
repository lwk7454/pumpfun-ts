import { 
  ComputeBudgetProgram, 
  Keypair, 
  Connection, 
  PublicKey, 
  TransactionInstruction,
  AddressLookupTableAccount,
  VersionedTransaction,
  TransactionMessage, 
} from '@solana/web3.js'
import bs58 from 'bs58'
import { logger } from '@/shared/utils.ts';
import { Buffer } from 'node:buffer';


// expect connectionList is ordered by priority
export const callWithConnectionList = async <RET>(fn: (connection: Connection) => Promise<RET>, connectionList: Connection[]): Promise<RET> => {
  for (const [idx, connection] of connectionList.entries()) {
    try {
      return await fn(connection)
    } catch (e) {
      const message = e instanceof Error ? e.message.toLowerCase() : 'Unknown error'
      if (message.includes('429') || message.includes('too many requests') || message.includes('next connection')) {
        logger.warn('Switching to next connection', { currentIdx: idx })
      } else {
        throw e
      }
    }
  }
  throw new Error('All connections failed')
}

export function getKeyPairFromPrivateKey(key: string) {
  return Keypair.fromSecretKey(
    new Uint8Array(bs58.decode(key))
  )
}

export async function createVersionedTransaction(
  connection: Connection,
  instructions: TransactionInstruction[],
  payer: PublicKey,
  priorityFeeInSol: number = 0,
  addressLookupTables: AddressLookupTableAccount[] = []
): Promise<VersionedTransaction> {
  const modifyComputeUnits = ComputeBudgetProgram.setComputeUnitLimit({
    units: 1_000_000, 
  })

  const transactionInstructions = [modifyComputeUnits]

  if (priorityFeeInSol > 0) {
    const microLamports = priorityFeeInSol * 1_000_000_000
    const addPriorityFee = ComputeBudgetProgram.setComputeUnitPrice({
      microLamports,
    })
    transactionInstructions.push(addPriorityFee)
  }

  transactionInstructions.push(...instructions)

  const { blockhash } = await connection.getLatestBlockhash()

  const messageV0 = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: transactionInstructions,
  }).compileToV0Message(addressLookupTables)

  const versionedTx = new VersionedTransaction(messageV0)
  return versionedTx
}

export function bufferFromUInt64(value: number | string) {
  const buffer = Buffer.alloc(8)
  buffer.writeBigUInt64LE(BigInt(value), 0)
  return buffer
}
