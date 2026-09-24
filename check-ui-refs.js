// 校验 index.html：脚本里引用的 DOM id 是否都存在、onclick 调用的函数是否都已定义或暴露。
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

// 收集 HTML 中定义的 id
const ids = new Set();
for (const m of html.matchAll(/\sid="([^"]+)"/g)) ids.add(m[1]);

// 收集内联脚本正文
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join('\n');
const all = html;

let bad = 0;

// 1) getElementById('x') / getElementById("x") → 必须存在于 HTML
const refIds = new Set([...scripts.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]));
for (const id of refIds) {
  if (!ids.has(id)) { bad++; console.error(`✗ getElementById('${id}') 引用了不存在的 id`); }
}
console.log(`检查 getElementById 引用 ${refIds.size} 个 → ${bad ? '有缺失' : '全部存在'}`);

// 2) onclick="fn(" → 函数必须定义或出现在 window 暴露列表
const called = new Set([...all.matchAll(/on(?:click|change|input|submit)="([a-zA-Z_$][\w$]*)\s*\(/g)].map((m) => m[1]));
const definedFns = new Set([...scripts.matchAll(/function\s+([a-zA-Z_$][\w$]*)\s*\(/g)].map((m) => m[1]));
const exposeLine = (scripts.match(/Object\.assign\(window,\s*\{([\s\S]*?)\}\)/) || [])[1] || '';
const exposedFns = new Set(exposeLine.split(',').map((s) => s.trim().split(':')[0].trim()).filter(Boolean));
let fnBad = 0;
for (const fn of called) {
  if (!definedFns.has(fn) && !exposedFns.has(fn)) { fnBad++; console.error(`✗ HTML 里调用了未定义的函数：${fn}()`); }
}
console.log(`检查事件调用函数 ${called.size} 个 → ${fnBad ? '有缺失' : '全部已定义或已暴露'}`);

// 3) 本次新增的编辑弹窗必须齐备
const needIds = ['tooledit-overlay', 'toolEditForm', 'teType', 'teName', 'teDesc', 'teIcon', 'teIconFile', 'teIconPreview', 'teAuthor', 'teUrl', 'teFile', 'teFileHint', 'teTags', 'teSaveBtn'];
const needFns = ['openToolEditor', 'closeToolEditor', 'saveToolEdit'];
for (const id of needIds) { if (!ids.has(id)) { bad++; console.error(`✗ 缺少编辑弹窗元素 #${id}`); } }
for (const fn of needFns) { if (!definedFns.has(fn)) { bad++; console.error(`✗ 缺少函数 ${fn}`); } if (!exposedFns.has(fn)) { bad++; console.error(`✗ 函数 ${fn} 未暴露到 window`); } }
console.log(`检查编辑弹窗 ${needIds.length} 个元素 + ${needFns.length} 个函数 → ${bad || fnBad ? '有缺失' : '齐备'}`);

// 4) 确认「✏️ 编辑」按钮已挂到已上线列表
if (!/openToolEditor\(\$\{t\.id\}\)/.test(scripts)) { bad++; console.error('✗ 已上线列表未找到编辑按钮'); }
else console.log('已上线列表的「编辑」按钮已就位');

console.log(bad || fnBad ? '\n❌ 检查未通过' : '\n✅ 全部检查通过');
process.exit(bad || fnBad ? 1 : 0);
