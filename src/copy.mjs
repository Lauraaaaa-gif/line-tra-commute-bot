import fs from 'node:fs';
import { defaultCopy, validateCopy } from './copy-core.mjs';
export { defaultCopy, validateCopy } from './copy-core.mjs';

export class CopyBook {
  constructor({ file = new URL('../copy.zh-TW.json', import.meta.url), logger = console } = {}) {
    this.file = file; this.logger = logger; this.value = defaultCopy; this.last = undefined;
  }
  reload() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      if (raw === this.last) return;
      this.last = raw;
      this.value = validateCopy(JSON.parse(raw));
    } catch { this.logger.error('COPY_INVALID: keeping last valid wording'); }
  }
  text(key, data = {}) {
    this.reload();
    const item = this.value[key];
    const text = Array.isArray(item) ? item.join('\n') : item;
    return text.replace(/\{(\w+)\}/g, (_, name) => stringValue(data[name]));
  }
}
function stringValue(value) { return value === undefined || value === null ? '—' : String(value); }
export const copyBook = new CopyBook();
