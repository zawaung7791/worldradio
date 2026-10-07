'use strict';
/*
 * World Radio API — tiny dependency-free Node service.
 *   GET  /api/nowplaying?uuid=<station uuid>   -> { title }   (reads ICY metadata from the stream)
 *   GET  /api/dead                              -> { uuids: [...] }
 *   POST /api/dead/report  { uuid }             -> { dead: bool }  (server re-tests the stream itself)
 *
 * Safety: clients only ever send a station UUID, never a URL. The stream URL is looked up
 * in the Radio Browser directory, and every connection is blocked from reaching private/internal IPs.
 */
const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = +process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || '/data';
const DEAD_FILE = path.join(DATA_DIR, 'dead.json');
const DEAD_TTL = (+process.env.DEAD_DAYS || 3) * 24 * 3600 * 1000;   // dead stations are re-tried after this
const MIN_REPORTS = +process.env.DEAD_MIN_REPORTS || 1;              // distinct visitors needed (plus a failed server test)
const MAX_STREAMS = 12;                                              // concurrent outbound stream connections
const UA = 'WorldRadio/1.0 (+https://worldradio.zawaung.site)';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* ---------- Block private networks (SSRF protection) ---------- */
const blocked = new net.BlockList();
[['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],
 ['192.0.0.0',24],['192.168.0.0',16],['198.18.0.0',15],['224.0.0.0',4],['240.0.0.0',4]]
  .forEach(([a, p]) => blocked.addSubnet(a, p, 'ipv4'));
[['::',128],['::1',128],['64:ff9b::',96],['fc00::',7],['fe80::',10],['ff00::',8]]
  .forEach(([a, p]) => blocked.addSubnet(a, p, 'ipv6'));
const isBlocked = (addr, fam) => blocked.check(addr, fam === 6 ? 'ipv6' : 'ipv4');

function safeLookup(hostname, options, cb){
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
    if (err) return cb(err);
    const ok = addrs.filter(a => !isBlocked(a.address, a.family));
    if (!ok.length) return cb(new Error('blocked address'));
    if (options && options.all) return cb(null, ok);
    cb(null, ok[0].address, ok[0].family);
  });
}

let activeStreams = 0;
function openStream(urlStr, headers, redirects = 3){
  return new Promise((resolve, reject) => {
    let u;
    try{ u = new URL(urlStr); }catch{ return reject(new Error('bad url')); }
    if (u.protocol !== 'https:') return reject(new Error('https only'));
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && isBlocked(host, net.isIPv6(host) ? 6 : 4)) return reject(new Error('blocked address'));
    const req = https.request(u, { method:'GET', headers, lookup:safeLookup, timeout:8000, insecureHTTPParser:true }, res => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location){
        res.resume();
        if (redirects <= 0) return reject(new Error('too many redirects'));
        let next;
        try{ next = new URL(res.headers.location, u).href; }catch{ return reject(new Error('bad redirect')); }
        return openStream(next, headers, redirects - 1).then(resolve, reject);
      }
      resolve({ res, req });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}
async function withStream(url, headers, fn){
  if (activeStreams >= MAX_STREAMS) throw new Error('busy');
  activeStreams++;
  let conn;
  try{
    conn = await openStream(url, headers);
    return await fn(conn.res, conn.req);
  } finally {
    activeStreams--;
    if (conn){ conn.res.destroy(); conn.req.destroy(); }
  }
}

/* ---------- Station lookup (UUID -> stream URL) ---------- */
const urlCache = new Map();
async function stationUrl(uuid){
  const hit = urlCache.get(uuid);
  if (hit && Date.now() - hit.ts < 3600e3) return hit.url;
  for (const base of ['https://all.api.radio-browser.info','https://de1.api.radio-browser.info','https://nl1.api.radio-browser.info']){
    try{
      const r = await fetch(`${base}/json/stations/byuuid/${uuid}`, { signal: AbortSignal.timeout(6000), headers: { 'User-Agent': UA } });
      if (!r.ok) continue;
      const j = await r.json();
      if (!Array.isArray(j) || !j.length) return null;
      const url = j[0].url_resolved || j[0].url;
      if (urlCache.size > 2000) urlCache.clear();
      urlCache.set(uuid, { url, ts: Date.now() });
      return url;
    }catch{}
  }
  throw new Error('directory unreachable');
}

/* ---------- Now playing (ICY metadata) ---------- */
function cleanTitle(buf){
  let t = buf.toString('utf8');
  if (t.includes('\uFFFD')) t = buf.toString('latin1');
  return t.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}
function readIcy(res){
  return new Promise(resolve => {
    const metaint = parseInt(res.headers['icy-metaint'], 10);
    if (!(res.statusCode >= 200 && res.statusCode < 300) || !metaint || metaint > 262144) return resolve(null);
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => resolve(null), 9000);
    const finish = v => { clearTimeout(timer); resolve(v); };
    res.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < metaint + 1) return;
      const len = buf[metaint] * 16;
      if (buf.length < metaint + 1 + len) return;
      if (!len) return finish('');
      const block = buf.subarray(metaint + 1, metaint + 1 + len);
      const raw = block.toString('latin1');
      const m = /StreamTitle='(.*?)'(?:;|$)/s.exec(raw);
      if (!m) return finish('');
      const start = raw.indexOf(m[1]);
      finish(cleanTitle(block.subarray(start, start + Buffer.byteLength(m[1], 'latin1'))));
    });
    res.on('error', () => finish(null));
    res.on('end', () => finish(null));
  });
}
const npCache = new Map();
async function nowPlaying(uuid){
  const c = npCache.get(uuid);
  if (c && c.pending) return c.pending;
  if (c && Date.now() - c.ts < 15000) return c.title;
  const p = (async () => {
    const url = await stationUrl(uuid);
    if (!url) return null;
    return await withStream(url, { 'Icy-MetaData': '1', 'User-Agent': UA, Accept: '*/*' }, res => readIcy(res));
  })().catch(() => null).then(title => {
    if (npCache.size > 500) npCache.clear();
    npCache.set(uuid, { title, ts: Date.now() });
    return title;
  });
  npCache.set(uuid, { title: c ? c.title : null, ts: c ? c.ts : 0, pending: p });
  return p;
}

/* ---------- Shared dead-station list ---------- */
let dead = {};
function pruneDead(){ const now = Date.now(); for (const [k, t] of Object.entries(dead)) if (now - t > DEAD_TTL) delete dead[k]; }
try{ dead = JSON.parse(fs.readFileSync(DEAD_FILE, 'utf8')); }catch{ dead = {}; }
pruneDead();
function saveDead(){
  try{
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DEAD_FILE + '.tmp', JSON.stringify(dead));
    fs.renameSync(DEAD_FILE + '.tmp', DEAD_FILE);
  }catch(e){ console.error('could not save dead list:', e.message); }
}
async function probe(uuid){
  const url = await stationUrl(uuid);
  if (!url) return { known:false };
  try{
    const alive = await withStream(url, { 'User-Agent': UA, Accept: '*/*' }, res => new Promise(resolve => {
      const ct = String(res.headers['content-type'] || '').toLowerCase();
      if (!(res.statusCode >= 200 && res.statusCode < 300) || ct.startsWith('text/html')) return resolve(false);
      const t = setTimeout(() => resolve(false), 8000);
      res.once('data', () => { clearTimeout(t); resolve(true); });     // audio bytes arrived: stream is alive
      res.once('error', () => { clearTimeout(t); resolve(false); });
      res.once('end', () => { clearTimeout(t); resolve(false); });
    }));
    return { known:true, alive };
  }catch(e){
    if (e.message === 'busy') return { known:true, alive:true };       // can't test right now: don't blame the station
    return { known:true, alive:false };
  }
}
const probeCache = new Map();
function probeCached(uuid){
  const c = probeCache.get(uuid);
  if (c && Date.now() - c.ts < 60000) return c.p;
  const p = probe(uuid);
  if (probeCache.size > 500) probeCache.clear();
  probeCache.set(uuid, { ts: Date.now(), p });
  return p;
}
const reporters = new Map();   // uuid -> Set(ip hashes)
async function report(uuid, ip){
  pruneDead();
  if (dead[uuid]) return { dead:true };
  const r = await probeCached(uuid);
  if (!r.known || r.alive) return { dead:false };
  const h = crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16);
  if (reporters.size > 2000) reporters.clear();
  const set = reporters.get(uuid) || new Set();
  set.add(h); reporters.set(uuid, set);
  if (set.size >= MIN_REPORTS){ dead[uuid] = Date.now(); reporters.delete(uuid); saveDead(); return { dead:true }; }
  return { dead:false, pending:true };
}

/* ---------- HTTP plumbing ---------- */
const windows = new Map();
function limited(key, max, ms){
  const now = Date.now();
  if (windows.size > 5000) for (const [k, w] of windows) if (w.reset < now) windows.delete(k);
  let w = windows.get(key);
  if (!w || w.reset < now){ w = { n:0, reset: now + ms }; windows.set(key, w); }
  return ++w.n > max;
}
function send(res, code, obj){
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff' });
  res.end(body);
}
function readJson(req){
  return new Promise((resolve, reject) => {
    let size = 0; const parts = [];
    req.on('data', c => { size += c.length; if (size > 2048){ reject(new Error('too large')); req.destroy(); } else parts.push(c); });
    req.on('end', () => { try{ resolve(JSON.parse(Buffer.concat(parts).toString() || '{}')); }catch(e){ reject(e); } });
    req.on('error', reject);
  });
}

http.createServer(async (req, res) => {
  const ip = String(req.headers['x-real-ip'] || req.socket.remoteAddress || 'unknown');
  const url = new URL(req.url, 'http://localhost');
  try{
    if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { ok:true });

    if (req.method === 'GET' && url.pathname === '/api/dead'){
      pruneDead();
      return send(res, 200, { uuids: Object.keys(dead) });
    }
    if (req.method === 'GET' && url.pathname === '/api/nowplaying'){
      const uuid = url.searchParams.get('uuid') || '';
      if (!UUID_RE.test(uuid)) return send(res, 400, { error:'bad uuid' });
      if (limited('np:' + ip, 40, 60000)) return send(res, 429, { error:'slow down' });
      return send(res, 200, { title: await nowPlaying(uuid) });
    }
    if (req.method === 'POST' && url.pathname === '/api/dead/report'){
      if (limited('rp:' + ip, 10, 60000)) return send(res, 429, { error:'slow down' });
      const body = await readJson(req);
      if (!UUID_RE.test(String(body.uuid || ''))) return send(res, 400, { error:'bad uuid' });
      return send(res, 200, await report(body.uuid, ip));
    }
    send(res, 404, { error:'not found' });
  }catch(e){
    send(res, 500, { error:'server error' });
  }
}).listen(PORT, '0.0.0.0', () => console.log('World Radio API listening on', PORT));
