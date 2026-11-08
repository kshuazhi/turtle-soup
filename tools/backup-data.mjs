// 备份题库数据（翻煮次数 / 喜欢 / 投稿缓存）到 backups/db-<时间戳>.json
import fs from 'node:fs';
import path from 'node:path';

const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const src = path.join(dataDir, 'db.json');
const outDir = process.env.BACKUP_DIR || path.join(process.cwd(), 'backups');

if (!fs.existsSync(src)) {
  console.error('[backup] 没有找到 ' + src + '，先启动一次服务再备份');
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dest = path.join(outDir, 'db-' + stamp + '.json');
fs.copyFileSync(src, dest);
console.log('[backup] 已备份到 ' + dest);
