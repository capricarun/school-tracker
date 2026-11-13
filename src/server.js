// Entry point: open the database, set up push, start HTTP and the reminder scheduler.
process.env.TZ = process.env.TZ || 'Asia/Kolkata';

const { config } = await import('./config.js');
const { openDb } = await import('./db.js');
const { initPush } = await import('./push.js');
const { createApp } = await import('./app.js');
const { startScheduler } = await import('./scheduler.js');

const db = await openDb();
await initPush(db);
const app = createApp(db);
const server = app.listen(config.port, () => {
  console.log(`School Tracker on :${config.port} (TZ ${process.env.TZ}, AI ${config.anthropicKey ? config.claudeModel : 'off — rule parser'}, DB ${db.kind})`);
});
const timer = startScheduler(db);

function shutdown(sig) {
  console.log(`${sig} received, shutting down`);
  clearInterval(timer);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
