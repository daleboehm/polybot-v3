// SSE dashboard server — REST API + Server-Sent Events + cookie-session auth

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import Database from 'better-sqlite3';
import type { DashboardConfig } from '../types/index.js';
import type { Engine } from '../core/engine.js';
import { eventBus } from '../core/event-bus.js';
import { getEntityPnlView } from '../storage/repositories/entity-repo.js';
import { getTradesByEntity } from '../storage/repositories/trade-repo.js';
import { getOpenPositions, getOpenPositionsWithMarketMeta } from '../storage/repositories/position-repo.js';
import { getOrdersByEntity, getOpenOrders } from '../storage/repositories/order-repo.js';
import { getResolutionsByEntity, getStrategyPerformance, getStrategyRolling, getStrategyCheckpoints } from '../storage/repositories/resolution-repo.js';
import { getSnapshots } from '../storage/repositories/snapshot-repo.js';
import { getMarketCount, getActiveMarkets } from '../storage/repositories/market-repo.js';
import { createChildLogger } from '../core/logger.js';
import { killSwitch } from '../core/kill-switch.js';
import { metricsRegistry } from '../metrics/metrics.js';
import { getDatabase } from '../storage/database.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const log = createChildLogger('dashboard');
const __dirname = dirname(fileURLToPath(import.meta.url));

// Session management
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
// Stable secret derived from env — survives restarts so sessions stay valid
const SECRET = createHmac('sha256', process.env.DASHBOARD_PASSWORD ?? 'polybot-v3-session-key').update('session-secret').digest('hex');
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

interface Session {
  user: string;
  created: number;
  csrf: string;
}

interface LoginAttempts {
  count: number;
  lockedUntil: number | null;
}

export class DashboardServer {
  private server: ReturnType<typeof createServer> | null = null;
  private sseClients: Set<ServerResponse> = new Set();
  private sessions = new Map<string, Session>();
  private loginAttempts = new Map<string, LoginAttempts>();
  private basePath: string;       // '' for prod, '/rd' for R&D
  private cookieName: string;     // unique per instance to avoid collision

  constructor(
    private config: DashboardConfig,
    private engine: Engine,
  ) {
    this.basePath = process.env.BASE_PATH ?? '';
    this.cookieName = this.basePath ? 'session_rd' : 'session';
  }

  start(): void {
    this.server = createServer((req, res) => this.handleRequest(req, res));
    this.wireSSE();
    this.server.listen(this.config.port, () => {
      log.info({ port: this.config.port }, 'Dashboard server started');
    });
  }

  stop(): void {
    for (const client of this.sseClients) {
      client.end();
    }
    this.sseClients.clear();
    this.server?.close();
    log.info('Dashboard server stopped');
  }

  /**
   * POST /api/kill-switch — authenticated. Body: { action: 'halt' | 'resume', reason?, message? }
   * Lets the operator halt or resume the engine from the dashboard without
   * needing shell access. R3b (2026-04-10).
   */
  private async handleKillSwitchPost(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body = '';
    for await (const chunk of req) body += chunk;
    let payload: { action?: string; reason?: string; message?: string; operator?: string };
    try {
      payload = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    if (payload.action === 'halt') {
      killSwitch.halt('operator_dashboard', payload.message ?? 'dashboard POST');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'halted', ...killSwitch.status() }));
      return;
    }
    if (payload.action === 'resume') {
      killSwitch.resume(payload.operator ?? 'dashboard');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'released', ...killSwitch.status() }));
      return;
    }
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'action must be halt or resume' }));
  }

  /**
   * Unauthenticated health endpoint. Returns 200 when DB is reachable and the
   * engine has scanned within the last 10 minutes (or within the first 60s
   * after startup). Returns 503 otherwise. Kill-switch activation returns 503
   * with the reason in the payload.
   *
   * Used by Uptime Kuma (R3b) and the operator runbooks. No secrets in the
   * response — just status flags + aggregate counts.
   */
  private handleHealth(res: ServerResponse): void {
    const payload: Record<string, unknown> = {
      status: 'unknown',
      timestamp: new Date().toISOString(),
    };
    let httpStatus = 200;

    try {
      // DB reachability
      const db = getDatabase();
      const dbOk = db.prepare('SELECT 1 as ok').get() !== undefined;
      payload.db = dbOk;
      if (!dbOk) httpStatus = 503;

      // Engine state
      const stats = this.engine.getStats();
      payload.engine = {
        running: stats.running,
        cycles: stats.cycles,
        entities: stats.entities,
        active_entities: stats.active_entities,
        strategies: stats.strategies,
        markets_cached: stats.markets_cached,
        ws_connected: stats.ws_connected,
      };
      if (!stats.running) httpStatus = 503;

      // Kill switch
      const killStatus = killSwitch.status();
      payload.kill_switch = killStatus;
      if (killStatus.halted) {
        httpStatus = 503;
        payload.status = 'halted';
      }

      // Mode (prod live vs R&D paper)
      payload.mode = this.basePath === '/rd' ? 'rd' : 'prod';

      if (httpStatus === 200) payload.status = 'healthy';
      else if (payload.status === 'unknown') payload.status = 'unhealthy';
    } catch (err) {
      httpStatus = 500;
      payload.status = 'error';
      payload.error = err instanceof Error ? err.message : String(err);
    }

    res.writeHead(httpStatus, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://localhost:${this.config.port}`);
    // Strip basePath prefix so route matching is base-path-agnostic.
    // For R&D (BASE_PATH=/rd), nginx proxies `rd.sageadvisors.ai/rd/foo` to
    // `localhost:9200/rd/foo` — we strip the `/rd` so existing `path === '/foo'`
    // route checks work. Without this strip, the auth redirect to `/rd/login`
    // produces a 404 loop because the handler expects `path === '/login'`.
    let path = url.pathname;
    if (this.basePath && path.startsWith(this.basePath)) {
      path = path.slice(this.basePath.length) || '/';
    }

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // Public routes (no auth required)
      if (path === '/login' && req.method === 'GET') return this.serveLogin(res);
      if (path === '/login' && req.method === 'POST') return await this.handleLogin(req, res);
      if (path === '/logout') return this.handleLogout(req, res);
      // Health endpoint — unauth, used by Uptime Kuma and the operator runbooks.
      // Added R1 PR#2 (2026-04-10) per audit D5.1 (no health endpoint).
      if (path === '/health') return this.handleHealth(res);
      // Prometheus metrics exposition — unauth, scraped by Prometheus. R3b (2026-04-10).
      if (path === '/metrics') {
        res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
        res.end(metricsRegistry.render());
        return;
      }

      // Health endpoint — BEFORE auth check so external monitors can ping
      // it without credentials. Returns 200 when healthy, 503 when not.
      // Returns a simple JSON with status + staleness flag. UptimeRobot or
      // any HTTP monitor checks this every 60s and alerts on non-200.
      if (path === '/api/health') {
        const stats = this.engine.getStats();
        const healthy = stats.running && !stats.cycle_stale && !stats.kill_switch?.halted;
        const status = healthy ? 200 : 503;
        res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({
          status: healthy ? 'healthy' : 'unhealthy',
          running: stats.running,
          cycle_stale: stats.cycle_stale,
          ms_since_last_cycle: stats.ms_since_last_cycle,
          last_cycle_at: stats.last_cycle_at,
          cycles: stats.cycles,
          uptime_ms: stats.uptime_ms,
          ws_connected: stats.ws_connected,
          kill_switch_halted: stats.kill_switch?.halted ?? false,
          strategies: stats.strategies,
          markets_active: stats.markets_active,
          fast_crypto: stats.fast_crypto_stats,
        }));
        return;
      }

      // Auth check for everything below
      if (this.config.auth_enabled && !this.isAuthenticated(req)) {
        res.writeHead(302, { 'Location': this.basePath + '/login' });
        res.end();
        return;
      }

      // Health endpoint — unauthenticated so external monitors can ping it.
      // Returns a simple JSON with status + staleness flag. UptimeRobot or
      // any HTTP monitor checks this every 60s and alerts on non-200.
      if (path === '/api/health') {
        const stats = this.engine.getStats();
        const healthy = stats.running && !stats.cycle_stale && !stats.kill_switch?.halted;
        const status = healthy ? 200 : 503;
        res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({
          status: healthy ? 'healthy' : 'unhealthy',
          running: stats.running,
          cycle_stale: stats.cycle_stale,
          ms_since_last_cycle: stats.ms_since_last_cycle,
          last_cycle_at: stats.last_cycle_at,
          cycles: stats.cycles,
          uptime_ms: stats.uptime_ms,
          ws_connected: stats.ws_connected,
          kill_switch_halted: stats.kill_switch?.halted ?? false,
          strategies: stats.strategies,
          markets_active: stats.markets_active,
          fast_crypto: stats.fast_crypto_stats,
        }));
        return;
      }

      // API routes
      if (path === '/api/status')      return this.jsonResponse(res, this.engine.getStats());
      if (path === '/api/entities')    return this.jsonResponse(res, getEntityPnlView());
      if (path === '/api/markets')     return this.jsonResponse(res, { counts: getMarketCount(), active: getActiveMarkets().slice(0, 50) });
      if (path === '/api/strategies')  return this.jsonResponse(res, getStrategyPerformance());
      if (path === '/api/strategies/checkpoints') {
        const entityParam = url.searchParams.get('entity') || undefined;
        return this.jsonResponse(res, getStrategyCheckpoints(entityParam));
      }
      if (path === '/api/strategies/rolling') {
        const entityParam = url.searchParams.get('entity') ?? undefined;
        return this.jsonResponse(res, getStrategyRolling(entityParam));
      }
      if (path === '/api/rd-strategies') return this.jsonResponse(res, this.getRdStrategies());
      if (path === '/api/rd-strategies/checkpoints') return this.jsonResponse(res, this.getRdStrategyCheckpoints());
      // R3b endpoints (2026-04-10) — additive, dashboard structure preserved
      if (path === '/api/kill-switch' && req.method === 'GET') return this.jsonResponse(res, killSwitch.status());
      if (path === '/api/kill-switch' && req.method === 'POST') return await this.handleKillSwitchPost(req, res);
      if (path === '/api/portfolio-risk') {
        const tracker = this.engine.getPortfolioRiskTracker?.();
        return this.jsonResponse(res, tracker ? tracker.snapshot() : {});
      }
      if (path === '/api/regime') {
        const detector = this.engine.getRegimeDetector?.();
        return this.jsonResponse(res, detector?.getLastSnapshot() ?? null);
      }

      // Entity-specific routes
      const entityMatch = path.match(/^\/api\/([\w][\w-]*)\/([\w]+)$/);
      if (entityMatch) {
        const [, slug, resource] = entityMatch;
        switch (resource) {
          case 'positions': return this.jsonResponse(res, getOpenPositions(slug));
          // 2026-04-11 Phase 1.6: positions pre-joined with market end_date +
          // uma_resolution_status so the frontend can render triage states
          // (overdue / uma_pending / dispute) without a second fetch.
          case 'positions-with-markets': return this.jsonResponse(res, getOpenPositionsWithMarketMeta(slug));
          case 'trades':    return this.jsonResponse(res, getTradesByEntity(slug, 50));
          case 'orders':    return this.jsonResponse(res, getOrdersByEntity(slug, 50));
          case 'resolutions': return this.jsonResponse(res, getResolutionsByEntity(slug, 50));
          case 'snapshots': return this.jsonResponse(res, getSnapshots(slug, 168));
        }
      }

      // SSE endpoint
      if (path === '/events') return this.handleSSE(req, res);

      // Entity detail page
      const entityPageMatch = path.match(/^\/entity\/([\w][\w-]*)$/);
      if (entityPageMatch) return this.serveEntityPage(res, entityPageMatch[1]);

      // Dashboard
      if (path === '/' || path === '/index.html') return this.serveStatic(res);

      res.writeHead(404);
      res.end('Not Found');
    } catch (err) {
      log.error({ err, path }, 'Request handler error');
      res.writeHead(500);
      res.end('Internal Server Error');
    }
  }

  // ─── AUTH ───────────────────────────────────────────────────

  private serveLogin(res: ServerResponse, error?: string): void {
    const csrf = randomBytes(32).toString('hex');
    const html = this.getLoginHtml(csrf, error);
    // Store CSRF temporarily — will be validated on POST
    const tempId = `csrf_${csrf}`;
    this.sessions.set(tempId, { user: '', created: Date.now(), csrf });
    res.writeHead(200, {
      'Content-Type': 'text/html',
      'Set-Cookie': `csrf=${csrf}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`,
    });
    res.end(html);
  }

  private async handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    const params = new URLSearchParams(body);
    const username = params.get('username') ?? '';
    const password = params.get('password') ?? '';
    const csrfToken = params.get('csrf_token') ?? '';
    const ip = req.socket.remoteAddress ?? 'unknown';

    // CSRF check — validate against server-side session store
    const csrfSession = this.sessions.get(`csrf_${csrfToken}`);
    if (!csrfToken || !csrfSession) {
      return this.serveLogin(res, 'Session expired. Please try again.');
    }
    // Clean up used CSRF token
    this.sessions.delete(`csrf_${csrfToken}`);

    // Rate limiting
    const attempts = this.loginAttempts.get(ip) ?? { count: 0, lockedUntil: null };
    if (attempts.lockedUntil && Date.now() < attempts.lockedUntil) {
      return this.serveLogin(res, 'Too many attempts. Try again later.');
    }

    // Validate credentials
    if (username === this.config.auth_user && password === this.config.auth_password) {
      // Success — create signed token (survives restarts)
      const expires = Date.now() + SESSION_TTL_MS;
      const payload = `${username}:${expires}`;
      const signature = createHmac('sha256', SECRET).update(payload).digest('hex');
      const token = Buffer.from(`${payload}:${signature}`).toString('base64');
      this.loginAttempts.delete(ip);

      const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
      res.writeHead(302, {
        'Location': this.basePath + '/',
        'Set-Cookie': `${this.cookieName}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure}`,
      });
      res.end();
      log.info({ user: username, ip }, 'Login successful');
    } else {
      // Failed
      attempts.count += 1;
      if (attempts.count >= MAX_LOGIN_ATTEMPTS) {
        attempts.lockedUntil = Date.now() + LOCKOUT_DURATION_MS;
        log.warn({ ip, attempts: attempts.count }, 'Login lockout triggered');
      }
      this.loginAttempts.set(ip, attempts);
      log.warn({ ip, attempts: attempts.count }, 'Login failed');
      return this.serveLogin(res, 'Invalid credentials');
    }
  }

  private handleLogout(_req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(302, {
      'Location': this.basePath + '/login',
      'Set-Cookie': `${this.cookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
    });
    res.end();
  }

  private isAuthenticated(req: IncomingMessage): boolean {
    const token = this.getCookie(req, this.cookieName);
    if (!token) return false;

    try {
      const decoded = Buffer.from(token, 'base64').toString('utf-8');
      const parts = decoded.split(':');
      if (parts.length !== 3) return false;

      const [user, expiresStr, signature] = parts;
      const payload = `${user}:${expiresStr}`;
      const expected = createHmac('sha256', SECRET).update(payload).digest('hex');

      // Timing-safe comparison
      if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;

      // Check expiry
      const expires = parseInt(expiresStr, 10);
      if (isNaN(expires) || Date.now() > expires) return false;

      return true;
    } catch {
      return false;
    }
  }

  private getCookie(req: IncomingMessage, name: string): string | undefined {
    const header = req.headers.cookie ?? '';
    const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
    return match?.[1];
  }

  private async readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 10_000) { req.destroy(); reject(new Error('Body too large')); return; }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString()));
      req.on('error', reject);
    });
  }

  // ─── RESPONSES ───────��──────────────────────────────────────

  private jsonResponse(res: ServerResponse, data: unknown): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  /**
   * Read R&D engine's strategy performance view from its database (read-only).
   * Used by the prod dashboard to show R&D data alongside prod stats.
   * Returns empty array if R&D DB is unavailable (e.g., this engine IS the R&D engine).
   */
  private getRdStrategies(): unknown[] {
    const rdPath = process.env.RD_DATABASE_PATH ?? '/opt/polybot-v3-rd/data/rd.db';
    try {
      const db = new Database(rdPath, { readonly: true, fileMustExist: true });
      try {
        return db.prepare('SELECT * FROM v_strategy_performance').all();
      } finally {
        db.close();
      }
    } catch {
      return [];
    }
  }

  /**
   * 2026-04-20: cross-engine checkpoints fetch. Mirrors getRdStrategies() but
   * reads v_strategy_checkpoints. Dashboard uses this to render "since 04-18"
   * columns alongside cumulative scoreboard values so Dale can distinguish
   * recent performance from life-to-date.
   */
  private getRdStrategyCheckpoints(): unknown[] {
    const rdPath = process.env.RD_DATABASE_PATH ?? '/opt/polybot-v3-rd/data/rd.db';
    try {
      const db = new Database(rdPath, { readonly: true, fileMustExist: true });
      try {
        return db.prepare("SELECT * FROM v_strategy_checkpoints WHERE entity_slug='rd-engine'").all();
      } finally {
        db.close();
      }
    } catch {
      return [];
    }
  }

  private handleSSE(_req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    this.sseClients.add(res);
    res.on('close', () => this.sseClients.delete(res));
    this.sendSSE(res, 'connected', { timestamp: new Date().toISOString() });
  }

  private wireSSE(): void {
    const events = [
      'engine:cycle_complete', 'signal:generated', 'signal:approved', 'signal:rejected',
      'order:filled', 'position:opened', 'position:resolved', 'risk:lockout', 'risk:unlocked',
      'entity:mode_changed', 'entity:balance_updated', 'entity:strategies_changed',
      'advisor:check_complete',
    ] as const;
    for (const event of events) {
      eventBus.on(event, (payload) => { this.broadcastSSE(event, payload); });
    }
  }

  private broadcastSSE(event: string, data: unknown): void {
    for (const client of this.sseClients) { this.sendSSE(client, event, data); }
  }

  private sendSSE(res: ServerResponse, event: string, data: unknown): void {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private serveStatic(res: ServerResponse): void {
    try {
      const html = readFileSync(join(__dirname, 'static', 'index.html'), 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } catch {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body><h1>Gemini Capital</h1></body></html>');
    }
  }

  private serveEntityPage(res: ServerResponse, slug: string): void {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(this.getEntityPageHtml(slug));
  }

  private getEntityPageHtml(slug: string): string {
    return `<!DOCTYPE html>
<html><head><title>${slug} — Gemini Capital</title>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: linear-gradient(135deg, #0a0e17 0%, #111827 100%); color: #e2e8f0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
header { background: #0a0e17; border-bottom: 2px solid #f6ad55; padding: 16px 24px; display: flex; align-items: center; justify-content: space-between; position: sticky; top: 0; z-index: 1000; box-shadow: 0 4px 16px rgba(0,0,0,0.4); }
.header-left { display: flex; align-items: center; gap: 16px; }
.header-left h1 { color: #f6ad55; font-size: 1.5em; font-weight: 700; }
.header-left .subtitle { color: #718096; font-size: 0.8em; margin-top: 2px; }
a.back { color: #a0aec0; text-decoration: none; font-size: 0.85em; padding: 6px 12px; border-radius: 6px; border: 1px solid #2d3748; }
a.back:hover { background: #1a1f2e; color: #e2e8f0; }
.container { max-width: 1400px; margin: 0 auto; padding: 24px; }
.scoreboard { background: #1a1f2e; border: 2px solid #f6ad55; border-radius: 12px; padding: 14px 20px; margin-bottom: 24px; display: flex; justify-content: space-between; gap: 12px; flex-wrap: nowrap; overflow-x: auto; position: sticky; top: 72px; z-index: 999; box-shadow: 0 4px 16px rgba(0,0,0,0.4); }
.sb-item { display: flex; flex-direction: column; }
.sb-label { font-size: 10px; color: #718096; text-transform: uppercase; letter-spacing: 1.2px; margin-bottom: 6px; }
.sb-value { font-size: 22px; font-weight: 700; }
.green { color: #10b981; } .red { color: #ef4444; } .orange { color: #f6ad55; } .blue { color: #3b82f6; } .cyan { color: #06b6d4; } .neutral { color: #718096; }
.section { background: #1a1f2e; border: 1px solid #2d3748; border-radius: 12px; padding: 20px; margin-bottom: 20px; }
.section h2 { color: #f6ad55; font-size: 1.05em; margin-bottom: 14px; padding-bottom: 10px; border-bottom: 1px solid #2d3748; }
table { width: 100%; border-collapse: collapse; font-size: 0.82em; }
th { text-align: left; color: #718096; font-weight: 600; padding: 10px 8px; border-bottom: 1px solid #2d3748; text-transform: uppercase; font-size: 0.7em; letter-spacing: 0.05em; background: #0f1117; }
td { padding: 9px 8px; border-bottom: 1px solid rgba(45,55,72,0.5); }
tr:hover { background: rgba(15,17,23,0.6); }
.badge-sm { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 0.7em; font-weight: 600; }
.badge-live-sm { background: #166534; color: #86efac; }
.badge-paper-sm { background: #2563eb; color: #93c5fd; }
.two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 24px; }
@media (max-width: 900px) { .two-col { grid-template-columns: 1fr; } }
</style></head><body>
<header>
  <div class="header-left">
    <div>
      <h1 id="entityName">${slug}</h1>
      <div class="subtitle" id="entitySub">Loading...</div>
    </div>
  </div>
  <a href="/" class="back">&larr; Back to Dashboard</a>
</header>
<div class="container">
  <div class="scoreboard" id="scoreboard"></div>
  <div class="section">
    <h2>Open Positions <span class="count" id="posCount"></span></h2>
    <table><thead><tr><th>Market</th><th>Side</th><th>Size</th><th>Entry</th><th>Cost Basis</th><th>Est. Gain</th><th>Est. Resolution</th><th>Strategy</th></tr></thead>
    <tbody id="positionsBody"><tr><td colspan="8" style="color:#718096;text-align:center">Loading...</td></tr></tbody></table>
  </div>
  <div class="section">
    <h2>Strategy Performance</h2>
    <table><thead><tr><th>Strategy</th><th>Sub-Strategy</th><th>Trades</th><th>Open</th><th>Deployed</th><th>Upside</th><th>Resolved</th><th>W/L</th><th>Win Rate</th><th>P&L</th><th>Volume</th></tr></thead>
    <tbody id="strategiesBody"><tr><td colspan="11" style="color:#718096;text-align:center">Loading...</td></tr></tbody></table>
  </div>
  <div class="section">
    <h2>Strategy Rolling P&amp;L <span style="color:#718096;font-size:0.65em;font-weight:400;margin-left:10px">24h / 48h / 72h / all-time &mdash; per-trade P&amp;L is the decision metric</span></h2>
    <table><thead><tr><th>Strategy</th><th>Sub-Strategy</th><th>Window</th><th>n</th><th>Win Rate</th><th>Total P&amp;L</th><th>Per-Trade</th><th>Best</th><th>Worst</th></tr></thead>
    <tbody id="rollingBody"><tr><td colspan="9" style="color:#718096;text-align:center">Loading...</td></tr></tbody></table>
  </div>
  <div class="section">
    <h2>Live Events <span class="count" id="eventCount">(0)</span></h2>
    <div class="events-log" id="eventsLog" style="max-height:300px;overflow-y:auto;font-family:'SF Mono','Fira Code',monospace;font-size:12px;background:#0f1117;padding:12px;border-radius:8px;border:1px solid #2d3748;">
      <div class="event"><span style="color:#4a5568">--:--:--</span> Waiting for events...</div>
    </div>
  </div>
</div>
<script>
const SLUG = '${slug}';
const fmt = v => { const s = Math.abs(v).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); return v >= 0 ? '$'+s : '-$'+s; };
const cls = v => v > 0 ? 'green' : v < 0 ? 'red' : 'neutral';

let eventCounter = 0;
async function load() {
  const [entities, positions, strategies, rolling] = await Promise.all([
    fetch('/api/entities').then(r=>r.json()),
    fetch('/api/'+SLUG+'/positions').then(r=>r.json()).catch(()=>[]),
    fetch('/api/strategies').then(r=>r.json()).catch(()=>[]),
    fetch('/api/strategies/rolling?entity='+encodeURIComponent(SLUG)).then(r=>r.json()).catch(()=>[]),
  ]);

  const e = entities.find(x => x.slug === SLUG);
  if (!e) return;

  document.getElementById('entityName').textContent = e.name;
  const modeBadge = e.mode === 'live' ? 'LIVE' : 'R&D';
  document.getElementById('entitySub').textContent = modeBadge + ' | ' + e.status + ' | Port ' + (e.slug);

  const wr = (e.total_wins+e.total_losses) > 0 ? ((e.total_wins/(e.total_wins+e.total_losses))*100).toFixed(1)+'%' : '-';
  const cash = e.current_cash || 0;
  const deployed = e.open_positions_value || 0;
  const equity = cash + deployed;
  const upside = e.total_upside || 0;
  const pnlVsStart = equity - (e.starting_capital || 0);
  document.getElementById('scoreboard').innerHTML =
    '<div class="sb-item"><span class="sb-label">Equity</span><span class="sb-value '+cls(pnlVsStart)+'">'+fmt(equity)+'</span></div>'+
    '<div class="sb-item"><span class="sb-label">Cash</span><span class="sb-value">'+fmt(cash)+'</span></div>'+
    '<div class="sb-item"><span class="sb-label">Capital Deployed</span><span class="sb-value orange">'+fmt(deployed)+'</span></div>'+
    '<div class="sb-item"><span class="sb-label">P&L vs Start</span><span class="sb-value '+cls(pnlVsStart)+'">'+fmt(pnlVsStart)+'</span></div>'+
    '<div class="sb-item"><span class="sb-label">Total Upside</span><span class="sb-value green">'+fmt(upside)+'</span></div>'+
    '<div class="sb-item"><span class="sb-label">Win Rate</span><span class="sb-value '+(parseFloat(wr)>50?'green':parseFloat(wr)>30?'orange':'red')+'">'+wr+'</span></div>'+
    '<div class="sb-item"><span class="sb-label">W / L</span><span class="sb-value"><span class="green">'+e.total_wins+'</span> / <span class="red">'+e.total_losses+'</span></span></div>'+
    '<div class="sb-item"><span class="sb-label">Total Trades</span><span class="sb-value cyan">'+e.total_trades+'</span></div>'+
    '<div class="sb-item"><span class="sb-label">Open Positions</span><span class="sb-value orange">'+e.open_positions+'</span></div>';

  // Positions
  const pb = document.getElementById('positionsBody');
  document.getElementById('posCount').textContent = '('+positions.length+')';
  if (positions.length === 0) { pb.innerHTML = '<tr><td colspan="8" style="color:#718096;text-align:center">No open positions</td></tr>'; }
  else {
    function fmtResolve(endDate) {
      if (!endDate) return '<span style="color:#718096">Unknown</span>';
      var d = new Date(endDate);
      if (isNaN(d.getTime())) return '<span style="color:#718096">Unknown</span>';
      var now = Date.now();
      var diff = d.getTime() - now;
      if (diff < 0) {
        var hrsOver = Math.round(Math.abs(diff) / 3600000);
        if (hrsOver < 48) return '<span style="color:#f6ad55" title="Normal 24-48h oracle window">&#9203; Settling ('+hrsOver+'h)</span>';
        if (hrsOver < 168) return '<span style="color:#fb923c" title="Resolution delayed">&#9888; Slow ('+Math.round(hrsOver/24)+'d)</span>';
        return '<span style="color:#ef4444" title="Investigate">&#10060; Overdue ('+Math.round(hrsOver/24)+'d)</span>';
      }
      var hours = Math.floor(diff / 3600000);
      var days = Math.floor(hours / 24);
      if (days > 0) return '<span style="color:'+(days <= 2 ? '#f6ad55' : '#718096')+'">'+days+'d '+(hours % 24)+'h</span>';
      return '<span style="color:#10b981">'+hours+'h</span>';
    }
    pb.innerHTML = positions.map(p => {
      var gain = p.size - (p.cost_basis || 0);
      return '<tr><td>'+(p.market_question||p.condition_id||'').substring(0,55)+'</td><td>'+p.side+'</td><td>'+p.size.toFixed(2)+'</td><td>$'+(p.avg_entry_price||0).toFixed(3)+'</td><td>'+fmt(p.cost_basis||0)+'</td><td class="green">'+fmt(gain)+'</td><td>'+fmtResolve(p.market_end_date)+'</td><td><span style="background:#2d3748;padding:2px 6px;border-radius:4px;font-size:0.7em">'+(p.strategy_id||'-')+'</span></td></tr>';
    }).join('');
  }

  // Strategy Performance
  const sb = document.getElementById('strategiesBody');
  if (!strategies || strategies.length === 0) { sb.innerHTML = '<tr><td colspan="11" style="color:#718096;text-align:center">No strategy data yet</td></tr>'; }
  else {
    const sorted = strategies.slice().sort((a, b) => {
      const aKey = a.strategy_id + '|' + (a.sub_strategy_id || '');
      const bKey = b.strategy_id + '|' + (b.sub_strategy_id || '');
      return aKey.localeCompare(bKey);
    });
    sb.innerHTML = sorted.map(s => {
      const wrCls = s.total_resolutions > 0 ? (s.win_rate > 50 ? 'green' : s.win_rate > 30 ? 'orange' : 'red') : 'neutral';
      const wrText = s.total_resolutions > 0 ? s.win_rate.toFixed(1)+'%' : '-';
      const subLabel = s.sub_strategy_id ? '<span style="background:#1e293b;color:#94a3b8;padding:2px 6px;border-radius:4px;font-size:0.7em">'+s.sub_strategy_id+'</span>' : '<span style="color:#4a5568">—</span>';
      return '<tr><td><span style="background:#2d3748;padding:2px 6px;border-radius:4px;font-size:0.7em">'+s.strategy_id+'</span></td><td>'+subLabel+'</td><td>'+s.total_trades+'</td><td class="orange">'+(s.open_positions||0)+'</td><td>'+fmt(s.open_cost_basis||0)+'</td><td class="green">'+fmt(s.open_upside||0)+'</td><td>'+(s.total_resolutions||0)+'</td><td><span class="green">'+(s.wins||0)+'</span>/<span class="red">'+(s.losses||0)+'</span></td><td class="'+wrCls+'">'+wrText+'</td><td class="'+cls(s.total_pnl)+'">'+fmt(s.total_pnl||0)+'</td><td>'+fmt(s.total_volume||0)+'</td></tr>';
    }).join('');
  }

  // Strategy Rolling P&L (24h/48h/72h/all_time)
  const rb = document.getElementById('rollingBody');
  if (!rolling || rolling.length === 0) {
    rb.innerHTML = '<tr><td colspan="9" style="color:#718096;text-align:center">No rolling data yet</td></tr>';
  } else {
    const windowOrder = { '24h': 1, '48h': 2, '72h': 3, 'all_time': 4 };
    const sorted = rolling.slice().sort((a, b) => {
      const ak = a.strategy_id + '|' + (a.sub_strategy_id || '');
      const bk = b.strategy_id + '|' + (b.sub_strategy_id || '');
      if (ak !== bk) return ak.localeCompare(bk);
      return (windowOrder[a.window_label] || 9) - (windowOrder[b.window_label] || 9);
    });
    // Signal group boundaries with a subtle top border every 4 rows (one per strategy/sub).
    rb.innerHTML = sorted.map((r, i) => {
      const isFirstOfGroup = r.window_label === '24h';
      const rowStyle = isFirstOfGroup && i > 0 ? ' style="border-top:2px solid #2d3748"' : '';
      const perTradeCls = cls(r.avg_pnl_per_trade || 0);
      const pnlCls = cls(r.total_pnl || 0);
      const wrCls = r.n > 0 ? (r.win_rate > 60 ? 'green' : r.win_rate > 40 ? 'orange' : 'red') : 'neutral';
      const wrText = r.n > 0 ? r.win_rate.toFixed(1) + '%' : '-';
      const subLabel = r.sub_strategy_id ? '<span style="background:#1e293b;color:#94a3b8;padding:2px 6px;border-radius:4px;font-size:0.7em">'+r.sub_strategy_id+'</span>' : '<span style="color:#4a5568">—</span>';
      const stratLabel = isFirstOfGroup ? '<span style="background:#2d3748;padding:2px 6px;border-radius:4px;font-size:0.7em">'+r.strategy_id+'</span>' : '<span style="color:#4a5568;font-size:0.7em">\u00b7</span>';
      const subCell = isFirstOfGroup ? subLabel : '<span style="color:#4a5568;font-size:0.7em">\u00b7</span>';
      const windowBadge = '<span style="background:#0f1117;color:#94a3b8;padding:2px 6px;border-radius:4px;font-size:0.7em;font-weight:600">'+r.window_label+'</span>';
      return '<tr'+rowStyle+'><td>'+stratLabel+'</td><td>'+subCell+'</td><td>'+windowBadge+'</td><td>'+r.n+'</td><td class="'+wrCls+'">'+wrText+'</td><td class="'+pnlCls+'">'+fmt(r.total_pnl||0)+'</td><td class="'+perTradeCls+'"><strong>'+fmt(r.avg_pnl_per_trade||0)+'</strong></td><td class="green">'+fmt(r.best_trade||0)+'</td><td class="red">'+fmt(r.worst_trade||0)+'</td></tr>';
    }).join('');
  }
}

// SSE Live Events
function connectSSE() {
  const es = new EventSource('/events');
  const log = document.getElementById('eventsLog');
  es.onopen = () => { addEvent('SSE connected', '#10b981'); };
  es.addEventListener('engine:cycle_complete', (e) => {
    const d = JSON.parse(e.data);
    addEvent('Cycle '+d.cycle+': '+d.signals+' signals, '+d.orders+' orders ('+d.duration_ms+'ms)', '#06b6d4');
    load();
  });
  es.addEventListener('order:filled', (e) => {
    const d = JSON.parse(e.data);
    addEvent('FILL: '+d.fill.side+' '+d.fill.outcome+' @ '+d.fill.price.toFixed(2)+' ($'+d.fill.usdc_size.toFixed(2)+') ['+d.fill.entity_slug+']', d.fill.side==='BUY'?'#10b981':'#f6ad55');
  });
  es.addEventListener('position:resolved', (e) => {
    const d = JSON.parse(e.data);
    const r = d.resolution;
    addEvent('RESOLVED: '+(r.market_question||'').substring(0,40)+' → '+r.winning_outcome+' P&L: $'+r.realized_pnl.toFixed(2), r.realized_pnl>=0?'#10b981':'#ef4444');
    load();
  });
  es.addEventListener('signal:approved', (e) => {
    const d = JSON.parse(e.data);
    addEvent('SIGNAL: '+d.decision.signal.strategy_id+' → '+d.decision.signal.outcome+' edge='+d.decision.signal.edge.toFixed(3)+' size=$'+d.decision.final_size_usd.toFixed(2), '#3b82f6');
  });
  es.addEventListener('advisor:check_complete', (e) => {
    const d = JSON.parse(e.data);
    addEvent('ADVISOR: '+d.result.changes_made+' changes, strategies: ['+d.result.strategies_after.join(', ')+']', '#f6ad55');
  });
  es.onerror = () => { addEvent('SSE disconnected — reconnecting...', '#ef4444'); };
  function addEvent(text, color) {
    eventCounter++;
    document.getElementById('eventCount').textContent = '('+eventCounter+')';
    const ts = new Date().toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour12: false });
    log.innerHTML = '<div style="padding:4px 0;border-bottom:1px solid #1a1f2e"><span style="color:#4a5568">'+ts+'</span> <span style="color:'+color+'">'+text+'</span></div>' + log.innerHTML;
    while (log.children.length > 200) log.lastChild.remove();
  }
}

load();
setInterval(load, 60000);
connectSSE();
</script></body></html>`;
  }

  private getLoginHtml(csrf: string, error?: string): string {
    const errorHtml = error ? `<div class="error">${error}</div>` : '';
    return `<!DOCTYPE html>
<html><head><title>Gemini Capital Polymarket Trading Engine — Login</title>
<style>
body { background: #0a0e17; color: #e2e8f0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
.login-box { background: #1a1f2e; border: 1px solid #2d3748; border-radius: 12px; padding: 40px; width: 360px; }
.login-box h2 { color: #f6ad55; margin: 0 0 8px 0; font-size: 1.4em; }
.login-box .subtitle { color: #718096; font-size: 0.85em; margin-bottom: 24px; }
input { width: 100%; padding: 10px 12px; border: 1px solid #2d3748; border-radius: 6px; background: #0a0e17; color: #e2e8f0; font-size: 14px; margin-bottom: 12px; box-sizing: border-box; }
input:focus { border-color: #f6ad55; outline: none; }
button { width: 100%; padding: 10px; background: #f6ad55; color: #0a0e17; border: none; border-radius: 6px; font-weight: 600; cursor: pointer; font-size: 14px; }
button:hover { background: #ed8936; }
.error { color: #fc8181; font-size: 0.85em; margin-bottom: 12px; }
</style></head><body>
<div class="login-box">
<h2>Gemini Capital Polymarket Trading Engine</h2>
<div class="subtitle">Gemini Capital Trading Engine</div>
${errorHtml}
<form method="POST" action="${this.basePath}/login">
<input type="hidden" name="csrf_token" value="${csrf}">
<input type="text" name="username" placeholder="Email" required autofocus>
<input type="password" name="password" placeholder="Password" required>
<button type="submit">Sign In</button>
</form></div></body></html>`;
  }
}
