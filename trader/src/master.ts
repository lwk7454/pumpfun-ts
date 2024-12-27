// master.ts
import { StrategyConstructor, TokenEvent, TradeEvent } from "@/trader/interfaces.ts"
import { InfluxService } from "@/trader/services/influx_service.ts"
import { TradePortalService } from "@/trader/services/trade_portal.ts"
import { DummyStrategy } from "@/trader/strategy/dummy_strategy.ts"
import { TokenWorker } from "@/trader/token_worker.ts"
import { parseArgs } from "jsr:@std/cli/parse-args";
import { wait } from "@/shared/utils.ts"

export interface MasterConfig {
  maxOpenPositions: number
  baseBid: number
  dryRun: boolean
  influxService: InfluxService
  tradePortal: TradePortalService
  defaultStrategy: StrategyConstructor
  walletPublicKey: string
  defaultSlippage: number
  priorityFee: number
}

/**
 * The Master class manages:
 *  1. Discovering new tokens (in real-time or from historical data).
 *  2. Spawning worker processes up to a concurrency limit.
 *  3. Handling termination of workers when a token is fully traded.
 */
export class Master {
  private activeWorkers: Map<string, TokenWorker> = new Map();
  private isRunning = false;
  private ws?: WebSocket;
  constructor(private config: MasterConfig) { }

  // Entry point
  public async run(): Promise<void> {
    this.isRunning = true

    if (!this.config.dryRun) {
      this.runLive()
    }

    await this.heartBeat()
  }

  public close(): void {
    if(this.ws) {
      this.ws.close()
    }
    Array.from(this.activeWorkers.keys()).forEach((token) => {
      this.closeWorker(token)
    })
    this.isRunning = false
  }

  private runLive() {
    if (this.ws) {
      this.ws.close()
      this.ws = undefined
      console.log('Socket reset')
    } else {
      console.log('Starting master')
    }
    this.ws = new WebSocket(`wss://pumpportal.fun/api/data`)

    this.ws.onerror = e => {
      console.error('WS Error', e)
      setTimeout(() => {
        this.runLive()
      }, 5000)
    }

    this.ws.onopen = () => {
      console.log("Connected to market feed.")
      this.ws!.send(
        JSON.stringify({
          method: "subscribeNewToken",
        }),
      )
    }

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)

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

          if (!this.activeWorkers.has(mint)) {
            // Subscribe to trade events for the new token
            this.ws!.send(
              JSON.stringify({
                method: "subscribeTokenTrade",
                keys: Array.from(this.activeWorkers.keys()),
              }),
            )
            console.log("Subscribed to token trade events for:", mint)
          }

          this.onEvent(tokenEvent)
        }
      } catch (err) {
        console.error("Error processing message:", { event, err })
      }
    }
  }

  private async heartBeat() {
    while (this.isRunning) {
      console.log("[Master] Heartbeat")
      this.activeWorkers.forEach((worker) => {
        worker.enqueueEvent({ type: "heartbeat" })
      })

      await wait(1000)
    }
  }

  public onEvent(event: TokenEvent) {
    console.log("[Master] Event:", event)

    if (this.activeWorkers.has(event.mint)) {
      this.activeWorkers.get(event.mint)!.enqueueEvent({ type: "marketCapUpdate", event })
    } else {
      this.spawnWorker(event)
    }
  }

  public closeWorker(mint: string) {
    console.log(`[Master] Closing worker for token ${mint}`)
    this.activeWorkers.delete(mint)
  }

  private spawnWorker(event: TokenEvent): TokenWorker {
    const { mint } = event
    const {
       defaultStrategy, walletPublicKey, defaultSlippage, 
       priorityFee, influxService, tradePortal, dryRun, baseBid
    } = this.config
    
    const worker = new TokenWorker({
      initEvent: event,
      strategy: defaultStrategy,
      baseBid,
      traderAddress: walletPublicKey,
      defaultSlippage,
      priorityFee,
      influx: influxService,
      tradePortal,
      dryRun,
    }, () => {
      this.closeWorker(mint)
    })

    this.activeWorkers.set(mint, worker)
    return worker
  }
}

if (import.meta.main) {
  // Define the expected command-line arguments
  const args = parseArgs(Deno.args, {
    boolean: ["dryRun"],
    string: ["maxOpenPositions", "baseBid"],
    default: {
      dryRun: false,
      maxOpenPositions: "10",
      baseBid: "0.1",
    },
    alias: {
      dryRun: ["dry"],
      maxOpenPositions: ["concurrency"],
      baseBid: ["bid"],
    },
  });

  const dryRun: boolean = args.dryRun;
  const maxOpenPositions: number = Number(args.maxOpenPositions);
  const baseBid: number = Number(args.baseBid);

  // TODO
  if (!dryRun) {
    throw new Error("Live mode not implemented yet")
  }

  const RPC_ENDPOINT = Deno.env.get("RPC_ENDPOINT") || "https://api.mainnet-beta.solana.com";
  const WALLET_SECRET = Deno.env.get("WALLET_SECRET_KEY") || "YOUR_BASE58_PRIVATE_KEY";
  const WALLET_PUBLIC_KEY = Deno.env.get("WALLET_PUBLIC_KEY") || "YOUR_WALLET_PUBLIC_KEY";

  const influxService = new InfluxService();
  const tradePortalService = new TradePortalService({
    rpcEndpoint: RPC_ENDPOINT,
    walletSecretKey: WALLET_SECRET,
  });

  const master = new Master({
    maxOpenPositions,
    baseBid,
    dryRun,
    influxService,
    tradePortal: tradePortalService,
    defaultStrategy: DummyStrategy,
    walletPublicKey: WALLET_PUBLIC_KEY,
    defaultSlippage: 10,
    priorityFee: 0.00001,
  });

  master.run();
}
