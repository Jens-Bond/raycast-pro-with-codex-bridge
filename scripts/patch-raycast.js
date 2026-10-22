#!/usr/bin/env node
'use strict';

/**
 * Patch Raycast for Local Codex AI Routing & Paywall Bypass
 * 
 * 1. Bypasses client-side Pro / AI trial paywall gates in WebKit frontend.
 * 2. Spoofs local Pro / Better AI capabilities in the backend user store.
 * 3. Redirects native AI completion requests to the local Codex bridge (port 5001).
 */

const fs = require('fs');
const path = require('path');

const RAYCAST_APP = '/Applications/Raycast.app';
const RAYCAST_BUNDLE = path.join(RAYCAST_APP, 'Contents/Resources/macos-app_RaycastDesktopApp.bundle/Contents/Resources');
const BACKEND_INDEX = path.join(RAYCAST_BUNDLE, 'backend/index.mjs');
const FRONTEND_DIR = path.join(RAYCAST_BUNDLE, 'frontend');

function backupFile(filePath) {
  const origPath = filePath + '.orig';
  if (!fs.existsSync(origPath)) {
    fs.copyFileSync(filePath, origPath);
    console.log(`[BACKUP] Created ${origPath}`);
  }
}

function patchBackend() {
  if (!fs.existsSync(BACKEND_INDEX)) {
    console.error(`[ERROR] Backend bundle not found at ${BACKEND_INDEX}`);
    return false;
  }

  backupFile(BACKEND_INDEX);
  let content = fs.readFileSync(BACKEND_INDEX, 'utf8');
  let modified = false;

  // 1. Redirect AI chat completions to local bridge on port 5001
  const targetAiUrl = 'let d=`${i.apiUrl}/ai/chat_completions`';
  const patchedAiUrl = 'let d=`http://127.0.0.1:5001/api/v1/ai/chat_completions`';

  if (content.includes(targetAiUrl)) {
    content = content.replace(targetAiUrl, patchedAiUrl);
    modified = true;
    console.log('[PATCH] Redirected native AI completions endpoint to localhost:5001');
  } else if (content.includes(patchedAiUrl)) {
    console.log('[OK] Native AI completions endpoint already redirected');
  } else {
    console.warn('[WARN] Could not find AI completions URL target in index.mjs');
  }

  // 2. Wrap user capabilities in backend
  const targetUserCheck = 'function Ib(){return Ub.getCurrentUser()}function Lb(){return Ub.getStoredCurrentUserOrNull()}';
  const patchedUserCheck = 'function _wrapU(u){return u?{...u,has_pro_features:!0,has_better_ai:!0,can_use_ai:!0,is_pro:!0,subscription:{...(u.subscription||{}),plan:"pro",status:"active",active:!0,running:!0,trial_days_left:999}}:{id:"local",email:"user@local",name:"User",has_pro_features:!0,has_better_ai:!0,can_use_ai:!0,is_pro:!0,subscription:{plan:"pro",status:"active",active:!0,running:!0,trial_days_left:999}}}function Ib(){return Promise.resolve(Ub.getCurrentUser()).then(_wrapU)}function Lb(){return Promise.resolve(Ub.getStoredCurrentUserOrNull()).then(_wrapU)}';

  if (content.includes(targetUserCheck)) {
    content = content.replace(targetUserCheck, patchedUserCheck);
    modified = true;
    console.log('[PATCH] Injected Pro user spoofing into Ib() and Lb()');
  } else if (content.includes('_wrapU')) {
    console.log('[OK] User spoofing wrapper already present in index.mjs');
  } else {
    console.warn('[WARN] Could not find user methods target in index.mjs');
  }

  // 3. Ensure Wb.getUser calls Ib()
  const targetWb = 'signout:()=>Ub.signout(),getUser:()=>Ub.getCurrentUser()';
  const patchedWb = 'signout:()=>Ub.signout(),getUser:()=>Ib()';

  if (content.includes(targetWb)) {
    content = content.replace(targetWb, patchedWb);
    modified = true;
    console.log('[PATCH] Updated Wb.getUser to call Ib()');
  }

  if (modified) {
    fs.writeFileSync(BACKEND_INDEX, content, 'utf8');
    console.log('[SUCCESS] Successfully updated backend/index.mjs');
  }

  return true;
}

function patchFrontend() {
  if (!fs.existsSync(FRONTEND_DIR)) {
    console.error(`[ERROR] Frontend directory not found at ${FRONTEND_DIR}`);
    return false;
  }

  // Locate ai-access-*.js regardless of Vite build hash
  const files = fs.readdirSync(FRONTEND_DIR);
  const aiAccessFile = files.find(f => f.startsWith('ai-access-') && f.endsWith('.js'));

  if (!aiAccessFile) {
    console.warn('[WARN] Could not find ai-access-*.js in frontend directory');
    return false;
  }

  const aiAccessPath = path.join(FRONTEND_DIR, aiAccessFile);
  backupFile(aiAccessPath);

  let content = fs.readFileSync(aiAccessPath, 'utf8');
  const targetCheck = 'function i(e){return e?.has_pro_features===!0||e?.has_better_ai===!0}';
  const patchedCheck = 'function i(e){return!0}';

  if (content.includes(targetCheck)) {
    content = content.replace(targetCheck, patchedCheck);
    fs.writeFileSync(aiAccessPath, content, 'utf8');
    console.log(`[PATCH] Bypassed AI paywall gate in ${aiAccessFile}`);
  } else if (content.includes(patchedCheck)) {
    console.log(`[OK] AI gate check already bypassed in ${aiAccessFile}`);
  } else {
    console.warn(`[WARN] Target entitlement pattern not found in ${aiAccessFile}`);
  }

  return true;
}

console.log('=== Patching Raycast for Codex AI Routing ===');
patchBackend();
patchFrontend();
console.log('=== Done! Restart Raycast (Cmd + Q, then reopen) to apply changes. ===');
