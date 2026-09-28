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
    // 只返回真正「待审核」的项：历史数据可能没有 status 字段，按 pending 处理。
    // 已驳回（status='rejected')的项仍然保留在库中，供提交人查看审批结果。
    return json(list.filter((x) => (x.status || 'pending') === 'pending'));
  } catch (e) {
    return json({ error: String(e && e.message ? e.message : e) }, 500);
  }
}
