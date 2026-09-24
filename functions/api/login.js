// functions/api/login.js  （重写）
// 登录：管理员(用户名+密钥) 或 普通用户(用户名+可选通行码)
// 成功返回 HS256 风格签名令牌（前端存 localStorage），服务端用 AUTH_SECRET 校验。
import { signToken, sha256Hex, parseAdmins, json } from './_shared/auth.js';

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

  // 1) 管理员判定
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
    return json({ success: false, message: '管理员密钥错误' }, 401);
  }

  // 2) 普通用户：若配置了 USER_PASSCODE，则必须匹配
  const pc = env.USER_PASSCODE || '';
  if (pc.length > 0 && password !== pc) {
    return json({ success: false, message: '通行码错误' }, 401);
  }
  const token = await signToken(
    { sub: username, role: 'user', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 12 * 3600 },
    env.AUTH_SECRET
  );
  return json({ success: true, token, role: 'user', username });
}
