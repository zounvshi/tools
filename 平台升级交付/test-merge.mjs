// 合并读取逻辑的实测脚本（Node ESM，无需外部依赖）。
// 验证：① GitHub 原始 + R2 新增 的合并；② 审批后实时可见；③ GitHub 宕机时缓存兜底；④ 权限拦截。
import { signToken } from './functions/api/_shared/auth.js';
import { onRequest as toolsOnRequest } from './functions/api/tools.js';
import { onRequest as adminOnRequest } from './functions/api/admin.js';
import { onRequest as submitOnRequest } from './functions/api/submit.js';

const SECRET = 'test-secret';

// ---------- Mock R2 桶（支持 ETag 乐观锁）----------
function makeBucket(initial = {}) {
  const store = new Map();
  for (const [k, v] of Object.entries(initial)) store.set(k, { text: v, etag: 'e' + Math.random().toString(36).slice(2) });
  return {
    async get(key) { const o = store.get(key); if (!o) return null; return { text: async () => o.text, etag: o.etag }; },
    async put(key, text, opts = {}) {
      const existing = store.get(key);
      if (opts.onlyIf) {
        if (opts.onlyIf.etagMatches) { if (!existing || existing.etag !== opts.onlyIf.etagMatches) return null; }
        if (opts.onlyIf.etagDoesNotMatch === '*') { if (existing) return null; }
      }
      const etag = 'e' + Math.random().toString(36).slice(2);
      store.set(key, { text: typeof text === 'string' ? text : String(text), etag });
      return { etag };
    },
    async delete(key) { store.delete(key); return {}; },
    _store: store,
  };
}

// ---------- Mock fetch ----------
let fetchImpl;
globalThis.fetch = (...args) => fetchImpl(...args);

function makeReq(method, body, token, opts = {}) {
  return {
    method,
    url: opts.url || 'https://x.example/api',
    headers: {
      get: (k) => {
        const lk = String(k).toLowerCase();
        if (lk === 'authorization') return token ? 'Bearer ' + token : '';
        if (lk === 'content-type') return opts.contentType || 'application/json';
        return null;
      },
      set: () => {},
    },
    json: async () => body,
    formData: async () => opts.formData || new Map(),
  };
}

const BASE = {
  about: '原·关于我们',
  tools: Array.from({ length: 8 }, (_, i) => ({
    id: i + 1, name: '原工具' + (i + 1), type: i % 2 ? 'html' : 'exe',
    url: 'https://gh/' + (i + 1), desc: 'd', status: 'approved',
  })),
};

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.error('  ✗ ' + msg); } }

const adminToken = await signToken({ sub: 'liyt1', role: 'admin', exp: Date.now() / 1000 + 3600 }, SECRET);
const userToken = await signToken({ sub: 'u2', role: 'user', exp: Date.now() / 1000 + 3600 }, SECRET);

// ===== 1) 仅有 GitHub 原始，无 R2 新增 =====
console.log('\n[1] 仅 GitHub 原始数据（R2 为空）');
{
  const bucket = makeBucket();
  fetchImpl = async () => ({ ok: true, status: 200, json: async () => BASE });
  const resp = await toolsOnRequest({ env: { TOOLS_BUCKET: bucket, MIGRATE_SOURCE_URL: 'https://gh/base', AUTH_SECRET: SECRET } });
  const data = await resp.json();
  assert(data.tools.length === 8, '返回 8 个工具');
  assert(data.tools.every(t => t.source === 'github'), '全部标记为 source=github');
  assert(data.about === '原·关于我们', 'about 来自 GitHub');
  assert(bucket._store.has('data/base.json'), '已把原始数据缓存到 R2 base.json');
}

// ===== 2) GitHub 原始 + R2 新增 合并 =====
console.log('\n[2] GitHub 原始 + R2 新增 合并');
{
  const bucket = makeBucket({ 'data/tools.json': JSON.stringify({ about: '', tools: [{ id: 100, name: '新增工具', type: 'html', url: 'https://new', status: 'approved' }] }) });
  fetchImpl = async () => ({ ok: true, status: 200, json: async () => BASE });
  const resp = await toolsOnRequest({ env: { TOOLS_BUCKET: bucket, MIGRATE_SOURCE_URL: 'https://gh/base', AUTH_SECRET: SECRET } });
  const data = await resp.json();
  assert(data.tools.length === 9, '8 原始 + 1 新增 = 9');
  const r2 = data.tools.find(t => t.id === 100);
  assert(r2 && r2.source === 'r2', '新增工具 source=r2');
  assert(data.tools.filter(t => t.source === 'github').length === 8, '原始仍为 8 个');
}

// ===== 3) 审批流程：提交→待审→通过→可见 =====
console.log('\n[3] 审批后实时可见');
{
  const bucket = makeBucket({ 'data/pending.json': JSON.stringify([{ id: 200, name: '待审工具', type: 'exe', url: 'https://y', status: 'pending', submittedBy: 'u2' }]) });
  fetchImpl = async () => ({ ok: true, status: 200, json: async () => BASE });
  // 管理员通过
  const areq = makeReq('POST', { action: 'approve', id: 200 }, adminToken, { url: 'https://x/api/admin' });
  const aresp = await adminOnRequest({ request: areq, env: { TOOLS_BUCKET: bucket, AUTH_SECRET: SECRET } });
  const ad = await aresp.json();
  assert(ad.success === true, 'approve 成功');
  // 再次读取
  const resp = await toolsOnRequest({ env: { TOOLS_BUCKET: bucket, MIGRATE_SOURCE_URL: 'https://gh/base', AUTH_SECRET: SECRET } });
  const data = await resp.json();
  const seen = data.tools.find(t => t.id === 200);
  assert(!!seen && seen.source === 'r2', '通过后的工具出现在公开列表（source=r2）');
  assert(data.tools.length === 9, '总数 8+1=9');
  // 待审应为空
  const pendRaw = bucket._store.get('data/pending.json');
  const pend = pendRaw ? JSON.parse(pendRaw.text) : [];
  assert(Array.isArray(pend) && pend.length === 0, 'pending 已清空');
}

// ===== 4) GitHub 宕机 → 用缓存兜底 =====
console.log('\n[4] GitHub 宕机时用 R2 缓存兜底');
{
  const bucket = makeBucket();
  fetchImpl = async () => ({ ok: true, status: 200, json: async () => BASE });
  await toolsOnRequest({ env: { TOOLS_BUCKET: bucket, MIGRATE_SOURCE_URL: 'https://gh/base', AUTH_SECRET: SECRET } }); // 先缓存
  fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const resp = await toolsOnRequest({ env: { TOOLS_BUCKET: bucket, MIGRATE_SOURCE_URL: 'https://gh/base', AUTH_SECRET: SECRET } });
  const data = await resp.json();
  assert(data.tools.length === 8 && data.tools.every(t => t.source === 'github'), '宕机时仍返回 8 个原始工具（读缓存）');
}

// ===== 5) GitHub 宕机且无缓存 → 至少返回 R2 新增 =====
console.log('\n[5] GitHub 宕机且首次无缓存 → 仅返回 R2 新增');
{
  const bucket = makeBucket({ 'data/tools.json': JSON.stringify({ about: '', tools: [{ id: 300, name: '仅R2', type: 'html', url: 'x', status: 'approved' }] }) });
  fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const resp = await toolsOnRequest({ env: { TOOLS_BUCKET: bucket, MIGRATE_SOURCE_URL: 'https://gh/base', AUTH_SECRET: SECRET } });
  const data = await resp.json();
  assert(data.tools.length === 1 && data.tools[0].source === 'r2', '返回 1 个 R2 新增，不崩');
}

// ===== 6) 越权拦截：普通用户不能审批 =====
console.log('\n[6] 权限拦截');
{
  const bucket = makeBucket({ 'data/pending.json': JSON.stringify([{ id: 1, name: 'x', type: 'html', url: 'x', status: 'pending' }]) });
  fetchImpl = async () => ({ ok: true, status: 200, json: async () => BASE });
  const areq = makeReq('POST', { action: 'approve', id: 1 }, userToken, { url: 'https://x/api/admin' });
  const aresp = await adminOnRequest({ request: areq, env: { TOOLS_BUCKET: bucket, AUTH_SECRET: SECRET } });
  assert(aresp.status === 403, '普通用户审批返回 403');
}

// ===== 7) 普通用户提交 → 进入 pending =====
console.log('\n[7] 普通用户提交进入待审');
{
  const bucket = makeBucket();
  fetchImpl = async () => ({ ok: true, status: 200, json: async () => BASE });
  const sreq = makeReq('POST', { tool: { name: '提交测试', desc: 'd', type: 'html', url: 'https://z' } }, userToken, { url: 'https://x/api/submit' });
  const sresp = await submitOnRequest({ request: sreq, env: { TOOLS_BUCKET: bucket, AUTH_SECRET: SECRET } });
  const sd = await sresp.json();
  assert(sd.success && sd.status === 'pending', '提交成功且状态为 pending');
  const pendRaw = bucket._store.get('data/pending.json');
  const pend = pendRaw ? JSON.parse(pendRaw.text) : [];
  assert(pend.length === 1 && pend[0].name === '提交测试', '已进入 pending.json');
}

console.log(`\n==== 结果：${pass} 通过 / ${fail} 失败 ====`);
process.exit(fail === 0 ? 0 : 1);
