'use strict';
//  线上学习引擎：记录 → 评分 → 微调
//  每手牌记录 bot 决策 → 局末按结果打分 → 真人离开后触发微调 → 写入 profiles

const fs = require('fs');
const path = require('path');
const PROFILE_PATH = path.join(__dirname, '..', 'data', 'bot-profiles.json');

// ========================= 样本结构 =========================
// { seat, position, seatedCount, street, handScore, stackBB, action, amount, potSize, roundResult, profileSnap }

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ========================= 局末评分 =========================
function scoreHandSamples(samples, game) {
  if (!samples || samples.length === 0) return samples;
  const winners = game.hand && game.hand.winners ? game.hand.winners : [];
  const winSeats = new Set(winners.map(w => w.seat));

  for (const s of samples) {
    // 赢了 +1，输了 −0.5，中立 0
    if (winSeats.has(s.seat)) {
      s.reward = 1.0;
      if (s.action === 'raise' || s.action === 'bet') s.reward += 0.3;  // 用侵略赢的额外奖
    } else {
      s.reward = -0.3;
      if (s.action === 'fold') s.reward += 0.2;  // 弃牌止损不算太差
      if (s.action === 'call' && s.amount > 0 && s.potSize > 0 && s.amount / s.potSize > 0.5) {
        s.reward -= 0.3;  // 跟重注输了
      }
    }
    // 好牌弃了 → 惩罚
    if (s.action === 'fold' && s.handScore > 0.55) s.reward -= 0.2;
    // 弱牌加注赢了 → 大奖励（诈唬成功）
    if (winSeats.has(s.seat) && s.handScore < 0.40 && (s.action === 'raise' || s.action === 'bet')) {
      s.reward += 0.4;
    }
  }
  return samples;
}

// ========================= 微调算法 =========================
function onlineLearn(allSamples) {
  if (!allSamples || allSamples.length < 15) return { updated: 0, msg: '样本不足（需≥15），跳过微调' };

  // 加载当前 profiles
  let profiles;
  try {
    if (fs.existsSync(PROFILE_PATH)) {
      const raw = JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf8'));
      profiles = raw.profiles || [];
    }
  } catch { profiles = []; }
  if (profiles.length === 0) return { updated: 0, msg: '无 profile 可更新' };

  // 按 profile 分组（用 profileSnap 哈希近似）
  const byProfile = new Map();
  for (const s of allSamples) {
    const key = profileKey(s.profileSnap);
    if (!byProfile.has(key)) byProfile.set(key, []);
    byProfile.get(key).push(s);
  }

  let updated = 0;

  for (const [key, samples] of byProfile) {
    const positives = samples.filter(s => s.reward > 0);
    const negatives = samples.filter(s => s.reward < 0);
    if (positives.length < 3 || negatives.length < 3) continue;

    // 找到匹配的 profile
    const idx = profiles.findIndex(p => profileKey(p.profile) === key);
    if (idx < 0) continue;
    const prof = profiles[idx];
    const p = prof.profile;

    // 计算正负样本参数均值差异
    const meanPos = meanProfile(positives);
    const meanNeg = meanProfile(negatives);

    // 按差异方向微调 1-3%
    const rate = 0.02;
    if (meanPos.handScore > meanNeg.handScore + 0.05) {
      p.aggression = clamp(p.aggression + rate * 0.3, 0.7, 1.7);
    }
    if (meanNeg.handScore < 0.30 && meanPos.handScore < 0.35) {
      p.tight = clamp(p.tight + rate * 0.2, -0.15, 0.25);
    }
    if (meanPos.reward > 1.0) {
      p.aggression = clamp(p.aggression + rate * 0.2, 0.7, 1.7);
      p.bluff = clamp(p.bluff + rate * 0.15, 0.3, 1.8);
    }
    if (negatives.length > positives.length * 2) {
      p.call = clamp(p.call - rate * 0.2, 0.6, 1.5);
      p.allin = clamp(p.allin - rate * 0.1, 0.25, 0.85);
    }

    updated++;
  }

  if (updated > 0) {
    const output = {
      trained: new Date().toISOString(),
      method: 'online-learn',
      numHands: allSamples.length,
      profiles,
    };
    const dir = path.dirname(PROFILE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PROFILE_PATH, JSON.stringify(output, null, 2));
  }

  return { updated, msg: `更新了 ${updated} 个 profile` };
}

function meanProfile(samples) {
  const m = { handScore: 0, reward: 0 };
  for (const s of samples) {
    m.handScore += s.handScore;
    m.reward += s.reward;
  }
  m.handScore /= samples.length;
  m.reward /= samples.length;
  return m;
}

function profileKey(p) {
  if (!p) return 'empty';
  const t = p.tight || 0, a = p.aggression || 1, b = p.bluff || 1, c = p.call || 1, ai = p.allin || 1;
  return `${t.toFixed(2)}_${a.toFixed(2)}_${b.toFixed(2)}_${c.toFixed(2)}_${ai.toFixed(2)}`;
}

function recordSample(game, seat, action, amount) {
  if (!game._learnSamples) game._learnSamples = [];
  const p = game.players.get(game.seats[seat]);
  if (!p || !p.isBot) return;

  const h = game.hand;
  const profile = p.botProfile || { tight: 0, aggression: 1, bluff: 1, call: 1, allin: 1 };
  const bb = game.config.bb;
  const st = h.ps[seat];

  // 评估这手牌当前强度
  const { estimateStrength } = require('./bot');
  let hs = 0;
  try { hs = estimateStrength(st.hole, h.board, h.street, game, seat); } catch { hs = 0.3; }

  game._learnSamples.push({
    seat,
    position: seat,
    seatedCount: game._seatedActive().length,
    street: h.street,
    handScore: hs,
    stackBB: Math.round(p.stack / bb),
    action,
    amount: amount || 0,
    potSize: game._collectPot(),
    profileSnap: profile,
  });
}

function finalizeHandSamples(game) {
  if (!game._learnSamples || game._learnSamples.length === 0) return;
  const scored = scoreHandSamples(game._learnSamples, game);
  if (!game._learnLog) game._learnLog = [];
  game._learnLog.push(...scored);
  game._learnSamples = [];
}

module.exports = { recordSample, finalizeHandSamples, onlineLearn, scoreHandSamples };
