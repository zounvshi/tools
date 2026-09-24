// functions/api/_shared/auth.js
// 共享鉴权模块（Cloudflare Workers 运行时，使用 Web Crypto）
// 提供：HMAC 令牌签发/校验、密码 sha256、请求取令牌、角色校验、JSON 响应助手。

const enc = new TextEncoder();

// ---------- base64url 工具 ----------
function strToB64url(str) {
  // 处理 Unicode
  const b64 = btoa(unescape(encodeURIComponent(str)));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlToStr(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return decodeURIComponent(escape(atob(s)));
}
function abToB64url(ab) {
  const bytes = new Uint8Array(ab);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ---------- 密码哈希 ----------
export async function sha256Hex(str) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(str));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------- 令牌签发/校验（HS256 风格，自实现 HMAC）----------
export async function signToken(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const h = strToB64url(JSON.stringify(header));
  const p = strToB64url(JSON.stringify(payload));
  const data = h + '.' + p;
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return data + '.' + abToB64url(sig);
}

export async function verifyToken(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      enc.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify']
    );
    const ok = await crypto.subtle.verify(
      'HMAC',
      key,
      b64urlToBytes(sig),
      enc.encode(h + '.' + p)
    );
    if (!ok) return null;
    const payload = JSON.parse(b64urlToStr(p));
    if (payload.exp && Date.now() / 1000 > payload.exp) return null; // 过期
    return payload;
  } catch (e) {
    return null;
  }
}

// 从请求中取令牌：Authorization: Bearer <t> 或 ?token=
export function getToken(request) {
  const auth = request.headers.get('Authorization');
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const url = new URL(request.url);
  const q = url.searchParams.get('token');
  return q || '';
}

// 校验角色：role='user' 表示 用户或管理员 均可；role='admin' 仅管理员
export async function requireRole(request, env, role) {
  const payload = await verifyToken(getToken(request), env.AUTH_SECRET);
  if (!payload) return null;
  if (role === 'admin' && payload.role !== 'admin') return null;
  return payload;
}

// 解析管理员名单（向后兼容旧 ADMIN_PASSWORD）
export function parseAdmins(env) {
  if (env.ADMIN_CREDENTIALS && env.ADMIN_CREDENTIALS.trim()) {
    try {
      const arr = JSON.parse(env.ADMIN_CREDENTIALS);
      if (Array.isArray(arr)) return arr;
    } catch (e) {
      /* 解析失败则回退 */
    }
  }
  if (env.ADMIN_PASSWORD) {
    return [{ user: 'admin', pass: env.ADMIN_PASSWORD }];
  }
  return [];
}

// JSON 响应助手
export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
