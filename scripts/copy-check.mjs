import fs from 'node:fs';
import { validateCopy } from '../src/copy.mjs';
import { timetableText, arrivalText } from '../src/messages.mjs';
try {
  validateCopy(JSON.parse(fs.readFileSync(new URL('../copy.zh-TW.json', import.meta.url), 'utf8')));
  const train = { number: 'DEMO', type: '區間車', departure: '17:48', arrival: '18:12' };
  const result = { from: '新左營', to: '大湖', date: '2026-08-29', time: '17:42', trains: [train] };
  console.log('文案格式正確。以下是人工資料預覽，不會發送 LINE 訊息。\n');
  console.log(timetableText(result));
  console.log('\n--- 選擇班次後 ---\n' + arrivalText(result, train));
} catch {
  console.error('文案格式有誤：請檢查 copy.zh-TW.json 的雙引號、逗號、欄位名稱及 {變數}。未發送訊息。');
  process.exitCode = 1;
}
