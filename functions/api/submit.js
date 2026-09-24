// functions/api/submit.js
// POST：提交新工具。支持两种形态：
//   1) 仅链接：JSON { tool:{ name,desc,type,url,tags,icon,author } }
//   2) 带文件：multipart/form-data（字段同上 + 可选 file 安装包、可选 iconFile 图标图片），文件存入 Cloudflare R2。
//  - 普通用户：写入 data/pending.json（status='pending'），需管理员审批。
//  - 管理员：直接写入 data/tools.json（status='approved'），立即上线。
// 鉴权：用户或管理员均可调用。数据全部存 R2，无需任何 GitHub 令牌。
import { requireRole, json } from './_shared/auth.js';
import { updateJson } from './_shared/store.js';

const MAX_UPLOAD_MB = 100; // 单次上传默认上限（受 Pages Functions 请求体限制；R2 本身无上限）

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  if (!env.TOOLS_BUCKET) return json({ error: '服务端未绑定 R2 存储桶（TOOLS_BUCKET）' }, 500);

  const payload = await requireRole(request, env, 'user');
  if (!payload) return json({ error: '请先登录' }, 401);

  // ---- 解析：multipart（含文件）或 JSON ----
  let f = {};
  let file = null;
  let iconFile = null;
  const ct = request.headers.get('content-type') || '';
  if (ct.includes('multipart/form-data')) {
    const fd = await request.formData();
    for (const [k, v] of fd.entries()) {
      if (k === 'file') file = v;
      else if (k === 'iconFile') iconFile = v;
      else f[k] = v;
    }
  } else {
    try { const body = await request.json(); f = body.tool || body; } catch (e) { return json({ error: '请求格式错误' }, 400); }
  }

  const name = String(f.name || '').trim();
  const desc = String(f.desc || '').trim();
  const type = String(f.type || '').trim();
  const url = String(f.url || '').trim();

  if (!name || !desc || !type) return json({ error: '缺少必填字段（name/desc/type）' }, 400);
  if (!['exe', 'html'].includes(type)) return json({ error: 'type 只能是 exe 或 html' }, 400);

  // ---- 文件上传（可选）：存 R2；未配置 R2_PUBLIC_BASE 则要求改用链接 ----
  let fileKey = '', fileUrl = '', fileName = '', fileSize = 0, storage = 'url';
  if (file && file.size > 0) {
    if (!env.R2_PUBLIC_BASE) {
      return json({ error: '服务端未配置 R2 公开地址（R2_PUBLIC_BASE），暂不支持上传文件；请填写链接，或让管理员配置 R2_PUBLIC_BASE' }, 500);
    }
    const maxBytes = (Number(env.MAX_UPLOAD_MB) || MAX_UPLOAD_MB) * 1024 * 1024;
    if (file.size > maxBytes) return json({ error: `文件过大，单次最大 ${Math.round(maxBytes / 1024 / 1024)} MB（受 Pages 请求体限制）` }, 413);
    const safeName = (file.name || 'file').replace(/[^\w.\-一-龥]/g, '_').slice(-60);
    fileName = file.name || safeName;
    fileSize = file.size;
    storage = 'r2';
    fileKey = `tools/${Date.now()}-${safeName}`;
    try {
      // R2 put 不接受 File/Blob，必须传 ReadableStream（file.stream()）或 ArrayBuffer
      await env.TOOLS_BUCKET.put(fileKey, file.stream(), { httpMetadata: { contentType: file.type || 'application/octet-stream' } });
    } catch (e) { return json({ error: '文件存入 R2 失败：' + (e && e.message ? e.message : e) }, 500); }
    fileUrl = `${env.R2_PUBLIC_BASE.replace(/\/$/, '')}/${fileKey}`;
  } else if (!url) {
    return json({ error: '未上传文件时，必须填写访问/下载地址（url）' }, 400);
  }

  // ---- 图标图片上传（可选，优先级高于手填的图标 URL）：存 R2 icons/upload/ ----
  let iconKey = '';
  let icon = String(f.icon || '').trim();
  if (iconFile && iconFile.size > 0) {
    const ict = (iconFile.type || '').toLowerCase();
    if (!ict.startsWith('image/')) return json({ error: '图标必须是图片文件（png / jpg / svg / webp / ico）' }, 400);
    if (iconFile.size > 1024 * 1024) return json({ error: '图标文件过大，请控制在 1MB 以内' }, 413);
    iconKey = `icons/upload/${Date.now().toString(36)}-${(iconFile.name || 'icon').replace(/[^\w.\-一-龥]/g, '_').slice(-40)}`;
    try {
      await env.TOOLS_BUCKET.put(iconKey, iconFile.stream(), { httpMetadata: { contentType: ict } });
    } catch (e) { return json({ error: '图标存入 R2 失败：' + (e && e.message ? e.message : e) }, 500); }
    icon = '/api/icon/' + iconKey.slice('icons/'.length);
  }

  const now = new Date().toISOString();
  const item = {
    id: Date.now(),
    name: name.slice(0, 60),
    desc: desc.slice(0, 300),
    type,
    tags: Array.isArray(f.tags) ? f.tags.slice(0, 6) : (f.tags ? String(f.tags).split(/[,，]/).map(t => t.trim()).filter(Boolean) : []),
    url,
    fileKey, fileUrl, fileName, fileSize, storage,
    guide: String(f.guide || ''),
    icon, iconKey,
    author: (String(f.author || '').trim()) || '@' + payload.sub,
    favorite: false,
    status: payload.role === 'admin' ? 'approved' : 'pending',
    submittedBy: payload.sub,
    submittedAt: now,
    reviewedBy: payload.role === 'admin' ? payload.sub : '',
    reviewedAt: payload.role === 'admin' ? now : '',
  };

  try {
    if (payload.role === 'admin') {
      await updateJson(env, 'tools.json', (prev) => {
        const tools = Array.isArray(prev.tools) ? prev.tools : [];
        tools.push(item);
        return { about: prev.about || '', tools };
      }, { about: '', tools: [] });
      return json({ success: true, status: 'approved', tool: item });
    } else {
      await updateJson(env, 'pending.json', (list) => {
        const arr = Array.isArray(list) ? list : [];
        arr.push(item);
        return arr;
      }, []);
      return json({ success: true, status: 'pending', tool: item });
    }
  } catch (e) {
    // 写入失败：回收已上传的 R2 文件，避免孤儿文件
    if (fileKey && storage === 'r2' && env.TOOLS_BUCKET) {
      try { await env.TOOLS_BUCKET.delete(fileKey); } catch (_) {}
    }
    if (iconKey && env.TOOLS_BUCKET) {
      try { await env.TOOLS_BUCKET.delete(iconKey); } catch (_) {}
    }
    return json({ error: String(e && e.message ? e.message : e) }, 500);
  }
}
