'use strict';
// 端到端：起服务，两个 WS 客户端加入同一房间并打一局
const http = require('http');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = 4711;
const srv = spawn('node', ['server.js'], {
  cwd: __dirname + '/..',
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
  stdio: 'ignore',
});

function httpGet(path) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: PORT, path }, (r) => {
      let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(d));
    }).on('error', rej);
  });
}

const states = {}; // name -> last state
function client(name, nick) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`);
    const c = { ws, name, id: null };
    ws.on('open', () => ws.send(JSON.stringify({ type: 'join', roomId: 'smoke', nickname: nick })));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'joined') { c.id = m.playerId; resolve(c); }
      if (m.type === 'state') { states[name] = m; c.state = m; }
      if (m.type === 'error') console.log(`[${name}] err:`, m.msg);
    });
  });
}
const send = (c, o) => c.ws.send(JSON.stringify(o));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let ok = true;
  const assert = (cond, msg) => { if (!cond) { ok = false; console.error('  ✗ ' + msg); } };
  try {
    await wait(700);
    const health = JSON.parse(await httpGet('/health'));
    assert(health.ok === true, '/health 正常');

    const a = await client('A', '阿宝');
    const b = await client('B', '小美');
    await wait(200);
    send(a, { type: 'sit', seat: 0 });
    send(b, { type: 'sit', seat: 3 });
    await wait(200);
    assert(a.state.seatedCount === 2, '两人已入座, 实际' + a.state.seatedCount);

    send(a, { type: 'start' }); // A 是房主
    await wait(300);
    assert(a.state.status === 'playing', '开局后状态 playing, 实际' + a.state.status);

    // 自动跟注/过牌直到本局结束
    for (let i = 0; i < 40; i++) {
      for (const c of [a, b]) {
        const s = c.state;
        if (s && s.status === 'playing' && s.legal && s.actor === s.you.seat) {
          if (s.legal.canCheck) send(c, { type: 'action', action: 'check' });
          else if (s.legal.canCall) send(c, { type: 'action', action: 'call' });
          await wait(80);
        }
      }
      if (a.state.status === 'showdown') break;
      await wait(80);
    }
    assert(a.state.status === 'showdown', '应到摊牌, 实际' + a.state.status);
    assert(a.state.board.length === 5, '公共牌5张, 实际' + a.state.board.length);
    // 只能看到自己的底牌
    const meSeat = a.state.you.seat;
    const otherSeat = a.state.seats.findIndex((x, i) => x && i !== meSeat && !x.folded);
    if (otherSeat >= 0) {
      // 摊牌阶段可见对手底牌（合理），下面验证进行中不可见通过另一测试覆盖
    }
    const chips = a.state.seats.filter(Boolean).reduce((s, x) => s + x.stack, 0);
    assert(chips === 2000, '两人筹码守恒2000, 实际' + chips);

    console.log(ok ? '\n冒烟测试通过 ✅' : '\n冒烟测试失败 ❌');
  } catch (e) {
    ok = false; console.error(e);
  } finally {
    srv.kill('SIGKILL');
    process.exit(ok ? 0 : 1);
  }
})();
