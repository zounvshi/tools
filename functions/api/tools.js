// functions/api/tools.js  （公开）
// GET：返回已上线工具 = GitHub 原始数据（只读，绝不写回） UNION R2 新增的已审数据。
//
// 数据架构（新版）：
//   - 原始数据：始终从 GitHub 公开 raw 读取（MIGRATE_SOURCE_URL 可配），只读，永不修改 GitHub。
//   - 新增数据：存 R2 data/tools.json（仅新增/已审的工具，不再包含原始 8 个）。
//   - 待审数据：R2 data/pending.json。
// 每次读取都实时合并两者 + no-store，配合前端 cache:'no-store' 满足「审批后实时可见 / 缓存失效」。
//
// 健壮性：成功读取 GitHub 后，把原始数据缓存到 R2 data/base.json（仅首次缺失时写），
// 当 GitHub 不可达时用缓存兜底，避免原数据短暂消失（GitHub 文件本身仍不被修改）。
//
// 每个工具带 source 字段：'github'（原仓库，只读）或 'r2'（新增，可管），便于前端区分。
import { readJson, putRaw } from './_shared/store.js';
import { json } from './_shared/auth.js';

const FALLBACK_RAW = 'https://raw.githubusercontent.com/zounvshi/tools/main/tools.json';

export async function onRequest(context) {
  const { env } = context;
  try {
    // 1) 原始数据（GitHub，带缓存兜底）
    const base = await fetchBase(env);

    // 2) R2 中的「新增已审」列表（仅新增，不含原始 8 个）
    const { value: additions } = await readJson(env, 'tools.json', { about: '', tools: [] });
    const baseTools = Array.isArray(base.tools) ? base.tools : [];
    const addTools = Array.isArray(additions.tools) ? additions.tools : [];
    const baseAbout = base.about || '';
    const addAbout = (additions && additions.about) || '';

    const merged = [
      ...baseTools.map((t) => ({ ...t, status: t.status || 'approved', source: 'github' })),
      ...addTools.map((t) => ({ ...t, status: t.status || 'approved', source: 'r2' })),
    ];

    // about：优先用 R2 中管理员改过的，否则用 GitHub 原始
    return json({ about: addAbout || baseAbout || '', tools: merged });
  } catch (e) {
    return json({ error: String(e && e.message ? e.message : e) }, 500);
  }
}

// 读取 GitHub 原始数据；失败则回退到 R2 缓存 base.json；再失败返回空（不崩）。
async function fetchBase(env) {
  const url = env.MIGRATE_SOURCE_URL || FALLBACK_RAW;
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error('github ' + r.status);
    const c = await r.json();
    const doc = Array.isArray(c) ? { about: '', tools: c } : { about: c.about || '', tools: c.tools || [] };
    // 仅当缓存缺失时写入，减少 R2 写入次数（GitHub 可达时永远返回实时数据）
    try {
      const { found } = await readJson(env, 'base.json', null);
      if (!found) await putRaw(env, 'base.json', JSON.stringify(doc, null, 2));
    } catch (_) { /* 缓存写失败不影响主流程 */ }
    return doc;
  } catch (e) {
    try {
      const { value, found } = await readJson(env, 'base.json', null);
      if (found && value) return value;
    } catch (_) { /* ignore */ }
    return { about: '', tools: [] };
  }
}
