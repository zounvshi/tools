// functions/api/admin.js  （仅管理员）
// POST { action, ... }：approve(通过) | reject(驳回) | delete(删除) | about(改关于我们) | guide(改说明) | seticon(改图标) | edit(编辑工具信息)
// 所有写操作均落到 R2（data/tools.json / data/pending.json），带 ETag 乐观锁，避免并发覆盖。
// 请求体支持两种：JSON（普通编辑）与 multipart/form-data（编辑时同时替换程序包/图标图片）。
import { requireRole, json } from './_shared/auth.js';
import { updateJson } from './_shared/store.js';

const NOTFOUND = '__NOTFOUND__';
const DEFAULT_MAX_UPLOAD_MB = 100;

// 删除工具时，一并删除其文件（仅 R2 存储；失败不阻断 JSON 操作）
async function removeStoredFile(env, item) {
  if (!item) return;
  if (item.fileKey && item.storage === 'r2' && env.TOOLS_BUCKET) {
    try { await env.TOOLS_BUCKET.delete(item.fileKey); } catch (_) {}
  }
  // 随工具上传的图标图片一并回收（自动抓取的 icons/site/ 为共享缓存，不删）
  if (item.iconKey && env.TOOLS_BUCKET) {
    try { await env.TOOLS_BUCKET.delete(item.iconKey); } catch (_) {}
  }
}

// 标签解析：支持数组 / 「逗号或中文逗号」分隔的字符串，去重去空，最多 6 个
function parseTags(raw) {
  if (Array.isArray(raw)) return raw.map((t) => String(t).trim()).filter(Boolean).slice(0, 6);
  if (raw === undefined || raw === null) return [];
  return String(raw).split(/[,，]/).map((t) => t.trim()).filter(Boolean).slice(0, 6);
}

// 把上传的程序包存入 R2，返回 { fileKey, fileUrl, fileName, fileSize }；未传文件返回 null
async function storeToolFile(env, file) {
  if (!file || !file.size) return null;
  if (!env.R2_PUBLIC_BASE) {
    throw Object.assign(new Error('服务端未配置 R2 公开地址（R2_PUBLIC_BASE），暂不支持上传文件'), { status: 500 });
  }
  const maxBytes = (Number(env.MAX_UPLOAD_MB) || DEFAULT_MAX_UPLOAD_MB) * 1024 * 1024;
  if (file.size > maxBytes) {
    throw Object.assign(new Error(`文件过大，单次最大 ${Math.round(maxBytes / 1024 / 1024)} MB`), { status: 413 });
  }
  const safeName = (file.name || 'file').replace(/[^\w.\-一-龥]/g, '_').slice(-60);
  const fileKey = `tools/${Date.now()}-${safeName}`;
  // R2 put 不接受 File/Blob，必须传 ReadableStream
  await env.TOOLS_BUCKET.put(fileKey, file.stream(), { httpMetadata: { contentType: file.type || 'application/octet-stream' } });
  return { fileKey, fileUrl: `${env.R2_PUBLIC_BASE.replace(/\/$/, '')}/${fileKey}`, fileName: file.name || safeName, fileSize: file.size };
}

// 把上传的图标图片存入 R2，返回 { iconKey, icon }；未传返回 null
async function storeIconFile(env, iconFile) {
  if (!iconFile || !iconFile.size) return null;
  const ict = (iconFile.type || '').toLowerCase();
  if (!ict.startsWith('image/')) {
    throw Object.assign(new Error('图标必须是图片文件（png / jpg / svg / webp / ico）'), { status: 400 });
  }
  if (iconFile.size > 1024 * 1024) {
    throw Object.assign(new Error('图标文件过大，请控制在 1MB 以内'), { status: 413 });
  }
  const iconKey = `icons/upload/${Date.now().toString(36)}-${(iconFile.name || 'icon').replace(/[^\w.\-一-龥]/g, '_').slice(-40)}`;
  await env.TOOLS_BUCKET.put(iconKey, iconFile.stream(), { httpMetadata: { contentType: ict } });
  return { iconKey, icon: '/api/icon/' + iconKey.slice('icons/'.length) };
}

// 按标记回收旧资源（file=程序包，icon=随工具上传的图标；共享缓存 icons/site/ 不删）
async function removeFiles(env, item, opts) {
  if (!item || !env.TOOLS_BUCKET) return;
  if (opts.file && item.fileKey && item.storage === 'r2') {
    try { await env.TOOLS_BUCKET.delete(item.fileKey); } catch (_) {}
  }
  if (opts.icon && item.iconKey) {
    try { await env.TOOLS_BUCKET.delete(item.iconKey); } catch (_) {}
  }
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  const payload = await requireRole(request, env, 'admin');
  if (!payload) return json({ error: '无权操作' }, 403);
  if (!env.TOOLS_BUCKET) return json({ error: '服务端未绑定 R2 存储桶（TOOLS_BUCKET）' }, 500);

  // ---- 解析请求体：JSON（默认）或 multipart（编辑时带文件） ----
  let body = {};
  let newFile = null;      // 替换的程序包（exe/zip 等）
  let newIconFile = null;  // 替换的图标图片
  const ct = request.headers.get('content-type') || '';
  if (ct.includes('multipart/form-data')) {
    const fd = await request.formData();
    for (const [k, v] of fd.entries()) {
      if (k === 'file') newFile = v;
      else if (k === 'iconFile') newIconFile = v;
      else body[k] = typeof v === 'string' ? v : String(v);
    }
  } else {
    try { body = await request.json(); } catch (e) { return json({ error: '请求格式错误' }, 400); }
  }
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

    if (action === 'seticon') {
      // 修改图标地址（仅 R2 新增工具；GitHub 原始数据只读，不在 tools.json 中，故必然 404）
      let found = false;
      await updateJson(env, 'tools.json', (prev) => {
        const tools = Array.isArray(prev.tools) ? prev.tools : [];
        const idx = tools.findIndex((x) => String(x.id) === String(id));
        if (idx >= 0) { tools[idx].icon = String(body.icon || '').trim(); found = true; }
        return { about: prev.about || '', tools };
      }, { about: '', tools: [] });
      if (!found) return json({ error: '工具不存在（GitHub 原始数据不可修改）' }, 404);
      return json({ success: true });
    }

    if (action === 'edit') {
      // 编辑工具信息（仅 R2 新增工具；GitHub 原始数据不在 tools.json 中，故必然 404）
      const name = String(body.name || '').trim();
      const desc = String(body.desc || '').trim();
      const type = String(body.type || '').trim();
      const url = String(body.url || '').trim();
      if (!name || !desc || !type) return json({ error: '缺少必填字段（名称 / 描述 / 类型）' }, 400);
      if (!['exe', 'html'].includes(type)) return json({ error: '类型只能是 exe 或 html' }, 400);

      // 先上传新文件成功，再改数据：上传失败则数据完全不动，不会留下半截状态
      let storedFile = null;
      let storedIcon = null;
      try {
        storedFile = await storeToolFile(env, newFile);
        storedIcon = await storeIconFile(env, newIconFile);
      } catch (e) {
        // 清理已传成功的一半，避免孤儿文件
        if (storedFile) { try { await env.TOOLS_BUCKET.delete(storedFile.fileKey); } catch (_) {} }
        if (storedIcon) { try { await env.TOOLS_BUCKET.delete(storedIcon.iconKey); } catch (_) {} }
        return json({ error: String(e && e.message ? e.message : e) }, (e && e.status) || 500);
      }

      let old = null;
      let updated = null;
      try {
        await updateJson(env, 'tools.json', (prev) => {
          const tools = Array.isArray(prev.tools) ? prev.tools : [];
          const idx = tools.findIndex((x) => String(x.id) === String(id));
          if (idx < 0) throw new Error(NOTFOUND);
          old = tools[idx];
          const next = {
            ...old,
            name: name.slice(0, 60),
            desc: desc.slice(0, 300),
            type,
            tags: parseTags(body.tags),
            author: body.author !== undefined ? String(body.author || '').trim() : (old.author || ''),
            url,
          };
          if (storedFile) {
            next.fileKey = storedFile.fileKey;
            next.fileUrl = storedFile.fileUrl;
            next.fileName = storedFile.fileName;
            next.fileSize = storedFile.fileSize;
            next.storage = 'r2';
          }
          if (storedIcon) {
            next.icon = storedIcon.icon;
            next.iconKey = storedIcon.iconKey;
          } else if (body.icon !== undefined) {
            next.icon = String(body.icon || '').trim();
          }
          // 至少要有一个可用的入口：网址或已上传的文件包
          if (!next.url && !next.fileUrl) throw new Error('EMPTY_TARGET');
          next.updatedAt = now;
          next.updatedBy = payload.sub;
          tools[idx] = next;
          updated = next;
          return { about: prev.about || '', tools };
        }, { about: '', tools: [] });
      } catch (e) {
        // 数据未改动，回滚本次新上传的文件
        const rollback = async () => {
          if (storedFile) { try { await env.TOOLS_BUCKET.delete(storedFile.fileKey); } catch (_) {} }
          if (storedIcon) { try { await env.TOOLS_BUCKET.delete(storedIcon.iconKey); } catch (_) {} }
        };
        if (String(e.message).includes(NOTFOUND)) {
          await rollback();
          return json({ error: '工具不存在（GitHub 原始数据不可修改）' }, 404);
        }
        if (String(e.message) === 'EMPTY_TARGET') {
          await rollback();
          return json({ error: '必须填写访问/下载地址，或上传文件' }, 400);
        }
        await rollback();
        throw e;
      }

      // 数据已落盘，回收被替换掉的旧资源（共享缓存 icons/site/ 不在回收范围）
      if (old) await removeFiles(env, old, { file: !!storedFile, icon: !!storedIcon });
      return json({ success: true, tool: updated });
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
