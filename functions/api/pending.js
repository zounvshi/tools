// functions/api/pending.js  （仅管理员）
// GET：返回待审核列表（status==='pending'）。
import { requireRole, json } from './_shared/auth.js';
import { readJson } from './_shared/store.js';

export async function onRequest(context) {
  const { request, env } = context;
  const payload = await requireRole(request, env, 'admin');
  if (!payload) return json({ error: '无权访问' }, 403);

  try {
    const { value } = await readJson(env, 'pending.json', []);
    const list = Array.isArray(value) ? value : [];
    return json(list);
  } catch (e) {
    return json({ error: String(e && e.message ? e.message : e) }, 500);
  }
}
