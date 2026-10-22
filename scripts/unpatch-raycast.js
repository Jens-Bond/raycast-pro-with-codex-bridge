#!/usr/bin/env node
'use strict';

/**
 * Unpatch Raycast: Restores original stock files from .orig backups
 */

const fs = require('fs');
const path = require('path');

const RAYCAST_APP = '/Applications/Raycast.app';
const RAYCAST_BUNDLE = path.join(RAYCAST_APP, 'Contents/Resources/macos-app_RaycastDesktopApp.bundle/Contents/Resources');
const BACKEND_INDEX = path.join(RAYCAST_BUNDLE, 'backend/index.mjs');
const FRONTEND_DIR = path.join(RAYCAST_BUNDLE, 'frontend');

function restoreFile(filePath) {
  const origPath = filePath + '.orig';
  if (fs.existsSync(origPath)) {
    fs.copyFileSync(origPath, filePath);
    fs.unlinkSync(origPath);
    console.log(`[RESTORED] Restored ${filePath} and removed backup.`);
    return true;
  }
  return false;
}

console.log('=== Restoring Stock Raycast Files ===');

// Restore backend
if (fs.existsSync(BACKEND_INDEX)) {
  const restored = restoreFile(BACKEND_INDEX);
  if (!restored) console.log('[SKIP] No backend backup found to restore.');
}

// Restore frontend
if (fs.existsSync(FRONTEND_DIR)) {
  const files = fs.readdirSync(FRONTEND_DIR);
  const origFiles = files.filter(f => f.startsWith('ai-access-') && f.endsWith('.js.orig'));
  if (origFiles.length > 0) {
    for (const orig of origFiles) {
      const originalPath = path.join(FRONTEND_DIR, orig.replace('.orig', ''));
      restoreFile(originalPath);
    }
  } else {
    console.log('[SKIP] No frontend backup found to restore.');
  }
}

console.log('=== Done! Restart Raycast to apply stock state. ===');
