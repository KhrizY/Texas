'use strict';

//  机器人自学习训练引擎
//  群体进化算法：多组 profile 变异体互相对战，逐代优化
//  用法：node scripts/train-bots.js [--hands 200] [--gens 15] [--output data/bot-profiles.json]

const path = require('path');
const { Game } = require(path.join(__dirname, '..', 'src', 'game'));
const { decideBotAction, trackAction } = require(path.join(__dirname, '..', 'src', 'bot'));

// ========================= 参数配置 =========================
const args = process.argv.slice(2);
const NUM_HANDS = parseInt(getArg('--hands', '5000'), 10);
const GENERATIONS = parseInt(getArg('--gens', '80'), 10);
const POP_SIZE = 30;          // 每代 candidate 数
const KEEP_TOP = 20;          // 每代保留 top N 进入下代
const OUTPUT = getArg('--output', path.join(__dirname, '..', 'data', 'bot-profiles.json'));

function getArg(flag, defaultVal) {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : defaultVal;
}

// ========================= 基础 profile（12 个原始角色） =========================
const BASE_PROFILES = [
  { name: '高松灯',   profile: { tight: 0.02, aggression: 1.05, bluff: 0.80, call: 1.15, allin: 0.70 } },
  { name: '千早爱音', profile: { tight:-0.05, aggression: 1.35, bluff: 1.35, call: 1.05, allin: 0.55 } },
  { name: '要乐奈',   profile: { tight:-0.08, aggression: 1.45, bluff: 1.15, call: 0.95, allin: 0.65 } },
  { name: '长崎爽世', profile: { tight: 0.06, aggression: 0.95, bluff: 0.75, call: 1.00, allin: 0.45 } },
  { name: '椎名立希', profile: { tight: 0.10, aggression: 1.28, bluff: 0.65, call: 0.82, allin: 0.55 } },
  { name: '多洛莉丝', profile: { tight:-0.06, aggression: 1.38, bluff: 1.45, call: 1.00, allin: 0.50 } },
  { name: '墨提斯',   profile: { tight: 0.02, aggression: 1.32, bluff: 1.05, call: 0.92, allin: 0.45 } },
  { name: '提摩利斯', profile: { tight: 0.04, aggression: 0.92, bluff: 0.85, call: 1.35, allin: 0.35 } },
  { name: '阿莫里斯', profile: { tight:-0.03, aggression: 1.22, bluff: 1.55, call: 1.05, allin: 0.50 } },
  { name: '欧布利维奥尼斯', profile: { tight: 0.14, aggression: 1.40, bluff: 0.45, call: 0.75, allin: 0.50 } },
  { name: '若叶睦',   profile: { tight: 0.09, aggression: 1.18, bluff: 0.55, call: 0.90, allin: 0.45 } },
  { name: '丰川祥子', profile: { tight: 0.03, aggression: 1.50, bluff: 1.00, call: 0.85, allin: 0.50 } },
];

// ========================= 工具函数 =========================
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function rand(min, max) { return min + Math.random() * (max - min); }
function gauss() { let u=0; for(let i=0;i<6;i++) u+=Math.random(); return (u-3)/Math.sqrt(0.5); }

function mutateProfile(p, rate = 0.15) {
  return {
    tight:     clamp(p.tight     + gauss() * rate * 0.15, -0.15, 0.20),
    aggression:clamp(p.aggression+ gauss() * rate * 0.50,  0.70, 1.70),
    bluff:     clamp(p.bluff     + gauss() * rate * 0.60,  0.30, 1.80),
    call:      clamp(p.call      + gauss() * rate * 0.30,  0.60, 1.50),
    allin:     clamp(p.allin     + gauss() * rate * 0.15,  0.25, 0.85),
  };
}

function crossoverProfile(a, b) {
  return {
    tight:     Math.random() < 0.5 ? a.tight : b.tight,
    aggression:Math.random() < 0.5 ? a.aggression : b.aggression,
    bluff:     Math.random() < 0.5 ? a.bluff : b.bluff,
    call:      Math.random() < 0.5 ? a.call : b.call,
    allin:     Math.random() < 0.5 ? a.allin : b.allin,
  };
}

// ========================= 批量对战 =========================
function runBatch(profiles) {
  // 为每个 profile 分配内存 bank
  const bank = new Map();
  for (const p of profiles) bank.set(p.name, 0);

  for (let h = 0; h < NUM_HANDS; h++) {
    const g = new Game('train', { sb: 5, bb: 10, startStack: 2000, actionTimeoutMs: 60000 });

    // 随机选 6-9 人、随机分配 profile
    const num = 4 + Math.floor(Math.random() * 5); // 4-8
    const shuffled = [...profiles].sort(() => Math.random() - 0.5);
    const players = shuffled.slice(0, Math.min(num, shuffled.length));
    const assigned = [];
    for (const entry of players) {
      const pid = 'b' + Math.random().toString(36).slice(2, 10);
      const bot = g.addPlayer(pid, entry.name, { isBot: true });
      bot.botProfile = { ...entry.profile };
      const seat = g.seats.findIndex(x => !x);
      if (seat >= 0) {
        const r = g.sit(pid, seat);
        if (!r || r.error) continue;
        assigned.push({ pid, seat, entry });
      }
    }

    if (assigned.length < 2) continue;

    // 纯 bot 桌：hostId 为 null，startHand(null) 跳过权限检查
    const r = g.startHand(null);
    if (r && r.error) continue;

    // 驱动牌局至结束
    let safety = 0;
    while (g.status !== 'showdown' && g.status !== 'waiting' && safety < 500) {
      safety++;
      if (g.status === 'playing' && g.hand && g.hand.actor !== null) {
        const actSeat = g.hand.actor;
        const pid = g.seats[actSeat];
        const player = g.players.get(pid);
        if (player && player.isBot) {
          const decision = decideBotAction(g, actSeat);
          g.act(pid, decision.action, decision.amount || 0);
        } else if (player && !player.isBot) {
          // 真人不会参与训练，理论上不存在
          g.act(pid, 'fold', 0);
        }
      } else if (g.status === 'waiting' || g.status === 'showdown') {
        break;
      }
    }

    // 结算：最终筹码 = 收益
    for (const a of assigned) {
      const player = g.players.get(a.pid);
      if (player) {
        bank.set(a.entry.name, (bank.get(a.entry.name) || 0) + player.stack - 2000);
      }
    }
  }

  // 归一化：按 profile 汇总收益
  const results = new Map();
  for (const entry of profiles) {
    const total = bank.get(entry.name) || 0;
    results.set(entry.name, { profile: entry, ev: total, avgEv: total / Math.max(1, NUM_HANDS) });
  }
  return results;
}

// ========================= 群体进化 =========================
function evolve() {
  console.log(`═══ 自学习训练启动 ═══`);
  console.log(`  每代 ${NUM_HANDS} 手 × ${GENERATIONS} 代 × 群体 ${POP_SIZE}`);
  console.log(`  开始时间: ${new Date().toLocaleString()}\n`);

  // 初始群体：原 12 + 随机 12
  let population = [...BASE_PROFILES.map(p => ({ ...p, profile: { ...p.profile } }))];
  while (population.length < POP_SIZE) {
    const base = BASE_PROFILES[Math.floor(Math.random() * BASE_PROFILES.length)];
    population.push({ name: `种子${population.length}`, profile: mutateProfile(base.profile, 0.3) });
  }

  let bestEver = null;
  let lastRanked = null;

  for (let gen = 0; gen < GENERATIONS; gen++) {
    process.stdout.write(`第 ${gen + 1}/${GENERATIONS} 代 … `);

    const results = runBatch(population);

    // 按 EV 排名
    const ranked = [...results.values()].sort((a, b) => b.ev - a.ev);
    lastRanked = ranked;
    const top3 = ranked.slice(0, 3);
    const topEV = top3[0].ev;
    process.stdout.write(`Top: ${top3.map(r => `${r.profile.name}(ev=${r.ev})`).join(' | ')}\n`);

    if (!bestEver || topEV > bestEver.ev) bestEver = { ev: topEV, profile: top3[0].profile, gen: gen + 1 };

    // 精英保留
    const survivors = ranked.slice(0, KEEP_TOP);

    // 生成下一代
    const nextGen = survivors.map(s => ({ ...s.profile, profile: { ...s.profile.profile } }));

    // 交叉 + 变异填补
    while (nextGen.length < POP_SIZE) {
      // 锦标赛选择父代
      const p1 = survivors[Math.floor(Math.random() * Math.min(6, survivors.length))].profile;
      const p2 = survivors[Math.floor(Math.random() * Math.min(6, survivors.length))].profile;
      let child = crossoverProfile(p1.profile, p2.profile);
      child = mutateProfile(child, 0.10 + Math.random() * 0.10);
      nextGen.push({ name: `变异${gen+1}-${nextGen.length}`, profile: child });
    }

    population = nextGen;
  }

  console.log(`\n═══ 训练完成 ═══`);
  console.log(`  最佳 profile: ${JSON.stringify(bestEver.profile.profile)} (gen ${bestEver.gen}, ev=${bestEver.ev})`);

  return { best: bestEver, population, lastRanked };
}

// ========================= 保存结果 =========================
function saveResults(population, best, lastRanked) {
  const fs = require('fs');
  const dir = path.dirname(OUTPUT);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // 按 EV 排名输出（优先用最后一代的实测 EV）
  const evMap = new Map();
  if (lastRanked) {
    for (const r of lastRanked) evMap.set(r.profile.name, r.ev);
  }
  const ranked = population.sort((a, b) => {
    const evA = evMap.get(a.name) || 0;
    const evB = evMap.get(b.name) || 0;
    return evB - evA;
  });

  const output = {
    trained: new Date().toISOString(),
    numHands: NUM_HANDS,
    generations: GENERATIONS,
    bestProfile: best ? best.profile.profile : null,
    profiles: ranked.slice(0, 16).map(p => ({
      name: p.name,
      profile: p.profile,
    })),
  };

  fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 2));
  console.log(`  已保存至: ${OUTPUT}\n`);
}

// ========================= 运行 =========================
const result = evolve();
saveResults(result.population, result.best, result.lastRanked);
console.log('训练结束，可在 game.js 中加载该文件供机器人使用。');
