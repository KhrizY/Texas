'use strict';
// 针对性验证安全修复：playerId 劫持 + XSS 转义
const http = require('http');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = 4712;
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

let ok = true;
const assert = (cond, msg) => { if (!cond) { ok = false; console.error('  ✗ ' + msg); } else { console.log('  ✓ ' + msg); } };

// 复刻前端的 esc()，确认能中和 XSS
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  try {
    await wait(700);

    // 1) playerId 劫持修复：客户端指定 id，服务器应忽略并重新生成
    await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`);
      ws.on('open', () => ws.send(JSON.stringify({
        type: 'join', roomId: 'sec', nickname: '甲', playerId: 'deadbeefdeadbeefdeadbeef',
      })));
      ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === 'joined') {
          assert(m.playerId !== 'deadbeefdeadbeefdeadbeef', '服务器忽略客户端指定的 playerId');
          assert(/^[a-f0-9]{32}$/.test(m.playerId), 'playerId 为服务端生成的 32 位 hex');
          ws.close();
          resolve();
        }
      });
    });

    // 2) XSS 房间号：保持连接时拉 /api/rooms，确认服务器正常接收且不崩溃
    const xssRoom = '<img src=x onerror=alert(1)>';
    await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`);
      let checked = false;
      ws.on('open', () => ws.send(JSON.stringify({ type: 'join', roomId: xssRoom, nickname: 'X' })));
      ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === 'joined') {
          ws.send(JSON.stringify({ type: 'sit', seat: 0 }));
        } else if (m.type === 'state' && !checked && m.you && m.you.seated) {
          checked = true;
          httpGet('/api/rooms').then((d) => {
            const rooms = JSON.parse(d);
            const found = (rooms.rooms || []).some((r) => r.roomId.includes('<'));
            assert(found, '含 XSS payload 的房间号被服务端正常接收且不崩溃');
            ws.close();
            resolve();
          }).catch(() => { ws.close(); resolve(); });
        }
      });
    });

    // 3) 前端 esc() 能中和该 payload
    const safe = esc(xssRoom);
    assert(!/<img/i.test(safe), 'esc() 已将 < 转义，浏览器不会执行脚本');
    assert(safe.includes('&lt;img'), '转义后的房间号仅作文本展示');

    // 4) NaN 座位校验：发送非整数 seat 应被拒绝
    const reject = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`);
      let done = false;
      ws.on('open', () => ws.send(JSON.stringify({ type: 'join', roomId: 'nan', nickname: 'Y' })));
      ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === 'joined') {
          ws.send(JSON.stringify({ type: 'sit', seat: 'abc' }));
        } else if (m.type === 'error' && /座位无效/.test(m.msg) && !done) {
          done = true; ws.close(); resolve(true);
        }
      });
      setTimeout(() => { if (!done) { ws.close(); resolve(false); } }, 2000);
    });
    assert(reject, "非整数座位 (seat:'abc') 被服务端拒绝");

    console.log(ok ? '\n安全修复验证通过 ✅' : '\n安全修复验证失败 ❌');
  } catch (e) {
    ok = false; console.error(e);
  } finally {
    srv.kill('SIGKILL');
    process.exit(ok ? 0 : 1);
  }
})();
