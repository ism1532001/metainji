// 메타인지 방문·공유 통계 API (Vercel Function + Upstash Redis)
// POST /api/stats  {e:'visit'|..., src?}   이벤트 1건 세기 (사이트가 보냄)
// GET  /api/stats?days=30                   날짜별·전체 합계 (통계 페이지가 읽음)
// 날짜별 합계는 st:d:<한국 날짜> 해시, 전체 합계는 st:total 해시에 있어요. 개인정보는 저장하지 않아요.
const EVENTS = new Set(['visit', 'new_visitor', 'verdict_marry', 'verdict_date', 'share_dialog', 'share_native', 'share_save', 'share_copy', 'shared_open', 'board_view']);
const SOURCES = new Set(['instagram', 'naver', 'kakao', 'google', 'friend', 'direct', 'other']);
const ORIGIN_RE = /^(https:\/\/metainji(-[a-z0-9-]+)?\.vercel\.app|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/;
const BOT_RE = /bot|crawl|spider|slurp|preview|facebookexternalhit|kakaotalk-scrap|headless|lighthouse/i;
const kstDay = (t = Date.now()) => new Date(t + 9 * 3600e3).toISOString().slice(0, 10);

async function redis(cmds) {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('redis_not_configured');
  const r = await fetch(`${url.replace(/\/$/, '')}/pipeline`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cmds) });
  if (!r.ok) throw new Error('redis_http_' + r.status);
  const out = await r.json();
  return out.map(x => { if (x && x.error) throw new Error('redis: ' + x.error); return x ? x.result : null; });
}

function send(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(body === null ? '' : JSON.stringify(body));
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  let raw = typeof req.body === 'string' ? req.body : Buffer.isBuffer(req.body) ? req.body.toString('utf8') : null;
  if (raw === null) {
    raw = '';
    for await (const chunk of req) { raw += chunk; if (raw.length > 2000) throw new Error('too_big'); }
  }
  if (raw.length > 2000) throw new Error('too_big');
  return raw ? JSON.parse(raw) : {};
}

const toObj = arr => {
  const o = {};
  if (Array.isArray(arr)) for (let i = 0; i + 1 < arr.length; i += 2) o[arr[i]] = Number(arr[i + 1]) || 0;
  else if (arr && typeof arr === 'object') for (const [k, v] of Object.entries(arr)) o[k] = Number(v) || 0;
  return o;
};

export default async function handler(req, res) {
  try {
    if (req.method === 'POST') {
      const origin = req.headers.origin;
      if (origin && !ORIGIN_RE.test(origin)) return send(res, 403, { error: 'origin' });
      if (BOT_RE.test(req.headers['user-agent'] || '')) return send(res, 204, null);
      let body;
      try { body = await readBody(req); } catch { return send(res, 400, { error: 'body' }); }
      const e = body && body.e;
      if (!EVENTS.has(e)) return send(res, 400, { error: 'event' });
      const day = `st:d:${kstDay()}`;
      const cmds = [['HINCRBY', day, e, '1'], ['HINCRBY', 'st:total', e, '1']];
      if (e === 'visit' && SOURCES.has(body.src)) cmds.push(['HINCRBY', day, `src_${body.src}`, '1'], ['HINCRBY', 'st:total', `src_${body.src}`, '1']);
      cmds.push(['EXPIRE', day, String(400 * 86400)]);
      await redis(cmds);
      return send(res, 204, null);
    }
    if (req.method !== 'GET') return send(res, 405, { error: 'method' });
    const url = new URL(req.url, 'http://x');
    const n = Math.min(90, Math.max(1, parseInt(url.searchParams.get('days') || '30', 10) || 30));
    const days = Array.from({ length: n }, (_, i) => kstDay(Date.now() - i * 86400e3));
    const out = await redis([...days.map(d => ['HGETALL', `st:d:${d}`]), ['HGETALL', 'st:total'], ['ZCARD', 'pz:all']]);
    send(res, 200, { days: days.map((d, i) => ({ d, c: toObj(out[i]) })), total: toObj(out[n]), posts: Number(out[n + 1]) || 0, today: days[0] });
  } catch (e) {
    console.error('stats api error', e);
    const notReady = String(e && e.message) === 'redis_not_configured';
    return send(res, notReady ? 503 : 500, { error: notReady ? 'not_ready' : 'server' });
  }
}
