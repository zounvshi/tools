// 编辑工具（admin.js edit action）的实测脚本（Node ESM，无需外部依赖）。
// 覆盖：基本字段编辑 / 权限 / GitHub 只读拦截 / 替换文件并回收旧文件 / 替换图标 / 参数校验 / 兜底。
import { signToken } from './functions/api/_shared/auth.js';
import { onRequest as adminOnRequest } from './functions/api/admin.js';

const SECRET = 'test-secret';

// ---------- Mock R2 桶（支持 ETag 乐观锁，并记录每次 put 的原始值）----------
function makeBucket(initial = {}) {
  const store = new Map();
  for (const [k, v] of Object.entries(initial)) store.set(k, { value: v, etag: 'e' + Math.random().toString(36).slice(2) });
  const putLog = [];
  const delLog = [];
  const bucket = {
    async get(key) { const o = store.get(key); if (!o) return null; return { text: async () => String(o.value), etag: o.etag }; },
    async put(key, value, opts = {}) {
      const existing = store.get(key);
      if (opts.onlyIf) {
        if (opts.onlyIf.etagMatches) { if (!existing || existing.etag !== opts.onlyIf.etagMatches) return null; }
        if (opts.onlyIf.etagDoesNotMatch === '*') { if (existing) return null; }
      }
      const etag = 'e' + Math.random().toString(36).slice(2);
      store.set(key, { value, etag });
      putLog.push({ key, value });
      return { etag };
    },
    async delete(key) { store.delete(key); delLog.push(key); return {}; },
    _store: store, _putLog: putLog, _delLog: delLog,
    json(key) { const o = store.get(key); return o ? JSON.parse(String(o.value)) : null; },
    has(key) { return store.has(key); },
  };
  return bucket;
}

// ---------- Mock File（模拟 multipart 里的文件）----------
function fakeFile(name, size, type) {
  return { name, size, type, stream: () => ({ __stream: name }) };
}

function makeReq(method, body, token, opts = {}) {
  return {
    method,
    url: opts.url || 'https://x.example/api/admin',
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

function fdOf(entries) { return new Map(entries); }

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.error('  ✗ ' + msg); } }

const adminToken = await signToken({ sub: 'liyt1', role: 'admin', exp: Date.now() / 1000 + 3600 }, SECRET);
const userToken = await signToken({ sub: 'u2', role: 'user', exp: Date.now() / 1000 + 3600 }, SECRET);

// 初始：R2 里有一条新增已审工具 + 一条待审（edit 不该碰到 pending）
function freshTools() {
  return JSON.stringify({
    about: '关于我们原文',
    tools: [
      { id: 100, name: '旧名称', desc: '旧描述', type: 'html', tags: ['旧标签'], url: 'https://old.example', icon: '/api/icon/x.png', iconKey: 'icons/upload/old.png', author: '@旧作者', guide: '使用说明原文', fileKey: 'tools/old.exe', fileUrl: 'https://r2/tools/old.exe', fileName: 'old.exe', fileSize: 1024, storage: 'r2', status: 'approved' },
      { id: 101, name: '别的工具', desc: 'd', type: 'exe', tags: [], url: 'https://b.example', status: 'approved' },
    ],
  });
}

// ===== 1) 纯 JSON 编辑基本字段 =====
console.log('\n[1] JSON 编辑：名称/描述/类型/标签/作者/网址');
{
  const bucket = makeBucket({ 'data/tools.json': freshTools() });
  const req = makeReq('POST', { action: 'edit', id: 100, name: '新名称', desc: '新描述', type: 'exe', tags: '甲, 乙，丙', author: '@新作者', url: 'https://new.example' }, adminToken);
  const res = await adminOnRequest({ request: req, env: { TOOLS_BUCKET: bucket, AUTH_SECRET: SECRET } });
  const d = await res.json();
  assert(res.status === 200 && d.success, '编辑成功返回 200');
  const t = bucket.json('data/tools.json').tools.find((x) => x.id === 100);
  assert(t.name === '新名称' && t.desc === '新描述', '名称与描述已更新');
  assert(t.type === 'exe', '类型已更新');
  assert(JSON.stringify(t.tags) === JSON.stringify(['甲', '乙', '丙']), '中英文逗号混排的标签被正确切分');
  assert(t.author === '@新作者', '作者已更新');
  assert(t.url === 'https://new.example', '网址已更新');
  assert(t.guide === '使用说明原文', '未传的 guide 保持原样（不被清空）');
  assert(t.fileUrl === 'https://r2/tools/old.exe', '未上传新文件时，原程序包保持不变');
  assert(t.updatedBy === 'liyt1' && !!t.updatedAt, '记录了修改人与修改时间');
  assert(bucket.json('data/tools.json').about === '关于我们原文', 'about 未被影响');
  assert(bucket.json('data/tools.json').tools.length === 2, '工具总数不变');
  assert(bucket.json('data/tools.json').tools.find((x) => x.id === 101).name === '别的工具', '其他工具未被误改');
  assert(bucket._delLog.length === 0, '未替换资源时不误删任何文件');
}

// ===== 2) 权限：普通用户不能编辑 =====
console.log('\n[2] 权限拦截');
{
  const bucket = makeBucket({ 'data/tools.json': freshTools() });
  const req = makeReq('POST', { action: 'edit', id: 100, name: 'x', desc: 'y', type: 'html', url: 'z' }, userToken);
  const res = await adminOnRequest({ request: req, env: { TOOLS_BUCKET: bucket, AUTH_SECRET: SECRET } });
  assert(res.status === 403, '普通用户编辑返回 403');
  const t = bucket.json('data/tools.json').tools.find((x) => x.id === 100);
  assert(t.name === '旧名称', '被拦截时数据未被修改');
}
{
  const bucket = makeBucket({ 'data/tools.json': freshTools() });
  const req = makeReq('POST', { action: 'edit', id: 100, name: 'x', desc: 'y', type: 'html', url: 'z' }, '');
  const res = await adminOnRequest({ request: req, env: { TOOLS_BUCKET: bucket, AUTH_SECRET: SECRET } });
  assert(res.status === 403, '无令牌返回 403');
}

// ===== 3) GitHub 原始工具不可编辑 =====
console.log('\n[3] GitHub 原始只读工具（id 不在 R2）');
{
  const bucket = makeBucket({ 'data/tools.json': freshTools() });
  const req = makeReq('POST', { action: 'edit', id: 999, name: 'x', desc: 'y', type: 'html', url: 'z' }, adminToken);
  const res = await adminOnRequest({ request: req, env: { TOOLS_BUCKET: bucket, AUTH_SECRET: SECRET } });
  const d = await res.json();
  assert(res.status === 404, '返回 404');
  assert(/不可修改/.test(d.error || ''), '错误信息说明原始数据不可修改');
  assert(bucket.json('data/tools.json').tools.length === 2, '原始数据未被写入');
}

// ===== 4) multipart：替换程序包 =====
console.log('\n[4] 替换程序包：新文件入库 + 旧文件回收');
{
  const bucket = makeBucket({ 'data/tools.json': freshTools() });
  const fd = fdOf([
    ['action', 'edit'], ['id', '100'], ['name', '带文件'], ['desc', 'd'], ['type', 'exe'],
    ['tags', ''], ['author', '@A'], ['url', 'https://home.example'], ['icon', ''],
    ['file', fakeFile('新版.zip', 2048, 'application/zip')],
  ]);
  const req = makeReq('POST', null, adminToken, { contentType: 'multipart/form-data; boundary=----x', formData: fd });
  const res = await adminOnRequest({ request: req, env: { TOOLS_BUCKET: bucket, AUTH_SECRET: SECRET, R2_PUBLIC_BASE: 'https://pub.example' } });
  const d = await res.json();
  assert(res.status === 200 && d.success, '带文件的编辑成功');
  const t = bucket.json('data/tools.json').tools.find((x) => x.id === 100);
  assert(/^tools\/\d+-新版\.zip$/.test(t.fileKey), '新文件 key 写入 tools/ 前缀');
  assert(t.fileUrl === 'https://pub.example/' + t.fileKey, 'fileUrl 指向公开地址');
  assert(t.fileName === '新版.zip' && t.fileSize === 2048, '文件名与大小已更新');
  assert(t.storage === 'r2', 'storage 标记为 r2');
  assert(t.url === 'https://home.example', '网址字段仍保留（可同时存在）');
  const putEntry = bucket._putLog.find((p) => p.key === t.fileKey);
  assert(putEntry && putEntry.value && putEntry.value.__stream === '新版.zip', '传给 R2 的是 ReadableStream 而非 File 对象');
  assert(bucket._delLog.includes('tools/old.exe'), '旧程序包已被回收');
  assert(bucket.has(t.fileKey), '新文件确实写入了 R2');
}

// ===== 5) multipart：替换图标 =====
console.log('\n[5] 替换图标：新图标入库 + 旧图标回收');
{
  const bucket = makeBucket({ 'data/tools.json': freshTools() });
  const fd = fdOf([
    ['action', 'edit'], ['id', '100'], ['name', 'n'], ['desc', 'd'], ['type', 'html'],
    ['tags', ''], ['author', ''], ['url', 'https://u.example'], ['icon', ''],
    ['iconFile', fakeFile('new.png', 1024, 'image/png')],
  ]);
  const req = makeReq('POST', null, adminToken, { contentType: 'multipart/form-data; boundary=----x', formData: fd });
  const res = await adminOnRequest({ request: req, env: { TOOLS_BUCKET: bucket, AUTH_SECRET: SECRET, R2_PUBLIC_BASE: 'https://pub.example' } });
  const d = await res.json();
  assert(res.status === 200 && d.success, '带图标的编辑成功');
  const t = bucket.json('data/tools.json').tools.find((x) => x.id === 100);
  assert(/^icons\/upload\//.test(t.iconKey), '新 iconKey 在 icons/upload/ 下');
  assert(t.icon === '/api/icon/upload/' + t.iconKey.slice('icons/upload/'.length), 'icon 转为本站 /api/icon/ 地址');
  assert(bucket._delLog.includes('icons/upload/old.png'), '旧图标已被回收');
  assert(t.fileUrl === 'https://r2/tools/old.exe', '未传文件时程序包不受影响');
  assert(bucket._delLog.includes('tools/old.exe') === false, '未替换文件时旧程序包保留');
}

// ===== 6) 参数校验 =====
console.log('\n[6] 参数校验');
{
  const bucket = makeBucket({ 'data/tools.json': freshTools() });
  const req = makeReq('POST', { action: 'edit', id: 100, name: '', desc: 'd', type: 'html', url: 'z' }, adminToken);
  const res = await adminOnRequest({ request: req, env: { TOOLS_BUCKET: bucket, AUTH_SECRET: SECRET } });
  assert(res.status === 400, '缺名称返回 400');
}
{
  const bucket = makeBucket({ 'data/tools.json': freshTools() });
  const req = makeReq('POST', { action: 'edit', id: 100, name: 'n', desc: 'd', type: 'xxx', url: 'z' }, adminToken);
  const res = await adminOnRequest({ request: req, env: { TOOLS_BUCKET: bucket, AUTH_SECRET: SECRET } });
  assert(res.status === 400, '非法 type 返回 400');
}
{
  // 网址和已有文件都没有 → 拒绝
  const doc = { about: '', tools: [{ id: 100, name: 'n', desc: 'd', type: 'html', tags: [], url: 'https://x', status: 'approved' }] };
  const bucket = makeBucket({ 'data/tools.json': JSON.stringify(doc) });
  const req = makeReq('POST', { action: 'edit', id: 100, name: 'n', desc: 'd', type: 'html', url: '' }, adminToken);
  const res = await adminOnRequest({ request: req, env: { TOOLS_BUCKET: bucket, AUTH_SECRET: SECRET } });
  const d = await res.json();
  assert(res.status === 400, '既无网址又无文件时返回 400');
  assert(/必须填写/.test(d.error || ''), '提示必须填写地址或上传文件');
  assert(bucket.json('data/tools.json').tools[0].url === 'https://x', '校验失败时数据未被改动');
}

// ===== 7) 上传限制 =====
console.log('\n[7] 文件限制');
{
  const bucket = makeBucket({ 'data/tools.json': freshTools() });
  const fd = fdOf([
    ['action', 'edit'], ['id', '100'], ['name', 'n'], ['desc', 'd'], ['type', 'exe'],
    ['tags', ''], ['author', ''], ['url', ''], ['icon', ''],
    ['file', fakeFile('big.exe', 200 * 1024 * 1024, 'application/octet-stream')],
  ]);
  const req = makeReq('POST', null, adminToken, { contentType: 'multipart/form-data; boundary=----x', formData: fd });
  const res = await adminOnRequest({ request: req, env: { TOOLS_BUCKET: bucket, AUTH_SECRET: SECRET, R2_PUBLIC_BASE: 'https://pub.example', MAX_UPLOAD_MB: '50' } });
  assert(res.status === 413, '超过 MAX_UPLOAD_MB 返回 413');
  assert(bucket.json('data/tools.json').tools.find((x) => x.id === 100).fileName === 'old.exe', '超限时不改动数据');
}
{
  const bucket = makeBucket({ 'data/tools.json': freshTools() });
  const fd = fdOf([
    ['action', 'edit'], ['id', '100'], ['name', 'n'], ['desc', 'd'], ['type', 'html'],
    ['tags', ''], ['author', ''], ['url', 'https://u'], ['icon', ''],
    ['iconFile', fakeFile('a.exe', 1024, 'application/octet-stream')],
  ]);
  const req = makeReq('POST', null, adminToken, { contentType: 'multipart/form-data; boundary=----x', formData: fd });
  const res = await adminOnRequest({ request: req, env: { TOOLS_BUCKET: bucket, AUTH_SECRET: SECRET } });
  assert(res.status === 400, '图标传非图片文件返回 400');
}
{
  const bucket = makeBucket({ 'data/tools.json': freshTools() });
  const fd = fdOf([
    ['action', 'edit'], ['id', '100'], ['name', 'n'], ['desc', 'd'], ['type', 'exe'],
    ['tags', ''], ['author', ''], ['url', ''], ['icon', ''],
    ['file', fakeFile('a.exe', 1024, 'application/octet-stream')],
  ]);
  const req = makeReq('POST', null, adminToken, { contentType: 'multipart/form-data; boundary=----x', formData: fd });
  const res = await adminOnRequest({ request: req, env: { TOOLS_BUCKET: bucket, AUTH_SECRET: SECRET } }); // 无 R2_PUBLIC_BASE
  assert(res.status === 500, '未配置 R2_PUBLIC_BASE 时返回 500');
  assert(bucket.json('data/tools.json').tools.find((x) => x.id === 100).fileName === 'old.exe', '失败时数据未被半改');
}

// ===== 8) 服务端未绑桶 =====
console.log('\n[8] 未绑定 R2 桶');
{
  const req = makeReq('POST', { action: 'edit', id: 100, name: 'n', desc: 'd', type: 'html', url: 'z' }, adminToken);
  const res = await adminOnRequest({ request: req, env: { AUTH_SECRET: SECRET } });
  const d = await res.json();
  assert(res.status === 500 && /TOOLS_BUCKET/.test(d.error || ''), '提示未绑定存储桶');
}

// ===== 9) id 类型兼容 + 未知 action =====
console.log('\n[9] 兼容性与未知动作');
{
  const bucket = makeBucket({ 'data/tools.json': freshTools() });
  const req = makeReq('POST', { action: 'edit', id: '100', name: '字符串id', desc: 'd', type: 'html', url: 'z' }, adminToken);
  const res = await adminOnRequest({ request: req, env: { TOOLS_BUCKET: bucket, AUTH_SECRET: SECRET } });
  assert(res.status === 200, 'id 传字符串也能匹配到数字 id');
  assert(bucket.json('data/tools.json').tools.find((x) => x.id === 100).name === '字符串id', '匹配并修改成功');
}
{
  const bucket = makeBucket({ 'data/tools.json': freshTools() });
  const req = makeReq('POST', { action: 'no-such', id: 100 }, adminToken);
  const res = await adminOnRequest({ request: req, env: { TOOLS_BUCKET: bucket, AUTH_SECRET: SECRET } });
  assert(res.status === 400, '未知 action 返回 400');
}

// ===== 10) 旧的 seticon / delete 仍可用（回归） =====
console.log('\n[10] 回归：原有 action 未被破坏');
{
  const bucket = makeBucket({ 'data/tools.json': freshTools() });
  const r1 = await adminOnRequest({ request: makeReq('POST', { action: 'seticon', id: 100, icon: '/api/icon/y.png' }, adminToken), env: { TOOLS_BUCKET: bucket, AUTH_SECRET: SECRET } });
  assert(r1.status === 200, 'seticon 仍可用');
  assert(bucket.json('data/tools.json').tools.find((x) => x.id === 100).icon === '/api/icon/y.png', 'seticon 生效');
  const r2 = await adminOnRequest({ request: makeReq('POST', { action: 'delete', id: 101 }, adminToken), env: { TOOLS_BUCKET: bucket, AUTH_SECRET: SECRET } });
  assert(r2.status === 200, 'delete 仍可用');
  assert(bucket.json('data/tools.json').tools.length === 1, 'delete 生效');
}

console.log(`\n==== 结果：${pass} 通过 / ${fail} 失败 ====`);
process.exit(fail === 0 ? 0 : 1);
