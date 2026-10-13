'use strict';
/**
 * Preloaded into the bot process of the smoke test (`node --require ...`). It does two things and nothing else:
 *
 * 1. Every TCP/TLS connection the process opens is written to the file named by SMOKE_NET_LOG, and a connection to
 *    anything but this machine is refused (so a bug that sends the token or the club password to a real host fails
 *    the test instead of leaving the computer).
 * 2. When the test starts the bot with an IPC channel (Windows: a console signal cannot be sent to a child, and
 *    `kill('SIGINT')` there terminates it without running any handler), the message 'SIGINT' / 'SIGTERM' emits that
 *    signal on `process`, which reaches exactly the handlers that src/runtime/shutdown.ts registered.
 */
const net = require('node:net');
const fs = require('node:fs');

const logFile = process.env.SMOKE_NET_LOG;
const THIS_MACHINE = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);

const record = (line) => {
  if (logFile) fs.appendFileSync(logFile, `${line}\n`);
};

const optionsOf = (args) => {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (first !== null && typeof first === 'object') return first;
  if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
    return { port: Number(first), host: typeof args[1] === 'string' ? args[1] : 'localhost' };
  }
  return { path: String(first) };
};

const originalConnect = net.Socket.prototype.connect;

net.Socket.prototype.connect = function guardedConnect(...args) {
  const options = optionsOf(args);
  const host = typeof options.path === 'string' ? `pipe:${options.path}` : String(options.host ?? 'localhost');
  const target = `${host}:${String(options.port ?? '')}`;
  if (!THIS_MACHINE.has(host)) {
    record(`BLOCKED ${target}`);
    throw new Error(`smoke test: a connection to ${target} was refused`);
  }
  record(`CONNECT ${target}`);
  return Reflect.apply(originalConnect, this, args);
};

if (process.env.SMOKE_SIGNAL_VIA_IPC === '1' && typeof process.send === 'function') {
  process.on('message', (message) => {
    if (message === 'SIGINT' || message === 'SIGTERM') process.emit(message);
  });
}
