// functions/api/admin.js  （仅管理员）
// POST { action, ... }：approve(通过) | reject(驳回) | delete(删除) | about(改关于我们) | guide(改说明)
// 所有写操作均落到 R2（data/tools.json / data/pending.json），带 ETag 乐观锁，避免并发覆盖。
import { requireRole, json } from './_shared/auth.js';
import { updateJson } from './_shared/store.js';

const NOTFOUND = '__NOTFOUND__';

// 删除工具时，一并删除其文件（仅 R2 存储；失败不阻断 JSON 操作）
async function removeStoredFile(env, item) {
  if (!item || !item.fileKey) return;
  if (item.storage === 'r2' && env.TOOLS_BUCKET) {
    try { await env.TOOLS_BUCKET.delete(item.fileKey); } catch (_) {}
  }
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  const payload = await requireRole(request, env, 'admin');
  if (!payload) return json({ error: '无权操作' }, 403);
  if (!env.TOOLS_BUCKET) return json({ error: '服务端未绑定 R2 存储桶（TOOLS_BUCKET）' }, 500);

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: '请求格式错误' }, 400); }
  const { action, id } = body;
  const now = new Date().toISOString();

  try {
    if (action === 'approve') {
      // 先在 pending 中找到并取出，再写入 tools（两步；先 tools 后 pending，任一步失败可重试）
      let moved = null;
      try {
        await updateJson(env, 'pending.json', (list) => {
          const arr = Array.isArray(list) ? list : [];
          const idx = arr.findIndex((x) => String(x.id) === String(id));
          if (idx < 0) throw new Error(NOTFOUND);
          moved = { ...arr[idx], status: 'approved', reviewedBy: payload.sub, reviewedAt: now };
          arr.splice(idx, 1);
          return arr;
        }, []);
      } catch (e) {
        if (String(e.message).includes(NOTFOUND)) return json({ error: '待审核项不存在' }, 404);
        throw e;
      }
      await updateJson(env, 'tools.json', (prev) => {
        const tools = Array.isArray(prev.tools) ? prev.tools : [];
        tools.push(moved);
        return { about: prev.about || '', tools };
      }, { about: '', tools: [] });
      return json({ success: true, tool: moved });
    }

    if (action === 'reject') {
      let removed = null;
      try {
        await updateJson(env, 'pending.json', (list) => {
          const arr = Array.isArray(list) ? list : [];
          const idx = arr.findIndex((x) => String(x.id) === String(id));
          if (idx < 0) throw new Error(NOTFOUND);
          removed = arr[idx];
          arr.splice(idx, 1);
          return arr;
        }, []);
      } catch (e) {
        if (String(e.message).includes(NOTFOUND)) return json({ error: '待审核项不存在' }, 404);
        throw e;
      }
      await removeStoredFile(env, removed);
      return json({ success: true });
    }

    if (action === 'delete') {
      let removed = null;
      try {
        await updateJson(env, 'tools.json', (prev) => {
          const tools = Array.isArray(prev.tools) ? prev.tools : [];
          const idx = tools.findIndex((x) => String(x.id) === String(id));
          if (idx < 0) throw new Error(NOTFOUND);
          removed = tools[idx];
          tools.splice(idx, 1);
          return { about: prev.about || '', tools };
        }, { about: '', tools: [] });
      } catch (e) {
        if (String(e.message).includes(NOTFOUND)) return json({ error: '工具不存在' }, 404);
        throw e;
      }
      await removeStoredFile(env, removed);
      return json({ success: true });
    }

    if (action === 'about') {
      await updateJson(env, 'tools.json', (prev) => ({ about: body.about || '', tools: Array.isArray(prev.tools) ? prev.tools : [] }), { about: '', tools: [] });
      return json({ success: true });
    }

    if (action === 'guide') {
      let found = false;
      await updateJson(env, 'tools.json', (prev) => {
        const tools = Array.isArray(prev.tools) ? prev.tools : [];
        const idx = tools.findIndex((x) => String(x.id) === String(id));
        if (idx >= 0) { tools[idx].guide = body.guide || ''; found = true; }
        return { about: prev.about || '', tools };
      }, { about: '', tools: [] });
      if (!found) return json({ error: '工具不存在' }, 404);
      return json({ success: true });
    }

    return json({ error: '未知 action' }, 400);
  } catch (e) {
    return json({ error: String(e && e.message ? e.message : e) }, 500);
  }
}
