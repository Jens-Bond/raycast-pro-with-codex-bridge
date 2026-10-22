#!/usr/bin/env node
'use strict';

/**
 * Modded Raycast - Codex AI Bridge & Reverse Proxy
 * 
 * Supports:
 * 1. Raycast Native AI routing (POST /api/v1/ai/chat_completions)
 * 2. OpenAI-compatible custom provider endpoint (POST /v1/chat/completions)
 * 3. Transparent proxying for non-AI requests to backend.raycast.com
 * 4. Pre-warmed persistent Codex app-server for real-time token streaming
 */

const http = require('node:http');
const https = require('node:https');
const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 5001);
const RAYCAST_BACKEND = 'backend.raycast.com';
const MAX_BODY = 5_000_000;

function log(tag, ...args) {
  console.log(`[${new Date().toISOString()}] [${tag}]`, ...args);
}

// Auto-discover Codex binary
function findCodex() {
  if (process.env.CODEX_BIN && fs.existsSync(process.env.CODEX_BIN)) {
    return process.env.CODEX_BIN;
  }
  const candidates = [
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    path.join(process.env.HOME || '', '.cargo/bin/codex'),
    ...(process.env.PATH || '').split(path.delimiter).map(dir => path.join(dir, 'codex'))
  ].filter(Boolean);

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  try {
    const fromPath = execSync('which codex', { encoding: 'utf8' }).trim();
    if (fromPath && fs.existsSync(fromPath)) return fromPath;
  } catch (_) {}
  return 'codex';
}

const CODEX_BIN = findCodex();

/**
 * Persistent Codex App-Server Daemon Client
 * Keeps codex app-server --stdio warm in RAM for near-zero startup latency
 * and delivers real-time token deltas as they are generated.
 */
class CodexDaemonClient {
  constructor() {
    this.process = null;
    this.isInitialized = false;
    this.rpcId = 1;
    this.pendingCallbacks = new Map();
    this.activeTurns = new Map(); // threadId -> { onDelta, onDone, res }
    this.initPromise = null;
    this.buffer = '';
  }

  start() {
    if (this.initPromise) return this.initPromise;

    this.initPromise = new Promise((resolve, reject) => {
      log('DAEMON', `Launching background Codex app-server (${CODEX_BIN})...`);
      try {
        this.process = spawn(CODEX_BIN, ['app-server', '--stdio'], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            CODEX_HOME: process.env.CODEX_HOME || path.join(process.env.HOME || '', '.codex')
          }
        });
      } catch (err) {
        log('DAEMON', 'Failed to spawn app-server:', err.message);
        return reject(err);
      }

      this.process.stdout.on('data', chunk => this.handleStdout(chunk));

      this.process.stderr.on('data', data => {
        const str = data.toString('utf8');
        if (!str.includes('failed to connect to websocket') && !str.includes('Codex is ignoring')) {
          log('DAEMON_STDERR', str.trim());
        }
      });

      this.process.on('close', (code, signal) => {
        log('DAEMON', `App-server exited (code=${code}, signal=${signal})`);
        this.isInitialized = false;
        this.initPromise = null;
        this.process = null;
        for (const call of this.pendingCallbacks.values()) {
          call.reject(new Error('App-server terminated'));
        }
        this.pendingCallbacks.clear();
      });

      // Send JSON-RPC initialize
      this.sendRequest('initialize', {
        clientInfo: { name: 'raycast-pro-unlock', title: 'Modded Raycast Codex Bridge', version: '1.0.0' },
        capabilities: null
      })
      .then(() => {
        this.isInitialized = true;
        log('DAEMON', 'App-server initialized and warm in background.');
        resolve(this);
      })
      .catch(err => {
        log('DAEMON', 'App-server initialization failed:', err.message);
        reject(err);
      });
    });

    return this.initPromise;
  }

  sendRequest(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.process || this.process.killed) {
        return reject(new Error('App-server is not running'));
      }
      const id = ++this.rpcId;
      this.pendingCallbacks.set(id, { resolve, reject });
      this.process.stdin.write(JSON.stringify({ method, id, params }) + '\n', error => {
        if (error) {
          this.pendingCallbacks.delete(id);
          reject(error);
        }
      });
    });
  }

  handleStdout(chunk) {
    this.buffer += chunk.toString('utf8');
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop();

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        this.handleMessage(msg);
      } catch (_) {}
    }
  }

  handleMessage(msg) {
    // Request response (has id)
    if (msg.id && this.pendingCallbacks.has(msg.id)) {
      const cb = this.pendingCallbacks.get(msg.id);
      this.pendingCallbacks.delete(msg.id);
      if (msg.error) {
        cb.reject(new Error(msg.error.message || 'App-server RPC error'));
      } else {
        cb.resolve(msg.result || {});
      }
      return;
    }

    // Streaming server notifications
    const method = msg.method;
    const params = msg.params || {};

    // 1. Real-time token delta
    if (method === 'item/agentMessage/delta' && params.delta) {
      const active = this.activeTurns.get(params.threadId);
      if (active && active.onDelta) {
        active.onDelta(params.delta);
      }
    }

    // 2. Turn completed
    if (method === 'turn/completed' && params.threadId) {
      const active = this.activeTurns.get(params.threadId);
      if (active) {
        this.activeTurns.delete(params.threadId);
        if (active.onDone) active.onDone();
      }
    }
  }

  async runTurn(prompt, onDelta, onDone, res) {
    await this.start();

    const threadRes = await this.sendRequest('thread/start', {});
    const threadId = threadRes.threadId || threadRes.thread?.id;

    if (!threadId) {
      throw new Error('Could not acquire thread from app-server');
    }

    this.activeTurns.set(threadId, { onDelta, onDone, res });

    if (res) {
      res.once('close', () => {
        if (!res.writableEnded && this.activeTurns.has(threadId)) {
          this.activeTurns.delete(threadId);
          this.sendRequest('turn/interrupt', { threadId }).catch(() => {});
        }
      });
    }

    await this.sendRequest('turn/start', {
      threadId,
      input: [{ type: 'text', text: prompt }]
    });
  }
}

const daemon = new CodexDaemonClient();

// Pre-warm daemon on server boot
daemon.start().catch(err => {
  log('WARN', 'Initial daemon warm-up failed, will use fallback when requested:', err.message);
});

// One-shot CLI fallback
function runCliFallback(prompt, onDelta, onDone, res) {
  const child = spawn(CODEX_BIN, ['exec', '--skip-git-repo-check', '--json', '-'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: process.env.CODEX_HOME || path.join(process.env.HOME || '', '.codex') }
  });

  child.stdin.end(prompt);

  if (res) {
    res.once('close', () => {
      if (!res.writableEnded) child.kill('SIGTERM');
    });
  }

  let buffer = '';
  child.stdout.on('data', chunk => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text) {
          onDelta(event.item.text);
        }
      } catch (_) {}
    }
  });

  child.on('close', () => {
    if (buffer.trim()) {
      try {
        const event = JSON.parse(buffer);
        if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text) {
          onDelta(event.item.text);
        }
      } catch (_) {}
    }
    onDone();
  });
}

function promptFromMessages(messages, fallbackPrompt) {
  if (Array.isArray(messages)) {
    const parts = [];
    for (const msg of messages) {
      let content = '';
      if (typeof msg.content === 'string') content = msg.content;
      else if (msg.content && typeof msg.content.text === 'string') content = msg.content.text;
      else if (msg.content && typeof msg.content.command_instructions === 'string') content = msg.content.command_instructions;

      if (msg.role === 'system') parts.push(`System: ${content}`);
      else if (msg.role === 'user') parts.push(`User: ${content}`);
      else if (msg.role === 'assistant') parts.push(`Assistant: ${content}`);
    }
    return parts.join('\n\n');
  }
  return String(fallbackPrompt || 'Hello');
}

/**
 * Handle Raycast Native AI completions: POST /api/v1/ai/chat_completions
 * Protocol: Server-Sent Events with `data: {"text":"..."}\n\n` ending in `data: [DONE]\n\n`
 */
function handleNativeRaycastAi(req, res, payload) {
  const prompt = promptFromMessages(payload.messages, payload.prompt);
  log('AI_NATIVE', `Request received: prompt length = ${prompt.length} chars`);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  const onDelta = text => {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ text })}\n\n`);
    }
  };

  const onDone = () => {
    if (!res.writableEnded) {
      res.write('data: [DONE]\n\n');
      res.end();
      log('AI_NATIVE', 'Turn completed and delivered to Raycast.');
    }
  };

  daemon.runTurn(prompt, onDelta, onDone, res).catch(err => {
    log('AI_NATIVE_FALLBACK', `Daemon failed (${err.message}), using CLI fallback.`);
    runCliFallback(prompt, onDelta, onDone, res);
  });
}

/**
 * Handle OpenAI-compatible completions: POST /v1/chat/completions
 */
function handleOpenAiChat(req, res, payload) {
  const prompt = promptFromMessages(payload.messages, payload.prompt);
  const streaming = payload.stream === true;
  const model = payload.model || 'codex';
  log('AI_OPENAI', `Request received: stream=${streaming}, model=${model}`);

  if (streaming) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });

    const onDelta = text => {
      if (!res.writableEnded) {
        const chunk = { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
    };

    const onDone = () => {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
        res.end('data: [DONE]\n\n');
      }
    };

    daemon.runTurn(prompt, onDelta, onDone, res).catch(() => {
      runCliFallback(prompt, onDelta, onDone, res);
    });
  } else {
    let fullText = '';
    const onDelta = text => { fullText += text; };
    const onDone = () => {
      if (!res.writableEnded) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, message: { role: 'assistant', content: fullText }, finish_reason: 'stop' }]
        }));
      }
    };

    daemon.runTurn(prompt, onDelta, onDone, res).catch(() => {
      runCliFallback(prompt, onDelta, onDone, res);
    });
  }
}

/**
 * Forward non-AI traffic transparently to backend.raycast.com
 */
function forwardToRaycastBackend(req, res) {
  const options = {
    hostname: RAYCAST_BACKEND,
    port: 443,
    path: req.url,
    method: req.method,
    headers: {
      ...req.headers,
      host: RAYCAST_BACKEND
    }
  };

  const proxyReq = https.request(options, proxyRes => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on('error', err => {
    log('PROXY_ERR', `Forwarding failed: ${err.message}`);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Proxy gateway error', message: err.message }));
  });

  req.pipe(proxyReq, { end: true });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('Payload too large'));
        req.destroy();
      } else {
        body += chunk;
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host || HOST}`);
  const pathname = reqUrl.pathname;

  // Health endpoint
  if (req.method === 'GET' && pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      service: 'raycast-pro-unlock',
      codexBin: CODEX_BIN,
      daemonWarm: daemon.isInitialized
    }));
    return;
  }

  // 1. Raycast Native AI Completions
  if (req.method === 'POST' && pathname === '/api/v1/ai/chat_completions') {
    try {
      const payload = await readJsonBody(req);
      handleNativeRaycastAi(req, res, payload);
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 2. OpenAI Compatible Completions
  if (req.method === 'POST' && pathname === '/v1/chat/completions') {
    try {
      const payload = await readJsonBody(req);
      handleOpenAiChat(req, res, payload);
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 3. Fallback: Forward all other requests to backend.raycast.com
  forwardToRaycastBackend(req, res);
});

server.listen(PORT, HOST, () => {
  log('INIT', `Modded Raycast Bridge listening on http://${HOST}:${PORT}`);
  log('INIT', `Native AI completions: http://${HOST}:${PORT}/api/v1/ai/chat_completions`);
  log('INIT', `OpenAI custom provider: http://${HOST}:${PORT}/v1/chat/completions`);
  log('INIT', `Auto-detected Codex binary: ${CODEX_BIN}`);
});
