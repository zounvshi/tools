// functions/api/migrate.js
// 新版数据架构下，原始数据「始终从 GitHub 直接读取」，不再需要导入到 R2。
// 本接口保留仅为兼容旧引用，调用它不会做任何数据搬运（空操作）。
// 如确认不再需要，可直接删除本文件（不删除也不影响任何功能）。
import { requireRole, json } from './_shared/auth.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  const payload = await requireRole(request, env, 'admin');
  if (!payload) return json({ error: '无权操作' }, 403);
  return json({
    info: '当前架构下原始数据直接从 GitHub 读取，无需导入；本接口为空操作。',
    success: true,
  });
}
