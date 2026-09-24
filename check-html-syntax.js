// 临时：抽出 index.html 内联脚本做语法检查
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
let m, i = 0, bad = 0;
while ((m = re.exec(html))) {
  i++;
  const code = m[1];
  try { new Function(code); console.log(`OK  内联脚本 #${i}（${code.length} 字符）`); }
  catch (e) { bad++; console.log(`FAIL 内联脚本 #${i}: ${e.message}`); }
}
console.log(bad ? '❌ 存在语法错误' : '✅ 全部内联脚本语法通过');
process.exit(bad ? 1 : 0);
