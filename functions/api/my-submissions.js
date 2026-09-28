// functions/api/my-submissions.js
// GET：当前登录用户「我提交的工具」及其审批进度。
// 数据来源（全部在 R2）：
//   - data/pending.json：status='pending'（待审核）与 status='rejected'（已驳回，含审批意见）
//   - data/tools.json：status='approved'（已通过上线）
// 只按 submittedBy 匹配当前账号，不会泄露他人提交内容。
import { requireRole, json } from './_shared/auth.js';
import { readJson } from './_shared/store.js';

// 只返回前端展示需要的字段，去掉 fileKey / iconKey 等内部字段
function pick(t, status) {
  return {
    id: t.id,
    name: t.name || '',
    desc: t.desc || '',
    type: t.type || '',
    status: status,                                   // pending | approved | rejected
    submittedAt: t.submittedAt || '',
    reviewedBy: t.reviewedBy || '',
    reviewedAt: t.reviewedAt || '',
    reviewNote: t.reviewNote || '',                   // 驳回意见（通过时为空）
    target: t.url || t.fileUrl || '',                 // 方便提交人自己核对地址
  };
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });

  // role='user'：普通用户与管理员均可（管理员直接上线的提交也会出现在列表里）
  const payload = await requireRole(request, env, 'user');
  if (!payload) return json({ error: '请先登录' }, 401);
  const me = String(payload.sub || '');

  try {
    const { value: pend } = await readJson(env, 'pending.json', []);
    const arr = Array.isArray(pend) ? pend : [];
    const mine = arr
      .filter((x) => String(x.submittedBy || '') === me)
      .filter((x) => (x.status || 'pending') !== 'approved')
      .map((x) => pick(x, x.status === 'rejected' ? 'rejected' : 'pending'));

    const { value: toolsDoc } = await readJson(env, 'tools.json', { about: '', tools: [] });
    const tools = Array.isArray(toolsDoc && toolsDoc.tools) ? toolsDoc.tools : [];
    const approved = tools
      .filter((x) => String(x.submittedBy || '') === me && (x.status || 'approved') === 'approved')
      .map((x) => pick(x, 'approved'));

    const list = mine
      .concat(approved)
      .sort((a, b) => String(b.submittedAt || '').localeCompare(String(a.submittedAt || '')));

    return json({ success: true, count: list.length, list });
  } catch (e) {
    return json({ error: String(e && e.message ? e.message : e) }, 500);
  }
}
