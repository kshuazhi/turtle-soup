import express from 'express';
import compression from 'compression';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  listStories,
  getStory,
  detailStory,
  addStory,
  deleteStory,
  revealStory,
  incViews,
  toggleLike,
  allTags,
  stats,
  recordAnswer,
  storyPool,
  store
} from './src/store.js';
import { rateLimit } from './src/ratelimit.js';
import {
  startRooms,
  createRoom,
  listRooms,
  pruneDeadRooms,
  joinRoom,
  resumeRoom,
  renameMember,
  hostSetPuzzle,
  setReady,
  startGame,
  hostUseStory,
  askQuestion,
  hostAnswer,
  hostHint,
  hostSay,
  assignRole,
  revokeRole,
  sendChat,
  sendWhisper,
  requestHint,
  answerHintRequest,
  endRound,
  submitGuess,
  hostGetStory,
  hostReveal,
  hostNextRound,
  transferHost,
  leaveRoom,
  closeRoom,
  attachClient,
  roomsStats
} from './src/rooms.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3300;
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_KEY = process.env.ADMIN_KEY || '';

store.load();
startRooms();

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(compression());
app.use(express.json({ limit: '64kb' }));

// 基础安全响应头
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

/* ------------------------------ 访客身份 ------------------------------ */

function visitorKey(req, res) {
  const m = /(?:^|;\s*)ts_vid=([a-f0-9]{16,40})/.exec(req.headers.cookie || '');
  let vid = m ? m[1] : '';
  if (!vid) {
    vid = crypto.randomBytes(12).toString('hex');
    res.setHeader('Set-Cookie', `ts_vid=${vid}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`);
    req.headers.cookie = (req.headers.cookie ? req.headers.cookie + '; ' : '') + `ts_vid=${vid}`;
  }
  return crypto.createHash('sha1').update(vid).digest('hex').slice(0, 16);
}

const answerCache = new Map(); // key -> { a, at }
const ANSWER_TTL = 2 * 60 * 60 * 1000;

/* ------------------------------ API ------------------------------ */

const api = express.Router();

api.get('/health', (req, res) => {
  res.json({ ok: true, time: Date.now() });
});

api.get('/stats', (req, res) => {
  res.json({ ...stats(), ...roomsStats() });
});

api.get('/tags', (req, res) => {
  res.json({ tags: allTags() });
});

api.get('/stories', (req, res) => {
  const { page, size, q, tag, sort } = req.query;
  res.json(listStories({ page, size, q, tag, sort }));
});

api.get('/stories/random', (req, res) => {
  const pool = storyPool();
  if (!pool.length) return res.status(404).json({ error: '题库还是空的' });
  const exclude = String(req.query.exclude || '');
  const candidates = pool.filter((s) => s.id !== exclude);
  const pickFrom = candidates.length ? candidates : pool;
  res.json({ id: pickFrom[Math.floor(Math.random() * pickFrom.length)].id });
});

api.get('/stories/:id', (req, res) => {
  const s = getStory(req.params.id);
  if (!s) return res.status(404).json({ error: '这道汤不存在或已下架' });
  incViews(s);
  res.json(detailStory(s));
});

api.post('/stories', rateLimit({ windowMs: 10 * 60_000, max: 20 }), (req, res, next) => {
  try {
    const story = addStory(req.body || {}, 'user');
    res.status(201).json(detailStory(story));
  } catch (err) {
    next(err);
  }
});

api.delete('/stories/:id', (req, res) => {
  const key = String(req.headers['x-admin-key'] || req.query.key || '');
  if (!ADMIN_KEY) {
    return res.status(403).json({ error: '服务器未配置 ADMIN_KEY，删除功能不可用' });
  }
  const a = Buffer.from(key);
  const b = Buffer.from(ADMIN_KEY);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(403).json({ error: '管理员密钥不正确' });
  }
  if (!deleteStory(req.params.id)) return res.status(404).json({ error: '这道汤不存在' });
  res.json({ ok: true });
});

api.post('/stories/:id/reveal', (req, res) => {
  const s = getStory(req.params.id);
  if (!s) return res.status(404).json({ error: '这道汤不存在或已下架' });
  revealStory(s);
  res.json({ ok: true, solution: s.solution });
});

api.post('/stories/:id/like', (req, res) => {
  const s = getStory(req.params.id);
  if (!s) return res.status(404).json({ error: '这道汤不存在或已下架' });
  res.json(toggleLike(s, !!req.body?.like, visitorKey(req, res)));
});

api.post('/stories/:id/hint', rateLimit({ windowMs: 60_000, max: 40 }), (req, res) => {
  const s = getStory(req.params.id);
  if (!s) return res.status(404).json({ error: '这道汤不存在或已下架' });
  const hints = s.hints || [];
  const count = Math.min(Math.max(parseInt(req.body?.count, 10) || 1, 0), hints.length);
  res.json({ hints: hints.slice(0, count), total: hints.length });
});

api.post('/stories/:id/answer', rateLimit({ windowMs: 60_000, max: 40 }), (req, res) => {
  const s = getStory(req.params.id);
  if (!s) return res.status(404).json({ error: '这道汤不存在或已下架' });

  const vid = visitorKey(req, res);
  const key = s.id + ':' + vid;

  const norm = (t) =>
    String(t || '')
      .toLowerCase()
      .replace(/[\s\p{P}\p{S}]/gu, '');

  const guess = norm(req.body?.answer);
  if (!guess) return res.status(400).json({ error: '先写下你的推理吧' });
  if (guess.length > 500) return res.status(400).json({ error: '推理太长了，精简一下' });

  const cached = answerCache.get(key);
  const correctByMemo = cached && cached.a === guess && Date.now() - cached.at < ANSWER_TTL;
  const correctBySolution = guess === norm(s.solution);

  const correct = !!(correctByMemo || correctBySolution);
  if (correct) {
    answerCache.set(key, { a: guess, at: Date.now() });
    if (answerCache.size > 5000) answerCache.clear();
    recordAnswer(s, true);
  }
  res.json(correct ? { correct, solution: s.solution } : { correct });
});


/* ------------------------------ 联机房间 ------------------------------ */

const roomApi = express.Router();
// 只限制房间接口：挂成全局会连带 /api/stories 等一起计数，正常浏览也会被 429
roomApi.use('/rooms', rateLimit({ windowMs: 60_000, max: 150 }));

roomApi.get('/rooms', (req, res) => {
  pruneDeadRooms();
  res.json({ rooms: listRooms() });
});

// 创建房间：只需要名字，进来后由主持人写题
roomApi.post('/rooms', rateLimit({ windowMs: 10 * 60_000, max: 10 }), (req, res, next) => {
  try {
    const room = createRoom({ hostName: req.body?.name, mode: req.body?.mode });
    const host = room.members.find((m) => m.id === room.hostId);
    res.status(201).json({ code: room.code, memberId: host.id, token: host.token, title: room.title });
  } catch (err) {
    next(err);
  }
});

roomApi.post('/rooms/join', (req, res, next) => {
  try {
    const { room, member } = joinRoom({ code: req.body?.code, name: req.body?.name });
    res.json({ code: room.code, memberId: member.id, token: member.token, title: room.title });
  } catch (err) {
    next(err);
  }
});

roomApi.post('/rooms/resume', (req, res, next) => {
  try {
    const { room, member } = resumeRoom({ code: req.body?.code, token: req.body?.token });
    res.json({ code: room.code, memberId: member.id, token: member.token, title: room.title });
  } catch (err) {
    next(err);
  }
});

roomApi.get('/rooms/:code/events', (req, res, next) => {
  try {
    attachClient({ code: req.params.code, token: req.query.token, res });
  } catch (err) {
    if (res.headersSent) return res.end();
    next(err);
  }
});

const roomPost = (path, fn) => {
  roomApi.post('/rooms/:code' + path, (req, res, next) => {
    try {
      const result = fn({ code: req.params.code, token: req.body?.token, body: req.body || {} });
      // submitGuess 会把是否猜中带回来，前端要用它提示；房间对象本身不能下发（含 token 与汤底）
      const extra = result && typeof result === 'object' && typeof result.correct === 'boolean' ? { correct: result.correct } : {};
      res.json({ ok: true, ...extra });
    } catch (err) {
      next(err);
    }
  });
};

// 主持人选题：题库汤底只在这个接口下发给主持人
roomApi.post('/rooms/:code/story', (req, res, next) => {
  try {
    res.json(hostGetStory({ code: req.params.code, token: req.body?.token, storyId: req.body?.storyId }));
  } catch (err) {
    next(err);
  }
});

roomPost('/rename', ({ code, token, body }) => renameMember({ code, token, name: body.name }));
roomPost('/puzzle', ({ code, token, body }) =>
  hostSetPuzzle({
    code,
    token,
    title: body.title,
    surface: body.surface,
    solution: body.solution,
    hints: body.hints
  })
);
roomPost('/use-story', ({ code, token, body }) => hostUseStory({ code, token, storyId: body.storyId }));
roomPost('/ready', ({ code, token, body }) => setReady({ code, token, ready: body.ready }));
roomPost('/start', ({ code, token, body }) =>
  startGame({ code, token, title: body.title, surface: body.surface, solution: body.solution, hints: body.hints })
);
roomPost('/ask', ({ code, token, body }) => askQuestion({ code, token, text: body.text }));
roomPost('/answer', ({ code, token, body }) =>
  hostAnswer({ code, token, messageId: body.messageId, answer: body.answer })
);
roomPost('/hint', ({ code, token, body }) => hostHint({ code, token, text: body.text }));
roomPost('/role', ({ code, token, body }) =>
  assignRole({ code, token, memberId: body.memberId, name: body.name, desc: body.desc, goal: body.goal })
);
roomPost('/role-clear', ({ code, token, body }) => revokeRole({ code, token, memberId: body.memberId }));
roomPost('/chat', ({ code, token, body }) => sendChat({ code, token, text: body.text }));
roomPost('/whisper', ({ code, token, body }) => sendWhisper({ code, token, toId: body.toId, text: body.text }));
roomPost('/hint-request', ({ code, token, body }) => requestHint({ code, token, text: body.text }));
roomPost('/hint-answer', ({ code, token, body }) =>
  answerHintRequest({ code, token, messageId: body.messageId, accept: !!body.accept, text: body.text })
);
roomPost('/end', ({ code, token, body }) => endRound({ code, token, solution: body.solution }));
roomPost('/say', ({ code, token, body }) => hostSay({ code, token, text: body.text }));
roomPost('/guess', ({ code, token, body }) => submitGuess({ code, token, text: body.text }));
roomPost('/next-round', ({ code, token }) => hostNextRound({ code, token }));
roomPost('/reveal', ({ code, token }) => hostReveal({ code, token }));
roomPost('/host', ({ code, token, body }) => transferHost({ code, token, memberId: body.memberId }));
roomPost('/leave', ({ code, token }) => leaveRoom({ code, token }));
roomPost('/close', ({ code, token }) => closeRoom({ code, token }));

// 房间路由必须先于接口兜底挂载，否则未知路由会被提前兜底
app.use('/api', roomApi);
api.use((req, res) => res.status(404).json({ error: '接口不存在' }));
app.use('/api', api);

/* ------------------------------ 静态资源 ------------------------------ */

const publicDir = path.join(__dirname, 'public');
app.use(
  '/assets',
  express.static(path.join(publicDir, 'assets'), {
    index: false,
    // 静态资源没有构建 hash：用协商缓存，否则前端改完还要等一周缓存过期
    setHeaders(res) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  })
);
app.use(
  express.static(publicDir, {
    maxAge: '1h',
    index: 'index.html',
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    }
  })
);

// 单页路由回退
app.get(['/play/:id', '/new', '/about', '/rooms', '/rooms/custom', '/rooms/preset', '/room/:code'], (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

/* ------------------------------ 错误处理 ------------------------------ */

app.use((err, req, res, next) => {
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: '提交内容过大' });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: '请求格式不正确' });
  }
  console.error('[server]', err);
  if (res.headersSent) return next(err);
  res.status(err?.status || 500).json({ error: err?.status ? err.message : '服务器开小差了，请稍后再试' });
});

/* ------------------------------ 启动 ------------------------------ */

const server = app.listen(PORT, HOST, () => {
  console.log('');
  console.log('  海龟汤已启动');
  console.log(`  本机访问   http://127.0.0.1:${PORT}`);
  console.log(`  监听地址   ${HOST}:${PORT}`);
  if (!ADMIN_KEY) console.log('  提示：未设置 ADMIN_KEY，删除接口已关闭（可选）');
  console.log('');
});

function shutdown(signal) {
  console.log(`\n[server] 收到 ${signal}，正在保存数据并退出…`);
  server.close(() => {
    try { store.flush(); } catch (e) { console.error(e.message); }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

