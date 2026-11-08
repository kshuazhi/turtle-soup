import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { builtinStories } from './stories.js';
import { loadSubmissions } from './submissions.js';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const DATA_FILE = path.join(DATA_DIR, 'db.json');

const LIMITS = {
  title: 40,
  surface: 1000,
  solution: 3000,
  hintText: 200,
  tag: 12,
  maxHints: 8,
  maxTags: 5,
  storiesCap: 1000,
  historyCap: 30
};

const id = (prefix) => prefix + crypto.randomBytes(6).toString('hex');
const now = () => Date.now();

function cleanText(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim().slice(0, max);
}

/* ------------------------------ 持久化 ------------------------------ */

function emptyDb() {
  return { stories: [], deleted: [], seededAt: 0, roomSnapshots: {} };
}

// 内置题库的固定 ID，保证重启后不会重复写入、也不会覆盖已有记录
const builtinId = (i) => 'b_' + String(i + 1).padStart(2, '0');

function seedIfNeeded(db) {
  if (db.seededAt) return;
  const existing = new Set(db.stories.map((s) => s.id));
  const cutoff = Date.now() - builtinStories.length * 1000;
  builtinStories.forEach((s, i) => {
    const bid = builtinId(i);
    if (existing.has(bid)) return;
    db.stories.push({
      id: bid,
      source: 'builtin',
      title: s.title,
      surface: s.surface,
      solution: s.solution,
      hints: (s.hint || []).slice(0, LIMITS.maxHints),
      tags: (s.tags || []).slice(0, LIMITS.maxTags),
      views: 0,
      likes: 0,
      createdAt: cutoff + i * 1000
    });
  });
  db.seededAt = now();
  delete db.meta;
}

let db = emptyDb();
let saveTimer = null;

// 合并进 submissions/ 的 PR 稿件（人工核查通过后）同步进题库；文件被删除则下架
function syncSubmissions(target) {
  const list = loadSubmissions();
  const ids = new Set(list.map((s) => s.id));
  target.stories = target.stories.filter((s) => s.source !== 'pr' || ids.has(s.id));
  const byId = new Map(target.stories.map((s) => [s.id, s]));
  for (const s of list) {
    const existing = byId.get(s.id);
    if (existing) {
      existing.title = s.title;
      existing.surface = s.surface;
      existing.solution = s.solution;
      existing.hints = s.hints;
      existing.tags = s.tags;
      existing.updatedAt = now();
    } else {
      target.stories.push({ ...s, views: 0, likes: 0, createdAt: s.createdAt || now() });
    }
  }
}

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DATA_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      db = {
        stories: Array.isArray(parsed.stories) ? parsed.stories : [],
        deleted: Array.isArray(parsed.deleted) ? parsed.deleted : [],
        seededAt: Number(parsed.seededAt) || 0,
        roomSnapshots:
          parsed.roomSnapshots && typeof parsed.roomSnapshots === 'object' ? parsed.roomSnapshots : {}
      };
    } catch (err) {
      console.error('[store] 数据文件损坏，已备份并重建：', err.message);
      const backup = DATA_FILE + '.broken-' + Date.now();
      try { fs.copyFileSync(DATA_FILE, backup); } catch { /* ignore */ }
      db = emptyDb();
    }
  }
  seedIfNeeded(db);
  syncSubmissions(db);
  flush();
}

function flush() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 0));
  fs.renameSync(tmp, DATA_FILE);
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { flush(); } catch (err) { console.error('[store] 保存失败：', err.message); }
  }, 300);
}

function pruneHistory(h) {
  if (!Array.isArray(h)) return [];
  return h
    .filter((x) => x && typeof x.id === 'string')
    .slice(0, LIMITS.historyCap)
    .map((x) => ({ id: x.id, guess: !!x.guess, at: Number(x.at) || 0 }));
}

/* ------------------------------ 视图 ------------------------------ */

export function publicStory(s) {
  return {
    id: s.id,
    title: s.title,
    surface: s.surface,
    tags: s.tags || [],
    source: s.source,
    views: s.views || 0,
    likes: s.likes || 0,
    hintsCount: (s.hints || []).length,
    createdAt: s.createdAt
  };
}

export function detailStory(s) {
  // 汤底不随详情下发：只有主动“揭晓”（/reveal）或猜中时才返回
  return {
    ...publicStory(s),
    hints: s.hints || []
  };
}

/* ------------------------------ 查询 ------------------------------ */

export function listStories({ page = 1, size = 12, q = '', tag = '', sort = 'new' } = {}) {
  const deleted = new Set(db.deleted);
  let list = db.stories.filter((s) => !deleted.has(s.id));

  const kw = String(q || '').trim().toLowerCase();

  if (tag) {
    list = list.filter((s) => (s.tags || []).includes(tag));
  }
  if (kw) {
    list = list.filter(
      (s) =>
        s.title.toLowerCase().includes(kw) ||
        s.surface.toLowerCase().includes(kw) ||
        (s.tags || []).some((t) => t.toLowerCase().includes(kw))
    );
  }

  if (sort === 'hot') {
    list = list.slice().sort((a, b) => (b.views || 0) + (b.likes || 0) * 5 - ((a.views || 0) + (a.likes || 0) * 5));
  } else if (sort === 'like') {
    list = list.slice().sort((a, b) => (b.likes || 0) - (a.likes || 0));
  } else if (sort === 'random') {
    list = list.slice().sort(() => Math.random() - 0.5);
  } else {
    list = list.slice().sort((a, b) => b.createdAt - a.createdAt);
  }

  const total = list.length;
  const per = Math.min(Math.max(parseInt(size, 10) || 12, 1), 50);
  const pages = Math.max(1, Math.ceil(total / per));
  const p = Math.min(Math.max(parseInt(page, 10) || 1, 1), pages);
  const start = (p - 1) * per;

  return {
    items: list.slice(start, start + per).map(publicStory),
    total,
    page: p,
    pages,
    size: per
  };
}

export function getStory(rawId) {
  const deleted = new Set(db.deleted);
  const s = db.stories.find((x) => x.id === rawId && !deleted.has(x.id));
  return s || null;
}

export function getDeleted() {
  return new Set(db.deleted);
}

export function allTags() {
  const map = new Map();
  const deleted = new Set(db.deleted);
  for (const s of db.stories) {
    if (deleted.has(s.id)) continue;
    for (const t of s.tags || []) map.set(t, (map.get(t) || 0) + 1);
  }
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([name, count]) => ({ name, count }));
}

export function stats() {
  const deleted = new Set(db.deleted);
  const live = db.stories.filter((s) => !deleted.has(s.id));
  return {
    total: live.length,
    views: live.reduce((n, s) => n + (s.views || 0), 0),
    likes: live.reduce((n, s) => n + (s.likes || 0), 0)
  };
}

/* ------------------------------ 写入 ------------------------------ */

export function addStory(input, source = 'user') {
  const title = cleanText(input.title, LIMITS.title);
  const surface = cleanText(input.surface, LIMITS.surface);
  const solution = cleanText(input.solution, LIMITS.solution);
  if (!title || !surface || !solution) {
    const e = new Error('标题、汤面和汤底都必须填写');
    e.status = 400;
    throw e;
  }

  const hints = Array.isArray(input.hints)
    ? input.hints.map((h) => cleanText(h, LIMITS.hintText)).filter(Boolean).slice(0, LIMITS.maxHints)
    : [];

  const tags = Array.isArray(input.tags)
    ? [...new Set(input.tags.map((t) => cleanText(t, LIMITS.tag)).filter(Boolean))].slice(0, LIMITS.maxTags)
    : [];

  const story = {
    id: id('s_'),
    source,
    title,
    surface,
    solution,
    hints,
    tags,
    views: 0,
    likes: 0,
    createdAt: now()
  };

  db.stories.push(story);
  if (db.stories.length > LIMITS.storiesCap) {
    db.stories = db.stories.slice(-LIMITS.storiesCap);
  }
  scheduleSave();
  return story;
}

export function deleteStory(rawId) {
  const idx = db.stories.findIndex((x) => x.id === rawId);
  if (idx === -1 || db.deleted.includes(rawId)) return false;
  db.stories.splice(idx, 1);
  db.deleted.push(rawId);
  if (db.deleted.length > 600) db.deleted = db.deleted.slice(-600);
  scheduleSave();
  return true;
}

export function revealStory(s) {
  if (!s.revealed) {
    s.revealed = true;
    s.revealedAt = now();
    scheduleSave();
  }
}

export function incViews(s) {
  s.views = (s.views || 0) + 1;
  scheduleSave();
}

// 点赞要按访客记：原来用一个全局 s.liked 会让第二个人的点赞无效、第一个人的取消又扣掉别人的赞
export function toggleLike(s, didLike, visitorId) {
  const vid = String(visitorId || 'anon');
  const likedBy = new Set(Array.isArray(s.likedBy) ? s.likedBy : []);
  const has = likedBy.has(vid);
  if (didLike && !has) {
    likedBy.add(vid);
    s.likes = (s.likes || 0) + 1;
  } else if (!didLike && has) {
    likedBy.delete(vid);
    s.likes = Math.max(0, (s.likes || 0) - 1);
  }
  s.likedBy = [...likedBy].slice(-1000);
  delete s.liked;
  scheduleSave();
  return { liked: likedBy.has(vid), likes: s.likes || 0 };
}

export function recordAnswer(s, correct) {
  if (correct && !s.solved) s.solved = true;
  scheduleSave();
}

/* ---------- 房间快照（服务重启后恢复进行中的房间） ---------- */

export function getRoomSnapshots() {
  return db.roomSnapshots || {};
}

export function saveRoomSnapshot(code, snapshot) {
  db.roomSnapshots = db.roomSnapshots || {};
  if (snapshot) db.roomSnapshots[code] = snapshot;
  else delete db.roomSnapshots[code];
  scheduleSave();
}

export function storyPool() {
  const deleted = new Set(db.deleted);
  return db.stories.filter((s) => !deleted.has(s.id));
}

export { LIMITS };
export const store = { load, flush, pruneHistory };
