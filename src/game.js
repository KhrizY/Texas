'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { newShuffledDeck } = require('./deck');
const { bestOf, cmp, CATEGORY_NAMES } = require('./evaluator');
const { decideBotAction, trackAction, botReaction } = require('./bot');
const { recordSample, finalizeHandSamples } = require('./learn-online');

const STREETS = ['preflop', 'flop', 'turn', 'river', 'showdown'];

// 一个房间 = 一张牌桌
class Game {
  constructor(id, opts = {}) {
    this.id = id;
    this.config = {
      maxSeats: opts.maxSeats || 9,
      minSeats: opts.minSeats || 6,
      sb: opts.sb || 5,
      bb: opts.bb || 10,
      startStack: opts.startStack || 1000,
      actionTimeoutMs: opts.actionTimeoutMs || 30000,
    };
    this.players = new Map(); // id -> {id,name,seat,stack,connected,sittingOut}
    this.seats = new Array(this.config.maxSeats).fill(null); // seat -> playerId|null
    this.hostId = null;
    this.buttonSeat = -1;
    this.handNumber = 0;
    this.hand = null; // 当前手牌状态
    this.status = 'waiting'; // waiting | playing | showdown
    this.log = [];
    this.lastMessage = '等待玩家入座…';
    this._timer = null;
    this._botTimer = null;
    this._autoNextTimer = null;
    this._runoutTimers = [];
    this.autoNext = false;
    this.animateTransitions = opts.animateTransitions === true; // 人类对局时启用发牌停顿动画
    this.onChange = opts.onChange || (() => {});
    // 机器人对手追踪 & 多街计划
    this._botStats = {};
    this._botPlans = {};
    this._lastBotReaction = null;
    // 线上学习样本
    this._learnSamples = [];
    this._learnLog = [];
  }

  _log(text) {
    this.log.push(text);
    if (this.log.length > 40) this.log.shift();
    this.lastMessage = text;
  }

  _changed() { this.onChange(); }

  // ---------- 玩家 / 座位 ----------
  addPlayer(id, name, opts = {}) {
    let p = this.players.get(id);
    if (p) { p.connected = true; p.name = name || p.name; return p; }
    p = { id, name: name || '玩家', seat: null, stack: 0, connected: true, sittingOut: false, isBot: !!opts.isBot };
    this.players.set(id, p);
    if (!this.hostId && !p.isBot) this.hostId = id;
    this._log(`${p.name} 进入房间`);
    return p;
  }

  disconnect(id) {
    const p = this.players.get(id);
    if (!p) return;
    p.connected = false;
    this._log(`${p.name} 掉线`);
    // 非牌局进行中（等待/结算）：立即释放座位，让房间状态刷新、他人可入座
    if (this.status !== 'playing') {
      this._removePlayer(id);
    }
    // 牌局进行中：保留座位，由超时逻辑自动处理其行动；当局结束后在 _finishHand 中统一清理
    this._reassignHost();
    this._changed();
  }

  _removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    if (p.seat !== null) this.seats[p.seat] = null;
    this.players.delete(id);
  }

  // 清理所有已掉线的真人玩家（机器人始终在线，不受影响）
  _cleanupDisconnected() {
    for (const [pid, p] of [...this.players.entries()]) {
      if (!p.connected) this._removePlayer(pid);
    }
    this._reassignHost();
  }

  _reassignHost() {
    if (this.hostId && this.players.get(this.hostId)?.connected) return;
    const next = [...this.players.values()].find((p) => p.connected && !p.isBot);
    this.hostId = next ? next.id : null;
  }

  // 动态座位数：初始默认 minSeats(6) 个位置；占用达到 minSeats 后随人数 +1 扩展，最高 maxSeats(9)；始终保持均匀分布
  activeSeatCount() {
    const MIN = this.config.minSeats, MAX = this.config.maxSeats;
    let occupied = 0, maxIdx = -1;
    for (let s = 0; s < this.seats.length; s++) {
      if (this.seats[s]) { occupied++; if (s > maxIdx) maxIdx = s; }
    }
    let n = Math.max(MIN, occupied + (occupied >= MIN ? 1 : 0));
    if (maxIdx + 1 > n) n = maxIdx + 1; // 不遗漏任何已占座位
    return Math.min(MAX, n);
  }

  // 选取使座位均匀分布的空位：最大化到最近已占座的最小弧距
  _pickEvenSeat() {
    const total = this.activeSeatCount();
    const occupied = new Set();
    const empty = [];
    for (let s = 0; s < total; s++) {
      if (this.seats[s]) occupied.add(s);
      else empty.push(s);
    }
    if (empty.length === 0) return -1;
    if (occupied.size === 0) return 0;
    let bestSeat = empty[0], bestDist = -1;
    for (const s of empty) {
      let minDist = total;
      for (const o of occupied) {
        const d = Math.min((s - o + total) % total, (o - s + total) % total);
        if (d < minDist) minDist = d;
      }
      if (minDist > bestDist) { bestDist = minDist; bestSeat = s; }
    }
    return bestSeat;
  }

  addBot(byId) {
    if (byId && byId !== this.hostId) return { error: '只有房主可以添加机器人' };
    const emptySeat = this._pickEvenSeat();
    if (emptySeat < 0) return { error: '座位已满' };
    const botCatalog = getBotCatalog();
    const used = new Set([...this.players.values()].map((p) => p.name));
    const unused = botCatalog.filter((x) => !used.has(x.name));
    const pool = unused.length ? unused : botCatalog;
    const entry = pool[Math.floor(Math.random() * pool.length)];
    const name = entry.name;
    const id = 'bot' + crypto.randomBytes(8).toString('hex');
    const bot = this.addPlayer(id, name, { isBot: true });
    bot.botStyle = entry.style || '自学习风格';
    bot.botProfile = entry.profile;
    const res = this.sit(id, emptySeat);
    if (res.error) return res;
    this._log(`${name} 加入为机器人`);
    this._changed();
    return { ok: true, id, seat: emptySeat };
  }

  removeBot(byId, seat) {
    if (byId && byId !== this.hostId) return { error: '只有房主可以移除机器人' };
    const id = this.seats[seat];
    if (!id) return { error: '该座位无人' };
    const p = this.players.get(id);
    if (!p || !p.isBot) return { error: '只能移除机器人' };
    if (this.status === 'playing' && this.hand && this.hand.ps[seat] && !this.hand.ps[seat].folded) {
      return { error: '牌局进行中不能移除正在参与的机器人' };
    }
    this.seats[seat] = null;
    this.players.delete(id);
    this._log(`${p.name} 机器人已移除`);
    this._changed();
    return { ok: true };
  }

  sit(id, seat) {
    const p = this.players.get(id);
    if (!p) return { error: '玩家不存在' };
    if (seat < 0 || seat >= this.activeSeatCount()) return { error: '座位无效' };
    if (this.seats[seat]) return { error: '该座位已被占用' };
    if (p.seat !== null) this.seats[p.seat] = null;
    p.seat = seat;
    p.stack = this.config.startStack;
    p.sittingOut = false;
    this.seats[seat] = id;
    this._log(`${p.name} 坐到 ${seat + 1} 号位（买入 ${p.stack}）`);
    this._changed();
    return { ok: true };
  }

  stand(id) {
    const p = this.players.get(id);
    if (!p || p.seat === null) return { error: '你不在座位上' };
    if (p.isBot) return { error: '机器人不能手动离座，请用移除机器人' };
    // 若正在牌局中且未弃牌，先按弃牌处理
    if (this.hand && this.hand.ps[p.seat] && !this.hand.ps[p.seat].folded && !this.hand.ps[p.seat].done) {
      this.hand.ps[p.seat].folded = true;
    }
    this.seats[p.seat] = null;
    p.seat = null;
    p.stack = 0;
    this._log(`${p.name} 离开座位`);
    this._changed();
    return { ok: true };
  }

  setAutoNext(byId, enabled) {
    if (byId && byId !== this.hostId) return { error: '只有房主可以设置自动下一局' };
    this.autoNext = !!enabled;
    this._log(`自动下一局已${this.autoNext ? '开启' : '关闭'}`);
    if (this.autoNext && this.status === 'showdown') this._scheduleAutoNext();
    if (!this.autoNext && this._autoNextTimer) { clearTimeout(this._autoNextTimer); this._autoNextTimer = null; }
    this._changed();
    return { ok: true };
  }

  // 房主实时增发筹码给某座位
  grant(byId, seat, amount) {
    if (byId && byId !== this.hostId) return { error: '只有房主可以增发筹码' };
    amount = Math.floor(amount);
    if (!(amount > 0)) return { error: '金额无效' };
    const id = this.seats[seat];
    if (!id) return { error: '该座位无人' };
    const p = this.players.get(id);
    p.stack += amount;
    if (p.stack > 0) p.sittingOut = false;
    this._log(`房主给 ${p.name} 增发 ${amount} 筹码`);
    this._changed();
    return { ok: true };
  }

  rebuy(id) {
    const p = this.players.get(id);
    if (!p || p.seat === null) return { error: '请先坐下' };
    if (this.hand && this.hand.ps[p.seat] && !this.hand.ps[p.seat].folded) {
      return { error: '本局结束后才能补充筹码' };
    }
    p.stack = this.config.startStack;
    p.sittingOut = false;
    this._log(`${p.name} 补充筹码到 ${p.stack}`);
    this._changed();
    return { ok: true };
  }

  _seatedActive() {
    // 可参与下一局的座位：有玩家且有筹码
    const arr = [];
    for (let s = 0; s < this.config.maxSeats; s++) {
      const id = this.seats[s];
      if (!id) continue;
      const p = this.players.get(id);
      if (p && p.stack > 0 && !p.sittingOut) arr.push(s);
    }
    return arr;
  }

  // ---------- 开局 ----------
  startHand(byId) {
    if (byId && byId !== this.hostId) return { error: '只有房主可以开始' };
    if (this.status === 'playing') return { error: '牌局进行中' };
    const seated = this._seatedActive();
    if (seated.length < 2) return { error: '至少需要 2 名有筹码的玩家' };

    this._clearTimers();
    if (this._autoNextTimer) { clearTimeout(this._autoNextTimer); this._autoNextTimer = null; }
    this.handNumber++;
    const size = this.config.maxSeats;
    const set = seated;
    const n = set.length;

    // 庄家按钮轮转
    this.buttonSeat = nextInSet(this.buttonSeat, set, size);
    const button = this.buttonSeat;

    let sbSeat, bbSeat, firstPre;
    if (n === 2) {
      sbSeat = button;
      bbSeat = nextInSet(button, set, size);
      firstPre = button; // 单挑：庄家(小盲)先行动
    } else {
      sbSeat = nextInSet(button, set, size);
      bbSeat = nextInSet(sbSeat, set, size);
      firstPre = nextInSet(bbSeat, set, size);
    }

    const deck = newShuffledDeck();
    const ps = {}; // seat -> per-hand state
    for (const s of set) {
      ps[s] = {
        seat: s,
        hole: [deck.pop(), deck.pop()],
        folded: false,
        allIn: false,
        hasActed: false,
        roundBet: 0,
        committed: 0,
        done: false,
      };
    }

    this.hand = {
      deck,
      board: [],
      street: 'preflop',
      streetIdx: 0,
      participants: set,
      size,
      ps,
      button,
      sbSeat,
      bbSeat,
      currentBet: 0,
      minRaise: this.config.bb,
      actor: null,
      deadline: 0,
      lastAggressor: null,
      winners: null,
      revealed: false,
    };

    this.status = 'playing';
    this.log = [];
    this._log(`第 ${this.handNumber} 手开始 · ${n} 人 · 庄家 ${button + 1} 号位`);

    // 下盲注
    this._postBlind(sbSeat, this.config.sb, '小盲');
    this._postBlind(bbSeat, this.config.bb, '大盲');
    this.hand.currentBet = this.config.bb;
    this.hand.minRaise = this.config.bb;

    // 预下注阶段所有人都需要行动（含大盲有权利选择）
    for (const s of set) this.hand.ps[s].hasActed = false;

    this._setActor(firstPre);
    this._changed();
    return { ok: true };
  }

  _postBlind(seat, amount, label) {
    const p = this.players.get(this.seats[seat]);
    const st = this.hand.ps[seat];
    const pay = Math.min(amount, p.stack);
    p.stack -= pay;
    st.roundBet += pay;
    st.committed += pay;
    if (p.stack === 0) st.allIn = true;
    this._log(`${p.name} 下${label} ${pay}`);
  }

  // ---------- 行动 ----------
  act(id, action, amount) {
    const p = this.players.get(id);
    if (!p || p.seat === null || !this.hand) return { error: '现在无法行动' };
    const seat = p.seat;
    if (this.hand.actor !== seat) return { error: '还没轮到你' };
    const st = this.hand.ps[seat];
    if (!st || st.folded || st.allIn) return { error: '你无法行动' };

    const toCall = this.hand.currentBet - st.roundBet;

    if (action === 'fold') {
      st.folded = true;
      st.hasActed = true;
      this._log(`${p.name} 弃牌`);
    } else if (action === 'check') {
      if (toCall > 0) return { error: '当前需要跟注，不能过牌' };
      st.hasActed = true;
      this._log(`${p.name} 过牌`);
    } else if (action === 'call') {
      if (toCall <= 0) return { error: '无需跟注' };
      const pay = Math.min(toCall, p.stack);
      p.stack -= pay;
      st.roundBet += pay;
      st.committed += pay;
      if (p.stack === 0) st.allIn = true;
      st.hasActed = true;
      this._log(`${p.name} 跟注 ${pay}${st.allIn ? '（全下）' : ''}`);
    } else if (action === 'raise' || action === 'bet') {
      const res = this._doRaise(p, st, seat, Math.floor(amount || 0));
      if (res && res.error) return res;
    } else {
      return { error: '未知动作' };
    }

    if (action === 'raise' || action === 'bet') {
      this.hand.lastAggressor = seat;
    }

    this._afterAction(seat);
    // 记录对手数据 + 线上学习样本
    trackAction(this, seat, action, amount || 0);
    recordSample(this, seat, action, amount || 0);
    return { ok: true };
  }

  _doRaise(p, st, seat, target) {
    const cur = this.hand.currentBet;
    const maxTarget = st.roundBet + p.stack; // 全下上限
    if (target > maxTarget) target = maxTarget;
    const isAllIn = target === maxTarget;

    if (cur === 0) {
      // 开池下注
      const minBet = Math.min(this.config.bb, maxTarget);
      if (target < minBet) return { error: `下注至少 ${minBet}` };
    } else {
      const minTarget = cur + this.hand.minRaise;
      if (target <= cur) return { error: '加注必须高于当前注' };
      if (!isAllIn && target < minTarget) return { error: `加注至少到 ${minTarget}` };
    }

    const add = target - st.roundBet;
    if (add <= 0) return { error: '金额无效' };
    p.stack -= add;
    st.roundBet += add;
    st.committed += add;
    if (p.stack === 0) st.allIn = true;

    const raiseSize = target - cur;
    if (target > cur) {
      if (raiseSize >= this.hand.minRaise) this.hand.minRaise = raiseSize;
      this.hand.currentBet = target;
      // 重新开放行动：其他未弃牌未全下的玩家需再次行动
      for (const s of this.hand.participants) {
        const o = this.hand.ps[s];
        if (s !== seat && !o.folded && !o.allIn) o.hasActed = false;
      }
    }
    st.hasActed = true;
    const verb = cur === 0 ? '下注' : '加注到';
    this._log(`${p.name} ${verb} ${target}${st.allIn ? '（全下）' : ''}`);
    return { ok: true };
  }

  _afterAction(seat) {
    this._clearTimers();
    // 只剩一名未弃牌 -> 直接结束
    const live = this.hand.participants.filter((s) => !this.hand.ps[s].folded);
    if (live.length === 1) {
      this._awardUncontested(live[0]);
      return;
    }
    // 找下一个需要行动的玩家
    const next = this._nextActor(seat);
    if (next !== -1) {
      this._setActor(next);
      this._changed();
      return;
    }
    // 本轮结束：如果有人类在线，先清 actor 广播停顿再发牌
    this.hand.actor = null;
    this._changed();
    const hasHuman = this.animateTransitions && [...this.players.values()].some(p => !p.isBot && p.connected);
    if (hasHuman) {
      this._timer = setTimeout(() => this._endStreet(), 700);
    } else {
      this._endStreet();
    }
  }

  _nextActor(from) {
    const { size, participants, ps } = this.hand;
    for (let i = 1; i <= size; i++) {
      const s = (from + i) % size;
      if (!participants.includes(s)) continue;
      const st = ps[s];
      if (!st.folded && !st.allIn && !st.hasActed) return s;
    }
    return -1;
  }

  _setActor(seat) {
    this.hand.actor = seat;
    this.hand.deadline = nowMs() + this.config.actionTimeoutMs;
    this._clearTimers();
    this._timer = setTimeout(() => this._onTimeout(seat), this.config.actionTimeoutMs + 500);
    this._scheduleBotIfActor();
  }

  _scheduleBotIfActor() {
    if (!this.hand || this.hand.actor === null) return;
    const id = this.seats[this.hand.actor];
    const p = this.players.get(id);
    if (!p || !p.isBot) return;
    if (this._botTimer) { clearTimeout(this._botTimer); this._botTimer = null; }
    const delay = 650 + Math.floor(Math.random() * 850);
    this._botTimer = setTimeout(() => {
      this._botTimer = null;
      if (!this.hand || this.hand.actor !== p.seat) return;
      const decision = decideBotAction(this, p.seat);
      this.act(id, decision.action, decision.amount || 0);
      // 机器人表情反应：存入状态，客户端渲染浮动动画
      const react = botReaction(decision.action, this, p.seat);
      if (react) this._lastBotReaction = { seat: p.seat, emoji: react, ts: Date.now() };
    }, delay);
  }

  _onTimeout(seat) {
    if (!this.hand || this.hand.actor !== seat) return;
    const st = this.hand.ps[seat];
    const p = this.players.get(this.seats[seat]);
    const toCall = this.hand.currentBet - st.roundBet;
    if (toCall > 0) {
      st.folded = true;
      st.hasActed = true;
      this._log(`${p ? p.name : '玩家'} 超时弃牌`);
    } else {
      st.hasActed = true;
      this._log(`${p ? p.name : '玩家'} 超时过牌`);
    }
    if (p) p.sittingOut = false;
    this._afterAction(seat);
  }

  _endStreet() {
    // 结束当前下注轮：清零本轮注
    for (const s of this.hand.participants) {
      this.hand.ps[s].roundBet = 0;
      this.hand.ps[s].hasActed = false;
    }
    this.hand.currentBet = 0;
    this.hand.minRaise = this.config.bb;
    this.hand.actor = null;

    // 还能行动的人数（未弃牌未全下）
    const canAct = this.hand.participants.filter((s) => !this.hand.ps[s].folded && !this.hand.ps[s].allIn);

    if (this.hand.street === 'river') {
      this._showdown();
      return;
    }

    if (canAct.length <= 1) {
      // 无需再下注：自动发完公共牌并摊牌（分阶段展示）
      this._runOut();
      return;
    }

    this._dealNextStreet();
    this._changed();
    // 翻牌后由庄家后第一个未弃牌者先行动
    const first = this._firstToActPostflop();
    if (first === -1) { this._showdown(); return; }
    this._setActor(first);
    this._changed();
  }

  _firstToActPostflop() {
    const { size, button, participants, ps } = this.hand;
    for (let i = 1; i <= size; i++) {
      const s = (button + i) % size;
      if (!participants.includes(s)) continue;
      const st = ps[s];
      if (!st.folded && !st.allIn) return s;
    }
    return -1;
  }

  _dealNextStreet() {
    const h = this.hand;
    if (h.street === 'preflop') {
      h.board.push(h.deck.pop(), h.deck.pop(), h.deck.pop());
      h.street = 'flop';
      this._log('翻牌 Flop');
    } else if (h.street === 'flop') {
      h.board.push(h.deck.pop());
      h.street = 'turn';
      this._log('转牌 Turn');
    } else if (h.street === 'turn') {
      h.board.push(h.deck.pop());
      h.street = 'river';
      this._log('河牌 River');
    }
  }

  _runOut() {
    // 全下后逐条展示剩余公共牌，最后摊牌
    this._changed();
    const step = () => {
      if (!this.hand) return;
      if (this.hand.street === 'river') { this._showdown(); return; }
      this._dealNextStreet();
      this._changed();
      const t = setTimeout(step, 1100);
      this._runoutTimers.push(t);
    };
    const t0 = setTimeout(step, 1100);
    this._runoutTimers.push(t0);
  }

  // ---------- 结算 ----------
  _awardUncontested(seat) {
    const total = this._collectPot();
    const p = this.players.get(this.seats[seat]);
    p.stack += total;
    this.hand.actor = null;
    this.hand.winners = [{ seat, amount: total, handName: '（其他人弃牌）', reveal: false }];
    this._log(`${p.name} 赢得 ${total}（无人跟注）`);
    this._finishHand();
  }

  _collectPot() {
    return this.hand.participants.reduce((sum, s) => sum + this.hand.ps[s].committed, 0);
  }

  _showdown() {
    this._clearTimers();
    const h = this.hand;
    h.street = 'showdown';
    h.actor = null;
    h.revealed = true;

    // 计算主池/边池
    const contribs = h.participants.map((s) => ({
      seat: s,
      amount: h.ps[s].committed,
      folded: h.ps[s].folded,
    }));
    const pots = computePots(contribs);

    // 评估每个未弃牌玩家的最佳牌型
    const scores = {};
    for (const s of h.participants) {
      if (h.ps[s].folded) continue;
      const cards = [...h.ps[s].hole, ...h.board];
      scores[s] = bestOf(cards);
    }

    const winners = [];
    const payout = {}; // seat -> amount
    for (const pot of pots) {
      const eligible = pot.eligible.filter((s) => !h.ps[s].folded);
      if (eligible.length === 0) continue;
      let best = null;
      let winSeats = [];
      for (const s of eligible) {
        const sc = scores[s];
        if (!best || cmp(sc, best) > 0) { best = sc; winSeats = [s]; }
        else if (cmp(sc, best) === 0) winSeats.push(s);
      }
      const share = Math.floor(pot.amount / winSeats.length);
      let remainder = pot.amount - share * winSeats.length;
      // 余数按庄家后顺序分给第一个赢家
      const ordered = orderFromButton(winSeats, h.button, h.size);
      for (const s of ordered) {
        let amt = share;
        if (remainder > 0) { amt += 1; remainder -= 1; }
        payout[s] = (payout[s] || 0) + amt;
      }
    }

    for (const s of Object.keys(payout).map(Number)) {
      const p = this.players.get(this.seats[s]);
      p.stack += payout[s];
    }

    // 组织展示信息（未弃牌玩家亮牌）
    for (const s of h.participants) {
      if (h.ps[s].folded) continue;
      const catName = CATEGORY_NAMES[scores[s][0]];
      const won = payout[s] || 0;
      winners.push({ seat: s, amount: won, handName: catName, reveal: true });
    }
    winners.sort((a, b) => b.amount - a.amount);
    h.winners = winners;

    const top = winners.filter((w) => w.amount > 0);
    for (const w of top) {
      const p = this.players.get(this.seats[w.seat]);
      this._log(`${p.name} 以【${w.handName}】赢得 ${w.amount}`);
    }
    this._finishHand();
  }

  _finishHand() {
    this.status = 'showdown';
    this.hand.actor = null;
    // 筹码归零的玩家标记为暂离
    for (const p of this.players.values()) {
      if (p.seat !== null && p.stack <= 0) p.sittingOut = true;
    }
    // 本局结束：释放掉线玩家的座位，房间状态刷新
    this._cleanupDisconnected();
    // 线上学习：局末对样本打分并存入学习日志
    finalizeHandSamples(this);
    this._changed();
    this._scheduleAutoNext();
  }

  _scheduleAutoNext() {
    if (!this.autoNext || this.status !== 'showdown') return;
    if (this._autoNextTimer) clearTimeout(this._autoNextTimer);
    this._autoNextTimer = setTimeout(() => {
      this._autoNextTimer = null;
      if (!this.autoNext || this.status !== 'showdown') return;
      if (this._seatedActive().length >= 2) this.startNext(this.hostId);
    }, 4500);
  }
  _readyForNext() {
    this.status = 'waiting';
    this.hand = null;
  }

  startNext(byId) {
    if (byId && byId !== this.hostId) return { error: '只有房主可以开始' };
    this._readyForNext();
    return this.startHand(byId);
  }

  _clearTimers() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (this._botTimer) { clearTimeout(this._botTimer); this._botTimer = null; }
    for (const t of this._runoutTimers) clearTimeout(t);
    this._runoutTimers = [];
  }

  // ---------- 状态快照（按视角脱敏） ----------
  stateFor(viewerId) {
    const cfg = this.config;
    const h = this.hand;
    const seats = [];
    for (let s = 0; s < cfg.maxSeats; s++) {
      const id = this.seats[s];
      if (!id) { seats.push(null); continue; }
      const p = this.players.get(id);
      const st = h ? h.ps[s] : null;
      const isYou = id === viewerId;
      const revealHole = st && !st.folded && ((h && h.revealed) || isYou);
      seats.push({
        seat: s,
        id,
        name: p.name,
        stack: p.stack,
        connected: p.connected,
        isBot: !!p.isBot,
        botStyle: p.botStyle || null,
        isYou,
        isHost: id === this.hostId,
        isButton: h ? s === h.button : false,
        isSmallBlind: h ? s === h.sbSeat : false,
        isBigBlind: h ? s === h.bbSeat : false,
        inHand: !!st,
        folded: st ? st.folded : false,
        allIn: st ? st.allIn : false,
        roundBet: st ? st.roundBet : 0,
        hasCards: !!st,
        hole: revealHole ? st.hole : null,
        isActor: h ? h.actor === s : false,
      });
    }

    const you = this.players.get(viewerId);
    const yourSeat = you ? you.seat : null;
    let legal = null;
    if (h && you && yourSeat !== null && h.actor === yourSeat) {
      const st = h.ps[yourSeat];
      const toCall = h.currentBet - st.roundBet;
      const maxTarget = st.roundBet + you.stack;
      const canRaise = you.stack > toCall; // 有多余筹码才能加注
      let minRaiseTo;
      if (h.currentBet === 0) minRaiseTo = Math.min(cfg.bb, maxTarget);
      else minRaiseTo = Math.min(h.currentBet + h.minRaise, maxTarget);
      legal = {
        canFold: true,
        canCheck: toCall === 0,
        canCall: toCall > 0,
        callAmount: Math.min(toCall, you.stack),
        canRaise,
        isOpen: h.currentBet === 0,
        minRaiseTo,
        maxRaiseTo: maxTarget,
      };
    }

    return {
      type: 'state',
      roomId: this.id,
      activeSeats: this.activeSeatCount(),
      config: { sb: cfg.sb, bb: cfg.bb, maxSeats: cfg.maxSeats, minSeats: cfg.minSeats, startStack: cfg.startStack, actionTimeoutMs: cfg.actionTimeoutMs },
      status: this.status,
      handNumber: this.handNumber,
      street: h ? h.street : null,
      board: h ? h.board : [],
      pot: h ? this._collectPot() : 0,
      currentBet: h ? h.currentBet : 0,
      buttonSeat: h ? h.button : this.buttonSeat,
      actor: h ? h.actor : null,
      deadline: h ? h.deadline : 0,
      seats,
      you: {
        id: viewerId,
        name: you ? you.name : '',
        seat: yourSeat,
        stack: you ? you.stack : 0,
        isHost: viewerId === this.hostId,
        seated: yourSeat !== null,
      },
      autoNext: this.autoNext,
      legal,
      winners: h ? h.winners : null,
      message: this.lastMessage,
      log: this.log.slice(-12),
      seatedCount: this._seatedActive().length,
      botReact: this._lastBotReaction,
    };
    // 消耗式：表情只发一次
    this._lastBotReaction = null;
  }
}

// 尝试加载自学习训练结果（若存在 data/bot-profiles.json 则优先使用）
function loadTrainedProfiles() {
  try {
    const p = path.join(__dirname, '..', 'data', 'bot-profiles.json');
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (raw && raw.profiles && raw.profiles.length) {
        return raw.profiles;
      }
    }
  } catch { /* ignore */ }
  return null;
}

// 默认 bot 角色（未训练时的后备）
const DEFAULT_BOT_CATALOG = [
  { name: '高松灯', style: '迷子主唱', profile: { tight: 0.02, aggression: 1.05, bluff: 0.8, call: 1.15, allin: 0.7 } },
  { name: '千早爱音', style: '松凶吉他', profile: { tight: -0.05, aggression: 1.35, bluff: 1.35, call: 1.05, allin: 0.55 } },
  { name: '要乐奈', style: '野性攻击', profile: { tight: -0.08, aggression: 1.45, bluff: 1.15, call: 0.95, allin: 0.65 } },
  { name: '长崎爽世', style: '稳健控池', profile: { tight: 0.06, aggression: 0.95, bluff: 0.75, call: 1.0, allin: 0.45 } },
  { name: '椎名立希', style: '紧凶鼓手', profile: { tight: 0.10, aggression: 1.28, bluff: 0.65, call: 0.82, allin: 0.55 } },
  { name: 'Doloris', style: '松凶主唱', profile: { tight: -0.06, aggression: 1.38, bluff: 1.45, call: 1.0, allin: 0.5 } },
  { name: 'Mortis', style: '冷静侵略', profile: { tight: 0.02, aggression: 1.32, bluff: 1.05, call: 0.92, allin: 0.45 } },
  { name: 'Timoris', style: '跟注观察', profile: { tight: 0.04, aggression: 0.92, bluff: 0.85, call: 1.35, allin: 0.35 } },
  { name: 'Amoris', style: '情绪诈唬', profile: { tight: -0.03, aggression: 1.22, bluff: 1.55, call: 1.05, allin: 0.5 } },
  { name: 'Oblivionis', style: '超紧强攻', profile: { tight: 0.14, aggression: 1.4, bluff: 0.45, call: 0.75, allin: 0.5 } },
  { name: '若叶睦', style: '沉默强牌', profile: { tight: 0.09, aggression: 1.18, bluff: 0.55, call: 0.9, allin: 0.45 } },
  { name: '丰川祥子', style: '压迫控场', profile: { tight: 0.03, aggression: 1.5, bluff: 1.0, call: 0.85, allin: 0.5 } },
];

// 懒加载：首次使用时决定用训练结果还是默认值
let _botCatalogCache = null;
function getBotCatalog() {
  if (_botCatalogCache) return _botCatalogCache;
  const trained = loadTrainedProfiles();
  _botCatalogCache = trained || DEFAULT_BOT_CATALOG;
  if (trained) console.log(`[bot] 加载自学习训练结果（${trained.length} 个 profile）`);
  return _botCatalogCache;
}

// ---------- 工具函数 ----------
function nowMs() { return Date.now(); }

function nextInSet(from, set, size) {
  for (let i = 1; i <= size; i++) {
    const s = (from + i) % size;
    if (set.includes(s)) return s;
  }
  return set.length ? set[0] : -1;
}

function orderFromButton(seats, button, size) {
  return [...seats].sort((a, b) => {
    const da = (a - button + size) % size;
    const db = (b - button + size) % size;
    return da - db;
  });
}

// 边池计算：contribs = [{seat, amount, folded}]
function computePots(contribs) {
  const pots = [];
  let rem = contribs.map((c) => ({ ...c })).filter((c) => c.amount > 0);
  while (rem.length > 0) {
    const min = Math.min(...rem.map((c) => c.amount));
    let potAmount = 0;
    const eligible = [];
    for (const c of rem) {
      c.amount -= min;
      potAmount += min;
      if (!c.folded) eligible.push(c.seat);
    }
    // 合并 eligible 相同的连续池
    const last = pots[pots.length - 1];
    const key = eligible.slice().sort((a, b) => a - b).join(',');
    if (last && last._key === key) {
      last.amount += potAmount;
    } else {
      pots.push({ amount: potAmount, eligible, _key: key });
    }
    rem = rem.filter((c) => c.amount > 0);
  }
  return pots;
}

module.exports = { Game, computePots, orderFromButton };
