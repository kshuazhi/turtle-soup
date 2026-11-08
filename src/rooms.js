// 联机房间（主持人模式）：内存管理 + SSE 实时同步 + 断线宽限 + 快照恢复
//
// 玩法：谁创房谁是主持人 → 主持人写汤面 / 汤底（只有自己可见）→ 其他人提问，
// 主持人答「是 / 否 / 无关」→ 有人猜中或主持人公布汤底 → 主持人决定把
// 主持人身份转给谁（或自己继续），开始下一轮。
import crypto from 'node:crypto';
import { getRoomSnapshots, saveRoomSnapshot, getStory } from './store.js';

/* ------------------------------ 字符池 ------------------------------ */

// 易混淆字符（0/O、1/I/L、5/S 等）已剔除
const LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const DIGITS = '23456789';
const POOL = LETTERS + DIGITS;

const CODE_LEN = 6;
const MAX_MEMBERS = 12;
const MAX_ROOMS = 300;
const MAX_MESSAGES = 200;
const JOIN_GRACE_MS = 90_000; // 从没进来过的人，断线后多久释放
const RECONNECT_GRACE_MS = 10 * 60_000; // 进过房间的人，断线后多久释放
const BACKUP_MS = 2_000;
const EMPTY_ROOM_MS = 30 * 60_000;
const HOST_HANDOVER_DELAY_MS = 5_000; // 主持人掉线后先给重连留时间，超时才移交

const rooms = new Map();

/* ------------------------------ 工具 ------------------------------ */

const now = () => Date.now();
const randId = () => crypto.randomBytes(9).toString('base64url');
const randToken = () => crypto.randomBytes(18).toString('base64url');

function clean(v, max) {
  if (typeof v !== 'string') return '';
  return v
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function normName(v) {
  const s = clean(v, 14);
  return s || '游客';
}

function normAnswer(v) {
  return String(v || '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '');
}

function makeCode() {
  let code;
  let guard = 0;
  do {
    code = Array.from({ length: CODE_LEN }, () => POOL[crypto.randomInt(0, POOL.length)]).join('');
    guard += 1;
  } while (rooms.has(code) && guard < 200);
  return code;
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// 猜中判定：完全相同，或答案覆盖了汤底的关键内容（双向包含）
function isCorrect(solution, guess) {
  const sol = normAnswer(solution);
  const g = normAnswer(guess);
  if (!sol || !g) return false;
  if (g === sol) return true;
  const shorter = g.length < sol.length ? g : sol;
  const longer = g.length < sol.length ? sol : g;
  return shorter.length >= 6 && longer.includes(shorter);
}

/* ------------------------------ 房间对象 ------------------------------ */

function newRoom(hostName, mode) {
  if (rooms.size >= MAX_ROOMS) throw httpError(429, '房间有点多，请稍后再试');

  const hostId = randId();
  const room = {
    code: makeCode(),
    title: '等待出题',
    surface: '',
    solution: '', // 只在揭晓后下发
    hints: [], // 主持人私下记的提示
    hostId,
    mode: mode === 'preset' ? 'preset' : 'custom',
    createdAt: now(),
    active: false, // 是否已经有汤面在出题
    revealed: false,
    hintCount: 0,
    round: 1,
    played: false,
    members: [],
    messages: [],
    pendingHintRequests: new Set(),
    lastActivity: now()
  };

  room.members.push({
    id: hostId,
    name: normName(hostName),
    host: true,
    online: false,
    connectedOnce: false,
    lastSeen: now(),
    correctAt: 0,
    ready: true, // 主持人自己不用点准备
    token: randToken(),
    clients: new Set()
  });

  rooms.set(room.code, room);
  persist(room);
  return room;
}

function getMemberByToken(room, token) {
  if (!token) return null;
  return room.members.find((x) => x.token === token) || null;
}

function findMember(room, memberId) {
  return room.members.find((x) => x.id === memberId) || null;
}

// 身份（二级身份）：只给本人和主持人看
function roleState(role) {
  if (!role) return null;
  return {
    name: role.name,
    desc: role.desc || '',
    goal: role.goal || '',
    assignedAt: role.at || 0,
    by: role.by || ''
  };
}

function memberState(m) {
  return {
    id: m.id,
    name: m.name,
    host: !!m.host,
    online: !!m.online,
    ready: !!m.ready,
    correct: !!m.correctAt,
    hasRole: !!m.role
  };
}

function messageState(msg) {
  return {
    id: msg.id,
    kind: msg.kind,
    memberId: msg.memberId || null,
    name: msg.name || '',
    text: msg.text || '',
    answer: msg.answer || null,
    hintReq: msg.hintReq || null, // 提示请求：pending / approved / rejected
    to: msg.to || null, // 私聊接收方 / 只给某个人的通知
    from: msg.from || null, // 私聊发送方
    role: msg.role || null, // 身份通知内容
    at: msg.at
  };
}

// 对外视图：永远不泄露汤底、未解锁提示、以及主持人私下的汤底输入
function roomView(room, viewerId) {
  const guests = room.members.filter((m) => m.id !== room.hostId);
  // 主持人能看所有人的身份；其他人只能看自己的
  const roles = {};
  for (const m of room.members) {
    if (m.role && (m.id === viewerId || viewerId === room.hostId)) {
      roles[m.id] = roleState(m.role);
    }
  }
  return {
    code: room.code,
    title: room.title,
    hostId: room.hostId,
    hostName: room.members.find((m) => m.id === room.hostId)?.name || '',
    mode: room.mode,
    // waiting：还没开局（准备中）；playing：已开局、还没揭晓；revealed：本轮已揭晓
    status: !room.active ? 'waiting' : room.revealed ? 'revealed' : 'playing',
    active: room.active,
    revealed: room.revealed,
    round: room.round,
    createdAt: room.createdAt,
    surface: room.active || room.revealed ? room.surface : '',
    hints: room.active || room.revealed ? room.hints.slice(0, room.hintCount) : [],
    hintsTotal: room.active || room.revealed ? room.hints.length : 0,
    maxMembers: MAX_MEMBERS,
    members: room.members.map(memberState),
    participantCount: guests.length,
    readyCount: guests.filter((m) => m.ready).length,
    canStart: !room.active && guests.length > 0 && room.members.every((m) => m.ready),
    waiting: room.members.filter((m) => !m.ready).map((m) => m.name),
    // 主持人可以旁观所有人的私聊；其他玩家只能看到自己参与的私聊
    pmVisibleToHost: true,
    solution: room.revealed ? room.solution : null,
    roles
  };
}

/* ------------------------------ SSE 广播 ------------------------------ */

function send(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    /* ignore */
  }
}

function emitRoom(room) {
  for (const m of room.members) {
    const view = roomView(room, m.id);
    for (const res of m.clients) {
      send(res, 'room', view);
      if (typeof res.you === 'function') send(res, 'you', res.you());
    }
  }
}

// 一条消息对某个成员是否可见：公共消息所有人可见，私聊只有收发双方可见
function visibleTo(msg, memberId) {
  if (!msg.to) return true;
  return msg.memberId === memberId || msg.to === memberId || msg.from === memberId;
}

// 主持人（房主）可以看到房间里所有私聊；其他人只能看到自己的
function canSee(msg, memberId, hostId) {
  // 身份相关的通知只给被分配的人，主持人不在这里看（主持人在玩家列表里看身份）
  if (msg.kind === 'role') return msg.to === memberId;
  if (memberId === hostId) return true;
  return visibleTo(msg, memberId);
}

function messagesFor(room, memberId) {
  return room.messages
    .filter((m) => canSee(m, memberId, room.hostId))
    .slice(-MAX_MESSAGES)
    .map(messageState);
}

function emitMessages(room) {
  for (const m of room.members) {
    for (const res of m.clients) send(res, 'messages', { messages: messagesFor(room, m.id) });
  }
}

function pushMessage(room, kind, member, text, opts = {}) {
  const msg = {
    id: randId(),
    kind,
    memberId: member ? member.id : null,
    name: member ? member.name : '',
    text: clean(text, 300),
    at: now()
  };
  if (opts.to) {
    msg.to = opts.to; // 私聊接收方
    msg.from = member ? member.id : null;
  }
  room.messages.push(msg);
  if (room.messages.length > MAX_MESSAGES) room.messages.splice(0, room.messages.length - MAX_MESSAGES);
  room.lastActivity = now();
  return msg;
}

function systemMessage(room, text) {
  return pushMessage(room, 'system', null, text);
}

function commit(room) {
  emitRoom(room);
  emitMessages(room);
  persist(room);
}

/* ------------------------------ 快照 ------------------------------ */

function persist(room) {
  const snapshot = {
    code: room.code,
    title: room.title,
    surface: room.surface,
    solution: room.solution,
    hints: room.hints,
    hostId: room.hostId,
    mode: room.mode,
    createdAt: room.createdAt,
    active: room.active,
    revealed: room.revealed,
    hintCount: room.hintCount,
    round: room.round,
    played: !!room.played,
    lastActivity: room.lastActivity,
    members: room.members.map((m) => ({
      id: m.id,
      name: m.name,
      host: !!m.host,
      token: m.token,
      correctAt: m.correctAt,
      ready: !!m.ready,
      role: m.role || null,
      connectedOnce: m.connectedOnce
    })),
    messages: room.messages.slice(-MAX_MESSAGES)
  };
  try {
    saveRoomSnapshot(room.code, snapshot);
  } catch (err) {
    console.error('[rooms] 快照保存失败：', err.message);
  }
}

function restoreRooms() {
  const snaps = getRoomSnapshots();
  for (const [code, s] of Object.entries(snaps)) {
    if (!s || !Array.isArray(s.members) || !s.members.length) {
      saveRoomSnapshot(code, null);
      continue;
    }
    // 重启后保留 30 分钟内还有活动的房间；更早的直接清掉
    if (now() - (s.lastActivity || 0) > EMPTY_ROOM_MS) {
      saveRoomSnapshot(code, null);
      continue;
    }
    const members = s.members.map((m) => ({
      id: m.id,
      name: m.name,
      host: !!m.host,
      online: false,
      connectedOnce: true, // 重启后按“进过房间”对待，给足重连宽限
      lastSeen: now(),
      correctAt: m.correctAt || 0,
      ready: !!m.ready,
      role: m.role && typeof m.role === 'object' ? m.role : null,
      token: m.token,
      clients: new Set()
    }));
    let hostId = s.hostId;
    if (!members.some((m) => m.id === hostId)) hostId = members[0].id;
    members.forEach((m) => (m.host = m.id === hostId));
    rooms.set(code, {
      code,
      title: s.title || '等待出题',
      surface: s.surface || '',
      solution: s.solution || '',
      hints: Array.isArray(s.hints) ? s.hints : [],
      hostId,
      mode: s.mode === 'preset' ? 'preset' : 'custom',
      createdAt: s.createdAt || now(),
      active: !!s.active,
      revealed: !!s.revealed,
      hintCount: Math.min(s.hintCount || 0, (s.hints || []).length),
      round: s.round || 1,
      played: !!s.played,
      members,
      messages: Array.isArray(s.messages) ? s.messages : [],
      pendingHintRequests: new Set(),
      lastActivity: s.lastActivity || now()
    });
  }
  if (rooms.size) console.log(`[rooms] 已恢复 ${rooms.size} 个房间（等待原成员重连）`);
}

/* ------------------------------ 清理 ------------------------------ */

function reassignHost(room, why) {
  const next = room.members.find((m) => m.online) || room.members[0];
  if (!next) return;
  room.members.forEach((m) => (m.host = m.id === next.id));
  room.hostId = next.id;
  systemMessage(room, `${next.name} 成为主持人${why || ''}`);
}

function removeRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  for (const m of room.members) {
    for (const res of m.clients) {
      try {
        send(res, 'closed', { reason: '房间已关闭' });
        res.end();
      } catch {
        /* ignore */
      }
    }
    m.clients.clear();
  }
  rooms.delete(code);
  saveRoomSnapshot(code, null);
}

function sweep() {
  const t = now();
  for (const room of [...rooms.values()]) {
    let changed = false;

    // 剔除长时间离线成员
    const before = room.members.length;
    room.members = room.members.filter((m) => {
      if (m.online || m.clients.size) return true;
      const grace = m.connectedOnce ? RECONNECT_GRACE_MS : JOIN_GRACE_MS;
      return t - m.lastSeen < grace;
    });
    if (room.members.length !== before) changed = true;

    if (!room.members.length) {
      removeRoom(room.code);
      continue;
    }

    // 主持人离开：交给在线的人
    if (!room.members.some((m) => m.id === room.hostId)) {
      reassignHost(room, '接任');
      changed = true;
    }

    // 空房间超时
    if (!room.members.some((m) => m.online) && t - room.lastActivity > EMPTY_ROOM_MS) {
      removeRoom(room.code);
      continue;
    }

    if (changed) commit(room);
  }
}

/* ------------------------------ 对外操作 ------------------------------ */

function mustRoom(code) {
  const room = rooms.get(String(code || '').toUpperCase());
  if (!room) throw httpError(404, '房间不存在或已解散');
  return room;
}

function mustMember(room, token) {
  const member = getMemberByToken(room, token);
  if (!member) throw httpError(401, '身份已失效，请重新加入房间');
  return member;
}

function mustHost(room, member) {
  if (!member) throw httpError(401, '请先用房间身份加入');
  if (member.id !== room.hostId) throw httpError(403, '只有主持人可以进行这个操作');
}

export function createRoom({ hostName, mode }) {
  return newRoom(hostName, mode);
}

// 进大厅时顺手清掉已经没人的房间（断线等待期已过）
export function pruneDeadRooms() {
  const t = now();
  let removed = 0;
  for (const room of [...rooms.values()]) {
    const anyone = room.members.some((m) => m.online || m.clients.size);
    if (!room.members.length || (!anyone && t - room.lastActivity > EMPTY_ROOM_MS)) {
      removeRoom(room.code);
      removed += 1;
    }
  }
  return removed;
}

const STALE_SEEN_MS = 15 * 60_000; // 开局后 15 分钟没人操作，视为已结束

export function listRooms() {
  const t = now();
  return [...rooms.values()]
    // 只展示有人在线的房间；掉线的人也算“不在”
    .filter((r) => r.members.some((m) => m.online) && r.members.length > 0)
    // 开局中但 15 分钟没有任何操作：视为已结束，不再展示
    .filter((r) => !r.active || t - r.lastActivity < STALE_SEEN_MS)
    .map((r) => ({
      code: r.code,
      mode: r.mode,
      title: r.active ? r.title : r.mode === 'preset' ? '题库开桌' : '等待出题',
      hostName: r.members.find((m) => m.id === r.hostId)?.name || '',
      members: r.members.filter((m) => m.online).length,
      maxMembers: MAX_MEMBERS,
      active: r.active,
      revealed: r.revealed,
      round: r.round,
      status: !r.active ? 'waiting' : r.revealed ? 'revealed' : 'playing',
      createdAt: r.createdAt
    }))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 60);
}

export function joinRoom({ code, name }) {
  const room = mustRoom(code);
  const nm = normName(name);
  // 只拦“在线且没有房间身份”的重名：掉线的人可以用同一个名字回来
  if (nm !== '游客' && room.members.some((m) => m.name === nm && m.online)) {
    throw httpError(409, '这个名字已经在房间中了');
  }
  if (room.members.length >= MAX_MEMBERS) throw httpError(409, '房间满了');

  const member = {
    id: randId(),
    name: nm,
    host: false,
    online: false,
    connectedOnce: false,
    lastSeen: now(),
    correctAt: 0,
    ready: false,
    role: null,
    token: randToken(),
    clients: new Set()
  };
  room.members.push(member);
  systemMessage(room, `${nm} 加入了房间`);

  // 局中有人加入：自动回到准备阶段，主持人和老成员重新点准备，下一轮一起开
  if (room.active && !room.revealed) {
    room.active = false;
    room.hintCount = 0;
    for (const m of room.members) m.ready = m.id === room.hostId;
    systemMessage(room, '有人中途加入，先回到准备阶段，一起重新开始');
  }

  commit(room);
  return { room, member };
}

export function resumeRoom({ code, token }) {
  const room = mustRoom(code);
  const member = mustMember(room, token);
  return { room, member };
}

export function renameMember({ code, token, name }) {
  const room = mustRoom(code);
  const member = mustMember(room, token);
  const nm = normName(name);
  if (nm === member.name) return room;
  if (room.members.some((m) => m.id !== member.id && m.name === nm)) {
    throw httpError(409, '这个名字已经被占用了');
  }
  const old = member.name;
  member.name = nm;
  systemMessage(room, `${old} 改名为 ${nm}`);
  commit(room);
  return room;
}

export function setReady({ code, token, ready }) {
  const room = mustRoom(code);
  const member = mustMember(room, token);
  if (room.active) throw httpError(409, '游戏已经开始了');
  if (member.id === room.hostId) throw httpError(403, '主持人不用准备，等大家准备好后点「开始游戏」');
  const next = !!ready;
  if (member.ready === next) return room;
  member.ready = next;
  systemMessage(room, next ? `${member.name} 已准备` : `${member.name} 取消了准备`);
  commit(room);
  return room;
}

// 主持人点「开始游戏」并提交汤面：这一刻才真正开局，广播给所有人
export function startGame({ code, token, title, surface, solution, hints }) {
  const room = mustRoom(code);
  const member = mustMember(room, token);
  mustHost(room, member);
  if (room.active && !room.revealed) throw httpError(409, '这一轮还没结束，先揭晓汤底');

  const notReady = room.members.filter((m) => !m.ready);
  const notReadyNames = notReady.filter((m) => m.id !== member.id).map((m) => m.name);
  if (notReadyNames.length) {
    throw httpError(409, `还有人在准备中：${notReadyNames.join('、')}`);
  }
  if (room.members.length < 2) throw httpError(409, '至少要有 1 名玩家才能开始');

  const r = hostSetPuzzle({ code, token, title, surface, solution, hints });
  // 主持人不需要点准备：开局后立即回到“已准备”，否则下一轮永远开不了
  for (const m of room.members) m.ready = m.id === room.hostId;
  systemMessage(room, '游戏开始');
  commit(room);
  return r;
}

function requireActive(room) {
  if (!room.active) throw httpError(409, '主持人还没有出题');
  if (room.revealed) throw httpError(409, '这一轮已经结束了');
}

// 主持人出题 / 换题
export function hostSetPuzzle({ code, token, title, surface, solution, hints }) {
  const room = mustRoom(code);
  const member = mustMember(room, token);
  mustHost(room, member);

  const t = clean(title, 40);
  const sf = clean(surface, 1000);
  const sol = clean(solution, 3000);
  if (!sf) throw httpError(400, '先写汤面');

  const hs = (Array.isArray(hints) ? hints : [])
    .map((h) => clean(h, 200))
    .filter(Boolean)
    .slice(0, 8);

  room.title = t || '无题';
  room.surface = sf;
  room.solution = sol;
  room.hints = hs;
  room.active = true;
  room.revealed = false;
  room.hintCount = 0;
  room.pendingHintRequests = new Set();
  if (room.played) room.round += 1; // 第一道题算第 1 轮，之后每道题加一轮
  room.played = true;
  for (const m of room.members) {
    m.correctAt = 0;
    m.role = null; // 换了新汤，身份重新分配
  }

  systemMessage(room, `第 ${room.round} 轮开始：主持人 ${member.name} 出了一道汤「${room.title}」`);
  commit(room);
  return room;
}

// 主持人从内置题库挑一道题开桌（可选，预设汤仍然保留）
export function hostUseStory({ code, token, storyId }) {
  const room = mustRoom(code);
  const member = mustMember(room, token);
  mustHost(room, member);
  const s = getStory(String(storyId || ''));
  if (!s) throw httpError(404, '这道汤不存在或已下架');
  const room2 = hostSetPuzzle({
    code,
    token,
    title: s.title,
    surface: s.surface,
    solution: s.solution,
    hints: s.hints || []
  });
  pushMessage(room2, 'story', null, `这一轮的题来自题库：「${s.title}」`);
  commit(room2);
  return room2;
}

// 题库汤底不再随 /api/stories/:id 下发：主持人选题时通过这个接口拿完整题目
export function hostGetStory({ code, token, storyId }) {
  const room = mustRoom(code);
  const member = mustMember(room, token);
  mustHost(room, member);
  const s = getStory(String(storyId || ''));
  if (!s) throw httpError(404, '这道汤不存在或已下架');
  return {
    id: s.id,
    title: s.title,
    surface: s.surface,
    solution: s.solution,
    hints: s.hints || []
  };
}

// 公共聊天：所有人可见（只在游戏进行中开放）
export function sendChat({ code, token, text }) {
  const room = mustRoom(code);
  const member = mustMember(room, token);
  requireActive(room);
  const body = clean(text, 300);
  if (!body) throw httpError(400, '说点什么吧');
  pushMessage(room, 'chat', member, body);
  commit(room);
  return room;
}

// 私聊：只有收发双方可见
export function sendWhisper({ code, token, toId, text }) {
  const room = mustRoom(code);
  const member = mustMember(room, token);
  requireActive(room);
  const target = findMember(room, String(toId || ''));
  if (!target) throw httpError(404, '找不到这位玩家');
  if (target.id === member.id) throw httpError(400, '不能和自己私聊');
  const body = clean(text, 300);
  if (!body) throw httpError(400, '说点什么吧');

  pushMessage(room, 'pm', member, body, { to: target.id });
  commit(room);
  return room;
}

export function askQuestion({ code, token, text }) {
  const room = mustRoom(code);
  const member = mustMember(room, token);
  requireActive(room);
  const body = clean(text, 200);
  if (!body) throw httpError(400, '写点什么再提问吧');
  if (!member.online) throw httpError(409, '你还没连上实时连接，请刷新页面');
  pushMessage(room, 'question', member, body);
  commit(room);
  return room;
}

const ANSWER_LABELS = { yes: '是', no: '否', irrelevant: '无关' };

export function hostAnswer({ code, token, messageId, answer }) {
  const room = mustRoom(code);
  const member = mustMember(room, token);
  mustHost(room, member);
  requireActive(room);
  const label = ANSWER_LABELS[answer];
  if (!label) throw httpError(400, '回答只能是：是、否、无关');

  const target = room.messages.find((m) => m.id === messageId && m.kind === 'question');
  if (!target) throw httpError(404, '没找到这条提问');
  target.answer = label;
  target.answeredBy = member.name;
  target.answeredAt = now();

  pushMessage(room, 'answer', member, `回答「${target.text}」：${label}`);
  commit(room);
  return room;
}

export function hostHint({ code, token, text }) {
  const room = mustRoom(code);
  const member = mustMember(room, token);
  mustHost(room, member);
  requireActive(room);
  const own = clean(text, 200);
  if (own) {
    // 主持人现场写的提示
    room.hints.push(own);
    room.hintCount = room.hints.length;
    pushMessage(room, 'hint', member, own);
  } else {
    if (room.hintCount >= room.hints.length) throw httpError(409, '没有更多提示了，可以在弹窗里自己写一条');
    room.hintCount += 1;
    pushMessage(room, 'hint', member, room.hints[room.hintCount - 1]);
  }
  commit(room);
  return room;
}

// 玩家请求提示（待主持人决定）
export function requestHint({ code, token, text }) {
  const room = mustRoom(code);
  const member = mustMember(room, token);
  requireActive(room);
  if (member.id === room.hostId) throw httpError(403, '你是主持人，可以直接给提示');
  const body = clean(text, 200);
  if (room.pendingHintRequests.size && [...room.pendingHintRequests].some((id) => room.messages.find((m) => m.id === id)?.memberId === member.id)) {
    throw httpError(409, '你已经有一个提示请求在等主持人回复了');
  }
  const msg = pushMessage(room, 'hintreq', member, body || '想请主持人给一条提示');
  msg.hintReq = 'pending';
  room.pendingHintRequests.add(msg.id);
  commit(room);
  return room;
}

// 主持人回应提示请求：同意（可同时给出提示内容）/ 不同意
export function answerHintRequest({ code, token, messageId, accept, text }) {
  const room = mustRoom(code);
  const member = mustMember(room, token);
  mustHost(room, member);
  requireActive(room);
  const target = room.messages.find((m) => m.id === messageId && m.kind === 'hintreq');
  if (!target) throw httpError(404, '没找到这条提示请求');
  if (target.hintReq !== 'pending') throw httpError(409, '这条请求已经处理过了');

  const asker = room.members.find((m) => m.id === target.memberId);

  if (accept) {
    let hintText = clean(text, 200);
    if (!hintText) {
      // 没写内容：用本局预备的提示条
      if (room.hintCount < room.hints.length) {
        room.hintCount += 1;
        hintText = room.hints[room.hintCount - 1];
      } else {
        throw httpError(400, '这一局没有预备提示，请把提示写进弹窗');
      }
    } else {
      room.hints.push(hintText);
      room.hintCount = room.hints.length;
    }
    target.hintReq = 'approved';
    pushMessage(room, 'hint', member, hintText);
    systemMessage(room, `主持人同意了 ${target.name || '玩家'} 的提示请求`);
  } else {
    target.hintReq = 'rejected';
    const notice = pushMessage(
      room,
      'notice',
      null,
      `${target.name || '玩家'}：主持人拒绝了你的提示请求`
    );
    notice.to = target.memberId || null;
  }
  room.pendingHintRequests.delete(target.id);
  commit(room);
  return room;
}

export function hostSay({ code, token, text }) {
  const room = mustRoom(code);
  const member = mustMember(room, token);
  mustHost(room, member);
  const body = clean(text, 300);
  if (!body) throw httpError(400, '写点什么再说吧');
  pushMessage(room, 'host', member, body);
  commit(room);
  return room;
}

// 主持人给玩家分配二级身份（仅本人和主持人可见）
export function assignRole({ code, token, memberId, name, desc, goal }) {
  const room = mustRoom(code);
  const member = mustMember(room, token);
  mustHost(room, member);
  requireActive(room);

  const target = findMember(room, String(memberId || ''));
  if (!target) throw httpError(404, '找不到这位玩家');
  if (target.id === room.hostId) throw httpError(400, '不能给主持人自己分配身份');

  const roleName = clean(name, 20);
  if (!roleName) throw httpError(400, '身份名称不能为空');

  target.role = {
    name: roleName,
    desc: clean(desc, 300),
    goal: clean(goal, 300),
    at: now(),
    by: member.name
  };

  // 不广播给房间：只有被分配的人能看到自己的身份，主持人从玩家列表里看到
  const notice = pushMessage(room, 'role', null, `你的身份：${target.role.name}`, { to: target.id, role: roleState(target.role) });
  notice.role = roleState(target.role);
  notice.from = target.id; // 只让自己看到这条
  commit(room);
  return room;
}

export function revokeRole({ code, token, memberId }) {
  const room = mustRoom(code);
  const member = mustMember(room, token);
  mustHost(room, member);
  const target = findMember(room, String(memberId || ''));
  if (!target) throw httpError(404, '找不到这位玩家');
  if (!target.role) return room;
  target.role = null;
  pushMessage(room, 'notice', null, '主持人收回了你的身份', { to: target.id });
  commit(room);
  return room;
}

export function submitGuess({ code, token, text }) {
  const room = mustRoom(code);
  const member = mustMember(room, token);
  requireActive(room);
  const answer = clean(text, 500);
  if (!normAnswer(answer)) throw httpError(400, '先写下你的推理吧');

  const correct = isCorrect(room.solution, answer);
  pushMessage(room, 'guess', member, answer);

  if (correct) {
    member.correctAt = now();
    room.revealed = true;
    systemMessage(room, `${member.name} 猜中了！汤底已揭晓`);
    commit(room);
    return { correct: true, room };
  }

  room.lastActivity = now();
  emitMessages(room);
  persist(room);
  return { correct: false, room };
}

export function hostReveal({ code, token }) {
  const room = mustRoom(code);
  const member = mustMember(room, token);
  mustHost(room, member);
  requireActive(room);
  room.revealed = true;
  systemMessage(room, `主持人 ${member.name} 公布了汤底`);
  commit(room);
  return room;
}

// 房主把主持人身份交给某人（也可以自己继续）
export function transferHost({ code, token, memberId }) {
  const room = mustRoom(code);
  const member = mustMember(room, token);
  mustHost(room, member);
  const target = findMember(room, String(memberId || ''));
  if (!target) throw httpError(404, '找不到这位玩家');
  if (target.id === room.hostId) return room;
  room.members.forEach((m) => (m.host = m.id === target.id));
  room.hostId = target.id;
  systemMessage(room, `${member.name} 把主持人交给了 ${target.name}`);
  commit(room);
  return room;
}

// 主持人结束本局：揭晓汤底 → 房间回到准备阶段（房间不解散）
export function endRound({ code, token, solution }) {
  const room = mustRoom(code);
  const member = mustMember(room, token);
  mustHost(room, member);
  if (!room.active) throw httpError(409, '现在还没有开局');
  const sol = clean(solution, 3000);
  if (!sol) throw httpError(400, '先写汤底');
  room.solution = sol;
  return hostReveal({ code, token });
}

export function hostNextRound({ code, token }) {
  const room = mustRoom(code);
  const member = mustMember(room, token);
  mustHost(room, member);
  if (!room.active || !room.revealed) throw httpError(409, '这一轮还没结束');
  room.active = false;
  room.hintCount = 0;
  room.pendingHintRequests = new Set();
  for (const m of room.members) {
    m.ready = m.id === room.hostId;
    m.role = null; // 本局身份作废
  }
  systemMessage(room, '这一轮结束，回到准备，等下一局');
  commit(room);
  return room;
}

export function leaveRoom({ code, token }) {
  const room = mustRoom(code);
  const member = getMemberByToken(room, token);
  if (!member) return null;
  for (const res of member.clients) {
    try {
      res.end();
    } catch {
      /* ignore */
    }
  }
  member.clients.clear();
  room.members = room.members.filter((m) => m.id !== member.id);
  systemMessage(room, `${member.name} 离开了房间`);

  if (!room.members.length) {
    removeRoom(room.code);
    return null;
  }
  if (room.hostId === member.id) reassignHost(room, '接任主持人');
  commit(room);
  return room;
}

export function closeRoom({ code, token }) {
  const room = mustRoom(code);
  const member = mustMember(room, token);
  mustHost(room, member);
  removeRoom(room.code);
}

/* ------------------------------ SSE 连接管理 ------------------------------ */

export function attachClient({ code, token, res }) {
  const room = mustRoom(code);
  const member = mustMember(room, token);

  member.online = true;
  member.connectedOnce = true;
  member.lastSeen = now();
  member.clients.add(res);
  room.lastActivity = now();
  persist(room); // 有人在房间里，就不用马上清掉快照

  res.you = () => ({ id: member.id, name: member.name, host: member.id === room.hostId });

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (res.flushHeaders) res.flushHeaders();

  send(res, 'room', roomView(room));
  send(res, 'you', res.you());
  send(res, 'messages', { messages: messagesFor(room, member.id) });
  emitRoom(room); // 让其他客户端看到在线状态

  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* ignore */
    }
  }, 25_000);

  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(ping);
    member.clients.delete(res);
    member.lastSeen = now();
    if (member.clients.size) return;
    member.online = false;

    // 主持人可能只是刷新页面：先等一会儿，确认没有重连再移交，避免刷一下就把主持权弄丢
    if (room.hostId === member.id) {
      setTimeout(() => {
        const live = rooms.get(room.code);
        if (!live || live.hostId !== member.id) return;
        if (member.online || member.clients.size) return;
        const next = live.members.find((m) => m.online && m.clients.size && m.id !== member.id);
        if (!next) return;
        live.members.forEach((m) => (m.host = m.id === next.id));
        live.hostId = next.id;
        systemMessage(live, `${member.name} 掉线了，${next.name} 接任主持人`);
        commit(live);
      }, HOST_HANDOVER_DELAY_MS);
    }

    // 带上每个成员各自的视角重新广播：直接用 roomView(room) 会漏掉 roles，把身份卡刷没
    emitRoom(room);
    persist(room);
  };

  res.on('close', cleanup);
  res.on('error', cleanup);
  return { room, member };
}

/* ------------------------------ 启动 ------------------------------ */

let started = false;

export function startRooms() {
  if (started) return;
  started = true;
  restoreRooms();
  setInterval(sweep, 15_000).unref();
  setInterval(() => {
    const t = now();
    for (const room of [...rooms.values()]) {
      const anytime = room.members.some((m) => m.online || m.clients.size);
      // 长时间没人：清掉（sweep 也会处理，这里兜底保证列表不残留）
      if (!room.members.length || (!anytime && t - room.lastActivity > EMPTY_ROOM_MS)) {
        removeRoom(room.code);
        continue;
      }
      persist(room);
    }
  }, BACKUP_MS).unref();
}

export function roomsStats() {
  return { rooms: rooms.size };
}

export { rooms, MAX_MEMBERS, CODE_LEN };
