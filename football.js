'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   FOOTBALL MANAGER  —  a full club-management game mode for the Libya hub
   ------------------------------------------------------------------------
   • Clubs are one-of-one. Buying one gives you its permanent captain (never
     sellable, stays with the club forever, even on resale).
   • Every other squad slot is a FREE placeholder with a Libyan-flavoured
     generated name, until you buy a real player into it.
   • Real players are one-of-one across the whole server. No duplicates.
   • RETAINER: every owned asset holds a prepaid balance. While it has funds,
     nobody can buy it off you. At zero you keep it — it simply becomes
     purchasable by anyone, instantly, with no warning.
   • Matches are simulated live and animated into the channel by editing one
     message ~60 times over ~3 minutes. Full colour, no GIF, no links.
   ══════════════════════════════════════════════════════════════════════════ */

const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, PermissionFlagsBits, AttachmentBuilder,
} = require('discord.js');
const { Resvg } = require('@resvg/resvg-js');
const path = require('path');
const fs = require('fs');
const { frame } = require('./fm-render');

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
// small club is a realistic first goal, a mid player is a few weeks of saving,
// and a superstar is a genuine long-term chase.
const SQUAD_SIZE   = 11;          // starting XI (subs come later)
const RETAINER_PCT = 0.20;        // starting retainer = 20% of price
const DRAIN_PCT    = 0.02;        // 2% of price drains per day → ~10 days cover

const playerPrice = (rating) => Math.max(10, Math.round(25 * Math.pow(1.15, rating - 60)));
const startRetainer = (price) => Math.max(5, Math.ceil(price * RETAINER_PCT));
const dailyDrain   = (price) => Math.max(1, Math.ceil(price * DRAIN_PCT));

// ─── Libyan Premier League clubs (one-of-one assets) ──────────────────────
// colours: [primary shirt, secondary/trim, number text]
const CLUBS = [
  { id:'ahli-tripoli',  name:'Al-Ahli Tripoli',   short:'AHL', city:'Tripoli',  tier:1, price:1200, c:['#D32F2F','#7f1d1d','#ffffff'], cap:{ name:'Ahmed Krawa\'a',        pos:'FWD', rating:84 } },
  { id:'ittihad-tripoli',name:'Al-Ittihad Tripoli',short:'ITT', city:'Tripoli', tier:1, price:1200, c:['#1f2937','#f8fafc','#ffffff'], cap:{ name:'Muad Eisa',             pos:'FWD', rating:83 } },
  { id:'hilal-benghazi',name:'Al-Hilal Benghazi', short:'HIL', city:'Benghazi', tier:2, price:800,  c:['#1d4ed8','#bfdbfe','#ffffff'], cap:{ name:'Sayfulnasr Jaddour',   pos:'DEF', rating:79 } },
  { id:'ahli-benghazi', name:'Al-Ahli Benghazi',  short:'AHB', city:'Benghazi', tier:2, price:800,  c:['#b91c1c','#fecaca','#ffffff'], cap:{ name:'Ismael Tajouri-Shradi',pos:'FWD', rating:80 } },
  { id:'nasr-benghazi', name:'Al-Nasr Benghazi',  short:'NSR', city:'Benghazi', tier:2, price:750,  c:['#f59e0b','#78350f','#1f2937'], cap:{ name:'Muhanad Madyen',        pos:'DEF', rating:77 } },
  { id:'akhdar',        name:'Al-Akhdar',         short:'AKH', city:'Bayda',    tier:3, price:500,  c:['#15803d','#bbf7d0','#ffffff'], cap:{ name:'Abdallah Dagou',        pos:'MID', rating:74 } },
  { id:'madina',        name:'Al-Madina',         short:'MDN', city:'Tripoli',  tier:3, price:500,  c:['#0ea5e9','#e0f2fe','#ffffff'], cap:{ name:'Osamah Al Shuraimi',    pos:'MID', rating:73 } },
  { id:'ittihad-misrata',name:'Al-Ittihad Misrata',short:'ITM',city:'Misrata',  tier:3, price:480,  c:['#047857','#a7f3d0','#ffffff'], cap:{ name:'Mahmoud Al Shilw',      pos:'MID', rating:72 } },
  { id:'swihli',        name:'Al-Swihli',         short:'SWH', city:'Misrata',  tier:3, price:480,  c:['#6d28d9','#ddd6fe','#ffffff'], cap:{ name:'Marwan Mabrook',        pos:'MID', rating:72 } },
  { id:'olympic-zawiya',name:'Olympic Zawiya',    short:'OLZ', city:'Zawiya',   tier:4, price:280,  c:['#ea580c','#ffedd5','#ffffff'], cap:{ name:'Husain Taqtaq',         pos:'FWD', rating:68 } },
  { id:'tahaddi',       name:'Al-Tahaddi',        short:'THD', city:'Benghazi', tier:4, price:260,  c:['#1e3a8a','#dbeafe','#ffffff'], cap:{ name:'Talal Farhat',          pos:'DEF', rating:67 } },
  { id:'abu-salim',     name:'Abu Salim',         short:'ABS', city:'Tripoli',  tier:4, price:260,  c:['#831843','#fbcfe8','#ffffff'], cap:{ name:'Faisal Al-Badri',       pos:'MID', rating:67 } },
  { id:'khaleej-sirte', name:'Khaleej Sirte',     short:'KHS', city:'Sirte',    tier:4, price:240,  c:['#0f766e','#ccfbf1','#ffffff'], cap:{ name:'Moayad Al-Lafi',        pos:'FWD', rating:66 } },
  { id:'asaria',        name:'Asaria',            short:'ASR', city:'Tripoli',  tier:4, price:240,  c:['#525252','#e5e5e5','#ffffff'], cap:{ name:'Badr Hassan',           pos:'MID', rating:65 } },
  { id:'shat',          name:'Al-Shat',           short:'SHT', city:'Tripoli',  tier:4, price:220,  c:['#a16207','#fef3c7','#ffffff'], cap:{ name:'Ahmed Huwaydi',         pos:'DEF', rating:65 } },
];
const clubById = (id) => CLUBS.find(c => c.id === id) || null;

// ─── real player pool (one-of-one, tradeable) ─────────────────────────────
const P = (name, pos, rating) => ({ name, pos, rating, id: name.toLowerCase().replace(/[^a-z]+/g, '-') });
const REAL_PLAYERS = [
  // GK
  P('Alisson','GK',89), P('Thibaut Courtois','GK',89), P('Jan Oblak','GK',88), P('Marc-Andre ter Stegen','GK',88),
  P('Gianluigi Donnarumma','GK',88), P('Ederson','GK',87), P('Manuel Neuer','GK',87), P('Mike Maignan','GK',86),
  P('Emiliano Martinez','GK',85), P('Andre Onana','GK',84), P('David Raya','GK',84), P('Yann Sommer','GK',84),
  P('Guglielmo Vicario','GK',83), P('Gregor Kobel','GK',83), P('Diogo Costa','GK',82), P('Bart Verbruggen','GK',79),
  // DEF
  P('Virgil van Dijk','DEF',89), P('Ruben Dias','DEF',88), P('Antonio Rudiger','DEF',87), P('Joshua Kimmich','DEF',87),
  P('William Saliba','DEF',86), P('Alessandro Bastoni','DEF',86), P('Marquinhos','DEF',86), P('Ronald Araujo','DEF',86),
  P('Trent Alexander-Arnold','DEF',86), P('Andrew Robertson','DEF',86), P('Gabriel Magalhaes','DEF',85),
  P('Josko Gvardiol','DEF',85), P('Theo Hernandez','DEF',85), P('Jules Kounde','DEF',85), P('Eder Militao','DEF',85),
  P('David Alaba','DEF',85), P('Achraf Hakimi','DEF',85), P('Alphonso Davies','DEF',84), P('Kyle Walker','DEF',84),
  P('Joao Cancelo','DEF',84), P('Dayot Upamecano','DEF',84), P('Matthijs de Ligt','DEF',84), P('Ibrahima Konate','DEF',84),
  P('Ben White','DEF',84), P('Reece James','DEF',84), P('Alejandro Grimaldo','DEF',84), P('Jonathan Tah','DEF',83),
  P('Nico Schlotterbeck','DEF',82), P('Sven Botman','DEF',82), P('Jeremie Frimpong','DEF',82), P('Denzel Dumfries','DEF',82),
  P('Noussair Mazraoui','DEF',81), P('Jurrien Timber','DEF',81), P('Pervis Estupinan','DEF',81), P('Ben Chilwell','DEF',80),
  P('Levi Colwill','DEF',79), P('Micky van de Ven','DEF',82), P('Cristian Romero','DEF',85),
  // MID
  P('Rodri','MID',90), P('Kevin De Bruyne','MID',90), P('Jude Bellingham','MID',89), P('Federico Valverde','MID',88),
  P('Toni Kroos','MID',87), P('Bernardo Silva','MID',87), P('Phil Foden','MID',87), P('Martin Odegaard','MID',87),
  P('Bruno Fernandes','MID',87), P('Luka Modric','MID',86), P('Declan Rice','MID',86), P('Nicolo Barella','MID',86),
  P('Hakan Calhanoglu','MID',86), P('Florian Wirtz','MID',86), P('Jamal Musiala','MID',86), P('Cole Palmer','MID',86),
  P('Pedri','MID',85), P('Bruno Guimaraes','MID',85), P('Aurelien Tchouameni','MID',84), P('Eduardo Camavinga','MID',84),
  P('Michael Olise','MID',84), P('Granit Xhaka','MID',84), P('Enzo Fernandez','MID',84), P('Vitinha','MID',84),
  P('Alexis Mac Allister','MID',84), P('Gavi','MID',83), P('Martin Zubimendi','MID',83), P('Moises Caicedo','MID',83),
  P('Dominik Szoboszlai','MID',83), P('Mikel Merino','MID',82), P('Sandro Tonali','MID',82), P('James Maddison','MID',82),
  P('Ruben Neves','MID',82), P('Warren Zaire-Emery','MID',82), P('Eberechi Eze','MID',82), P('Ryan Gravenberch','MID',82),
  P('Davide Frattesi','MID',81), P('Manuel Ugarte','MID',79), P('Kobbie Mainoo','MID',78), P('Adam Wharton','MID',78),
  // FWD
  P('Kylian Mbappe','FWD',91), P('Erling Haaland','FWD',91), P('Vinicius Junior','FWD',90), P('Harry Kane','FWD',90),
  P('Mohamed Salah','FWD',89), P('Robert Lewandowski','FWD',89), P('Antoine Griezmann','FWD',88), P('Victor Osimhen','FWD',88),
  P('Lautaro Martinez','FWD',87), P('Son Heung-min','FWD',87), P('Bukayo Saka','FWD',87), P('Rafael Leao','FWD',86),
  P('Khvicha Kvaratskhelia','FWD',86), P('Alexander Isak','FWD',85), P('Viktor Gyokeres','FWD',85), P('Raphinha','FWD',85),
  P('Lamine Yamal','FWD',85), P('Dusan Vlahovic','FWD',84), P('Ollie Watkins','FWD',84), P('Christopher Nkunku','FWD',84),
  P('Marcus Rashford','FWD',83), P('Benjamin Sesko','FWD',82), P('Lois Openda','FWD',82), P('Randal Kolo Muani','FWD',82),
  P('Kai Havertz','FWD',82), P('Gabriel Martinelli','FWD',82), P('Jeremy Doku','FWD',82), P('Federico Chiesa','FWD',82),
  P('Bryan Mbeumo','FWD',82), P('Jarrod Bowen','FWD',82), P('Darwin Nunez','FWD',82), P('Leon Bailey','FWD',81),
  P('Nicolas Jackson','FWD',81), P('Ivan Toney','FWD',81), P('Dominic Solanke','FWD',81), P('Yoane Wissa','FWD',80),
  P('Joao Felix','FWD',81), P('Rasmus Hojlund','FWD',79), P('Joshua Zirkzee','FWD',79), P('Antony','FWD',78),
];
const realById = (id) => REAL_PLAYERS.find(p => p.id === id) || null;

// ─── placeholder name generator (Libyan flavoured, shuffled — not real people)
const FIRST = ['Ahmed','Mohamed','Ali','Omar','Khaled','Youssef','Hamza','Tariq','Faisal','Bilal','Nasser','Salem',
  'Idris','Marwan','Anas','Zaid','Rami','Sami','Adel','Karim','Hassan','Hussein','Mustafa','Ibrahim','Yassin','Jamal',
  'Nabil','Walid','Fathi','Sufyan','Munir','Ashraf','Osama','Bashir','Saleh','Tawfik','Ridwan','Ayman','Basem','Ziad'];
const LAST = ['Al-Mabrouk','Al-Sharif','Al-Trabelsi','Ben Ali','Al-Zawi','Al-Misrati','Al-Fitouri','Al-Barghathi',
  'Al-Werfalli','Al-Obeidi','Ben Omar','Al-Sanussi','Al-Ghariani','Al-Darsi','Al-Hasi','Bin Nasser','Al-Tuhami',
  'Al-Shibani','Al-Areibi','Al-Fakhri','Al-Jilani','Al-Rayyani','Al-Mahdi','Al-Ferjani','Al-Khoja','Al-Zintani',
  'Al-Bakoush','Al-Hariri','Al-Suwaidi','Al-Gheryani','Al-Nuwairi','Al-Kabir'];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const genName = () => `${pick(FIRST)} ${pick(LAST)}`;

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

// ─── mentality & instructions ─────────────────────────────────────────────
const MENTALITIES = {
  defensive: { name:'Defensive', emoji:'🛡️', push:-9,  attack:-0.22, defend:+0.20, tempo:-0.15 },
  cautious:  { name:'Cautious',  emoji:'🧱', push:-4,  attack:-0.10, defend:+0.10, tempo:-0.07 },
  balanced:  { name:'Balanced',  emoji:'⚖️', push:0,   attack:0,     defend:0,     tempo:0 },
  positive:  { name:'Positive',  emoji:'📈', push:+5,  attack:+0.11, defend:-0.09, tempo:+0.08 },
  attacking: { name:'Attacking', emoji:'⚔️', push:+10, attack:+0.24, defend:-0.20, tempo:+0.17 },
};
const INSTRUCTIONS = {
  press:  { name:'Pressing',  opts:{ low:'Sit Deep', mid:'Balanced', high:'Press High' } },
  tempo:  { name:'Tempo',     opts:{ slow:'Slow', normal:'Normal', fast:'High Tempo' } },
  width:  { name:'Width',     opts:{ narrow:'Narrow', normal:'Normal', wide:'Wide' } },
  pass:   { name:'Passing',   opts:{ short:'Short', mixed:'Mixed', direct:'Direct' } },
};
const SHOUTS = {
  encourage: { name:'Encourage',   emoji:'👏', morale:+6,  desc:'lifts a struggling side' },
  praise:    { name:'Praise',      emoji:'🌟', morale:+8,  desc:'rewards a good spell' },
  demand:    { name:'Demand More', emoji:'📢', morale:+4,  desc:'sparks a flat team' },
  calm:      { name:'Calm Down',   emoji:'🧊', morale:+5,  desc:'steadies a nervy lead' },
  berate:    { name:'Berate',      emoji:'🔥', morale:-2,  desc:'high risk, high reward' },
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
  if (!f.managers[uid]) {
    f.managers[uid] = {
      clubId: null,
      squad: [],
      formation: '4-3-3',
      mentality: 'balanced',
      instr: { press:'mid', tempo:'normal', width:'normal', pass:'mixed' },
      morale: 65, cohesion: 50,
      p:0, w:0, d:0, l:0, gf:0, ga:0,
      created: Date.now(),
    };
  }
  return f.managers[uid];
}
// build a fresh free placeholder for a formation slot
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
   A possession/momentum model. Each tick is ~1.5 game-minutes; 60 ticks make
   a 90-minute match that plays out over about 3 real minutes.
   ══════════════════════════════════════════════════════════════════════════ */

const TICKS = 60, TICK_MS = 3000, MIN_PER_TICK = 1.5;

function strength(ctx) {
  const sq = ctx.squad, f = ctx.formation;
  const gk  = lineRating(sq, f, 'GK');
  const def = lineRating(sq, f, 'DEF');
  const mid = lineRating(sq, f, 'MID');
  const fwd = lineRating(sq, f, 'FWD');
  const men = MENTALITIES[ctx.mentality] || MENTALITIES.balanced;
  const mor = 0.86 + (clamp(ctx.morale, 0, 100) / 100) * 0.28;
  const coh = 0.93 + (clamp(ctx.cohesion, 0, 100) / 100) * 0.14;
  const pressBoost = ctx.instr && ctx.instr.press === 'high' ? 0.05 : ctx.instr && ctx.instr.press === 'low' ? -0.03 : 0;
  return {
    att: (fwd * 0.62 + mid * 0.38) * (1 + men.attack) * mor * coh,
    mid: mid * (1 + men.tempo * 0.4 + pressBoost) * mor * coh,
    def: (def * 0.72 + gk * 0.28) * (1 + men.defend) * mor * coh,
    gk,
  };
}
const rnd = (a, b) => a + Math.random() * (b - a);

// pick a named player from a side for commentary flavour
function whoFrom(ctx, prefer) {
  const form = FORMATIONS[ctx.formation] || FORMATIONS['4-3-3'];
  const pool = ctx.squad.filter((p, i) => form.slots[i] && form.slots[i].p === prefer);
  const list = pool.length ? pool : ctx.squad.filter((p,i)=>form.slots[i] && form.slots[i].p !== 'GK');
  return (list.length ? pick(list) : ctx.squad[0] || { name: 'the striker' }).name;
}

const C = {
  build:  ['{T} knock it around at the back.', '{T} building patiently through midfield.', '{P} drops deep to get on the ball.',
           '{T} probing for a way through.', '{P} switches the play across the pitch.', 'Neat triangle from {T} in the middle third.'],
  press:  ['{T} win it back high up the pitch!', 'Turnover — {T} pounce on a loose touch.', '{P} nicks it and {T} surge forward.'],
  turn:   ['Misplaced pass — {T} take over.', '{T} lose it cheaply in midfield.', 'Cleared away, {T} regain possession.',
           'Heavy touch from {P} and it runs away.'],
  wide:   ['{P} takes it down the flank.', '{T} stretch it wide looking for the cross.', '{P} beats his man on the outside!'],
  final:  ['{T} into the final third now.', '{P} threads it into a dangerous area.', '{T} are camped in the opposition half.'],
  chance: ['A big chance opens up for {T}!', '{P} finds space in the box!', 'It falls to {P} eight yards out!'],
  goal:   ['GOAL! {P} buries it!', 'GOAL! {P} finishes coolly for {T}!', 'GOAL! A brilliant strike from {P}!',
           'GOAL! {P} makes no mistake!', 'GOAL! {T} break through — {P} with the finish!'],
  save:   ['Saved! A strong hand keeps {P} out.', 'Great stop! {P} denied from close range.', 'The keeper holds {P}\'s effort.'],
  miss:   ['{P} drags it wide.', 'Over the bar from {P}!', '{P} snatches at it — off target.'],
  post:   ['Off the post! {P} is inches away!', 'Crashes off the woodwork! {T} can\'t believe it.'],
  block:  ['Blocked! Brave defending from {T}.', 'The shot is charged down.'],
  keep:   ['{T} keep possession, slowing it down.', '{T} recycle it patiently.'],
};
const say = (arr, T, Pn) => pick(arr).replace(/\{T\}/g, T).replace(/\{P\}/g, Pn || 'the forward');

function newMatch(home, away) {
  return {
    home, away, hg: 0, ag: 0, minute: 0, tick: 0,
    poss: Math.random() < 0.5 ? 'H' : 'A',
    ballX: 50, ballY: 50, trail: [],
    possTicks: { H: 1, A: 1 },
    stats: { H: { shots: 0, sot: 0, chances: 0 }, A: { shots: 0, sot: 0, chances: 0 } },
    scorers: [], feed: [], ended: false, ballOwner: null,
  };
}

function advance(m) {
  m.tick++;
  m.minute = Math.min(90, Math.round(m.tick * MIN_PER_TICK));
  const isH = m.poss === 'H';
  const atk = isH ? m.home : m.away;
  const dfn = isH ? m.away : m.home;
  const sa = strength(atk), sd = strength(dfn);
  const T = atk.club.short, Tf = atk.club.name;
  m.possTicks[m.poss]++;
  let event = null, commentary = '';

  // ── contest the ball ──
  const keep = clamp(0.70 + (sa.mid - sd.mid) / 240, 0.46, 0.88);
  if (Math.random() > keep) {
    m.poss = isH ? 'A' : 'H';
    const nT = (isH ? m.away : m.home).club.short;
    commentary = Math.random() < 0.45
      ? say(C.press, nT, whoFrom(isH ? m.away : m.home, 'MID'))
      : say(C.turn, nT, whoFrom(atk, 'MID'));
    m.ballY = clamp(m.ballY + rnd(-18, 18), 8, 92);
    m.ballOwner = null;
    return { event, commentary };
  }

  // ── carry the ball forward ──
  const drive = 9 + (sa.att - sd.def) / 6.5 + rnd(-4, 14);
  m.ballX = clamp(m.ballX + (isH ? drive : -drive), 4, 96);
  m.ballY = clamp(m.ballY + rnd(-14, 14), 8, 92);
  m.trail.push({ x: m.ballX, y: m.ballY });
  if (m.trail.length > 6) m.trail.shift();

  const deep = isH ? m.ballX > 72 : m.ballX < 28;
  const mid3 = isH ? m.ballX > 58 : m.ballX < 42;

  // ── chance creation in the final third ──
  if (deep) {
    const q = clamp(0.52 + (sa.att - sd.def) / 150, 0.22, 0.80);
    if (Math.random() < q) {
      m.stats[m.poss].chances++;
      const shooter = whoFrom(atk, Math.random() < 0.7 ? 'FWD' : 'MID');
      m.stats[m.poss].shots++;
      // shot quality vs keeper
      const xg = clamp(0.26 + (sa.att - sd.gk) / 190 + rnd(-0.12, 0.16), 0.06, 0.60);
      const roll = Math.random();
      if (roll < xg) {
        if (isH) m.hg++; else m.ag++;
        m.stats[m.poss].sot++;
        m.scorers.push({ side: m.poss, name: shooter, minute: m.minute });
        event = { type: 'GOAL', sub: `${shooter} · ${m.minute}'` };
        commentary = say(C.goal, T, shooter);
        m.feed.push(`⚽ **${m.minute}'** ${shooter} (${T}) — ${m.hg}-${m.ag}`);
        m.ballX = 50; m.ballY = 50; m.trail = [];
        m.poss = isH ? 'A' : 'H';
        m.ballOwner = null;
        return { event, commentary };
      }
      if (roll < xg + 0.30) {
        m.stats[m.poss].sot++;
        event = { type: 'SAVE' }; commentary = say(C.save, T, shooter);
        m.feed.push(`🧤 **${m.minute}'** Save — ${shooter} (${T})`);
      } else if (roll < xg + 0.38) {
        event = { type: 'POST' }; commentary = say(C.post, T, shooter);
        m.feed.push(`🪵 **${m.minute}'** Woodwork — ${shooter} (${T})`);
      } else if (roll < xg + 0.52) {
        commentary = say(C.block, T, shooter);
      } else {
        event = { type: 'MISS' }; commentary = say(C.miss, T, shooter);
      }
      m.ballX = isH ? 26 : 74; m.ballY = rnd(30, 70); m.trail = [];
      m.poss = isH ? 'A' : 'H';
      m.ballOwner = null;
      return { event, commentary };
    }
    commentary = say(C.chance, T, whoFrom(atk, 'FWD'));
    event = { type: 'CHANCE' };
  } else if (mid3) {
    commentary = Math.random() < 0.5 ? say(C.final, T, whoFrom(atk, 'MID')) : say(C.wide, T, whoFrom(atk, 'MID'));
  } else {
    commentary = Math.random() < 0.75 ? say(C.build, T, whoFrom(atk, 'MID')) : say(C.keep, T, whoFrom(atk, 'DEF'));
  }
  // who is on the ball (for the highlight ring) — nearest slot to the ball
  const form = FORMATIONS[atk.formation] || FORMATIONS['4-3-3'];
  let best = 0, bestD = 1e9;
  form.slots.forEach((s, i) => {
    const px = isH ? s.x : 100 - s.x;
    const d = Math.abs(px - m.ballX) + Math.abs(s.y - m.ballY) * 0.6;
    if (d < bestD) { bestD = d; best = i; }
  });
  m.ballOwner = `${isH ? 'H' : 'A'}${best}`;
  return { event, commentary };
}

/* team shape for rendering — the unit shifts with the ball and mentality */
function shapeFor(ctx, isHome, m) {
  const form = FORMATIONS[ctx.formation] || FORMATIONS['4-3-3'];
  const men = MENTALITIES[ctx.mentality] || MENTALITIES.balanced;
  const hasBall = (m.poss === 'H') === isHome;
  // convert ball to this team's attacking frame (0 = own goal, 100 = opponent goal)
  const relBall = isHome ? m.ballX : 100 - m.ballX;
  const widthMul = ctx.instr && ctx.instr.width === 'wide' ? 1.12 : ctx.instr && ctx.instr.width === 'narrow' ? 0.86 : 1;
  return form.slots.map((s, i) => {
    let x, y;
    if (s.p === 'GK') {
      x = s.x + (relBall - 50) * 0.06;
      y = 50 + (m.ballY - 50) * 0.16;
    } else {
      const follow = (relBall - 50) * 0.24;
      const push = (hasBall ? 7 : -6) + men.push * 0.55;
      x = s.x + follow + push;
      y = 50 + (s.y - 50) * widthMul + (m.ballY - 50) * 0.14;
    }
    x = clamp(x, 3, 96); y = clamp(y, 5, 95);
    return { x: isHome ? x : 100 - x, y, num: ctx.squad[i] ? ctx.squad[i].num : i + 1 };
  });
}

function matchFrameState(m) {
  const total = m.possTicks.H + m.possTicks.A;
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
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   LIVE MATCH RUNNER  —  one message, edited ~60 times over ~3 minutes
   ══════════════════════════════════════════════════════════════════════════ */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const money = (n) => `${Math.round(n).toLocaleString('en-US')} 🪙`;

function shoutRow(disabled = false) {
  const r = new ActionRowBuilder();
  for (const [k, s] of Object.entries(SHOUTS))
    r.addComponents(new ButtonBuilder().setCustomId(`fm:shout:${k}`).setLabel(s.name).setEmoji(s.emoji)
      .setStyle(k === 'berate' ? ButtonStyle.Danger : ButtonStyle.Secondary).setDisabled(disabled));
  return r;
}

function applyShout(ctx, key, m, side) {
  const s = SHOUTS[key]; if (!s) return 0;
  const diff = side === 'H' ? m.hg - m.ag : m.ag - m.hg;
  let d = s.morale;
  if (key === 'praise' && diff < 0) d = -4;          // praising a losing side rings hollow
  if (key === 'calm'   && diff <= 0) d = 1;          // nothing to protect yet
  if (key === 'berate' && diff > 0) d = -6;          // needless when ahead
  if (key === 'berate' && diff < 0) d = 7;           // fires up a losing side
  if (key === 'demand' && diff > 1) d = 1;
  if (key === 'encourage' && diff < 0) d = 8;        // exactly when it helps most
  ctx.morale = clamp(ctx.morale + d, 10, 100);
  return d;
}

function matchEmbed(m, live = true) {
  const feed = m.feed.slice(-6).join('\n') || '_No goals yet._';
  const e = new EmbedBuilder()
    .setColor(parseInt((m.hg > m.ag ? m.home.club.c[0] : m.ag > m.hg ? m.away.club.c[0] : '#fbbf24').slice(1), 16))
    .setTitle(`${m.home.club.name}  ${m.hg} – ${m.ag}  ${m.away.club.name}`)
    .setDescription(live ? `⏱️ **${m.minute}'** · ${m.lastCommentary || 'Kick off.'}` : `**Full time.**`)
    .setImage('attachment://pitch.png')
    .addFields({ name: 'Match feed', value: feed, inline: false });
  if (!live) {
    const hs = m.stats.H, as = m.stats.A;
    e.addFields(
      { name: `${m.home.club.short} stats`, value: `Shots **${hs.shots}** · On target **${hs.sot}**`, inline: true },
      { name: `${m.away.club.short} stats`, value: `Shots **${as.shots}** · On target **${as.sot}**`, inline: true },
    );
  }
  return e;
}

async function runLiveMatch(channel, m, seatMap, db, gid, saveData) {
  m.lastCommentary = 'Kick off.'; m.lastEvent = { type: 'KICK' };
  let png = frame(matchFrameState(m));
  let msg;
  try {
    msg = await channel.send({
      embeds: [matchEmbed(m)],
      files: [new AttachmentBuilder(png, { name: 'pitch.png' })],
      components: [shoutRow()],
    });
  } catch (e) { console.error('[fm] could not post match:', e.message); return null; }

  const collector = msg.createMessageComponentCollector({ time: TICKS * TICK_MS + 15000 });
  collector.on('collect', async (i) => {
    const side = seatMap[i.user.id];
    if (!side) return i.reply({ content: 'Only the two managers can shout from the touchline.', flags: 64 }).catch(()=>{});
    const key = i.customId.split(':')[2];
    const ctx = side === 'H' ? m.home : m.away;
    const d = applyShout(ctx, key, m, side);
    const s = SHOUTS[key];
    await i.reply({
      content: `${s.emoji} **${s.name}** — morale ${d >= 0 ? '+' : ''}${d} (now ${Math.round(ctx.morale)}).${d < 0 ? ' That did not land well.' : ''}`,
      flags: 64,
    }).catch(()=>{});
  });

  for (let t = 0; t < TICKS && !m.ended; t++) {
    const { event, commentary } = advance(m);
    m.lastEvent = event; m.lastCommentary = commentary;
    if (m.tick === Math.floor(TICKS / 2)) m.lastEvent = { type: 'HT' };
    try {
      png = frame(matchFrameState(m));
      await msg.edit({
        embeds: [matchEmbed(m)],
        files: [new AttachmentBuilder(png, { name: 'pitch.png' })],
        attachments: [],
        components: [shoutRow()],
      });
    } catch (e) { /* a dropped frame is not worth killing the match over */ }
    await sleep(TICK_MS);
  }

  // full time
  m.ended = true; m.minute = 90;
  m.lastEvent = { type: 'FT' };
  m.lastCommentary = m.hg === m.ag ? 'It ends level.' : `${(m.hg > m.ag ? m.home : m.away).club.name} take it.`;
  try {
    png = frame(matchFrameState(m));
    await msg.edit({
      embeds: [matchEmbed(m, false)],
      files: [new AttachmentBuilder(png, { name: 'pitch.png' })],
      attachments: [], components: [shoutRow(true)],
    });
  } catch { /* */ }
  collector.stop();
  return m;
}

/* ══════════════════════════════════════════════════════════════════════════
   VIEWS
   ══════════════════════════════════════════════════════════════════════════ */
const POS_EMOJI = { GK:'🧤', DEF:'🛡️', MID:'🎯', FWD:'⚡' };

function homeView(db, gid, uid, getDinar) {
  const f = fState(db, gid);
  const mgr = getManager(db, gid, uid);
  ensureSquad(mgr);
  const club = mgr.clubId ? clubById(mgr.clubId) : null;
  const bal = getDinar(db, gid, uid);
  const rating = squadRating(mgr.squad);
  const realCount = mgr.squad.filter(p => p.real).length;

  const e = new EmbedBuilder()
    .setColor(club ? parseInt(club.c[0].slice(1), 16) : 0x22c55e)
    .setTitle('⚽ Football Manager')
    .setDescription(club
      ? `**${club.name}** · ${club.city}\n_${MENTALITIES[mgr.mentality].emoji} ${MENTALITIES[mgr.mentality].name} · ${mgr.formation}_`
      : '_You have no club yet. Buy one to get its permanent captain and start your career._')
    .addFields(
      { name: '💰 Your Dinar', value: money(bal), inline: true },
      { name: '⭐ Squad rating', value: `**${rating.toFixed(1)}**`, inline: true },
      { name: '👤 Real players', value: `**${realCount}** / ${SQUAD_SIZE}`, inline: true },
      { name: '📊 Record', value: `**${mgr.w}**W · **${mgr.d}**D · **${mgr.l}**L  (${mgr.p} played)`, inline: true },
      { name: '🔥 Morale', value: `${Math.round(mgr.morale)}%`, inline: true },
      { name: '🤝 Cohesion', value: `${Math.round(mgr.cohesion)}%`, inline: true },
    )
    .setFooter({ text: 'Retainers protect your club and players from being bought out.' });

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
  const form = FORMATIONS[mgr.formation];
  const club = mgr.clubId ? clubById(mgr.clubId) : null;
  const lines = mgr.squad.map((p, i) => {
    const slot = form.slots[i] || { p: p.pos };
    const cap = club && p.captain ? ' 👑' : '';
    const prot = p.real ? (isProtected(p) ? `🛡️${Math.ceil(daysLeft(p))}d` : '⚠️ exposed') : '';
    const tag = p.real ? `**${p.rating}**` : `${p.rating}`;
    return `\`${String(p.num).padStart(2)}\` ${POS_EMOJI[slot.p]} ${p.real ? '**' + p.name + '**' : p.name}${cap} · ${tag} ${prot}`;
  });
  const e = new EmbedBuilder().setColor(club ? parseInt(club.c[0].slice(1), 16) : 0x64748b)
    .setTitle(`👥 ${club ? club.name : 'Your Squad'} — ${mgr.formation}`)
    .setDescription(lines.join('\n'))
    .setFooter({ text: 'Bold = real signing · plain = free academy player · 👑 = club captain' });
  return {
    embeds: [e],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('fm:market').setLabel('Sign a player').setEmoji('💸').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('fm:sell').setLabel('Release').setEmoji('📤').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('fm:home').setLabel('Back').setStyle(ButtonStyle.Secondary))],
    files: [], attachments: [],
  };
}

function clubsView(db, gid, uid, getDinar) {
  const f = fState(db, gid);
  const mgr = getManager(db, gid, uid);
  const bal = getDinar(db, gid, uid);
  const lines = CLUBS.map(c => {
    const owner = f.clubOwner[c.id];
    if (owner === uid) return `🟢 **${c.name}** — yours`;
    if (owner) {
      const om = f.managers[owner];
      const asset = om && om.clubAsset;
      const prot = asset && isProtected(asset);
      return prot
        ? `🔒 **${c.name}** — <@${owner}> · protected`
        : `🔓 **${c.name}** — <@${owner}> · **buyable ${money(c.price)}**`;
    }
    return `⚪ **${c.name}** — ${money(c.price)} · cap. ${c.cap.name} (${c.cap.rating})`;
  });
  const e = new EmbedBuilder().setColor(0x16a34a).setTitle('🏟️ Clubs')
    .setDescription(lines.join('\n'))
    .addFields({ name: 'Your Dinar', value: money(bal), inline: true },
               { name: 'Rule', value: 'One club each. The captain stays with the club forever.', inline: true });
  const opts = CLUBS.filter(c => f.clubOwner[c.id] !== uid).slice(0, 25).map(c => ({
    label: `${c.name} — ${c.price} Dinar`, value: c.id,
    description: `${c.city} · captain ${c.cap.name} (${c.cap.rating})`.slice(0, 100),
  }));
  const rows = [];
  if (opts.length) rows.push(new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('fm:buyclub').setPlaceholder('Buy a club…').addOptions(opts)));
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('fm:home').setLabel('Back').setStyle(ButtonStyle.Secondary)));
  return { embeds: [e], components: rows, files: [], attachments: [] };
}

function marketView(db, gid, uid, getDinar, pos = 'FWD') {
  const f = fState(db, gid);
  const bal = getDinar(db, gid, uid);
  const avail = REAL_PLAYERS.filter(p => p.pos === pos).map(p => {
    const owner = f.playerOwner[p.id];
    let state = 'free';
    if (owner === uid) state = 'mine';
    else if (owner) {
      const om = f.managers[owner];
      const held = om && (om.squad || []).find(q => q.playerId === p.id);
      state = held && isProtected(held) ? 'locked' : 'buyable';
    }
    return { ...p, price: playerPrice(p.rating), owner, state };
  }).sort((a, b) => b.rating - a.rating);

  const show = avail.slice(0, 20).map(p => {
    const icon = p.state === 'mine' ? '🟢' : p.state === 'locked' ? '🔒' : p.state === 'buyable' ? '🔓' : '⚪';
    const who = p.owner ? ` · <@${p.owner}>` : '';
    return `${icon} **${p.name}** \`${p.rating}\` — ${money(p.price)}${who}`;
  });
  const e = new EmbedBuilder().setColor(0x0ea5e9).setTitle(`💸 Transfer Market — ${POS_EMOJI[pos]} ${pos}`)
    .setDescription(show.join('\n') || '_None._')
    .addFields({ name: 'Your Dinar', value: money(bal), inline: true },
               { name: 'Key', value: '⚪ free · 🔒 protected · 🔓 buyable now · 🟢 yours', inline: true })
    .setFooter({ text: 'A player with no retainer left can be bought instantly by anyone.' });

  const buyable = avail.filter(p => p.state === 'free' || p.state === 'buyable').slice(0, 25);
  const rows = [
    new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('fm:pos')
      .setPlaceholder('Filter position…')
      .addOptions(['GK','DEF','MID','FWD'].map(p => ({ label: p, value: p, emoji: POS_EMOJI[p], default: p === pos })))),
  ];
  if (buyable.length) rows.push(new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(`fm:buy:${pos}`).setPlaceholder('Sign a player…')
      .addOptions(buyable.map(p => ({ label: `${p.name} — ${p.price} Dinar`, value: p.id,
        description: `Rating ${p.rating}${p.owner ? ' · buying from another manager' : ''}`.slice(0,100) })))));
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('fm:home').setLabel('Back').setStyle(ButtonStyle.Secondary)));
  return { embeds: [e], components: rows, files: [], attachments: [] };
}

function tacticsView(db, gid, uid) {
  const mgr = getManager(db, gid, uid);
  const men = MENTALITIES[mgr.mentality];
  const e = new EmbedBuilder().setColor(0x8b5cf6).setTitle('🧠 Tactics')
    .addFields(
      { name: 'Formation', value: `**${mgr.formation}**`, inline: true },
      { name: 'Mentality', value: `${men.emoji} **${men.name}**`, inline: true },
      { name: 'Shape', value: `${lineRating(mgr.squad, mgr.formation,'DEF').toFixed(0)} DEF · ${lineRating(mgr.squad, mgr.formation,'MID').toFixed(0)} MID · ${lineRating(mgr.squad, mgr.formation,'FWD').toFixed(0)} FWD`, inline: true },
      { name: 'Instructions', value: Object.entries(INSTRUCTIONS)
          .map(([k, v]) => `**${v.name}:** ${v.opts[mgr.instr[k]]}`).join('\n'), inline: false },
    )
    .setFooter({ text: 'Mentality shifts your whole shape up or down the pitch during a match.' });
  return {
    embeds: [e],
    components: [
      new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('fm:form')
        .setPlaceholder('Formation…').addOptions(FORMATION_KEYS.map(k => ({ label: k, value: k, default: k === mgr.formation })))),
      new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('fm:ment')
        .setPlaceholder('Mentality…').addOptions(Object.entries(MENTALITIES).map(([k, v]) =>
          ({ label: v.name, value: k, emoji: v.emoji, default: k === mgr.mentality })))),
      new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('fm:instr')
        .setPlaceholder('Team instruction…').addOptions(
          Object.entries(INSTRUCTIONS).flatMap(([k, v]) => Object.entries(v.opts).map(([ok, ol]) =>
            ({ label: `${v.name}: ${ol}`, value: `${k}|${ok}`, default: mgr.instr[k] === ok }))).slice(0, 25))),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('fm:home').setLabel('Back').setStyle(ButtonStyle.Secondary)),
    ], files: [], attachments: [],
  };
}

function retainersView(db, gid, uid, getDinar) {
  const mgr = getManager(db, gid, uid);
  const club = mgr.clubId ? clubById(mgr.clubId) : null;
  const rows = [];
  const lines = [];
  if (club && mgr.clubAsset) {
    const d = daysLeft(mgr.clubAsset);
    lines.push(`🏟️ **${club.name}** — ${retainerNow(mgr.clubAsset).toFixed(0)} left · ${d > 0 ? `**${d.toFixed(1)} days**` : '**EXPOSED**'}`);
  }
  for (const p of mgr.squad.filter(x => x.real)) {
    const d = daysLeft(p);
    lines.push(`${POS_EMOJI[p.pos]} **${p.name}** — ${retainerNow(p).toFixed(0)} left · ${d > 0 ? `${d.toFixed(1)}d` : '**EXPOSED**'}`);
  }
  const e = new EmbedBuilder().setColor(0xf59e0b).setTitle('🛡️ Retainers')
    .setDescription(lines.length ? lines.join('\n') : '_Nothing to protect yet._')
    .addFields({ name: 'How it works', value:
      'A funded retainer makes an asset **unbuyable**. At zero you keep it — but anyone can buy it from you instantly, with no warning. Top up before a break.' })
    .setFooter({ text: `Your Dinar: ${Math.round(getDinar(db, gid, uid))}` });
  const opts = [];
  if (club && mgr.clubAsset) opts.push({ label: `${club.name} (club)`, value: 'club' });
  mgr.squad.filter(x => x.real).slice(0, 24).forEach(p => opts.push({ label: p.name, value: `p|${p.uid}` }));
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
  const e = new EmbedBuilder().setColor(0xfbbf24).setTitle('🏆 League Table')
    .setDescription(lines.join('\n') || '_No managers with clubs yet._')
    .setFooter({ text: 'Win 3 pts · Draw 1 pt' });
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
  return idx;
}

function doBuyPlayer(db, gid, uid, playerId, api) {
  const f = fState(db, gid);
  const rp = realById(playerId);
  if (!rp) return { ok: false, msg: 'That player does not exist.' };
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
  if (api.getDinar(db, gid, uid) < price) return { ok: false, msg: `You need ${money(price)} — you have ${money(api.getDinar(db, gid, uid))}.` };
  if (!api.spendDinar(db, gid, uid, price, api.saveData)) return { ok: false, msg: 'Payment failed.' };

  // strip from the old owner and pay them
  if (owner && f.managers[owner]) {
    const om = f.managers[owner];
    const i = (om.squad || []).findIndex(q => q.playerId === playerId);
    if (i !== -1) {
      const form = FORMATIONS[om.formation] || FORMATIONS['4-3-3'];
      om.squad[i] = makePlaceholder(form.slots[i] || { p: rp.pos }, om.squad[i].num);
    }
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
  return { ok: true, msg: `✅ Signed **${rp.name}** (${rp.rating}) for ${money(price)}.${owner ? ` Bought out from <@${owner}>.` : ''}\n🛡️ Retainer started: **${startRetainer(price)}** (~${(startRetainer(price)/dailyDrain(price)).toFixed(0)} days).`, price };
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

  if (owner && f.managers[owner]) {
    const om = f.managers[owner];
    om.clubId = null; om.clubAsset = null;
    // the captain goes with the club, so strip him from the old squad
    const ci = (om.squad || []).findIndex(p => p.captain);
    if (ci !== -1) {
      const form = FORMATIONS[om.formation] || FORMATIONS['4-3-3'];
      om.squad[ci] = makePlaceholder(form.slots[ci] || { p: 'MID' }, om.squad[ci].num);
    }
    api.awardDinar(db, gid, owner, club.price, api.saveData, 'football-clubsale');
  }

  mgr.clubId = clubId;
  f.clubOwner[clubId] = uid;
  mgr.clubAsset = {};
  setRetainer(mgr.clubAsset, startRetainer(club.price), club.price);

  // the captain arrives with the club and can never be sold
  const cap = {
    uid: `cap-${clubId}`, name: club.cap.name, pos: club.cap.pos, rating: club.cap.rating,
    real: true, captain: true, num: 10, price: 0,
  };
  const idx = slotFor(mgr, cap.pos);
  cap.num = mgr.squad[idx] ? mgr.squad[idx].num : idx + 1;
  mgr.squad[idx] = cap;
  api.saveData(gid);
  return { ok: true, msg: `🏟️ You are now the manager of **${club.name}**!\n👑 Club captain **${cap.name}** (${cap.rating}) joins permanently — he can never be sold.\n🛡️ Retainer started: **${startRetainer(club.price)}**.` };
}

/* AI opponent built from a club's tier so a solo match still feels fair */
function makeAIContext(club) {
  const base = [88, 80, 72, 65][club.tier - 1] || 70;
  const form = FORMATIONS['4-3-3'];
  const squad = form.slots.map((s, i) => ({
    uid: `ai${i}`, name: genName(), pos: s.p,
    rating: clamp(Math.round(base + (Math.random() * 10 - 5)), 45, 92),
    real: false, num: i + 1,
  }));
  const ci = squad.findIndex(p => p.pos === club.cap.pos);
  if (ci !== -1) squad[ci] = { ...squad[ci], name: club.cap.name, rating: club.cap.rating, captain: true };
  return { club, squad, formation: '4-3-3', mentality: 'balanced',
    instr: { press:'mid', tempo:'normal', width:'normal', pass:'mixed' },
    morale: 65, cohesion: 60, ai: true };
}
function ctxFor(db, gid, uid) {
  const mgr = getManager(db, gid, uid); ensureSquad(mgr);
  return { club: clubById(mgr.clubId), squad: mgr.squad, formation: mgr.formation,
    mentality: mgr.mentality, instr: mgr.instr, morale: mgr.morale, cohesion: mgr.cohesion, uid };
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

function initFootball({ client, db, saveData, getDinar, spendDinar, awardDinar }) {
  const api = { getDinar, spendDinar, awardDinar, saveData };
  const liveMatches = new Set();      // guild ids with a match running
  const posState = new Map();         // uid -> market position filter

  const wrongChannel = (interaction) => {
    const f = fState(db, interaction.guildId);
    if (f.channelId && interaction.channelId !== f.channelId) {
      return `⚽ Football Manager lives in <#${f.channelId}> — head over there.`;
    }
    return null;
  };

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
      if (id.startsWith('fm:shout:')) return;           // handled by the match collector

      const w = wrongChannel(interaction);
      if (w) return interaction.reply({ content: w, flags: 64 });

      // ── navigation ──
      const nav = {
        'fm:home':      () => homeView(db, gid, uid, getDinar),
        'fm:squad':     () => squadView(db, gid, uid),
        'fm:clubs':     () => clubsView(db, gid, uid, getDinar),
        'fm:market':    () => marketView(db, gid, uid, getDinar, posState.get(uid) || 'FWD'),
        'fm:tactics':   () => tacticsView(db, gid, uid),
        'fm:retainers': () => retainersView(db, gid, uid, getDinar),
        'fm:table':     () => tableView(db, gid),
      };
      if (interaction.isButton() && nav[id]) return interaction.update(nav[id]());

      // ── buy a club ──
      if (interaction.isStringSelectMenu() && id === 'fm:buyclub') {
        const r = doBuyClub(db, gid, uid, interaction.values[0], api);
        await interaction.update(clubsView(db, gid, uid, getDinar));
        return interaction.followUp({ content: r.msg, flags: 64 });
      }
      // ── market ──
      if (interaction.isStringSelectMenu() && id === 'fm:pos') {
        posState.set(uid, interaction.values[0]);
        return interaction.update(marketView(db, gid, uid, getDinar, interaction.values[0]));
      }
      if (interaction.isStringSelectMenu() && id.startsWith('fm:buy:')) {
        const r = doBuyPlayer(db, gid, uid, interaction.values[0], api);
        await interaction.update(marketView(db, gid, uid, getDinar, posState.get(uid) || id.split(':')[2]));
        return interaction.followUp({ content: r.msg, flags: 64 });
      }
      // ── tactics ──
      if (interaction.isStringSelectMenu() && id === 'fm:form') {
        const mgr = getManager(db, gid, uid); mgr.formation = interaction.values[0];
        mgr.cohesion = clamp(mgr.cohesion - 3, 0, 100); saveData(gid);
        return interaction.update(tacticsView(db, gid, uid));
      }
      if (interaction.isStringSelectMenu() && id === 'fm:ment') {
        const mgr = getManager(db, gid, uid); mgr.mentality = interaction.values[0]; saveData(gid);
        return interaction.update(tacticsView(db, gid, uid));
      }
      if (interaction.isStringSelectMenu() && id === 'fm:instr') {
        const [k, v] = interaction.values[0].split('|');
        const mgr = getManager(db, gid, uid); mgr.instr[k] = v; saveData(gid);
        return interaction.update(tacticsView(db, gid, uid));
      }
      // ── retainer top-up ──
      if (interaction.isStringSelectMenu() && id === 'fm:topup') {
        const AMOUNT = 50;
        const mgr = getManager(db, gid, uid);
        if (getDinar(db, gid, uid) < AMOUNT)
          return interaction.reply({ content: `You need ${money(AMOUNT)}.`, flags: 64 });
        const v = interaction.values[0];
        let target = null;
        if (v === 'club') target = mgr.clubAsset;
        else target = mgr.squad.find(p => p.uid === v.split('|')[1]);
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
              ({ label: `${p.name} — +${Math.floor((p.price||0)/2)} Dinar`, value: p.uid, description: `Rating ${p.rating}` }))))] });
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
        const f = fState(db, gid);
        const rivals = Object.entries(f.managers).filter(([id2, m2]) => id2 !== uid && m2.clubId);
        const rows = [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('fm:quick').setLabel('Quick Match (vs AI club)').setEmoji('🤖').setStyle(ButtonStyle.Success))];
        if (rivals.length) rows.push(new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder().setCustomId('fm:challenge').setPlaceholder('Challenge a manager…')
            .addOptions(rivals.slice(0,25).map(([id2, m2]) => {
              const c = clubById(m2.clubId);
              return { label: (c ? c.name : 'Club'), value: id2, description: `${m2.w}W ${m2.d}D ${m2.l}L` };
            }))));
        return interaction.reply({ content: '▶️ **Choose your opponent**', components: rows, flags: 64 });
      }
      if ((interaction.isButton() && id === 'fm:quick') || (interaction.isStringSelectMenu() && id === 'fm:challenge')) {
        const mgr = getManager(db, gid, uid);
        if (!mgr.clubId) return interaction.reply({ content: 'Buy a club first.', flags: 64 });
        if (liveMatches.has(gid)) return interaction.reply({ content: '⏳ A match is already running.', flags: 64 });
        const f = fState(db, gid);
        const home = ctxFor(db, gid, uid);
        let away, seat = { [uid]: 'H' };
        if (interaction.isButton()) {
          const free = CLUBS.filter(c => !f.clubOwner[c.id] && c.id !== mgr.clubId);
          away = makeAIContext(free.length ? pick(free) : CLUBS[0]);
        } else {
          const oid = interaction.values[0];
          away = ctxFor(db, gid, oid); seat[oid] = 'A';
          if (!away.club) return interaction.reply({ content: 'That manager has no club.', flags: 64 });
        }
        liveMatches.add(gid);
        await interaction.update({ content: '⚽ Kicking off in the channel…', components: [] }).catch(()=>{});
        const m = newMatch(home, away);
        try {
          await runLiveMatch(interaction.channel, m, seat, db, gid, saveData);
          recordResult(db, gid, m, api);
          const line = `**${m.home.club.name} ${m.hg} – ${m.ag} ${m.away.club.name}**`;
          await interaction.channel.send({ content: `🏁 ${line}` }).catch(()=>{});
        } catch (e) { console.error('[fm] match failed:', e.message); }
        finally { liveMatches.delete(gid); }
        return;
      }
    } catch (e) {
      console.error('[football] handler error:', e.message, (e.stack||'').split('\n')[1]);
      try {
        if (!interaction.replied && !interaction.deferred)
          await interaction.reply({ content: `⚠️ Something went wrong: ${e.message.slice(0,150)}`, flags: 64 });
      } catch { /* */ }
    }
  });

  console.log('⚽ Football Manager loaded');
  return { fState: (gid) => fState(db, gid) };
}

module.exports = {
  initFootball, getFootballCommands,
  // data
  CLUBS, clubById, REAL_PLAYERS, realById, FORMATIONS, FORMATION_KEYS,
  MENTALITIES, INSTRUCTIONS, SHOUTS, SQUAD_SIZE,
  // economy
  playerPrice, startRetainer, dailyDrain, retainerNow, setRetainer, topUpRetainer,
  daysLeft, isProtected,
  // state
  fState, getManager, ensureSquad, makePlaceholder, squadRating, lineRating, genName,
  // simulation (exported so behaviour can be tested without a live Discord client)
  newMatch, advance, matchFrameState, makeAIContext,
};
