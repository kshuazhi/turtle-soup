// 海龟汤投稿（Pull Request）加载器：
// 维护者人工核查并合并到 submissions/ 下的 JSON 文件，会在下次启动/部署时自动入库。
import fs from 'node:fs';
import path from 'node:path';
import { normalizeTags } from './tags.js';

const DIR = path.join(process.cwd(), 'submissions');

const LIMITS = {
  title: 40,
  surface: 1000,
  solution: 3000,
  hint: 200,
  maxHints: 8,
  files: 500
};

function clean(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim().slice(0, max);
}

function makeId(file) {
  const base = file
    .replace(/\.json$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return 'pr_' + (base || 'soup');
}

export function loadSubmissions() {
  const out = [];
  let files = [];
  try {
    files = fs
      .readdirSync(DIR)
      .filter((f) => f.toLowerCase().endsWith('.json') && !f.startsWith('_'))
      .sort();
  } catch {
    return out;
  }

  const seen = new Set();
  for (const file of files.slice(0, LIMITS.files)) {
    const full = path.join(DIR, file);
    try {
      const raw = JSON.parse(fs.readFileSync(full, 'utf8'));
      const title = clean(raw.title, LIMITS.title);
      const surface = clean(raw.surface, LIMITS.surface);
      const solution = clean(raw.solution, LIMITS.solution);
      if (!title || !surface || !solution) {
        console.warn('[submissions] 跳过 ' + file + '：title / surface / solution 必填');
        continue;
      }
      let id = makeId(file);
      if (seen.has(id)) id = id + '-' + (seen.size + 1);
      seen.add(id);
      out.push({
        id,
        source: 'pr',
        title,
        surface,
        solution,
        hints: Array.isArray(raw.hints)
          ? raw.hints.map((h) => clean(h, LIMITS.hint)).filter(Boolean).slice(0, LIMITS.maxHints)
          : [],
        // 非白名单标签直接丢弃；一个都不合法就是空数组
        tags: normalizeTags(raw.tags),
        createdAt: fs.statSync(full).mtimeMs || Date.now()
      });
    } catch (err) {
      console.warn('[submissions] 跳过 ' + file + '：' + err.message);
    }
  }
  return out;
}

export { DIR as SUBMISSIONS_DIR };
