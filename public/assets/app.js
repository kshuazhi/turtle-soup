/* 修复已知问题 / Fix known issues */

const $ = (sel, root = document) => root.querySelector(sel);

const state = {
  scope: 'browse',
  page: 1,
  q: '',
  tag: '',
  sort: 'new',
  tags: [],
  total: 0,
  listToken: 0
};

/* ------------------------------ 工具 ------------------------------ */

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[c]);
}

const pad = (n) => String(n).padStart(2, '0');

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('is-on');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('is-on'), 2200);
}

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
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
    const err = new Error((data && data.error) || `请求失败（${res.status}）`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v ? JSON.parse(v) : d;
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* ignore */
    }
  }
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ------------------------------ 主题 ------------------------------ */

const THEME_KEY = 'turtle-soup-theme';

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'light' ? '#f7f7f5' : '#0a0a0a');
}

function initTheme() {
  const saved = store.get(THEME_KEY, null);
  if (saved === 'light' || saved === 'dark') return applyTheme(saved);
  const prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
  applyTheme(prefersLight ? 'light' : 'dark');
}

$('#themeToggle').addEventListener('click', () => {
  const cur = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  const next = cur === 'light' ? 'dark' : 'light';
  applyTheme(next);
  store.set(THEME_KEY, next);
});

/* ------------------------------ 切换动画 ------------------------------ */

let swapLock = false;
let swapQueue = null;

async function swap(render) {
  // 锁只保护过渡本身：锁住时排队最新的一次，别把用户刚点的导航直接丢掉
  if (swapLock) {
    swapQueue = render;
    return;
  }
  swapLock = true;
  window.TS._isSwapping = true;
  try {
    const el = $('#view');
    el.classList.add('is-leaving');
    await sleep(document.documentElement.dataset.reduce === 'true' ? 0 : 260);

    // 换一个全新容器：上一个视图的异步回调只会写进已经脱离文档的旧节点，
    // 不会覆盖刚渲染出来的新页面（viewPlay 里的 el.isConnected 检查也靠这个生效）
    const fresh = document.createElement('div');
    fresh.id = 'view';
    fresh.className = 'view';
    fresh.setAttribute('aria-live', 'polite');
    el.replaceWith(fresh);

    try {
      const result = render(fresh);
      if (result && typeof result.catch === 'function') result.catch((err) => console.error('[view]', err));
    } catch (err) {
      console.error('[view]', err);
    }
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  } finally {
    swapLock = false;
    window.TS._isSwapping = false;
    const next = swapQueue;
    swapQueue = null;
    if (next) swap(next);
  }
}

/* ------------------------------ 导航高亮 ------------------------------ */

function setNav(scope) {
  document.querySelectorAll('.site-nav a').forEach((a) => {
    const href = a.getAttribute('href');
    const on =
      (scope === 'community' && href === '/community') ||
      (scope === 'browse' && href === '/') ||
      (scope === 'rooms' && href === '/rooms') ||
      (scope === 'new' && href === '/new') ||
      (scope === 'about' && href === '/about');
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}

/* ------------------------------ 路由 ------------------------------ */

function navigate(path, replace = false) {
  if (path === location.pathname + location.search) return;
  if (replace) history.replaceState({}, '', path);
  else history.pushState({}, '', path);
  route();
}

function route() {
  const p = location.pathname;
  if (p.startsWith('/play/')) {
    const id = decodeURIComponent(p.slice('/play/'.length));
    return viewPlay(id);
  }
  if (p === '/community') return viewCommunity();
  if (p === '/new') return viewNew();
  if (p === '/about') return viewAbout();
  if (p === '/rooms' || p === '/rooms/custom' || p === '/rooms/preset') return window.TS.rooms.viewLobby();
  if (p.startsWith('/room/')) return window.TS.rooms.viewRoom(decodeURIComponent(p.slice('/room/'.length)).toUpperCase());
  return viewHome();
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-nav]');
  if (!a) return;
  const url = new URL(a.href, location.origin);
  if (url.origin !== location.origin) return;
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  navigate(url.pathname + url.search);
});

window.addEventListener('popstate', route);

/* ------------------------------ 公共片段 ------------------------------ */

const ICON_ARROW_L = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>`;
const ICON_ARROW_R = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>`;
const ICON_SEARCH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>`;
const ICON_PLUS = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`;
const ICON_X = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`;

function cardHtml(s, i) {
  const tags = (s.tags || [])
    .slice(0, 2)
    .map((t) => `<i>${esc(t)}</i>`)
    .join('');
  return `
    <article class="card" style="--i:${i}" data-id="${esc(s.id)}" role="link" tabindex="0"
             aria-label="阅读：${esc(s.title)}">
      <div class="card-top">
        <span class="card-no">${s.source === 'builtin' ? '馆藏' : '来稿'}</span>
      </div>
      <h3 class="card-title">${esc(s.title)}</h3>
      <p class="card-surface">${esc(s.surface)}</p>
      <div class="card-foot">
        <span class="card-tags">${tags}</span>
      </div>
    </article>`;
}

function bindCards(root) {
  root.querySelectorAll('.card').forEach((card) => {
    const go = () => navigate('/play/' + encodeURIComponent(card.dataset.id));
    card.addEventListener('click', go);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        go();
      }
    });
  });
}

async function loadStats() {
  try {
    const s = await api('/stats');
    const el = $('#footStats');
    if (el) el.textContent = `共 ${s.total} 道汤`;
  } catch {
    /* ignore */
  }
}

/* ============================================================
   首页
   ============================================================ */

async function viewHome() {
  setNav('browse');
  state.scope = 'browse';

  await swap((el) => {
    el.innerHTML = `
      <section class="hero">
        <span class="kicker" data-anim style="--i:0">Situation Puzzle · 情境推理</span>
        <h1 data-anim style="--i:1">
  一个人走进餐馆，<br />
          <span class="thin">点了一碗海龟汤。</span><span class="cursor" aria-hidden="true"></span>
        </h1>
        <p class="lead" data-anim style="--i:2">
          只读汤面，自行推理，一步一步逼近真相。没有标准流程，只有你和那道谜。
        </p>
        <div class="hero-actions" data-anim style="--i:3">
          <button class="btn btn--primary" id="btnRandom" type="button">随机一道</button>
          <a class="btn" href="/community" data-nav>玩家投稿</a>
          <a class="btn" href="/new" data-nav>出题</a>
          <a class="btn btn--ghost" href="/about" data-nav>玩法 ${ICON_ARROW_R}</a>
        </div>
      </section>

      <section class="section-head" aria-label="题库">
        <h2 class="section-title" data-anim style="--i:4">题库 / STORIES</h2>
        <div class="toolbar">
          <div class="search">
            ${ICON_SEARCH}
            <input id="searchInput" type="search" placeholder="搜索标题、汤面或标签" aria-label="搜索题库" autocomplete="off" />
          </div>
          <select class="select" id="sortSelect" aria-label="排序">
            <option value="new">最新</option>
            <option value="hot">最热</option>
            <option value="like">最多喜欢</option>
            <option value="random">随机</option>
          </select>
        </div>
        <div class="tagbar" id="tagbar"></div>
      </section>

      <div class="cards" id="cards" aria-busy="true">
        ${'<div class="skeleton"></div>'.repeat(6)}
      </div>
      <nav class="pager" id="pager" aria-label="分页"></nav>
    `;

    $('#btnRandom').addEventListener('click', goRandom);
    $('#searchInput').addEventListener('input', debounce((e) => {
      state.q = e.target.value.trim();
      state.page = 1;
      loadList();
    }, 320));
    $('#sortSelect').addEventListener('change', (e) => {
      state.sort = e.target.value;
      state.page = 1;
      loadList();
    });
    $('#sortSelect').value = state.sort;

    loadTags();
    loadList();
    loadStats();
  });
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

async function loadTags() {
  try {
    const { tags } = await api('/tags');
    state.tags = tags;
    const bar = $('#tagbar');
    if (!bar) return;
    if (!tags.length) {
      bar.innerHTML = '';
      return;
    }
    const all = `<button class="chip ${state.tag ? '' : 'is-on'}" data-tag="">全部</button>`;
    const items = tags
      .slice(0, 10)
      .map((t) => `<button class="chip ${state.tag === t.name ? 'is-on' : ''}" data-tag="${esc(t.name)}">${esc(t.name)} <span style="opacity:.5">${t.count}</span></button>`)
      .join('');
    bar.innerHTML = all + items;
    bar.querySelectorAll('.chip').forEach((c) =>
      c.addEventListener('click', () => {
        state.tag = c.dataset.tag;
        state.page = 1;
        loadTags();
        loadList();
      })
    );
  } catch {
    /* ignore */
  }
}

async function loadList() {
  const token = ++state.listToken;
  const wrap = $('#cards');
  if (!wrap) return;
  const params = new URLSearchParams({
    page: state.page,
    size: 12,
    sort: state.sort,
    q: state.q,
    tag: state.tag
  });
  try {
    const data = await api('/stories?' + params.toString());
    if (token !== state.listToken || !$('#cards')) return;
    state.total = data.total;
    wrap.removeAttribute('aria-busy');
    if (!data.items.length) {
      wrap.innerHTML = `<div class="empty" style="grid-column:1/-1"><strong>翻遍了，没有找到</strong>换一个关键词，或者亲自出一题</div>`;
      renderPager(data);
      return;
    }
    wrap.innerHTML = data.items.map((s, i) => cardHtml(s, i)).join('');
    bindCards(wrap);
    renderPager(data);
  } catch (err) {
    if (token !== state.listToken) return;
    wrap.innerHTML = `<div class="empty" style="grid-column:1/-1"><strong>加载失败</strong>${esc(err.message)}</div>`;
    renderPager({ page: 1, pages: 1 });
  }
}

function renderPager(data) {
  const pager = $('#pager');
  if (!pager) return;
  if (data.pages <= 1) {
    pager.innerHTML = '';
    return;
  }
  pager.innerHTML = `
    <button type="button" data-p="prev" aria-label="上一页" ${data.page <= 1 ? 'disabled' : ''}>${ICON_ARROW_L}</button>
    <span>${pad(data.page)} / ${pad(data.pages)}</span>
    <button type="button" data-p="next" aria-label="下一页" ${data.page >= data.pages ? 'disabled' : ''}>${ICON_ARROW_R}</button>
  `;
  pager.querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => {
      if (b.dataset.p === 'prev') state.page = Math.max(1, data.page - 1);
      else state.page = Math.min(data.pages, data.page + 1);
      loadList();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    })
  );
}

async function goRandom() {
  try {
    const { id } = await api('/stories/random');
    navigate('/play/' + encodeURIComponent(id));
  } catch (err) {
    toast(err.message);
  }
}

/* ============================================================
   玩家投稿（独立页面：独立搜索与标签）
   ============================================================ */

const communityState = {
  page: 1,
  q: '',
  tag: '',
  sort: 'new',
  tags: [],
  total: 0,
  listToken: 0
};

async function viewCommunity() {
  setNav('community');
  state.scope = 'community';
  document.title = '玩家投稿 · 海龟汤';

  await swap((el) => {
    el.innerHTML = `
      <section class="hero hero--community">
        <span class="kicker" data-anim style="--i:0">COMMUNITY · 玩家投稿</span>
        <h1 data-anim style="--i:1">玩家熬的汤，<span class="thin">也在桌上。</span></h1>
        <p class="lead" data-anim style="--i:2">
          这里只收录通过 GitHub Pull Request 投稿、经人工核查合并的海龟汤。搜索和标签都属于这个页面，不会影响题库。
        </p>
        <div class="hero-actions" data-anim style="--i:3">
          <a class="btn btn--primary" href="/new" data-nav>投稿一碗汤</a>
          <a class="btn btn--ghost" href="/" data-nav>返回题库 ${ICON_ARROW_R}</a>
        </div>
      </section>

      <section class="section-head" aria-label="玩家投稿">
        <h2 class="section-title" data-anim style="--i:4">投稿汤 / COMMUNITY</h2>
        <div class="toolbar">
          <div class="search">
            ${ICON_SEARCH}
            <input id="cSearch" type="search" placeholder="在玩家投稿里搜索标题、汤面或标签" aria-label="搜索玩家投稿" autocomplete="off" />
          </div>
          <select class="select" id="cSort" aria-label="排序">
            <option value="new">最新</option>
            <option value="hot">最热</option>
            <option value="like">最多喜欢</option>
            <option value="random">随机</option>
          </select>
        </div>
        <div class="tagbar" id="cTagbar"></div>
      </section>

      <div class="cards" id="cCards" aria-busy="true">
        ${'<div class="skeleton"></div>'.repeat(6)}
      </div>
      <nav class="pager" id="cPager" aria-label="分页"></nav>
    `;

    $('#cSearch').addEventListener('input', debounce((e) => {
      communityState.q = e.target.value.trim();
      communityState.page = 1;
      loadCommunityList();
    }, 320));
    $('#cSort').addEventListener('change', (e) => {
      communityState.sort = e.target.value;
      communityState.page = 1;
      loadCommunityList();
    });
    $('#cSort').value = communityState.sort;

    loadCommunityTags();
    loadCommunityList();
    loadStats();
  });
}

async function loadCommunityTags() {
  try {
    const { tags } = await api('/tags?source=pr');
    communityState.tags = tags;
    const bar = $('#cTagbar');
    if (!bar) return;
    if (!tags.length) {
      bar.innerHTML = '';
      return;
    }
    const all = `<button class="chip ${communityState.tag ? '' : 'is-on'}" data-ctag="">全部</button>`;
    const items = tags
      .slice(0, 10)
      .map((t) => `<button class="chip ${communityState.tag === t.name ? 'is-on' : ''}" data-ctag="${esc(t.name)}">${esc(t.name)} <span style="opacity:.5">${t.count}</span></button>`)
      .join('');
    bar.innerHTML = all + items;
    bar.querySelectorAll('.chip').forEach((c) =>
      c.addEventListener('click', () => {
        communityState.tag = c.dataset.ctag;
        communityState.page = 1;
        loadCommunityTags();
        loadCommunityList();
      })
    );
  } catch {
    /* ignore */
  }
}

async function loadCommunityList() {
  const token = ++communityState.listToken;
  const wrap = $('#cCards');
  if (!wrap) return;
  const params = new URLSearchParams({
    page: communityState.page,
    size: 12,
    sort: communityState.sort,
    q: communityState.q,
    tag: communityState.tag,
    source: 'pr'
  });
  try {
    const data = await api('/stories?' + params.toString());
    if (token !== communityState.listToken || !$('#cCards')) return;
    communityState.total = data.total;
    wrap.removeAttribute('aria-busy');
    if (!data.items.length) {
      wrap.innerHTML = '<div class="empty" style="grid-column:1/-1"><strong>还没有玩家投稿</strong>去 <a href="/new" data-nav>投稿教程</a> 提交第一碗汤</div>';
      renderCommunityPager(data);
      return;
    }
    wrap.innerHTML = data.items.map((s, i) => cardHtml(s, i)).join('');
    bindCards(wrap);
    renderCommunityPager(data);
  } catch (err) {
    if (token !== communityState.listToken) return;
    wrap.innerHTML = `<div class="empty" style="grid-column:1/-1"><strong>加载失败</strong>${esc(err.message)}</div>`;
    renderCommunityPager({ page: 1, pages: 1 });
  }
}

function renderCommunityPager(data) {
  const pager = $('#cPager');
  if (!pager) return;
  if (data.pages <= 1) {
    pager.innerHTML = '';
    return;
  }
  pager.innerHTML = `
    <button type="button" data-cp="prev" aria-label="上一页" ${data.page <= 1 ? 'disabled' : ''}>${ICON_ARROW_L}</button>
    <span>${pad(data.page)} / ${pad(data.pages)}</span>
    <button type="button" data-cp="next" aria-label="下一页" ${data.page >= data.pages ? 'disabled' : ''}>${ICON_ARROW_R}</button>
  `;
  pager.querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => {
      if (b.dataset.cp === 'prev') communityState.page = Math.max(1, data.page - 1);
      else communityState.page = Math.min(data.pages, data.page + 1);
      loadCommunityList();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    })
  );
}

/* ============================================================
   详情页
   ============================================================ */

const playState = {
  storyId: null,
  hintCount: 0,
  revealed: false,
  liked: false
};

async function viewPlay(id) {
  setNav('browse');
  state.scope = 'detail';

  await swap(async (el) => {
    el.innerHTML = `
      <div class="play">
        <a class="back" href="/" data-nav>${ICON_ARROW_L} 返回题库</a>
        <div class="play-meta">
          <span>LOADING</span>
        </div>
        <h1>正在揭开汤面…</h1>
        <div class="soup" aria-hidden="true">…</div>
      </div>`;
    let s;
    try {
      s = await api('/stories/' + encodeURIComponent(id));
    } catch (err) {
      el.innerHTML = `
        <div class="play">
          <a class="back" href="/" data-nav>${ICON_ARROW_L} 返回题库</a>
          <div class="empty"><strong>${esc(err.status === 404 ? '这碗汤不见了' : '加载失败')}</strong>${esc(err.message)}</div>
        </div>`;
      return;
    }
    if (state.scope !== 'detail' || !el.isConnected) return;

    playState.storyId = s.id;
    playState.hintCount = 0;
    playState.revealed = false;
    playState.liked = false;
    const likedIds = store.get('turtle-soup-liked', []);
    playState.liked = likedIds.includes(s.id);
    document.title = `${s.title} · 海龟汤`;

    const date = new Date(s.createdAt);
    const tags = (s.tags || []).map((t) => `<i>${esc(t)}</i>`).join('');

    el.innerHTML = `
      <div class="play">
        <a class="back" href="/" data-nav>${ICON_ARROW_L} 返回题库</a>

        <div class="play-meta" data-anim style="--i:0">
          <span>${s.source === 'builtin' ? '馆藏' : '来稿'}</span>
          <span class="dot"></span>
          <span>${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())}</span>
        </div>

        <h1 data-anim style="--i:1">${esc(s.title)}</h1>

        <div class="soup" data-anim style="--i:2">${esc(s.surface)}</div>
        ${tags ? `<div class="play-tags" data-anim style="--i:3">${tags}</div>` : ''}

        <section class="hints-block" data-anim style="--i:4" aria-label="提示">
          <div class="hints-list" id="hintsList"></div>
          <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
            <button class="btn btn--sm" id="btnHint" type="button">要一条提示</button>
            <span class="hint-note" id="hintNote">${s.hints.length ? `共 ${s.hints.length} 条提示` : '这道汤没有提示'}</span>
          </div>
        </section>

        <section class="guess-box" data-anim style="--i:5" aria-label="推理">
          <label for="guessInput">写下你的推理 / YOUR ANSWER</label>
          <div class="guess-row">
            <textarea id="guessInput" rows="3" maxlength="500" placeholder="你觉得真相是什么？猜对一次，就能看到汤底。"></textarea>
            <button class="btn" id="btnGuess" type="button">交卷</button>
          </div>
          <div class="guess-msg" id="guessMsg" aria-live="polite"></div>
        </section>

        <section data-anim style="--i:6">
          <button class="btn reveal-btn" id="btnReveal" type="button">放弃推理，直接看汤底</button>
          <div id="solutionWrap" aria-live="polite"></div>
        </section>

        <div class="solution-actions" data-anim style="--i:7">
          <button class="btn ${playState.liked ? 'like-btn is-on' : ''}" id="btnLike" type="button">
            ${playState.liked ? '已喜欢' : '喜欢'}
          </button>
          <button class="btn" id="btnNext" type="button">下一道 ${ICON_ARROW_R}</button>
          <button class="btn btn--ghost" id="btnRandom2" type="button">随机</button>
          <button class="btn btn--ghost" id="btnShare" type="button">复制链接</button>
        </div>

        <section class="related" aria-label="相关汤">
          <h2 class="section-title">继续翻煮</h2>
          <div class="cards" id="related"></div>
        </section>
      </div>
    `;

    // 提示
    const hintBtn = $('#btnHint');
    if (!s.hints.length) hintBtn.disabled = true;
    hintBtn.addEventListener('click', async () => {
      hintBtn.disabled = true;
      try {
        const next = playState.hintCount + 1;
        const r = await api(`/stories/${encodeURIComponent(s.id)}/hint`, {
          method: 'POST',
          body: JSON.stringify({ count: next })
        });
        playState.hintCount = r.hints.length;
        const list = $('#hintsList');
        list.innerHTML = r.hints
          .map((h, i) => `<div class="hint-item"><b>${pad(i + 1)}</b><span>${esc(h)}</span></div>`)
          .join('');
        $('#hintNote').textContent =
          playState.hintCount >= r.total ? '提示已给完，剩下的靠你' : `已用 ${playState.hintCount} / ${r.total} 条提示`;
      } catch (err) {
        toast(err.message);
      } finally {
        hintBtn.disabled = playState.hintCount >= s.hints.length;
      }
    });

    // 推理
    const guessInput = $('#guessInput');
    const guessMsg = $('#guessMsg');
    const btnGuess = $('#btnGuess');

    async function submitGuess() {
      const answer = guessInput.value.trim();
      if (!answer) {
        guessMsg.className = 'guess-msg is-bad';
        guessMsg.textContent = '先写下你的推理吧。';
        guessInput.focus();
        return;
      }
      btnGuess.disabled = true;
      guessMsg.className = 'guess-msg';
      guessMsg.textContent = '正在比对汤底…';
      try {
        const r = await api(`/stories/${encodeURIComponent(s.id)}/answer`, {
          method: 'POST',
          body: JSON.stringify({ answer })
        });
        if (r.correct) {
          guessMsg.className = 'guess-msg is-good';
          guessMsg.textContent = '猜对了。汤底为你揭开。';
          showSolution(r.solution);
        } else {
          guessMsg.className = 'guess-msg is-bad';
          guessMsg.textContent = '不对。别急，再看看汤面，或者要一条提示。';
        }
      } catch (err) {
        guessMsg.className = 'guess-msg is-bad';
        guessMsg.textContent = err.message;
      } finally {
        btnGuess.disabled = false;
      }
    }

    btnGuess.addEventListener('click', submitGuess);
    guessInput.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') submitGuess();
    });

    // 揭晓：汤底不再随详情预下发，直接在「放弃推理」或猜中时向服务器要
    const revealBtn = $('#btnReveal');
    async function showSolution(solution) {
      if (playState.revealed) return;
      let text = solution || '';
      if (!text) {
        try {
          const r = await api(`/stories/${encodeURIComponent(s.id)}/reveal`, { method: 'POST' });
          text = r.solution || '';
        } catch (err) {
          toast(err.message);
          return;
        }
      } else {
        api(`/stories/${encodeURIComponent(s.id)}/reveal`, { method: 'POST' }).catch(() => {});
      }
      if (playState.revealed) return;
      playState.revealed = true;
      const wrap = $('#solutionWrap');
      if (!wrap) return;
      wrap.innerHTML = `
        <div class="solution">
          <div class="sol-head"><span>汤底 / SOLUTION</span><span>${esc(s.title)}</span></div>
          <p style="margin:0;white-space:pre-wrap">${esc(text)}</p>
        </div>`;
      revealBtn.remove();
    }
    revealBtn.addEventListener('click', async () => {
      revealBtn.disabled = true;
      await showSolution();
      if (!playState.revealed) revealBtn.disabled = false;
    });

    // 喜欢
    const likeBtn = $('#btnLike');
    likeBtn.addEventListener('click', async () => {
      const next = !playState.liked;
      likeBtn.disabled = true;
      try {
        const r = await api(`/stories/${encodeURIComponent(s.id)}/like`, {
          method: 'POST',
          body: JSON.stringify({ like: next })
        });
        playState.liked = r.liked;
        likeBtn.classList.toggle('is-on', r.liked);
        likeBtn.innerHTML = r.liked ? '已喜欢' : '喜欢';
        let ids = store.get('turtle-soup-liked', []);
        ids = r.liked ? [...new Set([...ids, s.id])] : ids.filter((x) => x !== s.id);
        store.set('turtle-soup-liked', ids);
      } catch (err) {
        toast(err.message);
      } finally {
        likeBtn.disabled = false;
      }
    });

    // 下一道 / 随机 / 分享
    async function next(exceptSelf) {
      try {
        const { id: nid } = await api('/stories/random' + (exceptSelf ? `?exclude=${encodeURIComponent(s.id)}` : ''));
        navigate('/play/' + encodeURIComponent(nid));
      } catch (err) {
        toast(err.message);
      }
    }
    $('#btnNext').addEventListener('click', () => next(true));
    $('#btnRandom2').addEventListener('click', () => next(true));
    $('#btnShare').addEventListener('click', async () => {
      const url = location.href;
      try {
        if (navigator.share) {
          await navigator.share({ title: s.title, text: s.surface, url });
          return;
        }
        await navigator.clipboard.writeText(url);
        toast('链接已复制');
      } catch {
        try {
          await navigator.clipboard.writeText(url);
          toast('链接已复制');
        } catch {
          toast(url);
        }
      }
    });

    // 相关内容
    loadRelated(s.tags || [], s.id);
    loadStats();
  });
}

async function loadRelated(tags, exceptId) {
  const wrap = $('#related');
  if (!wrap) return;
  try {
    let items = [];
    if (tags.length) {
      const d = await api(`/stories?tag=${encodeURIComponent(tags[0])}&size=4`);
      items = d.items.filter((x) => x.id !== exceptId).slice(0, 3);
    }
    if (items.length < 3) {
      const d = await api('/stories?sort=random&size=7');
      for (const x of d.items) {
        if (x.id !== exceptId && !items.some((y) => y.id === x.id)) items.push(x);
        if (items.length >= 3) break;
      }
    }
    if (!items.length) {
      wrap.closest('.related').remove();
      return;
    }
    wrap.innerHTML = items.map((s, i) => cardHtml(s, i)).join('');
    bindCards(wrap);
  } catch {
    wrap.closest('.related')?.remove();
  }
}

/* ============================================================
   投稿页（GitHub Pull Request）
   ============================================================ */

const SOUP_REPO = 'https://github.com/kshuazhi/turtle-soup';
const SOUP_PR = SOUP_REPO + '/compare?expand=1&template=turtle-soup.md';
const SOUP_SUBMISSIONS = SOUP_REPO + '/tree/main/submissions';
const SOUP_TEMPLATE = `{
  "title": "汤的名字（40 字以内）",
  "surface": "汤面：只写谜面，不要透露答案",
  "solution": "汤底：完整、唯一、能解释汤面所有细节的真相",
  "hints": ["提示一（可选）", "提示二（可选）"],
  "tags": []
}`;

async function viewNew() {
  setNav('new');
  state.scope = 'new';
  document.title = '投稿 · 海龟汤';

  await swap((el) => {
    el.innerHTML = `
      <div class="form-wrap">
        <a class="back" href="/" data-nav>${ICON_ARROW_L} 返回题库</a>

        <div class="form-head" data-anim style="--i:0">
          <span class="kicker">SUBMIT · 投稿</span>
          <h1>出一碗汤，<span class="thin">用 Pull Request。</span></h1>
          <p>网页不再直接发布题目。所有海龟汤都通过 GitHub Pull Request 提交，维护者人工核查后合并，随下一次部署自动上线。</p>
        </div>

        <ol class="submit-steps">
          <li data-anim style="--i:1"><div>
            <h3><b>01</b> Fork 仓库</h3>
            <p>打开 <a href="${SOUP_REPO}" target="_blank" rel="noopener">kshuazhi/turtle-soup</a>，点右上角 Fork，得到你自己的副本。</p>
          </div></li>
          <li data-anim style="--i:2"><div>
            <h3><b>02</b> 新建 submissions/你的汤名.json</h3>
            <p>在副本里进入 <a href="${SOUP_SUBMISSIONS}" target="_blank" rel="noopener">submissions/</a> 目录，按下面的格式新建一个 JSON 文件（文件名用英文或拼音，例如 <code>midnight-knock.json</code>）。标签是<strong>可选</strong>的，最多 2 个，只能从下面列出的标签里选；不填就留空。</p>
          </div></li>
          <li data-anim style="--i:3"><div>
            <h3><b>03</b> 提交 Pull Request</h3>
            <p>点下面的「去 GitHub 提交 PR」，标题以 <code>[汤]</code> 开头，模板选「海龟汤投稿」，说明里写清汤名和一句话简介。</p>
          </div></li>
          <li data-anim style="--i:4"><div>
            <h3><b>04</b> 人工核查后上线</h3>
            <p>维护者会人工检查内容与合规性；合并后随下一次部署自动进入题库，不需要你再做别的。</p>
          </div></li>
        </ol>

        <section class="submit-template" data-anim style="--i:5" aria-label="投稿格式">
          <div class="submit-template-head">
            <span>submissions/你的汤名.json</span>
            <button class="btn btn--sm" id="btnCopyTemplate" type="button">复制模板</button>
          </div>
          <pre id="soupTemplate">${esc(SOUP_TEMPLATE)}</pre>
        </section>

        <section class="submit-tags" data-anim style="--i:6" aria-label="可选标签">
          <div class="submit-tags-head">
            <span>可选标签 <em>最多 2 个，可不填；只能用下面这些</em></span>
          </div>
          <div class="tagbar" id="submitTagOptions"><span class="chip is-static">加载中…</span></div>
        </section>

        <div class="hero-actions" data-anim style="--i:7">
          <a class="btn btn--primary" href="${SOUP_PR}" target="_blank" rel="noopener">去 GitHub 提交 PR ${ICON_ARROW_R}</a>
          <a class="btn" href="${SOUP_SUBMISSIONS}" target="_blank" rel="noopener">查看投稿目录</a>
          <a class="btn btn--ghost" href="${SOUP_REPO}" target="_blank" rel="noopener">打开仓库</a>
        </div>

        <p class="submit-note" data-anim style="--i:8">
          海龟汤投稿请使用「海龟汤投稿」模板并放在 <code>submissions/</code> 下；
          普通代码 / 文档 PR 请使用默认模板、标题不要加 <code>[汤]</code>，
          两者互不干扰，人工核查分开进行。
        </p>
      </div>`;

    $('#btnCopyTemplate').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(SOUP_TEMPLATE);
        toast('模板已复制');
      } catch {
        toast('复制失败，请手动选中模板');
      }
    });

    // 标签白名单由服务端给出，避免教程和实际校验不一致
    api('/tags')
      .then(({ options }) => {
        const box = $('#submitTagOptions');
        if (!box || !Array.isArray(options)) return;
        box.innerHTML = options
          .map(function (t) {
            return '<span class="chip is-static">' + esc(t) + '</span>';
          })
          .join('');
      })
      .catch(() => {});
  });
}

/* ============================================================
   玩法页
   ============================================================ */

async function viewAbout() {
  setNav('about');
  state.scope = 'about';
  document.title = '玩法 · 海龟汤';

  await swap((el) => {
    el.innerHTML = `
      <div class="about">
        <span class="kicker" data-anim style="--i:0">HOW TO PLAY</span>
        <h1 data-anim style="--i:1">怎么玩海龟汤</h1>
        <p class="lead" data-anim style="--i:2">
          海龟汤是一种情境推理游戏。出题人给出一个看似离奇、甚至不合逻辑的“汤面”，
          玩家通过提问与推理，还原出那唯一的“汤底”。
        </p>

        <ol class="rules">
          <li data-anim style="--i:3"><div>
            <h3>先读汤面</h3>
            <p>汤面只描述结果，不解释原因。注意每一个反常的细节，它们都是线索。</p>
          </div></li>
          <li data-anim style="--i:4"><div>
            <h3>卡住了就点提示</h3>
            <p>提示会一条一条放出来，从含糊到直白。用得越少，推出来的成就感越强。</p>
          </div></li>
          <li data-anim style="--i:5"><div>
            <h3>写下推理，交卷</h3>
            <p>把真相概括成一句话提交。命中了，汤底会立刻为你翻开。</p>
          </div></li>
          <li data-anim style="--i:6"><div>
            <h3>实在想不出，也可以直接看</h3>
            <p>看汤底不丢人。看完不妨去“出题”页面，熬一锅自己的汤。</p>
          </div></li>
        </ol>

        <blockquote class="quote" data-anim style="--i:7">
          “一个人走进餐馆，点了一碗海龟汤。他喝了一口，就结束了自己的生命。”<br />
          这条最古老的谜面，是这项游戏名字的来源。
        </blockquote>

        <div class="hero-actions" data-anim style="--i:8">
          <button class="btn btn--primary" id="aboutRandom" type="button">随机一道</button>
          <a class="btn" href="/new" data-nav>出题</a>
        </div>
      </div>
    `;
    $('#aboutRandom').addEventListener('click', goRandom);
    loadStats();
  });
}

/* ============================================================
   启动
   ============================================================ */

document.documentElement.dataset.reduce = String(
  window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
);

window.TS = { $, esc, pad, api, toast, swap, setNav, navigate, debounce, playState, loadRelated, loadStats, ICON_ARROW_L };

initTheme();

// app.js 先于 rooms.js 执行：等 DOMContentLoaded（所有 module 脚本都执行完）再跑首屏路由，
// 否则直接打开 /rooms、/room/:code 时 window.TS.rooms 还不存在，页面会整片空白
if (document.readyState === 'complete') route();
else document.addEventListener('DOMContentLoaded', route);
