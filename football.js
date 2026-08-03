'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   FOOTBALL MANAGER  —  a full club-management game mode for the Libya hub
   ------------------------------------------------------------------------
   • Clubs are one-of-one, across the Libyan league and Europe's big five.
     Buying one gives you its permanent captain (never sellable, stays with
     the club forever, even on resale).
   • Every other squad slot is a FREE placeholder with a Libyan-flavoured
     generated name, until you buy a real player into it.
   • Players are browsed BY CLUB: pick a league, pick a club, pick a player.
     Real players are one-of-one across the whole server. No duplicates.
   • RETAINER: every owned asset holds a prepaid balance. While it has funds,
     nobody can buy it off you. At zero you keep it — it simply becomes
     purchasable by anyone, instantly, with no warning.
   • Matches run for 90 seconds of wall clock and are decided by TACTICS, not
     dice: mentality, pressing, tempo, width, passing directness, the offside
     trap and time-wasting all feed the same maths that produces the result.
     Both managers can change theirs mid-match and see the other's choices.
   ══════════════════════════════════════════════════════════════════════════ */

const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, UserSelectMenuBuilder, PermissionFlagsBits, AttachmentBuilder,
} = require('discord.js');
const path = require('path');
const fs = require('fs');
const { frame } = require('./fm-render');
const DATA = require('./fm-data');

const { LEAGUES, CLUBS, PLAYERS, clubById, playerById, clubsInLeague, leagueList, squadOf } = DATA;

// ─── fonts ────────────────────────────────────────────────────────────────
function findFont(name) {
  for (const dir of [path.join(__dirname, 'fonts'), __dirname]) {
    const p = path.join(dir, name);
    try { if (fs.existsSync(p)) return p; } catch { /* */ }
  }
  return null;
}
const FONT_FILES = ['DejaVuSans.ttf', 'DejaVuSans-Bold.ttf'].map(findFont).filter(Boolean);

// ─── economy scale ────────────────────────────────────────────────────────
// The average member holds ~200 Dinar, so the curve below is tuned so that a
// Libyan club is a realistic first goal, a good European player is weeks of
// saving, and Real Madrid is a genuine long-term chase.
const SQUAD_SIZE   = 11;          // starting XI (subs come later)
const RETAINER_PCT = 0.20;        // starting retainer = 20% of price

const playerPrice  = (rating) => Math.max(10, Math.round(25 * Math.pow(1.15, rating - 60)));
const startRetainer = (price) => Math.max(5, Math.ceil(price * RETAINER_PCT));
// Sub-linear so a 20,000 Dinar club doesn't cost 400/day to hold. Cheap assets
// keep their original ~10-day cover; expensive ones get ~18-20 days.
const dailyDrain   = (price) => Math.max(1, Math.ceil(Math.pow(Math.max(price, 1), 0.85) * 0.045));

const REAL_PLAYERS = PLAYERS;                       // kept for backwards compatibility
const realById = (id) => playerById(id);

// ─── placeholder name generator (Libyan flavoured, shuffled — not real people)
const FIRST = ['Ahmed','Mohamed','Ali','Omar','Khaled','Youssef','Hamza','Tariq','Faisal','Bilal','Nasser','Salem',
  'Idris','Marwan','Anas','Zaid','Rami','Sami','Adel','Karim','Hassan','Hussein','Mustafa','Ibrahim','Yassin','Jamal',
  'Nabil','Walid','Fathi','Sufyan','Munir','Ashraf','Osama','Bashir','Saleh','Tawfik','Ridwan','Ayman','Basem','Ziad'];
const LAST = ['Al-Mabrouk','Al-Sharif','Al-Trabelsi','Ben Ali','Al-Zawi','Al-Misrati','Al-Fitouri','Al-Barghathi',
  'Al-Werfalli','Al-Obeidi','Ben Omar','Al-Sanussi','Al-Ghariani','Al-Darsi','Al-Hasi','Bin Nasser','Al-Tuhami',
  'Al-Shibani','Al-Areibi','Al-Fakhri','Al-Jilani','Al-Rayyani','Al-Mahdi','Al-Ferjani','Al-Khoja','Al-Zintani',
  'Al-Bakoush','Al-Hariri','Al-Suwaidi','Al-Gheryani','Al-Nuwairi','Al-Kabir'];
const pick  = (a) => a[Math.floor(Math.random() * a.length)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const genName = () => `${pick(FIRST)} ${pick(LAST)}`;
const rnd = (a, b) => a + Math.random() * (b - a);
const money = (n) => `${Math.round(n).toLocaleString('en-US')} 🪙`;

// ─── formations ───────────────────────────────────────────────────────────
// slot positions in pitch space (x = depth 0..100 attacking right, y = width)
const FORMATIONS = {
  '4-3-3':   { name:'4-3-3',   slots:[ {p:'GK',x:6,y:50},{p:'DEF',x:22,y:15},{p:'DEF',x:18,y:38},{p:'DEF',x:18,y:62},{p:'DEF',x:22,y:85},{p:'MID',x:40,y:28},{p:'MID',x:35,y:50},{p:'MID',x:40,y:72},{p:'FWD',x:62,y:16},{p:'FWD',x:65,y:50},{p:'FWD',x:62,y:84} ] },
  '4-4-2':   { name:'4-4-2',   slots:[ {p:'GK',x:6,y:50},{p:'DEF',x:22,y:14},{p:'DEF',x:18,y:38},{p:'DEF',x:18,y:62},{p:'DEF',x:22,y:86},{p:'MID',x:42,y:14},{p:'MID',x:37,y:40},{p:'MID',x:37,y:60},{p:'MID',x:42,y:86},{p:'FWD',x:62,y:42},{p:'FWD',x:62,y:58} ] },
  '4-2-3-1': { name:'4-2-3-1', slots:[ {p:'GK',x:6,y:50},{p:'DEF',x:22,y:14},{p:'DEF',x:18,y:38},{p:'DEF',x:18,y:62},{p:'DEF',x:22,y:86},{p:'MID',x:31,y:40},{p:'MID',x:31,y:60},{p:'MID',x:50,y:16},{p:'MID',x:48,y:50},{p:'MID',x:50,y:84},{p:'FWD',x:67,y:50} ] },
  '3-5-2':   { name:'3-5-2',   slots:[ {p:'GK',x:6,y:50},{p:'DEF',x:18,y:30},{p:'DEF',x:15,y:50},{p:'DEF',x:18,y:70},{p:'MID',x:42,y:10},{p:'MID',x:35,y:35},{p:'MID',x:33,y:50},{p:'MID',x:35,y:65},{p:'MID',x:42,y:90},{p:'FWD',x:63,y:42},{p:'FWD',x:63,y:58} ] },
  '5-3-2':   { name:'5-3-2',   slots:[ {p:'GK',x:6,y:50},{p:'DEF',x:26,y:10},{p:'DEF',x:16,y:30},{p:'DEF',x:13,y:50},{p:'DEF',x:16,y:70},{p:'DEF',x:26,y:90},{p:'MID',x:38,y:32},{p:'MID',x:36,y:50},{p:'MID',x:38,y:68},{p:'FWD',x:60,y:42},{p:'FWD',x:60,y:58} ] },
};
const FORMATION_KEYS = Object.keys(FORMATIONS);

/* ══════════════════════════════════════════════════════════════════════════
   TACTICS
   Mentality is the dial everything else hangs off. Instructions are the
   detail. Both feed planOf(), and planOf() is the ONLY thing the match
   engine reads — so every switch a manager flips has a traceable effect.
   ══════════════════════════════════════════════════════════════════════════ */
const MENTALITIES = {
  defensive: { name:'Defensive', emoji:'🛡️', push:-9,  attack:-0.22, defend:+0.20, tempo:-0.15 },
  cautious:  { name:'Cautious',  emoji:'🧱', push:-4,  attack:-0.10, defend:+0.10, tempo:-0.07 },
  balanced:  { name:'Balanced',  emoji:'⚖️', push:0,   attack:0,     defend:0,     tempo:0 },
  positive:  { name:'Positive',  emoji:'📈', push:+5,  attack:+0.11, defend:-0.09, tempo:+0.08 },
  attacking: { name:'Attacking', emoji:'⚔️', push:+10, attack:+0.24, defend:-0.20, tempo:+0.17 },
};
const MENTALITY_KEYS = Object.keys(MENTALITIES);

const INSTRUCTIONS = {
  press: { name:'Pressing', emoji:'🏃', opts:{ low:'Sit Deep', mid:'Balanced', high:'Press High' },
    help:'High press wins the ball back higher, but drains stamina and concedes fouls. Long balls beat it.' },
  tempo: { name:'Tempo', emoji:'⏩', opts:{ slow:'Slow', normal:'Normal', fast:'High Tempo' },
    help:'High tempo creates more of everything — for both sides — and tires your legs.' },
  width: { name:'Width', emoji:'↔️', opts:{ narrow:'Narrow', normal:'Normal', wide:'Wide' },
    help:'Wide beats a narrow defence in the box. Narrow wins the midfield against a wide side.' },
  pass:  { name:'Passing', emoji:'🎯', opts:{ short:'Short', mixed:'Mixed', direct:'Direct' },
    help:'Direct passing bypasses a high press and punishes a high line. Short play dies against a press.' },
};
const TOGGLES = {
  offside:   { name:'Offside Trap',  emoji:'🚩', help:'Kills through balls, but if it is beaten the striker is clean through.' },
  timeWaste: { name:'Time-Wasting', emoji:'🐢', help:'Kills the game when ahead. Wastes your own time when you are not, and risks cards.' },
};
const SHOUTS = {
  encourage: { name:'Encourage',   emoji:'👏', morale:+6,  desc:'lifts a struggling side' },
  praise:    { name:'Praise',      emoji:'🌟', morale:+8,  desc:'rewards a good spell' },
  demand:    { name:'Demand More', emoji:'📢', morale:+4,  desc:'sparks a flat team' },
  calm:      { name:'Calm Down',   emoji:'🧊', morale:+5,  desc:'steadies a nervy lead' },
  berate:    { name:'Berate',      emoji:'🔥', morale:-2,  desc:'high risk, high reward' },
};

const DEFAULT_INSTR = () => ({ press:'mid', tempo:'normal', width:'normal', pass:'mixed', offside:false, timeWaste:false });

/* Turn a manager's settings into the numbers the engine actually uses. */
function planOf(ctx) {
  const men = MENTALITIES[ctx.mentality] || MENTALITIES.balanced;
  const I = Object.assign(DEFAULT_INSTR(), ctx.instr || {});
  const press  = I.press === 'high' ? 1 : I.press === 'low' ? -1 : 0;
  const tempo  = I.tempo === 'fast' ? 1 : I.tempo === 'slow' ? -1 : 0;
  const width  = I.width === 'wide' ? 1 : I.width === 'narrow' ? -1 : 0;
  const direct = I.pass === 'direct' ? 1 : I.pass === 'short' ? -1 : 0;
  return {
    men,
    press:  press + men.push / 14,                              // -1.7 … +1.7
    tempo:  tempo + men.tempo * 3,                              // -1.5 … +1.5
    width, direct,
    line:   clamp(38 + men.push * 1.5 + press * 7 + (I.offside ? 9 : 0), 18, 72),
    offside: !!I.offside,
    waste:   !!I.timeWaste,
  };
}
const styleLine = (ctx) => {
  const I = Object.assign(DEFAULT_INSTR(), ctx.instr || {});
  const bits = [INSTRUCTIONS.press.opts[I.press], INSTRUCTIONS.tempo.opts[I.tempo],
    INSTRUCTIONS.width.opts[I.width], INSTRUCTIONS.pass.opts[I.pass]];
  if (I.offside) bits.push('Offside Trap');
  if (I.timeWaste) bits.push('Time-Wasting');
  return bits.join(' · ');
};

// ─── state ────────────────────────────────────────────────────────────────
function fState(db, gid) {
  const g = (db[gid] ||= {});
  const f = (g.__football ||= {});
  f.managers ||= {};        // uid -> manager
  f.clubOwner ||= {};       // clubId -> uid
  f.playerOwner ||= {};     // realPlayerId -> uid
  f.channelId ||= null;
  f.results ||= [];         // recent match results
  return f;
}
function getManager(db, gid, uid) {
  const f = fState(db, gid);
  const m = (f.managers[uid] ||= {
    clubId: null, squad: [], formation: '4-3-3', mentality: 'balanced',
    instr: DEFAULT_INSTR(), morale: 65, cohesion: 50,
    p:0, w:0, d:0, l:0, gf:0, ga:0, created: Date.now(),
  });
  // migrate older saves that predate the toggles / new instruction keys
  m.instr = Object.assign(DEFAULT_INSTR(), m.instr || {});
  if (!MENTALITIES[m.mentality]) m.mentality = 'balanced';
  if (!FORMATIONS[m.formation]) m.formation = '4-3-3';
  if (typeof m.morale !== 'number') m.morale = 65;
  if (typeof m.cohesion !== 'number') m.cohesion = 50;
  return m;
}
function makePlaceholder(slot, num) {
  return {
    uid: `ph${Date.now().toString(36)}${Math.floor(Math.random()*1e5).toString(36)}`,
    name: genName(), pos: slot.p, rating: 55 + Math.floor(Math.random() * 8),
    real: false, num, retainer: 0, price: 0,
  };
}
function ensureSquad(mgr) {
  const form = FORMATIONS[mgr.formation] || FORMATIONS['4-3-3'];
  if (!Array.isArray(mgr.squad)) mgr.squad = [];
  while (mgr.squad.length < SQUAD_SIZE) {
    const i = mgr.squad.length;
    mgr.squad.push(makePlaceholder(form.slots[i] || { p:'MID' }, i + 1));
  }
  mgr.squad = mgr.squad.slice(0, SQUAD_SIZE);
  return mgr.squad;
}

// ─── retainer maths ───────────────────────────────────────────────────────
// Retainer drains in real time. We store {bal, at} and compute lazily so no
// timers are needed — cheap, and exact regardless of downtime.
function retainerNow(asset) {
  if (!asset || !asset.ret) return 0;
  const { bal, at, price } = asset.ret;
  const days = (Date.now() - at) / 86400000;
  const spent = days * dailyDrain(price || 0);
  return Math.max(0, Math.round((bal - spent) * 100) / 100);
}
function setRetainer(asset, bal, price) {
  asset.ret = { bal: Math.max(0, bal), at: Date.now(), price: price || (asset.ret && asset.ret.price) || 0 };
}
function topUpRetainer(asset, amount) {
  const cur = retainerNow(asset);
  setRetainer(asset, cur + amount, asset.ret ? asset.ret.price : 0);
}
function daysLeft(asset) {
  const bal = retainerNow(asset);
  const price = asset && asset.ret ? asset.ret.price : 0;
  const d = dailyDrain(price);
  return d > 0 ? bal / d : 0;
}
const isProtected = (asset) => retainerNow(asset) > 0;

// ─── squad helpers ────────────────────────────────────────────────────────
const squadRating = (squad) => squad.length ? squad.reduce((s,p)=>s+p.rating,0) / squad.length : 55;
function lineRating(squad, formation, line) {
  const form = FORMATIONS[formation] || FORMATIONS['4-3-3'];
  const vals = [];
  squad.forEach((p, i) => { const s = form.slots[i]; if (s && s.p === line) vals.push(p.rating); });
  return vals.length ? vals.reduce((a,b)=>a+b,0) / vals.length : 55;
}

/* ══════════════════════════════════════════════════════════════════════════
   MATCH ENGINE
   ------------------------------------------------------------------------
   Every number below traces back to planOf(). Nothing here is a coin flip
   dressed up as tactics — the rock-paper-scissors matchups are explicit:

     high press      beaten by  direct passing        (long balls skip it)
     short passing   beaten by  high press            (turnovers in your half)
     high line       beaten by  direct passing        (space in behind)
     offside trap    beaten by  direct passing        (but kills it otherwise)
     narrow          beaten by  wide  (in the box)
     wide            beaten by  narrow (in midfield)
     high press/tempo beaten by the 70th minute       (stamina)
     time-wasting    only works if you are ahead
   ══════════════════════════════════════════════════════════════════════════ */

/* ── PACE ──────────────────────────────────────────────────────────────────
   A tick is a PASSAGE OF PLAY, not a single kick. Fewer, longer beats means
   you can actually read what is happening and get a change in before the
   picture moves on. Each beat resolves 1-3 sequences under the hood, so the
   match still produces a realistic number of shots and goals.
   Want it faster or slower? TICK_MS is the only line you need to touch.     */
const TICKS       = 24;                       // beats in a match
const TICK_MS     = 4500;                     // wall clock per beat
const HT_PAUSE_MS = 14000;                    // team-talk window
const MATCH_MS    = TICKS * TICK_MS + HT_PAUSE_MS;
const HT_TICK     = 12;
const MIN_PER_TICK = 90 / TICKS;
const CHANGES_PER_HALF = 4;
const MAX_SUBS    = 3;
const BENCH_SIZE  = 5;

const UNITS = ['DEF', 'MID', 'FWD'];
const unitOf = (pos) => (pos === 'GK' ? 'DEF' : pos);
const overallStam = (s) => (s.DEF + s.MID + s.FWD) / 3;
const fatOf = (v) => 1 - Math.max(0, 75 - v) * 0.0092;

/* Stamina is tracked PER UNIT, which is what makes substitutions matter:
   a high press burns your midfield, not some abstract team number, and
   bringing on a fresh midfielder measurably fixes that unit.               */
function drainFor(plan, unit) {
  let d = 0.95;
  if (unit === 'MID') d += Math.max(0, plan.press) * 0.55 + Math.max(0, plan.tempo) * 0.45;
  if (unit === 'FWD') d += Math.max(0, plan.press) * 0.45 + Math.max(0, plan.tempo) * 0.30 + (plan.men.push > 0 ? 0.25 : 0);
  if (unit === 'DEF') d += Math.max(0, plan.press) * 0.28 + Math.max(0, plan.line - 45) * 0.032;
  if (plan.waste) d -= 0.25;
  if (plan.men.push < -6) d -= 0.15;
  return Math.max(0.3, d);
}

function sideStrength(ctx, m, side) {
  const sq = ctx.squad, f = ctx.formation;
  const gk  = lineRating(sq, f, 'GK');
  const def = lineRating(sq, f, 'DEF');
  const mid = lineRating(sq, f, 'MID');
  const fwd = lineRating(sq, f, 'FWD');
  const p   = planOf(ctx);
  const S   = m.stam[side];
  const fD = fatOf(S.DEF), fM = fatOf(S.MID), fF = fatOf(S.FWD);
  const mor = 0.86 + (clamp(ctx.morale, 0, 100) / 100) * 0.28;
  const coh = 0.93 + (clamp(ctx.cohesion, 0, 100) / 100) * 0.14;
  const settle = ctx.settle > 0 ? 0.94 : 1;      // just changed shape
  const short  = m.men[side] < 11;
  const under  = m.pressure[side === 'H' ? 'A' : 'H'] / 100;   // pressure against me
  return {
    p, gk,
    att: (fwd * 0.62 * fF + mid * 0.38 * fM) * (1 + p.men.attack) * mor * coh * settle * (short ? 0.86 : 1),
    mid: mid * fM * (1 + p.men.tempo * 0.4 + p.press * 0.03) * mor * coh * settle * (short ? 0.84 : 1),
    def: (def * 0.72 * fD + gk * 0.28) * (1 + p.men.defend) * mor * coh * (short ? 0.91 : 1) * (1 - under * 0.07),
  };
}

// pick a named player from a side for commentary flavour
function whoFrom(ctx, prefer) {
  const form = FORMATIONS[ctx.formation] || FORMATIONS['4-3-3'];
  const pool = ctx.squad.filter((p, i) => form.slots[i] && form.slots[i].p === prefer);
  const list = pool.length ? pool : ctx.squad.filter((p, i) => form.slots[i] && form.slots[i].p !== 'GK');
  return (list.length ? pick(list) : ctx.squad[0] || { name: 'the striker' }).name;
}

const C = {
  build:  ['{T} knock it around at the back.', '{T} building patiently through midfield.', '{P} drops deep to get on the ball.',
           '{T} probing for a way through.', '{P} switches the play across the pitch.', 'Neat triangle from {T} in the middle third.'],
  press:  ['{T} win it back high up the pitch!', 'Turnover — {T} pounce on a loose touch.', '{P} nicks it and {T} surge forward.'],
  turn:   ['Misplaced pass — {T} take over.', '{T} lose it cheaply in midfield.', 'Cleared away, {T} regain possession.',
           'Heavy touch from {P} and it runs away.'],
  long:   ['{T} go long over the press.', '{P} clips it over the top for the runner.', '{T} skip midfield entirely.'],
  wideL:  ['{P} works it down the left.', '{T} overload the left flank.', '{P} gets to the byline on the left!'],
  wideR:  ['{P} takes it down the right.', '{T} switch it right and go again.', '{P} beats his man on the right!'],
  centre: ['{T} come straight through the middle.', '{P} threads it between the lines.'],
  final:  ['{T} into the final third now.', '{P} finds a pocket between the lines.', '{T} are camped in the opposition half.'],
  chance: ['A big chance opens up for {T}!', '{P} finds space in the box!', 'It falls to {P} eight yards out!'],
  goal:   ['GOAL! {P} buries it!', 'GOAL! {P} finishes coolly for {T}!', 'GOAL! A brilliant strike from {P}!',
           'GOAL! {P} makes no mistake!', 'GOAL! {T} break through — {P} with the finish!'],
  save:   ['Saved! A strong hand keeps {P} out.', 'Great stop! {P} denied from close range.', "The keeper holds {P}'s effort."],
  miss:   ['{P} drags it wide.', 'Over the bar from {P}!', '{P} snatches at it — off target.'],
  post:   ['Off the post! {P} is inches away!', "Crashes off the woodwork! {T} can't believe it."],
  block:  ['Blocked! Brave defending from {T}.', 'The shot is charged down.'],
  keep:   ['{T} keep possession, slowing it down.', '{T} recycle it patiently.'],
  waste:  ['{T} are taking their time over everything.', '{P} goes down and stays down. Clock ticking.'],
  counter:['{T} break at speed!', 'Three on two — {T} are away!', '{T} catch them square at the back!'],
  offs:   ['Flag up — {P} is caught offside.', 'The trap works! {P} strays beyond the line.'],
  foul:   ['Cynical from {T}. Free kick.', '{P} clatters through the back of him.'],
  tired:  ['{T} are running on empty here.', 'Legs going for {T} — they cannot get out.'],
  siege:  ['{T} have them pinned in.', 'Wave after wave from {T} now.', '{T} smell blood.'],
};
const say = (arr, T, Pn) => pick(arr).replace(/\{T\}/g, T).replace(/\{P\}/g, Pn || 'the forward');

/* ── bench ─────────────────────────────────────────────────────────────── */
function benchForSquad(squad) {
  const avg = squadRating(squad);
  return ['DEF', 'MID', 'MID', 'FWD', 'FWD'].map(pos => ({
    name: genName(), pos, real: false, used: false,
    rating: clamp(Math.round(avg - 2 - Math.random() * 5), 45, 92),
  }));
}
function benchForClub(club, xi) {
  const inXI = new Set(xi.map(p => p.name));
  const spare = club.squad.filter(p => !inXI.has(p.name))
    .sort((a, b) => b.rating - a.rating).slice(0, BENCH_SIZE)
    .map(p => ({ name: p.name, pos: p.pos, rating: p.rating, real: true, used: false }));
  while (spare.length < BENCH_SIZE) {
    const avg = squadRating(xi);
    spare.push({ name: genName(), pos: pick(['DEF','MID','FWD']), real: false, used: false,
      rating: clamp(Math.round(avg - 4 - Math.random() * 4), 45, 92) });
  }
  return spare;
}

/* A substitution replaces the weakest player in the incoming man's line and
   refreshes that unit's stamina by his share of it. Both effects are real
   and immediately visible in the next tick's numbers.                       */
function makeSub(ctx, m, side, benchIdx) {
  const inP = ctx.bench && ctx.bench[benchIdx];
  if (!inP || inP.used) return { ok: false, msg: 'That player has already come on.' };
  if (ctx.subsUsed >= MAX_SUBS) return { ok: false, msg: `You have used all ${MAX_SUBS} substitutions.` };
  const form = FORMATIONS[ctx.formation] || FORMATIONS['4-3-3'];

  let idx = -1, worst = 1e9;
  ctx.squad.forEach((p, i) => {
    const s = form.slots[i];
    if (!s || s.p !== inP.pos || p.captain) return;
    if (p.rating < worst) { worst = p.rating; idx = i; }
  });
  if (idx === -1) ctx.squad.forEach((p, i) => {
    const s = form.slots[i];
    if (!s || s.p === 'GK' || p.captain) return;
    if (p.rating < worst) { worst = p.rating; idx = i; }
  });
  if (idx === -1) return { ok: false, msg: 'No one available to come off.' };

  const out = ctx.squad[idx];
  const unit = unitOf(form.slots[idx].p);
  const count = form.slots.filter(s => unitOf(s.p) === unit).length || 1;
  const before = m.stam[side][unit];
  m.stam[side][unit] = clamp(before + (100 - before) / count, 5, 100);

  ctx.squad[idx] = {
    uid: `sub-${Date.now().toString(36)}`, name: inP.name, pos: out.pos,
    rating: inP.rating, real: !!inP.real, num: out.num,
  };
  inP.used = true; ctx.subsUsed++;
  ctx.cohesion = clamp(ctx.cohesion - 2, 0, 100);
  ctx.settle = 1;
  m.feed.push(`🔄 **${m.minute}'** ${ctx.club.short}: ${inP.name} on for ${out.name}`);
  return {
    ok: true, out, inP, unit,
    gain: Math.round(m.stam[side][unit] - before),
    ratingDelta: inP.rating - out.rating,
    msg: `🔄 **${inP.name}** (${inP.rating}) on for **${out.name}** (${out.rating}).\n` +
         `${unit} stamina **${Math.round(before)}% → ${Math.round(m.stam[side][unit])}%**` +
         ` · line rating ${inP.rating - out.rating >= 0 ? '+' : ''}${inP.rating - out.rating}` +
         ` · ${MAX_SUBS - ctx.subsUsed} sub${MAX_SUBS - ctx.subsUsed === 1 ? '' : 's'} left`,
  };
}

function newMatch(home, away) {
  for (const c of [home, away]) {
    c.changes = 0; c.settle = 0; c.subsUsed = 0;
    if (!Array.isArray(c.bench)) c.bench = benchForSquad(c.squad);
    c.bench.forEach(b => { b.used = false; });
  }
  return {
    home, away, hg: 0, ag: 0, minute: 0, tick: 0, ticks: TICKS,
    poss: Math.random() < 0.5 ? 'H' : 'A',
    ballX: 50, ballY: 50, trail: [],
    possTicks: { H: 1, A: 1 },
    stam:  { H: { DEF:100, MID:100, FWD:100 }, A: { DEF:100, MID:100, FWD:100 } },
    cards: { H: { y:0, r:0 }, A: { y:0, r:0 } },
    men:   { H: 11, A: 11 },
    pressure: { H: 0, A: 0 },                       // sustained territorial pressure
    flank: { H: { L:0, C:0, R:0 }, A: { L:0, C:0, R:0 } },
    counter: null,
    stats: { H: { shots:0, sot:0, chances:0, fouls:0, offside:0, final:0 },
             A: { shots:0, sot:0, chances:0, fouls:0, offside:0, final:0 } },
    scorers: [], feed: [], ended: false, ballOwner: null, read: '', beat: [],
  };
}

/* ── one sequence of play ───────────────────────────────────────────────── */
function sequence(m) {
  const isH = m.poss === 'H';
  const A = isH ? 'H' : 'A', D = isH ? 'A' : 'H';
  const atk = isH ? m.home : m.away;
  const dfn = isH ? m.away : m.home;
  const sa = sideStrength(atk, m, A), sd = sideStrength(dfn, m, D);
  const pa = sa.p, pd = sd.p;
  const T = atk.club.short, dT = dfn.club.short;
  m.possTicks[m.poss]++;
  const wasCounter = m.counter === m.poss;
  m.counter = null;

  // ── fouls from the defending side (pressing high costs you) ──
  const deepForDef = isH ? m.ballX > 66 : m.ballX < 34;
  if (Math.random() < 0.055 + Math.max(0, pd.press) * 0.035 + (pd.waste ? 0.02 : 0)) {
    m.stats[D].fouls++;
    if (Math.random() < 0.20 + Math.max(0, pd.press) * 0.10 + (pd.waste ? 0.06 : 0)) {
      m.cards[D].y++;
      if (m.cards[D].y >= 3 && !m.cards[D].r && Math.random() < 0.5) {
        m.cards[D].r++; m.men[D] = 10;
        m.feed.push(`🟥 **${m.minute}'** Red card — ${dT} down to ten`);
        return { event: { type:'RED', sub:`${dfn.club.name} · ${m.minute}'` }, commentary: `${dT} are down to ten men!` };
      }
      m.feed.push(`🟨 **${m.minute}'** Booking — ${dT}`);
      if (deepForDef && Math.random() < 0.16) {
        const taker = whoFrom(atk, 'FWD');
        m.stats[A].shots++;
        if (Math.random() < 0.76) {
          if (isH) m.hg++; else m.ag++;
          m.stats[A].sot++;
          m.scorers.push({ side: A, name: taker, minute: m.minute, pen: true });
          m.feed.push(`⚽ **${m.minute}'** ${taker} (${T}) pen. — ${m.hg}-${m.ag}`);
          m.ballX = 50; m.ballY = 50; m.trail = []; m.poss = D; m.ballOwner = null;
          m.pressure[A] = 35; m.pressure[D] = 15;
          return { event: { type:'GOAL', sub:`${taker} · pen · ${m.minute}'` }, commentary: `PENALTY — and ${taker} scores!` };
        }
        m.poss = D;
        return { event: { type:'SAVE', sub:'Penalty saved!' }, commentary: `Penalty saved! ${taker} is denied from the spot.` };
      }
      return { event: { type:'YELLOW', sub:`${dfn.club.name} · ${m.minute}'` }, commentary: say(C.foul, dT, whoFrom(dfn,'MID')) };
    }
  }

  // ── contest the ball ──
  let keep = 0.70 + (sa.mid - sd.mid) / 240;
  keep -= Math.max(0, pd.press) * 0.045;
  if (pa.direct > 0) keep += Math.max(0, pd.press) * 0.062;
  if (pa.direct < 0) keep -= Math.max(0, pd.press) * 0.040;
  keep += (pd.width - pa.width) * 0.014;
  if (pa.width < 0) keep += Math.max(0, pd.press) * 0.030;
  keep += (pa.direct < 0 ? 0.030 : 0) - (pa.direct > 0 ? 0.025 : 0);
  keep += (pa.waste ? 0.05 : 0);
  keep -= Math.max(0, pa.tempo) * 0.015;
  keep = clamp(keep, 0.42, 0.90);

  if (Math.random() > keep) {
    m.poss = D;
    if (pa.line > 48 && pa.men.push > 0) m.counter = D;
    const highPress = Math.max(0, pd.press) > 0.6;
    m.ballY = clamp(m.ballY + rnd(-18, 18), 8, 92);
    m.ballOwner = null;
    return {
      event: m.counter ? { type:'COUNTER' } : null,
      commentary: highPress && Math.random() < 0.6 ? say(C.press, dT, whoFrom(dfn, 'MID')) : say(C.turn, dT, whoFrom(atk, 'MID')),
    };
  }

  // ── carry it forward ──
  let drive = 9 + (sa.att - sd.def) / 6.5 + rnd(-4, 12);
  drive += pa.direct * 5;
  drive += Math.max(0, pd.line - 40) * 0.16;
  drive += pa.tempo * 2;
  drive -= pa.waste ? 5 : 0;
  if (wasCounter) drive += 18;
  m.ballX = clamp(m.ballX + (isH ? drive : -drive), 4, 96);
  m.ballY = clamp(m.ballY + rnd(-14, 14), 8, 92);
  m.trail.push({ x: m.ballX, y: m.ballY });
  if (m.trail.length > 6) m.trail.shift();

  const deep = isH ? m.ballX > 72 : m.ballX < 28;
  const mid3 = isH ? m.ballX > 58 : m.ballX < 42;
  let through = false;

  // which channel is this attack coming down?
  const flankBias = pa.width > 0 ? 0.68 : pa.width < 0 ? 0.30 : 0.48;
  const channel = Math.random() < flankBias ? (m.ballY < 50 ? 'L' : 'R') : 'C';

  if (deep) {
    m.stats[A].final++;
    m.flank[A][channel]++;
    m.pressure[A] = clamp(m.pressure[A] + 8, 0, 100);
  }

  // ── the offside trap ──
  if (deep && pd.offside && Math.random() < 0.40) {
    const beaten = 0.45 + pa.direct * 0.24 + (atk.cohesion - 50) / 320;
    if (Math.random() > beaten) {
      m.stats[A].offside++;
      const who = whoFrom(atk, 'FWD');
      m.feed.push(`🚩 **${m.minute}'** Offside — ${who} (${T})`);
      m.ballX = isH ? 30 : 70; m.ballY = rnd(30, 70); m.trail = [];
      m.poss = D; m.ballOwner = null;
      return { event: { type:'OFFSIDE' }, commentary: say(C.offs, T, who) };
    }
    through = true;
  }

  if (deep) {
    let q = 0.52 + (sa.att - sd.def) / 150;
    if (channel !== 'C' && pd.width < 0) q += 0.11;              // flank play vs a narrow back four
    if (channel === 'C' && pd.width > 0) q += 0.05;              // through the middle of a stretched side
    if (pa.direct < 0 && pd.line < 30) q += 0.09;                // patience unpicks a low block
    if (pa.width > 0 && pd.line < 30) q += 0.08;
    if (wasCounter) q += 0.10;
    q += (m.pressure[A] / 100) * 0.07;                           // sustained pressure tells
    if (pd.line < 28) q -= 0.06;
    q = clamp(q, 0.20, 0.85);

    if (Math.random() < q) {
      m.stats[A].chances++;
      m.pressure[A] = clamp(m.pressure[A] + 10, 0, 100);
      const shooter = whoFrom(atk, Math.random() < 0.7 ? 'FWD' : 'MID');
      m.stats[A].shots++;
      let xg = 0.24 + (sa.att - sd.gk) / 190 + rnd(-0.10, 0.14);
      if (channel !== 'C' && pd.width < 0) xg += 0.08;
      if (pa.direct > 0 && pd.line > 50) xg += 0.06;
      if (pa.direct < 0 && pd.line < 30) xg += 0.05;
      if (pa.width > 0 && pd.line < 30) xg += 0.04;
      if (wasCounter) xg += 0.10;
      if (through) xg += 0.16;
      xg += (m.pressure[A] / 100) * 0.04;
      if (pd.line < 28) xg -= 0.05;
      xg = clamp(xg, 0.06, 0.70);

      const roll = Math.random();
      if (roll < xg) {
        if (isH) m.hg++; else m.ag++;
        m.stats[A].sot++;
        m.scorers.push({ side: A, name: shooter, minute: m.minute });
        m.feed.push(`⚽ **${m.minute}'** ${shooter} (${T}) — ${m.hg}-${m.ag}`);
        m.ballX = 50; m.ballY = 50; m.trail = [];
        m.poss = D; m.ballOwner = null;
        m.pressure[A] = 35; m.pressure[D] = 15;
        dfn.morale = clamp(dfn.morale - 4, 0, 100);
        atk.morale = clamp(atk.morale + 4, 0, 100);
        return { event: { type:'GOAL', sub:`${shooter} · ${m.minute}'` }, commentary: say(C.goal, T, shooter) };
      }
      let event = null, commentary;
      if (roll < xg + 0.30)      { m.stats[A].sot++; event = { type:'SAVE' }; commentary = say(C.save, T, shooter); m.feed.push(`🧤 **${m.minute}'** Save — ${shooter} (${T})`); }
      else if (roll < xg + 0.38) { event = { type:'POST' }; commentary = say(C.post, T, shooter); m.feed.push(`🪵 **${m.minute}'** Woodwork — ${shooter} (${T})`); }
      else if (roll < xg + 0.52) { commentary = say(C.block, T, shooter); }
      else                       { event = { type:'MISS' }; commentary = say(C.miss, T, shooter); }
      m.ballX = isH ? 26 : 74; m.ballY = rnd(30, 70); m.trail = [];
      m.poss = D; m.ballOwner = null;
      return { event, commentary };
    }
    return {
      event: { type:'CHANCE' },
      commentary: m.pressure[A] > 55 ? say(C.siege, T, whoFrom(atk,'FWD')) : say(C.chance, T, whoFrom(atk, 'FWD')),
    };
  }

  let commentary;
  if (wasCounter) commentary = say(C.counter, T, whoFrom(atk, 'FWD'));
  else if (mid3) {
    commentary = pa.direct > 0 && Math.random() < 0.45 ? say(C.long, T, whoFrom(atk, 'DEF'))
      : channel === 'L' ? say(C.wideL, T, whoFrom(atk, 'MID'))
      : channel === 'R' ? say(C.wideR, T, whoFrom(atk, 'MID'))
      : say(C.centre, T, whoFrom(atk, 'MID'));
  }
  else if (pa.waste && Math.random() < 0.5) commentary = say(C.waste, T, whoFrom(atk, 'DEF'));
  else if (overallStam(m.stam[A]) < 45 && Math.random() < 0.35) commentary = say(C.tired, T, whoFrom(atk, 'MID'));
  else commentary = Math.random() < 0.75 ? say(C.build, T, whoFrom(atk, 'MID')) : say(C.keep, T, whoFrom(atk, 'DEF'));

  const form = FORMATIONS[atk.formation] || FORMATIONS['4-3-3'];
  let best = 0, bestD = 1e9;
  form.slots.forEach((s, i) => {
    const px = isH ? s.x : 100 - s.x;
    const d = Math.abs(px - m.ballX) + Math.abs(s.y - m.ballY) * 0.6;
    if (d < bestD) { bestD = d; best = i; }
  });
  m.ballOwner = `${A}${best}`;
  return { event: wasCounter ? { type:'COUNTER' } : null, commentary };
}

/* ── one beat = several sequences, reported as the most significant one ── */
const EVENT_RANK = { GOAL:7, RED:6, SAVE:4, POST:4, OFFSIDE:3, YELLOW:3, CHANCE:2, COUNTER:2 };
function advance(m) {
  m.tick++;
  m.minute = Math.min(90, Math.round(m.tick * MIN_PER_TICK));

  for (const s of ['H', 'A']) {
    const ctx = s === 'H' ? m.home : m.away;
    const p = planOf(ctx);
    for (const u of UNITS) m.stam[s][u] = clamp(m.stam[s][u] - drainFor(p, u), 5, 100);
    if (ctx.settle > 0) ctx.settle--;
    m.pressure[s] = Math.max(0, m.pressure[s] * 0.80);
  }

  const hp = planOf(m.home), ap = planOf(m.away);
  let seq = 2;
  if (Math.max(hp.tempo, ap.tempo) > 0.8 && Math.random() < 0.35) seq++;   // end-to-end spells
  if ((hp.waste || ap.waste) && Math.random() < 0.45) seq--;               // the game gets killed
  seq = Math.max(1, seq);

  let best = null; let goal = false;
  m.beat = [];
  for (let i = 0; i < seq && !goal; i++) {
    const r = sequence(m);
    m.beat.push(r.commentary);
    const score = (r.event && EVENT_RANK[r.event.type]) || 0;
    if (!best || score >= best.score) best = { score, event: r.event, commentary: r.commentary };
    if (r.event && r.event.type === 'GOAL') goal = true;
  }
  m.read = readOut(m);
  return { event: best.event, commentary: best.commentary };
}

/* ── what the manager should be looking at ─────────────────────────────────
   Everything below is diagnosis, generated from the SAME numbers the engine
   just used. If a line appears here, it is because it is actually happening
   in the maths — and the "fix" named is the lever that actually counters it. */
function possPct(m, side) {
  const t = m.possTicks.H + m.possTicks.A;
  return Math.round((m.possTicks[side] / t) * 100);
}

function readOut(m) {
  const hp = planOf(m.home), ap = planOf(m.away);
  const H = m.home.club.short, A = m.away.club.short;
  const obs = [];
  const push = (sev, txt) => obs.push([sev, txt]);
  const pair = (att, def, pAtt, pDef, aT, dT) => {
    if (pDef.press > 0.6 && pAtt.direct > 0) push(0.9, `${aT} are going long to beat the ${dT} press.`);
    if (pDef.press > 0.6 && pAtt.direct < 0) push(0.85, `${dT}'s press is suffocating ${aT}'s short passing.`);
    if (pDef.line > 52 && pAtt.direct > 0)   push(0.8, `${dT}'s high line is leaving space in behind.`);
    if (pAtt.width > 0 && pDef.width < 0)    push(0.6, `${aT} are stretching a narrow ${dT} back four.`);
    if (pAtt.width < 0 && pDef.width > 0)    push(0.55, `${aT} are outnumbering ${dT} through the middle.`);
    if (pDef.offside)                        push(0.45, `${dT} are holding a high line and playing offside.`);
  };
  pair(m.home, m.away, hp, ap, H, A);
  pair(m.away, m.home, ap, hp, A, H);
  if (m.pressure.H > 55) push(1.1, `${H} have ${A} pinned in — sustained pressure building.`);
  if (m.pressure.A > 55) push(1.1, `${A} have ${H} pinned in — sustained pressure building.`);
  if (overallStam(m.stam.H) < 45) push(1.0, `${H} are visibly tiring.`);
  if (overallStam(m.stam.A) < 45) push(1.0, `${A} are visibly tiring.`);
  const hf = m.flank.H, af = m.flank.A;
  const dom = (f, aT, dT) => {
    const tot = f.L + f.C + f.R;
    if (tot < 4) return;
    if (f.L / tot > 0.55) push(0.7, `${aT} are working almost everything down their left.`);
    else if (f.R / tot > 0.55) push(0.7, `${aT} are working almost everything down their right.`);
  };
  dom(hf, H, A); dom(af, A, H);
  if (!obs.length) return m.read;
  obs.sort((a, b) => b[0] - a[0]);
  return obs[0][1];
}

/* Concrete, actionable problems for ONE side, with the counter named. */
function analyse(m, side) {
  const me  = side === 'H' ? m.home : m.away;
  const opp = side === 'H' ? m.away : m.home;
  const pm = planOf(me), po = planOf(opp);
  const S = m.stam[side];
  const gf = side === 'H' ? m.hg : m.ag, ga = side === 'H' ? m.ag : m.hg;
  const poss = possPct(m, side);
  const oppSide = side === 'H' ? 'A' : 'H';
  const late = m.tick > TICKS * 0.6;
  const out = [];
  const add = (sev, text, fix) => out.push({ sev, text, fix });

  if (m.men[side] < 11) add(9, 'You are down to ten men.', 'Go Defensive and Sit Deep — protect what you have.');
  if (S.MID < 45) add(8, `Your midfield is gone (${Math.round(S.MID)}% stamina).`, 'Substitute a midfielder, or drop Pressing and Tempo.');
  else if (S.MID < 60 && pm.press > 0.6) add(6, `Your press is running on ${Math.round(S.MID)}% legs.`, 'Drop Pressing to Balanced before it breaks.');
  if (S.FWD < 45) add(6, `Your forwards are spent (${Math.round(S.FWD)}%).`, 'Bring on a fresh striker.');
  if (m.pressure[oppSide] > 55) add(8, `${opp.club.short} have you pinned in — pressure is building.`, 'Go Cautious, Sit Deep, and take the tempo out of it.');
  if (poss < 38) add(6, `You are losing the midfield battle (${poss}% possession).`, 'Go Narrow to outnumber them centrally, or slow the Tempo.');
  if (po.press > 0.6 && pm.direct < 0) add(7, 'Their press is turning over your short passing.', 'Switch Passing to Direct and go over the top of it.');
  if (pm.line > 52 && po.direct > 0) add(7, 'They are playing balls over your high line.', 'Drop to Cautious, or set Pressing to Sit Deep.');
  if (pm.offside && po.direct > 0) add(6, 'Your offside trap is being beaten by direct balls.', 'Turn the trap off against a direct side.');
  const of = m.flank[oppSide], tot = of.L + of.C + of.R;
  if (tot >= 4 && pm.width < 0) {
    const side2 = of.L / tot > 0.55 ? 'their left' : of.R / tot > 0.55 ? 'their right' : null;
    if (side2) add(5, `${Math.round(Math.max(of.L, of.R) / tot * 100)}% of their attacks are coming down ${side2} — you are too narrow.`, 'Set Width to Wide to cover the flanks.');
  }
  if (late && gf < ga) add(7, `You are ${ga - gf} down with ${90 - m.minute} minutes left.`, 'Go Attacking, High Tempo, and use your substitutions.');
  if (late && gf > ga && !pm.waste) add(4, `You are protecting a ${gf - ga}-goal lead.`, 'Cautious + Time-Wasting kills the game.');
  if (pm.waste && gf <= ga) add(6, 'You are wasting time without a lead — it only helps them.', 'Turn Time-Wasting off.');
  if (me.morale < 40) add(5, `Morale has dropped to ${Math.round(me.morale)}%.`, 'Use Encourage on the touchline.');
  if (!out.length) add(1, 'Nothing is badly wrong — the shape is holding.', 'Look for a weakness you can attack.');
  return out.sort((a, b) => b.sev - a.sev);
}

/* Numeric read-out of what a manager's current settings are actually doing. */
function effectLines(ctx, m, side) {
  const p = planOf(ctx);
  const S = m.stam[side];
  const sg = (n, d = 0) => `${n >= 0 ? '+' : ''}${n.toFixed(d)}`;
  const drain = UNITS.map(u => `${u[0]}${drainFor(p, u).toFixed(1)}`).join(' ');
  return [
    `**Defensive line** ${Math.round(p.line)}%  _(space behind you: ${p.line > 52 ? 'high risk' : p.line < 30 ? 'minimal' : 'moderate'})_`,
    `**Ball recovery** ${sg(p.press * 4.5, 1)}%  ·  **Foul risk** ${sg(Math.max(0, p.press) * 3.5, 1)}%`,
    `**Territory per attack** ${sg(p.direct * 5, 1)}  ·  **Possession** ${sg((p.direct < 0 ? 3 : p.direct > 0 ? -2.5 : 0) - Math.max(0, p.tempo) * 1.5, 1)}%`,
    `**Chance quality vs narrow** ${sg(p.width > 0 ? 11 : 0)}%  ·  **vs wide** ${sg(p.width < 0 ? 8 : 0)}%`,
    `**Stamina burn / beat** ${drain}  _(now D${Math.round(S.DEF)} M${Math.round(S.MID)} F${Math.round(S.FWD)})_`,
    p.offside ? '**Offside trap ON** — line +9%, kills through balls, beaten by direct passing' : '',
    p.waste ? '**Time-wasting ON** — +5% possession, −5 territory, extra card risk' : '',
  ].filter(Boolean);
}

/* team shape for rendering — the unit shifts with the ball and mentality */
function shapeFor(ctx, isHome, m) {
  const form = FORMATIONS[ctx.formation] || FORMATIONS['4-3-3'];
  const p = planOf(ctx);
  const hasBall = (m.poss === 'H') === isHome;
  const relBall = isHome ? m.ballX : 100 - m.ballX;
  const widthMul = p.width > 0 ? 1.12 : p.width < 0 ? 0.86 : 1;
  return form.slots.map((s, i) => {
    let x, y;
    if (s.p === 'GK') {
      x = s.x + (relBall - 50) * 0.06;
      y = 50 + (m.ballY - 50) * 0.16;
    } else {
      const follow = (relBall - 50) * 0.24;
      const push = (hasBall ? 7 : -6) + p.men.push * 0.55 + (p.line - 38) * 0.22;
      x = s.x + follow + push;
      y = 50 + (s.y - 50) * widthMul + (m.ballY - 50) * 0.14;
    }
    x = clamp(x, 3, 96); y = clamp(y, 5, 95);
    return { x: isHome ? x : 100 - x, y, num: ctx.squad[i] ? ctx.squad[i].num : i + 1 };
  });
}

function matchFrameState(m) {
  const total = m.possTicks.H + m.possTicks.A;
  const hp = planOf(m.home), ap = planOf(m.away);
  return {
    home: m.home.club, away: m.away.club,
    hg: m.hg, ag: m.ag, minute: m.minute,
    poss: Math.round((m.possTicks.H / total) * 100),
    ball: { x: m.ballX, y: m.ballY }, trail: m.trail.slice(0, -1),
    ballOwner: m.ballOwner,
    homePos: shapeFor(m.home, true, m),
    awayPos: shapeFor(m.away, false, m),
    commentary: m.lastCommentary || 'Kick off.',
    event: m.lastEvent || null,
    hMent: (MENTALITIES[m.home.mentality] || MENTALITIES.balanced).name,
    aMent: (MENTALITIES[m.away.mentality] || MENTALITIES.balanced).name,
    hStyle: styleLine(m.home), aStyle: styleLine(m.away),
    hUnits: m.stam.H, aUnits: m.stam.A,
    hStam: overallStam(m.stam.H), aStam: overallStam(m.stam.A),
    hPressure: m.pressure.H, aPressure: m.pressure.A,
    hCards: m.cards.H, aCards: m.cards.A,
    hMen: m.men.H, aMen: m.men.A,
    hSubs: m.home.subsUsed || 0, aSubs: m.away.subsUsed || 0,
    showLines: true, hLine: hp.line, aLine: ap.line,
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   LIVE MATCH RUNNER
   Two messages, on purpose:
     1. the PITCH  — the big image, edited every beat
     2. the DUGOUT — a compact panel posted underneath it holding the score,
        what is going wrong, and every control
   The dugout is the newest message in the channel, so it stays where your
   eyes already are. You never have to scroll up to the picture and back
   down to the buttons.
   ══════════════════════════════════════════════════════════════════════════ */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// gid -> { m, seat, done } so interactions (including ephemeral follow-ups,
// which a message collector would never see) can find the running match.
const LIVE = new Map();

function liveRows(disabled = false) {
  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId('fm:live:ment').setPlaceholder('🧠 Mentality…')
        .setDisabled(disabled)
        .addOptions(MENTALITY_KEYS.map(k => ({ label: MENTALITIES[k].name, value: k, emoji: MENTALITIES[k].emoji })))),
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId('fm:live:instr').setPlaceholder('⚙️ Team instruction…')
        .setDisabled(disabled)
        .addOptions(Object.entries(INSTRUCTIONS).flatMap(([k, v]) =>
          Object.entries(v.opts).map(([ok, ol]) => ({ label: `${v.name}: ${ol}`, value: `${k}|${ok}`, emoji: v.emoji }))))),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('fm:live:sub').setLabel('Substitution').setEmoji('🔄')
        .setStyle(ButtonStyle.Primary).setDisabled(disabled),
      new ButtonBuilder().setCustomId('fm:live:tog:offside').setLabel('Offside Trap').setEmoji('🚩')
        .setStyle(ButtonStyle.Secondary).setDisabled(disabled),
      new ButtonBuilder().setCustomId('fm:live:tog:timeWaste').setLabel('Time-Waste').setEmoji('🐢')
        .setStyle(ButtonStyle.Secondary).setDisabled(disabled),
      new ButtonBuilder().setCustomId('fm:live:mine').setLabel('My Numbers').setEmoji('📊')
        .setStyle(ButtonStyle.Secondary).setDisabled(disabled)),
    new ActionRowBuilder().addComponents(
      ...Object.entries(SHOUTS).map(([k, s]) =>
        new ButtonBuilder().setCustomId(`fm:live:shout:${k}`).setLabel(s.name).setEmoji(s.emoji)
          .setStyle(k === 'berate' ? ButtonStyle.Danger : ButtonStyle.Secondary).setDisabled(disabled))),
  ];
}

function applyShout(ctx, key, m, side) {
  const s = SHOUTS[key]; if (!s) return 0;
  const diff = side === 'H' ? m.hg - m.ag : m.ag - m.hg;
  let d = s.morale;
  if (key === 'praise' && diff < 0) d = -4;
  if (key === 'calm'   && diff <= 0) d = 1;
  if (key === 'berate' && diff > 0) d = -6;
  if (key === 'berate' && diff < 0) d = 7;
  if (key === 'demand' && diff > 1) d = 1;
  if (key === 'encourage' && diff < 0) d = 8;
  ctx.morale = clamp(ctx.morale + d, 10, 100);
  return d;
}

/* The AI manages against you: it reads the same analyse() output you do. */
function aiThink(ctx, m, side) {
  if (!ctx.ai) return;
  const diff = side === 'H' ? m.hg - m.ag : m.ag - m.hg;
  const late = m.tick > TICKS * 0.6;
  const S = m.stam[side];
  const opp = side === 'H' ? m.away : m.home;
  const po = planOf(opp);

  if (diff <= -2)       { ctx.mentality = 'attacking'; ctx.instr.press = 'high'; ctx.instr.tempo = 'fast'; }
  else if (diff === -1) { ctx.mentality = late ? 'attacking' : 'positive'; ctx.instr.tempo = 'fast'; }
  else if (diff >= 2 && late) { ctx.mentality = 'cautious'; ctx.instr.press = 'low'; ctx.instr.timeWaste = true; }
  else if (diff === 1 && late){ ctx.mentality = 'cautious'; ctx.instr.timeWaste = true; }
  else                  { ctx.mentality = 'balanced'; ctx.instr.timeWaste = false; }

  // counter what it is being shown
  ctx.instr.pass  = po.press > 0.6 ? 'direct' : po.line < 30 ? 'short' : 'mixed';
  ctx.instr.width = po.press > 0.6 ? 'narrow' : po.line < 30 ? 'wide' : 'normal';
  ctx.instr.offside = po.direct <= 0 && po.men.push > 0;
  if (S.MID < 50) { ctx.instr.press = 'low'; ctx.instr.tempo = 'slow'; }

  // and it makes substitutions when a unit is dead
  if (ctx.subsUsed < MAX_SUBS) {
    const worst = UNITS.slice().sort((a, b) => S[a] - S[b])[0];
    if (S[worst] < 52) {
      const idx = (ctx.bench || []).findIndex(b => !b.used && unitOf(b.pos) === worst);
      if (idx !== -1) makeSub(ctx, m, side, idx);
    }
  }
  ctx.settle = 1;
}

const unitBar = (v) => {
  const n = Math.round(clamp(v, 0, 100) / 20);
  return `${'█'.repeat(n)}${'░'.repeat(5 - n)}`;
};

function sidePanel(ctx, m, side) {
  const men = MENTALITIES[ctx.mentality] || MENTALITIES.balanced;
  const S = m.stam[side], c = m.cards[side];
  const top = analyse(m, side)[0];
  const bits = [
    `${men.emoji} **${men.name}** · ${styleLine(ctx)}`,
    `\`D ${unitBar(S.DEF)} M ${unitBar(S.MID)} F ${unitBar(S.FWD)}\``,
    `Poss **${possPct(m, side)}%** · Shots **${m.stats[side].shots}** · Subs **${ctx.subsUsed || 0}/${MAX_SUBS}**` +
      (c.y ? ` · ${'🟨'.repeat(Math.min(c.y, 3))}` : '') + (c.r ? ' 🟥' : ''),
  ];
  if (m.pressure[side] > 45) bits.push(`🔥 Momentum **${Math.round(m.pressure[side])}%**`);
  if (top) bits.push(`⚠️ ${top.text}\n➜ _${top.fix}_`);
  return bits.join('\n').slice(0, 1020);
}

function dugoutEmbed(m, live = true) {
  const e = new EmbedBuilder()
    .setColor(m.htWindow ? 0xa78bfa : live ? 0x22c55e : 0x64748b)
    .setTitle(`${m.htWindow ? '🗣️ HALF TIME — ' : ''}${m.home.club.short} ${m.hg} – ${m.ag} ${m.away.club.short}  ·  ${m.minute}'`)
    .setDescription(live
      ? (m.htWindow
          ? '**Free changes for the next few seconds.** Read the problems below and fix them.'
          : `${m.lastCommentary || 'Kick off.'}${m.read ? `\n🔍 _${m.read}_` : ''}`)
      : '**Full time.**')
    .addFields(
      { name: `🏠 ${m.home.club.name}`, value: sidePanel(m.home, m, 'H'), inline: false },
      { name: `🛫 ${m.away.club.name}`, value: sidePanel(m.away, m, 'A'), inline: false });
  if (live) e.setFooter({ text: `${CHANGES_PER_HALF} tactical changes per half (free at half time) · ${MAX_SUBS} substitutions · controls below` });
  return e;
}

function matchEmbed(m, live = true) {
  const feed = m.feed.slice(-6).join('\n') || '_No goals yet._';
  const e = new EmbedBuilder()
    .setColor(parseInt((m.hg > m.ag ? m.home.club.c[0] : m.ag > m.hg ? m.away.club.c[0] : '#fbbf24').slice(1), 16))
    .setTitle(`${m.home.club.name}  ${m.hg} – ${m.ag}  ${m.away.club.name}`)
    .setDescription(live ? `⏱️ **${m.minute}'** · ${m.lastCommentary || 'Kick off.'}` : '**Full time.**')
    .setImage('attachment://pitch.png')
    .addFields({ name: 'Match feed', value: feed, inline: false });
  if (!live) {
    const hs = m.stats.H, as = m.stats.A;
    const fl = (f) => `L${f.L}/C${f.C}/R${f.R}`;
    e.addFields(
      { name: `${m.home.club.short}`, value: `Shots **${hs.shots}** (${hs.sot} on target)\nFinal third ${hs.final} · Offside ${hs.offside}\nFouls ${hs.fouls} · Attacks ${fl(m.flank.H)}`, inline: true },
      { name: `${m.away.club.short}`, value: `Shots **${as.shots}** (${as.sot} on target)\nFinal third ${as.final} · Offside ${as.offside}\nFouls ${as.fouls} · Attacks ${fl(m.flank.A)}`, inline: true });
  }
  return e;
}

/* ── the touchline handler, driven from the global router ──────────────── */
async function handleLive(interaction, gid, uid) {
  const live = LIVE.get(gid);
  if (!live) return interaction.reply({ content: 'That match has finished.', flags: 64 }).catch(()=>{});
  const { m, seat } = live;
  const side = seat[uid];
  if (!side) return interaction.reply({ content: 'Only the two managers can work the touchline.', flags: 64 }).catch(()=>{});
  const ctx = side === 'H' ? m.home : m.away;
  const id = interaction.customId;

  if (id === 'fm:live:mine') {
    const e = new EmbedBuilder().setColor(0x38bdf8)
      .setTitle('📊 What your settings are doing right now')
      .setDescription(effectLines(ctx, m, side).join('\n'))
      .addFields({ name: 'Problems', value: analyse(m, side).slice(0, 3)
        .map(p => `⚠️ ${p.text}\n➜ _${p.fix}_`).join('\n').slice(0, 1020) })
      .setFooter({ text: `Changes used this half: ${ctx.changes}/${CHANGES_PER_HALF} · Subs ${ctx.subsUsed}/${MAX_SUBS}` });
    return interaction.reply({ embeds: [e], flags: 64 }).catch(()=>{});
  }

  if (id.startsWith('fm:live:shout:')) {
    const key = id.split(':')[3];
    const d = applyShout(ctx, key, m, side);
    const s = SHOUTS[key];
    return interaction.reply({ content: `${s.emoji} **${s.name}** — morale ${d >= 0 ? '+' : ''}${d} (now ${Math.round(ctx.morale)}).${d < 0 ? ' That did not land well.' : ''}`, flags: 64 }).catch(()=>{});
  }

  if (id === 'fm:live:sub') {
    const avail = (ctx.bench || []).map((b, i) => ({ b, i })).filter(x => !x.b.used);
    if (ctx.subsUsed >= MAX_SUBS)
      return interaction.reply({ content: `You have used all ${MAX_SUBS} substitutions.`, flags: 64 }).catch(()=>{});
    if (!avail.length) return interaction.reply({ content: 'Your bench is empty.', flags: 64 }).catch(()=>{});
    const S = m.stam[side];
    return interaction.reply({
      content: `🔄 **Bench** — a sub refreshes that unit's legs.\nCurrent stamina: **DEF ${Math.round(S.DEF)}% · MID ${Math.round(S.MID)}% · FWD ${Math.round(S.FWD)}%**`,
      flags: 64,
      components: [new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId('fm:live:subdo').setPlaceholder('Bring on…')
          .addOptions(avail.slice(0, 25).map(x => ({
            label: `${x.b.name} (${x.b.pos} ${x.b.rating})`.slice(0, 100),
            value: String(x.i),
            description: `Refreshes the ${unitOf(x.b.pos)} unit`.slice(0, 100),
          }))))],
    }).catch(()=>{});
  }

  if (id === 'fm:live:subdo') {
    const r = makeSub(ctx, m, side, parseInt(interaction.values[0], 10));
    return interaction.update({ content: r.ok ? r.msg : `🚫 ${r.msg}`, components: [] }).catch(()=>{});
  }

  // ── rationed tactical changes ──
  const free = !!m.htWindow;
  if (!free && ctx.changes >= CHANGES_PER_HALF)
    return interaction.reply({ content: `🚫 You have used all **${CHANGES_PER_HALF}** changes this half. Half time is free.`, flags: 64 }).catch(()=>{});

  let note = '';
  if (id === 'fm:live:ment') {
    const v = interaction.values[0];
    if (!MENTALITIES[v]) return interaction.deferUpdate().catch(()=>{});
    const before = planOf(ctx).line;
    ctx.mentality = v;
    const after = planOf(ctx).line;
    note = `${MENTALITIES[v].emoji} Mentality → **${MENTALITIES[v].name}**\nDefensive line **${Math.round(before)}% → ${Math.round(after)}%**`;
  } else if (id === 'fm:live:instr') {
    const [k, v] = String(interaction.values[0]).split('|');
    if (!INSTRUCTIONS[k] || !INSTRUCTIONS[k].opts[v]) return interaction.deferUpdate().catch(()=>{});
    ctx.instr[k] = v;
    note = `${INSTRUCTIONS[k].emoji} ${INSTRUCTIONS[k].name} → **${INSTRUCTIONS[k].opts[v]}**\n_${INSTRUCTIONS[k].help}_`;
  } else if (id.startsWith('fm:live:tog:')) {
    const k = id.split(':')[3];
    if (!TOGGLES[k]) return interaction.deferUpdate().catch(()=>{});
    ctx.instr[k] = !ctx.instr[k];
    note = `${TOGGLES[k].emoji} ${TOGGLES[k].name} → **${ctx.instr[k] ? 'ON' : 'OFF'}**\n_${TOGGLES[k].help}_`;
  } else {
    return interaction.deferUpdate().catch(()=>{});
  }

  if (!free) { ctx.changes++; ctx.settle = 2; }
  const tail = free
    ? '\n_Free at half time._'
    : `\nThe side takes a beat to settle. Changes left this half: **${CHANGES_PER_HALF - ctx.changes}**`;
  return interaction.reply({ content: note + tail, flags: 64 }).catch(()=>{});
}

async function runLiveMatch(channel, m, seatMap, db, gid, saveData) {
  m.lastCommentary = 'Kick off.'; m.lastEvent = { type: 'KICK' };
  let png;
  try { png = frame(matchFrameState(m)); }
  catch (e) { console.error('[fm] render failed:', e.message); return null; }

  let pitchMsg, dugMsg;
  try {
    pitchMsg = await channel.send({
      embeds: [matchEmbed(m)],
      files: [new AttachmentBuilder(png, { name: 'pitch.png' })],
    });
    dugMsg = await channel.send({ embeds: [dugoutEmbed(m)], components: liveRows() });
  } catch (e) { console.error('[fm] could not post match:', e.message); return null; }

  LIVE.set(gid, { m, seat: seatMap });

  const paintPitch = async (live = true) => {
    try {
      const buf = frame(matchFrameState(m));
      await pitchMsg.edit({
        embeds: [matchEmbed(m, live)],
        files: [new AttachmentBuilder(buf, { name: 'pitch.png' })],
        attachments: [],
      });
    } catch { /* a dropped frame is not worth killing the match over */ }
  };
  const paintDug = async (live = true) => {
    try { await dugMsg.edit({ embeds: [dugoutEmbed(m, live)], components: liveRows(!live) }); }
    catch { /* */ }
  };

  try {
    for (let t = 0; t < TICKS && !m.ended; t++) {
      const started = Date.now();
      const { event, commentary } = advance(m);
      m.lastEvent = event; m.lastCommentary = commentary;

      if (m.tick === HT_TICK) {
        m.lastEvent = { type: 'HT' };
        m.lastCommentary = 'Half time.';
        m.htWindow = true;
        m.home.changes = 0; m.away.changes = 0;
        for (const s of ['H', 'A']) for (const u of UNITS) m.stam[s][u] = clamp(m.stam[s][u] + 9, 5, 100);
        aiThink(m.home, m, 'H'); aiThink(m.away, m, 'A');
        await Promise.all([paintPitch(), paintDug()]);
        await sleep(HT_PAUSE_MS);
        m.htWindow = false;
        m.lastEvent = { type: 'TALK' };
        m.lastCommentary = 'Back under way.';
        await Promise.all([paintPitch(), paintDug()]);
        continue;
      }
      if (m.tick % 4 === 0) { aiThink(m.home, m, 'H'); aiThink(m.away, m, 'A'); }

      await Promise.all([paintPitch(), paintDug()]);
      await sleep(Math.max(0, TICK_MS - (Date.now() - started)));
    }
  } finally {
    LIVE.delete(gid);
  }

  m.ended = true; m.minute = 90;
  m.lastEvent = { type: 'FT' };
  m.lastCommentary = m.hg === m.ag ? 'It ends level.' : `${(m.hg > m.ag ? m.home : m.away).club.name} take it.`;
  await Promise.all([paintPitch(false), paintDug(false)]);
  return m;
}

/* ══════════════════════════════════════════════════════════════════════════
   VIEWS
   ══════════════════════════════════════════════════════════════════════════ */
const POS_EMOJI = { GK:'🧤', DEF:'🛡️', MID:'🎯', FWD:'⚡' };

// per-user browsing state for the multi-step dropdowns
const uiState = new Map();
function getUI(uid) {
  let s = uiState.get(uid);
  if (!s) { s = { lg: null, mlg: null, clubId: null, pos: 'FWD' }; uiState.set(uid, s); }
  return s;
}
const leagueOptions = (sel) => leagueList().map(l => ({
  label: l.name, value: l.id, description: `${clubsInLeague(l.id).length} clubs`,
  default: l.id === sel,
}));

function ownerState(f, uid, playerId) {
  const owner = f.playerOwner[playerId];
  if (!owner) return { state: 'free', owner: null };
  if (owner === uid) return { state: 'mine', owner };
  const om = f.managers[owner];
  const held = om && (om.squad || []).find(q => q.playerId === playerId);
  return { state: held && isProtected(held) ? 'locked' : 'buyable', owner };
}
const STATE_ICON = { free:'⚪', mine:'🟢', locked:'🔒', buyable:'🔓' };

function homeView(db, gid, uid, getDinar) {
  const mgr = getManager(db, gid, uid);
  ensureSquad(mgr);
  const club = mgr.clubId ? clubById(mgr.clubId) : null;
  const bal = getDinar(db, gid, uid);
  const rating = squadRating(mgr.squad);
  const realCount = mgr.squad.filter(p => p.real).length;
  const men = MENTALITIES[mgr.mentality] || MENTALITIES.balanced;

  const e = new EmbedBuilder()
    .setColor(club ? parseInt(club.c[0].slice(1), 16) : 0x22c55e)
    .setTitle('⚽ Football Manager')
    .setDescription(club
      ? `**${club.name}** · ${club.city} · _${LEAGUES[club.league].name}_\n${men.emoji} ${men.name} · ${mgr.formation}\n\`${styleLine(mgr)}\``
      : '_You have no club yet. Buy one to get its captain and start your career._')
    .addFields(
      { name: '💰 Your Dinar', value: money(bal), inline: true },
      { name: '⭐ Squad rating', value: `**${rating.toFixed(1)}**`, inline: true },
      { name: '👤 Real players', value: `**${realCount}** / ${SQUAD_SIZE}`, inline: true },
      { name: '📊 Record', value: `**${mgr.w}**W · **${mgr.d}**D · **${mgr.l}**L  (${mgr.p} played)`, inline: true },
      { name: '🔥 Morale', value: `${Math.round(mgr.morale)}%`, inline: true },
      { name: '🤝 Cohesion', value: `${Math.round(mgr.cohesion)}%`, inline: true },
    )
    .setFooter({ text: `${CLUBS.length} clubs across ${leagueList().length} leagues · retainers protect what you own.` });

  const rows = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('fm:squad').setLabel('My Squad').setEmoji('👥').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('fm:market').setLabel('Transfer Market').setEmoji('💸').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('fm:clubs').setLabel('Clubs').setEmoji('🏟️').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('fm:tactics').setLabel('Tactics').setEmoji('🧠').setStyle(ButtonStyle.Secondary)),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('fm:play').setLabel('Play Match').setEmoji('▶️').setStyle(ButtonStyle.Primary).setDisabled(!club),
      new ButtonBuilder().setCustomId('fm:retainers').setLabel('Retainers').setEmoji('🛡️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('fm:table').setLabel('League Table').setEmoji('🏆').setStyle(ButtonStyle.Secondary)),
  ];
  return { embeds: [e], components: rows, files: [], attachments: [] };
}

function squadView(db, gid, uid) {
  const mgr = getManager(db, gid, uid);
  ensureSquad(mgr);
  const form = FORMATIONS[mgr.formation] || FORMATIONS['4-3-3'];
  const club = mgr.clubId ? clubById(mgr.clubId) : null;
  const lines = mgr.squad.map((p, i) => {
    const slot = form.slots[i] || { p: p.pos };
    const cap = p.captain ? ' 👑' : '';
    const prot = p.real && !p.captain ? (isProtected(p) ? `🛡️${Math.ceil(daysLeft(p))}d` : '⚠️ exposed') : '';
    const tag = p.real ? `**${p.rating}**` : `${p.rating}`;
    return `\`${String(p.num).padStart(2)}\` ${POS_EMOJI[slot.p]} ${p.real ? '**' + p.name + '**' : p.name}${cap} · ${tag} ${prot}`;
  });
  const e = new EmbedBuilder().setColor(club ? parseInt(club.c[0].slice(1), 16) : 0x64748b)
    .setTitle(`👥 ${club ? club.name : 'Your Squad'} — ${mgr.formation}`)
    .setDescription(lines.join('\n'))
    .setFooter({ text: 'Bold = real signing · plain = free academy player · 👑 = club captain (never sellable)' });
  return {
    embeds: [e],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('fm:market').setLabel('Sign a player').setEmoji('💸').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('fm:sell').setLabel('Release').setEmoji('📤').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('fm:home').setLabel('Back').setStyle(ButtonStyle.Secondary))],
    files: [], attachments: [],
  };
}

/* ── clubs: league dropdown, then a club dropdown ───────────────────────── */
function clubsView(db, gid, uid, getDinar) {
  const f = fState(db, gid);
  const mgr = getManager(db, gid, uid);
  const st = getUI(uid);
  const myClub = mgr.clubId ? clubById(mgr.clubId) : null;
  const lg = LEAGUES[st.lg] ? st.lg : (myClub ? myClub.league : 'ly');
  st.lg = lg;

  const list = clubsInLeague(lg).slice().sort((a, b) => a.price - b.price);
  const lines = list.map(c => {
    const owner = f.clubOwner[c.id];
    if (owner === uid) return `🟢 **${c.name}** — yours`;
    if (owner) {
      const om = f.managers[owner];
      const prot = om && om.clubAsset && isProtected(om.clubAsset);
      return prot ? `🔒 **${c.name}** — <@${owner}> · protected`
                  : `🔓 **${c.name}** — <@${owner}> · **buyable ${money(c.price)}**`;
    }
    return `⚪ **${c.name}** — ${money(c.price)} · 👑 ${c.cap.name} (${c.cap.rating})`;
  });

  const e = new EmbedBuilder().setColor(0x16a34a)
    .setTitle(`🏟️ ${LEAGUES[lg].name}`)
    .setDescription(lines.join('\n').slice(0, 4000))
    .addFields(
      { name: 'Your Dinar', value: money(getDinar(db, gid, uid)), inline: true },
      { name: 'Rule', value: 'One club each. The captain comes with the club and stays forever.', inline: true });

  const buyable = list.filter(c => f.clubOwner[c.id] !== uid).slice(0, 25);
  const rows = [
    new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('fm:clubs:lg')
      .setPlaceholder('Choose a league…').addOptions(leagueOptions(lg))),
  ];
  if (buyable.length) rows.push(new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('fm:buyclub').setPlaceholder('Buy a club…')
      .addOptions(buyable.map(c => ({
        label: `${c.name} — ${c.price.toLocaleString('en-US')} Dinar`.slice(0, 100), value: c.id,
        description: `${c.city} · captain ${c.cap.name} (${c.cap.rating})`.slice(0, 100),
      })))));
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('fm:home').setLabel('Back').setStyle(ButtonStyle.Secondary)));
  return { embeds: [e], components: rows, files: [], attachments: [] };
}

/* ── market: league → club → player ─────────────────────────────────────── */
function marketView(db, gid, uid, getDinar) {
  const f = fState(db, gid);
  const mgr = getManager(db, gid, uid);
  const st = getUI(uid);
  const myClub = mgr.clubId ? clubById(mgr.clubId) : null;
  const lg = LEAGUES[st.mlg] ? st.mlg : (myClub ? myClub.league : 'epl');
  st.mlg = lg; st.route = 'club';
  let club = st.clubId ? clubById(st.clubId) : null;
  if (club && club.league !== lg) { club = null; st.clubId = null; }

  const e = new EmbedBuilder().setColor(0x0ea5e9)
    .addFields({ name: 'Your Dinar', value: money(getDinar(db, gid, uid)), inline: true },
               { name: 'Key', value: '⚪ free · 🔒 protected · 🔓 buyable now · 🟢 yours', inline: true })
    .setFooter({ text: 'A player with no retainer left can be bought instantly by anyone.' });

  let squad = [];
  if (!club) {
    e.setTitle(`💸 Transfer Market — ${LEAGUES[lg].name}`)
     .setDescription('Pick a club below to see its players.\n\n' +
       clubsInLeague(lg).slice().sort((a,b)=>b.price-a.price)
         .map(c => `• **${c.name}** — ${c.squad.length} players`).join('\n').slice(0, 3500));
  } else {
    squad = squadOf(club.id).map(p => {
      const os = ownerState(f, uid, p.id);
      return { ...p, price: playerPrice(p.rating), ...os };
    });
    e.setTitle(`💸 ${club.name}`)
     .setDescription(
       `👑 Captain **${club.cap.name}** (${club.cap.rating}) — only available by buying the club (${money(club.price)}).\n\n` +
       squad.map(p => `${STATE_ICON[p.state]} ${POS_EMOJI[p.pos]} **${p.name}** \`${p.rating}\` — ${money(p.price)}${p.owner ? ` · <@${p.owner}>` : ''}`)
         .join('\n').slice(0, 3500));
  }

  const rows = [
    new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('fm:mkt:lg')
      .setPlaceholder('1️⃣ League…').addOptions(leagueOptions(lg))),
    new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('fm:mkt:club')
      .setPlaceholder('2️⃣ Club…').addOptions(clubsInLeague(lg).slice(0, 25).map(c => ({
        label: c.name.slice(0, 100), value: c.id,
        description: `${c.squad.length} players · captain ${c.cap.name}`.slice(0, 100),
        default: club ? c.id === club.id : false,
      })))),
  ];
  const buyable = squad.filter(p => p.state === 'free' || p.state === 'buyable').slice(0, 25);
  if (buyable.length) rows.push(new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('fm:buy').setPlaceholder('3️⃣ Sign a player…')
      .addOptions(buyable.map(p => ({
        label: `${p.name} — ${p.price.toLocaleString('en-US')} Dinar`.slice(0, 100), value: p.id,
        description: `${p.pos} · rating ${p.rating}${p.owner ? ' · buying from another manager' : ''}`.slice(0, 100),
      })))));
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('fm:mktpos').setLabel('Browse by position').setEmoji('🔎').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('fm:home').setLabel('Back').setStyle(ButtonStyle.Secondary)));
  return { embeds: [e], components: rows, files: [], attachments: [] };
}

/* ── market: the old position-filtered browse, kept as a second route ───── */
function posMarketView(db, gid, uid, getDinar, pos) {
  const f = fState(db, gid);
  const st = getUI(uid);
  pos = pos || st.pos || 'FWD';
  st.pos = pos; st.route = 'pos';
  const avail = PLAYERS.filter(p => p.pos === pos && !p.captain)
    .map(p => ({ ...p, price: playerPrice(p.rating), ...ownerState(f, uid, p.id) }))
    .sort((a, b) => b.rating - a.rating);

  const show = avail.slice(0, 20).map(p => {
    const c = clubById(p.clubId);
    return `${STATE_ICON[p.state]} **${p.name}** \`${p.rating}\` — ${money(p.price)} · _${c ? c.short : ''}_${p.owner ? ` · <@${p.owner}>` : ''}`;
  });
  const e = new EmbedBuilder().setColor(0x0ea5e9).setTitle(`🔎 Best available — ${POS_EMOJI[pos]} ${pos}`)
    .setDescription(show.join('\n') || '_None._')
    .addFields({ name: 'Your Dinar', value: money(getDinar(db, gid, uid)), inline: true },
               { name: 'Key', value: '⚪ free · 🔒 protected · 🔓 buyable now · 🟢 yours', inline: true });

  const buyable = avail.filter(p => p.state === 'free' || p.state === 'buyable').slice(0, 25);
  const rows = [
    new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('fm:pos')
      .setPlaceholder('Filter position…')
      .addOptions(['GK','DEF','MID','FWD'].map(p => ({ label: p, value: p, emoji: POS_EMOJI[p], default: p === pos })))),
  ];
  if (buyable.length) rows.push(new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('fm:buy').setPlaceholder('Sign a player…')
      .addOptions(buyable.map(p => ({
        label: `${p.name} — ${p.price.toLocaleString('en-US')} Dinar`.slice(0, 100), value: p.id,
        description: `${clubById(p.clubId) ? clubById(p.clubId).short : ''} · rating ${p.rating}`.slice(0, 100),
      })))));
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('fm:market').setLabel('Browse by club').setEmoji('🏟️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('fm:home').setLabel('Back').setStyle(ButtonStyle.Secondary)));
  return { embeds: [e], components: rows, files: [], attachments: [] };
}

/* ── tactics ───────────────────────────────────────────────────────────────
   NOTE: a Discord select with max_values = 1 accepts exactly ONE option
   flagged `default`. The old single "instructions" menu flagged four, which
   is what threw COMPONENT_TOO_MANY_DEFAULT_VALUES and made this button look
   dead. Each dial now gets its own menu on its own screen.                 */
function tacticsView(db, gid, uid) {
  const mgr = getManager(db, gid, uid);
  ensureSquad(mgr);
  const men = MENTALITIES[mgr.mentality] || MENTALITIES.balanced;
  const e = new EmbedBuilder().setColor(0x8b5cf6).setTitle('🧠 Tactics')
    .setDescription(`${men.emoji} **${men.name}** · ${mgr.formation}\n\`${styleLine(mgr)}\``)
    .addFields(
      { name: 'Shape', value: `${lineRating(mgr.squad, mgr.formation,'DEF').toFixed(0)} DEF · ${lineRating(mgr.squad, mgr.formation,'MID').toFixed(0)} MID · ${lineRating(mgr.squad, mgr.formation,'FWD').toFixed(0)} FWD`, inline: true },
      { name: 'Defensive line', value: `${Math.round(planOf(mgr).line)}%`, inline: true },
      { name: 'What mentality does', value:
          'Defensive → Cautious → Balanced → Positive → Attacking raises your line, your press, your tempo and how far you commit forward. Everything else sits on top of it.', inline: false },
    )
    .setFooter({ text: 'You can change all of this again mid-match, and free at half time.' });
  return {
    embeds: [e],
    components: [
      new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('fm:form')
        .setPlaceholder('Formation…')
        .addOptions(FORMATION_KEYS.map(k => ({ label: k, value: k, default: k === mgr.formation })))),
      new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('fm:ment')
        .setPlaceholder('Mentality…')
        .addOptions(MENTALITY_KEYS.map(k => ({
          label: MENTALITIES[k].name, value: k, emoji: MENTALITIES[k].emoji,
          default: k === mgr.mentality })))),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('fm:instrview').setLabel('Team Instructions').setEmoji('⚙️').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('fm:home').setLabel('Back').setStyle(ButtonStyle.Secondary)),
    ], files: [], attachments: [],
  };
}

function instructionsView(db, gid, uid) {
  const mgr = getManager(db, gid, uid);
  const I = mgr.instr;
  const e = new EmbedBuilder().setColor(0x8b5cf6).setTitle('⚙️ Team Instructions')
    .setDescription(`\`${styleLine(mgr)}\``)
    .addFields(Object.entries(INSTRUCTIONS).map(([k, v]) => ({
      name: `${v.emoji} ${v.name}: ${v.opts[I[k]]}`, value: v.help, inline: false })))
    .addFields({ name: `${TOGGLES.offside.emoji} Offside Trap: ${I.offside ? 'ON' : 'OFF'} · ${TOGGLES.timeWaste.emoji} Time-Wasting: ${I.timeWaste ? 'ON' : 'OFF'}`,
      value: `${TOGGLES.offside.help}\n${TOGGLES.timeWaste.help}`, inline: false });

  const rows = Object.entries(INSTRUCTIONS).map(([k, v]) =>
    new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`fm:instr:${k}`)
      .setPlaceholder(`${v.name}…`)
      .addOptions(Object.entries(v.opts).map(([ok, ol]) => ({
        label: `${v.name}: ${ol}`, value: ok, default: I[k] === ok })))));
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('fm:tog:offside').setLabel(`Offside Trap: ${I.offside ? 'ON' : 'OFF'}`)
      .setEmoji('🚩').setStyle(I.offside ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('fm:tog:timeWaste').setLabel(`Time-Wasting: ${I.timeWaste ? 'ON' : 'OFF'}`)
      .setEmoji('🐢').setStyle(I.timeWaste ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('fm:tactics').setLabel('Back').setStyle(ButtonStyle.Secondary)));
  return { embeds: [e], components: rows, files: [], attachments: [] };
}

function retainersView(db, gid, uid, getDinar) {
  const mgr = getManager(db, gid, uid);
  const club = mgr.clubId ? clubById(mgr.clubId) : null;
  const rows = [], lines = [];
  if (club && mgr.clubAsset) {
    const d = daysLeft(mgr.clubAsset);
    lines.push(`🏟️ **${club.name}** — ${retainerNow(mgr.clubAsset).toFixed(0)} left · ${d > 0 ? `**${d.toFixed(1)} days**` : '**EXPOSED**'}`);
  }
  for (const p of (mgr.squad || []).filter(x => x.real && !x.captain)) {
    const d = daysLeft(p);
    lines.push(`${POS_EMOJI[p.pos]} **${p.name}** — ${retainerNow(p).toFixed(0)} left · ${d > 0 ? `${d.toFixed(1)}d` : '**EXPOSED**'}`);
  }
  const e = new EmbedBuilder().setColor(0xf59e0b).setTitle('🛡️ Retainers')
    .setDescription(lines.length ? lines.join('\n') : '_Nothing to protect yet._')
    .addFields({ name: 'How it works', value:
      'A funded retainer makes an asset **unbuyable**. At zero you keep it — but anyone can buy it from you instantly, with no warning. Top up before a break.' })
    .setFooter({ text: `Your Dinar: ${Math.round(getDinar(db, gid, uid))}` });
  const opts = [];
  if (club && mgr.clubAsset) opts.push({ label: `${club.name} (club)`.slice(0, 100), value: 'club' });
  (mgr.squad || []).filter(x => x.real && !x.captain).slice(0, 24)
    .forEach(p => opts.push({ label: p.name.slice(0, 100), value: `p|${p.uid}` }));
  if (opts.length) rows.push(new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('fm:topup').setPlaceholder('Top up an asset (+50 Dinar)…').addOptions(opts)));
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('fm:home').setLabel('Back').setStyle(ButtonStyle.Secondary)));
  return { embeds: [e], components: rows, files: [], attachments: [] };
}

function tableView(db, gid) {
  const f = fState(db, gid);
  const rows = Object.entries(f.managers)
    .filter(([, m]) => m.clubId)
    .map(([uid, m]) => ({ uid, m, pts: m.w * 3 + m.d, gd: m.gf - m.ga }))
    .sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.m.gf - a.m.gf);
  const lines = rows.slice(0, 20).map((r, i) => {
    const c = clubById(r.m.clubId);
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `\`${String(i + 1).padStart(2)}\``;
    return `${medal} **${c ? c.short : '???'}** <@${r.uid}> — **${r.pts}** pts · ${r.m.w}-${r.m.d}-${r.m.l} · GD ${r.gd >= 0 ? '+' : ''}${r.gd}`;
  });
  const recent = (f.results || []).slice(0, 5).map(r => `${r.h} ${r.hg}–${r.ag} ${r.a}`).join(' · ');
  const e = new EmbedBuilder().setColor(0xfbbf24).setTitle('🏆 League Table')
    .setDescription(lines.join('\n') || '_No managers with clubs yet._')
    .setFooter({ text: 'Win 3 pts · Draw 1 pt' });
  if (recent) e.addFields({ name: 'Recent results', value: recent });
  return { embeds: [e], components: [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('fm:home').setLabel('Back').setStyle(ButtonStyle.Secondary))], files: [], attachments: [] };
}

/* ══════════════════════════════════════════════════════════════════════════
   TRANSFERS  —  buying from the pool, or buying an exposed asset off a rival
   (a buyout pays the previous owner, so Dinar circulates instead of vanishing)
   ══════════════════════════════════════════════════════════════════════════ */
function slotFor(mgr, pos) {
  const form = FORMATIONS[mgr.formation] || FORMATIONS['4-3-3'];
  let idx = mgr.squad.findIndex((p, i) => !p.real && !p.captain && form.slots[i] && form.slots[i].p === pos);
  if (idx === -1) idx = mgr.squad.findIndex(p => !p.real && !p.captain);
  if (idx === -1) {
    let worst = -1, wr = 1e9;
    mgr.squad.forEach((p, i) => { if (!p.captain && p.rating < wr) { wr = p.rating; worst = i; } });
    idx = worst;
  }
  return idx < 0 ? 0 : idx;
}

/* Take a player off whoever currently holds him, leaving a placeholder. */
function stripPlayerFrom(f, ownerUid, playerId) {
  const om = f.managers[ownerUid];
  if (!om || !Array.isArray(om.squad)) return;
  const i = om.squad.findIndex(q => q.playerId === playerId);
  if (i === -1) return;
  const form = FORMATIONS[om.formation] || FORMATIONS['4-3-3'];
  om.squad[i] = makePlaceholder(form.slots[i] || { p: om.squad[i].pos || 'MID' }, om.squad[i].num);
}

function doBuyPlayer(db, gid, uid, playerId, api) {
  const f = fState(db, gid);
  const rp = playerById(playerId);
  if (!rp) return { ok: false, msg: 'That player does not exist.' };
  if (rp.captain) {
    const c = clubById(rp.clubId);
    return { ok: false, msg: `**${rp.name}** is ${c ? c.name : 'his club'}'s captain — he only moves if you buy the club itself (${money(c ? c.price : 0)}).` };
  }
  const mgr = getManager(db, gid, uid); ensureSquad(mgr);
  if (mgr.squad.some(p => p.playerId === playerId)) return { ok: false, msg: 'You already have him.' };

  const price = playerPrice(rp.rating);
  const owner = f.playerOwner[playerId];
  if (owner === uid) return { ok: false, msg: 'You already own him.' };
  if (owner) {
    const om = f.managers[owner];
    const held = om && (om.squad || []).find(q => q.playerId === playerId);
    if (held && isProtected(held)) return { ok: false, msg: `**${rp.name}** is protected by a retainer — you cannot buy him right now.` };
  }
  if (api.getDinar(db, gid, uid) < price)
    return { ok: false, msg: `You need ${money(price)} — you have ${money(api.getDinar(db, gid, uid))}.` };
  if (!api.spendDinar(db, gid, uid, price, api.saveData)) return { ok: false, msg: 'Payment failed.' };

  if (owner && f.managers[owner]) {
    stripPlayerFrom(f, owner, playerId);
    api.awardDinar(db, gid, owner, price, api.saveData, 'football-sale');
  }

  const idx = slotFor(mgr, rp.pos);
  const num = mgr.squad[idx] ? mgr.squad[idx].num : idx + 1;
  const asset = {
    uid: `rp${Date.now().toString(36)}${Math.floor(Math.random()*1e4).toString(36)}`,
    name: rp.name, pos: rp.pos, rating: rp.rating, real: true, playerId, num, price,
  };
  setRetainer(asset, startRetainer(price), price);
  mgr.squad[idx] = asset;
  f.playerOwner[playerId] = uid;
  mgr.cohesion = clamp(mgr.cohesion - 4, 0, 100);   // a new face unsettles the side
  api.saveData(gid);
  const club = clubById(rp.clubId);
  return { ok: true, price, msg:
    `✅ Signed **${rp.name}** (${rp.pos} ${rp.rating})${club ? ` from **${club.name}**` : ''} for ${money(price)}.` +
    `${owner ? ` Bought out from <@${owner}>.` : ''}\n🛡️ Retainer started: **${startRetainer(price)}** (~${(startRetainer(price)/dailyDrain(price)).toFixed(0)} days).` };
}

function doBuyClub(db, gid, uid, clubId, api) {
  const f = fState(db, gid);
  const club = clubById(clubId);
  if (!club) return { ok: false, msg: 'Unknown club.' };
  const mgr = getManager(db, gid, uid); ensureSquad(mgr);
  if (mgr.clubId === clubId) return { ok: false, msg: 'That is already your club.' };
  if (mgr.clubId) return { ok: false, msg: 'You already manage a club. One club each — you would have to be bought out first.' };

  const owner = f.clubOwner[clubId];
  if (owner) {
    const om = f.managers[owner];
    if (om && om.clubAsset && isProtected(om.clubAsset))
      return { ok: false, msg: `**${club.name}** is protected by a retainer.` };
  }
  if (api.getDinar(db, gid, uid) < club.price)
    return { ok: false, msg: `You need ${money(club.price)} — you have ${money(api.getDinar(db, gid, uid))}.` };
  if (!api.spendDinar(db, gid, uid, club.price, api.saveData)) return { ok: false, msg: 'Payment failed.' };

  const capId = club.captainId;
  if (owner && f.managers[owner]) {
    const om = f.managers[owner];
    om.clubId = null; om.clubAsset = null;
    const ci = (om.squad || []).findIndex(p => p.captain);
    if (ci !== -1) {
      const form = FORMATIONS[om.formation] || FORMATIONS['4-3-3'];
      om.squad[ci] = makePlaceholder(form.slots[ci] || { p: 'MID' }, om.squad[ci].num);
    }
    api.awardDinar(db, gid, owner, club.price, api.saveData, 'football-clubsale');
  }
  // if anyone somehow holds the captain as a normal signing, he goes with the club
  if (capId && f.playerOwner[capId] && f.playerOwner[capId] !== uid) {
    stripPlayerFrom(f, f.playerOwner[capId], capId);
  }

  mgr.clubId = clubId;
  f.clubOwner[clubId] = uid;
  mgr.clubAsset = {};
  setRetainer(mgr.clubAsset, startRetainer(club.price), club.price);

  const cap = {
    uid: `cap-${clubId}`, name: club.cap.name, pos: club.cap.pos, rating: club.cap.rating,
    real: true, captain: true, playerId: capId, num: 10, price: 0,
  };
  const idx = slotFor(mgr, cap.pos);
  cap.num = mgr.squad[idx] ? mgr.squad[idx].num : idx + 1;
  mgr.squad[idx] = cap;
  if (capId) f.playerOwner[capId] = uid;
  api.saveData(gid);
  return { ok: true, msg:
    `🏟️ You are now the manager of **${club.name}** (${LEAGUES[club.league].name})!\n` +
    `👑 Club captain **${cap.name}** (${cap.rating}) joins permanently — he can never be sold.\n` +
    `🛡️ Retainer started: **${startRetainer(club.price)}** (~${(startRetainer(club.price)/dailyDrain(club.price)).toFixed(0)} days).` };
}

/* ── contexts ──────────────────────────────────────────────────────────── */
function bestXI(club, formation) {
  const form = FORMATIONS[formation] || FORMATIONS['4-3-3'];
  const pool = club.squad.slice().sort((a, b) => b.rating - a.rating);
  const used = new Set();
  return form.slots.map((s, i) => {
    let p = pool.find(q => !used.has(q.id) && q.pos === s.p) || pool.find(q => !used.has(q.id));
    if (p) used.add(p.id);
    return p
      ? { uid: `ai-${p.id}`, name: p.name, pos: p.pos, rating: p.rating, real: true, num: i + 1, captain: !!p.captain }
      : { uid: `ai${i}`, name: genName(), pos: s.p, rating: 58, real: false, num: i + 1 };
  });
}

/* AI opponent — a real club with its real squad, roughly matched on value. */
function pickAIOpponent(f, myClub) {
  const free = CLUBS.filter(c => !f.clubOwner[c.id] && (!myClub || c.id !== myClub.id));
  const pool = free.length ? free : CLUBS.filter(c => !myClub || c.id !== myClub.id);
  if (!myClub) return pick(pool);
  const near = pool.filter(c => c.price >= myClub.price * 0.55 && c.price <= myClub.price * 1.7);
  return pick(near.length ? near : pool);
}
function makeAIContext(club) {
  const formation = pick(FORMATION_KEYS);
  const squad = bestXI(club, formation);
  return {
    club, squad, formation,
    mentality: 'balanced', instr: DEFAULT_INSTR(),
    morale: 65, cohesion: 60, ai: true, changes: 0, settle: 0,
    subsUsed: 0, bench: benchForClub(club, squad),
  };
}
function ctxFor(db, gid, uid) {
  const mgr = getManager(db, gid, uid); ensureSquad(mgr);
  // instructions are COPIED: mid-match tinkering does not rewrite the plan
  // the manager saved on the Tactics screen.
  return {
    club: clubById(mgr.clubId), squad: mgr.squad, formation: mgr.formation,
    mentality: mgr.mentality, instr: Object.assign({}, mgr.instr),
    morale: mgr.morale, cohesion: mgr.cohesion, uid, changes: 0, settle: 0,
    subsUsed: 0, bench: benchForSquad(mgr.squad),
  };
}
function recordResult(db, gid, m, api) {
  const f = fState(db, gid);
  const apply = (ctx, gf, ga) => {
    if (!ctx.uid) return;
    const mgr = f.managers[ctx.uid]; if (!mgr) return;
    mgr.p++; mgr.gf += gf; mgr.ga += ga;
    if (gf > ga) { mgr.w++; mgr.morale = clamp(mgr.morale + 7, 0, 100); }
    else if (gf === ga) { mgr.d++; mgr.morale = clamp(mgr.morale + 1, 0, 100); }
    else { mgr.l++; mgr.morale = clamp(mgr.morale - 6, 0, 100); }
    mgr.cohesion = clamp(mgr.cohesion + 3, 0, 100);   // playing together builds understanding
  };
  apply(m.home, m.hg, m.ag);
  apply(m.away, m.ag, m.hg);
  f.results.unshift({ h: m.home.club.short, a: m.away.club.short, hg: m.hg, ag: m.ag, at: Date.now() });
  f.results = f.results.slice(0, 25);
  api.saveData(gid);
}

/* ══════════════════════════════════════════════════════════════════════════
   COMMANDS + INIT
   ══════════════════════════════════════════════════════════════════════════ */
function getFootballCommands() {
  return [
    new SlashCommandBuilder().setName('football')
      .setDescription('Open the Football Manager hub — build a club, sign players, play matches').toJSON(),
    new SlashCommandBuilder().setName('football-channel')
      .setDescription('Set this channel as the Football Manager channel (admin)')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator).toJSON(),
  ];
}

const CHALLENGE_MS = 120000;
const openChallenges = new Map();    // challenge message id -> { from, to, gid, at }

function initFootball({ client, db, saveData, getDinar, spendDinar, awardDinar }) {
  const api = { getDinar, spendDinar, awardDinar, saveData };
  const liveMatches = new Set();      // guild ids with a match running

  const wrongChannel = (interaction) => {
    const f = fState(db, interaction.guildId);
    if (f.channelId && interaction.channelId !== f.channelId)
      return `⚽ Football Manager lives in <#${f.channelId}> — head over there.`;
    return null;
  };

  async function startMatch(channel, gid, home, away, seat) {
    liveMatches.add(gid);
    const m = newMatch(home, away);
    try {
      await runLiveMatch(channel, m, seat, db, gid, saveData);
      recordResult(db, gid, m, api);
      await channel.send({ content: `🏁 **${m.home.club.name} ${m.hg} – ${m.ag} ${m.away.club.name}**` }).catch(()=>{});
    } catch (e) {
      console.error('[fm] match failed:', e.message, (e.stack || '').split('\n')[1]);
    } finally { liveMatches.delete(gid); }
  }

  client.on('interactionCreate', async (interaction) => {
    try {
      if (!interaction.guildId) return;
      const gid = interaction.guildId, uid = interaction.user.id;

      // ── commands ──
      if (interaction.isChatInputCommand() && interaction.commandName === 'football-channel') {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator))
          return interaction.reply({ content: '❌ Admins only.', flags: 64 });
        const f = fState(db, gid); f.channelId = interaction.channelId; saveData(gid);
        return interaction.reply({ content: `⚽ Football Manager is now based in <#${interaction.channelId}>.` });
      }
      if (interaction.isChatInputCommand() && interaction.commandName === 'football') {
        const w = wrongChannel(interaction);
        if (w) return interaction.reply({ content: w, flags: 64 });
        return interaction.reply(Object.assign(homeView(db, gid, uid, getDinar), { flags: 64 }));
      }

      const id = interaction.customId || '';
      if (!id.startsWith('fm:')) return;
      if (id.startsWith('fm:live:')) return handleLive(interaction, gid, uid);

      const w = wrongChannel(interaction);
      if (w) return interaction.reply({ content: w, flags: 64 });
      const st = getUI(uid);

      // ── navigation ──
      const nav = {
        'fm:home':      () => homeView(db, gid, uid, getDinar),
        'fm:squad':     () => squadView(db, gid, uid),
        'fm:clubs':     () => clubsView(db, gid, uid, getDinar),
        'fm:market':    () => marketView(db, gid, uid, getDinar),
        'fm:mktpos':    () => posMarketView(db, gid, uid, getDinar, st.pos),
        'fm:tactics':   () => tacticsView(db, gid, uid),
        'fm:instrview': () => instructionsView(db, gid, uid),
        'fm:retainers': () => retainersView(db, gid, uid, getDinar),
        'fm:table':     () => tableView(db, gid),
      };
      if (interaction.isButton() && nav[id]) return interaction.update(nav[id]());

      // ── clubs ──
      if (interaction.isStringSelectMenu() && id === 'fm:clubs:lg') {
        st.lg = interaction.values[0];
        return interaction.update(clubsView(db, gid, uid, getDinar));
      }
      if (interaction.isStringSelectMenu() && id === 'fm:buyclub') {
        const r = doBuyClub(db, gid, uid, interaction.values[0], api);
        await interaction.update(clubsView(db, gid, uid, getDinar));
        return interaction.followUp({ content: r.msg, flags: 64 });
      }

      // ── market: league → club → player ──
      if (interaction.isStringSelectMenu() && id === 'fm:mkt:lg') {
        st.mlg = interaction.values[0]; st.clubId = null;
        return interaction.update(marketView(db, gid, uid, getDinar));
      }
      if (interaction.isStringSelectMenu() && id === 'fm:mkt:club') {
        st.clubId = interaction.values[0];
        return interaction.update(marketView(db, gid, uid, getDinar));
      }
      if (interaction.isStringSelectMenu() && id === 'fm:pos') {
        st.pos = interaction.values[0]; st.route = 'pos';
        return interaction.update(posMarketView(db, gid, uid, getDinar, st.pos));
      }
      if (interaction.isStringSelectMenu() && id === 'fm:buy') {
        const r = doBuyPlayer(db, gid, uid, interaction.values[0], api);
        const back = st.route === 'pos'
          ? posMarketView(db, gid, uid, getDinar, st.pos)
          : marketView(db, gid, uid, getDinar);
        await interaction.update(back);
        return interaction.followUp({ content: r.msg, flags: 64 });
      }

      // ── tactics ──
      if (interaction.isStringSelectMenu() && id === 'fm:form') {
        const mgr = getManager(db, gid, uid); mgr.formation = interaction.values[0];
        mgr.cohesion = clamp(mgr.cohesion - 3, 0, 100); saveData(gid);
        return interaction.update(tacticsView(db, gid, uid));
      }
      if (interaction.isStringSelectMenu() && id === 'fm:ment') {
        const mgr = getManager(db, gid, uid);
        if (MENTALITIES[interaction.values[0]]) mgr.mentality = interaction.values[0];
        saveData(gid);
        return interaction.update(tacticsView(db, gid, uid));
      }
      if (interaction.isStringSelectMenu() && id.startsWith('fm:instr:')) {
        const k = id.split(':')[2], v = interaction.values[0];
        const mgr = getManager(db, gid, uid);
        if (INSTRUCTIONS[k] && INSTRUCTIONS[k].opts[v]) { mgr.instr[k] = v; saveData(gid); }
        return interaction.update(instructionsView(db, gid, uid));
      }
      if (interaction.isButton() && id.startsWith('fm:tog:')) {
        const k = id.split(':')[2];
        const mgr = getManager(db, gid, uid);
        if (TOGGLES[k]) { mgr.instr[k] = !mgr.instr[k]; saveData(gid); }
        return interaction.update(instructionsView(db, gid, uid));
      }

      // ── retainer top-up ──
      if (interaction.isStringSelectMenu() && id === 'fm:topup') {
        const AMOUNT = 50;
        const mgr = getManager(db, gid, uid);
        if (getDinar(db, gid, uid) < AMOUNT)
          return interaction.reply({ content: `You need ${money(AMOUNT)}.`, flags: 64 });
        const v = interaction.values[0];
        const target = v === 'club' ? mgr.clubAsset : mgr.squad.find(p => p.uid === v.split('|')[1]);
        if (!target) return interaction.reply({ content: 'Not found.', flags: 64 });
        if (!spendDinar(db, gid, uid, AMOUNT, saveData))
          return interaction.reply({ content: 'Payment failed.', flags: 64 });
        topUpRetainer(target, AMOUNT); saveData(gid);
        await interaction.update(retainersView(db, gid, uid, getDinar));
        return interaction.followUp({ content: `🛡️ Added **${AMOUNT}** to the retainer — now ~**${daysLeft(target).toFixed(1)} days** of cover.`, flags: 64 });
      }

      // ── release a player ──
      if (interaction.isButton() && id === 'fm:sell') {
        const mgr = getManager(db, gid, uid);
        const sellable = mgr.squad.filter(p => p.real && !p.captain);
        if (!sellable.length) return interaction.reply({ content: 'You have no sellable players (captains stay with the club).', flags: 64 });
        return interaction.reply({ content: 'Release a player for **half** his value:', flags: 64,
          components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('fm:selldo')
            .setPlaceholder('Release…').addOptions(sellable.slice(0,25).map(p =>
              ({ label: `${p.name} — +${Math.floor((p.price||0)/2)} Dinar`.slice(0,100), value: p.uid, description: `Rating ${p.rating}` }))))] });
      }
      if (interaction.isStringSelectMenu() && id === 'fm:selldo') {
        const f = fState(db, gid), mgr = getManager(db, gid, uid);
        const i = mgr.squad.findIndex(p => p.uid === interaction.values[0]);
        if (i === -1) return interaction.update({ content: 'Not found.', components: [] });
        const p = mgr.squad[i];
        const back = Math.floor((p.price || 0) / 2);
        if (p.playerId) delete f.playerOwner[p.playerId];
        const form = FORMATIONS[mgr.formation] || FORMATIONS['4-3-3'];
        mgr.squad[i] = makePlaceholder(form.slots[i] || { p: p.pos }, p.num);
        awardDinar(db, gid, uid, back, saveData, 'football-release');
        saveData(gid);
        return interaction.update({ content: `📤 Released **${p.name}** for ${money(back)}.`, components: [] });
      }

      // ── play a match ──
      if (interaction.isButton() && id === 'fm:play') {
        const mgr = getManager(db, gid, uid);
        if (!mgr.clubId) return interaction.reply({ content: 'Buy a club first.', flags: 64 });
        if (liveMatches.has(gid)) return interaction.reply({ content: '⏳ A match is already being played in this server — wait for it to finish.', flags: 64 });
        return interaction.reply({
          content: '▶️ **Choose your opponent**\nPlay the computer, or tag a manager to challenge them in this channel.',
          flags: 64,
          components: [
            new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId('fm:quick').setLabel('Quick Match (vs AI club)').setEmoji('🤖').setStyle(ButtonStyle.Success)),
            new ActionRowBuilder().addComponents(
              new UserSelectMenuBuilder().setCustomId('fm:chal:pick').setPlaceholder('⚔️ Tag a manager to challenge…').setMaxValues(1)),
            new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId('fm:home').setLabel('Back').setStyle(ButtonStyle.Secondary)),
          ],
        });
      }

      if (interaction.isButton() && id === 'fm:quick') {
        const mgr = getManager(db, gid, uid);
        if (!mgr.clubId) return interaction.reply({ content: 'Buy a club first.', flags: 64 });
        if (liveMatches.has(gid)) return interaction.reply({ content: '⏳ A match is already running.', flags: 64 });
        const f = fState(db, gid);
        const home = ctxFor(db, gid, uid);
        const away = makeAIContext(pickAIOpponent(f, home.club));
        await interaction.update({ content: '⚽ Kicking off in the channel…', components: [] }).catch(()=>{});
        return startMatch(interaction.channel, gid, home, away, { [uid]: 'H' });
      }

      // ── challenge another manager ──
      if (interaction.isUserSelectMenu() && id === 'fm:chal:pick') {
        const target = interaction.values[0];
        const picked = interaction.users ? interaction.users.first() : null;
        const mgr = getManager(db, gid, uid);
        if (!mgr.clubId) return interaction.reply({ content: 'Buy a club first.', flags: 64 });
        if (liveMatches.has(gid)) return interaction.reply({ content: '⏳ A match is already running.', flags: 64 });
        if (target === uid) return interaction.reply({ content: 'You cannot challenge yourself.', flags: 64 });
        if (picked && picked.bot) return interaction.reply({ content: 'That is a bot. Use Quick Match for a computer opponent.', flags: 64 });

        const f = fState(db, gid);
        const om = f.managers[target];
        if (!om || !om.clubId)
          return interaction.reply({ content: `<@${target}> does not manage a club yet — nothing to play for.`, flags: 64 });

        const myClub = clubById(mgr.clubId), theirClub = clubById(om.clubId);
        await interaction.update({ content: `📣 Challenge sent to <@${target}>.`, components: [] }).catch(()=>{});

        const e = new EmbedBuilder().setColor(0xef4444)
          .setTitle('⚔️ Match Challenge')
          .setDescription(`<@${uid}> has challenged <@${target}> to a match.`)
          .addFields(
            { name: myClub.name, value: `${myClub.short} · ${mgr.w}W ${mgr.d}D ${mgr.l}L`, inline: true },
            { name: 'vs', value: '\u200b', inline: true },
            { name: theirClub.name, value: `${theirClub.short} · ${om.w}W ${om.d}D ${om.l}L`, inline: true })
          .setFooter({ text: 'Expires in 2 minutes. Only the challenged manager can respond.' });

        const msg = await interaction.channel.send({
          content: `<@${target}>`,
          embeds: [e],
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('fm:chal:acc').setLabel('Accept').setEmoji('✅').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('fm:chal:dec').setLabel('Decline').setEmoji('❌').setStyle(ButtonStyle.Secondary))],
          allowedMentions: { users: [target] },
        }).catch(() => null);
        if (!msg) return;
        openChallenges.set(msg.id, { from: uid, to: target, gid, at: Date.now() });
        const t = setTimeout(async () => {
          if (!openChallenges.has(msg.id)) return;
          openChallenges.delete(msg.id);
          await msg.edit({ embeds: [EmbedBuilder.from(e).setColor(0x64748b)
            .setDescription(`<@${uid}>'s challenge to <@${target}> expired.`)], components: [] }).catch(()=>{});
        }, CHALLENGE_MS);
        if (t.unref) t.unref();
        return;
      }

      if (interaction.isButton() && (id === 'fm:chal:acc' || id === 'fm:chal:dec')) {
        const c = openChallenges.get(interaction.message.id);
        if (!c) return interaction.reply({ content: 'That challenge has already been answered or expired.', flags: 64 });
        if (uid !== c.to) return interaction.reply({ content: `Only <@${c.to}> can answer this challenge.`, flags: 64 });
        openChallenges.delete(interaction.message.id);

        if (id === 'fm:chal:dec') {
          return interaction.update({ embeds: [new EmbedBuilder().setColor(0x64748b)
            .setDescription(`❌ <@${c.to}> declined <@${c.from}>'s challenge.`)], components: [] });
        }
        if (liveMatches.has(gid))
          return interaction.update({ embeds: [new EmbedBuilder().setColor(0x64748b)
            .setDescription('⏳ Another match started first. Try again when it finishes.')], components: [] });

        const home = ctxFor(db, gid, c.from), away = ctxFor(db, gid, c.to);
        if (!home.club || !away.club)
          return interaction.update({ embeds: [new EmbedBuilder().setColor(0x64748b)
            .setDescription('One of you no longer has a club.')], components: [] });

        await interaction.update({ embeds: [new EmbedBuilder().setColor(0x22c55e)
          .setDescription(`✅ <@${c.to}> accepted. **${home.club.name} vs ${away.club.name}** — kicking off now.`)], components: [] }).catch(()=>{});
        return startMatch(interaction.channel, gid, home, away, { [c.from]: 'H', [c.to]: 'A' });
      }
    } catch (e) {
      console.error('[football] handler error:', e.message, (e.stack||'').split('\n')[1]);
      try {
        if (!interaction.replied && !interaction.deferred)
          await interaction.reply({ content: `⚠️ Something went wrong: ${e.message.slice(0,150)}`, flags: 64 });
      } catch { /* */ }
    }
  });

  console.log(`⚽ Football Manager loaded — ${CLUBS.length} clubs, ${PLAYERS.length} players`);
  return { fState: (gid) => fState(db, gid) };
}

module.exports = {
  initFootball, getFootballCommands,
  // data
  LEAGUES, CLUBS, clubById, REAL_PLAYERS, PLAYERS, realById, playerById, squadOf,
  FORMATIONS, FORMATION_KEYS, MENTALITIES, INSTRUCTIONS, TOGGLES, SHOUTS, SQUAD_SIZE,
  // economy
  playerPrice, startRetainer, dailyDrain, retainerNow, setRetainer, topUpRetainer,
  daysLeft, isProtected,
  // state
  fState, getManager, ensureSquad, makePlaceholder, squadRating, lineRating, genName,
  // simulation (exported so behaviour can be tested without a live Discord client)
  newMatch, advance, matchFrameState, makeAIContext, bestXI, ctxFor, planOf, styleLine,
  analyse, effectLines, makeSub, benchForSquad, benchForClub, possPct, overallStam,
  TICKS, MATCH_MS, TICK_MS, HT_TICK, CHANGES_PER_HALF, MAX_SUBS, BENCH_SIZE, UNITS,
};
