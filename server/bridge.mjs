#!/usr/bin/env node
// Inkfold ↔ T3 bridge.
//
// A tiny HTTP service that lets the Inkfold web app ask questions about
// selections in a notebook. Each question (text + clip images) is sent to one
// fixed T3 Code thread with `t3 thread send`, so the conversation continues in
// that thread, and the agent's reply is handed back to the app.
//
// Security model (the app itself is public; this service is not):
//  - It listens on a Unix socket in a 0700 directory, so other accounts on this
//    machine can't connect. Tailscale Serve (root) proxies the tailnet to it.
//  - Every request must carry a Tailscale-User-Login header from the
//    allowlist. Tailscale Serve sets this header from the caller's identity.
//  - Browsers may only call it from the configured origins (CORS).
//
// Configuration: ~/.config/inkfold-bridge/config.json (see server/README.md).
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const HOME = os.homedir();
const CONFIG_PATH = process.env.INKFOLD_BRIDGE_CONFIG || path.join(HOME, '.config/inkfold-bridge/config.json');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

const THREAD_ID = config.threadId;
if (!THREAD_ID) throw new Error('config.threadId is required');
const ALLOWED_LOGINS = new Set(config.allowedLogins || []);
const ALLOWED_ORIGINS = new Set(config.allowedOrigins || []);
const STATE_DIR = config.stateDir || path.join(HOME, '.local/state/inkfold-bridge');
const CLIP_DIR = config.clipDir || path.join(HOME, '.local/share/inkfold-bridge/clips');
const SOCKET = config.socket || path.join(STATE_DIR, 'bridge.sock');
const ASKS_FILE = path.join(STATE_DIR, 'asks.json');
/** Only for local tests: listen on 127.0.0.1:<port> and skip the identity check. */
const TEST_PORT = config.testPort || null;

const MAX_BODY = 25 * 1024 * 1024;
const MAX_CLIPS = 8;
const MAX_QUESTION = 6000;
const SHOW_MESSAGES = 40;

fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
fs.chmodSync(STATE_DIR, 0o700);
fs.mkdirSync(CLIP_DIR, { recursive: true, mode: 0o700 });

const log = (...a) => console.log(new Date().toISOString(), ...a);

/* ------------------------------------------------------------------ */
/* t3 CLI                                                              */
/* ------------------------------------------------------------------ */

function semverCmp(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

/** The newest installed t3 binary (the CLI version should match the running server). */
function t3Bin() {
  if (config.t3Bin) return config.t3Bin;
  const dir = path.join(HOME, '.t3/runtime/versions');
  const versions = fs.readdirSync(dir).filter((v) => /^\d+\.\d+\.\d+$/.test(v) && fs.existsSync(path.join(dir, v, 't3')));
  versions.sort(semverCmp);
  if (!versions.length) throw new Error('no t3 runtime found');
  return path.join(dir, versions[versions.length - 1], 't3');
}

function runT3(args, { input, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const bin = t3Bin();
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(e) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    if (input != null) child.stdin.end(input);
    else child.stdin.end();
  });
}

function parseJson(s) {
  try {
    return JSON.parse(s.trim());
  } catch {
    // tolerate log lines before the JSON
    const i = s.indexOf('{');
    try {
      return i >= 0 ? JSON.parse(s.slice(i)) : null;
    } catch {
      return null;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Thread snapshot (cached: one `t3 thread show` costs a few seconds)  */
/* ------------------------------------------------------------------ */

let snapshot = null; // { at, thread, messages }
let snapshotPromise = null;

function refreshSnapshot(maxAgeMs = 8000) {
  if (snapshot && Date.now() - snapshot.at < maxAgeMs) return Promise.resolve(snapshot);
  if (snapshotPromise) {
    if (maxAgeMs === 0) snapshotPromise.then(() => refreshSnapshot(0));
    return snapshotPromise;
  }
  snapshotPromise = runT3(['thread', 'show', THREAD_ID, '--json', '--messages', String(SHOW_MESSAGES)], { timeoutMs: 60_000 })
    .then((r) => {
      const d = parseJson(r.stdout);
      if (r.code !== 0 || !d?.thread) {
        log('thread show failed', r.code, r.stderr.slice(0, 400));
        return snapshot;
      }
      snapshot = { at: Date.now(), thread: d.thread, messages: d.messages || [] };
      applySnapshot(snapshot);
      return snapshot;
    })
    .finally(() => (snapshotPromise = null));
  return snapshotPromise;
}

function threadInfo() {
  const t = snapshot?.thread;
  if (!t) return { id: THREAD_ID };
  return { id: t.threadId, title: t.title, status: t.status, link: t.link, busy: !!t.activeRunId };
}

/* ------------------------------------------------------------------ */
/* Asks                                                                */
/* ------------------------------------------------------------------ */

/** @type {Map<string, any>} */
const asks = new Map();
const waiters = new Map(); // askId -> child process promise (send --wait)
let lastClientPoll = 0;

try {
  for (const a of JSON.parse(fs.readFileSync(ASKS_FILE, 'utf8'))) asks.set(a.askId, a);
} catch {
  /* first run */
}

let saveTimer = null;
function saveAsks() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    const list = [...asks.values()].sort((a, b) => a.createdAt - b.createdAt).slice(-500);
    const tmp = ASKS_FILE + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(list), { mode: 0o600 });
    await fsp.rename(tmp, ASKS_FILE);
  }, 300);
}

const PENDING = new Set(['sending', 'queued', 'running', 'recovering']);
const marker = (askId) => `inkfold:${askId}`;

function publicAsk(a) {
  return {
    askId: a.askId,
    status: a.status,
    progress: a.progress || [],
    answer: a.answer ?? null,
    error: a.error ?? null,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

function update(a, patch) {
  Object.assign(a, patch, { updatedAt: Date.now() });
  saveAsks();
}

/** Uses the latest thread messages to fill in progress (and recover asks after a restart). */
function applySnapshot(snap) {
  const msgs = snap.messages;
  for (const a of asks.values()) {
    if (!PENDING.has(a.status)) continue;
    const idx = msgs.findIndex((m) => m.role === 'user' && typeof m.text === 'string' && m.text.includes(marker(a.askId)));
    if (idx < 0) {
      if (a.status === 'sending' || a.status === 'queued') update(a, { status: snap.thread.activeRunId ? 'queued' : a.status });
      continue;
    }
    const runId = msgs[idx].runId;
    const replies = msgs.slice(idx + 1).filter((m) => m.role === 'assistant' && m.runId === runId).map((m) => m.text);
    const running = snap.thread.activeRunId === runId;
    if (running || waiters.has(a.askId)) {
      update(a, { status: 'running', runId, progress: replies.slice(-6) });
    } else if (replies.length) {
      // No live `--wait` process (bridge restarted): the run has finished.
      update(a, { status: 'completed', runId, answer: replies[replies.length - 1], progress: replies.slice(0, -1).slice(-6) });
    }
  }
}

function composeMessage(a, body) {
  const lines = [];
  lines.push(`[Inkfold] Question from my iPad notes (ref ${marker(a.askId)})`);
  lines.push('');
  if (body.context?.notebook) lines.push(`Notebook: ${body.context.notebook}`);
  if (a.clipPaths.length) {
    lines.push('Selections, saved as images on this machine. Open each image to see exactly what I circled:');
    body.clips.forEach((c, i) => {
      const where = [c.page ? `page ${c.page}` : null, c.document ? `of "${c.document}"` : null].filter(Boolean).join(' ');
      lines.push(`[${i + 1}] ${a.clipPaths[i]}${where ? ` (${where})` : ''}`);
      if (c.text) lines.push(`    Text under this selection, extracted from the PDF: «${c.text}»`);
    });
  }
  lines.push('');
  lines.push(`My question: ${body.question || 'What is this about? Explain it.'}`);
  lines.push('');
  if (body.detail === 'long') {
    lines.push(
      'How to answer: give a thorough but focused explanation, step by step where it helps. Write math in LaTeX: \\( … \\) inline and \\[ … \\] for display. Refer to the selections as [1], [2], … This is a reading question from my notes: do not edit files or start long computations unless I ask for that.',
    );
  } else {
    lines.push(
      'How to answer: be brief, at most about 150 words, focused on the selections. Write math in LaTeX: \\( … \\) inline and \\[ … \\] for display. Refer to the selections as [1], [2], … This is a quick reading question from my notes: do not edit files or start long computations unless I ask for that.',
    );
  }
  return lines.join('\n');
}

function decodeImage(dataUrl) {
  const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  if (!m) return null;
  const buf = Buffer.from(m[2], 'base64');
  const png = buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47;
  const jpg = buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8;
  if ((m[1] === 'png' && !png) || (m[1] === 'jpeg' && !jpg)) return null;
  return { buf, ext: m[1] === 'png' ? 'png' : 'jpg' };
}

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

async function createAsk(body) {
  const askId = str(body.askId, 80);
  if (!/^[A-Za-z0-9-]{8,80}$/.test(askId)) throw httpError(400, 'bad askId');
  const existing = asks.get(askId);
  if (existing) return existing; // idempotent retry
  const clips = Array.isArray(body.clips) ? body.clips.slice(0, MAX_CLIPS) : [];
  const clean = {
    question: str(body.question, MAX_QUESTION).trim(),
    detail: body.detail === 'long' ? 'long' : 'short',
    context: { notebook: str(body.context?.notebook, 300) },
    clips: clips.map((c) => ({
      page: Number.isInteger(c?.page) && c.page > 0 ? c.page : null,
      document: str(c?.document, 300),
      text: str(c?.text, 3000).replace(/\s+/g, ' ').trim(),
      image: c?.image,
    })),
  };
  if (!clean.question && !clean.clips.length) throw httpError(400, 'empty question');
  const clipPaths = [];
  for (let i = 0; i < clean.clips.length; i++) {
    const img = decodeImage(clean.clips[i].image);
    if (!img) throw httpError(400, `clip ${i + 1} is not a PNG/JPEG image`);
    const p = path.join(CLIP_DIR, `${askId}-${i + 1}.${img.ext}`);
    await fsp.writeFile(p, img.buf, { mode: 0o600 });
    clipPaths.push(p);
  }
  const now = Date.now();
  const a = { askId, createdAt: now, updatedAt: now, status: 'sending', clipPaths, progress: [], answer: null, error: null };
  asks.set(askId, a);
  const message = composeMessage(a, clean);
  update(a, { question: clean.question });
  log('ask', askId, `${clipPaths.length} clip(s)`);

  // `--wait` keeps the process alive until the agent finishes and prints its reply.
  const job = runT3(['thread', 'send', THREAD_ID, '-', '--json', '--wait'], { input: message, timeoutMs: 8 * 3600_000 }).then((r) => {
    waiters.delete(askId);
    const d = parseJson(r.stdout);
    if (d && d.status === 'completed' && typeof d.reply === 'string') {
      update(a, { status: 'completed', runId: d.runId, answer: d.reply });
    } else if (d && d.status) {
      update(a, { status: 'failed', runId: d.runId, error: d.error || `run ${d.status}` });
    } else {
      update(a, { status: 'failed', error: (r.stderr || r.stdout || 'send failed').trim().slice(0, 500) });
    }
    log('ask done', askId, a.status);
    void refreshSnapshot(0); // pick up the thread's new state (keeps the old info meanwhile)
  });
  waiters.set(askId, job);
  return a;
}

/* Poll the thread for progress while someone is watching, or to recover asks after a restart. */
setInterval(() => {
  const pending = [...asks.values()].some((a) => PENDING.has(a.status));
  if (!pending) return;
  const watching = Date.now() - lastClientPoll < 45_000;
  const orphaned = [...asks.values()].some((a) => PENDING.has(a.status) && !waiters.has(a.askId));
  if (watching) void refreshSnapshot(10_000);
  else if (orphaned) void refreshSnapshot(60_000);
}, 3000);

// After a restart, asks that were in flight have no `--wait` process any more.
for (const a of asks.values()) if (PENDING.has(a.status)) a.status = 'recovering';

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(httpError(413, 'too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

async function handle(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'Origin');
    res.setHeader('access-control-allow-headers', 'content-type');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-max-age', '600');
    if (req.headers['access-control-request-private-network']) res.setHeader('access-control-allow-private-network', 'true');
  } else if (origin) {
    return send(res, 403, { error: 'origin not allowed' });
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const login = req.headers['tailscale-user-login'];
  if (!TEST_PORT && !(typeof login === 'string' && ALLOWED_LOGINS.has(login))) return send(res, 403, { error: 'not allowed' });

  // Tailscale Serve may or may not strip the mount path; accept both.
  const url = new URL(req.url, 'http://bridge');
  const p = url.pathname.replace(/^\/api(?=\/|$)/, '') || '/';

  if (req.method === 'GET' && p === '/status') {
    void refreshSnapshot(60_000);
    return send(res, 200, { ok: true, user: login || null, thread: threadInfo() });
  }
  if (req.method === 'POST' && p === '/ask') {
    const body = parseJson(await readBody(req));
    if (!body) throw httpError(400, 'bad json');
    const a = await createAsk(body);
    lastClientPoll = Date.now();
    return send(res, 200, { ask: publicAsk(a), thread: threadInfo() });
  }
  if (req.method === 'GET' && p === '/asks') {
    lastClientPoll = Date.now();
    const ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean).slice(0, 50);
    const found = ids.map((id) => asks.get(id)).filter(Boolean).map(publicAsk);
    return send(res, 200, { asks: found, thread: threadInfo() });
  }
  return send(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (!e.status) log('error', e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'internal error' });
  });
});

if (TEST_PORT) {
  server.listen(TEST_PORT, '127.0.0.1', () => log(`test mode on http://127.0.0.1:${TEST_PORT}`));
} else {
  try {
    fs.unlinkSync(SOCKET);
  } catch {
    /* not there */
  }
  const old = process.umask(0o077);
  server.listen(SOCKET, () => {
    process.umask(old);
    fs.chmodSync(SOCKET, 0o600);
    log(`listening on ${SOCKET}, thread ${THREAD_ID}`);
  });
}
void refreshSnapshot(0);

for (const sig of ['SIGTERM', 'SIGINT'])
  process.on(sig, () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      fs.writeFileSync(ASKS_FILE, JSON.stringify([...asks.values()]), { mode: 0o600 });
    }
    process.exit(0);
  });
