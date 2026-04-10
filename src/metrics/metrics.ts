// Prometheus-compatible metrics exposition.
//
// R3b (2026-04-10). Per design-decisions §R3b: the v3 engine exposes metrics
// at `/metrics` for Prometheus scraping. No external prom-client dependency —
// we format the text directly per the Prometheus text exposition format:
//   https://prometheus.io/docs/instrumenting/exposition_formats/
//
// Metrics exposed:
//   - polybot_scan_cycles_total{mode,entity}
//   - polybot_scan_duration_seconds{mode}
//   - polybot_signals_generated_total{strategy,sub_strategy}
//   - polybot_orders_total{side,status}
//   - polybot_open_positions{entity}
//   - polybot_cash_balance_usd{entity}
//   - polybot_reconciliation_drift_total{entity}
//   - polybot_api_errors_total{source}
//   - polybot_kill_switch_activations_total
//   - polybot_odds_api_quota_used (gauge)
//   - polybot_current_regime (gauge, encoded)

import { eventBus } from '../core/event-bus.js';
import { killSwitch } from '../core/kill-switch.js';

type LabelMap = Record<string, string>;

interface MetricSeries {
  name: string;
  help: string;
  type: 'counter' | 'gauge' | 'histogram';
  values: Map<string, number>; // label hash → value
}

export class MetricsRegistry {
  private metrics = new Map<string, MetricSeries>();

  constructor() {
    this.defineCounter('polybot_scan_cycles_total', 'Total number of scan cycles completed');
    this.defineGauge('polybot_scan_duration_ms', 'Duration of most recent scan cycle in ms');
    this.defineCounter('polybot_signals_generated_total', 'Total signals generated per strategy');
    this.defineCounter('polybot_orders_total', 'Total orders submitted');
    this.defineCounter('polybot_fills_total', 'Total order fills');
    this.defineGauge('polybot_open_positions', 'Current open position count per entity');
    this.defineGauge('polybot_cash_balance_usd', 'Cash balance per entity');
    this.defineGauge('polybot_trading_balance_usd', 'Trading balance per entity');
    this.defineCounter('polybot_reconciliation_errors_total', 'Reconciliation failures per entity');
    this.defineCounter('polybot_reconciliation_closes_total', 'Positions closed by reconciler');
    this.defineCounter('polybot_api_errors_total', 'External API errors by source');
    this.defineCounter('polybot_kill_switch_activations_total', 'Kill switch activations');
    this.defineGauge('polybot_kill_switch_halted', 'Kill switch halted flag (1 = halted, 0 = released)');
    this.defineGauge('polybot_odds_api_requests_this_month', 'Odds API requests this calendar month');
    this.defineGauge('polybot_current_regime_code', 'Current market regime (0=calm, 1=choppy, 2=trending, 3=volatile)');

    this.wireEventBus();
  }

  defineCounter(name: string, help: string): void {
    if (this.metrics.has(name)) return;
    this.metrics.set(name, { name, help, type: 'counter', values: new Map() });
  }

  defineGauge(name: string, help: string): void {
    if (this.metrics.has(name)) return;
    this.metrics.set(name, { name, help, type: 'gauge', values: new Map() });
  }

  incrementCounter(name: string, labels: LabelMap = {}, delta = 1): void {
    const metric = this.metrics.get(name);
    if (!metric || metric.type !== 'counter') return;
    const key = this.labelKey(labels);
    metric.values.set(key, (metric.values.get(key) ?? 0) + delta);
  }

  setGauge(name: string, value: number, labels: LabelMap = {}): void {
    const metric = this.metrics.get(name);
    if (!metric || metric.type !== 'gauge') return;
    const key = this.labelKey(labels);
    metric.values.set(key, value);
  }

  /**
   * Render in Prometheus text exposition format. Attach to `/metrics`
   * on the dashboard server.
   */
  render(): string {
    const lines: string[] = [];
    for (const m of this.metrics.values()) {
      lines.push(`# HELP ${m.name} ${m.help}`);
      lines.push(`# TYPE ${m.name} ${m.type}`);
      if (m.values.size === 0) {
        lines.push(`${m.name} 0`);
      } else {
        for (const [key, value] of m.values) {
          const labelStr = key ? `{${key}}` : '';
          lines.push(`${m.name}${labelStr} ${value}`);
        }
      }
    }
    return lines.join('\n') + '\n';
  }

  private labelKey(labels: LabelMap): string {
    const keys = Object.keys(labels).sort();
    if (keys.length === 0) return '';
    return keys.map(k => `${k}="${this.escapeLabel(labels[k])}"`).join(',');
  }

  private escapeLabel(v: string): string {
    return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  }

  private wireEventBus(): void {
    eventBus.on('engine:cycle_complete', ({ cycle, duration_ms }) => {
      this.incrementCounter('polybot_scan_cycles_total');
      this.setGauge('polybot_scan_duration_ms', duration_ms);
    });

    eventBus.on('signal:generated', ({ signal }) => {
      this.incrementCounter('polybot_signals_generated_total', {
        strategy: signal.strategy_id,
        sub_strategy: signal.sub_strategy_id ?? '',
      });
    });

    eventBus.on('order:submitted', ({ order }) => {
      this.incrementCounter('polybot_orders_total', { side: order.side, status: 'submitted' });
    });
    eventBus.on('order:filled', ({ fill }) => {
      this.incrementCounter('polybot_fills_total', { side: fill.side, paper: String(fill.is_paper) });
    });
    eventBus.on('order:rejected', () => {
      this.incrementCounter('polybot_orders_total', { side: 'unknown', status: 'rejected' });
    });

    eventBus.on('killswitch:activated', () => {
      this.incrementCounter('polybot_kill_switch_activations_total');
      this.setGauge('polybot_kill_switch_halted', 1);
    });
    eventBus.on('killswitch:released', () => {
      this.setGauge('polybot_kill_switch_halted', 0);
    });

    eventBus.on('reconciler:complete', ({ result }) => {
      if (result.errors.length > 0) {
        this.incrementCounter('polybot_reconciliation_errors_total', { entity: result.entitySlug }, result.errors.length);
      }
      const closes = result.actions.filter(a => a.kind === 'close_resolved' || a.kind === 'close_absent').length;
      if (closes > 0) {
        this.incrementCounter('polybot_reconciliation_closes_total', { entity: result.entitySlug }, closes);
      }
    });
  }
}

// Module singleton
export const metricsRegistry = new MetricsRegistry();
