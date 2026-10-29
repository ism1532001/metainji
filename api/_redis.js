// Redis 연결 도우미 (함수가 아니라 posts.js, stats.js가 불러 쓰는 파일이에요)
// Upstash 웹 주소(KV_REST_API_URL/TOKEN)와 일반 Redis 주소(REDIS_URL)를 둘 다 지원해요.
// redis([[명령, 인자...], ...]) → 각 명령의 결과 배열
import net from 'node:net';
import tls from 'node:tls';

class RedisError extends Error {}

export async function redis(cmds) {
  const restUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const restToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (restUrl && restToken) return viaRest(restUrl, restToken, cmds);
  const url = process.env.REDIS_URL || process.env.KV_URL;
  if (url) return viaTcp(url, cmds);
  throw new Error('redis_not_configured');
}

// a stable secret used to salt hashed IPs (never stored or shown)
export function secretSalt() {
  const t = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (t) return t.slice(-24);
  try { return decodeURIComponent(new URL(process.env.REDIS_URL || process.env.KV_URL || '').password).slice(-24); } catch { return ''; }
}

async function viaRest(url, token, cmds) {
  const r = await fetch(`${url.replace(/\/$/, '')}/pipeline`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cmds) });
  if (!r.ok) throw new Error('redis_http_' + r.status);
  const out = await r.json();
  return out.map(x => { if (x && x.error) throw new Error('redis: ' + x.error); return x ? x.result : null; });
}

function encode(cmd) {
  const parts = [Buffer.from(`*${cmd.length}\r\n`)];
  for (const a of cmd) { const b = Buffer.from(String(a), 'utf8'); parts.push(Buffer.from(`$${b.length}\r\n`), b, Buffer.from('\r\n')); }
  return Buffer.concat(parts);
}

// RESP2 reply parser; returns null while a reply is still incomplete
function parse(b, i) {
  if (i >= b.length) return null;
  const nl = b.indexOf('\r\n', i);
  if (nl < 0) return null;
  const type = b[i], line = b.toString('utf8', i + 1, nl);
  if (type === 43) return { value: line, end: nl + 2 };                    // +
  if (type === 45) return { value: new RedisError(line), end: nl + 2 };    // -
  if (type === 58) return { value: Number(line), end: nl + 2 };            // :
  if (type === 36) {                                                       // $
    const len = Number(line);
    if (len < 0) return { value: null, end: nl + 2 };
    const s = nl + 2, e = s + len;
    if (b.length < e + 2) return null;
    return { value: b.toString('utf8', s, e), end: e + 2 };
  }
  if (type === 42) {                                                       // *
    const n = Number(line);
    if (n < 0) return { value: null, end: nl + 2 };
    let pos = nl + 2; const arr = [];
    for (let k = 0; k < n; k++) { const r = parse(b, pos); if (!r) return null; arr.push(r.value); pos = r.end; }
    return { value: arr, end: pos };
  }
  throw new Error('redis_bad_reply');
}

function viaTcp(url, cmds) {
  const u = new URL(url);
  const host = u.hostname, port = Number(u.port) || 6379, secure = u.protocol === 'rediss:';
  const user = decodeURIComponent(u.username || ''), pass = decodeURIComponent(u.password || '');
  const db = (u.pathname || '').replace(/^\//, '');
  const pre = [];
  if (pass) pre.push(user && user !== 'default' ? ['AUTH', user, pass] : ['AUTH', pass]);
  if (db && db !== '0') pre.push(['SELECT', db]);
  const all = [...pre, ...cmds];
  return new Promise((resolve, reject) => {
    const sock = secure ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
    const replies = [];
    let buf = Buffer.alloc(0), done = false;
    const finish = err => {
      if (done) return;
      done = true;
      sock.destroy();
      if (err) return reject(err);
      const authErr = replies.slice(0, pre.length).find(r => r instanceof RedisError);
      if (authErr) return reject(new Error('redis auth: ' + authErr.message));
      const out = replies.slice(pre.length);
      const bad = out.find(r => r instanceof RedisError);
      if (bad) return reject(new Error('redis: ' + bad.message));
      resolve(out);
    };
    sock.setTimeout(6000, () => finish(new Error('redis_timeout')));
    sock.on('error', finish);
    sock.on('close', () => finish(new Error('redis_closed')));
    sock.on('data', chunk => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      try {
        let r;
        while (replies.length < all.length && (r = parse(buf, 0))) { replies.push(r.value); buf = buf.subarray(r.end); }
      } catch (e) { return finish(e); }
      if (replies.length === all.length) finish();
    });
    sock.write(Buffer.concat(all.map(encode)));
  });
}
