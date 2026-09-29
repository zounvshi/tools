// functions/api/heat.js
// 热度统计：记录用户查看详情、打开在线链接、下载软件三种行为，按权重累加。
//   POST { id, action }  action ∈ { view, open, download }
//   GET                 返回热度 Top10（含工具名称、图标）
// 数据存 R2 data/heat.json：{ scores: { [toolId]: number } }

import { json } from './_shared/auth.js';
import { readJson, updateJson } from './_shared/store.js';

const WEIGHTS = {
  view: 1,      // 查看使用说明 / 详情
  open: 2,      // 打开在线链接
  download: 3,  // 下载软件
};

export async function onRequest(context) {
  const { request, env } = context;
  if (!env.TOOLS_BUCKET) return json({ error: '服务端未绑定 R2 存储桶（TOOLS_BUCKET）' }, 500);

  if (request.method === 'GET') {
    return await getHeat(env);
  }

  if (request.method === 'POST') {
    let body = {};
    try { body = await request.json(); } catch (e) {}
    const id = body.id == null ? null : String(body.id);
    const action = String(body.action || '').toLowerCase();
    if (!id || !WEIGHTS[action]) {
      return json({ error: '参数错误：需要 id 和 action（view / open / download）' }, 400);
    }
    return await addHeat(env, id, action);
  }

  return new Response('Method Not Allowed', { status: 405 });
}

async function addHeat(env, id, action) {
  await updateJson(
    env,
    'heat.json',
    (prev) => {
      const scores = prev && typeof prev === 'object' && prev.scores ? prev.scores : {};
      const add = WEIGHTS[action];
      const old = Number(scores[id] || 0);
      scores[id] = old + add;
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
