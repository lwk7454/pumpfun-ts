// master.ts
import { logger, printSol, shorten, wait } from "@/shared/utils.ts"
import { StrategyConstructor, TokenEvent, TradeEvent } from "@/trader/interfaces.ts"
import { InfluxService, PumpFunService } from "@/trader/services/index.ts"
import { HealthyGrowthStrategy } from '@/trader/strategy/index.ts'
import { TokenWorker, WorkerResult } from "@/trader/token_worker.ts"
import { parseArgs } from "jsr:@std/cli/parse-args"

export interface MasterConfig {
  maxOpenPositions: number
  baseBid: number
  dryRun: boolean
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

/**
 * The Master class manages:
 *  1. Discovering new tokens (in real-time or from historical data).
 *  2. Spawning worker processes up to a concurrency limit.
 *  3. Handling termination of workers when a token is fully traded.
 */
export class Master {
  private activeWorkers: Map<string, TokenWorker> = new Map();
  private subscribedTokens: Set<string> = new Set()
  private isRunning = false;
  private ws?: WebSocket
  private workerResults: WorkerResult[] = []
  private closedTokens: Set<string> = new Set()
  private openPositions: Set<TokenWorker> = new Set()
  private lastReportTime: number = Date.now()
  private minSolBalance: number

  constructor(private config: MasterConfig) {
    this.minSolBalance = this.config.maxOpenPositions * ((this.config.baseBid * 1.01) + this.config.priorityFee + 0.00203928)
  }

  // Entry point
  public async run(): Promise<void> {
    this.isRunning = true

    if (!this.config.dryRun) {
      this.runLive()
    }

    await this.heartBeat()
  }

  public close(): void {
    if (this.ws) {
      this.ws.close()
    }
    Array.from(this.activeWorkers.keys()).forEach((token) => {
      this.closeWorker(token)
    })
    this.isRunning = false

    const report = this.generateReport()
    logger.info(
      `[Master] Final Report: 
        Profit: ${printSol(report.solDelta)} SOL,
        Subscribed tokens: ${this.subscribedTokens.size}, 
        Traded tokens: ${report.tradedTokenCount},
        Fee: ${printSol(report.feeTotal)} SOL,
        Traded SOL: ${printSol(report.tradedSol)} SOL,
        Open positions: ${this.openPositions.size}
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
    return {
      solDelta,
      tokenDelta,
      tradedTokenCount: this.workerResults.length,
      feeTotal,
      tradedSol,
    }
  }

  private runLive() {
    if (this.ws) {
      this.ws.close()
      this.ws = undefined
      logger.info('Socket reset')
    } else {
      logger.info('Starting master')
    }
    this.ws = new WebSocket(`wss://pumpportal.fun/api/data`)

    this.ws.onerror = e => {
      logger.error('WS Error', e)
      setTimeout(() => {
        this.runLive()
      }, 5000)
    }

    this.ws.onopen = () => {
      logger.info("Connected to market feed.")
      this.ws!.send(
        JSON.stringify({
          method: "subscribeNewToken",
        }),
      )
    }

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)

        if (data.txType === 'create') {
          const event = data as TradeEvent
          const { mint } = event
          this.subscribedTokens.add(mint)
          this.ws!.send(
            JSON.stringify({
              method: "subscribeTokenTrade",
              keys: Array.from(this.subscribedTokens),
            }),
          )
          // logger.info("Subscribed to token trade events for:", mint)
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
    while (this.isRunning) {
      this.activeWorkers.forEach((worker) => {
        worker.enqueueCommand({ type: "heartbeat" })
      })

      if (Date.now() - this.lastReportTime > 1000 * 10) {
        const report = this.generateReport()
        logger.info(
          `[Master] Report 
          profit: ${printSol(report.solDelta)} SOL, 
          Subscribed tokens: ${this.subscribedTokens.size}, 
          Traded tokens: ${report.tradedTokenCount},
          Fee: ${printSol(report.feeTotal)} SOL,
          Traded SOL: ${printSol(report.tradedSol)} SOL,
          Open positions: ${this.openPositions.size}
        `)

        // check sol balance, close all if can't open max positions
        const balance = await this.config.pumpFun.getSolBalance()

        if (balance < this.minSolBalance) {
          logger.info("[Master] Balance is too low, closing all positions", { balance, minSolBalance: this.minSolBalance })
          this.close()
        }

        this.lastReportTime = Date.now()
      }

      await wait(1)
    }
  }

  public onEvent(event: TokenEvent) {
    if (this.activeWorkers.has(event.mint)) {
      this.activeWorkers.get(event.mint)!.enqueueCommand({ type: "marketCapUpdate", event })
    } else if (!this.closedTokens.has(event.mint)) {
      this.spawnWorker(event)
    }
  }

  public closeWorker(mint: string) {
    this.closedTokens.add(mint)
    this.activeWorkers.delete(mint)
  }

  private spawnWorker(event: TokenEvent): TokenWorker {
    const { mint } = event
    const {
      defaultStrategy, walletPublicKey, defaultSlippage,
      priorityFee, influxService, pumpFun, dryRun, baseBid
    } = this.config

    const worker = new TokenWorker({
      initEvent: event,
      strategy: defaultStrategy,
      baseBid,
      traderAddress: walletPublicKey,
      defaultSlippage,
      priorityFee,
      influx: influxService,
      pumpFun,
      dryRun,
    }, this)

    this.activeWorkers.set(mint, worker)
    return worker
  }

  public onWorkerComplete(result: WorkerResult) {
    if (result.solDelta !== 0) { // Only log if there was a profit/loss
      this.workerResults.push(result)
      logger.info(`[Master] Closing Token ${shorten(result.mint)}... Profit: ${printSol(result.solDelta)} SOL, Remaining Tokens: ${result.tokenDelta}`)
    }
    this.subscribedTokens.delete(result.mint)
    this.closeWorker(result.mint)
  }

  public openPosition(worker: TokenWorker) {
    this.openPositions.add(worker)
  }

  public closePosition(worker: TokenWorker) {
    this.openPositions.delete(worker)
  }

  public allowBuy(): boolean {
    return this.openPositions.size < this.config.maxOpenPositions
  }
}

if (import.meta.main) {
  logger.initFileLogger(`./logs/live-${new Date().toISOString()}/`)
  // Define the expected command-line arguments
  const args = parseArgs(Deno.args, {
    boolean: ["dryRun"],
    string: ["maxOpenPositions", "baseBid"],
    default: {
      dryRun: false,
      maxOpenPositions: "50",
      baseBid: "0.01",
    },
    alias: {
      dryRun: ["dry"],
      maxOpenPositions: ["concurrency"],
      baseBid: ["bid"],
    },
  })

  const dryRun: boolean = args.dryRun
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
    dryRun,
    influxService,
    pumpFun: pumpFun,
    // defaultStrategy: DummyStrategy,
    defaultStrategy: HealthyGrowthStrategy,
    walletPublicKey: WALLET_PUBLIC_KEY,
    defaultSlippage: 10,
    priorityFee: 0.00003,
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