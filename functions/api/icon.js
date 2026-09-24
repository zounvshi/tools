// functions/api/icon.js
// 图标服务（解决「新工具没有图标」问题）：
//   GET  /api/icon?url=<网页地址>            -> 直接返回图标图片二进制（前端 <img> 可直接用，无需登录）
//   POST /api/icon      { url }              -> 服务端抓取该站 favicon 并存入 R2，返回 { icon:"/api/icon/site/xxx.png" }
//   POST /api/icon      multipart iconFile   -> 上传本地图标图片（png/jpg/svg/webp/ico），返回 { icon:"/api/icon/upload/xxx.png" }
//
// 设计要点：
//   1) 抓取动作发生在 Cloudflare 边缘（境外出口），不受国内网络限制；
//   2) 抓到的图标落 R2，之后通过本站域名 /api/icon/<key> 返回，国内可稳定加载，且目标站改版不影响；
//   3) 同一网址只抓一次（按 URL 哈希做 key，命中即复用）；
//   4) 仅 http/https 公网地址，拦截 localhost / 内网网段，避免被当成 SSRF 代理。
import { requireRole, json } from './_shared/auth.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';
const SITE_PREFIX = 'icons/site/';    // 自动抓取的图标
const UP_PREFIX = 'icons/upload/';    // 手动上传的图标
const MAX_ICON_BYTES = 1024 * 1024;   // 单图标 1MB

function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function extOf(ct) {
  const t = (ct || '').toLowerCase();
  if (t.includes('svg')) return 'svg';
  if (t.includes('png')) return 'png';
  if (t.includes('jpeg') || t.includes('jpg')) return 'jpg';
  if (t.includes('webp')) return 'webp';
  if (t.includes('gif')) return 'gif';
  if (t.includes('x-icon') || t.includes('vnd.microsoft.icon') || t.includes('ico')) return 'ico';
  return '';
}

// 仅允许公网 http/https；拦截本机与内网网段
function safeUrl(raw) {
  let u;
  try { u = new URL(String(raw || '')); } catch (e) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const h = u.hostname.toLowerCase();
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '[::1]') return null;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    if (a === 10 || a === 127 || a === 0) return null;
    if (a === 192 && b === 168) return null;
    if (a === 172 && b >= 16 && b <= 31) return null;
    if (a === 169 && b === 254) return null;
  }
  return u;
}

function imgResp(body, ct, cacheSeconds) {
  return new Response(body, {
    headers: {
      'Content-Type': ct || 'image/png',
      'Cache-Control': 'public, max-age=' + (cacheSeconds || 604800),
      'Access-Control-Allow-Origin': '*',
    },
  });
}

// 下载一张候选图标；非图片 / 过大 / 过小(占位像素) 均视为失败
async function fetchImg(url, ms = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': UA, 'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const ct = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!ct.startsWith('image/')) return null;
    const buf = await res.arrayBuffer();
    if (!buf || buf.byteLength === 0 || buf.byteLength > MAX_ICON_BYTES) return null;
    if (buf.byteLength < 64 && !ct.includes('svg')) return null;
    return { buf, ct };
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 解析页面里的 <link rel="icon|apple-touch-icon...">，按 sizes 从大到小排，末尾兜底 /favicon.ico
async function collectCandidates(pageUrl) {
  const u = safeUrl(pageUrl);
  if (!u) return [];
  const list = [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(u.href, {
      redirect: 'follow',
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8' },
      signal: ctrl.signal,
    });
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (res.ok && ct.includes('html')) {
      const html = await res.text();
      const re = /<link\b[^>]*>/gi;
      let m;
      while ((m = re.exec(html))) {
        const tag = m[0];
        const relM = /\brel\s*=\s*["']?([^"'>]+)["']?/i.exec(tag);
        if (!relM) continue;
        const rel = relM[1].toLowerCase().replace(/\s+/g, ' ').trim();
        if (!/(^| )(icon|shortcut icon|apple-touch-icon|apple-touch-icon-precomposed|mask-icon)( |$)/.test(rel)) continue;
        const hrefM = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag);
        if (!hrefM) continue;
        const szM = /\bsizes\s*=\s*["'](\d+)\s*x\s*(\d+)/i.exec(tag);
        let abs;
        try { abs = new URL(hrefM[1], res.url || u.href).href; } catch (e) { continue; }
        const cand = safeUrl(abs);
        if (!cand) continue;
        list.push({ url: cand.href, size: szM ? Number(szM[1]) : 0 });
      }
    }
  } catch (e) { /* 页面取不到就靠 /favicon.ico 兜底 */ }
  finally { clearTimeout(timer); }

  list.sort((a, b) => b.size - a.size);
  list.push({ url: u.origin + '/favicon.ico', size: -1 });
  const seen = new Set();
  return list.filter((x) => (seen.has(x.url) ? false : (seen.add(x.url), true)));
}

async function grabIcon(pageUrl) {
  const cands = await collectCandidates(pageUrl);
  for (const c of cands.slice(0, 6)) {
    const got = await fetchImg(c.url);
    if (got) return got;
  }
  return null;
}

// 已缓存则返回 R2 对象 key，否则 null
async function findCached(env, pageUrl) {
  const listed = await env.TOOLS_BUCKET.list({ prefix: SITE_PREFIX + hashStr(pageUrl) });
  if (listed && listed.objects && listed.objects.length) return listed.objects[0].key;
  return null;
}

// ---------- GET：直接吐图片（供 <img src> 用，公开读） ----------
export async function onRequestGet(context) {
  const { request, env } = context;
  const target = safeUrl(new URL(request.url).searchParams.get('url') || '');
  if (!target) return new Response('Bad url', { status: 400 });
  if (!env.TOOLS_BUCKET) return new Response('R2 未绑定（TOOLS_BUCKET）', { status: 500 });

  const cachedKey = await findCached(env, target.href);
  if (cachedKey) {
    const obj = await env.TOOLS_BUCKET.get(cachedKey);
    if (obj) return imgResp(obj.body, obj.httpMetadata && obj.httpMetadata.contentType, 604800);
  }

  const got = await grabIcon(target.href);
  if (!got) return new Response('Icon not found', { status: 404 });
  const key = SITE_PREFIX + hashStr(target.href) + '.' + (extOf(got.ct) || 'png');
  await env.TOOLS_BUCKET.put(key, got.buf, { httpMetadata: { contentType: got.ct } });
  return imgResp(got.buf, got.ct, 604800);
}

// ---------- POST：抓取并固化 / 上传本地图片（需登录） ----------
export async function onRequestPost(context) {
  const { request, env } = context;
  const payload = await requireRole(request, env, 'user');
  if (!payload) return json({ error: '请先登录' }, 401);
  if (!env.TOOLS_BUCKET) return json({ error: '服务端未绑定 R2 存储桶（TOOLS_BUCKET）' }, 500);

  const ct = request.headers.get('content-type') || '';

  // 1) 上传本地图标图片
  if (ct.includes('multipart/form-data')) {
    const fd = await request.formData();
    const f = fd.get('iconFile');
    if (!f || !f.size) return json({ error: '未收到图标文件' }, 400);
    if (f.size > MAX_ICON_BYTES) return json({ error: '图标过大，请控制在 1MB 以内' }, 413);
    const ict = (f.type || '').toLowerCase();
    if (!ict.startsWith('image/')) return json({ error: '图标必须是图片文件（png / jpg / svg / webp / ico）' }, 400);
    const safeName = String(f.name || 'icon').replace(/[^\w.\-一-龥]/g, '_').slice(-40);
    const key = UP_PREFIX + Date.now().toString(36) + '-' + hashStr(safeName + f.size) + '.' + (extOf(ict) || 'png');
    try {
      await env.TOOLS_BUCKET.put(key, f.stream(), { httpMetadata: { contentType: ict } });
    } catch (e) {
      return json({ error: '图标存入 R2 失败：' + (e && e.message ? e.message : e) }, 500);
    }
    return json({ success: true, icon: '/api/icon/' + key.slice('icons/'.length) });
  }

  // 2) 按网址自动抓取
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: '请求格式错误' }, 400); }
  const target = safeUrl(body.url || '');
  if (!target) return json({ error: '网址无效或不允许（仅支持 http/https 公网地址）' }, 400);

  const cachedKey = await findCached(env, target.href);
  if (cachedKey) return json({ success: true, icon: '/api/icon/' + cachedKey.slice('icons/'.length), cached: true });

  const got = await grabIcon(target.href);
  if (!got) return json({ error: '未能自动获取该站点图标，请手动上传图片或填写图片地址' }, 404);
  const key = SITE_PREFIX + hashStr(target.href) + '.' + (extOf(got.ct) || 'png');
  try {
    await env.TOOLS_BUCKET.put(key, got.buf, { httpMetadata: { contentType: got.ct } });
  } catch (e) {
    return json({ error: '图标存入 R2 失败：' + (e && e.message ? e.message : e) }, 500);
  }
  return json({ success: true, icon: '/api/icon/' + key.slice('icons/'.length) });
}
