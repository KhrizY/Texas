'use strict';
const $ = (id) => document.getElementById(id);
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const rankStr = (r) => RANKS[r] || String(r);

// 转义用户输入，防止 innerHTML 注入（XSS）
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 筹码面额与配色（不同数值不同颜色）
const DENOMS = [
  { v: 1000, c: '#f5c542', t: '#4a3b00' },
  { v: 500, c: '#9b59b6', t: '#ffffff' },
  { v: 100, c: '#2c3e50', t: '#ffffff' },
  { v: 25, c: '#35b26a', t: '#04351c' },
  { v: 5, c: '#e0524a', t: '#ffffff' },
  { v: 1, c: '#ecf0f1', t: '#2b2b2b' },
];
function breakdown(amount) {
  const out = [];
  let a = Math.max(0, Math.floor(amount));
  for (const d of DENOMS) {
    const n = Math.floor(a / d.v);
    if (n > 0) { out.push({ ...d, count: n }); a -= n * d.v; }
  }
  return out;
}

let ws = null;
let state = null;
let prevState = null;
let myId = localStorage.getItem('poker_pid') || '';
let myRoom = '';
let myPwd = '';
let reconnectTimer = null;
let raiseTarget = 0;
let muted = localStorage.getItem('poker_muted') === '1';
let audioCtx = null;

// ---------- 音效 ----------
function ensureAudio() {
  if (muted) return null;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!audioCtx) audioCtx = new AC();
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx;
}
function tone(freq, duration, type, gain, delay) {
  const ctx = ensureAudio();
  if (!ctx) return;
  const t0 = ctx.currentTime + (delay || 0);
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type || 'sine';
  osc.frequency.setValueAtTime(freq, t0);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain || 0.05, t0 + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(g).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.03);
}
function noise(duration, gain, delay) {
  const ctx = ensureAudio();
  if (!ctx) return;
  const t0 = ctx.currentTime + (delay || 0);
  const len = Math.max(1, Math.floor(ctx.sampleRate * duration));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = ctx.createBufferSource();
  const filter = ctx.createBiquadFilter();
  const g = ctx.createGain();
  filter.type = 'bandpass';
  filter.frequency.value = 900;
  g.gain.value = gain || 0.04;
  src.buffer = buf;
  src.connect(filter).connect(g).connect(ctx.destination);
  src.start(t0);
}
function playSound(name) {
  if (muted) return;
  if (name === 'deal') { noise(0.08, 0.025); tone(520, 0.06, 'triangle', 0.025, 0.015); }
  else if (name === 'bet') { tone(220, 0.05, 'square', 0.035); tone(330, 0.07, 'square', 0.025, 0.045); noise(0.07, 0.018, 0.02); }
  else if (name === 'turn') { tone(660, 0.08, 'sine', 0.045); tone(880, 0.08, 'sine', 0.035, 0.08); }
  else if (name === 'win') { tone(523, 0.10, 'triangle', 0.045); tone(659, 0.10, 'triangle', 0.045, 0.10); tone(784, 0.16, 'triangle', 0.05, 0.20); }
}
function updateSoundButton() {
  const btn = $('soundBtn');
  if (!btn) return;
  btn.textContent = muted ? '🔇' : '🔊';
  btn.title = muted ? '开启音效' : '关闭音效';
}

// ---------- WebSocket ----------
function baseURL(path) {
  const u = new URL(location.href);
  u.search = ''; u.hash = '';
  const last = u.pathname.split('/').pop() || '';
  if (!u.pathname.endsWith('/')) {
    if (last.includes('.')) u.pathname = u.pathname.replace(/[^/]*$/, '');
    else u.pathname += '/';
  }
  return new URL(path, u).toString();
}

function wsURL() {
  const u = new URL(baseURL(''));
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.toString();
}
function connect(nick, room, pwd) {
  myRoom = room;
  myPwd = pwd || '';
  ws = new WebSocket(wsURL());
  ws.onopen = () => send({ type: 'join', roomId: room, nickname: nick, password: myPwd, playerId: myId || undefined });
  ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } handle(m); };
  ws.onclose = () => {
    if (myRoom) {
      $('statusLabel').textContent = '连接断开，重连中…';
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => connect(nick, room, myPwd), 1500);
    }
  };
  ws.onerror = () => { try { ws.close(); } catch {} };
}
function send(obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }

function handle(msg) {
  if (msg.type === 'joined') {
    myId = msg.playerId;
    localStorage.setItem('poker_pid', myId);
    $('login').classList.add('hidden');
    $('game').classList.remove('hidden');
    return;
  }
  if (msg.type === 'error') { toast(msg.msg); return; }
  if (msg.type === 'chat') { appendChat(msg.name, msg.text); return; }
  if (msg.type === 'react') { showEmoji(msg.seat, msg.emoji); return; }
  if (msg.type === 'state') {
    prevState = state;
    state = msg;
    render();
    runAnimations();
    runSounds();
    // 机器人表情反应：用 ts 去重，防止重复渲染触发两次
    if (msg.botReact && msg.botReact.ts !== _lastBotReactTS) {
      _lastBotReactTS = msg.botReact.ts;
      showEmoji(msg.botReact.seat, msg.botReact.emoji);
    }
  }
}

// ---------- 渲染 ----------
function render() {
  if (!state) return;
  const s = state;
  $('roomLabel').textContent = s.roomId;
  $('blindLabel').textContent = `${s.config.sb}/${s.config.bb}`;
  const map = { waiting: '等待开始', playing: `第 ${s.handNumber} 局 · ${streetName(s.street)}`, showdown: '本局结束' };
  $('statusLabel').textContent = map[s.status] || '';
  $('hostBtn').classList.toggle('hidden', !s.you.isHost);
  $('addBotTopBtn').classList.toggle('hidden', !s.you.isHost);

  renderBoard();
  renderPot();
  renderSeats();
  renderControls();
  renderWinner();
  renderLog();
  if (!$('hostPanel').classList.contains('hidden')) renderGrantList();
}
function streetName(st) {
  return { preflop: '翻牌前', flop: '翻牌', turn: '转牌', river: '河牌', showdown: '摊牌' }[st] || '';
}

function cardEl(c, mini) {
  const el = document.createElement('div');
  if (!c) { el.className = 'card back' + (mini ? ' mini' : ''); return el; }
  el.className = 'card' + (mini ? ' mini' : '') + ((c.s === 1 || c.s === 2) ? ' red' : '');
  el.innerHTML = `<div class="r">${rankStr(c.r)}</div><div class="s">${SUITS[c.s]}</div>`;
  return el;
}
function renderBoard() {
  const box = $('board');
  const curBoard = state.board || [];
  const prevBoard = prevState ? (prevState.board || []) : [];

  // 新一局 / board 缩容（不应发生）→ 全量重置
  if (!prevState || prevState.handNumber !== state.handNumber || curBoard.length < prevBoard.length) {
    box.innerHTML = '';
    curBoard.forEach(c => box.appendChild(cardEl(c, false)));
    return;
  }

  // 无新增牌 → 不动（避免覆盖已渲染的卡片）
  if (curBoard.length <= prevBoard.length) return;

  // 有新增牌 → 逐张翻牌动画
  const newCards = curBoard.slice(prevBoard.length);
  newCards.forEach((card, i) => {
    setTimeout(() => {
      const el = cardEl(card, false);
      el.classList.add('card-flip-in');
      box.appendChild(el);
    }, i * 380);
  });
}

// 筹码堆元素
function chipStackEl(amount, compact) {
  const wrap = document.createElement('div');
  wrap.className = 'chip-stack' + (compact ? ' compact' : '');
  const parts = breakdown(amount);
  for (const p of parts) {
    const pile = document.createElement('div');
    pile.className = 'chip-pile';
    const shown = Math.min(p.count, compact ? 3 : 5);
    for (let i = 0; i < shown; i++) {
      const chip = document.createElement('div');
      chip.className = 'chip';
      chip.style.background = p.c;
      chip.style.color = p.t;
      chip.style.bottom = (i * 4) + 'px';
      if (p.count > shown) chip.classList.add('many');
      if (i === shown - 1) chip.textContent = p.count > shown ? '×' + p.count : String(p.v);
      pile.appendChild(chip);
    }
    wrap.appendChild(pile);
  }
  const label = document.createElement('div');
  label.className = 'chip-amt';
  label.textContent = amount;
  wrap.appendChild(label);
  return wrap;
}

function walletChipEl(amount) {
  const wrap = document.createElement('div');
  wrap.className = 'chip-stack compact';
  const parts = breakdown(amount);
  if (!parts.length) return wrap;
  const top = parts[parts.length - 1]; // 取最大面额，避免多牌堆横向变宽遮挡名字
  const pile = document.createElement('div');
  pile.className = 'chip-pile';
  const shown = Math.min(top.count, 3);
  for (let i = 0; i < shown; i++) {
    const chip = document.createElement('div');
    chip.className = 'chip';
    chip.style.background = top.c;
    chip.style.color = top.t;
    chip.style.bottom = (i * 4) + 'px';
    pile.appendChild(chip);
  }
  wrap.appendChild(pile);
  return wrap;
}

function renderPot() {
  const box = $('potBox');
  box.innerHTML = '';
  if (state.pot > 0 && state.status !== 'showdown') {
    box.classList.remove('hidden');
    const lab = document.createElement('span');
    lab.className = 'pot-label'; lab.textContent = '底池';
    box.appendChild(lab);
    box.appendChild(chipStackEl(state.pot, true));
  } else {
    box.classList.add('hidden');
  }
}

// 座位沿胶囊（圆角矩形拉满）周长排布：你的座位在底部正中
// 以单位 u 计算（桌面 16 x 10），再换算成百分比
function seatPos(offset, total) {
  const R = 4.5, straight = 7;               // 半圆半径 / 直边长度（更扁的 16x9 胶囊）
  const P = 2 * straight + 2 * Math.PI * R;  // 周长
  const d0 = straight + Math.PI * R + straight / 2; // 底中（你的座位）对应弧长
  let d = (d0 + (offset / total) * P) % P;
  if (d < 0) d += P;
  let x, y, nx, ny;                          // 点 + 指向桌心（内）的法线
  if (d <= straight) {                        // 顶边（左→右）
    x = R + d; y = 0; nx = 0; ny = 1;
  } else if (d <= straight + Math.PI * R) {   // 右半圆
    const a = d - straight, th = -Math.PI / 2 + a / R;
    x = (R + straight) + R * Math.cos(th); y = R + R * Math.sin(th);
    nx = -Math.cos(th); ny = -Math.sin(th);
  } else if (d <= 2 * straight + Math.PI * R) { // 底边（右→左）
    const a2 = d - (straight + Math.PI * R); x = (R + straight) - a2; y = 2 * R; nx = 0; ny = -1;
  } else {                                    // 左半圆
    const a3 = d - (2 * straight + Math.PI * R), th = Math.PI / 2 + a3 / R;
    x = R + R * Math.cos(th); y = R + R * Math.sin(th);
    nx = -Math.cos(th); ny = -Math.sin(th);
  }
  const m = -1.4;                            // 统一外推：玩家卡片移到桌面外圈、围绕桌面（不再压在台面上）
  x += nx * m; y += ny * m;
  return { x: x / 16 * 100, y: y / 9 * 100 };
}

function renderSeats() {
  const layer = $('seats');
  layer.innerHTML = '';
  const total = state.activeSeats || state.config.maxSeats;
  const yourSeat = state.you.seat;
  const seated = yourSeat !== null;

  for (let s = 0; s < total; s++) {
    const offset = seated ? ((s - yourSeat + total) % total) : s;
    const pos = seatPos(offset, total);
    const seatData = state.seats[s];

    const wrap = document.createElement('div');
    wrap.className = 'seat';
    wrap.style.left = pos.x + '%';
    wrap.style.top = pos.y + '%';

    if (!seatData) {
      const empty = document.createElement('div');
      empty.className = 'seat-empty';
      empty.textContent = `坐下 (${s + 1})`;
      const canSit = !seated && state.status !== 'playing';
      if (canSit) {
        empty.onclick = () => send({ type: 'sit', seat: s });
      } else {
        empty.classList.add('disabled');
        empty.style.opacity = '.5';
        if (seated) { empty.title = '你已在座位上，无法移动到其他座位'; }
        else { empty.title = '本局进行中，结束后才能入座'; }
        empty.onclick = () => toast(seated ? '你已在座位上' : '本局进行中，结束后才能入座');
      }
      wrap.appendChild(empty);
    } else {
      wrap.appendChild(playerBox(seatData));
    }
    layer.appendChild(wrap);

    // 下注筹码：自适应位置——侧位靠外不挡公共牌，上下位靠内不挡卡
    if (seatData && seatData.roundBet > 0) {
      const xDistFromCenter = Math.abs(pos.x - 50) / 50; // 0=上下, 1=左右侧
      const k = 0.30 + (1 - xDistFromCenter) * 0.30;     // 侧位0.30, 上下位0.60
      const bp = { x: pos.x + (50 - pos.x) * k, y: pos.y + (50 - pos.y) * k };
      const bet = document.createElement('div');
      bet.className = 'bet-chips-layer';
      bet.style.left = bp.x + '%';
      bet.style.top = bp.y + '%';
      bet.appendChild(chipStackEl(seatData.roundBet, true));
      layer.appendChild(bet);
    }
  }
  renderTimers();
}

function playerBox(p) {
  const box = document.createElement('div');
  box.className = 'player-box';
  if (p.isActor) box.classList.add('actor');
  if (p.folded) box.classList.add('folded');
  const isWinner = state.winners && state.winners.some((w) => w.seat === p.seat && w.amount > 0);
  if (state.status === 'showdown' && isWinner) box.classList.add('winner');
  box.dataset.seat = p.seat;

  // 自己的卡片右上角放表情按钮
  if (p.isYou) {
    const trigger = document.createElement('button');
    trigger.className = 'react-trigger';
    trigger.textContent = '😊';
    trigger.title = '表情';
    trigger.onclick = (e) => { e.stopPropagation(); toggleEmojiPicker(trigger, p.seat); };
    box.appendChild(trigger);
  }

  if (p.hasCards && !p.folded) {
    const hc = document.createElement('div');
    hc.className = 'hole-cards';
    if (p.hole) p.hole.forEach((c) => hc.appendChild(cardEl(c, true)));
    else { hc.appendChild(cardEl(null, true)); hc.appendChild(cardEl(null, true)); }
    box.appendChild(hc);
  }

  const info = document.createElement('div');
  info.className = 'player-info';

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = (p.name || '?').trim().slice(0, 1).toUpperCase();
  info.appendChild(avatar);

  const text = document.createElement('div');
  text.className = 'player-text';
  const name = document.createElement('div');
  name.className = 'pname';
  name.textContent = p.name + (p.connected ? '' : ' 💤');
  text.appendChild(name);

  const stack = document.createElement('div');
  stack.className = 'pstack';
  stack.textContent = '💰 ' + p.stack;
  text.appendChild(stack);
  info.appendChild(text);

  box.appendChild(info);

  const badges = document.createElement('div');
  badges.className = 'pbadges';
  if (p.isBot) badges.appendChild(badge('BOT', 'bot'));
  if (p.isButton) badges.appendChild(badge('D', 'd'));
  if (p.isSmallBlind) badges.appendChild(badge('SB', 'sb'));
  if (p.isBigBlind) badges.appendChild(badge('BB', 'bb'));
  if (p.isYou) badges.appendChild(badge('你', 'you'));
  if (p.isHost) badges.appendChild(badge('房主', 'host'));
  if (p.allIn) badges.appendChild(badge('ALL-IN', 'allin'));
  if (p.sittingOut && !p.inHand) badges.appendChild(badge('暂离', 'out'));
  box.appendChild(badges);

  // 玩家筹码堆：放在人物卡片右侧，不遮挡卡片
  if (p.stack > 0) {
    const wallet = document.createElement('div');
    wallet.className = 'wallet-side';
    wallet.appendChild(walletChipEl(p.stack));
    box.appendChild(wallet);
  }

  const w = state.winners && state.winners.find((x) => x.seat === p.seat);
  if (state.status === 'showdown' && w && w.reveal) {
    const hn = document.createElement('div');
    hn.className = 'pstack';
    hn.style.color = '#fff';
    hn.textContent = w.handName + (w.amount > 0 ? ` +${w.amount}` : '');
    box.appendChild(hn);
  }

  if (p.isActor && state.status === 'playing') {
    const ring = document.createElement('div');
    ring.className = 'timer-ring';
    ring.innerHTML = '<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><rect class="timer-track" x="3" y="3" width="94" height="94" rx="10" ry="10" pathLength="100"/><rect class="timer-progress" x="3" y="3" width="94" height="94" rx="10" ry="10" pathLength="100"/></svg>';
    box.appendChild(ring);
  }
  return box;
}
function badge(text, cls) {
  const b = document.createElement('span');
  b.className = 'badge ' + cls; b.textContent = text; return b;
}

function renderTimers() {
  if (!state || state.status !== 'playing' || state.actor === null) return;
  const box = document.querySelector(`.player-box[data-seat="${state.actor}"] .timer-ring`);
  if (!box) return;
  const total = state.config.actionTimeoutMs;
  const left = Math.max(0, state.deadline - Date.now());
  const frac = Math.max(0, Math.min(1, left / total));
  const pct = Math.round(frac * 100);
  const color = frac > 0.4 ? '#f5c542' : '#e0524a';
  const progress = box.querySelector('.timer-progress');
  if (progress) {
    progress.style.strokeDasharray = '100';
    progress.style.strokeDashoffset = String(100 - pct);
    progress.style.stroke = color;
  }
}
setInterval(renderTimers, 100);

// ---------- 控制区 ----------
function renderControls() {
  const s = state;
  const host = $('hostControls'), action = $('actionBar'), wait = $('waitHint');
  host.classList.add('hidden'); action.classList.add('hidden'); wait.textContent = '';
  const oldRebuy = $('rebuyBtn'); if (oldRebuy) oldRebuy.remove();

  if (s.you.isHost) {
    host.classList.remove('hidden');
    $('autoNextBtn').textContent = `自动下一局：${s.autoNext ? '开' : '关'}`;
    $('autoNextBtn').classList.toggle('btn-primary', !!s.autoNext);
    $('autoNextBtn').classList.toggle('btn-ghost', !s.autoNext);
  }

  const yourTurn = s.legal && s.actor === s.you.seat;
  if (yourTurn) { action.classList.remove('hidden'); return setupActionBar(s.legal); }

  if (s.you.seated && s.you.stack <= 0 && s.status !== 'playing') {
    const rb = document.createElement('button');
    rb.id = 'rebuyBtn'; rb.className = 'btn btn-primary';
    rb.textContent = `补充筹码 (+${s.config.startStack})`;
    rb.onclick = () => send({ type: 'rebuy' });
    host.classList.remove('hidden'); host.appendChild(rb);
  }

  if (s.you.isHost && s.status !== 'playing' && s.seatedCount >= 2) {
    host.classList.remove('hidden');
    $('startBtn').classList.toggle('hidden', s.status !== 'waiting');
    $('nextBtn').classList.toggle('hidden', s.status !== 'showdown');
  } else { $('startBtn').classList.add('hidden'); $('nextBtn').classList.add('hidden'); }
  $('autoNextBtn').classList.toggle('hidden', !s.you.isHost);

  if (!s.you.seated) wait.textContent = '点击空位坐下参与游戏（也可旁观）';
  else if (s.status === 'waiting') wait.textContent = s.you.isHost ? (s.seatedCount < 2 ? '等待更多玩家入座…' : '') : '等待房主开始…';
  else if (s.status === 'playing') {
    const actor = s.actor !== null ? s.seats[s.actor] : null;
    wait.textContent = actor ? `等待 ${actor.name} 行动…` : '发牌中…';
  } else if (s.status === 'showdown') wait.textContent = s.you.isHost ? '' : '本局结束，等待房主开始下一局…';
}

// 指数映射 + 整十吸附
function snapTen(v, min, max) {
  if (v <= min) return min;
  if (v >= max) return max;
  const r = Math.round(v / 10) * 10;
  return Math.max(min, Math.min(max, r));
}
function posToAmount(pos, min, max) {
  const t = pos / 1000;
  let raw;
  if (min > 0) raw = min * Math.pow(max / min, t); // 指数：低端精细，高端粗放
  else raw = min + (max - min) * t;
  return snapTen(raw, min, max);
}
function amountToPos(amt, min, max) {
  if (max <= min) return 0;
  let t;
  if (min > 0) t = Math.log(amt / min) / Math.log(max / min);
  else t = (amt - min) / (max - min);
  return Math.max(0, Math.min(1000, Math.round(t * 1000)));
}

function setupActionBar(legal) {
  const foldBtn = $('foldBtn'), checkBtn = $('checkBtn'), callBtn = $('callBtn');
  const raiseBtn = $('raiseBtn'), slider = $('raiseSlider');

  foldBtn.onclick = () => send({ type: 'action', action: 'fold' });
  checkBtn.classList.toggle('hidden', !legal.canCheck);
  checkBtn.onclick = () => send({ type: 'action', action: 'check' });
  callBtn.classList.toggle('hidden', !legal.canCall);
  callBtn.textContent = '跟注 ' + legal.callAmount;
  callBtn.onclick = () => send({ type: 'action', action: 'call' });

  const raiseGroup = raiseBtn.closest('.raise-group');
  if (!legal.canRaise) { raiseGroup.style.display = 'none'; return; }
  raiseGroup.style.display = '';

  const min = legal.minRaiseTo, max = legal.maxRaiseTo;
  const label = legal.isOpen ? '下注' : '加注到';
  slider.min = 0; slider.max = 1000; slider.step = 1;

  raiseTarget = Math.max(min, Math.min(max, raiseTarget || min));
  const setTarget = (amt) => {
    raiseTarget = Math.max(min, Math.min(max, snapTen(amt, min, max)));
    $('raiseAmt').textContent = raiseTarget;
  };
  slider.value = amountToPos(raiseTarget, min, max);
  raiseBtn.innerHTML = `${label} <span id="raiseAmt">${raiseTarget}</span>`;

  slider.oninput = () => {
    const amt = posToAmount(+slider.value, min, max);
    raiseTarget = amt;
    $('raiseAmt').textContent = amt;
  };
  raiseBtn.onclick = () => send({ type: 'action', action: legal.isOpen ? 'bet' : 'raise', amount: raiseTarget });

  document.querySelectorAll('.chip-btn').forEach((btn) => {
    btn.onclick = () => {
      const mul = btn.dataset.mul;
      let target;
      const pot = state.pot;
      if (mul === 'min') target = min;
      else if (mul === 'max') target = max;
      else {
        const base = legal.isOpen ? 0 : state.currentBet;
        target = base + Math.round(pot * parseFloat(mul));
      }
      setTarget(target);
      slider.value = amountToPos(raiseTarget, min, max);
    };
  });

  // +/- 步进按钮：贴合滑块量程，方便微调
  const step = Math.max(1, Math.round((max - min) / 50));
  $('raiseMinus').onclick = () => { setTarget(raiseTarget - step); slider.value = amountToPos(raiseTarget, min, max); };
  $('raisePlus').onclick = () => { setTarget(raiseTarget + step); slider.value = amountToPos(raiseTarget, min, max); };
}

function renderWinner() {
  const banner = $('winnerBanner');
  if (state.status === 'showdown' && state.winners && state.winners.length) {
    const top = state.winners.filter((w) => w.amount > 0);
    if (top.length) {
      const names = top.map((w) => (state.seats[w.seat] ? state.seats[w.seat].name : '?') + ' +' + w.amount);
      banner.textContent = `🏆 ${names.join('  |  ')}`;
      banner.classList.remove('hidden');
      return;
    }
  }
  banner.classList.add('hidden');
}

function renderLog() {
  const box = $('logBox');
  box.innerHTML = '';
  (state.log || []).forEach((line) => { const d = document.createElement('div'); d.textContent = line; box.appendChild(d); });
  box.scrollTop = box.scrollHeight;
}

// ---------- 聊天 ----------
let unreadChat = 0;
function updateChatBadge() {
  const badge = $('chatBadge');
  if (!badge) return;
  if (unreadChat <= 0) { badge.classList.add('hidden'); return; }
  badge.textContent = unreadChat > 99 ? '99+' : String(unreadChat);
  badge.classList.remove('hidden');
}
function appendChat(name, text) {
  const box = $('chatLog');
  if (!box) return;
  const line = document.createElement('div');
  line.className = 'chat-line';
  const nm = document.createElement('span');
  nm.className = 'chat-name';
  nm.textContent = name + '：';
  const tx = document.createElement('span');
  tx.className = 'chat-text';
  tx.textContent = text; // textContent 天然防 XSS
  line.appendChild(nm);
  line.appendChild(tx);
  box.appendChild(line);
  while (box.children.length > 120) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
  // 面板未打开时累计未读，显示红点提示
  if ($('chatPanel').classList.contains('hidden')) {
    unreadChat++;
    updateChatBadge();
  }
}
function sendChat() {
  const inp = $('chatText');
  const text = inp.value.trim();
  if (!text) return;
  send({ type: 'chat', text });
  inp.value = '';
}

// ---------- 飞行筹码动画 ----------
function rectCenter(el) { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }
function feltCenter() { const el = document.querySelector('.felt'); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }

function flyChips(from, to, amount, opts) {
  opts = opts || {};
  const layer = $('flyLayer');
  const parts = breakdown(amount);
  let colors = [];
  for (const p of parts) for (let i = 0; i < Math.min(p.count, 3); i++) colors.push(p.c);
  if (colors.length === 0) colors = ['#f5c542'];
  const count = Math.min(14, Math.max(3, colors.length));
  for (let i = 0; i < count; i++) {
    const chip = document.createElement('div');
    chip.className = 'chip fly';
    chip.style.background = colors[i % colors.length];
    const jx = (Math.random() - 0.5) * 26, jy = (Math.random() - 0.5) * 26;
    chip.style.left = from.x + 'px'; chip.style.top = from.y + 'px';
    layer.appendChild(chip);
    const delay = i * 35 + (opts.delay || 0);
    requestAnimationFrame(() => {
      chip.style.transition = `transform .55s cubic-bezier(.3,.7,.3,1) ${delay}ms, opacity .3s ${delay + 450}ms`;
      chip.style.transform = `translate(${to.x - from.x + jx}px, ${to.y - from.y + jy}px) scale(.9)`;
      if (opts.fade) chip.style.opacity = '0';
    });
    setTimeout(() => chip.remove(), delay + 900);
  }
}

function runAnimations() {
  if (!state) return;
  // 下注：本轮注额增加 -> 从玩家飞向中心
  if (prevState && prevState.handNumber === state.handNumber &&
      prevState.street === state.street && state.status === 'playing') {
    for (let s = 0; s < state.seats.length; s++) {
      const now = state.seats[s], was = prevState.seats[s];
      if (now && was && now.roundBet > was.roundBet) {
        const box = document.querySelector(`.player-box[data-seat="${s}"]`);
        if (box) flyChips(rectCenter(box), feltCenter(), now.roundBet - was.roundBet, { fade: true });
      }
    }
  }
  // 摊牌：中心筹码飞入赢家
  if (state.status === 'showdown' && (!prevState || prevState.status !== 'showdown') && state.winners) {
    const center = feltCenter();
    state.winners.filter((w) => w.amount > 0).forEach((w, i) => {
      const box = document.querySelector(`.player-box[data-seat="${w.seat}"]`);
      if (box) flyChips(center, rectCenter(box), w.amount, { delay: 250 + i * 120 });
    });
  }
}

function runSounds() {
  if (!state || !prevState) return;
  if (prevState.handNumber !== state.handNumber && state.status === 'playing') playSound('deal');
  if ((prevState.board?.length || 0) < (state.board?.length || 0)) playSound('turn');
  if (prevState.status !== 'showdown' && state.status === 'showdown') playSound('win');
  if (prevState.actor !== state.actor && state.actor === state.you.seat && state.status === 'playing') playSound('turn');
  if (prevState.handNumber === state.handNumber && state.status === 'playing') {
    for (let s = 0; s < state.seats.length; s++) {
      const now = state.seats[s], was = prevState.seats[s];
      if (now && was && now.roundBet > was.roundBet) { playSound('bet'); break; }
    }
  }
}

// ---------- 房主增发面板 ----------
function renderGrantList() {
  const list = $('grantList');
  list.innerHTML = '';
  const seated = state.seats.filter(Boolean);
  if (seated.length === 0) { list.innerHTML = '<div class="grant-empty">暂无在座玩家</div>'; return; }
  for (const p of seated) {
    const row = document.createElement('div');
    row.className = 'grant-row';
    row.innerHTML = `<span class="grant-name">${esc(p.name)}${p.isBot ? ' 🤖' : ''}${p.isYou ? '（你）' : ''}</span><span class="grant-stack">💰 ${p.stack}</span>`;
    [200, 500, 1000].forEach((amt) => {
      const b = document.createElement('button');
      b.className = 'btn btn-primary grant-btn';
      b.textContent = '+' + amt;
      b.onclick = () => send({ type: 'grant', seat: p.seat, amount: amt });
      row.appendChild(b);
    });
    if (p.isBot) {
      const rm = document.createElement('button');
      rm.className = 'btn btn-fold grant-btn';
      rm.textContent = '移除';
      rm.onclick = () => send({ type: 'removeBot', seat: p.seat });
      row.appendChild(rm);
    }
    list.appendChild(row);
  }
}
$('hostBtn').onclick = () => { $('hostPanel').classList.remove('hidden'); renderGrantList(); };
$('addBotBtn').onclick = () => send({ type: 'addBot' });
$('addBotTopBtn').onclick = () => send({ type: 'addBot' });
$('hostClose').onclick = () => $('hostPanel').classList.add('hidden');
$('hostPanel').onclick = (e) => { if (e.target.id === 'hostPanel') $('hostPanel').classList.add('hidden'); };
document.querySelectorAll('.grant-all').forEach((b) => {
  b.onclick = () => {
    const amt = +b.dataset.amt;
    state.seats.filter(Boolean).forEach((p) => send({ type: 'grant', seat: p.seat, amount: amt }));
  };
});

// ---------- 提示 ----------
let toastTimer = null;
function toast(text) {
  const t = $('toast');
  t.textContent = text; t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2200);
}

// ---------- 登录 ----------
async function loadRooms() {
  const box = $('roomList');
  if (!box) return;
  try {
    const res = await fetch(baseURL('api/rooms'), { cache: 'no-store' });
    const data = await res.json();
    const rooms = data.rooms || [];
    box.innerHTML = '';
    if (!rooms.length) {
      box.innerHTML = '<span class="muted-small">暂无房间，创建一个吧</span>';
      return;
    }
    rooms.forEach((r) => {
      const item = document.createElement('button');
      item.className = 'room-item';
      const st = r.status === 'playing' ? '进行中' : (r.status === 'showdown' ? '结算中' : '等待中');
      const lock = r.locked ? ' 🔒' : '';
      item.innerHTML = `<b>${esc(r.roomId)}${lock}</b><span>${st} · ${r.seatedCount}人 · BOT ${r.bots}</span>`;
      item.onclick = () => {
        $('room').value = r.roomId;
        if (!$('nick').value.trim()) $('nick').value = '观众' + Math.floor(Math.random() * 90 + 10);
        if (r.locked) {
          // 加锁房间：填好房间号并聚焦密码框，等用户输密码
          $('pwd').focus();
          toast('该房间已加密，请输入密码');
          return;
        }
        $('enterBtn').click();
      };
      box.appendChild(item);
    });
  } catch (e) {
    box.innerHTML = '<span class="muted-small">房间列表加载失败</span>';
  }
}
$('refreshRoomsBtn').onclick = loadRooms;
loadRooms();
setInterval(() => { if (!$('login').classList.contains('hidden')) loadRooms(); }, 5000);

$('enterBtn').onclick = () => {
  const nick = $('nick').value.trim() || '玩家' + Math.floor(Math.random() * 900 + 100);
  const room = $('room').value.trim() || 'main';
  const pwd = $('pwd').value;
  localStorage.setItem('poker_nick', nick);
  localStorage.setItem('poker_room', room);
  connect(nick, room, pwd);
};
$('nick').value = localStorage.getItem('poker_nick') || '';
$('room').value = localStorage.getItem('poker_room') || '';
$('soundBtn').onclick = () => {
  muted = !muted;
  localStorage.setItem('poker_muted', muted ? '1' : '0');
  if (!muted) { ensureAudio(); playSound('turn'); }
  updateSoundButton();
};
updateSoundButton();

// 聊天面板
$('chatBtn').onclick = () => {
  const p = $('chatPanel');
  p.classList.toggle('hidden');
  if (!p.classList.contains('hidden')) {
    $('chatText').focus();
    unreadChat = 0; // 打开即已读，清除红点
    updateChatBadge();
  }
};
$('chatClose').onclick = () => $('chatPanel').classList.add('hidden');
$('chatSend').onclick = sendChat;
$('chatText').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

// 实时表情
const EMOJIS = ['👏', '👍', '😂', '😡', '😲', '🤔', '💪', '🔥', '😭'];
let _activePicker = null;
let _lastBotReactTS = 0;

function toggleEmojiPicker(trigger, seat) {
  // 已打开则关闭
  if (_activePicker) {
    _activePicker.remove();
    _activePicker = null;
    if (_activePicker === trigger._picker) return; // 已关闭自己
  }
  // 新建选择器
  const picker = document.createElement('div');
  picker.className = 'react-picker';
  EMOJIS.forEach(e => {
    const btn = document.createElement('button');
    btn.className = 'emoji-btn';
    btn.textContent = e;
    btn.onclick = (ev) => { ev.stopPropagation(); sendEmoji(seat, e); picker.remove(); _activePicker = null; };
    picker.appendChild(btn);
  });
  trigger.appendChild(picker);
  trigger._picker = picker;
  _activePicker = picker;
}

function sendEmoji(seat, emoji) {
  if (!myId || !ws || ws.readyState !== WebSocket.OPEN) return;
  send({ type: 'react', emoji });
  showEmoji(seat, emoji);
}

// 点击空白关闭选择器
document.addEventListener('click', (e) => {
  if (!_activePicker) return;
  if (!e.target.closest('.react-picker') && !e.target.closest('.react-trigger')) {
    _activePicker.remove();
    _activePicker = null;
  }
});

function showEmoji(seat, emoji) {
  if (!emoji) return;
  let target;
  if (seat !== null && seat >= 0) {
    target = document.querySelector(`.player-box[data-seat="${seat}"]`);
  }
  if (!target) {
    target = document.querySelector('.felt') || document.body;
  }
  const rect = target.getBoundingClientRect();
  const el = document.createElement('div');
  el.className = 'emoji-float';
  el.textContent = emoji;
  el.style.left = (rect.left + rect.width / 2 - 18) + 'px';
  el.style.top = (rect.top - 10) + 'px';
  $('emojiLayer').appendChild(el);
  setTimeout(() => el.remove(), 2000);
}

$('autoNextBtn').onclick = () => send({ type: 'setAutoNext', enabled: !(state && state.autoNext) });
$('startBtn').onclick = () => send({ type: 'start' });
$('nextBtn').onclick = () => send({ type: 'next' });
$('leaveBtn').onclick = () => { myRoom = ''; if (ws) { try { ws.close(); } catch {} } location.reload(); };
$('room').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('enterBtn').click(); });
$('pwd').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('enterBtn').click(); });

// ---------- 牌桌缩放（桌面 / 手机通用） ----------
// 通过 transform: scale() 缩放牌桌主体 .felt，座位与卡牌随容器等比缩放；
// 飞行筹码动画使用 getBoundingClientRect，会因 transform 自动对齐，无需额外处理。
(function setupZoom() {
  const felt = document.getElementById('felt');
  const zoomVal = document.getElementById('zoomVal');
  const zoomIn = document.getElementById('zoomIn');
  const zoomOut = document.getElementById('zoomOut');
  if (!felt || !zoomVal || !zoomIn || !zoomOut) return;

  const MIN = 0.6, MAX = 1.4, STEP = 0.1;
  const clamp = (z) => Math.min(MAX, Math.max(MIN, Math.round(z * 10) / 10));

  let zoom = clamp(parseFloat(localStorage.getItem('poker_zoom')) || 1);
  const apply = () => {
    felt.style.transform = 'scale(' + zoom + ')';
    zoomVal.textContent = Math.round(zoom * 100) + '%';
    localStorage.setItem('poker_zoom', String(zoom));
  };
  const change = (d) => { zoom = clamp(zoom + d); apply(); };

  zoomIn.onclick = () => change(STEP);
  zoomOut.onclick = () => change(-STEP);

  // 触控板双指捏合（桌面 Chrome/Safari 以 wheel + ctrlKey 表达）
  felt.addEventListener('wheel', (e) => {
    if (e.ctrlKey) { e.preventDefault(); change(e.deltaY < 0 ? STEP : -STEP); }
  }, { passive: false });

  // 手机双指捏合缩放
  let pinchStart = 0, pinchBase = 1;
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  felt.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) { pinchStart = dist(e.touches); pinchBase = zoom; }
  }, { passive: true });
  felt.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2 && pinchStart) {
      zoom = clamp(pinchBase * dist(e.touches) / pinchStart);
      apply();
    }
  }, { passive: true });
  felt.addEventListener('touchend', () => { pinchStart = 0; }, { passive: true });

  apply();
})();
