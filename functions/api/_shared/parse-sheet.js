// functions/api/_shared/parse-sheet.js
// 无第三方依赖的表格解析：支持 .xlsx（zip + deflate-raw 解压 + XML 提取）与 .csv。
// 用于管理员批量导入用户。Cloudflare Workerd 与 Node 18+ 均原生支持 DecompressionStream。

// ---------- ZIP 本地文件头扫描 ----------
function rdU16(b, p) { return b[p] | (b[p + 1] << 8); }
function rdU32(b, p) { return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0; }

function findLocalHeaders(buf) {
  const entries = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    if (rdU32(buf, off) !== 0x04034b50) { off++; continue; }
    const method = rdU16(buf, off + 8);
    const compSize = rdU32(buf, off + 18);
    const fnameLen = rdU16(buf, off + 26);
    const extraLen = rdU16(buf, off + 28);
    const nameStart = off + 30;
    let name = '';
    for (let i = 0; i < fnameLen; i++) name += String.fromCharCode(buf[nameStart + i]);
    const dataStart = nameStart + fnameLen + extraLen;
    entries.push({ name, method, data: buf.subarray(dataStart, dataStart + compSize) });
    off = dataStart + compSize;
  }
  return entries;
}

async function inflateRaw(bytes) {
  const tryInflate = async (fmt) => {
    const ds = new DecompressionStream(fmt);
    const w = ds.writable.getWriter();
    w.write(bytes);
    w.close();
    return new Uint8Array(await new Response(ds.readable).arrayBuffer());
  };
  try { return await tryInflate('deflate-raw'); }
  catch (e) { return await tryInflate('deflate'); }
}

// ---------- 解析 xlsx ----------
export async function parseXlsx(buf) {
  const entries = findLocalHeaders(buf);
  const map = {};
  for (const e of entries) {
    let data = e.data;
    if (e.method === 8) {
      try { data = await inflateRaw(e.data); } catch (err) { continue; }
    }
    map[e.name] = data;
  }

  // 共享字符串表
  const ss = [];
  if (map['xl/sharedStrings.xml']) {
    const xml = new TextDecoder().decode(map['xl/sharedStrings.xml']);
    const siRe = /<si>([\s\S]*?)<\/si>/g;
    let m;
    while ((m = siRe.exec(xml))) {
      const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g;
      let mm;
      let s = '';
      while ((mm = tRe.exec(m[1]))) s += mm[1];
      ss.push(s);
    }
  }

  // 选取工作表（优先 sheet1，否则第一个 worksheets 下文件）
  let sheetName = Object.keys(map).find((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  if (!sheetName) sheetName = Object.keys(map).find((n) => n.startsWith('xl/worksheets/'));
  if (!sheetName) return [];

  const sxml = new TextDecoder().decode(map[sheetName]);
  const rows = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let r;
  while ((r = rowRe.exec(sxml))) {
    const rowXml = r[1];
    const cells = [];
    const cRe = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;
    let c;
    while ((c = cRe.exec(rowXml))) {
      const attrs = c[1];
      const inner = c[2];
      const tM = /t="([^"]+)"/.exec(attrs);
      const t = tM ? tM[1] : '';
      let val = '';
      if (t === 's') {
        const vM = /<v>([\s\S]*?)<\/v>/.exec(inner);
        if (vM) { const idx = parseInt(vM[1], 10); val = ss[idx] !== undefined ? ss[idx] : ''; }
      } else if (t === 'inlineStr') {
        const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g;
        let mm;
        let s = '';
        while ((mm = tRe.exec(inner))) s += mm[1];
        val = s;
      } else {
        const vM = /<v>([\s\S]*?)<\/v>/.exec(inner);
        if (vM) val = vM[1];
      }
      cells.push(val);
    }
    rows.push(cells);
  }
  return rows;
}

// ---------- 解析 csv ----------
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\r') { /* 忽略 */ }
      else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else field += ch;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// ---------- 推断「登录账号」列 ----------
export function guessUserCol(columns) {
  const keys = ['域账号', '账号', '用户', '工号', '登录', 'user', 'account', 'login', 'username', 'employee', 'id', '姓名', 'name'];
  for (const k of keys) {
    const idx = columns.findIndex((c) => (c || '').toString().toLowerCase().includes(k.toLowerCase()));
    if (idx >= 0) return idx;
  }
  return 0;
}
