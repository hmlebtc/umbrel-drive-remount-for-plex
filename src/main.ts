/**
 * Entry point. Wires settings + event log + host adapter (real or mock) +
 * restore runner + background monitor + HTTP server, starts the monitor, and
 * shuts down cleanly on SIGTERM/SIGINT (docker stop sends SIGTERM).
 */

import { EventLog } from './events.js';
import { createRealAdapter, type HostAdapter } from './hostAdapter.js';
import { log, logError } from './log.js';
import { createMockAdapter, type MockScenario } from './mockAdapter.js';
import { Monitor } from './monitor.js';
import { createRestoreRunner } from './restore.js';
import { loadSettings, SettingsStore } from './settings.js';
import { createApiServer, type AppContext } from './server.js';
import { APP_NAME, APP_VERSION, GIT_SHA } from './version.js';

function main(): void {
  const dataDir = process.env.DRP_DATA_DIR || './data';
  const port = Number(process.env.DRP_HTTP_PORT || '3012');
  const mock = process.env.MOCK === '1';

  const settings = new SettingsStore(dataDir, loadSettings(dataDir));
  const events = new EventLog(dataDir);

  const adapter: HostAdapter = mock
    ? createMockAdapter((process.env.MOCK_SCENARIO as MockScenario) || 'healthy')
    : createRealAdapter();

  const restore = createRestoreRunner(adapter, () => settings.get(), events, dataDir);
  const monitor = new Monitor({ adapter, getSettings: () => settings.get(), restore, events });

  const ctx: AppContext = {
    adapter,
    settings,
    restore,
    mock,
    startedAt: new Date().toISOString(),
    version: APP_VERSION,
    gitSha: GIT_SHA,
    monitor,
    events,
  };

  const server = createApiServer(ctx);

  // Never let a stray rejection/exception kill the process — log and carry on.
  process.on('unhandledRejection', (reason) => {
    logError(`unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
  });
  process.on('uncaughtException', (err) => {
    logError(`uncaught exception: ${err instanceof Error ? err.message : String(err)}`);
  });

  server.listen(port, '0.0.0.0', () => {
    log(`${APP_NAME} v${APP_VERSION} (${GIT_SHA}) listening on 0.0.0.0:${port}`);
    log(`data dir: ${dataDir}${mock ? ' (MOCK mode)' : ''}`);
    monitor.start();
    events.info('system', `${APP_NAME} started`);
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`received ${signal}, shutting down`);
    monitor.stop();
    server.close(() => {
      log('server closed, exiting');
      process.exit(0);
    });
    const t = setTimeout(() => process.exit(0), 5000);
    if (typeof t.unref === 'function') t.unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
