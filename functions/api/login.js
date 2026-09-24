// functions/api/login.js
// 登录：管理员(用户名+密码，来自 ADMIN_CREDENTIALS 环境变量) 或 普通用户(用户名+密码，来自 R2 用户表)。
// 成功返回 HS256 风格签名令牌（前端存 localStorage），服务端用 AUTH_SECRET 校验。
import { signToken, sha256Hex, parseAdmins, json } from './_shared/auth.js';
import { readJson } from './_shared/store.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ success: false, message: '请求格式错误' }, 400);
  }

  const username = (body.username || '').trim();
  const password = body.password || '';
  if (!username) {
    return json({ success: false, message: '请输入用户名' }, 400);
  }

  // 1) 管理员判定（来自环境变量 ADMIN_CREDENTIALS，优先级最高）
  const admins = parseAdmins(env);
  const admin = admins.find((a) => a.user === username);
  if (admin) {
    const ok = admin.hash
      ? (await sha256Hex(password)) === admin.hash
      : password === admin.pass;
    if (ok) {
      const token = await signToken(
        { sub: username, role: 'admin', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 12 * 3600 },
        env.AUTH_SECRET
      );
      return json({ success: true, token, role: 'admin', username });
    }
    // 用户名匹配管理员但密码错 -> 直接拒绝（不降级为用户）
    return json({ success: false, message: '管理员密码错误' }, 401);
  }

  // 2) 普通用户：必须在用户表中存在，且密码匹配（用户表存于 R2 data/users.json）
  if (!env.TOOLS_BUCKET) {
    return json({ success: false, message: '服务端未绑定 R2 存储桶（TOOLS_BUCKET）' }, 500);
  }
  const { value: users } = await readJson(env, 'users.json', []);
  const u = (Array.isArray(users) ? users : []).find((x) => x.user === username);
  if (!u) {
    return json({ success: false, message: '该用户不存在，请联系管理员开通账号' }, 401);
  }
  const ok = (await sha256Hex(password)) === u.hash;
  if (!ok) {
    return json({ success: false, message: '密码错误' }, 401);
  }
  const token = await signToken(
    { sub: username, role: u.role || 'user', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 12 * 3600 },
    env.AUTH_SECRET
  );
  return json({ success: true, token, role: u.role || 'user', username });
}
