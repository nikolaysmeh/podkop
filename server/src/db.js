'use strict';

const fs       = require('fs');
const path     = require('path');
const Database = require('better-sqlite3');

const dbPath = process.env.DB_PATH || '/data/webhooks.db';
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS endpoints (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT UNIQUE NOT NULL,
    secret_key    TEXT UNIQUE NOT NULL,
    username      TEXT,
    password_hash TEXT,
    created_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS webhooks (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint_name TEXT NOT NULL,
    method        TEXT NOT NULL,
    payload       TEXT NOT NULL,
    headers       TEXT,
    received_at   TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (endpoint_name) REFERENCES endpoints(name)
  );

  CREATE TABLE IF NOT EXISTS webhook_deliveries (
    webhook_id  INTEGER NOT NULL,
    client_id   TEXT    NOT NULL,
    delivered_at TEXT   DEFAULT (datetime('now')),
    PRIMARY KEY (webhook_id, client_id)
  );
`);

// Migration: drop plaintext password column (security fix)
try {
  db.exec('ALTER TABLE endpoints DROP COLUMN password');
} catch {
  // column already dropped or never existed — ignore
}

// Migration: add password_hash column if missing (older installs)
try {
  db.exec('ALTER TABLE endpoints ADD COLUMN password_hash TEXT');
} catch {
  // column already exists — ignore
}

module.exports = db;
