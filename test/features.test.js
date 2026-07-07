'use strict';
// 端到端验证新功能：房间聊天广播 + 掉线释放座位
const http = require('http');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = 4713;
const srv = spawn('node', ['server.js'], {
  cwd: __dirname + '/..',
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
  stdio: 'ignore',
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const assert = (cond, msg) => { if (!cond) { ok = false; console.error('  ✗ ' + msg); } else { console.log('  ✓ ' + msg); } };

function client(name, room, nick) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`);
    const c = { ws, name, id: null, state: null, chats: [] };
    ws.on('open', () => ws.send(JSON.stringify({ type: 'join', roomId: room, nickname: nick })));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'joined') { c.id = m.playerId; resolve(c); }
      else if (m.type === 'state') c.state = m;
      else if (m.type === 'chat') c.chats.push(m);
    });
  });
}

(async () => {
  try {
    await wait(1200);

    console.log('— 房间聊天广播 —');
    const a = await client('A', 'feat', '阿宝');
    const b = await client('B', 'feat', '小美');
    await wait(150);

    // B 监听聊天
    const gotByB = new Promise((res) => {
      b.ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === 'chat') res(m);
      });
    });
    a.ws.send(JSON.stringify({ type: 'chat', text: 'hi <b>' }));
    const cb = await Promise.race([gotByB, wait(2000).then(() => null)]);
    assert(cb && cb.text === 'hi <b>', '聊天消息广播给房间内其他客户端');
    assert(cb && cb.name === '阿宝', '聊天消息携带发送者昵称');
    await wait(100);
    assert(a.chats.some((m) => m.text === 'hi <b>'), '发送者自身也能收到自己发出的聊天');

    // 空白消息应被忽略
    const before = b.chats.length;
    a.ws.send(JSON.stringify({ type: 'chat', text: '   ' }));
    await wait(150);
    assert(b.chats.length === before, '空白聊天被服务端忽略');

    a.ws.close(); b.ws.close();
    await wait(200);

    console.log('— 掉线释放座位（服务端）—');
    const c1 = await client('C', 'feat2', '甲');
    const c2 = await client('D', 'feat2', '乙');
    await wait(150);
    c1.ws.send(JSON.stringify({ type: 'sit', seat: 0 }));
    c2.ws.send(JSON.stringify({ type: 'sit', seat: 1 }));
    await wait(250);
    assert(c2.state && c2.state.seatedCount === 2, '两人已入座, 实际' + (c2.state ? c2.state.seatedCount : '?'));

    c1.ws.close(); // 甲掉线
    await wait(450);
    assert(c2.state && c2.state.seatedCount === 1, '掉线后座位释放，seatedCount 应为1，实际' + (c2.state ? c2.state.seatedCount : '?'));
    assert(c2.state && c2.state.seats[0] === null, '0号座位应被释放（room 刷新）');
    c2.ws.close();

    console.log(ok ? '\n新功能验证通过 ✅' : '\n新功能验证失败 ❌');
  } catch (e) {
    ok = false; console.error(e);
  } finally {
    srv.kill('SIGKILL');
    process.exit(ok ? 0 : 1);
  }
})();
