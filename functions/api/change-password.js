// functions/api/change-password.js
// 已登录用户（普通用户）修改自己的密码。管理员改密码仍通过 Cloudflare 环境变量 ADMIN_CREDENTIALS。
import { verifyToken, sha256Hex, getToken, json } from './_shared/auth.js';
import { readJson, updateJson } from './_shared/store.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }
  const payload = await verifyToken(getToken(request), env.AUTH_SECRET);
  if (!payload) {
    return json({ success: false, message: '请先登录' }, 401);
  }
  let body;
  try { body = await request.json(); } catch (e) { return json({ success: false, message: '请求格式错误' }, 400); }

  const oldP = body.oldPassword || '';
  const newP = body.newPassword || '';
  if (!newP || newP.length < 6) {
    return json({ success: false, message: '新密码至少 6 位' }, 400);
  }

  const { value: users } = await readJson(env, 'users.json', []);
  const arr = Array.isArray(users) ? users : [];
  const idx = arr.findIndex((x) => x.user === payload.sub);
  if (idx < 0) {
    return json({ success: false, message: '账号不存在或无权修改（管理员请在 Cloudflare 修改）' }, 401);
  }
  if ((await sha256Hex(oldP)) !== arr[idx].hash) {
    return json({ success: false, message: '原密码错误' }, 401);
  }
  const newHash = await sha256Hex(newP);
  try {
    await updateJson(env, 'users.json', (list) => {
      const a = Array.isArray(list) ? list : [];
      const i = a.findIndex((x) => x.user === payload.sub);
      if (i >= 0) a[i] = { ...a[i], hash: newHash };
      return a;
    }, []);
    return json({ success: true, message: '密码已修改，请重新登录' });
  } catch (e) {
    return json({ success: false, message: '修改失败：' + (e && e.message ? e.message : e) }, 500);
  }
}
