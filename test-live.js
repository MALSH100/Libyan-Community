'use strict';
/* End-to-end run of the two-message match flow against a mocked Discord
   channel, with the clock compressed so it finishes in seconds. */
const fs = require('fs'), path = require('path');
let src = fs.readFileSync(path.join(__dirname, 'football.js'), 'utf8')
  .replace('const TICK_MS     = 4500;', 'const TICK_MS     = 20;')
  .replace('const HT_PAUSE_MS = 14000;', 'const HT_PAUSE_MS = 20;')
  .replace(/\nmodule\.exports = \{[\s\S]*$/, '');
const tmp = path.join(__dirname, '_test_live.js');
fs.writeFileSync(tmp, src + `\nmodule.exports = { runLiveMatch, handleLive, newMatch, ctxFor, makeAIContext,
  pickAIOpponent, fState, getManager, ensureSquad, doBuyClub, LIVE, TICKS };\n`);
const FM = require(tmp);

const edits = { pitch: 0, dugout: 0 };
let sent = 0;
const mkMsg = (kind) => ({ id: `${kind}-msg`, edit: async () => { edits[kind]++; } });
const channel = { send: async (p) => { sent++; return mkMsg(p.files ? 'pitch' : 'dugout'); } };

const db = {}, wallet = { u1: 60000, u2: 60000 };
const api = { getDinar: (d,g,u)=>wallet[u]||0, spendDinar:(d,g,u,n)=>{if((wallet[u]||0)<n)return false;wallet[u]-=n;return true;},
  awardDinar:(d,g,u,n)=>{wallet[u]=(wallet[u]||0)+n;}, saveData: ()=>{} };
const GID='g1';
FM.ensureSquad(FM.getManager(db, GID, 'u1'));
FM.ensureSquad(FM.getManager(db, GID, 'u2'));
FM.doBuyClub(db, GID, 'u1', 'liverpool', api);
FM.doBuyClub(db, GID, 'u2', 'arsenal', api);

const replies = [];
const mkInteraction = (customId, userId, values) => ({
  customId, user: { id: userId }, values,
  reply: async (p) => { replies.push({ customId, userId, content: p.content || (p.embeds && p.embeds[0].data.title) }); },
  update: async (p) => { replies.push({ customId, userId, content: p.content }); },
  deferUpdate: async () => {},
});

(async () => {
  const home = FM.ctxFor(db, GID, 'u1'), away = FM.ctxFor(db, GID, 'u2');
  const m = FM.newMatch(home, away);
  const seat = { u1: 'H', u2: 'A' };

  // fire touchline actions while the match is running
  setTimeout(async () => {
    await FM.handleLive(mkInteraction('fm:live:ment', 'u1', ['attacking']), GID, 'u1');
    await FM.handleLive(mkInteraction('fm:live:instr', 'u2', ['press|high']), GID, 'u2');
    await FM.handleLive(mkInteraction('fm:live:tog:offside', 'u2'), GID, 'u2');
    await FM.handleLive(mkInteraction('fm:live:sub', 'u1'), GID, 'u1');
    await FM.handleLive(mkInteraction('fm:live:subdo', 'u1', ['0']), GID, 'u1');
    await FM.handleLive(mkInteraction('fm:live:mine', 'u1'), GID, 'u1');
    await FM.handleLive(mkInteraction('fm:live:shout:encourage', 'u1'), GID, 'u1');
    await FM.handleLive(mkInteraction('fm:live:ment', 'stranger', ['defensive']), GID, 'stranger');
  }, 120);

  const t0 = Date.now();
  await FM.runLiveMatch(channel, m, seat, db, GID, api.saveData);
  console.log(`\nmessages posted: ${sent} (expect 2: pitch + dugout)`);
  console.log(`edits: pitch ${edits.pitch}, dugout ${edits.dugout} (expect ~${FM.TICKS} each)`);
  console.log(`final: ${m.home.club.short} ${m.hg}-${m.ag} ${m.away.club.short}, ran in ${Date.now()-t0}ms (clock compressed)`);
  console.log(`home mentality after touchline change: ${m.home.mentality} (expect attacking)`);
  console.log(`away pressing: ${m.away.instr.press}, offside trap: ${m.away.instr.offside}`);
  console.log(`home subs used: ${m.home.subsUsed}`);
  console.log(`LIVE registry cleaned up: ${FM.LIVE.size === 0}`);
  console.log('\ntouchline replies:');
  replies.forEach(r => console.log(`  [${r.userId}] ${r.customId} -> ${String(r.content).split('\n')[0].slice(0,90)}`));
  fs.unlinkSync(tmp);
})();
