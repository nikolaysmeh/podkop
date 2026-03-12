'use strict';

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const { getLogs } = require('./logs');

// ── Load HTML templates ────────────────────────────────────────────────────────

const ADMIN_HTML = fs.readFileSync(path.join(__dirname, 'views', 'admin.html'), 'utf8');
const LOGIN_HTML = fs.readFileSync(path.join(__dirname, 'views', 'login.html'), 'utf8');
const ADMIN_CSS  = fs.readFileSync(path.join(__dirname, 'views', 'admin.css'), 'utf8');

// ── Session store ─────────────────────────────────────────────────────────────

const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
const sessions = new Map(); // token → expiry timestamp

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}

function destroySession(token) {
  sessions.delete(token);
}

function validateSession(token) {
  if (!token) return false;
  const expiry = sessions.get(token);
  if (!expiry) return false;
  if (Date.now() > expiry) { sessions.delete(token); return false; }
  return true;
}

function getSessionToken(req) {
  const cookie = req.headers.cookie || '';
  const part = cookie.split(';').find(c => c.trim().startsWith('admin_session='));
  return part ? decodeURIComponent(part.trim().slice('admin_session='.length)) : null;
}

function isAuthenticated(req) {
  return validateSession(getSessionToken(req));
}

// ── Config snapshot ───────────────────────────────────────────────────────────

function getCurrentConfig() {
  return {
    SERVER_PORT:                process.env.SERVER_PORT                || '3000',
    DB_PATH:                    process.env.DB_PATH                    || '/data/webhooks.db',
    SERVER_DEBUG:               process.env.SERVER_DEBUG               || 'false',
    CLEANUP_INTERVAL_MINUTES:   process.env.CLEANUP_INTERVAL_MINUTES   || '5',
    WEBHOOK_MAX_AGE_MINUTES:    process.env.WEBHOOK_MAX_AGE_MINUTES    || '60',
    BATCH_SIZE:                 process.env.BATCH_SIZE                 || '10',
    WEBHOOK_BODY_LIMIT:         process.env.WEBHOOK_BODY_LIMIT         || '2mb',
    WEBHOOK_RATE_LIMIT_RPM:     process.env.WEBHOOK_RATE_LIMIT_RPM     || '60',
    MULTI_CLIENT_ENABLED:       process.env.MULTI_CLIENT_ENABLED       || 'false',
    MAX_DELIVERIES_PER_WEBHOOK: process.env.MAX_DELIVERIES_PER_WEBHOOK || '1',
    WEBHOOK_ALLOWED_HOSTS:      process.env.WEBHOOK_ALLOWED_HOSTS      || '',
  };
}

// ── Route setup ───────────────────────────────────────────────────────────────

function setupAdminRoutes(app, adminSecret) {
  // Shared stylesheet for login and admin pages
  app.get('/admin/styles.css', (_req, res) => {
    res.type('text/css').send(ADMIN_CSS);
  });

  // Login page
  app.get('/admin/login', (req, res) => {
    if (isAuthenticated(req)) return res.redirect('/admin/');
    res.send(LOGIN_HTML.replace('{{ERROR}}', ''));
  });

  // Process login
  app.post('/admin/login', (req, res) => {
    const { password } = req.body || {};
    if (adminSecret && password === adminSecret) {
      const token = createSession();
      const maxAge = SESSION_TTL_MS / 1000;
      res.setHeader('Set-Cookie',
        `admin_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`);
      return res.redirect('/admin/');
    }
    const errHtml = `<div class="err">${esc(password ? 'Invalid password' : 'Password is required')}</div>`;
    res.send(LOGIN_HTML.replace('{{ERROR}}', errHtml));
  });

  // Logout
  app.post('/admin/logout', (req, res) => {
    const token = getSessionToken(req);
    if (token) destroySession(token);
    res.setHeader('Set-Cookie', 'admin_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    res.redirect('/admin/login');
  });

  // Main admin panel
  app.get(['/admin', '/admin/'], (req, res) => {
    if (!isAuthenticated(req)) return res.redirect('/admin/login');
    res.send(ADMIN_HTML);
  });

  // API: current configuration
  app.get('/api/admin/config', (req, res) => {
    const hasSecret = adminSecret && req.headers['x-admin-secret'] === adminSecret;
    if (!hasSecret && !isAuthenticated(req)) return res.status(403).json({ error: 'Forbidden' });
    res.json({ config: getCurrentConfig() });
  });

  // API: recent logs
  app.get('/api/admin/logs', (req, res) => {
    const hasSecret = adminSecret && req.headers['x-admin-secret'] === adminSecret;
    if (!hasSecret && !isAuthenticated(req)) return res.status(403).json({ error: 'Forbidden' });
    const n = parseInt(req.query.n) || 200;
    res.json({ logs: getLogs(n) });
  });
}

// ── Tiny server-side escape ───────────────────────────────────────────────────

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = { isAuthenticated, setupAdminRoutes };
