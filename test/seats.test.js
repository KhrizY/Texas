'use strict';
// 动态座位数自测：初始 6 位，满 6 人后随人数 +1 扩展，最高 9，保持均匀
const { Game } = require('../src/game');

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; } else { fail++; console.error('  ✗ ' + msg); }
}

function freshGame() { return new Game('t' + Math.random().toString(36).slice(2, 8)); }

// 确保 0..n-1 连续入座（幂等）
function sitN(g, n) {
  for (let i = 0; i < n; i++) {
    const id = 'p' + i;
    if (!g.players.get(id)) g.addPlayer(id, id);
    if (g.seats[i] !== id) g.sit(id, i);
  }
}

console.log('— 动态座位数 —');
const g = freshGame();
assert(g.config.minSeats === 6 && g.config.maxSeats === 9, '默认 min=6 / max=9');
assert(g.activeSeatCount() === 6, '空桌应默认 6 个位置');

sitN(g, 1); assert(g.activeSeatCount() === 6, '1 人仍 6 位');
sitN(g, 5); assert(g.activeSeatCount() === 6, '5 人仍 6 位');

sitN(g, 6); assert(g.activeSeatCount() === 7, '满 6 人 → 7 位');
sitN(g, 7); assert(g.activeSeatCount() === 8, '7 人 → 8 位');
sitN(g, 8); assert(g.activeSeatCount() === 9, '8 人 → 9 位（封顶）');
sitN(g, 9); assert(g.activeSeatCount() === 9, '9 人仍为 9 位（封顶）');

// 9 → 8 人：已达上限后不回缩
g._removePlayer(g.seats[8]);
assert(g.activeSeatCount() === 9, '9→8 人仍保持 9 位（已达上限不回缩）');

// 掉到 5 人以下回缩到默认 6
const g2 = freshGame();
sitN(g2, 6); assert(g2.activeSeatCount() === 7, 'g2 满 6 → 7');
g2._removePlayer(g2.seats[5]); // 6 → 5 人
assert(g2.activeSeatCount() === 6, 'g2 掉到 5 人 → 回缩默认 6');

// 越界入座应被拒（容量外）
const g3 = freshGame();
g3.addPlayer('x', 'x'); g3.addPlayer('y', 'y'); g3.addPlayer('z', 'z');
assert(g3.sit('x', 8).error === '座位无效', '空桌坐 9 号位(超出默认6)应被拒');
sitN(g3, 6); // 满 6 → 当前 7 个可用座位(0..6)
assert(g3.sit('y', 6).error === undefined, '满 6 人后可坐第 7 号位(索引6)');
assert(g3.sit('z', 8).error === '座位无效', '满 6 人时坐 9 号位(超出当前7)应被拒');

console.log(`动态座位测试：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
