/* ===========================================================================
 * FRIDAY — Memory backup / restore sidecar
 * ---------------------------------------------------------------------------
 * Why this exists:  the bundled server.cjs writes memories.json into the
 * Electron userData folder, which can disappear when the app name changes,
 * gets reinstalled, or the user clears AppData.  This sidecar keeps a
 * versioned history under FRIDAY_DATA_DIR\data\memories\ (outside the
 * resources/ folder so app updates don't clobber it) and auto-restores
 * if the primary file goes missing or empty.
 *
 * Usage (started by main.cjs alongside the backend):
 *   node memory_backup.cjs --port 3030 --source <APP_DATA>/memories.json
 *
 * Endpoints:
 *   GET    /api/memory-backups           -> list snapshots (newest first)
 *   GET    /api/memory-backups/:id       -> read a single snapshot
 *   POST   /api/memory-backups/now       -> force a snapshot right now
 *   POST   /api/memory-backups/restore   -> restore latest snapshot to primary
 *   POST   /api/memory-backups/restore/:id -> restore a specific snapshot
 *   GET    /api/memory-backups/health    -> status + counts
 * ========================================================================= */

'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const http = require('http');
const url = require('url');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  return process.argv[i + 1] ?? fallback;
}

const SOURCE_FILE = path.resolve(arg('--source', path.join(process.env.FRIDAY_DATA_DIR || process.cwd(), 'memories.json')));
const BACKUP_ROOT = path.resolve(arg('--backup-dir', path.join(__dirname, 'data', 'memories')));
const PORT = Number(arg('--port', '3030'));
const MAX_KEEP = Number(arg('--max-keep', '50'));
const WATCH_DEBOUNCE_MS = 800;

const BACKUPS_DIR = path.join(BACKUP_ROOT, 'backups');
const LATEST_FILE = path.join(BACKUP_ROOT, 'latest.json');
const PRIMARY_MIRROR = path.join(BACKUP_ROOT, 'memories.json');

function log(...args) {
  console.log('[mem-backup]', ...args);
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() +
    '-' + pad(d.getMonth() + 1) +
    '-' + pad(d.getDate()) +
    '_' + pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

async function ensureDirs() {
  await fsp.mkdir(BACKUPS_DIR, { recursive: true });
}

async function readJsonSafe(file, fallback = null) {
  try {
    const txt = await fsp.readFile(file, 'utf-8');
    return JSON.parse(txt);
  } catch (err) {
    if (err.code !== 'ENOENT') log('readJsonSafe error for', file, '-', err.message);
    return fallback;
  }
}

async function writeJsonAtomic(file, data) {
  const tmp = file + '.tmp-' + process.pid;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
  await fsp.rename(tmp, file);
}

function memoriesEqual(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  // shallow compare by id+text so trivial re-orderings don't churn snapshots
  const key = (m) => (m && m.id ? m.id : '') + '|' + (m && typeof m.text === 'string' ? m.text : JSON.stringify(m));
  const A = new Set(a.map(key));
  return b.every((m) => A.has(key(m)));
}

// ---------------------------------------------------------------------------
// Snapshot core
// ---------------------------------------------------------------------------
async function snapshot(reason = 'manual') {
  await ensureDirs();
  const current = await readJsonSafe(SOURCE_FILE, null);
  if (!Array.isArray(current)) {
    log(`snapshot skipped (${reason}): source is missing or not an array`);
    return null;
  }
  if (current.length === 0) {
    log(`snapshot skipped (${reason}): zero memories — refusing to overwrite history with emptiness`);
    return null;
  }

  const latest = await readJsonSafe(LATEST_FILE, null);
  if (memoriesEqual(current, latest)) {
    log(`snapshot skipped (${reason}): unchanged from latest`);
    return null;
  }

  const stamp = timestamp();
  const id = `${stamp}_${Math.random().toString(36).slice(2, 8)}`;
  const dest = path.join(BACKUPS_DIR, `${id}.json`);

  const payload = {
    id,
    createdAt: new Date().toISOString(),
    reason,
    sourceFile: SOURCE_FILE,
    count: current.length,
    memories: current,
  };

  await writeJsonAtomic(dest, payload);
  await writeJsonAtomic(LATEST_FILE, payload);
  await writeJsonAtomic(PRIMARY_MIRROR, current);

  const discordMemPath = path.resolve(__dirname, '..', 'friday-discord-bot', 'memories.json');
  if (fs.existsSync(path.dirname(discordMemPath))) {
    await writeJsonAtomic(discordMemPath, current);
    log(`synced ${current.length} memories directly to Discord bot (${discordMemPath})`);
  }

  await prune();
  log(`snapshot ${id} (${current.length} memories, reason=${reason})`);
  return { id, count: current.length, createdAt: payload.createdAt };
}

async function prune() {
  try {
    const entries = await fsp.readdir(BACKUPS_DIR);
    const json = entries.filter((f) => f.endsWith('.json')).sort().reverse();
    const toDelete = json.slice(MAX_KEEP);
    for (const f of toDelete) {
      await fsp.unlink(path.join(BACKUPS_DIR, f)).catch(() => {});
    }
    if (toDelete.length) log(`pruned ${toDelete.length} old snapshot(s); keeping ${MAX_KEEP}`);
  } catch (err) {
    log('prune error:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------
async function restore(id) {
  let payload;
  if (!id || id === 'latest') {
    payload = await readJsonSafe(LATEST_FILE, null);
  } else {
    // accept short id prefix
    const files = (await fsp.readdir(BACKUPS_DIR)).filter((f) => f.endsWith('.json'));
    const match = files.find((f) => f.startsWith(id));
    if (!match) throw new Error(`no snapshot matches id "${id}"`);
    payload = await readJsonSafe(path.join(BACKUPS_DIR, match), null);
  }
  if (!payload || !Array.isArray(payload.memories)) {
    throw new Error('snapshot payload invalid');
  }
  await writeJsonAtomic(SOURCE_FILE, payload.memories);
  await writeJsonAtomic(PRIMARY_MIRROR, payload.memories);
  log(`restored snapshot ${payload.id} (${payload.count} memories) -> ${SOURCE_FILE}`);
  return { id: payload.id, count: payload.count };
}

async function autoRestoreIfNeeded() {
  // Heuristic: source is missing or empty JSON; latest.json has data.
  let primary;
  try {
    const txt = await fsp.readFile(SOURCE_FILE, 'utf-8');
    primary = JSON.parse(txt);
  } catch (err) {
    primary = null;
  }
  const needsRestore =
    !Array.isArray(primary) || primary.length === 0;

  if (!needsRestore) return { restored: false };

  const latest = await readJsonSafe(LATEST_FILE, null);
  if (!latest || !Array.isArray(latest.memories) || latest.memories.length === 0) {
    log('auto-restore: nothing to restore from');
    return { restored: false };
  }

  log(`auto-restore: primary is empty, restoring ${latest.count} memories from ${latest.id}`);
  await writeJsonAtomic(SOURCE_FILE, latest.memories);
  await writeJsonAtomic(PRIMARY_MIRROR, latest.memories);
  return { restored: true, id: latest.id, count: latest.count };
}

// ---------------------------------------------------------------------------
// Watcher
// ---------------------------------------------------------------------------
let debounceTimer = null;
let watcher = null;

function startWatcher() {
  if (watcher) return;
  try {
    watcher = fs.watch(SOURCE_FILE, { persistent: false }, () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => snapshot('watch').catch((e) => log('watch snapshot err:', e.message)), WATCH_DEBOUNCE_MS);
    });
    watcher.on('error', (e) => log('watch error:', e.message));
    log('watching', SOURCE_FILE);
  } catch (err) {
    log('could not start watcher:', err.message);
  }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  const parsed = url.parse(req.url, true);
  const p = parsed.pathname || '';

  try {
    if (req.method === 'GET' && p === '/api/memory-backups/health') {
      return send(res, 200, {
        ok: true,
        sourceFile: SOURCE_FILE,
        backupDir: BACKUP_ROOT,
        pid: process.pid,
        uptime: process.uptime(),
      });
    }

    if (req.method === 'GET' && p === '/api/memory-backups') {
      await ensureDirs();
      const files = (await fsp.readdir(BACKUPS_DIR)).filter((f) => f.endsWith('.json')).sort().reverse();
      const list = [];
      for (const f of files) {
        const meta = await readJsonSafe(path.join(BACKUPS_DIR, f), null);
        if (!meta) continue;
        list.push({ id: meta.id, createdAt: meta.createdAt, reason: meta.reason, count: meta.count });
      }
      return send(res, 200, { count: list.length, backups: list });
    }

    if (req.method === 'GET' && p.startsWith('/api/memory-backups/') && !p.includes('/restore')) {
      const id = decodeURIComponent(p.slice('/api/memory-backups/'.length));
      const files = (await fsp.readdir(BACKUPS_DIR)).filter((f) => f.endsWith('.json'));
      const match = files.find((f) => f.startsWith(id));
      if (!match) return send(res, 404, { error: 'not found' });
      const payload = await readJsonSafe(path.join(BACKUPS_DIR, match), null);
      return send(res, 200, payload);
    }

    if (req.method === 'POST' && p === '/api/memory-backups/now') {
      const result = await snapshot('api');
      return send(res, 200, { ok: true, snapshot: result });
    }

    if (req.method === 'POST' && p.startsWith('/api/memory-backups/restore')) {
      const parts = p.split('/').filter(Boolean);
      const id = parts.length >= 4 ? decodeURIComponent(parts[3]) : null;
      const result = await restore(id);
      return send(res, 200, { ok: true, restored: result });
    }

    send(res, 404, { error: 'not found' });
  } catch (err) {
    log('http error:', err.message);
    send(res, 500, { error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
(async function main() {
  await ensureDirs();
  const restored = await autoRestoreIfNeeded().catch((e) => {
    log('auto-restore error:', e.message);
    return { restored: false };
  });
  if (restored.restored) {
    log(`AUTO-RESTORE COMPLETE: pulled ${restored.count} memories back into ${SOURCE_FILE}`);
  }

  // Take an initial snapshot if we have data but no latest yet.
  const latest = await readJsonSafe(LATEST_FILE, null);
  const current = await readJsonSafe(SOURCE_FILE, null);
  if (!latest && Array.isArray(current) && current.length > 0) {
    await snapshot('initial');
  }

  startWatcher();

  server.listen(PORT, '127.0.0.1', () => {
    log(`listening on http://127.0.0.1:${PORT}`);
    log(`source:    ${SOURCE_FILE}`);
    log(`backups:   ${BACKUPS_DIR}`);
    log(`keep last: ${MAX_KEEP}`);
  });
})().catch((e) => {
  console.error('[mem-backup] FATAL:', e);
  process.exit(1);
});

process.on('SIGTERM', () => { log('SIGTERM, exiting'); process.exit(0); });
process.on('SIGINT', () => { log('SIGINT, exiting'); process.exit(0); });
