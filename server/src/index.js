'use strict';

require('dotenv').config();

const db  = require('./db');
const app = require('./app');

const PORT                     = parseInt(process.env.SERVER_PORT)             || 3000;
const CLEANUP_INTERVAL_MINUTES = parseInt(process.env.CLEANUP_INTERVAL_MINUTES) || 5;
const WEBHOOK_MAX_AGE_MINUTES  = parseInt(process.env.WEBHOOK_MAX_AGE_MINUTES)  || 60;
const POLL_BATCH_SIZE          = parseInt(process.env.POLL_BATCH_SIZE)          || 10;

// ── Cleanup job ───────────────────────────────────────────────────────────────

setInterval(() => {
  const cutoff = `-${WEBHOOK_MAX_AGE_MINUTES} minutes`;

  // Delete delivery records for expired webhooks first
  db.prepare(`
    DELETE FROM webhook_deliveries
    WHERE webhook_id IN (
      SELECT id FROM webhooks WHERE datetime(received_at) < datetime('now', ?)
    )
  `).run(cutoff);

  const result = db.prepare(`
    DELETE FROM webhooks
    WHERE datetime(received_at) < datetime('now', ?)
  `).run(cutoff);

  if (result.changes > 0) {
    console.log(`[cleanup] Removed ${result.changes} expired webhook(s)`);
  }
}, CLEANUP_INTERVAL_MINUTES * 60 * 1000);

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Webhook server on port ${PORT}`);
  console.log(`  cleanup every ${CLEANUP_INTERVAL_MINUTES} min | max age ${WEBHOOK_MAX_AGE_MINUTES} min | batch ${POLL_BATCH_SIZE}`);
});
