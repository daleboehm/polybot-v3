// Routes orders to either CLOB API (live) or paper simulator

import type { Order, OrderFill, Outcome } from '../types/index.js';
import type { EntityState } from '../types/index.js';
import type { PaperSimulator } from './paper-simulator.js';
import type { MarketCache } from '../market/market-cache.js';
import { insertOrder, updateOrderStatus } from '../storage/repositories/order-repo.js';
import { insertTrade } from '../storage/repositories/trade-repo.js';
import { eventBus } from '../core/event-bus.js';
import { createChildLogger } from '../core/logger.js';
import { getPrimaryRpc } from '../market/rpc-config.js';
import { killSwitch } from '../core/kill-switch.js';
import { nanoid } from 'nanoid';
import { roundTo } from '../utils/math.js';

const log = createChildLogger('clob-router');

export class ClobRouter {
  private clobClients = new Map<string, ClobClientWrapper>();

  constructor(
    private paperSimulator: PaperSimulator,
    private clobBaseUrl: string,
    private marketCache: MarketCache,
  ) {}

  async routeOrder(order: Order, entity: EntityState): Promise<OrderFill | null> {
    // Kill switch gate — checked before any side-effect. Throws if halted;
    // caller catches and logs as rejected order.
    killSwitch.check();

    insertOrder(order);
    eventBus.emit('order:submitted', { order });

    try {
      let fill: OrderFill | null;

      if (order.is_paper) {
        fill = await this.paperSimulator.simulateFill(order);
      } else {
        fill = await this.submitToClob(order, entity);
      }

      if (fill) {
        updateOrderStatus(order.order_id!, 'filled', fill.size);
        order.status = 'filled';
        order.filled_size = fill.size;
        order.remaining_size = 0;
        order.filled_at = new Date();

        insertTrade(fill);
        eventBus.emit('order:filled', { fill });

        log.info({
          order_id: order.order_id,
          trade_id: fill.trade_id,
          entity: fill.entity_slug,
          side: fill.side,
          price: fill.price,
          size: fill.size,
          usdc: fill.usdc_size,
          paper: fill.is_paper,
        }, 'Order filled');
      }

      return fill;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      updateOrderStatus(order.order_id!, 'rejected', undefined, errorMsg);
      eventBus.emit('order:rejected', { order_id: order.order_id!, reason: errorMsg });
      log.error({ order_id: order.order_id, err }, 'Order routing failed');
      return null;
    }
  }

  private async submitToClob(order: Order, entity: EntityState): Promise<OrderFill | null> {
    if (!entity.credentials) {
      throw new Error(`No CLOB credentials for entity ${entity.config.slug}`);
    }

    const creds = entity.credentials;

    // Lazy-init CLOB client per entity
    let client = this.clobClients.get(entity.config.slug);
    if (!client) {
      client = new ClobClientWrapper(
        this.clobBaseUrl,
        creds.private_key,
        creds.api_key,
        creds.api_secret,
        creds.api_passphrase,
      );
      this.clobClients.set(entity.config.slug, client);
      log.info({ entity: entity.config.slug }, 'CLOB client initialized');
    }

    // Get market info for neg_risk flag
    const market = this.marketCache.get(order.condition_id);

    // Submit order via CLOB
    const result = await client.placeOrder(
      order.token_id,
      order.side,
      order.price,
      order.size,
      market?.neg_risk ?? false,
    );

    if (!result.success) {
      throw new Error(`CLOB order rejected: ${result.error}`);
    }

    // Determine outcome from token
    let outcome: Outcome = 'YES';
    if (market) {
      outcome = order.token_id === market.token_yes_id ? 'YES' : 'NO';
    }

    // Fee model: HARD-CODED 0 per the second 2026-04-10 fix.
    // See paper-simulator.ts for the full history — short version: the CLOB API
    // returns `taker_base_fee` as a scaled integer (e.g. 1000 for 1641 of 6288
    // markets), and the morning fix that read it as a decimal produced a $51,479 fee
    // on a $51 trade. Polymarket's real mainnet CLOB taker fee is 0 today; hard-coding
    // to 0 restores symmetry with live execution until the correct scaling factor is
    // verified from Polymarket docs.
    const feeRate = 0;
    const usdcSize = roundTo(order.price * order.size, 4);
    const feeUsdc = roundTo(usdcSize * feeRate, 4);
    const netUsdc = order.side === 'BUY'
      ? roundTo(usdcSize + feeUsdc, 4)  // buying costs more
      : roundTo(usdcSize - feeUsdc, 4); // selling nets less

    const fill: OrderFill = {
      trade_id: result.order_id ?? `live_${nanoid(12)}`,
      order_id: order.order_id!,
      entity_slug: order.entity_slug,
      condition_id: order.condition_id,
      token_id: order.token_id,
      tx_hash: result.tx_hash ?? null,
      side: order.side,
      size: order.size,
      price: order.price,
      usdc_size: usdcSize,
      fee_usdc: feeUsdc,
      net_usdc: netUsdc,
      is_paper: false,
      strategy_id: order.strategy_id,
      sub_strategy_id: order.sub_strategy_id,
      outcome,
      market_question: market?.question ?? '',
      market_slug: market?.market_slug ?? '',
      timestamp: Math.floor(Date.now() / 1000),
    };

    return fill;
  }

  async cancelOrder(orderId: string, _entity: EntityState): Promise<void> {
    updateOrderStatus(orderId, 'cancelled');
    eventBus.emit('order:cancelled', { order_id: orderId, reason: 'user_requested' });
    log.info({ order_id: orderId }, 'Order cancelled');
  }
}

/**
 * Thin wrapper around @polymarket/clob-client for live order execution.
 */
class ClobClientWrapper {
  private client: InstanceType<typeof import('@polymarket/clob-client').ClobClient> | null = null;
  private host: string;
  private privateKey: string;
  private apiKey: string;
  private apiSecret: string;
  private apiPassphrase: string;

  constructor(host: string, privateKey: string, apiKey: string, apiSecret: string, apiPassphrase: string) {
    this.host = host;
    this.privateKey = privateKey;
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.apiPassphrase = apiPassphrase;
  }

  private async getClient() {
    if (this.client) return this.client;
    const mod = await import('@polymarket/clob-client');
    const { createWalletClient, http } = await import('viem');
    const { privateKeyToAccount } = await import('viem/accounts');
    const { polygon } = await import('viem/chains');

    const account = privateKeyToAccount(this.privateKey as `0x${string}`);
    const walletClient = createWalletClient({
      account,
      chain: polygon,
      transport: http(getPrimaryRpc()),
    });

    this.client = new mod.ClobClient(
      this.host,
      137,
      walletClient,
      { key: this.apiKey, secret: this.apiSecret, passphrase: this.apiPassphrase },
    );
    return this.client;
  }

  async placeOrder(
    tokenId: string,
    side: string,
    price: number,
    size: number,
    negRisk: boolean,
  ): Promise<{ success: boolean; order_id?: string; tx_hash?: string; error?: string }> {
    try {
      const client = await this.getClient();
      const mod = await import('@polymarket/clob-client');

      const orderSide = side === 'BUY' ? mod.Side.BUY : mod.Side.SELL;

      const userOrder = {
        tokenID: tokenId,
        price,
        size,
        side: orderSide,
      };

      log.info({
        token: tokenId.substring(0, 20) + '...',
        side,
        price,
        size,
        negRisk,
      }, 'Submitting CLOB order');

      // Create signed order (negRisk uses createOrderOptions)
      const options = negRisk ? { negRisk: true } : undefined;
      const signedOrder = await client.createOrder(userOrder, options);

      // Post to CLOB
      const response = await client.postOrder(signedOrder);

      log.info({
        response: typeof response === 'object' ? JSON.stringify(response).substring(0, 200) : String(response),
      }, 'CLOB order response');

      if (response && typeof response === 'object') {
        const resp = response as Record<string, unknown>;
        if (resp.success === false || resp.errorMsg) {
          return { success: false, error: String(resp.errorMsg ?? 'Order rejected by CLOB') };
        }
        return {
          success: true,
          order_id: String(resp.orderID ?? resp.order_id ?? resp.id ?? ''),
        };
      }

      return { success: true, order_id: String(response) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, 'CLOB order failed');
      return { success: false, error: msg };
    }
  }
}
