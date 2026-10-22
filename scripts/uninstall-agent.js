#!/usr/bin/env node
'use strict';

/**
 * Uninstalls LaunchAgents for Raycast Codex Bridge
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const domain = `gui/${process.getuid()}`;
const agentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
const labels = ['com.user.raycast-codex-bridge', 'com.user.raycast-autopatch', 'com.axelreaeklund.raycast-codex-bridge'];

for (const label of labels) {
  spawnSync('/bin/launchctl', ['bootout', `${domain}/${label}`], { stdio: 'ignore' });
  const plistPath = path.join(agentsDir, `${label}.plist`);
  if (fs.existsSync(plistPath)) {
    fs.unlinkSync(plistPath);
    console.log(`Removed ${plistPath}`);
  }
}

console.log('✓ Successfully uninstalled Raycast Codex Bridge LaunchAgents.');
