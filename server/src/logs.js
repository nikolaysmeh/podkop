'use strict';

const MAX_LINES = 500;
const logBuffer = [];

function addLog(level, message) {
  logBuffer.push({ ts: new Date().toISOString(), level, message });
  if (logBuffer.length > MAX_LINES) logBuffer.shift();
}

function getLogs(n) {
  const count = Math.min(n > 0 ? n : 200, MAX_LINES);
  return logBuffer.slice(-count);
}

function setupLogCapture() {
  const orig = {
    log:   console.log.bind(console),
    error: console.error.bind(console),
    warn:  console.warn.bind(console),
  };
  console.log   = (...args) => { orig.log(...args);   addLog('info',  args.join(' ')); };
  console.error = (...args) => { orig.error(...args); addLog('error', args.join(' ')); };
  console.warn  = (...args) => { orig.warn(...args);  addLog('warn',  args.join(' ')); };
}

module.exports = { setupLogCapture, getLogs };
