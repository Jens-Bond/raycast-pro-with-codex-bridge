#!/usr/bin/env node
'use strict';

/**
 * Installs LaunchAgents for macOS:
 * 1. com.user.raycast-codex-bridge: Starts the Codex proxy automatically whenever Raycast opens.
 * 2. com.user.raycast-autopatch: Watches Raycast bundle and re-applies patches automatically on updates.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (process.platform !== 'darwin') {
  console.error('LaunchAgents are supported only on macOS.');
  process.exit(1);
}

const repo = path.resolve(__dirname, '..');
const supervisorScript = path.join(repo, 'scripts', 'raycast-supervisor.js');
const patcherScript = path.join(repo, 'scripts', 'patch-raycast.js');
const raycastBackend = '/Applications/Raycast.app/Contents/Resources/macos-app_RaycastDesktopApp.bundle/Contents/Resources/backend/index.mjs';

const agentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
const logsDir = path.join(os.homedir(), 'Library', 'Logs', 'raycast-codex-bridge');

const xml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const domain = `gui/${process.getuid()}`;

fs.mkdirSync(agentsDir, { recursive: true });
fs.mkdirSync(logsDir, { recursive: true });

// 1. Supervisor Agent (Runs bridge when Raycast opens)
const bridgeLabel = 'com.user.raycast-codex-bridge';
const bridgePlistPath = path.join(agentsDir, `${bridgeLabel}.plist`);
const bridgePlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${bridgeLabel}</string>
  <key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(supervisorScript)}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>WorkingDirectory</key><string>${xml(repo)}</string>
  <key>StandardOutPath</key><string>${xml(path.join(logsDir, 'supervisor.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(logsDir, 'supervisor-error.log'))}</string>
</dict></plist>
`;
fs.writeFileSync(bridgePlistPath, bridgePlist, { mode: 0o644 });

// 2. Auto-patch Agent (Re-patches Raycast when app updates)
const patchLabel = 'com.user.raycast-autopatch';
const patchPlistPath = path.join(agentsDir, `${patchLabel}.plist`);
const patchPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${patchLabel}</string>
  <key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(patcherScript)}</string></array>
  <key>WatchPaths</key><array><string>${xml(raycastBackend)}</string></array>
  <key>WorkingDirectory</key><string>${xml(repo)}</string>
  <key>StandardOutPath</key><string>${xml(path.join(logsDir, 'autopatch.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(logsDir, 'autopatch-error.log'))}</string>
</dict></plist>
`;
fs.writeFileSync(patchPlistPath, patchPlist, { mode: 0o644 });

// Load services
for (const label of [bridgeLabel, patchLabel]) {
  spawnSync('/bin/launchctl', ['bootout', `${domain}/${label}`], { stdio: 'ignore' });
}

spawnSync('/bin/launchctl', ['bootstrap', domain, bridgePlistPath], { stdio: 'inherit' });
spawnSync('/bin/launchctl', ['bootstrap', domain, patchPlistPath], { stdio: 'inherit' });

console.log('✓ Installed LaunchAgents:');
console.log('  1. Bridge Supervisor: starts/stops proxy with Raycast.');
console.log('  2. Auto-Patcher: auto-applies patches whenever Raycast updates.');
console.log(`Logs available at: ${logsDir}`);
