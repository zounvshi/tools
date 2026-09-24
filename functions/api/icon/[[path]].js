// functions/api/icon/[[path]].js
// GET /api/icon/site/<hash>.png  |  /api/icon/upload/<ts>-<hash>.png
// 从 R2 读出图标二进制直接返回（公开读，供 <img src> 使用；浏览器 img 标签不带 Authorization，故不鉴权）。
export async function onRequestGet(context) {
  const { env, params } = context;
  const raw = (params && params.path) ? (Array.isArray(params.path) ? params.path.join('/') : String(params.path)) : '';
  let key;
  try { key = decodeURIComponent(raw); } catch (e) { return new Response('Bad key', { status: 400 }); }

  if (!key || key.indexOf('..') >= 0 || key.startsWith('/')) return new Response('Bad key', { status: 400 });
  if (!/^(site|upload)\//.test(key)) return new Response('Bad key', { status: 400 });
  if (!env.TOOLS_BUCKET) return new Response('R2 未绑定（TOOLS_BUCKET）', { status: 500 });

  const fullKey = 'icons/' + key;
  const obj = await env.TOOLS_BUCKET.get(fullKey);
  if (!obj) return new Response('Not Found', { status: 404 });

  const ct = (obj.httpMetadata && obj.httpMetadata.contentType) || 'image/png';
  return new Response(obj.body, {
    headers: {
      'Content-Type': ct,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
