// functions/api/favorites.js  （登录用户：读/写「自己」的收藏）
//
// 数据落在 R2：data/favorites.json，结构：
//   { "liyt1": [1, 1785221348911], "zhangsan": [1785822106868] }
// 按用户名隔离，互不可见；写入带 ETag 乐观锁（并发安全）。
//
// 设计要点：
//   - 必须登录（requireRole 'user'，管理员也算 user）；未登录一律 401，前端自动退回「仅本机收藏」。
//   - 只存工具 id 数组，不存其它信息，体积可控（上限 500 条/人）。
//   - 只接受纯数字 id，避免脏数据污染。
import { requireRole, json } from './_shared/auth.js';
import { readJson, updateJson } from './_shared/store.js';

const MAX_IDS = 500;

// 只接受「安全整数」形式的工具 id，其它一律丢弃（防脏数据 / 超大数精度丢失）
function normId(x) {
  if (typeof x === 'number') return Number.isSafeInteger(x) ? x : null;
  const s = String(x == null ? '' : x).trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

export async function onRequest(context) {
  const { request, env } = context;

  const payload = await requireRole(request, env, 'user');
  if (!payload) return json({ error: '请先登录' }, 401);
  const user = String(payload.sub || '').trim();
  if (!user) return json({ error: '令牌缺少用户标识' }, 401);
  if (!env.TOOLS_BUCKET) return json({ error: '服务端未绑定 R2 存储桶（TOOLS_BUCKET）' }, 500);

  try {
    if (request.method === 'GET') {
      const { value } = await readJson(env, 'favorites.json', {});
      const ids = value && !Array.isArray(value) ? value[user] : null;
      return json({ user, ids: Array.isArray(ids) ? ids : [] });
    }

    if (request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch (e) { return json({ error: '请求格式错误' }, 400); }
      const raw = Array.isArray(body && body.ids) ? body.ids : [];
      const ids = [...new Set(raw.map(normId).filter((x) => x !== null))].slice(0, MAX_IDS);
      await updateJson(env, 'favorites.json', (prev) => {
        const doc = prev && typeof prev === 'object' && !Array.isArray(prev) ? prev : {};
        doc[user] = ids;
        return doc;
      }, {});
      return json({ success: true, user, ids });
    }

    return new Response('Method Not Allowed', { status: 405 });
  } catch (e) {
    return json({ error: String(e && e.message ? e.message : e) }, 500);
  }
}
