'use strict';
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const { Game } = require('./src/game');

const app = express();
app.get('/favicon.ico', (req, res) => res.status(204).end());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/rooms', (req, res) => {
  const list = [...rooms.entries()].map(([roomId, room]) => {
    const g = room.game;
    return {
      roomId,
      seatedCount: g._seatedActive().length,
      status: g.status,
      handNumber: g.handNumber,
      pot: g.hand ? g._collectPot() : 0,
      bots: [...g.players.values()].filter((p) => p.isBot).length,
      locked: !!room.password,
    };
  }).filter((r) => r.seatedCount > 0 || r.status === 'playing');
  res.json({ rooms: list });
});
app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.size }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// roomId -> { game, clients: Map(playerId -> ws) }
const rooms = new Map();

function getRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    room = { game: null, clients: new Map() };
    room.game = new Game(roomId, { onChange: () => broadcast(roomId) });
    rooms.set(roomId, room);
  }
  return room;
}

function broadcast(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  for (const [pid, ws] of room.clients) {
    if (ws.readyState !== ws.OPEN) continue;
    try {
      ws.send(JSON.stringify(room.game.stateFor(pid)));
    } catch (e) { /* ignore */ }
  }
}

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

wss.on('connection', (ws) => {
  ws.playerId = null;
  ws.roomId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const t = msg.type;

    if (t === 'join') {
      const roomId = String(msg.roomId || 'main').slice(0, 24).trim() || 'main';
      const name = String(msg.nickname || '玩家').slice(0, 16).trim() || '玩家';
      // 房主建房时可设置密码；已加锁房间需正确密码，错误则拒绝（且不创建房间）
      const existing = rooms.get(roomId);
      const pwd = msg.password != null ? String(msg.password) : '';
      if (existing && existing.password && pwd !== existing.password) {
        send(ws, { type: 'error', msg: '房间密码错误' });
        return;
      }
      const isNew = !existing;
      const room = getRoom(roomId);
      if (isNew && pwd) room.password = pwd.slice(0, 32);
      // 身份由服务端统一生成，绝不接受客户端指定的 playerId，杜绝会话顶替
      const playerId = crypto.randomBytes(16).toString('hex');
      ws.playerId = playerId;
      ws.roomId = roomId;
      room.clients.set(playerId, ws);
      room.game.addPlayer(playerId, name);
      send(ws, { type: 'joined', playerId, roomId });
      broadcast(roomId);
      return;
    }

    if (!ws.playerId || !ws.roomId) { send(ws, { type: 'error', msg: '请先加入房间' }); return; }
    const room = rooms.get(ws.roomId);
    if (!room) return;
    const g = room.game;
    let res = null;

    switch (t) {
      case 'sit': {
      const seat = Number(msg.seat);
      res = Number.isInteger(seat) ? g.sit(ws.playerId, seat) : { error: '座位无效' };
      break;
    }
      case 'stand': res = g.stand(ws.playerId); break;
      case 'rebuy': res = g.rebuy(ws.playerId); break;
      case 'grant': {
      const seat = Number(msg.seat);
      const amount = Number(msg.amount);
      res = (Number.isInteger(seat) && Number.isFinite(amount))
        ? g.grant(ws.playerId, seat, amount)
        : { error: '参数无效' };
      break;
    }
      case 'addBot': res = g.addBot(ws.playerId); break;
      case 'removeBot': res = g.removeBot(ws.playerId, Number(msg.seat)); break;
      case 'start': res = g.startHand(ws.playerId); break;
      case 'next': res = g.startNext(ws.playerId); break;
      case 'setAutoNext': res = g.setAutoNext(ws.playerId, !!msg.enabled); break;
      case 'action':
        res = g.act(ws.playerId, String(msg.action), Number(msg.amount) || 0);
        break;
      case 'ping': send(ws, { type: 'pong' }); return;
      case 'chat': {
        const pp = room.game.players.get(ws.playerId);
        const text = String(msg.text || '').slice(0, 200).trim();
        if (!pp || !text) return;
        // 广播给房间内所有客户端（含发送者，由其客户端渲染）
        const payload = JSON.stringify({ type: 'chat', name: pp.name, text, ts: Date.now() });
        for (const [, cws] of room.clients) {
          if (cws.readyState === cws.OPEN) {
            try { cws.send(payload); } catch { /* ignore */ }
          }
        }
        return;
      }
      default: res = { error: '未知指令' };
    }
    if (res && res.error) send(ws, { type: 'error', msg: res.error });
  });

  ws.on('close', () => {
    if (ws.roomId && ws.playerId) {
      const room = rooms.get(ws.roomId);
      if (room && room.clients.get(ws.playerId) === ws) {
        room.clients.delete(ws.playerId);
        room.game.disconnect(ws.playerId);
        // 房间空了则回收
        if (room.clients.size === 0) {
          setTimeout(() => {
            const r = rooms.get(ws.roomId);
            if (r && r.clients.size === 0) rooms.delete(ws.roomId);
          }, 60000);
        }
      }
    }
  });
});

const PORT = process.env.PORT || process.env.ZAOCODE_PREVIEW_PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
server.listen(PORT, HOST, () => {
  console.log(`德州扑克服务已启动 http://${HOST}:${PORT}`);
});
