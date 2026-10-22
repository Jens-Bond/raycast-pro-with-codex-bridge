#!/usr/bin/env node
'use strict';

const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');

const projectDir = path.resolve(__dirname, '..');
const serverFile = path.join(projectDir, 'src', 'server.js');
const pollMs = Number(process.env.POLL_INTERVAL_MS || 2000);
let bridge = null;
let stopping = false;

function raycastIsRunning() {
  // pgrep checks the process name and does not require Accessibility permissions.
  const result = spawnSync('/usr/bin/pgrep', ['-x', 'Raycast'], { stdio: 'ignore' });
  return result.status === 0;
}

function startBridge() {
  if (bridge) return;
  console.log(`[supervisor] Raycast detected; starting bridge from ${projectDir}`);
  bridge = spawn(process.execPath, [serverFile], {
    cwd: projectDir,
    stdio: 'inherit',
    env: process.env
  });
  bridge.on('error', error => console.error(`[supervisor] Could not start bridge: ${error.message}`));
  bridge.on('exit', (code, signal) => {
    console.log(`[supervisor] Bridge exited (code=${code}, signal=${signal})`);
    bridge = null;
  });
}

function stopBridge() {
  if (!bridge) return;
  console.log('[supervisor] Raycast closed; stopping bridge');
  bridge.kill('SIGTERM');
  const child = bridge;
  setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 5000).unref();
}

const timer = setInterval(() => {
  if (stopping) return;
  if (raycastIsRunning()) startBridge();
  else stopBridge();
}, pollMs);

function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  if (bridge) bridge.kill('SIGTERM');
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
console.log(`[supervisor] Watching for Raycast (poll every ${pollMs} ms)`);
if (raycastIsRunning()) startBridge();
