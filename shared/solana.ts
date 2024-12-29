import { Connection } from '@solana/web3.js'
import { logger } from '@/shared/utils.ts'

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
