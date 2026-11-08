// 从备份恢复题库数据：npm run data:restore -- backups/db-xxx.json
import fs from 'node:fs';
import path from 'node:path';

const file = process.argv[2];
if (!file) {
  console.error('用法：npm run data:restore -- backups/db-xxx.json');
  process.exit(1);
}

const src = path.resolve(file);
if (!fs.existsSync(src)) {
  console.error('[restore] 备份不存在：' + src);
  process.exit(1);
}

const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
fs.mkdirSync(dataDir, { recursive: true });
const dest = path.join(dataDir, 'db.json');
if (fs.existsSync(dest)) fs.copyFileSync(dest, dest + '.before-restore-' + Date.now());
fs.copyFileSync(src, dest);
console.log('[restore] 已恢复 ' + dest + '（重启服务后生效）');
