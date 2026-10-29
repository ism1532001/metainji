// 메타인지 인증 게시판 API (Vercel Function + Redis)
// GET    /api/posts?mode=marry|date&g=M|F&after=<ts>&limit=20   최신순 목록
// POST   /api/posts  {nick,msg,m,g,age,k,me,t,r,want}             인증 올리기 → {post, token}
// POST   /api/posts  {action:'delete', id, token}                 내가 올린 글 지우기
// 글은 p:<id> 에 JSON으로, 목록은 시간순 정렬 집합(pz:all, pz:m:<기준>, pz:g:<성별>, pz:mg:<기준><성별>)에 넣어요.
import { createHash, randomBytes } from 'node:crypto';
import { redis, secretSalt } from './_redis.js';

const MAX_TS = 9999999999999;
const ID_RE = /^(\d{13})-(marry|date)([MF])-([0-9a-f]{12})$/;
const ORIGIN_RE = /^(https:\/\/metainji(-[a-z0-9-]+)?\.vercel\.app|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/;
const BAD_WORDS = ['씨발', '시발', '씨팔', 'ㅅㅂ', 'ㅆㅂ', '병신', 'ㅂㅅ', '좆', '존나', '졸라', '개새끼', '새끼', '미친놈', '미친년', '썅', '닥쳐', 'fuck', 'shit', 'bitch'];
const RESERVED_NICK = /운영자|관리자|메타인지|admin/i;
const LINK_RE = /(https?:\/\/|www\.|\.(com|net|org|kr|co|io|me|ly|gg|xyz|link|shop)\b|open\.kakao)/i;

const sha = s => createHash('sha256').update(s).digest('hex');
const kstDay = (t = Date.now()) => new Date(t + 9 * 3600e3).toISOString().slice(0, 10);


function send(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(body === null ? '' : JSON.stringify(body));
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  let raw = typeof req.body === 'string' ? req.body : Buffer.isBuffer(req.body) ? req.body.toString('utf8') : null;
  if (raw === null) {
    raw = '';
    for await (const chunk of req) { raw += chunk; if (raw.length > 8000) throw new Error('too_big'); }
  }
  if (raw.length > 8000) throw new Error('too_big');
  return raw ? JSON.parse(raw) : {};
}

function cleanText(v, max) {
  if (typeof v !== 'string') return '';
  let s = v.normalize('NFC').replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  s = Array.from(s).slice(0, max).join('');
  for (const w of BAD_WORDS) s = s.split(w).join('*'.repeat(Array.from(w).length));
  return s;
}
const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null);

function publicPost(p) {
  return { id: p.id, ts: p.ts, nick: p.nick, msg: p.msg, m: p.m, g: p.g, age: p.age, k: p.k, me: p.me, t: p.t, r: p.r, want: p.want };
}
const indexCmds = p => [
  ['SET', `p:${p.id}`, JSON.stringify(p)],
  ['ZADD', 'pz:all', String(p.ts), p.id],
  ['ZADD', `pz:m:${p.m}`, String(p.ts), p.id],
  ['ZADD', `pz:g:${p.g}`, String(p.ts), p.id],
  ['ZADD', `pz:mg:${p.m}${p.g}`, String(p.ts), p.id],
];

// one-time move of posts saved by the earlier Blob-based version
async function importFromBlob() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return;
  const [claimed] = await redis([['SET', 'mig:blob', 'running', 'NX', 'EX', '120']]);
  if (claimed === null) return;
  try {
    const { list } = await import('@vercel/blob');
    const { blobs } = await list({ prefix: 'posts/', limit: 1000 });
    const cmds = [];
    for (const b of blobs) {
      const id = b.pathname.slice(6).replace(/\.json$/, '');
      if (!ID_RE.test(id)) continue;
      try {
        const p = await (await fetch(b.url, { cache: 'no-store' })).json();
        if (p && p.id === id) { delete p.ipHash; cmds.push(...indexCmds(p)); }
      } catch {}
    }
    if (cmds.length) await redis(cmds);
    await redis([['SET', 'mig:blob', 'done']]);
  } catch (e) {
    console.error('blob import failed', e);
    await redis([['DEL', 'mig:blob']]);
  }
}

async function handleList(req, res) {
  const url = new URL(req.url, 'http://x');
  const mode = ['marry', 'date'].includes(url.searchParams.get('mode')) ? url.searchParams.get('mode') : '';
  const g = ['M', 'F'].includes(url.searchParams.get('g')) ? url.searchParams.get('g') : '';
  const after = url.searchParams.get('after');
  const limit = Math.min(30, Math.max(1, parseInt(url.searchParams.get('limit') || '20', 10) || 20));
  const key = mode && g ? `pz:mg:${mode}${g}` : mode ? `pz:m:${mode}` : g ? `pz:g:${g}` : 'pz:all';
  const max = after && /^\d{1,15}$/.test(after) ? `(${after}` : '+inf';
  const range = ['ZRANGE', key, max, '-inf', 'BYSCORE', 'REV', 'LIMIT', '0', String(limit + 1)];
  let [migrated, ids] = await redis([['EXISTS', 'mig:blob'], range]);
  if (!migrated && process.env.BLOB_READ_WRITE_TOKEN) { await importFromBlob(); [ids] = await redis([range]); }
  ids = ids || [];
  const hasMore = ids.length > limit;
  const page = ids.slice(0, limit);
  let posts = [];
  if (page.length) {
    const [vals] = await redis([['MGET', ...page.map(id => `p:${id}`)]]);
    posts = (vals || []).filter(Boolean).map(v => { try { return publicPost(JSON.parse(v)); } catch { return null; } }).filter(Boolean);
  }
  const last = posts[posts.length - 1];
  send(res, 200, { posts, hasMore, next: hasMore && last ? String(last.ts) : null }, { 'Cache-Control': 'public, s-maxage=5, stale-while-revalidate=30' });
}

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  return (typeof xf === 'string' && xf.split(',')[0].trim()) || req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
}

async function handleCreate(req, res, body) {
  const nick = cleanText(body.nick, 12) || '익명';
  const msg = cleanText(body.msg, 80);
  if (RESERVED_NICK.test(nick)) return send(res, 400, { error: 'nick', message: '쓸 수 없는 닉네임이에요.' });
  if (LINK_RE.test(nick) || LINK_RE.test(msg)) return send(res, 400, { error: 'link', message: '링크나 연락처는 올릴 수 없어요.' });
  const m = body.m === 'date' ? 'date' : body.m === 'marry' ? 'marry' : null;
  const g = body.g === 'M' || body.g === 'F' ? body.g : null;
  const age = Number.isInteger(body.age) && body.age >= 20 && body.age <= 65 ? body.age : null;
  const k = Number.isInteger(body.k) && body.k >= 0 && body.k <= 4 ? body.k : null;
  const me = num(body.me, 0, 100), t = num(body.t, 0, 100), r = num(body.r, 0, 1);
  if (!m || !g || age === null || k === null || me === null || t === null || r === null) return send(res, 400, { error: 'invalid', message: '판정 결과를 확인하지 못했어요. 다시 판정한 뒤 올려 주세요.' });
  const want = (Array.isArray(body.want) ? body.want : []).slice(0, 8).map(w => cleanText(w, 30)).filter(Boolean);
  if (want.some(w => LINK_RE.test(w))) return send(res, 400, { error: 'link', message: '링크나 연락처는 올릴 수 없어요.' });

  const now = Date.now();
  const ipHash = sha(clientIp(req) + '|' + secretSalt()).slice(0, 32);
  // one post per person per minute, and at most 30 posts a minute overall
  const minute = `rl:min:${Math.floor(now / 60000)}`;
  const [okIp, perMin] = await redis([['SET', `rl:ip:${ipHash}`, '1', 'NX', 'EX', '60'], ['INCR', minute], ['EXPIRE', minute, '120']]);
  if (okIp === null) return send(res, 429, { error: 'slow', message: '1분에 한 번만 올릴 수 있어요. 잠시 후 다시 올려 주세요.' });
  if (perMin > 30) return send(res, 429, { error: 'busy', message: '지금 올리는 사람이 많아요. 잠시 후 다시 올려 주세요.' });

  const token = randomBytes(16).toString('hex');
  const id = `${String(MAX_TS - now).padStart(13, '0')}-${m}${g}-${randomBytes(6).toString('hex')}`;
  const post = { id, ts: now, nick, msg, m, g, age, k, me: Math.round(me * 10) / 10, t: Math.round(t * 10) / 10, r: Number(r.toPrecision(4)), want, tokenHash: sha(token) };
  const day = kstDay(now);
  await redis([...indexCmds(post), ['HINCRBY', `st:d:${day}`, 'post', '1'], ['HINCRBY', 'st:total', 'post', '1'], ['EXPIRE', `st:d:${day}`, String(400 * 86400)]]);
  send(res, 201, { post: publicPost(post), token });
}

async function handleDelete(req, res, body) {
  const id = typeof body.id === 'string' ? body.id : '';
  const token = typeof body.token === 'string' ? body.token : '';
  if (!ID_RE.test(id) || !/^[0-9a-f]{32}$/.test(token)) return send(res, 400, { error: 'invalid', message: '지울 글을 찾지 못했어요.' });
  const [raw] = await redis([['GET', `p:${id}`]]);
  if (!raw) return send(res, 404, { error: 'gone', message: '이미 지워진 글이에요.' });
  const post = JSON.parse(raw);
  if (post.tokenHash !== sha(token)) return send(res, 403, { error: 'forbidden', message: '이 기기에서 올린 글만 지울 수 있어요.' });
  await redis([['DEL', `p:${id}`], ['ZREM', 'pz:all', id], ['ZREM', `pz:m:${post.m}`, id], ['ZREM', `pz:g:${post.g}`, id], ['ZREM', `pz:mg:${post.m}${post.g}`, id]]);
  send(res, 200, { ok: true });
}

export default async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') return send(res, 204, null);
    if (req.method === 'GET') return await handleList(req, res);
    if (req.method !== 'POST') return send(res, 405, { error: 'method' });
    const origin = req.headers.origin;
    if (origin && !ORIGIN_RE.test(origin)) return send(res, 403, { error: 'origin', message: '메타인지 사이트에서만 올릴 수 있어요.' });
    let body;
    try { body = await readBody(req); } catch { return send(res, 400, { error: 'body', message: '내용을 읽지 못했어요.' }); }
    if (body && body.action === 'delete') return await handleDelete(req, res, body);
    return await handleCreate(req, res, body || {});
  } catch (e) {
    console.error('posts api error', e);
    const notReady = String(e && e.message) === 'redis_not_configured';
    return send(res, notReady ? 503 : 500, { error: notReady ? 'not_ready' : 'server', message: notReady ? '게시판을 준비하고 있어요. 조금 뒤에 다시 와 주세요.' : '잠시 문제가 생겼어요. 조금 뒤에 다시 시도해 주세요.' });
  }
}
