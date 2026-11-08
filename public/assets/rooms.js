/* =========================================================
   修复已知问题 / Fix known issues
   依赖主文件暴露的全局：window.TS
   玩法：谁创房谁是主持人；主持人写汤面/汤底，玩家提问，
         主持人答是/否/无关；有人猜中或主持人公布汤底后，
         主持人决定把主持人交给谁，开始下一轮。
   ========================================================= */

(() => {
  const { $, esc, pad, api, toast, swap, setNav, navigate, loadStats } = window.TS;

  const PROFILE_KEY = 'turtle-soup-profile';
  const SESSION_KEY = 'turtle-soup-room';

  const profile = loadProfile();
  // 每次都从 sessionStorage 读，避免模块加载过早把身份缓存成空
  const getSession = () => loadRoomSession();
  const setSession = (s) => saveSession(s);

  function loadProfile() {
    try {
      const p = JSON.parse(localStorage.getItem(PROFILE_KEY) || 'null');
      if (p && typeof p === 'object') {
        return { name: String(p.name || '').slice(0, 14), code: String(p.code || '').slice(0, 6) };
      }
    } catch {
      /* ignore */
    }
    return { name: '', code: '' };
  }

  function saveProfile() {
    try {
      localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
    } catch {
      /* ignore */
    }
  }

  function loadRoomSession() {
    try {
      const s = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
      if (s && s.code && s.token) {
        return {
          code: String(s.code),
          token: String(s.token),
          memberId: s.memberId || '',
          name: s.name || ''
        };
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  function saveSession(s) {
    try {
      if (s) sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
      else sessionStorage.removeItem(SESSION_KEY);
    } catch {
      /* ignore */
    }
  }

  function saveName(name) {
    profile.name = name;
    saveProfile();
  }

  /* ------------------------------ 大厅 ------------------------------ */

  let lobbyTimer = null;

  // 从大厅进房间：当前地址已经是 /room/:code（邀请链接直接打开、或身份失效后回落大厅）时，
  // navigate() 会因为“路径没变”直接返回，必须手动进入房间
  function enterRoom(code) {
    const path = '/room/' + code;
    if (location.pathname === path) {
      viewRoom(code);
      return;
    }
    navigate(path);
  }

  // 真正离开房间：否则点「离开房间」只是换了一页，房间里还会挂着一个离线成员
  function leaveCurrentRoom() {
    const { code, token } = roomState;
    if (!code || !token) return;
    api(`/rooms/${encodeURIComponent(code)}/leave`, {
      method: 'POST',
      body: JSON.stringify({ token })
    }).catch(() => {});
    closeStream();
    setSession(null);
    roomState.code = '';
    roomState.token = '';
    roomState.me = null;
    roomState.room = null;
    roomState.messages = [];
  }

  /* ------------------------------ 房间状态 ------------------------------ */

  const roomState = {
    code: '',
    token: '',
    me: null,
    room: null,
    messages: [],
    es: null,
    draft: null, // 主持人正在写的题（未提交）
    draftFor: '' // 草稿对应的轮次 / 状态 key
  };

  function closeStream() {
    if (roomState.es) {
      try {
        roomState.es.close();
      } catch {
        /* ignore */
      }
      roomState.es = null;
    }
  }

  // 第一屏：创建房间 / 加入房间 / 改名
  async function viewLobby(code = '') {
    setNav('rooms');
    leaveCurrentRoom();
    clearInterval(lobbyTimer);
    document.title = ('联机房间' + (code ? ' · ' + code : '')) + ' · 海龟汤';
    const prefill = code || profile.code || '';

    await swap((el) => {
      el.innerHTML = `
        <section class="lobby-hero">
          <div class="lobby-hero-head" data-anim style="--i:0">
            <span class="kicker">MULTIPLAYER · 联机</span>
            <h1>几个人，<span class="thin">一碗汤。</span></h1>
            <p class="lead">
              谁创房，谁就是主持人：主持人写汤面和汤底，玩家提问，主持人答「是 / 否 / 无关」。
              全员准备好后，主持人点开始游戏。
            </p>
          </div>

          <div class="duo" data-anim style="--i:1">
            <!-- 创建 -->
            <section class="duo-card">
              <div class="duo-head">
                <span class="duo-no">01</span>
                <h2>创建房间</h2>
                <small>你将成为主持人</small>
              </div>
              <div class="duo-body">
                <label class="field">
                  <span>你的名字</span>
                  <input id="newName" maxlength="14" placeholder="先报个名" value="${esc(profile.name)}" autocomplete="nickname" />
                </label>
                <div class="field">
                  <span>开桌方式</span>
                  <div class="seg" role="tablist" aria-label="开桌方式">
                    <button type="button" class="seg-btn is-on" data-mode="custom" role="tab" aria-selected="true">自己出题</button>
                    <button type="button" class="seg-btn" data-mode="preset" role="tab" aria-selected="false">题库开桌</button>
                  </div>
                </div>
                <p class="duo-note" id="modeNote">玩游戏时由主持人现场写汤面；汤底只有主持人能看到。</p>
              </div>
              <div class="duo-foot">
                <button class="btn btn--primary" id="createRoomBtn" type="button">创建房间</button>
                <span class="form-msg" id="createMsg" aria-live="polite"></span>
              </div>
            </section>

            <!-- 加入 -->
            <section class="duo-card">
              <div class="duo-head">
                <span class="duo-no">02</span>
                <h2>加入房间</h2>
                <small>输入主持人给你的房间码</small>
              </div>
              <div class="duo-body">
                <label class="field">
                  <span>房间码 <em>6 位</em></span>
                  <input id="joinCode" class="code-input" maxlength="6" placeholder="如 K7M2QP" autocomplete="off" spellcheck="false" value="${esc(prefill)}" />
                </label>
                <label class="field">
                  <span>你的名字</span>
                  <input id="joinName" maxlength="14" placeholder="给自己起个名字" value="${esc(profile.name)}" autocomplete="nickname" />
                </label>
                <p class="duo-note">名字和房间码都可以随时改，房间里能看见你的名字。</p>
              </div>
              <div class="duo-foot">
                <button class="btn btn--primary" id="joinRoomBtn" type="button">加入房间</button>
                <span class="form-msg" id="joinMsg" aria-live="polite"></span>
              </div>
            </section>
          </div>

          <div class="identity" data-anim style="--i:2">
            <div class="identity-main">
              <span class="identity-label">当前昵称</span>
              <b id="identityName">${esc(profile.name || '还没有名字')}</b>
            </div>
            <label class="identity-rename">
              <input id="globalName" maxlength="14" placeholder="改个名字" value="${esc(profile.name)}" aria-label="修改昵称" />
              <button class="btn btn--sm" id="saveNameBtn" type="button">保存昵称</button>
            </label>
            <span class="form-msg" id="nameMsg" aria-live="polite"></span>
          </div>

          <section class="panel panel--list lobby-list" data-anim style="--i:3">
            <div class="panel-head">
              <h2 class="panel-title">正在进行的房间</h2>
              <button class="btn btn--ghost btn--sm" id="refreshRooms" type="button">刷新</button>
            </div>
            <div id="roomList" class="room-list">
              <div class="skeleton skeleton--row"></div>
              <div class="skeleton skeleton--row"></div>
            </div>
          </section>
        </section>
      `;

      // 开桌方式
      let chosenMode = 'custom';
      const modeNote = el.querySelector('#modeNote');
      el.querySelectorAll('.seg-btn').forEach((btn) =>
        btn.addEventListener('click', () => {
          chosenMode = btn.dataset.mode;
          el.querySelectorAll('.seg-btn').forEach((b) => {
            b.classList.toggle('is-on', b === btn);
            b.setAttribute('aria-selected', String(b === btn));
          });
          modeNote.textContent =
            chosenMode === 'preset'
              ? '开局时由主持人从题库里挑一道汤，适合懒得出题、马上开玩。'
              : '玩游戏时由主持人现场写汤面；汤底只有主持人能看到。';
        })
      );

      // 创建
      const createBtn = el.querySelector('#createRoomBtn');
      const createMsg = el.querySelector('#createMsg');
      createBtn.addEventListener('click', async () => {
        const name = el.querySelector('#newName').value.trim();
        if (!name) {
          createMsg.className = 'form-msg is-bad';
          createMsg.textContent = '先填一个名字。';
          el.querySelector('#newName').focus();
          return;
        }
        createBtn.disabled = true;
        createMsg.className = 'form-msg';
        createMsg.textContent = '正在开锅…';
        try {
          const r = await api('/rooms', { method: 'POST', body: JSON.stringify({ name, mode: chosenMode }) });
          saveName(name);
          profile.code = r.code;
          saveProfile();
          setSession({ code: r.code, token: r.token, memberId: r.memberId, name });
          enterRoom(r.code);
        } catch (err) {
          createMsg.className = 'form-msg is-bad';
          createMsg.textContent = err.message;
          createBtn.disabled = false;
        }
      });

      // 加入
      const codeInput = el.querySelector('#joinCode');
      const nameInput = el.querySelector('#joinName');
      const joinBtn = el.querySelector('#joinRoomBtn');
      const joinMsg = el.querySelector('#joinMsg');
      codeInput.addEventListener('input', () => {
        codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
      });

      async function doJoin(code) {
        const name = nameInput.value.trim();
        if (!name) {
          joinMsg.className = 'form-msg is-bad';
          joinMsg.textContent = '先填一个名字。';
          nameInput.focus();
          return;
        }
        if (!/^[A-Z0-9]{6}$/.test(code)) {
          joinMsg.className = 'form-msg is-bad';
          joinMsg.textContent = '房间码是 6 位字母和数字。';
          codeInput.focus();
          return;
        }
        joinBtn.disabled = true;
        joinMsg.className = 'form-msg';
        joinMsg.textContent = '正在进房间…';
        try {
          const r = await api('/rooms/join', { method: 'POST', body: JSON.stringify({ code, name }) });
          saveName(name);
          profile.code = r.code;
          saveProfile();
          setSession({ code: r.code, token: r.token, memberId: r.memberId, name });
          enterRoom(r.code);
        } catch (err) {
          joinMsg.className = 'form-msg is-bad';
          joinMsg.textContent = err.message;
          joinBtn.disabled = false;
        }
      }
      joinBtn.addEventListener('click', () => doJoin(codeInput.value.trim().toUpperCase()));
      codeInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doJoin(codeInput.value.trim().toUpperCase());
      });
      nameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doJoin(codeInput.value.trim().toUpperCase());
      });

      // 改名（第一屏的昵称）
      const globalName = el.querySelector('#globalName');
      const identityName = el.querySelector('#identityName');
      const nameMsg = el.querySelector('#nameMsg');
      el.querySelector('#saveNameBtn').addEventListener('click', () => {
        const name = globalName.value.trim();
        if (!name) {
          nameMsg.className = 'form-msg is-bad';
          nameMsg.textContent = '名字不能为空。';
          return;
        }
        saveName(name);
        identityName.textContent = name;
        el.querySelector('#newName').value = name;
        nameInput.value = name;
        nameMsg.className = 'form-msg';
        nameMsg.textContent = '已保存';
      });

      // 房间列表
      async function refreshList() {
        const box = el.querySelector('#roomList');
        if (!box) return;
        try {
          const { rooms } = await api('/rooms');
          if (!box.isConnected) return;
          if (!rooms.length) {
            box.innerHTML = `<div class="empty empty--sm">还没有进行中的房间<br />开一个，把房间码发给朋友</div>`;
            return;
          }
          box.innerHTML = rooms
            .map(
              (r) => `
            <button class="room-row" type="button" data-code="${esc(r.code)}">
              <span class="room-row-main">
                <b>${esc(r.title)}</b>
                <small>主持人 ${esc(r.hostName)} · ${r.members} 人在线 · ${
                  r.status === 'playing'
                    ? `第 ${r.round} 轮进行中`
                    : r.status === 'revealed'
                      ? '本轮已揭晓'
                      : '准备中'
                }</small>
              </span>
              <span class="room-code">${esc(r.code)}</span>
            </button>`
            )
            .join('');
          box.querySelectorAll('.room-row').forEach((b) =>
            b.addEventListener('click', () => {
              codeInput.value = b.dataset.code;
              profile.code = b.dataset.code;
              saveProfile();
              const name = nameInput.value.trim();
              if (name) {
                doJoin(b.dataset.code);
              } else {
                nameInput.focus();
                toast('填个名字就能直接进入这个房间');
              }
            })
          );
        } catch (err) {
          box.innerHTML = `<div class="empty empty--sm">列表加载失败：${esc(err.message)}</div>`;
        }
      }
      el.querySelector('#refreshRooms').addEventListener('click', refreshList);
      refreshList();
      lobbyTimer = setInterval(refreshList, 15000);
      loadStats();
    });
  }

  async function viewRoom(code) {
    setNav('rooms');
    clearInterval(lobbyTimer);
    closeStream();
    roomState.code = code;

    let resumed = false;
    const session = getSession();
    if (session && session.code === code && session.token) {
      try {
        const r = await api('/rooms/resume', { method: 'POST', body: JSON.stringify({ code, token: session.token }) });
        roomState.token = r.token;
        resumed = true;
      } catch (err) {
        setSession(null);
        // 房间已经不存在了：清掉本地身份，告诉用户发生了什么
        if (err.status === 404) toast('这个房间已经结束或解散了');
      }
    }

    if (!resumed) {
      // 没身份就回第一屏：房间码已预填，填个名字点加入
      navigate('/room/' + code, true);
      viewLobby(code);
      return;
    }

    roomState.me = null;
    roomState.room = null;
    roomState.messages = [];

    document.title = '房间 ' + code + ' · 海龟汤';
    api('/stories?size=50&sort=new')
      .then((d) => {
        roomState.presets = d.items || [];
        renderRoom();
      })
      .catch(() => {});
    await swap((el) => {
      el.innerHTML = `
        <div class="room" id="roomRoot">
          <div class="play">
            <a class="back" href="/rooms" data-nav id="roomBack"><span class="back-arrow">←</span> 离开房间</a>
            <div class="play-meta"><span>ROOM ${esc(code)}</span><span class="dot"></span><span class="room-status">连接中…</span></div>
            <h1>载入中…</h1>
          </div>
        </div>`;
      startStream();
    });
  }

  /* ------------------------------ SSE ------------------------------ */

  function startStream() {
    closeStream();
    const url = `/api/rooms/${encodeURIComponent(roomState.code)}/events?token=${encodeURIComponent(roomState.token)}`;
    let es;
    try {
      es = new EventSource(url);
    } catch (err) {
      toast('实时连接失败：' + err.message);
      return;
    }
    roomState.es = es;

    es.addEventListener('room', (e) => {
      roomState.room = JSON.parse(e.data);
      renderRoom();
    });
    es.addEventListener('you', (e) => {
      roomState.me = JSON.parse(e.data);
      if (roomState.me?.name) saveName(roomState.me.name);
      renderRoom();
    });
    es.addEventListener('messages', (e) => {
      const d = JSON.parse(e.data);
      roomState.messages = d.messages || [];
      renderMessages();
    });
    es.addEventListener('closed', () => {
      setSession(null);
      closeStream();
      toast('房间已关闭');
      navigate('/rooms');
    });
    es.onerror = () => {
      const status = document.querySelector('.room-status');
      if (status) status.textContent = '连接中断，正在重连…';
      if (es.readyState === EventSource.CLOSED) toast('实时连接断开，请刷新页面');
    };
  }

  /* ------------------------------ 渲染 ------------------------------ */

  function renderRoom() {
    const room = roomState.room;
    const rootEl = document.getElementById('roomRoot');
    if (!room || !rootEl) return;

    // 房间每推进一步就整块重渲染，先把聊天框里的草稿和光标保住
    const draftEl = rootEl.querySelector('#chatText');
    const draft = draftEl
      ? {
          value: draftEl.value,
          start: draftEl.selectionStart,
          end: draftEl.selectionEnd,
          focused: document.activeElement === draftEl
        }
      : null;

    const me = roomState.me;
    const isHost = !!me && me.id === room.hostId;
    const hostName = room.hostName || '主持人';
    const statusText = room.status === 'revealed'
      ? `第 ${room.round} 轮已揭晓`
      : room.status === 'playing'
        ? `第 ${room.round} 轮进行中`
        : '准备中';

    const members = room.members
      .map((m) => {
        const tags = [];
        if (m.id === room.hostId) tags.push('主持');
        if (m.id !== room.hostId && room.status === 'waiting') tags.push(m.ready ? '已准备' : '未准备');
        if (m.correct) tags.push('猜中');
        const r = room.roles?.[m.id];
        const roleTag = r ? `<i class="role-tag" title="${esc(r.desc)}${r.goal ? ' · 目的：' + esc(r.goal) : ''}">${esc(r.name)}</i>` : '';
        return `<li class="member ${m.id === me?.id ? 'is-me' : ''}">
          <span class="presence ${m.online ? 'is-on' : ''}" aria-hidden="true"></span>
          <span class="member-name">${esc(m.name)}</span>
          <span class="member-tags">${roleTag}${tags.map((t) => `<i>${t}</i>`).join('')}</span>
        </li>`;
      })
      .join('');

    const hints = (room.hints || [])
      .map((h, i) => `<div class="hint-item"><b>${pad(i + 1)}</b><span>${esc(h)}</span></div>`)
      .join('');

    const myReady = !!room.members.find((m) => m.id === me?.id)?.ready;
    const myRole = room.roles?.[me?.id] || null;
    const roleCard = myRole ? renderRoleCard(myRole, false) : '';

    let stage = '';
    if (room.status === 'waiting') {
      stage = renderReadyStage(room, isHost, myReady, hostName);
    } else {
      stage = `
        <h2 class="stage-title">${esc(room.title)}</h2>
        ${roleCard}
        <div class="soup">${esc(room.surface)}</div>
        ${hints ? `<div class="hints-list hints-list--room">${hints}</div>` : ''}
        ${
          room.status === 'revealed'
            ? `<div class="solution">
                 <div class="sol-head"><span>汤底 / SOLUTION</span><span>${esc(room.title)}</span></div>
                 <p style="margin:0;white-space:pre-wrap">${esc(room.solution || '')}</p>
               </div>`
            : ''
        }
        ${isHost && room.status === 'playing' ? renderHostControls(room) : ''}
        ${room.status === 'revealed' ? renderNextRound(room, isHost) : ''}
        ${
          room.status === 'revealed'
            ? `<p class="stage-note">这一轮结束了，等主持人安排下一轮。</p>`
            : `<p class="stage-note">提问后等主持人回答。问题越具体，越容易被回答「是」或「否」。</p>`
        }
      `;
    }

    rootEl.innerHTML = `
      <div class="room-head">
        <div class="room-head-main">
          <a class="back" href="/rooms" data-nav>← 离开房间</a>
          <div class="play-meta">
            <span>ROOM <b class="room-code">${esc(room.code)}</b></span>
            <span class="dot"></span>
            <span class="room-status">${esc(statusText)}</span>
            <span class="dot"></span>
            <span>主持人 ${esc(hostName)}</span>
          </div>
          <div class="room-actions">
            <button class="btn btn--sm" id="btnCopyCode" type="button">复制房间码</button>
            <button class="btn btn--sm" id="btnCopyLink" type="button">复制邀请链接</button>
            <button class="btn btn--sm" id="btnRename" type="button">改名</button>
            ${isHost ? `<button class="btn btn--sm" id="btnClose" type="button">结束房间</button>` : ''}
          </div>
        </div>

        <aside class="room-side" aria-label="玩家">
          <h2 class="section-title">PLAYERS · ${room.members.length}</h2>
          <ul class="members">${members}</ul>
          ${
            isHost && Object.keys(room.roles || {}).length
              ? `<div class="role-board">
                   <span class="role-board-title">已分配身份</span>
                   ${Object.entries(room.roles)
                     .map(([id, r]) => {
                       const who = room.members.find((m) => m.id === id);
                       return `<div class="role-board-item">
                         <b>${esc(who?.name || '?')}</b>
                         <span class="role-board-name">${esc(r.name)}</span>
                         ${r.desc ? `<p>${esc(r.desc)}</p>` : ''}
                         ${r.goal ? `<p class="role-board-goal">目的：${esc(r.goal)}</p>` : ''}
                       </div>`;
                     })
                     .join('')}
                 </div>`
              : ''
          }
          <div class="side-note">${isHost ? '你是主持人：写题、回答、决定下一轮由谁出题。' : '你是玩家：提问，猜中汤底就赢了。'}</div>
        </aside>
      </div>

      <div class="room-body">
        <section class="room-main">
          <div class="stage">${stage}</div>

          <section class="chat" aria-label="对话">
            <h2 class="section-title">CHAT · 提问与回答</h2>
            <div class="chat-list" id="chatList"></div>
            ${renderComposer(room, isHost)}
          </section>
        </section>
      </div>
    `;

    // 通用按钮
    rootEl.querySelector('#btnCopyCode').addEventListener('click', () => copyText(room.code, '房间码已复制'));
    rootEl.querySelector('#btnCopyLink').addEventListener('click', () => copyText(location.origin + '/room/' + room.code, '邀请链接已复制'));
    rootEl.querySelector('#btnRename').addEventListener('click', () => openRename(room));
    rootEl.querySelector('#btnClose')?.addEventListener('click', () => openConfirmClose(room));

    bindReadyStage(rootEl, room, isHost);
    bindHostControls(rootEl, room);
    bindNextRound(rootEl, room);
    bindComposer(rootEl, room, isHost);

    renderMessages();

    if (draft) {
      const nextInput = rootEl.querySelector('#chatText');
      if (nextInput) {
        nextInput.value = draft.value;
        if (draft.focused) {
          nextInput.focus();
          try {
            nextInput.setSelectionRange(draft.start, draft.end);
          } catch {
            /* ignore */
          }
        }
      }
    }
  }

  /* ---------------------- 准备阶段 ---------------------- */

  function renderReadyStage(room, isHost, myReady, hostName) {
    const guests = room.members.filter((m) => m.id !== room.hostId);
    const chip = (m) => {
      const ready = m.ready;
      return `<li class="ready-chip ${ready ? 'is-ready' : ''}">
        <span class="ready-mark" aria-hidden="true">${ready ? '✓' : '·'}</span>
        <span class="ready-name">${esc(m.name)}</span>
        ${m.online ? '' : '<em>离线</em>'}
      </li>`;
    };
    const list = guests.length
      ? guests.map(chip).join('')
      : `<li class="ready-empty">还没有玩家进来，把房间码发给朋友</li>`;

    let action;
    if (isHost) {
      action = `
        <div class="ready-action">
          <button class="btn btn--primary ready-start" id="btnStartGame" type="button" ${room.canStart ? '' : 'disabled'}>
            ${room.revealed ? '开始下一局' : '开始游戏'}
          </button>
          <p class="ready-hint">${
            !guests.length
              ? '至少要有 1 名玩家加入才能开始。'
              : room.canStart
                ? '所有人都准备好了，可以开始。'
                : `还在等：${room.waiting.map((n) => esc(n)).join('、')}`
          }</p>
        </div>`;
    } else if (myReady) {
      action = `
        <div class="ready-action">
          <button class="btn" id="btnReady" type="button" data-ready="false">取消准备</button>
          <p class="ready-hint">已准备，等主持人开始游戏。</p>
        </div>`;
    } else {
      action = `
        <div class="ready-action">
          <button class="btn btn--primary" id="btnReady" type="button" data-ready="true">我准备好了</button>
          <p class="ready-hint">全员准备好后，主持人才能开始游戏。</p>
        </div>`;
    }

    return `
      <section class="ready-stage" aria-label="准备">
        <div class="ready-head">
          <span class="kicker">READY · 准备</span>
          <h2 class="ready-title">${room.round > 1 || room.revealed ? '准备下一轮' : '等大家准备好'}</h2>
          <p class="ready-sub">主持人 <b>${esc(hostName)}</b> · ${room.readyCount}/${room.participantCount} 名玩家已准备</p>
        </div>
        <ul class="ready-list">${list}</ul>
        ${action}
      </section>`;
  }

  function bindReadyStage(rootEl, room, isHost) {
    rootEl.querySelector('#btnReady')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const ready = btn.dataset.ready === 'true';
      btn.disabled = true;
      try {
        await api(`/rooms/${room.code}/ready`, { method: 'POST', body: JSON.stringify({ token: roomState.token, ready }) });
      } catch (err) {
        toast(err.message);
        btn.disabled = false;
      }
    });

    rootEl.querySelector('#btnStartGame')?.addEventListener('click', () => {
      if (!room.canStart) {
        toast(room.waiting.length ? '还有人在准备中：' + room.waiting.join('、') : '至少要有 1 名玩家');
        return;
      }
      openStartModal(room);
    });
  }

  // 点「开始游戏」弹出的表单：汤面必填，汤底可选（填了玩家才能“猜中”）
  function openStartModal(room) {
    const preset = room.mode === 'preset';
    const presets = roomState.presets || [];
    const presetSelect = preset
      ? `<div class="field">
           <span>从题库挑一道 <em>可选，选了会填进下面</em></span>
           <select class="preset-select" id="stPreset" aria-label="选择预设题">
             <option value="">— 自己写一道 —</option>
             ${presets.map((s) => `<option value="${esc(s.id)}">${esc(s.title)} — ${esc(s.surface.slice(0, 18))}…</option>`).join('')}
           </select>
         </div>`
      : '';

    openModal({
      title: '开始游戏',
      wide: true,
      okText: '发题，开始游戏',
      bodyHtml: `
        <p class="modal-note">填写这一轮的汤面，确定后立刻展示给房间里所有人。</p>
        ${presetSelect}
        <label class="field">
          <span>汤面 <em>玩家看到的谜题</em></span>
          <textarea id="stSurface" rows="6" maxlength="1000" placeholder="例如：他在雨中看见一个红色的身影，忽然哭了。"></textarea>
        </label>
        <label class="field">
          <span>标题 <em>可不填</em></span>
          <input id="stTitle" maxlength="40" placeholder="给这碗汤起个名字" />
        </label>
        <label class="field">
          <span>汤底 <em>可选，只有你能看到</em></span>
          <textarea id="stSolution" rows="4" maxlength="3000" placeholder="完整、唯一的真相。留空的话玩家只能等你「结束本局」时再揭晓。"></textarea>
        </label>`,
      onOk: async (box) => {
        const surface = box.querySelector('#stSurface').value.trim();
        if (!surface) throw new Error('先写汤面');
        await api(`/rooms/${room.code}/start`, {
          method: 'POST',
          body: JSON.stringify({
            token: roomState.token,
            title: box.querySelector('#stTitle').value.trim(),
            surface,
            solution: box.querySelector('#stSolution').value.trim()
          })
        });
        toast('游戏开始');
      }
    });

    // 题库选择：把题目填进表单（走主持人专属接口，汤底不再随详情接口下发）
    const sel = document.getElementById('stPreset');
    if (sel) {
      sel.addEventListener('change', async () => {
        if (!sel.value) return;
        sel.disabled = true;
        try {
          const s = await api(`/rooms/${room.code}/story`, {
            method: 'POST',
            body: JSON.stringify({ token: roomState.token, storyId: sel.value })
          });
          document.getElementById('stTitle').value = s.title;
          document.getElementById('stSurface').value = s.surface;
          document.getElementById('stSolution').value = s.solution || '';
        } catch (err) {
          toast(err.message);
        } finally {
          sel.disabled = false;
        }
      });
    }
    document.getElementById('stSurface')?.focus();
  }

  // 点「结束」弹出的汤底输入框：确定后揭晓，然后回到准备阶段
  function openEndModal(room) {
    const preset = room.mode === 'preset';
    const presets = roomState.presets || [];
    openModal({
      title: '结束本局',
      wide: true,
      okText: '结束并公布汤底',
      bodyHtml: `
        <p class="modal-note">写下这一轮的汤底，确定后公布给所有人，房间回到准备阶段，等大家准备好再开下一局。</p>
        ${
          preset
            ? `<div class="field">
                 <span>从题库补全 <em>可选</em></span>
                 <select class="preset-select" id="enPreset" aria-label="选择预设题">
                   <option value="">— 手动填写 —</option>
                   ${presets.map((s) => `<option value="${esc(s.id)}">${esc(s.title)}</option>`).join('')}
                 </select>
               </div>`
            : ''
        }
        <label class="field">
          <span>汤底 <em>只有揭晓后才公开</em></span>
          <textarea id="enSolution" rows="6" maxlength="3000" placeholder="完整、唯一、能解释汤面所有细节的真相"></textarea>
        </label>`,
      onOk: async (box) => {
        const solution = box.querySelector('#enSolution').value.trim();
        if (!solution) throw new Error('先写汤底');
        await api(`/rooms/${room.code}/end`, {
          method: 'POST',
          body: JSON.stringify({ token: roomState.token, solution })
        });
        toast('本局已结束，汤底已公布');
      }
    });
    const sel = document.getElementById('enPreset');
    if (sel) {
      sel.addEventListener('change', async () => {
        if (!sel.value) return;
        sel.disabled = true;
        try {
          const s = await api(`/rooms/${room.code}/story`, {
            method: 'POST',
            body: JSON.stringify({ token: roomState.token, storyId: sel.value })
          });
          document.getElementById('enSolution').value = s.solution || '';
        } catch (err) {
          toast(err.message);
        } finally {
          sel.disabled = false;
        }
      });
    }
    document.getElementById('enSolution')?.focus();
  }

  /* ---------------------- 主持人：局中控制 ---------------------- */

  function renderHostControls(room) {
    return `
      <div class="host-bar">
        <button class="btn btn--sm" id="btnHint" type="button">给提示</button>
        <button class="btn btn--sm" id="btnRole" type="button">分配二级身份</button>
        <button class="btn btn--sm btn--primary" id="btnEnd" type="button">结束本局</button>
        <span class="host-hint">回答别人时，点提问下面的「是 / 否 / 无关」。</span>
      </div>`;
  }

  function bindHostControls(rootEl, room) {
    rootEl.querySelector('#btnHint')?.addEventListener('click', () => openHintModal(room));
    rootEl.querySelector('#btnRole')?.addEventListener('click', () => openRoleModal(room));
    rootEl.querySelector('#btnEnd')?.addEventListener('click', () => openEndModal(room));
  }

  // 主持人主动给一条提示
  function openHintModal(room) {
    openModal({
      title: '给一条提示',
      okText: '公布提示',
      bodyHtml: `
        <p class="modal-note">写一句提示公布给所有人；也可以选择不给，直接关掉。</p>
        <label class="field">
          <span>提示内容 <em>200 字以内</em></span>
          <input id="hintText" maxlength="200" placeholder="例如：注意那个红色的东西" />
        </label>`,
      onOk: async (box) => {
        const text = box.querySelector('#hintText').value.trim();
        if (!text) throw new Error('写点什么再公布');
        await api(`/rooms/${room.code}/hint`, { method: 'POST', body: JSON.stringify({ token: roomState.token, text }) });
        toast('提示已公布');
      }
    });
    document.getElementById('hintText')?.focus();
  }

  /* ---------------------- 主持人：轮末交接 ---------------------- */

  function renderNextRound(room, isHost) {
    if (!isHost) {
      return `
        <div class="round-end">
          <h3>这一局结束了</h3>
          <p>等主持人 ${esc(room.hostName || '')} 把大家带回准备，准备好后再开下一局。</p>
        </div>`;
    }
    return `
      <div class="round-end">
        <h3>这一局结束了</h3>
        <p>房间还在，回到准备阶段，等大家重新准备好再开始下一局。</p>
        <div class="round-end-actions">
          <button class="btn btn--sm btn--primary" id="btnNextRound" type="button">回到准备</button>
        </div>
      </div>`;
  }

  function bindNextRound(rootEl, room) {
    rootEl.querySelector('#btnNextRound')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        await api(`/rooms/${room.code}/next-round`, { method: 'POST', body: JSON.stringify({ token: roomState.token }) });
      } catch (err) {
        toast(err.message);
        btn.disabled = false;
      }
    });
  }

  /* ---------------------- 输入区 ---------------------- */

  function renderComposer(room, isHost) {
    if (room.status !== 'playing') {
      return `<div class="chat-input chat-input--off">${
        room.status === 'revealed' ? '这一轮已经结束，等回到准备再开。' : '游戏还没开始，准备好后等主持人点开始。'
      }</div>`;
    }
    const me = roomState.me;
    const others = room.members.filter((m) => m.id !== me?.id);
    const targetId = roomState.pmTarget && others.some((m) => m.id === roomState.pmTarget) ? roomState.pmTarget : others[0]?.id || '';

    const targetSelect = others.length
      ? `<select class="pm-select" id="pmTarget" aria-label="私聊对象">
           ${others
             .map(
               (m) =>
                 `<option value="${esc(m.id)}" ${m.id === targetId ? 'selected' : ''}>${esc(m.name)}${
                   m.id === room.hostId ? '（主持）' : ''
                 }</option>`
             )
             .join('')}
         </select>`
      : '<span class="pm-empty">房间里还没有别人</span>';

    const placeholder = isHost
      ? '补充说明，或者和大家聊点什么'
      : '问一个能用「是 / 否 / 无关」回答的问题，或者直接猜汤底';

    return `
      <div class="chat-input">
        <div class="chat-modes" role="tablist" aria-label="聊天模式">
          <button class="mode-btn is-on" type="button" data-mode="public" role="tab" aria-selected="true">公共</button>
          <button class="mode-btn" type="button" data-mode="pm" role="tab" aria-selected="false" ${others.length ? '' : 'disabled'}>私聊</button>
          <span class="pm-hint" id="pmHint">${isHost ? '主持人可见所有人的私聊' : '私聊对主持人可见，其他玩家看不到'}</span>
          <span class="pm-target" id="pmTargetWrap" hidden>${targetSelect}</span>
        </div>
        <textarea id="chatText" rows="2" maxlength="300" placeholder="${esc(placeholder)}"></textarea>
        <div class="chat-btns">
          ${
            isHost
              ? '<button class="btn btn--sm" id="btnSay" type="button">发送</button>'
              : `<button class="btn btn--sm" id="btnAsk" type="button">提问</button>
                 <button class="btn btn--sm" id="btnAskHint" type="button">请求提示</button>
                 <button class="btn btn--sm btn--primary" id="btnGuess" type="button">猜汤底</button>`
          }
        </div>
      </div>`;
  }

  function bindComposer(rootEl, room, isHost) {
    const input = rootEl.querySelector('#chatText');
    if (!input) return;

    // 公共 / 私聊切换（默认公共）
    let chatMode = roomState.chatMode === 'pm' ? 'pm' : 'public';
    const modeBtns = rootEl.querySelectorAll('.mode-btn');
    const pmWrap = rootEl.querySelector('#pmTargetWrap');
    const pmSelect = rootEl.querySelector('#pmTarget');

    function applyMode() {
      modeBtns.forEach((b) => {
        const on = b.dataset.mode === chatMode;
        b.classList.toggle('is-on', on);
        b.setAttribute('aria-selected', String(on));
      });
      if (pmWrap) pmWrap.hidden = chatMode !== 'pm';
      input.placeholder =
        chatMode === 'pm'
          ? '只说给 TA 听（只有你们两个人能看到）'
          : isHost
            ? '补充说明，或者和大家聊点什么'
            : '问一个能用「是 / 否 / 无关」回答的问题，或者直接猜汤底';
    }
    modeBtns.forEach((b) =>
      b.addEventListener('click', () => {
        if (b.disabled) return;
        chatMode = b.dataset.mode;
        roomState.chatMode = chatMode;
        applyMode();
        input.focus();
      })
    );
    if (pmSelect) {
      pmSelect.addEventListener('change', () => (roomState.pmTarget = pmSelect.value));
    }
    roomState.pmTarget = pmSelect?.value || roomState.pmTarget;
    applyMode();

    async function send(kind) {
      const text = input.value.trim();
      if (!text) {
        input.focus();
        return;
      }
      const btns = rootEl.querySelectorAll('.chat-btns .btn');
      btns.forEach((b) => (b.disabled = true));
      // 先清空输入框：SSE 广播可能比 POST 响应先到，重渲染时会把已经发出去的话当成草稿恢复回来
      input.value = '';
      try {
        if (kind === 'guess') {
          // 猜汤底必须走 guess 接口，不能被“私聊模式”吞成一条 whisper
          const r = await api(`/rooms/${room.code}/guess`, {
            method: 'POST',
            body: JSON.stringify({ token: roomState.token, text })
          });
          if (r.correct) toast('猜中了！');
        } else if (chatMode === 'pm') {
          const toId = pmSelect?.value || roomState.pmTarget;
          if (!toId) throw new Error('房间里还没有别人可以私聊');
          await api(`/rooms/${room.code}/whisper`, {
            method: 'POST',
            body: JSON.stringify({ token: roomState.token, toId, text })
          });
        } else if (kind === 'ask') {
          await api(`/rooms/${room.code}/ask`, { method: 'POST', body: JSON.stringify({ token: roomState.token, text }) });
        } else {
          await api(`/rooms/${room.code}/chat`, { method: 'POST', body: JSON.stringify({ token: roomState.token, text }) });
        }
      } catch (err) {
        const restore = rootEl.querySelector('#chatText');
        if (restore) restore.value = text;
        toast(err.message);
      } finally {
        btns.forEach((b) => (b.disabled = false));
        (rootEl.querySelector('#chatText') || input).focus();
      }
    }

    rootEl.querySelector('#btnAsk')?.addEventListener('click', () => send('ask'));
    rootEl.querySelector('#btnGuess')?.addEventListener('click', () => send('guess'));
    rootEl.querySelector('#btnSay')?.addEventListener('click', () => send('chat'));
    rootEl.querySelector('#btnAskHint')?.addEventListener('click', () => openHintRequestModal(room));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        send(isHost ? 'chat' : 'ask');
      }
    });
  }

  /* ---------------------- 二级身份 ---------------------- */

  function renderRoleCard(role, isHostView) {
    return `<div class="role-card">
      <div class="role-card-head">
        <span class="role-label">${isHostView ? '该玩家的身份' : '你的身份'}</span>
        <b>${esc(role.name)}</b>
        ${role.by ? `<em>由 ${esc(role.by)} 分配</em>` : ''}
      </div>
      ${role.desc ? `<p class="role-desc">${esc(role.desc)}</p>` : ''}
      ${role.goal ? `<p class="role-goal"><b>目的</b>${esc(role.goal)}</p>` : ''}
    </div>`;
  }

  // 主持人：分配二级身份（给谁 / 名称 / 简介 / 目的）
  function openRoleModal(room) {
    const players = room.members.filter((m) => m.id !== room.hostId);
    if (!players.length) {
      toast('房间里还没有其他玩家');
      return;
    }
    const presetTarget = roomState.roleTarget && players.some((m) => m.id === roomState.roleTarget) ? roomState.roleTarget : players[0].id;
    const current = room.roles?.[presetTarget] || null;
    const presetRoles = ['失忆者', '旁观者', '知情者', '冒充者', '共犯'];

    openModal({
      title: '分配二级身份',
      wide: true,
      okText: '分配',
      bodyHtml: `
        <p class="modal-note">身份只有该玩家和你能看到。换一道新汤时身份会清空。</p>
        <label class="field">
          <span>给谁 <em>选择玩家</em></span>
          <select class="preset-select" id="roleTarget" aria-label="选择玩家">
            ${players
              .map(
                (m) =>
                  `<option value="${esc(m.id)}" ${m.id === presetTarget ? 'selected' : ''}>${esc(m.name)}${
                    room.roles?.[m.id] ? '（已有身份：' + esc(room.roles[m.id].name) + '）' : ''
                  }</option>`
              )
              .join('')}
          </select>
        </label>
        <label class="field">
          <span>名称 <em>20 字以内</em></span>
          <input id="roleName" maxlength="20" placeholder="例如：失忆者" value="${esc(current?.name || '')}" />
          <span class="role-presets">${presetRoles
            .map((n) => `<button type="button" class="chip role-preset" data-name="${esc(n)}">${esc(n)}</button>`)
            .join('')}</span>
        </label>
        <label class="field">
          <span>简介 <em>这个身份的背景，可不填</em></span>
          <textarea id="roleDesc" rows="3" maxlength="300" placeholder="例如：你记不起三年前那场雨夜发生了什么">${esc(current?.desc || '')}</textarea>
        </label>
        <label class="field">
          <span>目的 <em>他需要完成什么</em></span>
          <textarea id="roleGoal" rows="3" maxlength="300" placeholder="例如：在别人猜中之前，让大家相信孩子还活着">${esc(current?.goal || '')}</textarea>
        </label>
        <div class="role-current" id="roleCurrent"></div>`,
      onOk: async (box) => {
        const memberId = box.querySelector('#roleTarget').value;
        const name = box.querySelector('#roleName').value.trim();
        if (!name) throw new Error('先填身份名称');
        await api(`/rooms/${room.code}/role`, {
          method: 'POST',
          body: JSON.stringify({
            token: roomState.token,
            memberId,
            name,
            desc: box.querySelector('#roleDesc').value.trim(),
            goal: box.querySelector('#roleGoal').value.trim()
          })
        });
        roomState.roleTarget = memberId;
        toast('已分配身份');
      }
    });

    const targetSel = document.getElementById('roleTarget');
    const fill = (role) => {
      document.getElementById('roleName').value = role?.name || '';
      document.getElementById('roleDesc').value = role?.desc || '';
      document.getElementById('roleGoal').value = role?.goal || '';
      renderCurrent();
    };
    function renderCurrent() {
      const id = targetSel.value;
      const role = room.roles?.[id];
      const box = document.getElementById('roleCurrent');
      if (!box) return;
      box.innerHTML = role
        ? `${renderRoleCard(role, true)}<button class="btn btn--sm" type="button" id="roleRevoke">收回这个身份</button>`
        : '';
      document.getElementById('roleRevoke')?.addEventListener('click', async () => {
        try {
          await api(`/rooms/${room.code}/role-clear`, {
            method: 'POST',
            body: JSON.stringify({ token: roomState.token, memberId: id })
          });
          document.getElementById('roleName').value = '';
          document.getElementById('roleDesc').value = '';
          document.getElementById('roleGoal').value = '';
          box.innerHTML = '';
          toast('已收回身份');
        } catch (err) {
          toast(err.message);
        }
      });
    }
    targetSel?.addEventListener('change', () => {
      fill(room.roles?.[targetSel.value] || null);
    });
    document.querySelectorAll('.role-preset').forEach((b) =>
      b.addEventListener('click', () => {
        document.getElementById('roleName').value = b.dataset.name;
      })
    );
    renderCurrent();
    document.getElementById('roleName')?.focus();
  }

  // 玩家请求提示（主持人同意 / 拒绝）
  function openHintRequestModal(room) {
    openModal({
      title: '请求提示',
      okText: '发送请求',
      bodyHtml: `
        <p class="modal-note">主持人会看到你的请求。同意的话，房间里会多一条提示；不同意你会收到通知。</p>
        <label class="field">
          <span>想说的话 <em>可不填</em></span>
          <input id="hrText" maxlength="200" placeholder="例如：完全没头绪，给点方向吧" />
        </label>`,
      onOk: async (box) => {
        await api(`/rooms/${room.code}/hint-request`, {
          method: 'POST',
          body: JSON.stringify({ token: roomState.token, text: box.querySelector('#hrText').value.trim() })
        });
        toast('请求已发送');
      }
    });
    document.getElementById('hrText')?.focus();
  }

  /* ---------------------- 消息 ---------------------- */

  const ANSWER_TEXT = { yes: '是', no: '否', irrelevant: '无关' };

  function renderMessages() {
    const list = document.getElementById('chatList');
    if (!list) return;
    const room = roomState.room;
    const me = roomState.me;
    const isHost = !!me && room && me.id === room.hostId;
    const msgs = roomState.messages;

    if (!msgs.length) {
      list.innerHTML = `<div class="chat-empty">还没有人说话。${isHost ? '出题后等着大家提问吧。' : '提第一个问题吧。'}</div>`;
      return;
    }

    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 90;
    list.innerHTML = msgs
      .map((m) => {
        if (m.kind === 'system') return `<div class="msg msg--system"><span>${esc(m.text)}</span></div>`;
        if (m.kind === 'hint') return `<div class="msg msg--hint"><b>提示</b><span>${esc(m.text)}</span></div>`;
        if (m.kind === 'answer') return `<div class="msg msg--answer"><b>主持人</b><span>${esc(m.text)}</span></div>`;
        if (m.kind === 'host') return `<div class="msg msg--host"><b>主持人</b><span>${esc(m.text)}</span></div>`;
        if (m.kind === 'chat') {
          const ownChat = m.memberId === me?.id;
          return `<div class="msg msg--chat ${ownChat ? 'is-mine' : ''}">
            <div class="msg-meta"><b>${esc(m.name)}</b><em>聊</em></div>
            <div class="msg-text">${esc(m.text)}</div>
          </div>`;
        }
        if (m.kind === 'pm') {
          const mine = m.memberId === me?.id;
          const nameOf = (id) => room.members.find((x) => x.id === id)?.name || '?';
          const received = m.to === me?.id;
          // 主持人旁观别人的私聊：标成「私聊 A → B」
          const label = mine
            ? '私聊 → ' + nameOf(m.to)
            : received
              ? '私聊给你'
              : isHost
                ? `私聊 ${nameOf(m.memberId)} → ${nameOf(m.to)}`
                : '私聊';
          return `<div class="msg msg--pm ${mine ? 'is-mine' : ''} ${!mine && !received && isHost ? 'is-observed' : ''}">
            <div class="msg-meta"><b>${esc(m.name)}</b><em>${esc(label)}</em></div>
            <div class="msg-text">${esc(m.text)}</div>
          </div>`;
        }
        if (m.kind === 'story') return `<div class="msg msg--story"><b>题库</b><span>${esc(m.text)}</span></div>`;
        if (m.kind === 'role') {
          if (m.to !== me?.id) return '';
          const role = m.role || {};
          return `<div class="msg msg--role">
            <div class="msg-meta"><b>身份</b><em>主持人分配</em></div>
            <div class="msg-text"><b>${esc(role.name || '')}</b>${role.desc ? `<br />${esc(role.desc)}` : ''}${
              role.goal ? `<br /><span class="role-goal-inline">目的：${esc(role.goal)}</span>` : ''
            }</div>
          </div>`;
        }
        if (m.kind === 'notice') {
          if (m.to && m.to !== me?.id) return '';
          return `<div class="msg msg--notice"><span>${esc(m.text)}</span></div>`;
        }
        if (m.kind === 'hintreq') {
          const state =
            m.hintReq === 'pending' ? '等待主持人' : m.hintReq === 'approved' ? '已同意' : '已拒绝';
          let actions = '';
          if (isHost && m.hintReq === 'pending' && room.status === 'playing') {
            actions = `<div class="host-answer">
              <button type="button" data-hreq="${esc(m.id)}" data-accept="1">同意，写提示</button>
              <button type="button" data-hreq="${esc(m.id)}" data-accept="0">不同意</button>
            </div>`;
          }
          return `<div class="msg msg--hintreq ${m.hintReq === 'pending' ? 'is-pending' : ''}">
            <div class="msg-meta"><b>${esc(m.name)}</b><em>求提示</em><span class="hintreq-state">${state}</span></div>
            <div class="msg-text">${esc(m.text)}</div>
            ${actions}
          </div>`;
        }

        const own = m.memberId === me?.id;
        const kindLabel = m.kind === 'guess' ? '猜' : '问';
        let extra = '';
        if (isHost && m.kind === 'question' && room.active && !room.revealed) {
          extra = `<div class="host-answer">${['yes', 'no', 'irrelevant']
            .map(
              (a) =>
                `<button type="button" class="${m.answer === ANSWER_TEXT[a] ? 'is-on' : ''}" data-msg="${esc(m.id)}" data-answer="${a}">${ANSWER_TEXT[a]}</button>`
            )
            .join('')}</div>`;
        } else if (m.answer) {
          extra = `<span class="msg-answer">${esc(m.answer)}</span>`;
        }
        return `<div class="msg ${own ? 'is-mine' : ''} ${m.kind === 'guess' ? 'is-guess' : ''}">
          <div class="msg-meta"><b>${esc(m.name)}</b><em>${kindLabel}</em></div>
          <div class="msg-text">${esc(m.text)}</div>
          ${extra}
        </div>`;
      })
      .join('');

    if (nearBottom) list.scrollTop = list.scrollHeight;

    list.querySelectorAll('.host-answer button[data-answer]').forEach((b) =>
      b.addEventListener('click', async () => {
        try {
          await api(`/rooms/${roomState.code}/answer`, {
            method: 'POST',
            body: JSON.stringify({ token: roomState.token, messageId: b.dataset.msg, answer: b.dataset.answer })
          });
        } catch (err) {
          toast(err.message);
        }
      })
    );

    list.querySelectorAll('.host-answer button[data-hreq]').forEach((b) =>
      b.addEventListener('click', () => {
        const id = b.dataset.hreq;
        if (b.dataset.accept === '0') {
          api(`/rooms/${roomState.code}/hint-answer`, {
            method: 'POST',
            body: JSON.stringify({ token: roomState.token, messageId: id, accept: false })
          }).catch((err) => toast(err.message));
          return;
        }
        // 同意：让主持人写提示内容
        openModal({
          title: '同意提示请求',
          okText: '公布提示',
          bodyHtml: `
            <p class="modal-note">写一句提示公布给所有人；留空则使用本局预备的提示（如果有）。</p>
            <label class="field">
              <span>提示内容 <em>200 字以内</em></span>
              <input id="haText" maxlength="200" placeholder="例如：注意那个红色的东西" />
            </label>`,
          onOk: async (box) => {
            await api(`/rooms/${roomState.code}/hint-answer`, {
              method: 'POST',
              body: JSON.stringify({
                token: roomState.token,
                messageId: id,
                accept: true,
                text: box.querySelector('#haText').value.trim()
              })
            });
            toast('已同意并公布提示');
          }
        });
        document.getElementById('haText')?.focus();
      })
    );
  }

  /* ------------------------------ 弹窗 ------------------------------ */

  function openModal({ title, bodyHtml, okText, onOk, danger, wide }) {
    const overlay = document.createElement('div');
    overlay.className = 'modal';
    overlay.innerHTML = `
      <div class="modal-box ${wide ? 'modal-box--wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <h2>${esc(title)}</h2>
        ${bodyHtml}
        <div class="form-foot">
          <button class="btn ${danger ? '' : 'btn--primary'}" id="modalOk" type="button">${esc(okText || '确定')}</button>
          <button class="btn btn--ghost" id="modalCancel" type="button">取消</button>
          <span class="form-msg" id="modalMsg" aria-live="polite"></span>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('is-on'));

    function close() {
      overlay.classList.remove('is-on');
      setTimeout(() => overlay.remove(), 260);
      document.removeEventListener('keydown', onKey);
    }
    function onKey(e) {
      if (e.key === 'Escape') close();
    }
    document.addEventListener('keydown', onKey);
    overlay.querySelector('#modalCancel').addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    overlay.querySelector('#modalOk').addEventListener('click', async (e) => {
      const ok = async () => {
        e.currentTarget.disabled = true;
        try {
          await onOk(overlay);
          close();
        } catch (err) {
          overlay.querySelector('#modalMsg').className = 'form-msg is-bad';
          overlay.querySelector('#modalMsg').textContent = err.message;
          e.currentTarget.disabled = false;
        }
      };
      ok();
    });
    return overlay;
  }

  function openRename(room) {
    const current = roomState.me?.name || '';
    const overlay = openModal({
      title: '改名',
      bodyHtml: `<label class="field"><span>新名字 <em>14 字以内</em></span>
        <input id="renameInput" maxlength="14" value="${esc(current)}" /></label>`,
      okText: '确定',
      onOk: async (box) => {
        const name = box.querySelector('#renameInput').value.trim();
        if (!name) throw new Error('名字不能为空');
        await api(`/rooms/${room.code}/rename`, { method: 'POST', body: JSON.stringify({ token: roomState.token, name }) });
        saveName(name);
        toast('已改名');
      }
    });
    const input = overlay.querySelector('#renameInput');
    input.focus();
    input.select();
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') overlay.querySelector('#modalOk').click();
    });
  }

  function openConfirmClose(room) {
    openModal({
      title: '结束房间',
      bodyHtml: `<p style="margin:0;color:var(--muted);font-size:14px">所有人都将被移出，房间码作废，无法恢复。</p>`,
      okText: '结束房间',
      danger: true,
      onOk: async () => {
        await api(`/rooms/${room.code}/close`, { method: 'POST', body: JSON.stringify({ token: roomState.token }) });
      }
    });
  }

  async function copyText(text, okMsg) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        toast(okMsg);
        return;
      }
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      toast(ok ? okMsg : text);
    } catch {
      toast(text);
    }
  }

  /* ------------------------------ 生命周期 ------------------------------ */

  window.addEventListener('pagehide', closeStream);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && roomState.room && !roomState.es) startStream();
  });

  function viewCustomRooms() {
    return viewLobby();
  }

  window.TS.rooms = {
    viewRooms: viewCustomRooms,
    viewPresetRooms: viewCustomRooms,
    viewLobby,
    viewRoom,
    closeStream,
    state: roomState,
    profile
  };
})();
