/* 开发者面板：登录 + 对局审查（只读） */

const $ = (sel, root = document) => root.querySelector(sel);

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[c]);

const pad = (n) => String(n).padStart(2, '0');
const fmt = (t) => {
  const d = new Date(Number(t) || 0);
  return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
};

const STATUS = { waiting: '准备中', playing: '进行中', revealed: '已揭晓' };
const KIND = {
  system: '系统',
  chat: '聊',
  pm: '私聊',
  question: '提问',
  answer: '回答',
  host: '主持',
  hint: '提示',
  notice: '通知',
  role: '身份',
  hintreq: '求提示',
  guess: '猜',
  story: '题库'
};

let currentCode = '';
let pollTimer = null;

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('is-on');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('is-on'), 2400);
}

async function api(path, opts = {}) {
  const res = await fetch('/api/dev' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* ignore */
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || '请求失败（' + res.status + '）');
    err.status = res.status;
    throw err;
  }
  return data;
}

/* ------------------------------ 主题 ------------------------------ */

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
}

function initTheme() {
  try {
    const saved = localStorage.getItem('turtle-soup-theme');
    if (saved === 'light' || saved === 'dark') return applyTheme(saved);
  } catch {
    /* ignore */
  }
  const light = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
  applyTheme(light ? 'light' : 'dark');
}

$('#themeToggle').addEventListener('click', () => {
  const cur = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  const next = cur === 'light' ? 'dark' : 'light';
  applyTheme(next);
  try {
    localStorage.setItem('turtle-soup-theme', next);
  } catch {
    /* ignore */
  }
});

/* ------------------------------ 命中高亮 ------------------------------ */

function mark(text, hits) {
  let html = esc(text);
  for (const w of hits || []) {
    if (!w) continue;
    const needle = esc(w);
    html = html.split(needle).join('<mark>' + needle + '</mark>');
  }
  return html;
}

/* ------------------------------ 登录 ------------------------------ */

function showLogin() {
  $('#loginView').hidden = false;
  $('#panelView').hidden = true;
  $('#devToken').focus();
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    if (document.hidden) return;
    refreshRooms().catch(() => {});
    if (currentCode) loadRoom(currentCode).catch(() => {});
  }, 5000);
}

async function showPanel() {
  $('#loginView').hidden = true;
  $('#panelView').hidden = false;
  await refreshRooms();
  startPolling();
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const token = $('#devToken').value.trim();
  const msg = $('#loginMsg');
  const btn = $('#loginBtn');
  if (!token) {
    msg.className = 'form-msg is-bad';
    msg.textContent = '先粘贴开发者密钥';
    return;
  }
  btn.disabled = true;
  msg.className = 'form-msg';
  msg.textContent = '正在验证…';
  try {
    await api('/login', { method: 'POST', body: JSON.stringify({ token }) });
    $('#devToken').value = '';
    msg.textContent = '';
    await showPanel();
  } catch (err) {
    msg.className = 'form-msg is-bad';
    msg.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

$('#logoutBtn').addEventListener('click', async () => {
  try {
    await api('/logout', { method: 'POST' });
  } catch {
    /* ignore */
  }
  stopPolling();
  currentCode = '';
  $('#roomDetail').innerHTML = '<div class="empty">选择左侧的一局查看谜面、汤底与对话</div>';
  showLogin();
});

$('#refreshBtn').addEventListener('click', () => {
  refreshRooms().catch((e) => toast(e.message));
  if (currentCode) loadRoom(currentCode).catch((e) => toast(e.message));
});

/* ------------------------------ 房间列表 ------------------------------ */

async function refreshRooms() {
  const data = await api('/rooms');
  const list = $('#roomList');
  if (!data.rooms.length) {
    list.innerHTML = '<div class="empty empty--sm">现在没有进行中的对局</div>';
    return;
  }
  list.innerHTML = data.rooms.map(roomRow).join('');
  list.querySelectorAll('[data-code]').forEach((b) => {
    b.addEventListener('click', () => {
      loadRoom(b.dataset.code).catch((e) => toast(e.message));
    });
    b.classList.toggle('is-on', b.dataset.code === currentCode);
  });
  $('#devMeta').textContent =
    '共 ' + data.rooms.length + ' 局 · 词表 ' + data.moderation.words + ' 条 · ' + fmt(data.scannedAt) + ' 扫描';
}

function roomRow(r) {
  const hit = r.flags.surface.length + r.flags.solution.length + r.flags.messageHits;
  return (
    '<button class="dev-room" type="button" data-code="' + esc(r.code) + '">' +
    '<span class="dev-room-top"><b>' + esc(r.title || '等待出题') + '</b><em>' + esc(r.code) + '</em></span>' +
    '<span class="dev-room-meta">' + (STATUS[r.status] || r.status) + ' · 第 ' + r.round + ' 轮 · 主持人 ' + esc(r.hostName || '—') + '</span>' +
    '<span class="dev-room-meta">' + r.onlineCount + '/' + r.memberCount + ' 在线 · ' + r.messageCount + ' 条消息 · ' + fmt(r.lastActivity) + '</span>' +
    (hit ? '<span class="dev-badge dev-badge--bad">审查命中 ' + hit + ' 处</span>' : '<span class="dev-badge">未命中词表</span>') +
    '</button>'
  );
}

/* ------------------------------ 房间详情 ------------------------------ */

async function loadRoom(code) {
  currentCode = code;
  document.querySelectorAll('.dev-room').forEach((b) => b.classList.toggle('is-on', b.dataset.code === code));
  const data = await api('/rooms/' + encodeURIComponent(code));
  renderDetail(data.room);
}

function renderDetail(room) {
  const flags = room.flags || { surface: [], solution: [], messageHits: 0 };

  const members = room.members
    .map(
      (m) =>
        '<li class="dev-member ' + (m.online ? 'is-on' : '') + '">' +
        esc(m.name) +
        (m.host ? ' <i>主持</i>' : '') +
        (m.online ? '' : ' <em>离线</em>') +
        '</li>'
    )
    .join('');

  const msgs = room.messages
    .slice()
    .reverse()
    .map((m) => {
      const kind = KIND[m.kind] || m.kind;
      const toName = m.to ? room.members.find((x) => x.id === m.to)?.name || '?' : '';
      const extra =
        m.kind === 'pm' ? '私聊 → ' + esc(toName) : m.kind === 'notice' && m.to ? '仅 ' + esc(toName) + ' 可见' : '';
      const answer = m.answer ? '<span class="dev-msg-kind">回答 ' + esc(m.answer) + '</span>' : '';
      const hits = m.hits && m.hits.length ? '<span class="dev-hit">命中：' + esc(m.hits.join('、')) + '</span>' : '';
      return (
        '<div class="dev-msg">' +
        '<div class="dev-msg-head"><b>' + esc(m.name || '系统') + '</b>' +
        '<span class="dev-msg-kind">' + esc(kind) + '</span>' +
        (extra ? '<span>' + extra + '</span>' : '') +
        answer +
        '<span>' + fmt(m.at) + '</span></div>' +
        '<div class="dev-msg-text">' + mark(m.text, m.hits) + '</div>' +
        hits +
        '</div>'
      );
    })
    .join('');

  $('#roomDetail').innerHTML =
    '<h2>' + esc(room.title || '等待出题') + '</h2>' +
    '<div class="dev-detail-meta"><span>' + esc(room.code) + '</span>' +
    '<span>' + (STATUS[room.status] || room.status) + '</span>' +
    '<span>第 ' + room.round + ' 轮</span>' +
    '<span>主持人 ' + esc(room.hostName || '—') + '</span>' +
    '<span>' + esc(room.mode === 'preset' ? '题库开桌' : '自己出题') + '</span></div>' +
    '<ul class="dev-members">' + members + '</ul>' +
    '<div class="dev-audit">' +
    '<span class="' + (flags.surface.length ? 'is-hit' : '') + '">汤面：' +
    (flags.surface.length ? '命中 ' + esc(flags.surface.join('、')) : '未命中') + '</span>' +
    '<span class="' + (flags.solution.length ? 'is-hit' : '') + '">汤底：' +
    (flags.solution.length ? '命中 ' + esc(flags.solution.join('、')) : '未命中') + '</span>' +
    '<span class="' + (flags.messageHits ? 'is-hit' : '') + '">对话：' + flags.messageHits + ' 条命中</span>' +
    '</div>' +
    '<section class="dev-section"><h3>汤面 / SURFACE</h3><p class="dev-text">' +
    (room.surface ? mark(room.surface, flags.surface) : '（还没有出题）') + '</p></section>' +
    '<section class="dev-section"><h3>汤底 / SOLUTION</h3><p class="dev-text">' +
    (room.solution ? mark(room.solution, flags.solution) : '（还没有汤底）') + '</p></section>' +
    '<section class="dev-section"><h3>对话 / MESSAGES · ' + room.messages.length + '</h3>' +
    (room.messages.length ? '<div class="dev-msgs">' + msgs + '</div>' : '<div class="empty empty--sm">还没有消息</div>') +
    '</section>';
}

/* ------------------------------ 启动 ------------------------------ */

async function boot() {
  initTheme();
  try {
    const me = await api('/me');
    if (me.ok) return showPanel();
  } catch {
    /* ignore */
  }
  showLogin();
}

boot();
