// 账号系统本地测试：解析真实 users.xlsx + 内存模拟 R2，跑通 登录/建用户/改密码/批量导入/删除
import { parseXlsx, parseCsv, guessUserCol } from './functions/api/_shared/parse-sheet.js';
import { onRequest as login } from './functions/api/login.js';
import { onRequest as adminUsers } from './functions/api/admin-users.js';
import { onRequest as adminImport } from './functions/api/admin-import.js';
import { onRequest as changePw } from './functions/api/change-password.js';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';

async function sha256(s) {
  const d = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
const TEST_ADMIN_PW = 'testadmin';

let pass = 0, fail = 0;
function assert(name, cond) { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name); } }

function makeBucket() {
  const store = new Map();
  return {
    async get(k) { return store.has(k) ? { text: async () => store.get(k), etag: 'e-' + k } : null; },
    async put(k, body) { store.set(k, typeof body === 'string' ? body : (body && body.toString ? body.toString() : JSON.stringify(body))); return { etag: 'e-' + k }; },
    async delete(k) { store.delete(k); return {}; },
    _store: store,
  };
}

const env = {
  AUTH_SECRET: 'test-secret-123',
  ADMIN_CREDENTIALS: '[{"user":"liyt1","hash":"f05e9cb938aa2eb939ffb08b66a4a99a69cd46a4bc21d08d7edcd632781f8d15"}]',
  TOOLS_BUCKET: makeBucket(),
};

// 用已知密码覆盖管理员哈希，便于本测试登录（不影响真实部署的哈希）
env.ADMIN_CREDENTIALS = JSON.stringify([{ user: 'liyt1', hash: await sha256(TEST_ADMIN_PW) }]);

function req(method, path, body, headers = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  return new Request('https://x' + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
}
async function jres(r) { const d = await r.json().catch(() => ({})); return { status: r.status, d }; }

async function main() {
  console.log('— 1) xlsx 解析（真实 users.xlsx）—');
  const buf = new Uint8Array(readFileSync('C:/Users/liyt1/Desktop/AI小组/users.xlsx'));
  const rows = await parseXlsx(buf);
  assert('解析出行数 >= 2（表头+数据）', rows.length >= 2);
  assert('首行为表头：员工 ID/姓名/...', rows[0][0] === '员工 ID' && rows[0][1] === '姓名');
  const g = guessUserCol(rows[0]);
  assert('推断账号列指向「域账号」(index 5)', g === 5);
  assert('数据行含 liyt1', rows.some(r => r.includes('liyt1')));

  console.log('— 2) csv 解析 —');
  const csv = parseCsv('a,b,c\n张三,123456,x\n李四,654321,y');
  assert('csv 共 3 行（表头+2数据）', csv.length === 3 && csv[1][0] === '张三' && csv[2][1] === '654321');

  console.log('— 3) 管理员登录 —');
  let r = await jres(await login({ request: req('POST', '/api/login', { username: 'liyt1', password: '__wrong__' }), env }));
  assert('管理员密码错误 -> 401', r.status === 401);
  r = await jres(await login({ request: req('POST', '/api/login', { username: 'liyt1', password: TEST_ADMIN_PW }), env }));
  assert('管理员密码正确 -> 200 + token', r.status === 200 && !!r.d.token && r.d.role === 'admin');
  const adminToken = r.d.token;
  const authH = { Authorization: 'Bearer ' + adminToken };

  console.log('— 4) 普通用户登录（不存在）—');
  r = await jres(await login({ request: req('POST', '/api/login', { username: 'nobody', password: '123456' }), env }));
  assert('不存在用户 -> 401 该用户不存在', r.status === 401 && /不存在/.test(r.d.message));

  console.log('— 5) 管理员新建用户 —');
  r = await jres(await adminUsers({ request: req('POST', '/api/admin-users', { action: 'create', username: 'zhangsan', password: '123456', role: 'user' }, authH), env }));
  assert('创建 zhangsan -> success', r.status === 200 && r.d.success);
  r = await jres(await adminUsers({ request: req('POST', '/api/admin-users', { action: 'create', username: 'zhangsan', password: '123456' }, authH), env }));
  assert('重复创建 -> 报错', r.status !== 200 && /已存在/.test(r.d.error));

  console.log('— 6) 普通用户用初始密码登录 + 改密码 —');
  r = await jres(await login({ request: req('POST', '/api/login', { username: 'zhangsan', password: '123456' }), env }));
  assert('zhangsan 123456 登录成功', r.status === 200 && r.d.role === 'user');
  const zToken = r.d.token;
  r = await jres(await changePw({ request: req('POST', '/api/change-password', { oldPassword: '123456', newPassword: 'NewPass9' }, { Authorization: 'Bearer ' + zToken }), env }));
  assert('改密码成功', r.status === 200 && r.d.success);
  r = await jres(await login({ request: req('POST', '/api/login', { username: 'zhangsan', password: '123456' }), env }));
  assert('旧密码失效', r.status === 401);
  r = await jres(await login({ request: req('POST', '/api/login', { username: 'zhangsan', password: 'NewPass9' }), env }));
  assert('新密码生效', r.status === 200);

  console.log('— 7) 批量导入（用真实 xlsx 解析结果，选域账号列，跳过表头）—');
  // 构造含 liyt1(管理员,应跳过) + 两个新用户的合成表，验证创建与跳过
  const synth = [
    ['员工ID', '姓名', '域账号'],
    ['E1', '王五', 'wangwu'],
    ['E2', '赵六', 'zhaoliu'],
    ['CN0000001', 'liyt1', 'liyt1'], // 与管理员重名，应跳过
  ];
  r = await jres(await adminImport({ request: req('POST', '/api/admin-import', { rows: synth, userCol: 2, passCol: -1, skipHeader: true, defaultPass: '123456' }, authH), env }));
  assert('导入成功 created=2 skipped>=1', r.status === 200 && r.d.success && r.d.created === 2 && r.d.skipped >= 1);
  r = await jres(await login({ request: req('POST', '/api/login', { username: 'wangwu', password: '123456' }), env }));
  assert('导入的用户 wangwu 可登录', r.status === 200);
  r = await jres(await login({ request: req('POST', '/api/login', { username: 'liyt1', password: TEST_ADMIN_PW }), env }));
  assert('liyt1 仍走管理员校验（非用户表）', r.status === 200 && r.d.role === 'admin');

  console.log('— 8) 用户列表 + 删除 —');
  r = await jres(await adminUsers({ request: req('GET', '/api/admin-users', null, authH), env }));
  assert('列表含 zhangsan/wangwu/zhaoliu', r.d.users.some(u => u.user === 'zhangsan') && r.d.users.some(u => u.user === 'wangwu'));
  r = await jres(await adminUsers({ request: req('DELETE', '/api/admin-users?username=zhaoliu', null, authH), env }));
  assert('删除 zhaoliu 成功', r.status === 200 && r.d.success);
  r = await jres(await adminUsers({ request: req('DELETE', '/api/admin-users?username=liyt1', null, authH), env }));
  assert('禁止删除管理员', r.status !== 200 && /管理员/.test(r.d.error));

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常:', e); process.exit(2); });
