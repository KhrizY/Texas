'use strict';

const { bestOf } = require('./evaluator');

// 机器人策略：不是作弊 AI，只使用自己的底牌、公共牌、当前底池与跟注成本。
// 目标是“像普通玩家一样玩”：强牌进攻，中等牌看赔率，弱牌偶尔偷盲/诈唬。
function decideBotAction(game, seat) {
  const h = game.hand;
  const p = game.players.get(game.seats[seat]);
  const st = h.ps[seat];
  const toCall = Math.max(0, h.currentBet - st.roundBet);
  const pot = game._collectPot();
  const stack = p.stack;
  const maxTarget = st.roundBet + stack;
  const minTarget = h.currentBet === 0
    ? Math.min(game.config.bb, maxTarget)
    : Math.min(h.currentBet + h.minRaise, maxTarget);
  const canRaise = stack > toCall && maxTarget > h.currentBet;
  const canCheck = toCall === 0;

  const profile = p.botProfile || { tight: 0, aggression: 1, bluff: 1, call: 1, allin: 1 };
  const strength = estimateStrength(st.hole, h.board, h.street);
  const pressure = toCall <= 0 ? 0 : toCall / Math.max(1, pot + toCall);
  const stageAggro = h.street === 'preflop' ? 0.88 : 1.08;
  const jitter = (Math.random() - 0.5) * 0.14;
  const score = clamp(strength * stageAggro + jitter - (profile.tight || 0), 0, 1);

  // 面对下注：按牌力 + 底池赔率决定弃/跟/加
  if (toCall > 0) {
    if (score < pressure + 0.14 - (profile.call || 1) * 0.08 && Math.random() > 0.08) return { action: 'fold' };
    if (canRaise && score > 0.64 && Math.random() < raiseChance(score, profile)) {
      return { action: 'raise', amount: pickRaiseTarget(h, pot, minTarget, maxTarget, score, profile) };
    }
    return { action: 'call' };
  }

  // 无人下注：弱牌过牌，中强牌下注，偶尔偷/诈唬
  if (canRaise && (score > 0.50 || Math.random() < bluffChance(h.street, profile))) {
    return { action: h.currentBet === 0 ? 'bet' : 'raise', amount: pickRaiseTarget(h, pot, minTarget, maxTarget, score, profile) };
  }
  if (canCheck) return { action: 'check' };
  return { action: 'fold' };
}

function pickRaiseTarget(h, pot, minTarget, maxTarget, score, profile = {}) {
  if (maxTarget <= minTarget) return maxTarget;
  const ag = profile.aggression || 1;
  let target;
  if (score > 0.9) target = h.currentBet + Math.max(h.minRaise, Math.round(pot * (0.75 + Math.random() * 0.55) * ag));
  else if (score > 0.75) target = h.currentBet + Math.max(h.minRaise, Math.round(pot * (0.42 + Math.random() * 0.42) * ag));
  else target = h.currentBet + Math.max(h.minRaise, Math.round(pot * (0.30 + Math.random() * 0.24) * ag));

  // 更激进但较少 all-in：只有超强牌/短筹码时小概率全下
  if (score > 0.96 && Math.random() < 0.08 * (profile.allin || 1)) target = maxTarget;
  target = Math.max(minTarget, Math.min(maxTarget, target));
  return Math.round(target / 10) * 10 || minTarget;
}

function raiseChance(score, profile = {}) {
  const ag = profile.aggression || 1;
  if (score > 0.92) return Math.min(0.82, 0.64 * ag);
  if (score > 0.82) return Math.min(0.68, 0.44 * ag);
  return Math.min(0.48, 0.24 * ag);
}

function bluffChance(street, profile = {}) {
  const b = profile.bluff || 1;
  return (street === 'preflop' ? 0.08 : 0.14) * b;
}

function estimateStrength(hole, board, street) {
  if (!board || board.length < 3) return preflopStrength(hole);
  const cards = [...hole, ...board];
  const score = cards.length >= 5 ? bestOf(cards) : null;
  const cat = score ? score[0] : 0;
  const rankBonus = hole.reduce((s, c) => s + (c.r - 2) / 12, 0) / 2;
  const draw = drawBonus(hole, board);

  const baseByCat = [0.22, 0.38, 0.52, 0.64, 0.72, 0.78, 0.86, 0.93, 0.98][cat] || 0.22;
  return clamp(baseByCat + rankBonus * 0.08 + draw, 0.02, 0.99);
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
  if (gap === 1) s += 0.06;
  else if (gap === 2) s += 0.03;
  else if (gap >= 5) s -= 0.08;
  if (a.r >= 13 && b.r >= 10) s += 0.12;
  if (a.r === 14 && b.r >= 10) s += 0.10;
  return clamp(s, 0.05, 0.98);
}

function drawBonus(hole, board) {
  const cards = [...hole, ...board];
  const suitCounts = new Map();
  for (const c of cards) suitCounts.set(c.s, (suitCounts.get(c.s) || 0) + 1);
  let bonus = 0;
  if ([...suitCounts.values()].some((n) => n === 4)) bonus += 0.10;

  const ranks = [...new Set(cards.flatMap((c) => c.r === 14 ? [14, 1] : [c.r]))].sort((a, b) => a - b);
  for (let start = 1; start <= 10; start++) {
    const have = [0,1,2,3,4].filter((d) => ranks.includes(start + d)).length;
    if (have === 4) bonus += 0.08;
  }
  return Math.min(0.16, bonus);
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

module.exports = { decideBotAction, estimateStrength };
