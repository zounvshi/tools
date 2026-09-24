// functions/api/_shared/store.js
// R2 对象存储作为「数据真相源」（替代 GitHub 仓库）。
// 数据对象存放在 TOOLS_BUCKET 的 data/ 前缀下：
//   data/tools.json   -> { about, tools:[...] }
//   data/pending.json -> [ ... ]
// 用户上传的二进制文件存放在 tools/ 前缀（见 submit.js / admin.js，直接用 env.TOOLS_BUCKET）。
//
// 为什么可行：Cloudflare R2 对单对象 PUT 提供「写后强一致」，每次读都拿最新值，
// 配合前端 cache:'no-store' 即可满足「审批后实时可见 / 缓存失效」。
// 不再需要任何 GitHub 令牌（GITHUB_TOKEN），也不需要信用卡。

const DATA_PREFIX = 'data/';

// 读取 JSON 对象：缺失返回 { value: defaultVal, etag: null, found: false }
export async function readJson(env, key, defaultVal) {
  if (!env.TOOLS_BUCKET) throw new Error('服务端未绑定 R2 存储桶（TOOLS_BUCKET）');
  const obj = await env.TOOLS_BUCKET.get(DATA_PREFIX + key);
  if (!obj) return { value: defaultVal, etag: null, found: false };
  try {
    return { value: JSON.parse(await obj.text()), etag: obj.etag || null, found: true };
  } catch (e) {
    return { value: defaultVal, etag: obj.etag || null, found: true };
  }
}

// 乐观锁 + 自动重试的「读-改-写」。
// mutator(value) 必须返回新的对象/数组；value 已用 defaultVal 兜底。
// 并发冲突（ETag 不匹配）时最多重试 retries 次，避免覆盖丢失。
export async function updateJson(env, key, mutator, defaultVal = null, retries = 5) {
  const fullKey = DATA_PREFIX + key;
  if (!env.TOOLS_BUCKET) throw new Error('服务端未绑定 R2 存储桶（TOOLS_BUCKET）');
  for (let i = 0; i < retries; i++) {
    const { value, etag } = await readJson(env, key, defaultVal);
    const next = mutator(value);
    const opts = { httpMetadata: { contentType: 'application/json' } };
    // 已存在则要求 ETag 匹配（乐观锁）；不存在则仅当「不存在」时创建
    opts.onlyIf = etag ? { etagMatches: etag } : { etagDoesNotMatch: '*' };
    const res = await env.TOOLS_BUCKET.put(fullKey, JSON.stringify(next, null, 2), opts);
    if (res) return next; // 写入成功
    // 竞争失败，重试
  }
  throw new Error('数据写入冲突，请重试');
}

// 直接删除一个数据对象（一般不用，保留以便将来清理）
export async function deleteJson(env, key) {
  if (!env.TOOLS_BUCKET) throw new Error('服务端未绑定 R2 存储桶（TOOLS_BUCKET）');
  await env.TOOLS_BUCKET.delete(DATA_PREFIX + key);
}

// 无条件写入（last-writer-wins，用于缓存 GitHub 基础数据；非权威数据，可接受短暂陈旧）
export async function putRaw(env, key, text, contentType = 'application/json') {
  if (!env.TOOLS_BUCKET) throw new Error('服务端未绑定 R2 存储桶（TOOLS_BUCKET）');
  await env.TOOLS_BUCKET.put(DATA_PREFIX + key, text, { httpMetadata: { contentType } });
}
