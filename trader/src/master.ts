// master.ts
import { Strategy } from "@/trader/interfaces.ts"
import { InfluxService } from "@/trader/services/influx_service.ts"
import { TradePortalService } from "@/trader/services/trade_portal.ts"
import { DummyStrategy } from "@/trader/strategy/dummy_strategy.ts"
import { TokenWorker } from "@/trader/token_worker.ts"
import { parseArgs } from "jsr:@std/cli/parse-args";
/**
 * Configuration passed to the Master when we start the bot.
 */
export interface MasterConfig {
  maxOpenPositions: number        // e.g. 5
  dryRun: boolean                 // if true, run historical simulation
  historicalStart?: string        // e.g. "2024-01-01T00:00:00Z"
  historicalEnd?: string          // e.g. "2024-01-01T01:00:00Z"
  // General services & secrets
  influxService: InfluxService
  tradePortal: TradePortalService
  defaultStrategy: Strategy       // e.g. new DummyStrategy()
  walletPublicKey: string
  denominatedInSol: boolean
  defaultSlippage: number
  priorityFee: number
  pool: "pump" | "raydium"
}

interface ActivePosition {
  worker: TokenWorker
  token: string
  bought: boolean
  sold: boolean
}

/**
 * The Master class manages:
 *  1. Discovering new tokens (in real-time or from historical data).
 *  2. Spawning worker processes up to a concurrency limit.
 *  3. Handling termination of workers when a token is fully traded.
 */
export class Master {
  private activePositions: Map<string, ActivePosition> = new Map();
  private isRunning = false;

  constructor(private config: MasterConfig) { }

  /**
   * Entry point: If dryRun = false, we do real-time discovery (stubbed).
   * If dryRun = true, we replay historical data.
   */
  public async run(): Promise<void> {
    this.isRunning = true

    if (this.config.dryRun) {
      console.log("[Master] Starting DRY RUN with historical data...")
      await this.runHistoricalMode()
    } else {
      console.log("[Master] Starting LIVE mode with dynamic worker management...")
      await this.runLiveMode()
    }

    console.log("[Master] Done. Exiting run() method.")
  }

  /**
   * Example method for discovering new tokens in real time.
   * In a real system, you might connect to a WebSocket or subscription feed
   * that announces new tokens as they appear.
   */
  private async runLiveMode(): Promise<void> {
    while (this.isRunning) {
      try {
        // Hypothetical call: list tokens minted in the last X minutes
        const newTokens = await this.config.influxService.listNewTokensSince(Date.now() - 60_000)

        for (const token of newTokens) {
          // Check if we already have a worker for this token or if we've hit concurrency limit
          if (this.activePositions.size >= this.config.maxOpenPositions) {
            console.log("[Master] Reached max open positions, skipping new tokens...")
            break
          }
          if (!this.activePositions.has(token)) {
            console.log(`[Master] Found new token: ${token}. Spawning worker...`)
            this.spawnWorker(token)
          }
        }

        // For demonstration, we just wait some time before checking again
        // In real usage, you'd rely on a push-based event or Pub/Sub
        await new Promise((resolve) => setTimeout(resolve, 5000))
      } catch (err) {
        console.error("[Master] Error in runLiveMode:", err)
        // Decide whether to continue or break. We'll continue here.
      }
    }
  }

  /**
   * Example method for historical simulation between config.historicalStart and config.historicalEnd.
   *  1. Gather a list of tokens that were minted during that time.
   *  2. For each token, fetch its historical market cap timeline.
   *  3. Replay those market cap updates in chronological order.
   */
  private async runHistoricalMode(): Promise<void> {
    const start = this.config.historicalStart ?? "2024-01-01T00:00:00Z"
    const end = this.config.historicalEnd ?? new Date().toISOString()

    // 1) Find tokens minted in [start, end]
    const tokens = await this.config.influxService.listTokensMintedInRange(start, end)
    console.log(`[Master] Historical mode: discovered ${tokens.length} tokens in the range ${start} -> ${end}`)

    // 2) For each token, we replay market cap updates. Since concurrency might apply, we
    //    do a simple sequential approach to keep it straightforward. Or we could do partial concurrency.
    for (const token of tokens) {
      // Check concurrency limit
      if (this.activePositions.size >= this.config.maxOpenPositions) {
        console.log("[Master] Reached max open positions for dry run, skipping token:", token)
        continue
      }

      console.log(`[Master] Starting historical replay for token: ${token}`)

      // Spawn a worker
      const worker = this.spawnWorker(token, true)

      // 3) Fetch historical data for the token, then replay in chronological order
      const historicalPoints = await this.config.influxService.fetchHistoricalMarketData(token, start, end)

      // Sort by time ascending
      historicalPoints.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime())

      for (const point of historicalPoints) {
        // feed the worker
        await worker.handleMarketCapUpdate(point.marketCap)
      }

      // Once done, that worker either sold or the strategy never sold.
      // We can forcibly finalize the worker if needed, or just rely on the worker’s logic.
      console.log(`[Master] Finished replay for token: ${token}`)
    }

    // After finishing all tokens, we can exit
    this.isRunning = false
  }

  /**
   * Creates and stores a worker for the given token.
   * If called with `isDryRun=true`, the worker won't do real trades.
   */
  private spawnWorker(tokenMint: string, isDryRun = false): TokenWorker {
    const worker = new TokenWorker({
      tokenMint,
      strategy: this.config.defaultStrategy,
      traderAddress: this.config.walletPublicKey,
      denominatedInSol: this.config.denominatedInSol,
      defaultSlippage: this.config.defaultSlippage,
      priorityFee: this.config.priorityFee,
      pool: this.config.pool,
      influx: this.config.influxService,
      tradePortal: this.config.tradePortal,
      dryRun: isDryRun,
    })

    const position: ActivePosition = {
      worker,
      token: tokenMint,
      bought: false,
      sold: false,
    }

    this.activePositions.set(tokenMint, position)

    // The TokenWorker doesn't necessarily run in a separate thread in Deno, 
    // but we can still keep track of when it finishes (i.e. sells).
    // We'll do it by monkey-patching or providing a callback to the worker’s buy/sell methods.
    // For brevity, let's just do a setInterval check to see if the worker is done.
    // In real usage, you'd do an event or callback approach.
    const checkInterval = setInterval(() => {
      // We'll see if the worker is sold
      if (worker.isComplete()) {
        // Mark position as complete and free resources
        clearInterval(checkInterval)
        this.activePositions.delete(tokenMint)
        console.log(`[Master] Worker for token ${tokenMint} has completed trading. Removed from active positions.`)
      }
    }, 3000)

    return worker
  }
}

if (import.meta.main) {
  // Define the expected command-line arguments
  const args = parseArgs(Deno.args, {
    boolean: ["dryRun"],
    string: ["historicalStart", "historicalEnd"],
    default: {
      dryRun: false,
    },
    alias: {
      dryRun: ["dry-run"],
      historicalStart: ["start"],
      historicalEnd: ["end"],
    },
  });

  const dryRun: boolean = args.dryRun;
  const historicalStart: string | undefined = args.historicalStart;
  const historicalEnd: string | undefined = args.historicalEnd;

  if (dryRun) {
    if (!historicalStart || !historicalEnd) {
      console.error(
        "Error: '--historicalStart' and '--historicalEnd' must be provided when '--dryRun' is enabled."
      );
      Deno.exit(1);
    }
  }

  // TODO
  if (!dryRun) {
    throw new Error("Live mode not implemented yet")
  }

  const RPC_ENDPOINT = Deno.env.get("RPC_ENDPOINT") || "https://api.mainnet-beta.solana.com";
  const WALLET_SECRET = Deno.env.get("WALLET_SECRET_KEY") || "YOUR_BASE58_PRIVATE_KEY";
  const WALLET_PUBLIC_KEY = Deno.env.get("WALLET_PUBLIC_KEY") || "YOUR_WALLET_PUBLIC_KEY";
  const INFLUX_URL = Deno.env.get("INFLUX_URL") || "http://localhost:8086";
  const INFLUX_TOKEN = Deno.env.get("INFLUX_TOKEN") || "my-influx-token";
  const INFLUX_ORG = Deno.env.get("INFLUX_ORG") || "my-org";
  const INFLUX_BUCKET = Deno.env.get("INFLUX_BUCKET") || "trader-actions";

  const influxService = new InfluxService(INFLUX_URL, INFLUX_TOKEN, INFLUX_ORG, INFLUX_BUCKET);
  const tradePortalService = new TradePortalService({
    dryRun,
    rpcEndpoint: RPC_ENDPOINT,
    walletSecretKey: WALLET_SECRET,
  });

  const master = new Master({
    maxOpenPositions: 3,
    dryRun,
    historicalStart,
    historicalEnd,
    influxService,
    tradePortal: tradePortalService,
    defaultStrategy: new DummyStrategy(),
    walletPublicKey: WALLET_PUBLIC_KEY,
    denominatedInSol: false,
    defaultSlippage: 10,
    priorityFee: 0.00001,
    pool: "pump",
  });

  master.run();
}
