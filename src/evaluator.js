'use strict';

// 牌型评估器：给定 5~7 张牌，返回可比较的“牌力向量”
// 返回数组 [category, ...tiebreakers]，逐位比较，越大越强
// category: 8=同花顺 7=四条 6=葫芦 5=同花 4=顺子 3=三条 2=两对 1=一对 0=高牌

const CATEGORY_NAMES = {
  8: '同花顺', 7: '四条', 6: '葫芦', 5: '同花',
  4: '顺子', 3: '三条', 2: '两对', 1: '一对', 0: '高牌',
};

// 从 arr 中取 k 个的所有组合
function combinations(arr, k) {
  const res = [];
  const n = arr.length;
  const idx = Array.from({ length: k }, (_, i) => i);
  while (true) {
    res.push(idx.map((i) => arr[i]));
    let i = k - 1;
    while (i >= 0 && idx[i] === n - k + i) i--;
    if (i < 0) break;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
  return res;
}

// 评估恰好 5 张牌
function evaluate5(cards) {
  const rs = cards.map((c) => c.r).sort((a, b) => b - a);
  const suits = cards.map((c) => c.s);
  const flush = suits.every((s) => s === suits[0]);

  const counts = {};
  for (const r of rs) counts[r] = (counts[r] || 0) + 1;
  // 按 (数量, 点数) 降序排列
  const groups = Object.entries(counts)
    .map(([r, c]) => [c, +r])
    .sort((a, b) => b[0] - a[0] || b[1] - a[1]);

  // 顺子判定（含 A-2-3-4-5 轮子）
  const uniq = [...new Set(rs)].sort((a, b) => b - a);
  let straight = 0;
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) straight = uniq[0];
    else if (uniq[0] === 14 && uniq[1] === 5 && uniq[4] === 2) straight = 5; // 轮子，最大牌算 5
  }

  if (straight && flush) return [8, straight];
  if (groups[0][0] === 4) return [7, groups[0][1], groups[1][1]];
  if (groups[0][0] === 3 && groups[1][0] === 2) return [6, groups[0][1], groups[1][1]];
  if (flush) return [5, ...rs];
  if (straight) return [4, straight];
  if (groups[0][0] === 3) return [3, groups[0][1], ...groups.slice(1).map((g) => g[1])];
  if (groups[0][0] === 2 && groups[1][0] === 2) {
    const hi = Math.max(groups[0][1], groups[1][1]);
    const lo = Math.min(groups[0][1], groups[1][1]);
    return [2, hi, lo, groups[2][1]];
  }
  if (groups[0][0] === 2) return [1, groups[0][1], ...groups.slice(1).map((g) => g[1])];
  return [0, ...rs];
}

// 比较两个牌力向量，返回 >0 表示 a 强
function cmp(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

// 从 5~7 张里评估最强 5 张
function bestOf(cards) {
  if (cards.length < 5) throw new Error('至少需要 5 张牌');
  let best = null;
  for (const combo of combinations(cards, 5)) {
    const v = evaluate5(combo);
    if (!best || cmp(v, best) > 0) best = v;
  }
  return best;
}

module.exports = { evaluate5, bestOf, cmp, combinations, CATEGORY_NAMES };
