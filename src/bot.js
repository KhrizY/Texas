'use strict';

const { bestOf } = require('./evaluator');

// ========================= 位置系统 =========================
// 位置奖励表 [pos][seatedCount]：座椅索引 0~n-1（0=BB, n-1=BTN）
function positionBonus(seat, seatedCount) {
  if (seatedCount < 2) return 0;
  // 位置系数：越靠近庄位越激进
  return (seat / Math.max(1, seatedCount - 1)) * 0.12 - 0.06;
}

// ========================= 牌面纹理 =========================
function classifyBoard(board) {
  if (!board || board.length < 3) return { wet: false, veryWet: false, paired: false, highCard: true, mono: false };
  const suits = new Map();
  const ranks = new Map();
  for (const c of board) {
    suits.set(c.s, (suits.get(c.s) || 0) + 1);
    ranks.set(c.r, (ranks.get(c.r) || 0) + 1);
  }
  const paired = [...ranks.values()].some(n => n >= 2);
  const flushPossible = [...suits.values()].some(n => n >= 3);
  const mono = board.length >= 5 && [...suits.values()].some(n => n >= 4);
  const sortedRanks = [...ranks.keys()].sort((a, b) => a - b).map(r => r === 14 ? 1 : r);
  let connected = 0, maxConnected = 0;
  for (let i = 0; i < sortedRanks.length; i++) {
    if (i > 0 && sortedRanks[i] - sortedRanks[i - 1] === 1) connected++;
    else connected = 0;
    maxConnected = Math.max(maxConnected, connected);
  }
  const straightPossible = maxConnected >= 2;
  const wet = flushPossible || straightPossible;
  const veryWet = flushPossible && straightPossible;
  return { wet, veryWet, paired, highCard: board.length < 3, mono, flushPossible, straightPossible };
}

// ========================= 对手追踪 =========================
// 挂在 game._botStats = { [playerId]: { vpip, pfr, foldsToCbet, totalActions, foldCount } }
// 由 game.js 在每次 action 后更新 _trackBotOpponent(game, seat, action)

function initOppStats() {
  return { vpip: 0.25, pfr: 0.12, foldsToCbet: 0.40, totalActions: 0, foldCount: 0, raiseCount: 0, callCount: 0 };
}

function opponentTendency(stats) {
  if (!stats) stats = initOppStats();
  // 松/紧
  const loose = stats.vpip > 0.40;
  const tight = stats.vpip < 0.18;
  // 被动/激进
  const passive = stats.pfr < 0.08;
  const aggressive = stats.pfr > 0.22;
  const folder = stats.totalActions > 5 && (stats.foldCount / Math.max(1, stats.totalActions)) > 0.5;
  return { loose, tight, passive, aggressive, folder, stats };
}

// ========================= 手牌评估（升级版） =========================
function estimateStrength(hole, board, street, game, seat) {
  if (!board || board.length < 3) return preflopStrength(hole);

  const cards = [...hole, ...board];
  const score5 = cards.length >= 5 ? bestOf(cards) : null;
  const cat = score5 ? score5[0] : 0;

  // 基础牌型分
  const baseByCat = [0.25, 0.40, 0.55, 0.68, 0.76, 0.82, 0.89, 0.95, 0.99][cat] || 0.25;

  // — kicker 奖励 —
  let kickerBonus = 0;
  if (cat === 1 && score5) {
    const nonPairRanks = [];
    const rankCount = new Map();
    for (const c of cards) rankCount.set(c.r, (rankCount.get(c.r) || 0) + 1);
    for (const [r, n] of rankCount) {
      if (n === 1) nonPairRanks.push(r);
    }
    const myKicker = Math.max(...hole.map(c => c.r));
    if (myKicker >= 13) kickerBonus = 0.06;
    else if (myKicker >= 10) kickerBonus = 0.03;
  }

  // — 阻断牌奖励 —
  let blockerBonus = 0;
  const myRanks = new Set(hole.map(c => c.r));
  const cls = classifyBoard(board);
  if (cls.flushPossible) {
    const boardSuit = [...new Set(board.map(c => c.s))].find(s => board.filter(c => c.s === s).length >= 3);
    if (boardSuit && hole.some(c => c.s === boardSuit && c.r >= 10)) blockerBonus += 0.04;
  }
  if (cls.straightPossible) {
    const allRanks = new Set(board.map(c => c.r === 14 ? 1 : c.r));
    for (const r of myRanks) {
      const low = r === 14 ? 1 : r;
      if (allRanks.has(low + 1) || allRanks.has(low - 1)) blockerBonus += 0.02;
    }
  }

  // — 听牌权益 —
  const drawEq = drawEquity(hole, board);

  // — 组合 —
  let s = baseByCat + kickerBonus + Math.min(0.10, blockerBonus) + drawEq;

  // — 牌面纹理修正 —
  const tex = classifyBoard(board);
  if (tex.veryWet && cat <= 2) s -= 0.06; // 湿面弱牌降权
  if (tex.paired && cat <= 1) s -= 0.04;  // 公对面弱牌降权

  return clamp(s, 0.02, 0.99);
}

function drawEquity(hole, board) {
  const cards = [...hole, ...board];
  const suitCounts = new Map();
  for (const c of cards) suitCounts.set(c.s, (suitCounts.get(c.s) || 0) + 1);
  const flushDraw = [...suitCounts.values()].some(n => n === 4);
  const allRanks = new Set(cards.flatMap(c => c.r === 14 ? [14, 1] : [c.r]));
  let straightOuts = 0;
  for (let start = 1; start <= 10; start++) {
    let have = 0, need = 0;
    for (let d = 0; d < 5; d++) {
      if (allRanks.has(start + d)) have++;
      else if (hole.some(c => (c.r === 14 ? 1 : c.r) === start + d || c.r === start + d)) need = d;
    }
    if (have === 4 && need !== undefined) straightOuts = 4;
  }
  let eq = 0;
  if (flushDraw) eq += 0.06;
  if (straightOuts >= 4) eq += 0.06;
  else if (straightOuts > 0) eq += 0.03;
  return Math.min(0.14, eq);
}

function preflopStrength(hole) {
  const [a, b] = hole[0].r >= hole[1].r ? hole : [hole[1], hole[0]];
  const pair = a.r === b.r;
  const suited = a.s === b.s;
  const gap = Math.abs(a.r - b.r);
  const hi = (a.r - 2) / 12;
  const lo = (b.r - 2) / 12;

  let s = hi * 0.38 + lo * 0.22;
  if (pair) s = 0.48 + hi * 0.45;
  if (suited) s += 0.08;
  if (gap === 0 && a.r >= 10) s += 0.10; // 大对子额外
  if (gap === 1) s += 0.06;
  else if (gap === 2) s += 0.03;
  else if (gap >= 5) s -= 0.08;
  if (a.r >= 13 && b.r >= 10) s += 0.12;
  if (a.r === 14 && b.r >= 10) s += 0.10;
  if (a.r === 14 && a.s === b.s) s += 0.04; // Ax suited
  return clamp(s, 0.05, 0.98);
}

// ========================= 诈唬引擎 =========================
function bluffEligible(board, hole) {
  if (!board || board.length < 3) return false;
  const tex = classifyBoard(board);
  // 只有牌面支持"故事"才诈唬：湿面（表示听牌成牌）、公对面（表示有明三条）、或大牌面
  if (!tex.wet && !tex.paired) {
    const highCards = board.filter(c => c.r >= 10).length;
    if (highCards < 2) return false;
  }
  return true;
}

function bluffFrequency(street, profile = {}) {
  const b = (profile.bluff || 1);
  return { preflop: 0.08 * b, flop: 0.30 * b, turn: 0.22 * b, river: 0.14 * b }[street] || 0;
}

// ========================= 下注尺度 =========================
function pickRaiseTarget(h, pot, minTarget, maxTarget, score, profile = {}, opts = {}) {
  if (maxTarget <= minTarget) return maxTarget;
  const rawAg = profile.aggression || 1;
  // 下注尺度映射：侵略性影响频率但不过度放大 siz，1.0→1.0, 1.5→1.2
  const sizeMul = 0.75 + rawAg * 0.30;
  const isBluff = opts.isBluff || false;
  const isProtect = opts.isProtect || false;
  let target;
  if (isBluff) {
    target = h.currentBet + Math.max(h.minRaise, Math.round(pot * (0.45 + Math.random() * 0.25)));
  } else if (isProtect) {
    target = h.currentBet + Math.max(h.minRaise, Math.round(pot * (0.60 + Math.random() * 0.30)));
  } else if (score > 0.90) {
    target = h.currentBet + Math.max(h.minRaise, Math.round(pot * (0.55 + Math.random() * 0.30) * sizeMul));
  } else if (score > 0.75) {
    target = h.currentBet + Math.max(h.minRaise, Math.round(pot * (0.35 + Math.random() * 0.25) * sizeMul));
  } else {
    target = h.currentBet + Math.max(h.minRaise, Math.round(pot * (0.25 + Math.random() * 0.18) * sizeMul));
  }
  if (score > 0.96 && Math.random() < 0.05 * (profile.allin || 1)) target = maxTarget;
  target = Math.max(minTarget, Math.min(maxTarget, target));
  return Math.round(target / 10) * 10 || minTarget;
}

function raiseChance(score, profile = {}) {
  const ag = profile.aggression || 1;
  if (score > 0.92) return Math.min(0.82, 0.64 * ag);
  if (score > 0.82) return Math.min(0.68, 0.44 * ag);
  return Math.min(0.48, 0.24 * ag);
}

// ========================= 栈深策略 =========================
function stackDepthTier(stack, bb) {
  if (stack <= 0) return 'broke';
  if (stack < 15 * bb) return 'short';
  if (stack < 40 * bb) return 'medium';
  return 'deep';
}

// ========================= 主决策（完整升级版） =========================
function decideBotAction(game, seat) {
  const h = game.hand;
  if (!h) return { action: 'fold' };
  const p = game.players.get(game.seats[seat]);
  const st = h.ps[seat];
  if (!p || !st || st.folded) return { action: 'fold' };

  const bb = game.config.bb;
  const toCall = Math.max(0, h.currentBet - st.roundBet);
  const pot = game._collectPot();
  const stack = p.stack;
  const maxTarget = st.roundBet + stack;
  const minTarget = h.currentBet === 0
    ? Math.min(bb, maxTarget)
    : Math.min(h.currentBet + h.minRaise, maxTarget);
  const canRaise = stack > toCall && maxTarget > h.currentBet;
  const canCheck = toCall === 0;

  const profile = p.botProfile || { tight: 0, aggression: 1, bluff: 1, call: 1, allin: 1 };
  const street = h.street;
  const seatedCount = game._seatedActive().length;

  // — 手牌强度 —
  const strength = estimateStrength(st.hole, h.board, street, game, seat);

  // — 位置修正 —
  const posB = positionBonus(seat, seatedCount);

  // — 牌面纹理修正 —
  const tex = classifyBoard(h.board);
  let texMod = 0;
  if (tex.veryWet) texMod = -0.05;
  else if (tex.wet) texMod = -0.02;

  // — 栈深修正 —
  const tier = stackDepthTier(stack, bb);
  let stackMod = 0;
  if (tier === 'short') stackMod = 0.06; // 短码更激进
  if (tier === 'deep') stackMod = -0.03; // 深码更保守

  // — 对手修正 —
  const oppStats = game._botStats || {};
  let oppMod = 0;
  // 对上一条街的侵略者做针对性反应
  if (h.lastAggressor !== null && h.lastAggressor !== seat) {
    const aggrId = game.seats[h.lastAggressor];
    const aggr = oppStats[aggrId];
    if (aggr) {
      const tend = opponentTendency(aggr);
      if (tend.loose) oppMod = 0.04;      // vs 松手更有信心
      if (tend.tight && toCall > 0) oppMod = -0.06; // vs 紧手下注更尊重
      if (tend.folder) oppMod += 0.05;    // vs 弃牌机器多施压
    }
  }
  // 全局桌风：统计所有对手平均松紧
  let tableLoose = 0, tableCount = 0;
  for (let s = 0; s < game.seats.length; s++) {
    const pid = game.seats[s];
    if (pid && s !== seat && oppStats[pid]) {
      tableLoose += oppStats[pid].vpip;
      tableCount++;
    }
  }
  if (tableCount > 0) {
    const avgVpip = tableLoose / tableCount;
    if (avgVpip > 0.35) oppMod += 0.04;   // 全桌松 → 多进攻
    if (avgVpip < 0.20) oppMod -= 0.04;   // 全桌紧 → 更谨慎
  }

  // — 多街计划修正 —
  const plans = game._botPlans || {};
  let planMod = 0;
  const plan = plans[seat];
  if (plan && plan.street !== street && plan.action === 'bet' && toCall === 0) {
    // 上街下注了，本街继续 barreling
    planMod = 0.10;
  }

  // — 最终评分 —
  const stageAggro = street === 'preflop' ? 0.88 : 1.08;
  const preflopBoost = street === 'preflop' ? 0.14 : 0; // 翻前多玩一些牌
  const jitter = (Math.random() - 0.5) * 0.16;            // 更大随机性，减少可预测性
  const score = clamp(
    strength * stageAggro + preflopBoost + posB + texMod + stackMod + oppMod + planMod + jitter - (profile.tight || 0),
    0, 1
  );

  // — 保存本街计划 —
  if (!game._botPlans) game._botPlans = {};
  game._botPlans[seat] = null; // 会在决策结束后设置

  // === 决策分支 ===
  // 短码推拉逻辑
  if (tier === 'short' && canRaise && (score > 0.70 || pot > stack * 0.6)) {
    const decision = { action: h.currentBet === 0 ? 'bet' : 'raise', amount: maxTarget };
    game._botPlans[seat] = { street, action: 'bet' };
    return decision;
  }

  // 诱多/慢打检测：强牌+干燥面 → 有时不急着加注
  const dryForTrapping = street !== 'river' && !tex.wet && !tex.paired && tex.highCard !== true;

  // 面对下注
  if (toCall > 0) {
    const potOdds = toCall / Math.max(1, pot + toCall);
    // 止损逻辑：面对重注时更谨慎，弱牌不跟大锅
    const stopLoss = clamp((toCall / Math.max(1, pot)) * 0.10, 0, 0.14);
    const foldThreshold = potOdds * 0.55 + 0.02 + stopLoss - (profile.call || 1) * 0.04;

    // — 慢打诱多：强牌在干燥面跟注设陷阱 —
    if (dryForTrapping && score > 0.85 && toCall <= pot * 0.8 && Math.random() < 0.30) {
      game._botPlans[seat] = { street, action: 'trap', trapScore: score };
      return { action: 'call' };
    }

    if (score < foldThreshold && Math.random() > 0.04) {
      game._botPlans[seat] = null;
      return { action: 'fold' };
    }

    // — 上街设陷阱，本街收网 —
    if (plan && plan.action === 'trap' && canRaise && score > 0.70) {
      const decision = { action: 'raise', amount: pickRaiseTarget(h, pot, minTarget, maxTarget, score, profile, { isProtect: false }) };
      game._botPlans[seat] = { street, action: 'raise' };
      return decision;
    }

    // — 加注逻辑 —
    if (canRaise && score > 0.42) {
      const chance = raiseChance(score, profile);
      if (Math.random() < chance) {
        const decision = { action: 'raise', amount: pickRaiseTarget(h, pot, minTarget, maxTarget, score, profile, { isProtect: tex.wet && score > 0.75 }) };
        game._botPlans[seat] = { street, action: 'raise' };
        return decision;
      }
    }

    game._botPlans[seat] = { street, action: 'call' };
    return { action: 'call' };
  }

  // 无人下注
  if (canRaise) {
    // — 慢打诱多：强牌过牌/小额下注 —
    if (dryForTrapping && score > 0.88 && Math.random() < 0.25) {
      if (Math.random() < 0.4) {
        game._botPlans[seat] = { street, action: 'trap', trapScore: score };
        if (canCheck) return { action: 'check' };
        return { action: 'call' };
      }
      // 小额诱注
      const smallBet = h.currentBet + Math.max(h.minRaise, Math.round(pot * 0.30));
      const decision = { action: 'bet', amount: Math.min(smallBet, maxTarget) };
      game._botPlans[seat] = { street, action: 'bet', trapScore: score };
      return decision;
    }

    // — 价值下注 —
    if (score > 0.28 + (profile.tight || 0) * 0.08) {
      const isProtect = tex.wet && score > 0.70;
      const decision = {
        action: h.currentBet === 0 ? 'bet' : 'raise',
        amount: pickRaiseTarget(h, pot, minTarget, maxTarget, score, profile, { isProtect })
      };
      game._botPlans[seat] = { street, action: 'bet' };
      return decision;
    }

    // — 多街诈唬线：上街开了头，本街继续讲 —
    const continuingBluff = plan && plan.action === 'bluff' && plan.street !== street;
    if (continuingBluff && tex.wet && Math.random() < 0.55) {
      const stageMul = { flop: 0.45, turn: 0.60, river: 0.75 }[street] || 0.50;
      const target = h.currentBet + Math.max(h.minRaise, Math.round(pot * stageMul));
      const decision = { action: 'bet', amount: Math.min(target, maxTarget) };
      game._botPlans[seat] = { street, action: 'bluff' };
      return decision;
    }

    // — 逻辑诈唬 —
    if (bluffEligible(h.board, st.hole) && Math.random() < bluffFrequency(street, profile)) {
      const decision = {
        action: h.currentBet === 0 ? 'bet' : 'raise',
        amount: pickRaiseTarget(h, pot, minTarget, maxTarget, score, profile, { isBluff: true })
      };
      game._botPlans[seat] = { street, action: 'bluff' };
      return decision;
    }
  }

  if (canCheck) { game._botPlans[seat] = null; return { action: 'check' }; }
  game._botPlans[seat] = null;
  return { action: 'fold' };
}

// ========================= 对手追踪更新 =========================
function trackAction(game, seat, action, amount) {
  if (!game._botStats) game._botStats = {};
  if (!game._botPlans) game._botPlans = {};

  const playerId = game.seats[seat];
  if (!playerId) return;
  if (!game._botStats[playerId]) game._botStats[playerId] = initOppStats();
  const stats = game._botStats[playerId];
  stats.totalActions++;

  const h = game.hand;
  const street = h ? h.street : 'preflop';

  switch (action) {
    case 'fold': stats.foldCount++; break;
    case 'call': stats.callCount++; break;
    case 'bet':
    case 'raise': stats.raiseCount++; break;
  }

  // 更新 VPIP（入池率）
  const actions = stats.totalActions;
  const vpipActions = stats.callCount + stats.raiseCount;
  stats.vpip = stats.vpip * 0.92 + (actions > 0 ? vpipActions / actions : 0) * 0.08;

  // 更新 PFR（翻前加注率）
  if (street === 'preflop') {
    const raiseActions = stats.raiseCount;
    stats.pfr = stats.pfr * 0.90 + (actions > 0 ? raiseActions / actions : 0) * 0.10;
  }

  // FoldsToCbet：被 cbet 时弃牌
  if (street !== 'preflop' && action === 'fold' && h.lastAggressor !== undefined) {
    stats.foldsToCbetCount = (stats.foldsToCbetCount || 0) + 1;
    stats.cbetFaced = (stats.cbetFaced || 0) + 1;
    stats.foldsToCbet = stats.foldsToCbet * 0.90 + 0.10;
  }
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

module.exports = { decideBotAction, estimateStrength, trackAction, classifyBoard, initOppStats };
