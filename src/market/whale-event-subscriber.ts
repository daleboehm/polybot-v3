// Whale-event subscriber — Phase C1c (2026-04-11).
//
// Watches Polygon for trades by whitelisted whales on Polymarket's
// CTF Exchange, NegRisk CTF Exchange, and CTF contracts. When a
// whitelisted wallet trades, emits an internal event the whale-copy
// strategy can consume on its next scan cycle.
//
// Design decisions:
//
//   1. NOT a websocket subscriber — viem log subscription is flaky on
//      the free public RPC endpoints and would require a WSS endpoint
//      we don't have funding for. Instead, we POLL: every 60 seconds,
//      ask for Transfer + Trade logs in the block range since last poll,
//      filtered by from/to address matching any whitelisted whale.
//
//   2. POLL interval matches the scout tick (60s). The whale-copy
//      strategy processes results on its normal scan cycle (5 min prod,
//      2 min R&D), which means our effective detection latency is
//      60-120 seconds — consistent with the Bravado "2-5 minute book-
//      to-book latency" research. No mechanical way to beat that.
//
//   3. Event signatures are the 5 documented in Agent 3's research:
//        - OrderFilled         (0xd0a08e8c... CTF Exchange + NegRisk_CTFExchange)
//        - OrdersMatched       (0x63bf4d16... CTF Exchange)
//        - PositionSplit       (0xbbed930d... CTF + NegRiskAdapter)
//        - PositionsMerge      (0xba33ac50... CTF + NegRiskAdapter)
//        - PositionsConverted  (0xb03d19dd... NegRiskAdapter only)
//      Phase 1 of this subscriber implements OrderFilled + OrdersMatched
//      which are the two that directly indicate "whale bought/sold shares
//      in a specific market." The other three are position-management
//      events (merge/split/convert) we don't act on yet — parsing them
//      correctly requires decoding the event args for conditionId
//      extraction which we'll tackle when the whale-copy strategy is
//      proven to generate positive EV on the simpler events.
//
//   4. Fail-closed: any RPC error or parse failure logs and continues.
//      The subscriber is critical-path-nothing — if it misses a block
//      range, we just miss those whale trades. No state corruption
//      risk.
//
// DORMANT BY DEFAULT: the subscriber is only started when both
//   (a) at least one row exists in whitelisted_whales, AND
//   (b) WHALE_COPY_ENABLED=true env var is set
// The engine's startup code checks these two conditions before
// instantiating.

import {
  createPublicClient,
  http,
  parseAbiItem,
  type Hex,
  type Log,
  type PublicClient,
} from 'viem';
import { polygon } from 'viem/chains';
import { listActiveWhales, insertWhaleTrade } from '../storage/repositories/smart-money-repo.js';
import { eventBus } from '../core/event-bus.js';
import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('whale-event-subscriber');

// Polymarket contracts on Polygon (from Agent 3 research + verified)
const CTF_EXCHANGE: Hex = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const NEG_RISK_CTF_EXCHANGE: Hex = '0xC5d563A36AE78145C45a50134d48A1215220f80a';
// 2026-04-21 CTF V2 cutover — watch BOTH V1 and V2 exchanges during transition.
// V1 stops emitting after cutover; V2 takes over. Keeping V1 in the watch
// list is harmless (no events) and covers any lingering pre-cutover fills.
const CTF_EXCHANGE_V2: Hex = '0xE111180000d2663C0091e4f400237545B87B996B';
const NEG_RISK_CTF_EXCHANGE_V2: Hex = '0xe2222d279d744050d28e00520010520000310F59';

// OrderFilled event — V1 (pre-2026-04-21 cutover). Separate maker/takerAssetId fields.
const ORDER_FILLED_EVENT = parseAbiItem(
  'event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint256 makerAssetId, uint256 takerAssetId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee)',
);
// OrderFilled event — V2 (2026-04-21+). Drops separate asset IDs, unifies to side+tokenId.
// Derived from @polymarket/clob-client-v2 ExchangeV2 ABI.
const ORDER_FILLED_EVENT_V2 = parseAbiItem(
  'event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint8 side, uint256 tokenId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee)',
);

import { getPolygonRpcs } from './rpc-config.js';

export interface WhaleEventSubscriberConfig {
  /** Poll interval in ms. Default 60s. */
  poll_interval_ms: number;
  /** Max blocks to scan per poll. Polygon ~2s blocks → 30 blocks/min. */
  max_blocks_per_poll: number;
  /** Override the RPC list (useful for tests). */
  rpc_urls?: string[];
}

export const DEFAULT_WHALE_SUBSCRIBER_CONFIG: WhaleEventSubscriberConfig = {
  poll_interval_ms: 60_000,
  // Polygon ~2s blocks → 30 blocks/min. At 60s poll interval we need
  // ~30 blocks to stay current. Alchemy free tier caps at 10-block
  // range per getLogs call, so we chunk the scan into sub-ranges.
  max_blocks_per_poll: 100,
};

/**
 * Whale trade observation emitted on the event bus. The whale-copy
 * strategy subscribes to 'whale:trade_observed' and decides on its
 * next scan cycle whether to mirror the trade.
 */
export interface WhaleTradeObservation {
  proxy_wallet: Hex;
  tx_hash: Hex;
  block_number: bigint;
  // Asset IDs (Polymarket conditional tokens)
  maker_asset_id: bigint;
  taker_asset_id: bigint;
  maker_amount_filled: bigint;
  taker_amount_filled: bigint;
  // Role: was the whale the maker or taker?
  whale_is_maker: boolean;
}

export class WhaleEventSubscriber {
  private interval: NodeJS.Timeout | null = null;
  private running = false;
  private lastScannedBlock: bigint | null = null;
  private client: PublicClient | null = null;
  private rpcIndex = 0;

  constructor(
    private config: WhaleEventSubscriberConfig = DEFAULT_WHALE_SUBSCRIBER_CONFIG,
  ) {}

  private getClient(): PublicClient {
    if (this.client) return this.client;
    const rpcs = this.config.rpc_urls ?? getPolygonRpcs();
    const url = rpcs[this.rpcIndex % rpcs.length];
    if (!url) throw new Error('No RPC URLs configured');
    this.client = createPublicClient({ chain: polygon, transport: http(url) });
    return this.client;
  }

  /** Rotate to the next RPC on failure. */
  private rotateRpc(): void {
    this.rpcIndex++;
    this.client = null;
    log.debug({ new_rpc_index: this.rpcIndex }, 'Rotating RPC endpoint');
  }

  start(): void {
    if (this.interval) {
      log.warn('Whale subscriber already running');
      return;
    }
    // Check whitelisted_whales BEFORE starting the poll loop — if there
    // are zero whales we don't even bother waking up.
    const whales = listActiveWhales();
    if (whales.length === 0) {
      log.info('Whale subscriber not starting — zero whitelisted whales');
      return;
    }
    log.info(
      { whale_count: whales.length, poll_interval_ms: this.config.poll_interval_ms },
      'Whale event subscriber starting',
    );
    this.interval = setInterval(() => {
      if (this.running) return;
      this.pollOnce().catch(err => {
        log.error(
          { err: err instanceof Error ? err.message : String(err) },
          'Whale subscriber poll failed',
        );
      });
    }, this.config.poll_interval_ms);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      log.info('Whale subscriber stopped');
    }
  }

  async pollOnce(): Promise<void> {
    this.running = true;
    try {
      // Refresh whale set on every poll so newly-seeded whales are picked
      // up without requiring a restart. Cheap — one local SQL query.
      const whales = listActiveWhales();
      if (whales.length === 0) return;

      // Build a lowercase set of whale addresses for fast membership test
      const whaleSet = new Set(whales.map(w => w.proxy_wallet.toLowerCase()));

      const client = this.getClient();
      const currentBlock = await client.getBlockNumber();

      // Initialize lastScannedBlock on first poll to (currentBlock - N)
      // so we don't try to scan all of history.
      if (this.lastScannedBlock === null) {
        this.lastScannedBlock = currentBlock - 30n; // ~1 minute back
      }

      const fromBlock = this.lastScannedBlock + 1n;
      const maxRange = BigInt(this.config.max_blocks_per_poll);
      const toBlock = currentBlock > fromBlock + maxRange ? fromBlock + maxRange : currentBlock;

      if (toBlock < fromBlock) {
        // No new blocks yet
        return;
      }

      // Fetch OrderFilled events from both exchanges. We chunk into
      // sub-ranges of CHUNK_SIZE blocks to stay within Alchemy free
      // tier's 10-block getLogs limit. Other RPCs have similar limits.
      const CHUNK_SIZE = 8n; // conservative — Alchemy free caps at 10
      const logs: Log[] = [];
      let chunkFailed = false;
      // 2026-04-21: scan V1 + V2 exchanges with their respective event ABIs.
      const watchList = [
        { addr: CTF_EXCHANGE, event: ORDER_FILLED_EVENT },
        { addr: NEG_RISK_CTF_EXCHANGE, event: ORDER_FILLED_EVENT },
        { addr: CTF_EXCHANGE_V2, event: ORDER_FILLED_EVENT_V2 },
        { addr: NEG_RISK_CTF_EXCHANGE_V2, event: ORDER_FILLED_EVENT_V2 },
      ];
      for (const { addr: contract, event: eventDef } of watchList) {
        let chunkFrom = fromBlock;
        while (chunkFrom <= toBlock) {
          const chunkTo = chunkFrom + CHUNK_SIZE > toBlock ? toBlock : chunkFrom + CHUNK_SIZE;
          try {
            const contractLogs = await client.getLogs({
              address: contract,
              event: eventDef,
              fromBlock: chunkFrom,
              toBlock: chunkTo,
            });
            logs.push(...contractLogs);
          } catch (err) {
            log.warn(
              {
                contract,
                fromBlock: chunkFrom.toString(),
                toBlock: chunkTo.toString(),
                err: err instanceof Error ? err.message : String(err),
              },
              'getLogs chunk failed — rotating RPC',
            );
            this.rotateRpc();
            chunkFailed = true;
            break;
          }
          chunkFrom = chunkTo + 1n;
        }
        if (chunkFailed) break;
      }
      if (chunkFailed) {
        // Don't advance lastScannedBlock; retry the same range on next poll
        return;
      }

      let matched = 0;
      for (const l of logs) {
        // Type narrowing: with `event:` arg, viem returns decoded args
        const args = (l as unknown as { args?: Record<string, unknown> }).args;
        if (!args) continue;
        const maker = ((args.maker as string) ?? '').toLowerCase();
        const taker = ((args.taker as string) ?? '').toLowerCase();
        const whaleMaker = whaleSet.has(maker) ? maker : null;
        const whaleTaker = whaleSet.has(taker) ? taker : null;
        if (!whaleMaker && !whaleTaker) continue;

        matched++;
        const whaleWallet = (whaleMaker ?? whaleTaker)!;
        const observation: WhaleTradeObservation = {
          proxy_wallet: whaleWallet as Hex,
          tx_hash: l.transactionHash!,
          block_number: l.blockNumber!,
          maker_asset_id: BigInt((args.makerAssetId as bigint | string) ?? 0),
          taker_asset_id: BigInt((args.takerAssetId as bigint | string) ?? 0),
          maker_amount_filled: BigInt((args.makerAmountFilled as bigint | string) ?? 0),
          taker_amount_filled: BigInt((args.takerAmountFilled as bigint | string) ?? 0),
          whale_is_maker: whaleMaker !== null,
        };

        log.info(
          {
            whale: whaleWallet.substring(0, 14),
            tx: l.transactionHash?.substring(0, 14),
            block: l.blockNumber?.toString(),
            whale_role: whaleMaker ? 'maker' : 'taker',
          },
          'Whale trade observed',
        );

        // Write to whale_trades with action='skipped_other' as the
        // default — the whale-copy strategy will update the row
        // (if we implement action-backfill) or write its own row
        // when it decides to copy.
        try {
          insertWhaleTrade({
            proxy_wallet: whaleWallet,
            // condition_id + token_id can't be derived from OrderFilled
            // event alone — those are Polymarket-specific metadata we'd
            // need to look up via the CLOB API. Phase 2a leaves these
            // as placeholders; the whale-copy strategy will fill them
            // in when it processes the observation on its next scan.
            condition_id: '',
            token_id: observation.whale_is_maker
              ? observation.maker_asset_id.toString()
              : observation.taker_asset_id.toString(),
            side: observation.whale_is_maker ? 'SELL' : 'BUY',
            outcome: 'YES', // placeholder, resolved by strategy
            size: Number(
              observation.whale_is_maker
                ? observation.maker_amount_filled
                : observation.taker_amount_filled,
            ) / 1e6,
            price: 0, // resolved by strategy
            usdc_size: 0, // resolved by strategy
            block_number: Number(observation.block_number),
            tx_hash: l.transactionHash!,
            action: 'skipped_other',
            action_reason: 'observation-only, not yet routed to whale-copy strategy',
          });
        } catch (err) {
          log.debug(
            { err: err instanceof Error ? err.message : String(err) },
            'whale_trades insert failed (likely duplicate tx_hash)',
          );
        }

        // Emit the event for the whale-copy strategy to pick up
        eventBus.emit('whale:trade_observed', observation);
      }

      if (matched > 0 || logs.length > 100) {
        log.info(
          {
            from_block: fromBlock.toString(),
            to_block: toBlock.toString(),
            logs_scanned: logs.length,
            matched_whales: matched,
            whale_set_size: whaleSet.size,
          },
          'Whale poll complete',
        );
      }

      this.lastScannedBlock = toBlock;
    } finally {
      this.running = false;
    }
  }
}
