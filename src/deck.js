'use strict';
const crypto = require('crypto');

// 牌用对象表示: { r: 2..14, s: 0..3 }
// r: 11=J 12=Q 13=K 14=A ; s: 0=♠ 1=♥ 2=♦ 3=♣
function freshDeck() {
  const deck = [];
  for (let s = 0; s < 4; s++) {
    for (let r = 2; r <= 14; r++) {
      deck.push({ r, s });
    }
  }
  return deck;
}

// 加密级随机 Fisher-Yates 洗牌
function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function newShuffledDeck() {
  return shuffle(freshDeck());
}

module.exports = { freshDeck, shuffle, newShuffledDeck };
