// functions/api/admin-import.js
// 管理员批量导入用户：
//   1) POST multipart/form-data(file=xxx.xlsx|xxx.csv) -> 预览：返回列名、数据行、推断的账号列
//   2) POST application/json({rows, userCol, passCol, skipHeader, defaultPass}) -> 确认导入
import { requireRole, json, sha256Hex, parseAdmins } from './_shared/auth.js';
import { readJson, updateJson } from './_shared/store.js';
import { parseXlsx, parseCsv, guessUserCol } from './_shared/parse-sheet.js';

function isHeaderRow(columns) {
  const kw = ['员工', '姓名', '账号', '用户', '工号', '部门', '分公司', 'id', 'name', 'user', 'account', 'login', 'password', '域'];
  return columns.some((c) => kw.some((k) => (c || '').toLowerCase().includes(k.toLowerCase())));
}

function adminNames(env) {
  try { return parseAdmins(env).map((a) => a.user); } catch (e) { return []; }
}

export async function onRequest(context) {
  const { request, env } = context;
  const payload = await requireRole(request, env, 'admin');
  if (!payload) return json({ error: '需要管理员权限' }, 401);

  const ct = request.headers.get('content-type') || '';

  // ---- 1) 预览（上传文件）----
  if (ct.includes('multipart/form-data')) {
    let fd;
    try { fd = await request.formData(); } catch (e) { return json({ error: '解析上传失败' }, 400); }
    const file = fd.get('file');
    if (!file) return json({ error: '未收到文件' }, 400);
    const buf = new Uint8Array(await file.arrayBuffer());
    const fname = (file.name || '').toLowerCase();
    let rows;
    if (fname.endsWith('.xlsx')) {
      try { rows = await parseXlsx(buf); } catch (e) { return json({ error: 'xlsx 解析失败：' + (e && e.message ? e.message : e) }, 500); }
    } else if (fname.endsWith('.csv')) {
      rows = parseCsv(new TextDecoder().decode(buf));
    } else {
      return json({ error: '仅支持 .xlsx 或 .csv 文件' }, 400);
    }
    if (!rows || !rows.length) return json({ error: '文件为空或无数据' }, 400);
    const columns = rows[0];
    const guessedUserCol = guessUserCol(columns);
    return json({ ok: true, columns, rows, guessedUserCol, headerDetected: isHeaderRow(columns) });
  }

  // ---- 2) 确认导入（JSON）----
  if (ct.includes('application/json')) {
    let body;
    try { body = await request.json(); } catch (e) { return json({ error: '请求格式错误' }, 400); }
    const { rows, userCol, passCol, skipHeader, defaultPass } = body;
    if (!Array.isArray(rows) || userCol == null) return json({ error: '参数缺失（rows / userCol）' }, 400);
    const dp = defaultPass ? String(defaultPass) : '123456';
    const dataRows = skipHeader ? rows.slice(1) : rows;

    const admins = adminNames(env);
    const { value: users } = await readJson(env, 'users.json', []);
    const arr = Array.isArray(users) ? users : [];
    const existing = new Set(arr.map((x) => x.user));
    const adminSet = new Set(admins);
    const toAdd = [];
    let created = 0, skipped = 0;
    for (const r of dataRows) {
      const username = String(r[userCol] || '').trim();
      if (!username) continue;
      if (existing.has(username) || adminSet.has(username)) { skipped++; continue; }
      const pw = (passCol != null && passCol >= 0 && r[passCol] != null && String(r[passCol]).trim())
        ? String(r[passCol]).trim()
        : dp;
      toAdd.push({ user: username, hash: await sha256Hex(pw), role: 'user', createdAt: new Date().toISOString() });
      existing.add(username);
      created++;
    }
    if (toAdd.length) {
      try {
        await updateJson(env, 'users.json', (list) => {
          const a = Array.isArray(list) ? list : [];
          return a.concat(toAdd);
        }, []);
      } catch (e) { return json({ error: '写入失败：' + (e && e.message ? e.message : e) }, 500); }
    }
    return json({ success: true, created, skipped, message: `成功导入 ${created} 个用户，跳过 ${skipped} 个（已存在/管理员）` });
  }

  return json({ error: '不支持的请求类型' }, 400);
}
