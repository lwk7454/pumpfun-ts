// master.ts
import { isDryRun, logger, printSol, shorten, wait } from "@/shared/utils.ts"
import { StrategyConstructor, TokenEvent, TradeEvent } from "@/trader/interfaces.ts"
import { InfluxService, PumpFunService } from "@/trader/services/index.ts"
import { HealthyGrowthStrategy } from '@/trader/strategy/index.ts'
import { TokenWorker, WorkerResult } from "@/trader/token_worker.ts"
import { parseArgs } from "jsr:@std/cli/parse-args"
import { CommentsReaderStrategy } from '@/trader/strategy/comments_reader_strategy.ts';

export interface MasterConfig {
  maxOpenPositions: number
  baseBid: number
  influxService: InfluxService
  pumpFun: PumpFunService
  defaultStrategy: StrategyConstructor
  walletPublicKey: string
  defaultSlippage: number
  priorityFee: number
}

export type MasterResult = {
  solDelta: number
  tokenDelta: number
  tradedTokenCount: number
  feeTotal: number
  tradedSol: number
}

export type TokenWithLastUpdated = {
  mint: string
  lastUpdated: number
}

/**
 * The Master class manages:
 *  1. Discovering new tokens (in real-time or from historical data).
 *  2. Spawning worker processes up to a concurrency limit.
 *  3. Pass token events to workers
 *  4. Reports
 */
export class Master {
  MAX_WATCH_TIME = 1000 * 60 * 5 // timeout for subscriptions without a worker
  REPORT_INTERVAL = 1000 * 30

  private activeWorkers: Map<string, TokenWorker> = new Map();
  private subscribedTokens: Map<string, TokenWithLastUpdated> = new Map()
  private isRunning = false;
  private isClosing = false
  private ws?: WebSocket
  private workerResults: WorkerResult[] = []
  private aggWorkerResults: Omit<WorkerResult, 'mint'> & {tradedTokenCount: number} = {
    solDelta: 0,
    tokenDelta: 0,
    feeTotal: 0,
    tradedSol: 0,
    tradedTokenCount: 0,
  }
  private closedTokens: Map<string, TokenWithLastUpdated> = new Map()
  private openPositions: number = 0
  private lastReportTime: number = Date.now()
  private minSolBalance: number
  private currentBid: number
  private maxLoss: number | null = Number(Deno.env.get("MAX_LOSS")) || null
  private startingBalance: number | null = null

  constructor(private config: MasterConfig) {
    this.minSolBalance = this.config.maxOpenPositions * ((this.config.baseBid * 1.01) + this.config.priorityFee + 0.00203928)
    this.currentBid = this.config.baseBid

    logger.info(`[Master] Initializing. Min Sol required: ${this.minSolBalance} SOL`, this.maxLoss ? `, Max loss: ${this.maxLoss} SOL` : '')

    Deno.addSignalListener("SIGINT", async () => {
      if (this.isClosing) {
        return
      }

      if (this.openPositions > 0) {
        logger.warn("[Master] Exiting, gracefully selling all positions")
      }
      await this.close()
      Deno.exit()
    });
  }

  // Entry point
  public async run(): Promise<void> {
    this.isRunning = true

    if (!isDryRun()) {
      this.runLive()
    }

    await this.heartBeat()
  }

  public async close(): Promise<void> {
    this.isClosing = true
    if (this.ws) {
      this.ws.close()
    }
    Array.from(this.activeWorkers).forEach(([_, worker]) => {
      worker.enqueueCommand({ type: "force_close" })
    })

    while (this.openPositions > 0) {
      await wait(1)
    }

    this.isRunning = false

    const balance = await this.config.pumpFun.getSolBalance()

    const report = this.generateReport()
    logger.info(
      `[Master] Final Report: 
        Profit: ${printSol(report.solDelta)} SOL,
        Current Bid: ${printSol(this.currentBid)} SOL,
        Subscribed tokens: ${this.subscribedTokens.size}, 
        Traded tokens: ${report.tradedTokenCount},
        Fee: ${printSol(report.feeTotal)} SOL,
        Traded SOL: ${printSol(report.tradedSol)} SOL,
        Open positions: ${this.openPositions},
        Starting balance: ${printSol(this.startingBalance)} SOL,
        Current balance: ${printSol(balance)} SOL,
        Adjusted real profit: ${printSol(balance - (this.startingBalance ?? 0))} SOL
      `)
  }

  private generateReport(): MasterResult {
    let solDelta = 0
    let tokenDelta = 0
    let feeTotal = 0
    let tradedSol = 0
    this.workerResults.forEach(result => {
      if (!isNaN(result.solDelta) && !isNaN(result.tokenDelta)) {
        solDelta += result.solDelta
        tokenDelta += result.tokenDelta
        feeTotal += result.feeTotal
        tradedSol += result.tradedSol
      }
    })
    this.aggWorkerResults.solDelta += solDelta
    this.aggWorkerResults.tokenDelta += tokenDelta
    this.aggWorkerResults.feeTotal += feeTotal
    this.aggWorkerResults.tradedSol += tradedSol
    this.aggWorkerResults.tradedTokenCount += this.workerResults.length
    this.workerResults = []
    return this.aggWorkerResults
  }

  private cleanStaleSubscriptions() {
    const now = Date.now()
    const unsubscribeTokens: string[] = []
    this.subscribedTokens.forEach((token, mint) => {
      if (!this.activeWorkers.has(mint) && now - token.lastUpdated > this.MAX_WATCH_TIME) {
        this.subscribedTokens.delete(mint)
        unsubscribeTokens.push(mint)
      }
    })
    if (!isDryRun() && unsubscribeTokens.length > 0) {
      this.ws!.send(
        JSON.stringify({
          method: "unsubscribeTokenTrade",
          keys: unsubscribeTokens,
        }),
      )
    }
  }

  private closeSocket() {
    if(!this.ws) return
    this.ws.close()
    this.ws = undefined
    logger.info('Socket reset')
  }

  private runLive() {
    this.closeSocket()
    logger.info('Connecting to market feed')
    this.ws = new WebSocket(`wss://pumpportal.fun/api/data`)

    this.ws.onerror = e => {
      logger.error('WS Error', e)
      this.closeSocket()
      setTimeout(() => {
        this.runLive()
      }, 1000)
    }

    this.ws.onopen = () => {
      logger.info("Connected to market feed.")
      this.ws!.send(
        JSON.stringify({
          method: "subscribeNewToken",
        }),
      )
      if (this.activeWorkers.size > 0) {
        const workerMints = Array.from(this.activeWorkers.keys())
        this.subscribedTokens = new Map(workerMints.map(mint => [mint, { mint, lastUpdated: Date.now() }]))
        this.ws!.send(
          JSON.stringify({
            method: "subscribeTokenTrade",
            keys: workerMints,
          }),
        )
      }
    }

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)

        if (data.txType === 'create') {
          const event = data as TradeEvent
          const { mint } = event
          this.subscribedTokens.set(mint, { mint, lastUpdated: Date.now() })
          this.ws!.send(
            JSON.stringify({
              method: "subscribeTokenTrade",
              keys: [mint],
            }),
          )
        }

        if (['buy', 'sell'].includes(data.txType)) {
          const event = data as TradeEvent
          const { mint, marketCapSol, txType, tokenAmount, solAmount, traderPublicKey } = event
          const tokenEvent: TokenEvent = {
            mint,
            txType,
            tokenAmount,
            solAmount,
            marketCapSol,
            traderPublicKey,
            timestamp: Date.now(),
          }

          this.onEvent(tokenEvent)
        }
      } catch (err) {
        logger.error("Error processing message:", { event, err })
      }
    }
  }

  private async heartBeat() {
    let bidRatio: number = 0
    while (this.isRunning) {
      this.activeWorkers.forEach((worker) => {
        worker.enqueueCommand({ type: "heartbeat" })
      })

      if (Date.now() - this.lastReportTime > this.REPORT_INTERVAL) {
        this.cleanStaleSubscriptions()
        this.updateOpenPositions()
        const report = this.generateReport()
        logger.info(
          `[Master] Report 
          Profit: ${printSol(report.solDelta)} SOL, 
          Current Bid: ${printSol(this.currentBid)} SOL,
          Subscribed tokens: ${this.subscribedTokens.size}, 
          Traded tokens: ${report.tradedTokenCount},
          Fee: ${printSol(report.feeTotal)} SOL,
          Traded SOL: ${printSol(report.tradedSol)} SOL,
          Open positions: ${this.openPositions}
        `)

        // check sol balance, close all if can't open max positions
        const balance = isDryRun() ? (10 + report.solDelta) : await this.config.pumpFun.getSolBalance()
        if (this.startingBalance === null) this.startingBalance = balance
        if (bidRatio === 0) bidRatio = this.config.baseBid / balance
        this.currentBid = Math.max(this.config.baseBid, bidRatio * balance)

        if (this.maxLoss && report.solDelta < -this.maxLoss) {
          logger.info(`[Master] Lost more than ${this.maxLoss}, closing all positions`, { balance, minSolBalance: this.minSolBalance })
          this.close()
        } else if (balance < this.minSolBalance) {
          logger.info("[Master] Balance is too low, closing all positions", { balance, minSolBalance: this.minSolBalance })
          this.close()
        }

        this.lastReportTime = Date.now()
      }
      await wait(1)
    }
  }

  public onEvent(event: TokenEvent) {
    if (!this.isRunning) return
    if (this.activeWorkers.has(event.mint)) {
      this.activeWorkers.get(event.mint)!.enqueueCommand({ type: "marketCapUpdate", event })
    } else if (!this.closedTokens.has(event.mint)) {
      this.spawnWorker(event)
    }
  }

  public closeWorker(mint: string) {
    this.closedTokens.set(mint, { mint, lastUpdated: Date.now() })
    this.activeWorkers.delete(mint)
    this.subscribedTokens.delete(mint)

    if (!isDryRun()) {
      this.ws!.send(
          JSON.stringify({
            method: "unsubscribeTokenTrade",
            keys: [mint],
          }),
      )
    }
  }

  private spawnWorker(event: TokenEvent): TokenWorker {
    const { mint } = event
    const {
      defaultStrategy, walletPublicKey, defaultSlippage,
      priorityFee, influxService, pumpFun
    } = this.config

    const worker = new TokenWorker({
      initEvent: event,
      strategy: defaultStrategy,
      baseBid: this.currentBid,
      traderAddress: walletPublicKey,
      defaultSlippage,
      priorityFee,
      influx: influxService,
      pumpFun,
    }, this)

    this.activeWorkers.set(mint, worker)
    return worker
  }

  public onWorkerComplete(result: WorkerResult) {
    if (result.solDelta !== 0) { // Only log if there was a profit/loss
      this.workerResults.push(result)
      logger.info(`[Master] Closing Token ${shorten(result.mint)}... Profit: ${printSol(result.solDelta)} SOL, Remaining Tokens: ${result.tokenDelta}`)
    }
    this.closeWorker(result.mint)
  }

  public updateOpenPositions() {
    this.openPositions = Array.from(this.activeWorkers.values()).reduce((prev, curr) => {
      return prev + (curr.tokenBalance > 1e-6 ? 1 : 0)
    }, 0)
  }

  public allowBuy(): boolean {
    return this.openPositions < this.config.maxOpenPositions
  }
}

if (import.meta.main) {
  logger.initFileLogger(`./logs/live-${new Date().toISOString()}/`)
  // Define the expected command-line arguments
  const args = parseArgs(Deno.args, {
    string: ["maxOpenPositions", "baseBid"],
    default: {
      maxOpenPositions: "30",
      baseBid: "0.015",
    },
    alias: {
      maxOpenPositions: ["concurrency"],
      baseBid: ["bid"],
    },
  })

  const maxOpenPositions: number = Number(args.maxOpenPositions)
  const baseBid: number = Number(args.baseBid)

  const WALLET_SECRET = Deno.env.get("PRIVATE_KEY") || "YOUR_BASE58_PRIVATE_KEY"
  const WALLET_PUBLIC_KEY = Deno.env.get("PUBLIC_KEY") || "YOUR_WALLET_PUBLIC_KEY"

  const influxService = new InfluxService()
  const pumpFun = new PumpFunService({
    walletSecretKey: WALLET_SECRET,
  })

  const master = new Master({
    maxOpenPositions,
    baseBid,
    influxService,
    pumpFun: pumpFun,
    // defaultStrategy: DummyStrategy,
    defaultStrategy: CommentsReaderStrategy,
    walletPublicKey: WALLET_PUBLIC_KEY,
    defaultSlippage: 99.999,
    priorityFee: 0.0001,
  })

  master.run()
}

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