#!/usr/bin/env node
/* uventoy server — zero dependencies.
 * Serves the mobile-friendly UI and runs the official Ventoy2Disk.sh in the
 * background. Connected devices are discovered with lsblk and restricted to
 * whole removable disks. */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { listLocalDevices } = require('./lib/devices');

const ROOT = path.resolve(process.env.VENTOY_PKG || path.join(__dirname, 'ventoy')); // official package
const VTOY2DISK = path.resolve(process.env.VENTOY2DISK || path.join(ROOT, 'Ventoy2Disk.sh'));
const VERSION_FILE = path.join(ROOT, 'ventoy', 'version');

const MIME = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.json':'application/json; charset=utf-8', '.ico':'image/x-icon', '.svg':'image/svg+xml', '.png':'image/png' };
// Only UI files are exposed. server.js, lib/, ventoy/, setup.sh, module.prop
// must NEVER be reachable over HTTP.
const STATIC = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/css/style.css': 'css/style.css',
  '/js/app.js': 'js/app.js',
  '/favicon.ico': 'public/favicon.ico',
};

let HOST = 'localhost';
const _envPort = parseInt(process.env.PORT, 10);
let PORT = (Number.isInteger(_envPort) && _envPort > 0 && _envPort <= 65535) ? _envPort : 3000;

for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '-H') HOST = process.argv[++i];
  else if (a === '-p') PORT = +process.argv[++i];
  else if (a === '-h' || a === '--help') {
    console.log('Usage: node server.js [-H host] [-p port]\n  defaults: -H localhost -p 3000 (or $PORT if set)');
    process.exit(0);
  }
}

/* ------------------------------------------------------------------ */
/* package / devices                                                    */
/* ------------------------------------------------------------------ */
function pkgVersion() {
  try { return fs.readFileSync(VERSION_FILE, 'utf8').trim(); } catch { return '?'; }
}

function stripAnsi(s) {
  return String(s)
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

const infoCache = new Map(); // disk path -> { at, value }
let infoChain = Promise.resolve();

function runListInfo(disk) {
  return new Promise(resolve => {
    let out = '';
    const child = spawn('/bin/sh', [VTOY2DISK, '-l', disk], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const onData = d => { if (out.length < 65536) out += d.toString('utf8'); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 15000);
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', () => {
      clearTimeout(timer);
      const txt = stripAnsi(out);
      const vm = txt.match(/Ventoy Version in Disk:\s*(\S+)/i);
      if (!vm) return resolve({ valid: false, version: '', partstyle: 0, secure_boot: 0 });
      const pm = txt.match(/Disk Partition Style\s*:\s*(\S+)/i);
      const sm = txt.match(/Secure Boot Support\s*:\s*(\S+)/i);
      resolve({
        valid: true,
        version: vm[1],
        partstyle: pm && /^gpt$/i.test(pm[1]) ? 1 : 0,
        secure_boot: sm && /^yes$/i.test(sm[1]) ? 1 : 0,
      });
    });
  });
}

function ventoyInfo(disk) {
  const hit = infoCache.get(disk);
  if (hit && Date.now() - hit.at < 5000) return Promise.resolve(hit.value);
  const run = infoChain.then(() => runListInfo(disk)).then(value => {
    infoCache.set(disk, { at: Date.now(), value });
    return value;
  });
  infoChain = run.catch(() => {});
  return run;
}

async function scanDevices() {
  const list = await listLocalDevices();
  for (const d of list) {
    if (job && job.running) {
      const hit = infoCache.get(d.path);
      d.ventoy = hit ? hit.value : { valid: false, version: '', partstyle: 0, secure_boot: 0 };
    } else {
      d.ventoy = await ventoyInfo(d.path);
    }
  }
  return list;
}

async function resolveDisk(value) {
  const wanted = String(value == null ? '' : value).trim();
  if (!/^\/dev\/[A-Za-z0-9._-]+$/.test(wanted)) throw new Error('Invalid device path.');
  const list = await listLocalDevices();
  const hit = list.find(d => d.path === wanted || '/dev/' + d.name === wanted);
  if (!hit) throw new Error('Device is not a connected removable disk.');
  return hit;
}

/* ------------------------------------------------------------------ */
/* background jobs                                                      */
/* ------------------------------------------------------------------ */
const MAX_LOG = 500;
let job = null;
let jobSeq = 0;
let stopping = false;

const PROGRESS = {
  install: [
    { re: /check partition layout|Free space enough|We need to shrink/i, p: 12, stage: 'Checking disk' },
    { re: /Create partitions on/i, p: 15, stage: 'Creating partitions' },
    { re: /Format partition|mkexfatfs/i, p: 30, stage: 'Formatting partition' },
    { re: /writing data to disk/i, p: 55, stage: 'Writing data' },
    { re: /sync data/i, p: 75, stage: 'Syncing data' },
    { re: /esp partition processing/i, p: 85, stage: 'ESP partition' },
    { re: /successfully finished/i, p: 95, stage: 'Finishing' },
  ],
  update: [
    { re: /Upgrade operation is safe/i, p: 10, stage: 'Preparing update' },
    { re: /writing data to disk/i, p: 55, stage: 'Writing data' },
    { re: /esp partition processing/i, p: 85, stage: 'ESP partition' },
    { re: /update esp partition attribute/i, p: 90, stage: 'Updating partition table' },
    { re: /successfully finished/i, p: 95, stage: 'Finishing' },
  ],
};

const STAGE_CAP = {
  Starting: 8,
  'Preparing update': 20,
  'Checking disk': 20,
  'Creating partitions': 28,
  'Formatting partition': 50,
  'Writing data': 72,
  'Syncing data': 82,
  'ESP partition': 92,
  'Updating partition table': 92,
  Finishing: 99,
};

function newJob(type, disk, mode) {
  return {
    id: ++jobSeq,
    type,
    mode,
    disk,
    percent: 2,
    stage: 'Starting',
    lines: [],
    buf: '',
    running: true,
    finished: false,
    success: null,
    error: null,
    exitCode: null,
    startedAt: Date.now(),
    finishedAt: null,
    timer: null,
    child: null,
  };
}

function addLine(j, raw) {
  if (!j) return;
  const line = stripAnsi(raw).replace(/\s+$/, '');
  if (!line) return;
  j.lines.push(line);
  if (j.lines.length > MAX_LOG) j.lines.splice(0, j.lines.length - MAX_LOG);
  for (const step of PROGRESS[j.type] || []) {
    if (step.p > j.percent && step.re.test(line)) {
      j.percent = step.p;
      j.stage = step.stage;
    }
  }
}

function appendData(j, chunk) {
  if (!j) return;
  j.buf += chunk.toString('utf8');
  const parts = j.buf.split(/\r\n|\r|\n/);
  j.buf = parts.pop();
  for (const line of parts) addLine(j, line);
  if (j.buf.length > 16384) { addLine(j, j.buf); j.buf = ''; }
}

function flushBuffer(j) {
  if (j && j.buf) { addLine(j, j.buf); j.buf = ''; }
}

function finishJob(j, code, error) {
  if (!j || j.finished) return;
  j.finished = true;
  j.running = false;
  j.exitCode = code;
  j.finishedAt = Date.now();
  if (j.timer) clearInterval(j.timer);
  flushBuffer(j);
  if (error) {
    j.success = false;
    j.stage = 'Failed';
    j.error = error.message || String(error);
  } else if (code === 0) {
    j.success = true;
    j.percent = 100;
    j.stage = 'Done';
  } else {
    j.success = false;
    j.stage = 'Failed';
    const tail = j.lines.slice(-5).join(' ').trim();
    j.error = tail || ('Ventoy2Disk.sh exited with code ' + code);
  }
  infoCache.clear();
}

function publicJob() {
  if (!job) return { ok: true, running: false, none: true };
  return {
    ok: true,
    id: job.id,
    type: job.type,
    mode: job.mode,
    disk: job.disk,
    percent: Math.round(job.percent),
    stage: job.stage,
    running: job.running,
    success: job.success,
    error: job.error,
    exitCode: job.exitCode,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    lines: job.lines.slice(-150),
  };
}

function boolValue(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  const s = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

function normalizeLabel(value) {
  const label = String(value == null ? '' : value).trim() || 'Ventoy';
  if (label.length > 11) throw new Error('Partition label must be 11 characters or fewer.');
  if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]*$/.test(label)) throw new Error('Invalid partition label.');
  return label;
}

function normalizeReserve(value) {
  if (value === undefined || value === null || value === '' || value === 0 || value === '0') return 0;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 9999999) throw new Error('Invalid reserved space (MiB).');
  return n;
}

async function startJob(res, type, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) body = {};
  if (job && job.running) return json(res, 409, { ok: false, error: 'A task is already running.' });

  let args;
  let disk;
  let mode = '';
  try {
    const target = await resolveDisk(body.disk);
    disk = target.path;
    if (type === 'install') {
      mode = String(body.mode || 'install');
      if (!['install', 'force', 'nondestructive'].includes(mode)) throw new Error('Invalid install mode.');
      const label = normalizeLabel(body.label);
      const reserve = normalizeReserve(body.reserve_mb);
      const secureBoot = boolValue(body.secure_boot, true);
      args = [mode === 'force' ? '-I' : '-i'];
      if (mode === 'nondestructive') args.push('-n');
      if (boolValue(body.gpt, false)) args.push('-g');
      args.push(secureBoot ? '-s' : '-S');
      if (reserve > 0) args.push('-r', String(reserve));
      args.push('-L', label);
      args.push(disk);
    } else if (type === 'update') {
      args = ['-u', boolValue(body.secure_boot, true) ? '-s' : '-S', disk];
    } else {
      throw new Error('Unknown operation.');
    }
  } catch (e) {
    return json(res, 400, { ok: false, error: e.message });
  }

  // Re-check after the async lsblk call so two requests cannot start together.
  if (job && job.running) return json(res, 409, { ok: false, error: 'A task is already running.' });

  const thisJob = job = newJob(type, disk, mode);
  let child;
  try {
    child = spawn('/bin/sh', [VTOY2DISK, ...args], {
      cwd: ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    finishJob(thisJob, null, e);
    return json(res, 500, { ok: false, error: e.message });
  }
  thisJob.child = child;
  child.stdout.on('data', d => appendData(thisJob, d));
  child.stderr.on('data', d => appendData(thisJob, d));
  child.stdin.on('error', () => {});
  child.on('error', err => finishJob(thisJob, null, err));
  child.on('close', code => finishJob(thisJob, code));
  // VentoyWorker asks one or two "Continue? (y/n)" questions. Answer them here;
  // the web UI has already shown the destructive confirmations.
  try { child.stdin.write('y\ny\ny\n'); child.stdin.end(); } catch {}

  thisJob.timer = setInterval(() => {
    if (!thisJob.running) return;
    const cap = STAGE_CAP[thisJob.stage] == null ? 90 : STAGE_CAP[thisJob.stage];
    if (thisJob.percent < cap) thisJob.percent = Math.min(cap, thisJob.percent + 0.5);
  }, 1500);

  console.log(`[webx] ${type} ${disk} started (${args.join(' ')})`);
  return json(res, 202, { ok: true, job: publicJob() });
}

/* ------------------------------------------------------------------ */
/* http helpers                                                         */
/* ------------------------------------------------------------------ */
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(JSON.stringify(obj));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > 65536) { reject(new Error('Request body too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('Invalid JSON body.')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res) {
  const u = decodeURIComponent(req.url.split('?')[0]);
  const rel = STATIC[u];
  if (!rel) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return;
  }
  const f = path.join(__dirname, rel);
  if (!fs.existsSync(f)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return;
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(f)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  fs.createReadStream(f).pipe(res);
}

async function handler(req, res) {
  try {
    await route(req, res);
  } catch (e) {
    if (!res.headersSent) json(res, 500, { ok: false, error: e.message });
    else res.destroy();
  }
}

async function route(req, res) {
  const pathname = new URL(req.url, 'http://localhost').pathname;

  if (req.method === 'GET' && pathname === '/api/health') {
    return json(res, 200, { ok: true, backend: 'Ventoy2Disk.sh' });
  }
  if (req.method === 'GET' && pathname === '/api/sysinfo') {
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    return json(res, 200, {
      ok: true,
      version: pkgVersion(),
      platform: process.platform,
      arch: process.arch,
      uid,
      root: uid === null ? null : uid === 0,
      busy: !!(job && job.running),
    });
  }
  if (req.method === 'GET' && pathname === '/api/devices') {
    try {
      const devices = await scanDevices();
      return json(res, 200, { ok: true, devices, busy: !!(job && job.running) });
    } catch (e) {
      return json(res, 500, { ok: false, devices: [], error: e.message });
    }
  }
  if (req.method === 'GET' && pathname === '/api/job') {
    return json(res, 200, publicJob());
  }
  if (req.method === 'POST' && pathname === '/api/install') {
    try {
      const body = await readJson(req);
      return await startJob(res, 'install', body);
    } catch (e) {
      return json(res, 400, { ok: false, error: e.message });
    }
  }
  if (req.method === 'POST' && pathname === '/api/update') {
    try {
      const body = await readJson(req);
      return await startJob(res, 'update', body);
    } catch (e) {
      return json(res, 400, { ok: false, error: e.message });
    }
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return json(res, 405, { ok: false, error: 'Method not allowed.' });
  }
  return serveStatic(req, res);
}

/* ------------------------------------------------------------------ */
/* startup                                                              */
/* ------------------------------------------------------------------ */
if (!fs.existsSync(path.join(ROOT, 'boot', 'boot.img')) || !fs.existsSync(VTOY2DISK)) {
  console.error('Ventoy install package not found.');
  console.error('Expected: ' + path.join(ROOT, 'boot', 'boot.img'));
  console.error('          ' + VTOY2DISK);
  console.error('Run setup.sh first to download and extract the official Ventoy package.');
  process.exit(1);
}

const onReady = () => {
  console.log('');
  console.log('===============================================================');
  console.log(`  uventoy (Ventoy ${pkgVersion()}) is running ...`);
  console.log(`  Please open your browser and visit http://${HOST}:${PORT}`);
  console.log(`  backend: Ventoy2Disk.sh (${VTOY2DISK})`);
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    console.log('  WARNING: not running as root — install/update will fail.');
  }
  console.log('===============================================================');
  console.log('################## Press Ctrl + C to exit #####################');
};

if (HOST === 'localhost') {
  // 'localhost' may resolve to 127.0.0.1 and/or ::1 — listen on both
  // loopback families so http://localhost:$PORT always works.
  http.createServer(handler).listen(PORT, '127.0.0.1', () => {
    const v6 = http.createServer(handler);
    v6.on('error', onReady); // no IPv6 stack — IPv4 is enough
    v6.listen(PORT, '::1', onReady);
  });
} else {
  http.createServer(handler).listen(PORT, HOST, onReady);
}

const bye = () => {
  if (job && job.running && !stopping) {
    stopping = true;
    console.log('\n[webx] A Ventoy2Disk task is running. Press Ctrl+C again to stop the server (the task may be interrupted).');
    return;
  }
  process.exit(0);
};
process.on('SIGINT', bye);
process.on('SIGTERM', bye);
