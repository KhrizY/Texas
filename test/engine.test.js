'use strict';
// 引擎自测：牌型评估、边池、完整一局流程
const { evaluate5, bestOf, cmp } = require('../src/evaluator');
const { computePots } = require('../src/game');
const { Game } = require('../src/game');

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; } else { fail++; console.error('  ✗ ' + msg); }
}
const C = (r, s) => ({ r, s }); // 0♠ 1♥ 2♦ 3♣

console.log('— 牌型评估 —');
// 皇家同花顺 > 四条
const royal = bestOf([C(14,0),C(13,0),C(12,0),C(11,0),C(10,0),C(2,1),C(3,2)]);
const quads = bestOf([C(9,0),C(9,1),C(9,2),C(9,3),C(2,0),C(3,1),C(4,2)]);
assert(royal[0] === 8, '皇家同花顺 类别应为 8');
assert(quads[0] === 7, '四条 类别应为 7');
assert(cmp(royal, quads) > 0, '同花顺应大于四条');

// 葫芦 > 同花
const fullhouse = bestOf([C(5,0),C(5,1),C(5,2),C(8,0),C(8,1),C(2,3),C(3,3)]);
const flush = bestOf([C(2,1),C(5,1),C(8,1),C(11,1),C(13,1),C(3,0),C(4,2)]);
assert(fullhouse[0] === 6 && flush[0] === 5, '葫芦=6 同花=5');
assert(cmp(fullhouse, flush) > 0, '葫芦应大于同花');

// 轮子顺子 A-2-3-4-5
const wheel = evaluate5([C(14,0),C(2,1),C(3,2),C(4,3),C(5,0)]);
assert(wheel[0] === 4 && wheel[1] === 5, '轮子应为顺子且最大牌为5');
// 普通顺子应大于轮子
const straight6 = evaluate5([C(6,0),C(2,1),C(3,2),C(4,3),C(5,0)]);
assert(cmp(straight6, wheel) > 0, '2-6顺子应大于轮子');

// 两对踢脚比较
const tp1 = bestOf([C(10,0),C(10,1),C(4,2),C(4,3),C(14,0),C(2,1),C(3,2)]);
const tp2 = bestOf([C(10,2),C(10,3),C(4,0),C(4,1),C(13,0),C(2,3),C(3,3)]);
assert(cmp(tp1, tp2) > 0, '两对同点数时A踢脚应胜K踢脚');

console.log('— 边池计算 —');
// A全下100，B全下200，C跟200 -> 主池300(A,B,C) 边池200(B,C)
const pots = computePots([
  { seat: 0, amount: 100, folded: false },
  { seat: 1, amount: 200, folded: false },
  { seat: 2, amount: 200, folded: false },
]);
const total = pots.reduce((s, p) => s + p.amount, 0);
assert(total === 500, '边池总额应为500，实际' + total);
const main = pots.find((p) => p.eligible.length === 3);
assert(main && main.amount === 300, '主池应为300且3人有资格');
const side = pots.find((p) => p.eligible.length === 2);
assert(side && side.amount === 200, '边池应为200且2人有资格');

// 弃牌者筹码进池但无资格
const pots2 = computePots([
  { seat: 0, amount: 50, folded: true },
  { seat: 1, amount: 100, folded: false },
  { seat: 2, amount: 100, folded: false },
]);
assert(pots2.reduce((s, p) => s + p.amount, 0) === 250, '含弃牌者总池应为250');
assert(pots2.every((p) => !p.eligible.includes(0)), '弃牌者不应有资格赢池');

console.log('— 完整一局流程 —');
(function playHand() {
  const g = new Game('test', { actionTimeoutMs: 999999, startStack: 1000, sb: 5, bb: 10 });
  g.addPlayer('A', 'A'); g.addPlayer('B', 'B'); g.addPlayer('C', 'C');
  g.sit('A', 0); g.sit('B', 1); g.sit('C', 2);
  const r = g.startHand('A');
  assert(!r.error, '开局不应报错: ' + (r.error || ''));
  assert(g.status === 'playing', '状态应为 playing');
  assert(g.hand.board.length === 0, '翻牌前无公共牌');

  // 盲注已下：SB=1号位(seat1)?  button 首手为 seat0 -> sb=seat1 bb=seat2 utg=seat0
  const startChips = 3000;
  let guard = 0;
  while (g.status === 'playing' && guard++ < 50) {
    const actor = g.hand.actor;
    if (actor === null) break;
    const id = g.seats[actor];
    const st = g.hand.ps[actor];
    const toCall = g.hand.currentBet - st.roundBet;
    if (toCall > 0) g.act(id, 'call', 0);
    else g.act(id, 'check', 0);
  }
  assert(g.status === 'showdown' || g.status === 'waiting', '全程跟注/过牌应到摊牌，实际' + g.status);
  assert(g.hand && g.hand.board.length === 5, '摊牌应有5张公共牌，实际' + (g.hand ? g.hand.board.length : 'na'));
  // 筹码守恒
  const totalNow = ['A','B','C'].reduce((s, id) => s + g.players.get(id).stack, 0);
  assert(totalNow === startChips, '筹码总量应守恒为3000，实际' + totalNow);
  assert(g.hand.winners && g.hand.winners.length > 0, '应产生赢家');
})();

console.log('— 弃牌到只剩一人立即结束 —');
(function foldOut() {
  const g = new Game('t2', { actionTimeoutMs: 999999, startStack: 1000 });
  g.addPlayer('A', 'A'); g.addPlayer('B', 'B'); g.addPlayer('C', 'C');
  g.sit('A', 0); g.sit('B', 1); g.sit('C', 2);
  g.startHand('A');
  let guard = 0;
  while (g.status === 'playing' && guard++ < 20) {
    const actor = g.hand.actor;
    const id = g.seats[actor];
    g.act(id, 'fold', 0);
  }
  assert(g.status === 'showdown', '连续弃牌应立即结束');
  const total = ['A','B','C'].reduce((s, id) => s + g.players.get(id).stack, 0);
  assert(total === 3000, '弃牌局筹码守恒，实际' + total);
})();

console.log('— 摊牌输赢判断 —');
// 构造一局后直接注入底牌/公共牌/投入，验证结算
function forceShowdown(ids, seatList, holes, board, committed) {
  const g = new Game('sd', { actionTimeoutMs: 999999, startStack: 1000 });
  ids.forEach((id, i) => { g.addPlayer(id, id); g.sit(id, seatList[i]); });
  g.startHand(ids[0]);
  g.hand.board = board;
  for (let i = 0; i < ids.length; i++) {
    const s = seatList[i];
    g.hand.ps[s].hole = holes[i];
    g.hand.ps[s].committed = committed[i];
    g.hand.ps[s].folded = false;
    g.players.get(ids[i]).stack = 0; // 清零，便于观察纯派彩
  }
  g.hand.street = 'river';
  g._showdown();
  return g;
}

// 场景1：明确单一赢家（AA > KK > 高牌）
{
  const board = [C(2,0),C(7,1),C(9,2),C(12,3),C(4,3)];
  const g = forceShowdown(
    ['P0','P1','P2'], [0,1,2],
    [[C(14,0),C(14,1)], [C(13,0),C(13,1)], [C(3,2),C(5,2)]],
    board, [100,100,100]
  );
  const winners = g.hand.winners.filter((w) => w.amount > 0);
  assert(winners.length === 1, '应只有一个赢家，实际' + winners.length);
  assert(winners[0].seat === 0 && winners[0].amount === 300, 'AA 应独赢300，实际座位' + (winners[0]||{}).seat + ' 金额' + (winners[0]||{}).amount);
}

// 场景2：真正平局（两人打公共牌）应平分
{
  const board = [C(14,0),C(14,1),C(13,2),C(13,3),C(9,0)]; // 公共牌 AAKK9
  const g = forceShowdown(
    ['Q0','Q1'], [0,1],
    [[C(2,0),C(3,1)], [C(2,2),C(4,2)]], // 双方都只能打公共牌 -> 平
    board, [100,100]
  );
  const winners = g.hand.winners.filter((w) => w.amount > 0);
  assert(winners.length === 2, '平局应两人分池，实际' + winners.length);
  assert(winners.every((w) => w.amount === 100), '各分100，实际' + JSON.stringify(winners.map(w=>w.amount)));
}

// 场景3：边池 —— 小额全下者(最强)只能赢主池，边池归第二强
{
  const board = [C(2,0),C(7,1),C(9,2),C(12,3),C(4,3)];
  const g = forceShowdown(
    ['R0','R1','R2'], [0,1,2],
    [[C(14,0),C(14,1)], [C(13,0),C(13,1)], [C(3,2),C(5,2)]],
    board, [50,100,100] // R0 全下50(最强)，R1/R2 各100
  );
  const pay = {};
  g.hand.winners.forEach((w) => { if (w.amount > 0) pay[w.seat] = w.amount; });
  assert(pay[0] === 150, 'R0 只应赢主池150，实际' + pay[0]);
  assert(pay[1] === 100, 'R1 应赢边池100，实际' + pay[1]);
  assert(!pay[2], 'R2 不应赢，实际' + pay[2]);
}

console.log('— 掉线释放座位 —');
// 等待中掉线：立即释放座位并移除玩家，房间刷新
{
  const g = new Game('disc1', { actionTimeoutMs: 999999 });
  g.addPlayer('A', 'A'); g.sit('A', 0);
  g.disconnect('A');
  assert(g.seats[0] === null, '等待中掉线应立即释放座位');
  assert(!g.players.has('A'), '等待中掉线应移除玩家');
  assert(g._seatedActive().length === 0, '座位计数应归零');
}
// 牌局进行中掉线：暂留座位（由超时处理），本局结束后统一清理
{
  const g = new Game('disc2', { actionTimeoutMs: 999999 });
  g.addPlayer('A', 'A'); g.addPlayer('B', 'B');
  g.sit('A', 0); g.sit('B', 1);
  const r = g.startHand('A');
  assert(!r.error, '开局不应报错');
  assert(g.status === 'playing', '状态应为 playing');
  g.disconnect('A');
  assert(g.seats[0] !== null, '牌局进行中掉线应暂留座位');
  assert(g.players.get('A').connected === false, '应标记掉线');
  // 让 B 把牌局打完；掉线的 A 由超时逻辑自动弃牌（此处模拟 _onTimeout）
  let guard = 0;
  while (g.status === 'playing' && guard++ < 60) {
    const actor = g.hand.actor;
    if (actor === null) break;
    const id = g.seats[actor];
    const p = g.players.get(id);
    if (p && !p.connected) { g._onTimeout(actor); continue; }
    const st = g.hand.ps[actor];
    const toCall = g.hand.currentBet - st.roundBet;
    if (toCall > 0) g.act(id, 'call', 0); else g.act(id, 'check', 0);
  }
  assert(g.status === 'showdown', '牌局应结束');
  assert(g.seats[0] === null, '本局结束后掉线玩家座位应被清理');
  assert(!g.players.has('A'), '本局结束后掉线玩家应被移除');
  // A 翻牌前弃牌（剩 995 筹码），随离场离开牌桌；B 赢走 15 底池 -> 990+15=1005
  assert(g.players.get('B').stack === 1005, '未离场玩家筹码正确（赢走底池），实际' + g.players.get('B').stack);
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
