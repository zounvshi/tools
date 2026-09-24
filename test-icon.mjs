// test-icon.mjs
// 图标功能全链路测试（真实网络抓取 + 内存版 R2）：
//   1) GET  ?url= 自动抓取 favicon 并返回图片
//   2) 同一网址第二次走 R2 缓存
//   3) 非法/内网地址被拦截（防 SSRF）
//   4) POST { url } 抓取并固化，返回 /api/icon/site/...
//   5) POST multipart 上传本地图片，返回 /api/icon/upload/...
//   6) GET /api/icon/site/<key> 能读回图片；越界 key 被拒
//   7) submit.js 带 iconFile 提交 → icon 字段被写成 /api/icon/upload/...
//   8) admin.js seticon 能改图标；对 GitHub 只读工具返回 404
// 运行：node test-icon.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const API = path.join(here, 'functions', 'api');

let pass = 0, fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + (extra ? '  → ' + extra : '')); }
}

// ---------- 内存版 R2 ----------
class MemR2 {
  constructor() { this.map = new Map(); this.n = 0; }
  async put(key, value, opts) {
    let bytes;
    if (typeof value === 'string') bytes = Buffer.from(value);
    else if (value instanceof ArrayBuffer) bytes = Buffer.from(new Uint8Array(value));
    else if (ArrayBuffer.isView(value)) bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    else if (value && typeof value.arrayBuffer === 'function') bytes = Buffer.from(new Uint8Array(await value.arrayBuffer()));
    else if (value && typeof value.stream === 'function') {
      const res = new Response(value.stream());
      bytes = Buffer.from(new Uint8Array(await res.arrayBuffer()));
    } else bytes = Buffer.from(String(value));
    this.map.set(key, { body: bytes, httpMetadata: (opts && opts.httpMetadata) || null });
    this.n++;
    return { key, etag: 'etag' + this.n };
  }
  async get(key) {
    const o = this.map.get(key);
    if (!o) return null;
    return {
      body: new Blob([o.body]).stream(),
      httpMetadata: o.httpMetadata,
      async arrayBuffer() { return o.body.buffer.slice(o.body.byteOffset, o.body.byteOffset + o.body.byteLength); },
      async text() { return o.body.toString('utf8'); },
    };
  }
  async delete(key) { this.map.delete(key); }
  async list(opts) {
    const p = (opts && opts.prefix) || '';
    return { objects: [...this.map.keys()].filter((k) => k.startsWith(p)).map((k) => ({ key: k })) };
  }
}

// ---------- 把 auth.js 换成可控 stub，以便测试需登录分支 ----------
const AUTH_STUB = `
const requireRole = async (request, env, role) => {
  const p = globalThis.__TEST_PAYLOAD__;
  if (!p) return null;
  if (role === 'admin' && p.role !== 'admin') return null;
  return p;
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
`;
async function loadModule(relFile, tmpName) {
  const src = fs.readFileSync(path.join(API, relFile), 'utf8');
  const patched = src.replace(/^import \{ requireRole, json \} from '\.\/_shared\/auth\.js';$/m, AUTH_STUB);
  if (patched === src) throw new Error('auth 导入未被替换，请检查 import 语句：' + relFile);
  const tmp = path.join(API, tmpName);
  fs.writeFileSync(tmp, patched, 'utf8');
  const mod = await import('file:///' + tmp.replace(/\\/g, '/'));
  return { mod, tmp };
}

const TARGET = 'https://tools-2ks.pages.dev/';   // 已知可达、且页面含 <link rel="icon">
const env = () => ({ TOOLS_BUCKET: new MemR2() });

console.log('\n=== 1. 图标服务 icon.js ===');
const { mod: iconMod, tmp: tmpIcon } = await loadModule('icon.js', '__test_icon.mjs');
// 读取模块不依赖 auth，直接加载
const readMod = await import(pathToFileURL(path.join(API, 'icon', '[[path]].js')).href);

{
  const e = env();
  const res = await iconMod.onRequestGet({ request: new Request('https://x/api/icon?url=' + encodeURIComponent(TARGET)), env: e });
  ok(res.status === 200, `GET 抓取真实站点图标 → HTTP ${res.status}`, '目标：' + TARGET);
  const ct = res.headers.get('content-type') || '';
  ok(ct.startsWith('image/'), '返回内容是图片：' + ct);
  const buf = Buffer.from(new Uint8Array(await res.arrayBuffer()));
  ok(buf.length > 100, '图片字节数 = ' + buf.length);
  const cached = [...e.TOOLS_BUCKET.map.keys()].filter((k) => k.startsWith('icons/site/'));
  ok(cached.length === 1, '抓取结果已落 R2：' + cached.join(','));

  // 缓存命中（第二次不再回源）
  const before = e.TOOLS_BUCKET.n;
  const res2 = await iconMod.onRequestGet({ request: new Request('https://x/api/icon?url=' + encodeURIComponent(TARGET)), env: e });
  ok(res2.status === 200 && e.TOOLS_BUCKET.n === before, '第二次命中 R2 缓存，未重复写入');
}

{
  const e = env();
  const bad = new Request('https://x/api/icon?url=not-a-url');
  ok((await iconMod.onRequestGet({ request: bad, env: e })).status === 400, '非法网址 → 400');
  const inner = new Request('https://x/api/icon?url=' + encodeURIComponent('http://127.0.0.1/favicon.ico'));
  ok((await iconMod.onRequestGet({ request: inner, env: e })).status === 400, '内网地址 → 400（防 SSRF）');
  const priv = new Request('https://x/api/icon?url=' + encodeURIComponent('http://192.168.1.1/favicon.ico'));
  ok((await iconMod.onRequestGet({ request: priv, env: e })).status === 400, '私有网段 → 400（防 SSRF）');
  const file = new Request('https://x/api/icon?url=' + encodeURIComponent('file:///etc/passwd'));
  ok((await iconMod.onRequestGet({ request: file, env: e })).status === 400, 'file:// 协议 → 400');
}

{
  // POST 需登录
  globalThis.__TEST_PAYLOAD__ = null;
  const e = env();
  const res = await iconMod.onRequestPost({ request: new Request('https://x/api/icon', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: TARGET }) }), env: e });
  ok(res.status === 401, 'POST 未登录 → 401');

  globalThis.__TEST_PAYLOAD__ = { sub: 'tester', role: 'user' };
  const res2 = await iconMod.onRequestPost({ request: new Request('https://x/api/icon', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: TARGET }) }), env: e });
  const d2 = await res2.json();
  ok(res2.status === 200 && d2.icon && d2.icon.startsWith('/api/icon/site/'), 'POST 抓取成功 → ' + (d2.icon || JSON.stringify(d2)));

  const res3 = await iconMod.onRequestPost({ request: new Request('https://x/api/icon', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: TARGET }) }), env: e });
  const d3 = await res3.json();
  ok(d3.cached === true && d3.icon === d2.icon, 'POST 同网址复用缓存(cached=true)');

  // 上传本地图片
  const pngBase = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const fd = new FormData();
  fd.append('iconFile', new File([Buffer.from(pngBase, 'base64')], 'my-icon.png', { type: 'image/png' }));
  const res4 = await iconMod.onRequestPost({ request: new Request('https://x/api/icon', { method: 'POST', body: fd }), env: e });
  const d4 = await res4.json();
  ok(res4.status === 200 && d4.icon && d4.icon.startsWith('/api/icon/upload/'), 'POST 上传本地图片 → ' + (d4.icon || JSON.stringify(d4)));

  // 上传非图片
  const fd2 = new FormData();
  fd2.append('iconFile', new File(['hello'], 'a.txt', { type: 'text/plain' }));
  const res5 = await iconMod.onRequestPost({ request: new Request('https://x/api/icon', { method: 'POST', body: fd2 }), env: e });
  ok(res5.status === 400, '上传非图片文件 → 400');
}

console.log('\n=== 2. 图标读取 icon/[[path]].js ===');
{
  const e = env();
  await e.TOOLS_BUCKET.put('icons/site/abc.png', Buffer.from([1, 2, 3, 4]), { httpMetadata: { contentType: 'image/png' } });
  const res = await readMod.onRequestGet({ env: e, params: { path: ['site', 'abc.png'] } });
  ok(res.status === 200 && (res.headers.get('content-type') || '').includes('image/png'), 'GET /api/icon/site/abc.png → 200 图片');
  const bad1 = await readMod.onRequestGet({ env: e, params: { path: ['..', '..', 'data', 'tools.json'] } });
  ok(bad1.status === 400, '越界 key(../) → 400');
  const bad2 = await readMod.onRequestGet({ env: e, params: { path: ['data', 'tools.json'] } });
  ok(bad2.status === 400, '非图标前缀 key → 400（不能读数据文件）');
  const nf = await readMod.onRequestGet({ env: e, params: { path: ['site', 'nope.png'] } });
  ok(nf.status === 404, '不存在 → 404');
}

console.log('\n=== 3. submit.js 带图标文件提交 ===');
const { mod: submitMod, tmp: tmpSubmit } = await loadModule('submit.js', '__test_submit.mjs');
{
  globalThis.__TEST_PAYLOAD__ = { sub: 'tester', role: 'admin' };
  const e = env();
  const fd = new FormData();
  fd.append('name', '测试工具');
  fd.append('desc', '用来验证图标上传');
  fd.append('type', 'html');
  fd.append('url', TARGET);
  fd.append('iconFile', new File([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')], 'icon.png', { type: 'image/png' }));
  const res = await submitMod.onRequest({ request: new Request('https://x/api/submit', { method: 'POST', body: fd }), env: e });
  const d = await res.json();
  ok(res.status === 200 && d.success, '管理员带 iconFile 提交成功');
  const saved = JSON.parse((await e.TOOLS_BUCKET.get('data/tools.json')).body ? Buffer.from(new Uint8Array(await (await e.TOOLS_BUCKET.get('data/tools.json')).arrayBuffer())).toString('utf8') : '{}');
  const t = (saved.tools || [])[0] || {};
  ok(String(t.icon || '').startsWith('/api/icon/upload/'), 'icon 字段已写入 = ' + t.icon);
  ok(!!t.iconKey, 'iconKey 已记录（删除时可回收）= ' + t.iconKey);
  globalThis.__TOOL_ID__ = t.id;
  globalThis.__ENV__ = e;
}

console.log('\n=== 4. admin.js seticon 改图标 ===');
const { mod: adminMod, tmp: tmpAdmin } = await loadModule('admin.js', '__test_admin.mjs');
{
  globalThis.__TEST_PAYLOAD__ = { sub: 'liyt1', role: 'admin' };
  const e = globalThis.__ENV__;
  const post = (body) => new Request('https://x/api/admin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  const r1 = await adminMod.onRequest({ request: post({ action: 'seticon', id: globalThis.__TOOL_ID__, icon: '/api/icon/site/zzz.png' }), env: e });
  const d1 = await r1.json();
  ok(r1.status === 200 && d1.success, 'seticon 保存成功');
  const saved = JSON.parse(Buffer.from(new Uint8Array(await (await e.TOOLS_BUCKET.get('data/tools.json')).arrayBuffer())).toString('utf8'));
  ok(saved.tools[0].icon === '/api/icon/site/zzz.png', '图标已更新为 ' + saved.tools[0].icon);

  const r2 = await adminMod.onRequest({ request: post({ action: 'seticon', id: 999999999, icon: '/api/icon/site/x.png' }), env: e });
  ok(r2.status === 404, '给不存在的(GitHub只读)工具改图标 → 404');

  globalThis.__TEST_PAYLOAD__ = { sub: 'someone', role: 'user' };
  const r3 = await adminMod.onRequest({ request: post({ action: 'seticon', id: globalThis.__TOOL_ID__, icon: '/api/icon/site/hack.png' }), env: e });
  ok(r3.status === 403, '普通用户改图标 → 403');
}

for (const t of [tmpIcon, tmpSubmit, tmpAdmin]) { try { fs.unlinkSync(t); } catch (_) {} }

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====\n`);
process.exit(fail ? 1 : 0);
