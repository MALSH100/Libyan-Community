'use strict';
// Builds a temporary copy of football.js with test exports, then runs
// thousands of silent matches to check that tactics move the needle.
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'football.js'), 'utf8');
const tmp = path.join(__dirname, '_test_football.js');
fs.writeFileSync(tmp, src + `
module.exports = { newMatch, advance, MENTALITIES, INSTRUCTIONS, FORMATIONS, planOf,
  lineRating, TICKS, DEFAULT_INSTR };
`);
const FM = require(tmp);
const DATA = require('./fm-data');

function bestXI(club, formation) {
  const form = FM.FORMATIONS[formation];
  const pool = club.squad.slice().sort((a, b) => b.rating - a.rating);
  const used = new Set(); const out = [];
  form.slots.forEach((s, i) => {
    let p = pool.find(q => !used.has(q.id) && q.pos === s.p);
    if (!p) p = pool.find(q => !used.has(q.id));
    if (p) used.add(p.id);
    out.push(p ? { name: p.name, pos: p.pos, rating: p.rating, num: i + 1 }
               : { name: 'Trialist', pos: s.p, rating: 58, num: i + 1 });
  });
  return out;
}
function ctx(clubId, mentality, instr, formation = '4-3-3') {
  const club = DATA.clubById(clubId);
  return {
    club, squad: bestXI(club, formation), formation, mentality,
    instr: Object.assign(FM.DEFAULT_INSTR(), instr || {}),
    morale: 65, cohesion: 60, changes: 0, settle: 0,
  };
}
function play(hSpec, aSpec) {
  const m = FM.newMatch(ctx(...hSpec), ctx(...aSpec));
  for (let t = 0; t < FM.TICKS; t++) advanceSafe(m);
  return m;
}
function advanceSafe(m) { const r = FM.advance(m); m.lastEvent = r.event; return r; }

function series(label, hSpec, aSpec, n = 3000) {
  let hw = 0, aw = 0, d = 0, hg = 0, ag = 0, shots = 0, cards = 0, offs = 0;
  for (let i = 0; i < n; i++) {
    const m = play(hSpec, aSpec);
    hg += m.hg; ag += m.ag;
    shots += m.stats.H.shots + m.stats.A.shots;
    cards += m.cards.H.y + m.cards.A.y;
    offs += m.stats.H.offside + m.stats.A.offside;
    if (m.hg > m.ag) hw++; else if (m.ag > m.hg) aw++; else d++;
  }
  const pct = (x) => (x / n * 100).toFixed(1).padStart(5) + '%';
  console.log(`${label.padEnd(46)} W ${pct(hw)}  D ${pct(d)}  L ${pct(aw)}   goals ${(hg/n).toFixed(2)}-${(ag/n).toFixed(2)}  shots/game ${(shots/n).toFixed(1)}  yel ${(cards/n).toFixed(2)}  off ${(offs/n).toFixed(2)}`);
  return { hw: hw / n, aw: aw / n, d: d / n, hg: hg / n, ag: ag / n };
}

const EVEN = 'liverpool', EVEN2 = 'arsenal';
console.log('\n=== BASELINE: identical clubs, identical tactics ===');
series('balanced vs balanced', [EVEN, 'balanced'], [EVEN, 'balanced']);

console.log('\n=== MENTALITY (same club both sides) ===');
series('attacking  vs defensive', [EVEN, 'attacking'], [EVEN, 'defensive']);
series('defensive  vs attacking', [EVEN, 'defensive'], [EVEN, 'attacking']);
series('positive   vs balanced',  [EVEN, 'positive'],  [EVEN, 'balanced']);
series('cautious   vs balanced',  [EVEN, 'cautious'],  [EVEN, 'balanced']);

console.log('\n=== COUNTER 1: direct passing beats a high press ===');
series('direct     vs high press', [EVEN, 'balanced', { pass:'direct' }], [EVEN, 'balanced', { press:'high' }]);
series('short      vs high press', [EVEN, 'balanced', { pass:'short'  }], [EVEN, 'balanced', { press:'high' }]);
series('direct     vs sit deep',   [EVEN, 'balanced', { pass:'direct' }], [EVEN, 'balanced', { press:'low'  }]);

console.log('\n=== COUNTER 2: wide beats narrow in the box, narrow wins midfield ===');
series('wide       vs narrow', [EVEN, 'balanced', { width:'wide'   }], [EVEN, 'balanced', { width:'narrow' }]);
series('narrow     vs wide',   [EVEN, 'balanced', { width:'narrow' }], [EVEN, 'balanced', { width:'wide'   }]);

console.log('\n=== COUNTER 3: the offside trap ===');
series('trap       vs short passing', [EVEN, 'balanced', { offside:true }], [EVEN, 'balanced', { pass:'short'  }]);
series('trap       vs direct passing', [EVEN, 'balanced', { offside:true }], [EVEN, 'balanced', { pass:'direct' }]);

console.log('\n=== COUNTER 4: stamina punishes a full-throttle setup ===');
series('press+fast+attacking vs balanced', [EVEN, 'attacking', { press:'high', tempo:'fast' }], [EVEN, 'balanced']);

console.log('\n=== TIME-WASTING ===');
series('timewaste  vs balanced', [EVEN, 'balanced', { timeWaste:true }], [EVEN, 'balanced']);

console.log('\n=== SQUAD QUALITY still matters ===');
series('Real Madrid vs Al-Shat',   ['real-madrid', 'balanced'], ['shat', 'balanced']);
series('Al-Shat vs Real Madrid (Shat defensive+deep)', ['shat', 'defensive', { press:'low', pass:'direct' }], ['real-madrid', 'balanced']);
series('Liverpool vs Arsenal',     [EVEN, 'balanced'], [EVEN2, 'balanced']);

console.log('\n=== HOW MUCH DOES TACTICS BEAT A RATING GAP? ===');
series('Bologna (best plan) vs Inter (worst plan)',
  ['bologna', 'balanced', { pass:'direct', width:'wide' }],
  ['inter',   'attacking', { press:'high', tempo:'fast', pass:'short' }]);
series('Bologna (bad plan) vs Inter (good plan)',
  ['bologna', 'attacking', { press:'high', tempo:'fast', pass:'short' }],
  ['inter',   'balanced', { pass:'direct' }]);

fs.unlinkSync(tmp);
console.log('\n=== WIDTH AGAINST OTHER LEVERS ===');
series('wide       vs low block', [EVEN,'balanced',{width:'wide'}],   [EVEN,'defensive',{press:'low'}]);
series('narrow     vs low block', [EVEN,'balanced',{width:'narrow'}], [EVEN,'defensive',{press:'low'}]);
series('narrow     vs high press',[EVEN,'balanced',{width:'narrow'}], [EVEN,'balanced',{press:'high'}]);
series('wide       vs high press',[EVEN,'balanced',{width:'wide'}],   [EVEN,'balanced',{press:'high'}]);
