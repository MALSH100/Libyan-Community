'use strict';
/* Builds every screen and checks it against Discord's Form Body rules —
   the same class of check that would have caught COMPONENT_TOO_MANY_DEFAULT_VALUES
   before it ever reached Railway. */
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'football.js'), 'utf8');
const tmp = path.join(__dirname, '_test_views.js');
fs.writeFileSync(tmp, src.replace(/\nmodule\.exports = \{[\s\S]*$/, '') + `
module.exports = { homeView, squadView, clubsView, marketView, posMarketView, tacticsView,
  instructionsView, retainersView, tableView, liveRows, matchEmbed, getManager, ensureSquad,
  doBuyClub, doBuyPlayer, getUI, newMatch, advance, matchFrameState, ctxFor, makeAIContext,
  pickAIOpponent, fState, TICKS, matchFrameState };
`);
const FM = require(tmp);
const DATA = require('./fm-data');

// ── minimal wallet + db mock ──────────────────────────────────────────────
const db = {};
const wallet = {};
const getDinar = (d, g, u) => wallet[u] || 0;
const spendDinar = (d, g, u, n) => { if ((wallet[u] || 0) < n) return false; wallet[u] -= n; return true; };
const awardDinar = (d, g, u, n) => { wallet[u] = (wallet[u] || 0) + n; };
const saveData = () => {};
const api = { getDinar, spendDinar, awardDinar, saveData };
const GID = 'g1', U1 = 'user-one', U2 = 'user-two';

let problems = 0;
const fail = (where, msg) => { problems++; console.log(`  ✗ ${where}: ${msg}`); };

function checkComponents(where, rows) {
  const json = rows.map(r => (typeof r.toJSON === 'function' ? r.toJSON() : r));
  if (json.length > 5) fail(where, `${json.length} action rows (max 5)`);
  json.forEach((row, ri) => {
    const comps = row.components || [];
    const selects = comps.filter(c => c.type >= 3 && c.type <= 8);
    if (selects.length && comps.length > 1) fail(where, `row ${ri}: a select must be alone in its row`);
    if (comps.filter(c => c.type === 2).length > 5) fail(where, `row ${ri}: >5 buttons`);
    comps.forEach((c, ci) => {
      const at = `${where} row${ri}.comp${ci}`;
      if (c.custom_id && c.custom_id.length > 100) fail(at, 'custom_id > 100 chars');
      if (c.label && c.label.length > 80) fail(at, `button label ${c.label.length} > 80`);
      if (c.placeholder && c.placeholder.length > 150) fail(at, 'placeholder > 150');
      if (!c.options) return;
      if (c.options.length > 25) fail(at, `${c.options.length} options (max 25)`);
      if (c.options.length === 0) fail(at, 'select with zero options');
      const maxV = c.max_values == null ? 1 : c.max_values;
      const defaults = c.options.filter(o => o.default).length;
      if (defaults > maxV) fail(at, `${defaults} default options but max_values=${maxV}  <-- the Railway error`);
      const values = new Set();
      c.options.forEach((o, oi) => {
        if (!o.label || o.label.length > 100) fail(at, `option ${oi} label length ${o.label ? o.label.length : 0}`);
        if (!o.value || o.value.length > 100) fail(at, `option ${oi} value length`);
        if (o.description && o.description.length > 100) fail(at, `option ${oi} description length ${o.description.length}`);
        if (values.has(o.value)) fail(at, `option ${oi} duplicate value "${o.value}"`);
        values.add(o.value);
      });
    });
  });
}

function checkEmbeds(where, embeds) {
  (embeds || []).forEach((eb, i) => {
    const e = typeof eb.toJSON === 'function' ? eb.toJSON() : eb;
    let total = 0;
    const at = `${where} embed${i}`;
    if (e.title) { total += e.title.length; if (e.title.length > 256) fail(at, 'title > 256'); }
    if (e.description) { total += e.description.length; if (e.description.length > 4096) fail(at, `description ${e.description.length} > 4096`); }
    if (e.footer && e.footer.text) { total += e.footer.text.length; if (e.footer.text.length > 2048) fail(at, 'footer > 2048'); }
    if (e.fields) {
      if (e.fields.length > 25) fail(at, '>25 fields');
      e.fields.forEach((f, fi) => {
        total += (f.name || '').length + (f.value || '').length;
        if (!f.name || f.name.length > 256) fail(at, `field ${fi} name length`);
        if (!f.value || f.value.length > 1024) fail(at, `field ${fi} value length ${f.value ? f.value.length : 0} > 1024`);
      });
    }
    if (total > 6000) fail(at, `total embed text ${total} > 6000`);
  });
}

function screen(name, view) {
  process.stdout.write(`  ${name.padEnd(34)}`);
  const before = problems;
  try {
    checkEmbeds(name, view.embeds);
    checkComponents(name, view.components || []);
  } catch (e) { fail(name, 'threw: ' + e.message); }
  console.log(problems === before ? 'ok' : '');
}

console.log('\n── screens ─────────────────────────────────────────────');
wallet[U1] = 50000; wallet[U2] = 30000;
FM.ensureSquad(FM.getManager(db, GID, U1));

screen('home (no club)',   FM.homeView(db, GID, U1, getDinar));
screen('clubs (Libya)',    FM.clubsView(db, GID, U1, getDinar));
FM.getUI(U1).lg = 'epl';
screen('clubs (Premier League)', FM.clubsView(db, GID, U1, getDinar));

const buy = FM.doBuyClub(db, GID, U1, 'liverpool', api);
if (!buy.ok) fail('doBuyClub', buy.msg);
const buy2 = FM.doBuyClub(db, GID, U2, 'real-madrid', api);
if (!buy2.ok) fail('doBuyClub u2', buy2.msg);

screen('home (with club)', FM.homeView(db, GID, U1, getDinar));
screen('squad',            FM.squadView(db, GID, U1));
screen('market (no club picked)', FM.marketView(db, GID, U1, getDinar));
FM.getUI(U1).mlg = 'epl'; FM.getUI(U1).clubId = 'man-city';
screen('market (Man City squad)', FM.marketView(db, GID, U1, getDinar));
screen('market by position',      FM.posMarketView(db, GID, U1, getDinar, 'FWD'));
screen('tactics',          FM.tacticsView(db, GID, U1));
screen('instructions',     FM.instructionsView(db, GID, U1));
screen('retainers',        FM.retainersView(db, GID, U1, getDinar));
screen('league table',     FM.tableView(db, GID));

// every league, every club, in both market and clubs views
console.log('\n── all 111 clubs through the market view ───────────────');
let widest = 0, widestName = '';
for (const lg of Object.keys(DATA.LEAGUES)) {
  FM.getUI(U1).mlg = lg; FM.getUI(U1).lg = lg;
  checkComponents(`clubs:${lg}`, FM.clubsView(db, GID, U1, getDinar).components);
  checkEmbeds(`clubs:${lg}`, FM.clubsView(db, GID, U1, getDinar).embeds);
  for (const c of DATA.clubsInLeague(lg)) {
    FM.getUI(U1).clubId = c.id;
    const v = FM.marketView(db, GID, U1, getDinar);
    checkComponents(`market:${c.id}`, v.components);
    checkEmbeds(`market:${c.id}`, v.embeds);
    const d = v.embeds[0].toJSON().description.length;
    if (d > widest) { widest = d; widestName = c.name; }
  }
}
console.log(`  longest club listing: ${widestName} (${widest} chars, limit 4096)`);

console.log('\n── transfers ───────────────────────────────────────────');
const r1 = FM.doBuyPlayer(db, GID, U1, 'rodri', api);
console.log(`  buy Haaland:        ${r1.ok ? 'ok' : 'FAILED'} — ${r1.msg.split('\n')[0]}`);
const r2 = FM.doBuyPlayer(db, GID, U1, 'virgil-van-dijk', api);
console.log(`  buy own captain:    ${r2.ok ? 'WRONGLY ALLOWED' : 'correctly blocked'} — ${r2.msg}`);
const r3 = FM.doBuyPlayer(db, GID, U2, 'rodri', api);
console.log(`  buy protected:      ${r3.ok ? 'WRONGLY ALLOWED' : 'correctly blocked'}`);
const r4 = FM.doBuyClub(db, GID, U1, 'arsenal', api);
console.log(`  second club:        ${r4.ok ? 'WRONGLY ALLOWED' : 'correctly blocked'}`);
if (r2.ok || r3.ok || r4.ok) problems++;

console.log('\n── live match: 41 frames, embed + PNG each tick ────────');
const m = FM.newMatch(FM.ctxFor(db, GID, U1), FM.ctxFor(db, GID, U2));
let bytes = 0, slowest = 0;
for (let t = 0; t < FM.TICKS; t++) {
  const r = FM.advance(m);
  m.lastEvent = r.event; m.lastCommentary = r.commentary;
  const t0 = Date.now();
  const png = require('./fm-render').frame(FM.matchFrameState(m));
  slowest = Math.max(slowest, Date.now() - t0);
  bytes += png.length;
  checkEmbeds(`match t${t}`, [FM.matchEmbed(m, true)]);
  checkComponents(`match t${t}`, FM.liveRows());
}
checkEmbeds('match FT', [FM.matchEmbed(m, false)]);
checkComponents('match FT', FM.liveRows(true));
console.log(`  final score ${m.hg}-${m.ag}, ${m.stats.H.shots + m.stats.A.shots} shots`);
console.log(`  render: slowest frame ${slowest}ms, avg PNG ${(bytes/FM.TICKS/1024).toFixed(0)} KB, ${(bytes/1024/1024).toFixed(1)} MB per match`);

console.log(`\n${problems === 0 ? '✅ no Form Body problems found' : `❌ ${problems} problem(s)`}\n`);
fs.unlinkSync(tmp);
process.exit(problems ? 1 : 0);
