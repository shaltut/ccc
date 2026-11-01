import { serve } from '@hono/node-server';
import { loadConfig } from './config.ts';
import { createSql, migrate } from './db.ts';
import { createApp } from './app.ts';
import { startWatchdog } from './watchdog.ts';

const config = loadConfig(process.env);
const sql = createSql(config.databaseUrl);
const applied = await migrate(sql);
if (applied.length) console.log(`[ccc] applied migrations: ${applied.join(', ')}`);

const app = createApp(sql, config);
const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`[ccc] listening on :${info.port} (public URL ${config.publicUrl})`);
});
const stopWatchdog = startWatchdog(sql);

const shutdown = () => {
  stopWatchdog();
  server.close(() => void sql.end({ timeout: 5 }).then(() => process.exit(0)));
  // Long-polls hold connections open; don't wait on them forever.
  setTimeout(() => process.exit(0), 10_000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
