// functions/api/admin-users.js
// 管理员操作用户表（R2 data/users.json）：
//   GET    -> 列出用户（不含密码哈希）
//   POST   -> action=create 新建用户；action=reset 重置密码（默认 123456）
//   DELETE -> ?username= 删除用户（禁止删除管理员）
import { requireRole, json, parseAdmins, sha256Hex } from './_shared/auth.js';
import { readJson, updateJson } from './_shared/store.js';

function adminNames(env) {
  try { return (JSON.parse(env.ADMIN_CREDENTIALS || '[]')).map((a) => a.user); } catch (e) { return []; }
}

export async function onRequest(context) {
  const { request, env } = context;
  const payload = await requireRole(request, env, 'admin');
  if (!payload) return json({ error: '需要管理员权限' }, 401);

  const admins = adminNames(env);

  if (request.method === 'GET') {
    const { value: users } = await readJson(env, 'users.json', []);
    const arr = Array.isArray(users) ? users : [];
    return json({ users: arr.map((u) => ({ user: u.user, role: u.role || 'user', createdAt: u.createdAt || '' })) });
  }

  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch (e) { return json({ error: '请求格式错误' }, 400); }
    const action = body.action || 'create';

    if (action === 'create') {
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      const role = body.role === 'admin' ? 'admin' : 'user';
      if (!username) return json({ error: '用户名不能为空' }, 400);
      if (admins.includes(username)) return json({ error: '该用户名是管理员，不能在用户表创建' }, 400);
      if (!password || password.length < 6) return json({ error: '密码至少 6 位' }, 400);
      const { value: users } = await readJson(env, 'users.json', []);
      const arr = Array.isArray(users) ? users : [];
      if (arr.some((x) => x.user === username)) return json({ error: '用户已存在' }, 400);
      const hash = await sha256Hex(password);
      try {
        await updateJson(env, 'users.json', (list) => {
          const a = Array.isArray(list) ? list : [];
          a.push({ user: username, hash, role, createdAt: new Date().toISOString() });
          return a;
        }, []);
        return json({ success: true, message: '用户已创建' });
      } catch (e) { return json({ error: '创建失败：' + (e && e.message ? e.message : e) }, 500); }
    }

    if (action === 'reset') {
      const username = String(body.username || '').trim();
      const newPassword = body.newPassword ? String(body.newPassword) : '123456';
      if (!username) return json({ error: '用户名不能为空' }, 400);
      const { value: users } = await readJson(env, 'users.json', []);
      const arr = Array.isArray(users) ? users : [];
      if (!arr.some((x) => x.user === username)) return json({ error: '用户不存在' }, 400);
      const newHash = await sha256Hex(newPassword);
      try {
        await updateJson(env, 'users.json', (list) => {
          const a = Array.isArray(list) ? list : [];
          const i = a.findIndex((x) => x.user === username);
          if (i >= 0) a[i] = { ...a[i], hash: newHash };
          return a;
        }, []);
        return json({ success: true, message: `密码已重置为 ${newPassword}` });
      } catch (e) { return json({ error: '重置失败：' + (e && e.message ? e.message : e) }, 500); }
    }

    return json({ error: '未知 action' }, 400);
  }

  if (request.method === 'DELETE') {
    const url = new URL(request.url);
    const username = String(url.searchParams.get('username') || '').trim();
    if (!username) return json({ error: '缺少 username' }, 400);
    if (admins.includes(username)) return json({ error: '不能删除管理员账号' }, 400);
    const { value: users } = await readJson(env, 'users.json', []);
    const arr = Array.isArray(users) ? users : [];
    if (!arr.some((x) => x.user === username)) return json({ error: '用户不存在' }, 400);
    try {
      await updateJson(env, 'users.json', (list) => {
        const a = Array.isArray(list) ? list : [];
        return a.filter((x) => x.user !== username);
      }, []);
      return json({ success: true, message: '已删除' });
    } catch (e) { return json({ error: '删除失败：' + (e && e.message ? e.message : e) }, 500); }
  }

  return json({ error: 'Method Not Allowed' }, 405);
}
