// functions/api/heat.js
// 热度统计：记录查看详情、打开在线链接、下载软件、收藏、搜索命中五种行为，按权重累加。
//   POST { id, action }            单个工具记分，action ∈ { view, open, download, favorite, search }
//   POST { ids: [...], action }    批量记分（用于「搜索命中」一次给多个结果加分，最多 50 个）
//   GET                            返回热度 Top10（含工具名称、图标）
// 数据存 R2 data/heat.json：{ scores: { [toolId]: number } }

import { json } from './_shared/auth.js';
import { readJson, updateJson } from './_shared/store.js';

// 权重说明：越「重」的行为代表越强的真实使用意图，分值越高
const WEIGHTS = {
  search: 1,    // 搜索命中（出现在搜索结果里）
  view: 1,      // 查看使用说明 / 详情
  open: 2,      // 打开在线链接
  download: 3,  // 下载软件
  favorite: 4,  // 收藏（最强的偏好信号）
};

const MAX_BATCH = 50; // 单次批量最多记 50 个工具，防止刷分

export async function onRequest(context) {
  const { request, env } = context;
  if (!env.TOOLS_BUCKET) return json({ error: '服务端未绑定 R2 存储桶（TOOLS_BUCKET）' }, 500);

  if (request.method === 'GET') {
    return await getHeat(env);
  }

  if (request.method === 'POST') {
    let body = {};
    try { body = await request.json(); } catch (e) {}
    const action = String(body.action || '').toLowerCase();
    if (!WEIGHTS[action]) {
      return json({ error: '参数错误：action 需为 search / view / open / download / favorite' }, 400);
    }

    // 支持单个 id 或批量 ids
    let ids = [];
    if (Array.isArray(body.ids)) ids = body.ids.map(String).filter(Boolean);
    else if (body.id != null) ids = [String(body.id)];
    if (ids.length === 0) {
      return json({ error: '参数错误：需要 id 或 ids' }, 400);
    }
    ids = Array.from(new Set(ids)).slice(0, MAX_BATCH);

    return await addHeat(env, ids, action);
  }

  return new Response('Method Not Allowed', { status: 405 });
}

async function addHeat(env, ids, action) {
  const add = WEIGHTS[action];
  await updateJson(
    env,
    'heat.json',
    (prev) => {
      const scores = prev && typeof prev === 'object' && prev.scores ? prev.scores : {};
      ids.forEach((id) => {
        scores[id] = Number(scores[id] || 0) + add;
      });
      return { scores };
    },
    { scores: {} }
  );
  return await getHeat(env);
}

async function getHeat(env) {
  let scores = {};
  try {
    const h = await readJson(env, 'heat.json', { scores: {} });
    scores = h.value && typeof h.value === 'object' && h.value.scores ? h.value.scores : {};
  } catch (e) {
    scores = {};
  }

  let tools = [];
  try {
    const t = await readJson(env, 'tools.json', { about: '', tools: [] });
    tools = t.value && Array.isArray(t.value.tools) ? t.value.tools : [];
  } catch (e) {
    tools = [];
  }

  const list = Object.entries(scores)
    .map(([id, heat]) => {
      const tool = tools.find((x) => String(x.id) === id);
      return {
        id,
        heat: Number(heat) || 0,
        name: tool ? tool.name : '',
        icon: tool ? (tool.icon || '') : '',
      };
    })
    .filter((x) => x.heat > 0)
    .sort((a, b) => b.heat - a.heat)
    .slice(0, 10);

  return json({ success: true, list });
}
