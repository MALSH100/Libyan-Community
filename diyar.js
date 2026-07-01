// diyar.js — "Diyar" (ديار): a Libyan-themed, single-player-vs-everyone strategy
// game for Discord, inspired by Travian / Tribal Wars (async raiding) with a shared
// world-boss model. Players rule real Libyan cities on a rendered map, recruit troops
// and upgrade defenses with Dinar, raid rivals and neutral militias for loot/territory,
// and team up against nobody — every player is on their own. Boss threats appear at
// random times for solo damage races.
//
// Visuals are rendered locally with @resvg/resvg-js (no external API). Economy plugs
// into the existing Dinar system: upgrades/troops are a Dinar SINK, raids TRANSFER
// Dinar between players (no minting), and only modest capped city income + boss prizes
// mint new Dinar — so the game is, on balance, a sink.

const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  AttachmentBuilder, StringSelectMenuBuilder, PermissionFlagsBits,
} = require('discord.js');
const { getDinar, spendDinar, awardDinar } = require('./gacha');
const path = require('path');

// ─── Tuning ───────────────────────────────────────────────────────────────────
const STARTER_ARMY        = 40;
const TROOP_COST          = 1.5;                    // Dinar per troop
const SHIELD_MS           = 0;                     // truce disabled (no starting truce, no post-raid shield)
const ATTACK_COOLDOWN_MS  = 30 * 60 * 1000;     // between your own attacks
const RAID_WINDOW_MS      = 30 * 1000;          // PvP raids run live for 30s so the defender can rally
const REINFORCE_MULT      = 2.0;                // defence boost if the defender reinforces in time (bonus, never a penalty)
const LOOT_PCT            = 0.20;                  // share of a defender's Dinar stolen on a win (transfer, not minted)
const CAPTURE_RATIO       = 1.4;                   // must out-power a PLAYER city this much to seize it
const MATCH_BAND          = 3.0;                   // can't punch down: target strength must be ≥ yours / band
const LOOT_BY_LEVEL       = [0, 50, 80, 120];       // minted raid loot by city level (defender loses nothing)
const INCOME_BY_LEVEL     = [0, 15, 20, 40];       // Dinar/hour by city level (small/med/big)
const INCOME_CAP_HRS      = 12;                    // accrual caps at 12h, so you must collect
 const COLLECT_COOLDOWN_MS = 90 * 60 * 1000;       // can only collect once per 90 min
const UPG_MAX             = 10;
const UPG_BASE            = { mil: 240, for: 200, eco: 180 };   // cost = base × (level+1)
const TRIBUTE_BASE        = 40;                    // daily login reward (capped mint, async-friendly)
const TRIBUTE_PER_CITY    = 12;
const TRIBUTE_MAX         = 120;
const ARMOURY_BASE        = 360;                   // Dinar per weapon tier bought (cost = base × (tier+1))
const ARMOURY_MAX_TIER    = 3;                     // shop caps here; tiers 4–5 only from boss kills
// cost to forge the NEXT tier from `tier`; doubles once you're past tier 2
const armouryCost = (tier) => ARMOURY_BASE * (tier + 1) * (tier >= 2 ? 2 : 1);
const upgCost = (track, lvl) => UPG_BASE[track] * (lvl + 1) * (lvl >= 3 ? 2 : 1);   // steeper past level 3

// ─── Boss ───────────────────────────────────────────────────────────────────
const BOSS_DURATION_MS    = 6 * 3600 * 1000;      // time to defeat before it pillages
const BOSS_STRIKE_CD_MS   = 30 * 1000;            // per-player strike cooldown (30s)
const BOSS_HP             = 10000;                 // flat boss HP
const BOSS_HP_PER_PLAYER  = 0;                     // flat HP (raise this to scale with player count)
const BOSS_SPAWNS_PER_DAY = 2;
const BOSS_WIN_START      = 11;                    // Libya-time window for spawns
const BOSS_WIN_END        = 23;
const LIBYA_OFFSET_MS     = 2 * 3600 * 1000;       // UTC+2, no DST
const TICK_MS             = 60 * 1000;
const BOSS_DEFS = [
  { name: 'The Sandstorm Warlord', tag: 'A raider-king rides the dunes' },
  { name: 'The Sirte Corsairs',    tag: 'Sea-raiders strike the coast' },
  { name: 'The Fezzan Brigands',   tag: 'Desert bandits seize the south' },
  { name: 'The Iron Caravan',      tag: 'A mercenary host marches north' },
];

// ─── Cities (real Libyan locations; lon/lat drive the map projection) ──────────
const CITY_DEFS = [
  // ── Northwest & Nafusa (Tripolitania) ──
  { id: 'nalut',     name: 'Nalut',      lon: 10.98, lat: 31.87, level: 1 },
  { id: 'zuwara',    name: 'Zuwara',     lon: 12.08, lat: 32.93, level: 1 },
  { id: 'sabratha',  name: 'Sabratha',   lon: 12.49, lat: 32.79, level: 1 },
  { id: 'zawiya',    name: 'Zawiya',     lon: 12.73, lat: 32.76, level: 2 },
  { id: 'gharyan',   name: 'Gharyan',    lon: 13.02, lat: 32.17, level: 2 },
  { id: 'tripoli',   name: 'Tripoli',    lon: 13.19, lat: 32.89, level: 3 },
  { id: 'tarhuna',   name: 'Tarhuna',    lon: 13.63, lat: 32.44, level: 1 },
  { id: 'baniwalid', name: 'Bani Walid', lon: 13.99, lat: 31.76, level: 1 },
  { id: 'khoms',     name: 'Khoms',      lon: 14.26, lat: 32.65, level: 1 },
  { id: 'zliten',    name: 'Zliten',     lon: 14.57, lat: 32.47, level: 2 },
  { id: 'misrata',   name: 'Misrata',    lon: 15.09, lat: 32.38, level: 3 },
  // ── Central coast ──
  { id: 'sirte',     name: 'Sirte',      lon: 16.59, lat: 31.20, level: 2 },
  // ── Northeast (Cyrenaica) ──
  { id: 'benghazi',  name: 'Benghazi',   lon: 20.07, lat: 32.12, level: 3 },
  { id: 'ajdabiya',  name: 'Ajdabiya',   lon: 20.22, lat: 30.76, level: 2 },
  { id: 'marj',      name: 'Marj',       lon: 20.88, lat: 32.50, level: 1 },
  { id: 'bayda',     name: 'Bayda',      lon: 21.75, lat: 32.76, level: 2 },
  { id: 'derna',     name: 'Derna',      lon: 22.64, lat: 32.77, level: 2 },
  { id: 'tobruk',    name: 'Tobruk',     lon: 23.96, lat: 32.08, level: 2 },
  // ── South (Fezzan & desert) ──
  { id: 'ghat',      name: 'Ghat',       lon: 10.18, lat: 24.96, level: 1 },
  { id: 'ubari',     name: 'Ubari',      lon: 12.78, lat: 26.59, level: 1 },
  { id: 'murzuq',    name: 'Murzuq',     lon: 13.92, lat: 25.92, level: 1 },
  { id: 'sabha',     name: 'Sabha',      lon: 14.43, lat: 27.04, level: 2 },
  { id: 'waddan',    name: 'Waddan',     lon: 16.14, lat: 29.16, level: 1 },
  { id: 'jalu',      name: 'Jalu',       lon: 21.55, lat: 29.03, level: 1 },
  { id: 'kufra',     name: 'Kufra',      lon: 23.31, lat: 24.18, level: 1 },
];
const CITY_BY_ID = Object.fromEntries(CITY_DEFS.map(c => [c.id, c]));

// procedurally spread player colours around the hue wheel (golden angle) with alternating
// brightness — used only as overflow past the curated set below
function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const hx = x => Math.round(x * 255).toString(16).padStart(2, '0');
  return '#' + hx(f(0)) + hx(f(8)) + hx(f(4));
}
// hand-picked, maximally-distinct colours for a dark map (ordered most-distinct first);
// only one colour per hue family, so no "two blues / two greens" and no light-vs-dark pairs
const BASE_COLORS = [
  '#ff4136', // red
  '#0074ff', // blue
  '#2ecc40', // green
  '#ffdc00', // yellow
  '#ff5fd2', // magenta
  '#ff851b', // orange
  '#01d5d5', // cyan
  '#b967ff', // purple
  '#ffffff', // white
  '#a8e000', // lime
  '#8f7fff', // periwinkle
  '#ff9fb0', // light pink
  '#c9a26b', // tan
  '#5fd9a0', // seafoam
];
function playerColor(i) {
  if (i < BASE_COLORS.length) return BASE_COLORS[i];
  return hslToHex((i * 137.508) % 360, 82, [60, 72, 50][i % 3]);   // overflow past 14 players
}
const NEUTRAL = '#7f8c8d';
const COL_YOU   = '#3498db';   // your own cities on your private map (blue)
const COL_RIVAL = '#e74c3c';   // rival cities on your private map (red)
const COLOR   = { gold: 0xf1c40f, green: 0x2ecc71, red: 0xe74c3c, blue: 0x3498db, grey: 0x95a5a6 };
// Look for the font in the likely spots: repo root (where it currently lives),
// a fonts/ subfolder, and the working directory. First match wins.
const FONT_CANDIDATES = [
  path.join(__dirname, 'DejaVuSans.ttf'),
  path.join(__dirname, 'fonts', 'DejaVuSans.ttf'),
  path.join(process.cwd(), 'DejaVuSans.ttf'),
  path.join(process.cwd(), 'fonts', 'DejaVuSans.ttf'),
];
let _fontFile = undefined, _fontWarned = false;
function resolveFont() {
  if (_fontFile !== undefined) return _fontFile;
  const fs = require('fs');
  for (const p of FONT_CANDIDATES) { try { if (fs.existsSync(p)) { _fontFile = p; return p; } } catch {} }
  _fontFile = null;
  return null;
}

// ─── tiny utils ───────────────────────────────────────────────────────────────
const rnd   = (a, b) => a + Math.random() * (b - a);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const eph   = (extra) => ({ flags: 64, ...extra });
const fmt   = (n) => Math.round(n).toLocaleString('en-US');
const esc   = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

// ─── projection for the map ─────────────────────────────────────────────────
const LON_MIN = 9, LON_MAX = 25, LAT_MIN = 18.8, LAT_MAX = 33.7;
const MAP_W = 1080, MAP_H = 1000, MAP_PAD = 24;
const projX = (lon) => MAP_PAD + (lon - LON_MIN) / (LON_MAX - LON_MIN) * MAP_W;
const projY = (lat) => MAP_PAD + (LAT_MAX - lat) / (LAT_MAX - LAT_MIN) * MAP_H;
const BORDER = [
  [11.0,33.1],[12.7,32.9],[13.2,32.9],[14.6,32.5],[15.2,32.4],
  [16.6,31.2],[18.5,30.3],[19.8,30.4],[20.1,32.1],[21.0,32.9],
  [22.6,32.9],[24.0,32.1],[25.0,31.6],[25.0,22.0],[25.0,20.0],
  [24.0,19.5],[15.0,23.0],[14.0,23.0],[11.5,23.5],[10.0,24.5],
  [9.5,26.0],[9.3,30.0],[10.3,31.8],
];
// label nudges so the dense north-west cluster doesn't overlap
const LABEL_DX = { zuwara: -16, sabratha: -10, zawiya: -6, tripoli: 12, khoms: -8, zliten: 12, misrata: 16, gharyan: -10, tarhuna: 10, marj: 10, bayda: -4, benghazi: -10, derna: 10 };
const LABEL_DY = { zawiya: -2 };
const LABEL_BELOW = { zuwara: false, zawiya: false, khoms: false, marj: false, bayda: false };

function svgToPng(svg) {
  const { Resvg } = require('@resvg/resvg-js');
  const file = resolveFont();
  const font = { loadSystemFonts: true, defaultFontFamily: 'DejaVu Sans' };
  if (file) font.fontFiles = [file];
  else if (!_fontWarned) { _fontWarned = true; console.warn('⚠️ Diyar: DejaVuSans.ttf not found (looked in repo root, ./fonts, and cwd) — image text may not render. Commit DejaVuSans.ttf to the repo root.'); }
  return new Resvg(svg, { font }).render().asPng();
}

// ════════════════════════════════════════════════════════════════════════════
//  IMAGE RENDERERS
// ════════════════════════════════════════════════════════════════════════════
function renderMap(state, viewerId) {
  const W = MAP_W + MAP_PAD * 2;
  const poly = BORDER.map(([lo, la]) => `${projX(lo).toFixed(0)},${(projY(la) + 40).toFixed(0)}`).join(' ');

  let mine = 0, rival = 0, neutral = 0, nodes = '';
  for (const c of CITY_DEFS) {
    const city = state.cities[c.id];
    const owner = city.ownerId ? state.players[city.ownerId] : null;
    const isMine = !!viewerId && city.ownerId === viewerId;
    let col;
    if (!owner) { col = NEUTRAL; neutral++; }
    else if (isMine) { col = COL_YOU; mine++; }
    else if (viewerId) { col = COL_RIVAL; rival++; }
    else { col = owner.color; }
    const r = (owner ? 8 : 6) + city.level * 1.6;
    const x = projX(c.lon), y = projY(c.lat) + 40;
    // your own cities get a gold ring so your bases are unmistakable
    nodes += `<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${r.toFixed(1)}" fill="${col}" stroke="${isMine ? '#f1c40f' : '#ffffff'}" stroke-width="${isMine ? 3 : 1.5}"/>`;
    const below = LABEL_BELOW[c.id] !== undefined ? LABEL_BELOW[c.id] : true;
    const lyy = (below ? y + r + 14 : y - r - 7) + (LABEL_DY[c.id] || 0);
    const lxx = x + (LABEL_DX[c.id] || 0);
    nodes += `<text x="${lxx.toFixed(0)}" y="${lyy.toFixed(0)}" font-size="14" fill="#f5e9c8" text-anchor="middle">${esc(c.name)}</text>`;
  }

  // legend — wraps onto stacked rows so many owners never run off the edge
  const items = [];
  if (viewerId) {
    items.push([COL_YOU, `Your cities (${mine})`], [COL_RIVAL, `Rivals (${rival})`], [NEUTRAL, `Neutral (${neutral})`]);
  } else {
    items.push([NEUTRAL, 'Neutral']);
    const owners = Object.entries(state.players).map(([id, p]) => ({ p, n: p.cities.length }))
      .filter(o => o.n > 0).sort((a, b) => b.n - a.n);
    for (const o of owners.slice(0, 20)) items.push([o.p.color, `${o.p.name} (${o.n})`]);
  }
  const wOf = (label) => 34 + String(label).length * 7.8;
  const maxRowW = MAP_W - 8;
  const rows = [[]]; let rowW = 0;
  for (const it of items) {
    const w = wOf(it[1]);
    if (rowW + w > maxRowW && rows[rows.length - 1].length) { rows.push([]); rowW = 0; }
    rows[rows.length - 1].push(it); rowW += w;
  }
  const rowH = 24;
  const legendTopY = MAP_PAD + 40 + MAP_H + 30;
  const H = legendTopY + (rows.length - 1) * rowH + 16;
  let legend = `<text x="${MAP_PAD}" y="30" font-size="20" fill="#f1c40f">${viewerId ? 'Diyar — Your Realm' : 'Diyar — Map of Libya'}</text>`;
  rows.forEach((row, ri) => {
    let lx = MAP_PAD; const ly = legendTopY + ri * rowH;
    for (const [color, label] of row) {
      legend += `<rect x="${lx}" y="${ly - 11}" width="13" height="13" rx="2" fill="${color}"/><text x="${lx + 18}" y="${ly}" font-size="13" fill="#cbd3da">${esc(label)}</text>`;
      lx += wOf(label);
    }
  });

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="DejaVu Sans, sans-serif">
    <rect width="${W}" height="${H}" fill="#10243a"/>
    <polygon points="${poly}" fill="#cbb074" stroke="#8a6d3b" stroke-width="3"/>
    ${nodes}
    ${legend}
  </svg>`;
  return new AttachmentBuilder(svgToPng(svg), { name: 'diyar-map.png' });
}

function renderBoss(boss) {
  const W = 600, H = 300;
  const pct = clamp(boss.hp / boss.hpMax, 0, 1);
  const barW = W - 80;
  const minsLeft = Math.max(0, Math.round((boss.endsAt - Date.now()) / 60000));
  // a simple desert-raider figure (stylised, no external art), sized to sit below the title
  const figure = `
    <g transform="translate(${W/2},158)">
      <ellipse cx="0" cy="74" rx="58" ry="13" fill="#00000033"/>
      <rect x="-2.5" y="-80" width="5" height="62" fill="#9a7b4f"/>
      <path d="M-2.5,-80 l-18,24 l20,-5 Z" fill="#d7d7d7"/>
      <path d="M-40,66 L-26,-16 Q0,-42 26,-16 L40,66 Z" fill="#3b2f23"/>
      <circle cx="0" cy="-34" r="22" fill="#caa472"/>
      <path d="M-24,-44 Q0,-70 24,-44 L20,-32 Q0,-44 -20,-32 Z" fill="#7d2b1d"/>
      <circle cx="-8" cy="-36" r="3" fill="#1a1a1a"/><circle cx="8" cy="-36" r="3" fill="#1a1a1a"/>
    </g>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="DejaVu Sans, sans-serif">
    <rect width="${W}" height="${H}" fill="#2a1410"/>
    <rect width="${W}" height="${H}" fill="url(#g)" opacity="0.0"/>
    <text x="${W/2}" y="34" font-size="22" fill="#f1c40f" text-anchor="middle">${esc(boss.name)}</text>
    <text x="${W/2}" y="56" font-size="13" fill="#e8c9a0" text-anchor="middle">${esc(boss.tag)} — strike before it pillages!</text>
    ${figure}
    <rect x="40" y="${H-52}" width="${barW}" height="22" rx="11" fill="#3a3a3a"/>
    <rect x="40" y="${H-52}" width="${(barW*pct).toFixed(0)}" height="22" rx="11" fill="${pct>0.5?'#2ecc71':pct>0.25?'#f39c12':'#e74c3c'}"/>
    <text x="${W/2}" y="${H-36}" font-size="13" fill="#ffffff" text-anchor="middle">${fmt(Math.max(0,boss.hp))} / ${fmt(boss.hpMax)} HP   •   ${minsLeft} min left</text>
  </svg>`;
  return new AttachmentBuilder(svgToPng(svg), { name: 'diyar-boss.png' });
}

function renderBattle(r) {
  const W = 600, H = 220;
  const win = r.win;
  const banner = win ? 'VICTORY' : 'DEFEAT';
  const bcol = win ? '#2ecc71' : '#e74c3c';
  const line = (x, title, lines, col) => {
    let t = `<text x="${x}" y="96" font-size="17" fill="${col}" text-anchor="middle">${esc(title)}</text>`;
    lines.forEach((l, i) => { t += `<text x="${x}" y="${122 + i*22}" font-size="14" fill="#dfe6ec" text-anchor="middle">${esc(l)}</text>`; });
    return t;
  };
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="DejaVu Sans, sans-serif">
    <rect width="${W}" height="${H}" fill="#161b22"/>
    <rect x="0" y="0" width="${W}" height="46" fill="${bcol}"/>
    <text x="${W/2}" y="32" font-size="24" fill="#0b0e12" text-anchor="middle">${banner}</text>
    <text x="${W/2}" y="70" font-size="14" fill="#9aa6b2" text-anchor="middle">Raid on ${esc(r.cityName)}</text>
    ${line(W*0.27, r.attackerName, ['Sent ' + fmt(r.send), 'Lost ' + fmt(r.cas), 'Returned ' + fmt(r.survivors)], '#f1c40f')}
    <text x="${W/2}" y="120" font-size="22" fill="#5b6770" text-anchor="middle">VS</text>
    ${line(W*0.73, r.cityName + (r.defenderName ? ' ('+r.defenderName+')' : ' (Militia)'), ['Defence ' + fmt(r.defShown), r.captured ? 'CAPTURED!' : (r.win ? 'Raided' : 'Held'), r.stolen ? 'Looted ' + fmt(r.stolen) + ' Dinar' : 'No loot'], '#e8c9a0')}
  </svg>`;
  return new AttachmentBuilder(svgToPng(svg), { name: 'diyar-battle.png' });
}

// ════════════════════════════════════════════════════════════════════════════
//  STATE
// ════════════════════════════════════════════════════════════════════════════
function getState(db, guildId, saveData) {
  const data = db[guildId] || (db[guildId] = {});
  let dirty = false;
  if (!data.__diyar) {
    data.__diyar = { players: {}, cities: {}, boss: null, bossSched: null, channelId: null };
    dirty = true;
  }
  // seed (first run) or backfill (new cities added later) any CITY_DEFS not yet in state
  for (const c of CITY_DEFS) {
    if (!data.__diyar.cities[c.id]) {
      data.__diyar.cities[c.id] = {
        id: c.id, name: c.name, lon: c.lon, lat: c.lat, level: c.level,
        ownerId: null, npc: true, garrison: 20 + c.level * 18, lastIncomeAt: Date.now(),
      };
      dirty = true;
    }
  }
  // prune retired cities (removed from CITY_DEFS) that no one owns — keeps map and raids in sync
  const valid = new Set(CITY_DEFS.map(c => c.id));
  for (const id of Object.keys(data.__diyar.cities)) {
    if (!valid.has(id) && !data.__diyar.cities[id].ownerId) { delete data.__diyar.cities[id]; dirty = true; }
  }
  // give every player a distinct colour from the palette (by join order) so the map stays readable
  Object.keys(data.__diyar.players).forEach((id, i) => {
    const want = playerColor(i);
    if (data.__diyar.players[id].color !== want) { data.__diyar.players[id].color = want; dirty = true; }
  });
  if (dirty && saveData) saveData(guildId);
  return data.__diyar;
}

function ensurePlayer(state, userId, name, saveData, guildId) {
  let p = state.players[userId];
  if (p) { p.name = name || p.name; return { player: p, isNew: false }; }
  // assign a humble unowned city (prefer low level)
  const free = CITY_DEFS
    .map(c => state.cities[c.id])
    .filter(c => c.npc && !c.ownerId)
    .sort((a, b) => a.level - b.level);
  const start = free[0] || CITY_DEFS.map(c => state.cities[c.id]).filter(c => !c.ownerId)[0];
  // if every city is held, the newcomer still joins — landless — and must raid to seize one.

  const color = playerColor(Object.keys(state.players).length);
  p = {
    name, color, cities: start ? [start.id] : [], army: STARTER_ARMY, weaponTier: 0,
    upg: { mil: 0, for: 0, eco: 0 }, shieldUntil: Date.now() + SHIELD_MS, lastAttackAt: 0,
    lastStrikeAt: 0, joinedAt: Date.now(), lastTributeDay: '',
    stats: { raidsWon: 0, raidsLost: 0, defended: 0, captured: 0, lost: 0, bossKills: 0, bossDmg: 0 },
  };
  if (start) { start.ownerId = userId; start.npc = false; start.garrison = 25; start.lastIncomeAt = Date.now(); }
  state.players[userId] = p;
  if (saveData) saveData(guildId);
  return { player: p, isNew: true, startCity: start || null, landless: !start };
}

// reseed a knocked-out player (no cities) with a fresh starter next time they open the game
function reseedIfLanded(state, userId) {
  const p = state.players[userId];
  if (!p || p.cities.length > 0) return null;
  const free = CITY_DEFS.map(c => state.cities[c.id]).filter(c => !c.ownerId).sort((a,b)=>a.level-b.level);
  const start = free[0];
  if (!start) return null;
  start.ownerId = userId; start.npc = false; start.garrison = 25; start.lastIncomeAt = Date.now();
  p.cities.push(start.id); p.shieldUntil = Date.now() + SHIELD_MS;
  return start;
}

const ownedCities = (state, userId) => state.players[userId]?.cities.map(id => state.cities[id]).filter(Boolean) || [];

function playerStrength(state, p) {
  if (!p) return 0;
  const garr = ownedCities(state, findId(state, p)).reduce((s, c) => s + c.garrison, 0);
  const upg = p.upg.mil + p.upg.for + p.upg.eco;
  return p.army + garr + p.cities.length * 25 + upg * 12 + p.weaponTier * 15;
}
const findId = (state, p) => Object.keys(state.players).find(id => state.players[id] === p);

function pendingIncome(state, city) {
  if (!city.ownerId) return 0;
  const owner = state.players[city.ownerId];
  const rate = INCOME_BY_LEVEL[city.level] * (1 + (owner ? owner.upg.eco * 0.12 : 0)); // per hour
  const hrs = clamp((Date.now() - city.lastIncomeAt) / 3600000, 0, INCOME_CAP_HRS);
  return Math.floor(rate * hrs);
}

// ════════════════════════════════════════════════════════════════════════════
//  ACTIONS  (pure-ish; mutate state, return a result)
// ════════════════════════════════════════════════════════════════════════════
// troops get pricier the more land you hold, so sprawling empires are costlier to defend
function troopCost(state, userId) {
  const n = ownedCities(state, userId).length;
  if (n === 0) return 1;      // landless — cheapest
  if (n <= 2) return 1.5;     // 1–2 cities — standard
  return 3;                   // 3+ cities — expensive
}

function recruit(state, db, guildId, saveData, userId, n) {
  const p = state.players[userId];
  const cost = Math.round(n * troopCost(state, userId));
  if (getDinar(db, guildId, userId) < cost) return { ok: false, cost };
  spendDinar(db, guildId, userId, cost, saveData);
  p.army += n;
  saveData(guildId);
  return { ok: true, cost, army: p.army };
}

function upgrade(state, db, guildId, saveData, userId, track) {
  const p = state.players[userId];
  const lvl = p.upg[track];
  if (lvl >= UPG_MAX) return { ok: false, maxed: true };
  const cost = upgCost(track, lvl);
  if (getDinar(db, guildId, userId) < cost) return { ok: false, cost };
  spendDinar(db, guildId, userId, cost, saveData);
  p.upg[track]++;
  saveData(guildId);
  return { ok: true, cost, level: p.upg[track] };
}

function reinforce(state, saveData, guildId, userId, cityId, amt) {
  const p = state.players[userId];
  const city = state.cities[cityId];
  if (!city || city.ownerId !== userId) return { ok: false };
  amt = Math.min(amt, p.army);
  if (amt < 1) return { ok: false, noTroops: true };
  p.army -= amt; city.garrison += amt;
  saveData(guildId);
  return { ok: true, moved: amt, garrison: city.garrison };
}

function collectIncome(state, db, guildId, saveData, userId) {
  let total = 0;
  for (const city of ownedCities(state, userId)) {
    total += pendingIncome(state, city);
    city.lastIncomeAt = Date.now();
  }
  if (total > 0) awardDinar(db, guildId, userId, total, saveData);   // modest, capped mint
  saveData(guildId);
  return total;
}

// daily login reward — small capped mint; favours async / weaker players keeping pace
function claimTribute(state, db, guildId, saveData, userId) {
  const p = state.players[userId]; if (!p) return 0;
  const today = libyaDay(Date.now()).dateStr;
  if (p.lastTributeDay === today) return 0;
  const amount = Math.min(TRIBUTE_BASE + ownedCities(state, userId).length * TRIBUTE_PER_CITY, TRIBUTE_MAX);
  p.lastTributeDay = today;
  awardDinar(db, guildId, userId, amount, saveData);
  saveData(guildId);
  return amount;
}

// buy a weapon tier with Dinar (a Dinar sink); shop caps below the boss-only top tiers
function buyWeapon(state, db, guildId, saveData, userId) {
  const p = state.players[userId]; if (!p) return { error: 'Not found.' };
  if (p.weaponTier >= ARMOURY_MAX_TIER) return { error: `The armoury forges up to tier ${ARMOURY_MAX_TIER}. Higher tiers are won by defeating bosses.` };
  const cost = armouryCost(p.weaponTier);
  if (!spendDinar(db, guildId, userId, cost, saveData)) return { error: `Not enough Dinar (need ${fmt(cost)}).` };
  p.weaponTier++;
  saveData(guildId);
  return { ok: true, cost, tier: p.weaponTier };
}

// returns {error} or a full battle result for rendering
// the real defensive strength of a city (garrison + walls + city-size bonus) — shown everywhere so
// the dropdown, the confirm and the result all agree instead of the old raw-garrison number
function effectiveDefence(state, city, reinforceMult) {
  const owner = city.ownerId ? state.players[city.ownerId] : null;
  const dMultBase = 1 + (owner ? owner.upg.for * 0.15 : 0) + city.level * 0.1;
  const lastStand = (owner && owner.cities.length === 1) ? 1.5 : 1.0;
  return Math.round((city.garrison * dMultBase * lastStand + city.level * 8) * (reinforceMult || 1));
}
// the real attack strength of a force (troops + weapon tier + military upgrades)
function effectiveAttack(attacker, send) {
  return Math.round(send * (1 + attacker.weaponTier * 0.15 + attacker.upg.mil * 0.12));
}

// validate a raid and lock the committed troops; returns {error} or {pending}
function startRaid(state, db, guildId, saveData, attackerId, cityId, sendPct) {
  const attacker = state.players[attackerId];
  const city = state.cities[cityId];
  if (!attacker || !city) return { error: 'Not found.' };
  if (city.ownerId === attackerId) return { error: 'You already rule that city.' };
  const now = Date.now();
  if (now - attacker.lastAttackAt < ATTACK_COOLDOWN_MS)
    return { error: `Your army is regrouping. Ready in ${msLeft(attacker.lastAttackAt + ATTACK_COOLDOWN_MS)}.` };
  if (state.pendingRaids && Object.values(state.pendingRaids).some(p => p.cityId === cityId))
    return { error: 'That city is already under attack — wait for the current raid to finish.' };

  const owner = city.ownerId ? state.players[city.ownerId] : null;
  if (owner) {
    if (owner.shieldUntil > now) return { error: `${owner.name} is under truce for ${msLeft(owner.shieldUntil)}.` };
    if (playerStrength(state, owner) * MATCH_BAND < playerStrength(state, attacker))
      return { error: `${owner.name} is far weaker than you — no honour in that raid. Pick someone your size (neutral militias are always fair game).` };
  }

  const send = Math.floor(attacker.army * sendPct);
  if (send < 1) return { error: 'You have no troops to send. Recruit an army first.' };
  attacker.army -= send;         // lock the committed troops for the duration of the raid
  attacker.lastAttackAt = now;   // cooldown starts at commit
  if (saveData) saveData(guildId);
  return { pending: {
    attackerId, attackerName: attacker.name, cityId, cityName: city.name,
    defenderId: city.ownerId, defenderName: owner ? owner.name : null, send, startedAt: now,
  } };
}

// resolve a locked raid (optionally boosted by a defender reinforcement) and apply loot/capture/casualties
function resolveRaid(state, db, guildId, saveData, pending, reinforceMult) {
  const attacker = state.players[pending.attackerId];
  const city = state.cities[pending.cityId];
  const send = pending.send;
  if (!attacker) return null;
  if (!city) { attacker.army += send; return null; }   // city vanished — refund troops
  const now = Date.now();
  const owner = city.ownerId ? state.players[city.ownerId] : null;
  const garrisonBefore = city.garrison;
  const rMult = reinforceMult || 1;

  const aMult = 1 + attacker.weaponTier * 0.15 + attacker.upg.mil * 0.12;
  const aPow = send * aMult * rnd(0.85, 1.15);
  const dMultBase = 1 + (owner ? owner.upg.for * 0.15 : 0) + city.level * 0.1;
  const lastStand = (owner && owner.cities.length === 1) ? 1.5 : 1.0;
  const dPow = (city.garrison * dMultBase * lastStand + city.level * 8) * rMult * rnd(0.85, 1.15);
  const win = aPow > dPow;

  const result = {
    attackerId: pending.attackerId, attackerName: pending.attackerName, cityId: city.id, cityName: city.name,
    defenderId: city.ownerId, defenderName: owner ? owner.name : (pending.defenderName || null),
    send, win, reinforced: rMult > 1,
    defShown: effectiveDefence(state, city, rMult), atkShown: effectiveAttack(attacker, send),
    cas: 0, survivors: 0, stolen: 0, captured: false,
  };

  if (win) {
    const cas = Math.round(send * clamp(dPow / aPow, 0, 1) * 0.4);
    let survivors = send - cas;
    const stolen = LOOT_BY_LEVEL[city.level] || LOOT_BY_LEVEL[1];   // minted; defender loses nothing
    awardDinar(db, guildId, pending.attackerId, stolen, saveData);
    result.stolen = stolen;
    if (owner) { owner.cities = owner.cities.filter(id => id !== city.id); owner.stats.lost++; }
    city.ownerId = pending.attackerId; city.npc = false;
    attacker.cities.push(city.id);
    const g = Math.round(survivors * 0.35);
    city.garrison = g; survivors -= g; city.lastIncomeAt = now;
    attacker.stats.captured++; result.captured = true;
    result.defLoss = garrisonBefore;   // defender lost the whole garrison with the city
    attacker.army += survivors;
    attacker.stats.raidsWon++;
    result.cas = cas; result.survivors = survivors;
  } else {
    const cas = Math.round(send * clamp(aPow / dPow, 0, 1) * 0.6);
    const survivors = send - cas;
    city.garrison = Math.max(0, city.garrison - Math.round(city.garrison * clamp(aPow / dPow, 0, 1) * 0.4));
    result.defLoss = garrisonBefore - city.garrison;   // defenders still bleed troops even in victory
    attacker.army += survivors;
    attacker.stats.raidsLost++;
    if (owner) owner.stats.defended++;
    result.cas = cas; result.survivors = survivors;
  }
  if (owner) owner.shieldUntil = now + SHIELD_MS;
  if (saveData) saveData(guildId);
  return result;
}

// instant raid (neutral militias, and the compatibility path used by tests)
function resolveAttack(state, db, guildId, saveData, attackerId, cityId, sendPct) {
  const r = startRaid(state, db, guildId, saveData, attackerId, cityId, sendPct);
  if (r.error) return r;
  return resolveRaid(state, db, guildId, saveData, r.pending, 1);
}

const raidBar = (val, max) => { const n = Math.max(0, Math.min(12, Math.round(val / (max || 1) * 12))); return '🟥'.repeat(n) + '⬛'.repeat(12 - n); };

// the live 30s countdown embed shown in the war room while a PvP raid plays out
function raidLiveEmbed(state, raid, secsLeft) {
  const city = state.cities[raid.cityId];
  const atkP = effectiveAttack(state.players[raid.attackerId] || { weaponTier: 0, upg: { mil: 0 } }, raid.send);
  const defP = effectiveDefence(state, city, raid.reinforced ? REINFORCE_MULT : 1);
  // progress anchored to when the message appeared; reaches 1 at 85% of the window so the bars
  // visibly finish a few seconds BEFORE the result is announced (never mid-drain at the reveal)
  const elapsed = raid.animStart ? (Date.now() - raid.animStart) : 0;
  const f = clamp(elapsed / (RAID_WINDOW_MS * 0.85), 0, 1);
  // asymmetric attrition: each side wears the other down by the enemy's strength, so the stronger
  // side keeps a longer bar. Early drain is gentle, so the first frame the viewer sees looks full.
  const DRAIN = 0.55;
  const atkNow = Math.max(0, Math.round(atkP - defP * f * DRAIN));
  const defNow = Math.max(0, Math.round(defP - atkP * f * DRAIN));
  const mx = Math.max(atkP, defP, 1);
  const status = raid.reinforced
    ? `🛡️ **Reinforced!** The garrison rallies. ⏳ **${secsLeft}s** left…`
    : `⏳ **${secsLeft}s** left — defender, hit **🛡 Send Reinforcements** to rally your garrison!`;
  const desc =
    `**${raid.attackerName}** storms **${city.name}**${raid.defenderName ? ` — held by **${raid.defenderName}**` : ''}!\n\n` +
    `⚔ Attackers\n\`${raidBar(atkNow, mx)}\` **${fmt(atkNow)}**\n\n` +
    `🛡 Defenders\n\`${raidBar(defNow, mx)}\` **${fmt(defNow)}**${raid.reinforced ? '  🛡️' : ''}\n\n${status}`;
  return new EmbedBuilder().setColor(raid.reinforced ? COLOR.blue : COLOR.red).setTitle(`⚔ Battle for ${city.name}`).setDescription(desc);
}

// the final result — coloured title, attacker on the left, defender on the right
function raidResultEmbed(r) {
  const won = r.win;
  const title = won ? '⚔   R A I D   V I C T O R Y   ⚔' : '🛡   R A I D   D E F E N D E D   🛡';
  const subtitle = won
    ? (r.captured ? `**${r.attackerName}** captured **${r.cityName}**!` : `**${r.attackerName}** raided **${r.cityName}** and pulled back.`)
    : `**${r.defenderName || 'The militia'}** held **${r.cityName}**!`;
  const atkField = [
    `Troops sent: **${fmt(r.send)}**`,
    `Attack power: **${fmt(r.atkShown)}**`,
    `Troops lost: **${fmt(r.cas)}**`,
    `Returned home: **${fmt(r.survivors)}**`,
    `Loot: **${won ? '+' + fmt(r.stolen) : '0'}** 💰`,
  ].join('\n');
  const defField = [
    `Defence power: **${fmt(r.defShown)}**${r.reinforced ? ' 🛡️' : ''}`,
    `Troops lost: **${fmt(r.defLoss || 0)}**`,
    `Reinforced: **${r.reinforced ? 'yes' : 'no'}**`,
    `City: **${won ? 'LOST ❌' : 'HELD ✅'}**`,
  ].join('\n');
  return new EmbedBuilder()
    .setColor(won ? COLOR.green : COLOR.red)
    .setTitle(title)
    .setDescription(subtitle)
    .addFields(
      { name: `⚔ Attacker · ${r.attackerName}`, value: atkField, inline: true },
      { name: `🛡 Defender · ${r.defenderName || 'Militia'}`, value: defField, inline: true },
    );
}

function reinforceRow(raidId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`dy:reinf:${raidId}`).setLabel('🛡 Send Reinforcements').setStyle(ButtonStyle.Success));
}

// ─── Boss ─────────────────────────────────────────────────────────────────
function spawnBoss(state, saveData, guildId) {
  if (state.boss) return null;
  const def = BOSS_DEFS[Math.floor(Math.random() * BOSS_DEFS.length)];
  const hpMax = BOSS_HP;
  const owned = CITY_DEFS.map(c => state.cities[c.id]).filter(c => c.ownerId);
  const target = owned.length ? owned[Math.floor(Math.random() * owned.length)] : null;
  state.boss = {
    name: def.name, tag: def.tag, hpMax, hp: hpMax, spawnedAt: Date.now(), endsAt: Date.now() + BOSS_DURATION_MS,
    damage: {}, targetCityId: target ? target.id : null, channelId: state.channelId, messageId: null,
  };
  if (saveData) saveData(guildId);
  return state.boss;
}

function strikeBoss(state, saveData, guildId, userId) {
  const b = state.boss;
  if (!b) return { error: 'No threat is active right now.' };
  if (b.hp <= 0) return { error: 'The enemy is already falling — the spoils are being tallied.' };
  const p = state.players[userId];
  if (!p) return { error: 'Join the game first with /diyar.' };
  const now = Date.now();
  if (now - p.lastStrikeAt < BOSS_STRIKE_CD_MS) return { error: `You're rallying troops. Strike again in ${msLeft(p.lastStrikeAt + BOSS_STRIKE_CD_MS)}.` };
  const dmg = Math.round((p.army * (1 + p.upg.mil * 0.1 + p.weaponTier * 0.15) + 50) * rnd(0.8, 1.2));
  b.hp -= dmg;
  b.damage[userId] = (b.damage[userId] || 0) + dmg;
  p.lastStrikeAt = now;
  p.stats.bossDmg += dmg;
  const killed = b.hp <= 0;
  if (saveData) saveData(guildId);
  return { dmg, killed, hpLeft: Math.max(0, b.hp), total: b.damage[userId] };
}

function resolveBossDefeat(state, db, guildId, saveData) {
  const b = state.boss; if (!b) return null;
  const ranked = Object.entries(b.damage).sort((a, b2) => b2[1] - a[1]);
  const rewards = [];
  ranked.forEach(([uid, dmg], i) => {
    const p = state.players[uid]; if (!p) return;
    let dinar = 0, lp = 0, weapon = false;
    if (i === 0)      { dinar = 250; lp = 30; weapon = p.weaponTier < 5; p.stats.bossKills++; }
    else if (i === 1) { dinar = 150; lp = 18; }
    else if (i === 2) { dinar = 90; lp = 12; }
    else              { dinar = 40; lp = 5; }
    if (weapon) p.weaponTier++;
    awardDinar(db, guildId, uid, dinar, saveData);
    rewards.push({ uid, name: p.name, dmg, dinar, lp, weapon });
  });
  state.boss = null;
  if (saveData) saveData(guildId);
  return { rewards };
}

function resolveBossExpire(state, db, guildId, saveData) {
  const b = state.boss; if (!b) return null;
  const city = b.targetCityId ? state.cities[b.targetCityId] : null;
  let razed = null;
  if (city && city.ownerId) {
    const owner = state.players[city.ownerId];
    const looted = Math.min(Math.round(getDinar(db, guildId, city.ownerId) * 0.1), getDinar(db, guildId, city.ownerId));
    if (looted > 0) spendDinar(db, guildId, city.ownerId, looted, saveData);
    const before = city.garrison;
    city.garrison = Math.round(city.garrison * 0.3);
    razed = { city: city.name, owner: owner ? owner.name : null, looted, garrisonLost: before - city.garrison };
  }
  state.boss = null;
  if (saveData) saveData(guildId);
  return { razed, name: b.name };
}

// ─── Boss scheduler (persistent, survives redeploys — same model as spawns) ──
function libyaDay(nowMs) {
  const lib = new Date(nowMs + LIBYA_OFFSET_MS);
  const startOfDayUTC = Date.UTC(lib.getUTCFullYear(), lib.getUTCMonth(), lib.getUTCDate()) - LIBYA_OFFSET_MS;
  const dateStr = `${lib.getUTCFullYear()}-${String(lib.getUTCMonth() + 1).padStart(2,'0')}-${String(lib.getUTCDate()).padStart(2,'0')}`;
  return { dateStr, startOfDayUTC };
}
function pickTimes(startMs, endMs, count, minGapMs) {
  const win = endMs - startMs; if (win <= 0 || count <= 0) return [];
  let gap = minGapMs; if (win - (count - 1) * gap < 0) gap = Math.floor(win / count);
  const free = Math.max(0, win - (count - 1) * gap);
  const offs = Array.from({ length: count }, () => Math.random() * free).sort((a, b) => a - b);
  return offs.map((o, i) => Math.round(startMs + o + i * gap));
}
function ensureBossSched(state, saveData, guildId, nowMs) {
  const { dateStr, startOfDayUTC } = libyaDay(nowMs);
  if (!state.bossSched || state.bossSched.date !== dateStr) {
    const ws = startOfDayUTC + BOSS_WIN_START * 3600000;
    const we = startOfDayUTC + BOSS_WIN_END * 3600000;
    const eff = Math.max(ws, nowMs);
    const spawns = (we - eff > 5 * 60000) ? pickTimes(eff, we, BOSS_SPAWNS_PER_DAY, 150 * 60000).map(at => ({ at, fired: false })) : [];
    state.bossSched = { date: dateStr, spawns };
    if (saveData) saveData(guildId);
  }
  return state.bossSched;
}

// ════════════════════════════════════════════════════════════════════════════
//  UI
// ════════════════════════════════════════════════════════════════════════════
function msLeft(ts) {
  const ms = Math.max(0, ts - Date.now());
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60), m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function navButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('dy:map').setLabel('🗺 Map').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('dy:city').setLabel('🏰 My Cities').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('dy:attack').setLabel('⚔ Attack').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('dy:army').setLabel('🪖 Army').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('dy:collect').setLabel('💰 Collect').setStyle(ButtonStyle.Success),
  );
}
const backRow = () => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId('dy:home').setLabel('🏠 Back').setStyle(ButtonStyle.Secondary));

function dashboard(state, db, guildId, userId) {
  const p = state.players[userId];
  const cities = ownedCities(state, userId);
  const income = cities.reduce((s, c) => s + pendingIncome(state, c), 0);
  const garr = cities.reduce((s, c) => s + c.garrison, 0);
  const dinar = getDinar(db, guildId, userId);
  const shield = p.shieldUntil > Date.now() ? `  •  🛡 Truce: ${msLeft(p.shieldUntil)}` : '';
  const boss = state.boss ? `\n\n👹 **${state.boss.name}** is loose — open **Attack → Boss** or use the strike button in the war room!` : '';
  const embed = new EmbedBuilder().setColor(COLOR.gold)
    .setTitle(`⚔ Diyar — ${p.name}`)
    .setDescription(
      `**${cities.length}** cit${cities.length === 1 ? 'y' : 'ies'} • **${fmt(dinar)}** Dinar\n` +
      `🪖 Army: **${fmt(p.army)}**  •  🏰 Garrisons: **${fmt(garr)}**\n` +
      `🗡 Weapon tier **${p.weaponTier}**  •  Military **${p.upg.mil}** / Walls **${p.upg.for}** / Economy **${p.upg.eco}**\n` +
      `💰 Uncollected income: **${fmt(income)}**${shield}` + boss)
    .setFooter({ text: 'Raids steal Dinar from rivals • capture cities to grow' });
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('dy:upgrade').setLabel('⬆ Upgrades').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('dy:armoury').setLabel('🗡 Armoury').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('dy:reinforce').setLabel('🛡 Reinforce').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('dy:leaderboard').setLabel('🏆 Ranks').setStyle(ButtonStyle.Secondary),
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('dy:profile').setLabel('📜 Profile').setStyle(ButtonStyle.Secondary),
    ...(state.boss ? [new ButtonBuilder().setCustomId('dy:boss').setLabel('👹 Boss').setStyle(ButtonStyle.Danger)] : []),
  );
  return { embeds: [embed], components: [navButtons(), row2, row3] };
}

function cityView(state, db, guildId, userId) {
  const cities = ownedCities(state, userId);
  const lines = cities.map(c => `**${c.name}** — Lv ${c.level} • 🛡 ${fmt(c.garrison)} garrison • 💰 ${fmt(pendingIncome(state, c))} ready`);
  const embed = new EmbedBuilder().setColor(COLOR.blue)
    .setTitle('🏰 My Cities')
    .setDescription(lines.join('\n') || 'You hold no cities right now — reopen the game to be resettled.')
    .setFooter({ text: 'Reinforce moves army troops into a city to defend it' });
  return { embeds: [embed], components: [backRow()] };
}

function armyView(state, db, guildId, userId) {
  const p = state.players[userId];
  const dinar = getDinar(db, guildId, userId);
  const unit = troopCost(state, userId);
  const nCities = ownedCities(state, userId).length;
  const why = nCities === 0
    ? `You hold **no cities**, so troops are cheapest at **${unit} Dinar** each.`
    : nCities <= 2
      ? `You hold **${nCities}** cit${nCities === 1 ? 'y' : 'ies'}, so troops cost **${unit} Dinar** each.`
      : `You hold **${nCities}** cities. Holding **3 or more** makes each troop cost **${unit} Dinar** — a large realm is expensive to raise armies for.`;
  const embed = new EmbedBuilder().setColor(COLOR.gold)
    .setTitle('🪖 Recruit Army')
    .setDescription(`Army: **${fmt(p.army)}**  •  Dinar: **${fmt(dinar)}**\nEach troop costs **${unit} Dinar**.\n\n*${why}*`);
  const mk = (n) => new ButtonBuilder().setCustomId(`dy:recruit:${n}`).setLabel(`+${n} (${Math.round(n * unit)}💰)`).setStyle(ButtonStyle.Success).setDisabled(dinar < Math.round(n * unit));
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(mk(10), mk(50), mk(100), mk(250)), backRow()] };
}

function upgradeView(state, db, guildId, userId) {
  const p = state.players[userId];
  const dinar = getDinar(db, guildId, userId);
  const row = (track, label, desc) => {
    const lvl = p.upg[track];
    const cost = upgCost(track, lvl);
    const maxed = lvl >= UPG_MAX;
    return { field: `${label} — Lv ${lvl}/${UPG_MAX}\n${desc}${maxed ? ' • *maxed*' : ` • next: **${cost}💰**`}`,
      btn: new ButtonBuilder().setCustomId(`dy:upg:${track}`).setLabel(`${label} ${maxed ? 'MAX' : '→ ' + (lvl + 1)}`).setStyle(ButtonStyle.Primary).setDisabled(maxed || dinar < cost) };
  };
  const mil = row('mil', '⚔ Military', 'Stronger attacks');
  const fr  = row('for', '🛡 Walls', 'Tougher defense');
  const eco = row('eco', '💰 Economy', 'More income, less loot stolen');
  const embed = new EmbedBuilder().setColor(COLOR.blue).setTitle('⬆ Upgrades')
    .setDescription(`Dinar: **${fmt(dinar)}**\n\n${mil.field}\n\n${fr.field}\n\n${eco.field}`);
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(mil.btn, fr.btn, eco.btn), backRow()] };
}

function armouryView(state, db, guildId, userId) {
  const p = state.players[userId];
  const dinar = getDinar(db, guildId, userId);
  const atShopMax = p.weaponTier >= ARMOURY_MAX_TIER;
  const cost = armouryCost(p.weaponTier);
  const bonus = (t) => `+${Math.round(t * 15)}% attack power`;
  const embed = new EmbedBuilder().setColor(COLOR.gold).setTitle('🗡 Armoury')
    .setDescription(
      `Dinar: **${fmt(dinar)}**\n\n` +
      `Current weapon: **tier ${p.weaponTier}** (${bonus(p.weaponTier)})\n\n` +
      (atShopMax
        ? `The smiths have done all they can — **tiers ${ARMOURY_MAX_TIER + 1}–5** are forged only from the spoils of slain bosses.`
        : `Forge **tier ${p.weaponTier + 1}** (${bonus(p.weaponTier + 1)}) for **${fmt(cost)}💰**.`))
    .setFooter({ text: 'Better weapons raise both raid power and boss damage' });
  const buy = new ButtonBuilder().setCustomId('dy:buyweapon')
    .setLabel(atShopMax ? `Maxed (tier ${ARMOURY_MAX_TIER})` : `Forge tier ${p.weaponTier + 1} (${fmt(cost)}💰)`)
    .setStyle(ButtonStyle.Success).setDisabled(atShopMax || dinar < cost);
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(buy), backRow()] };
}

function targetSelect(state, userId) {
  const me = state.players[userId];
  const myStr = playerStrength(state, me);
  const opts = [];
  for (const c of CITY_DEFS) {
    const city = state.cities[c.id];
    if (city.ownerId === userId) continue;
    if (state.pendingRaids && Object.values(state.pendingRaids).some(p => p.cityId === c.id)) continue;   // already under attack
    const owner = city.ownerId ? state.players[city.ownerId] : null;
    let note;
    if (!owner) note = `Militia • Lv ${city.level} • 🛡${fmt(effectiveDefence(state, city))} def`;
    else if (owner.shieldUntil > Date.now()) continue;                       // shielded → hide
    else if (playerStrength(state, owner) * MATCH_BAND < myStr) continue;     // too weak → hide
    else note = `${owner.name} • Lv ${city.level} • 🛡${fmt(effectiveDefence(state, city))} def`;
    opts.push({ label: city.name, description: note, value: c.id });
  }
  if (!opts.length) {
    return { embeds: [new EmbedBuilder().setColor(COLOR.grey).setTitle('⚔ Attack')
      .setDescription('No reachable targets right now — rivals must be near your strength, and neutral militias are always fair game when any remain.')], components: [backRow()] };
  }
  // Discord caps each dropdown at 25 options and we have more cities than that,
  // so spread targets across multiple dropdowns — otherwise the overflow vanishes from raids.
  const rows = [];
  for (let i = 0; i < opts.length && rows.length < 4; i += 25) {
    const chunk = opts.slice(i, i + 25);
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(i === 0 ? 'dy:atk_target' : `dy:atk_target:${i}`)
        .setPlaceholder(`Raid a city  (${chunk[0].label} … ${chunk[chunk.length - 1].label})`)
        .addOptions(chunk)));
  }
  rows.push(backRow());
  return { embeds: [new EmbedBuilder().setColor(COLOR.red).setTitle('⚔ Choose your target')
    .setDescription('Pick a city to raid. Neutral militias are always fair game; rivals must be near your strength.')],
    components: rows };
}

function sendAmount(state, userId, cityId) {
  const p = state.players[userId];
  const city = state.cities[cityId];
  const half = Math.floor(p.army * 0.5);
  const embed = new EmbedBuilder().setColor(COLOR.red).setTitle(`⚔ Raid ${city.name}?`)
    .setDescription(`Your army: **${fmt(p.army)}**\nDefenders: 🛡 **${fmt(city.garrison)}** (Lv ${city.level})\n\nHow many troops do you commit?`);
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`dy:atk:${cityId}:50`).setLabel(`Send Half (${fmt(half)})`).setStyle(ButtonStyle.Danger).setDisabled(half < 1),
    new ButtonBuilder().setCustomId(`dy:atk:${cityId}:100`).setLabel(`Send All (${fmt(p.army)})`).setStyle(ButtonStyle.Danger).setDisabled(p.army < 1),
  ), backRow()] };
}

function reinforceSelect(state, userId) {
  const p = state.players[userId];
  if (p.army < 1) return { embeds: [new EmbedBuilder().setColor(COLOR.grey).setTitle('🛡 Reinforce').setDescription('No troops in reserve to station. Recruit an army first.')], components: [backRow()] };
  const cities = ownedCities(state, userId);
  if (!cities.length) return { embeds: [new EmbedBuilder().setColor(COLOR.grey).setTitle('🛡 Reinforce').setDescription('You hold no cities.')], components: [backRow()] };
  const menu = new StringSelectMenuBuilder().setCustomId('dy:rf_pick').setPlaceholder('Choose a city to reinforce…')
    .addOptions(cities.slice(0, 25).map(c => ({ label: c.name, description: `Lv ${c.level} • 🛡${fmt(c.garrison)} now`, value: c.id })));
  return { embeds: [new EmbedBuilder().setColor(COLOR.blue).setTitle('🛡 Reinforce your cities')
    .setDescription(`You have **${fmt(p.army)}** troops in reserve to divvy up. Pick a city, choose how many to send there, then come back and split the rest across your other cities.`)],
    components: [new ActionRowBuilder().addComponents(menu), backRow()] };
}

function reinforceAmount(state, userId, cityId) {
  const p = state.players[userId];
  const city = state.cities[cityId];
  if (!city || city.ownerId !== userId) return reinforceSelect(state, userId);
  const amtRow = new ActionRowBuilder().addComponents(
    ...[10, 50, 100].map(n => new ButtonBuilder().setCustomId(`dy:rf_do:${cityId}:${n}`).setLabel(`+${n}`).setStyle(ButtonStyle.Success).setDisabled(p.army < n)),
    new ButtonBuilder().setCustomId(`dy:rf_do:${cityId}:all`).setLabel(`All (${fmt(p.army)})`).setStyle(ButtonStyle.Success).setDisabled(p.army < 1));
  const navRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('dy:reinforce').setLabel('↩ Another city').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('dy:home').setLabel('🏠 Done').setStyle(ButtonStyle.Secondary));
  const note = p.army < 1 ? '\n\n*No troops left in reserve — recruit more or send your army elsewhere.*' : '';
  return { embeds: [new EmbedBuilder().setColor(COLOR.blue).setTitle(`🛡 Reinforce ${esc(city.name)}`)
    .setDescription(`**${esc(city.name)}** — Lv ${city.level} • garrison **🛡${fmt(city.garrison)}**\nReserve army: **${fmt(p.army)}** troops.\n\nChoose how many to station here.${note}`)],
    components: [amtRow, navRow] };
}

function leaderboard(state) {
  const rows = Object.entries(state.players)
    .map(([id, p]) => ({ p, str: playerStrength(state, p), c: p.cities.length }))
    .sort((a, b) => b.c - a.c || b.str - a.str).slice(0, 12);
  const medals = ['🥇', '🥈', '🥉'];
  const lines = rows.map((r, i) => `${medals[i] || `**${i + 1}.**`} ${esc(r.p.name)} — **${r.c}** cities • ${fmt(r.str)} power • ${r.p.stats.captured}⚔ / ${r.p.stats.defended}🛡`);
  return { embeds: [new EmbedBuilder().setColor(COLOR.gold).setTitle('🏆 Diyar — Conquerors').setDescription(lines.join('\n') || 'No rulers yet.')], components: [backRow()] };
}

function bossView(state) {
  const b = state.boss;
  if (!b) return { embeds: [new EmbedBuilder().setColor(COLOR.grey).setTitle('👹 Boss').setDescription('No threat is active. They strike at random times — watch the war room.')], components: [backRow()] };
  const ranked = Object.entries(b.damage).sort((a, c) => c[1] - a[1]).slice(0, 5)
    .map(([uid, d], i) => `**${i + 1}.** ${esc(state.players[uid]?.name || 'Unknown')} — ${fmt(d)}`);
  const embed = new EmbedBuilder().setColor(COLOR.red).setTitle(`👹 ${b.name}`)
    .setDescription(`HP **${fmt(Math.max(0, b.hp))} / ${fmt(b.hpMax)}** • ⏳ ${msLeft(b.endsAt)} left\n\n**Top damage**\n${ranked.join('\n') || '— no strikes yet —'}`);
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('dy:strike').setLabel('⚔ Strike!').setStyle(ButtonStyle.Danger)), backRow()] };
}

function profileView(state, db, guildId, userId) {
  const p = state.players[userId];
  const s = p.stats;
  const cities = ownedCities(state, userId);
  const str = playerStrength(state, p);
  const ranked = Object.entries(state.players)
    .map(([id, pp]) => ({ id, c: pp.cities.length, str: playerStrength(state, pp) }))
    .sort((a, b) => b.c - a.c || b.str - a.str);
  const rank = ranked.findIndex(r => r.id === userId) + 1;
  const fights = s.raidsWon + s.raidsLost;
  const winRate = fights ? Math.round(s.raidsWon / fights * 100) : 0;
  const embed = new EmbedBuilder().setColor(COLOR.gold).setTitle(`📜 ${p.name} — War Record`)
    .setDescription(
      `Rank **#${rank}** of ${ranked.length}  •  **${fmt(str)}** power\n` +
      `🏰 Cities **${cities.length}**  •  🪖 Army **${fmt(p.army)}**  •  🗡 Weapon tier **${p.weaponTier}**\n\n` +
      `**Raids:** ${s.raidsWon}W / ${s.raidsLost}L  (${winRate}% win rate)\n` +
      `**Cities captured:** ${s.captured}  •  **lost:** ${s.lost}\n` +
      `**Successful defences:** ${s.defended}\n` +
      `**Boss kills:** ${s.bossKills}  •  **total boss damage:** ${fmt(s.bossDmg)}`)
    .setFooter({ text: `Ruling since ${new Date(p.joinedAt).toISOString().slice(0, 10)}` });
  return { embeds: [embed], components: [backRow()] };
}

// wipe a season: clears players/boss/schedule, reseeds the map; keeps the home channel.
// Player Dinar balances live in the shared economy and are intentionally NOT touched.
function resetSeason(state, saveData, guildId) {
  const keepChannel = state.channelId;
  state.players = {};
  state.boss = null;
  state.bossSched = null;
  state.channelId = keepChannel;
  for (const c of CITY_DEFS) {
    state.cities[c.id] = {
      id: c.id, name: c.name, lon: c.lon, lat: c.lat, level: c.level,
      ownerId: null, npc: true, garrison: 20 + c.level * 18, lastIncomeAt: Date.now(),
    };
  }
  if (saveData) saveData(guildId);
}

// ════════════════════════════════════════════════════════════════════════════
//  COMMANDS + WIRING
// ════════════════════════════════════════════════════════════════════════════
function getDiyarCommands() {
  return [
    new SlashCommandBuilder().setName('diyar').setDescription('Open your Diyar dashboard (Libyan conquest game) — join instantly').toJSON(),
    new SlashCommandBuilder().setName('diyar-map').setDescription('Post the current map of Libya to the channel').toJSON(),
    new SlashCommandBuilder().setName('diyar-leaderboard').setDescription('See the top conquerors').toJSON(),
    new SlashCommandBuilder().setName('diyar-set-channel').setDescription('(Admin) Lock Diyar to this channel — dashboards, raids and boss events all live here')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).toJSON(),
    new SlashCommandBuilder().setName('diyar-reset').setDescription('(Admin) Wipe all progress and start a fresh season (player Dinar is kept)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).toJSON(),
  ];
}

function initDiyar({ client, db, saveData, awardLP }) {
  const stateOf = (guildId) => getState(db, guildId, saveData);

  // ----- boss scheduler tick -----
  async function postBoss(guildId) {
    const state = stateOf(guildId);
    const b = state.boss; if (!b || !state.channelId) return;
    try {
      const ch = await client.channels.fetch(state.channelId);
      const embed = new EmbedBuilder().setColor(COLOR.red).setTitle(`👹 ${b.name} appears!`)
        .setDescription(`${b.tag}. Everyone can **strike** it — most damage wins the best loot. If it isn't slain in **${Math.round(BOSS_DURATION_MS/3600000)}h**, it pillages a city!`)
        .setImage('attachment://diyar-boss.png');
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('dy:strike').setLabel('⚔ Strike!').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('dy:bossdmg').setLabel('📊 Damage').setStyle(ButtonStyle.Secondary));
      const msg = await ch.send({ embeds: [embed], components: [row], files: [renderBoss(b)] });
      b.messageId = msg.id; b.channelId = ch.id; saveData(guildId);
    } catch (e) { console.error('[diyar boss post]', e.message); }
  }
  async function announce(guildId, payload) {
    const state = stateOf(guildId); if (!state.channelId) return;
    try { const ch = await client.channels.fetch(state.channelId); await ch.send(payload); } catch (e) { console.error('[diyar announce]', e.message); }
  }

  const raidTimers = {};   // in-memory countdown intervals (not persisted)
  async function launchRaid(guildId, raidId) {
    const state = stateOf(guildId);
    const raid = state.pendingRaids && state.pendingRaids[raidId];
    if (!raid || !raid.channelId) return;
    let msg = null;
    try {
      const ch = await client.channels.fetch(raid.channelId);
      raid.animStart = Date.now();                     // anchor the animation to when the message actually appears
      raid.endsAt = raid.animStart + RAID_WINDOW_MS;   // re-anchor the countdown too, so it starts at a full 30s
      const secs = Math.round(RAID_WINDOW_MS / 1000);
      msg = await ch.send({ content: `<@${raid.defenderId}>`, embeds: [raidLiveEmbed(state, raid, secs)], components: [reinforceRow(raidId)] });
      raid.messageId = msg.id; saveData(guildId);
    } catch (e) { console.error('[diyar raid post]', e.message); }
    if (raidTimers[raidId]) clearInterval(raidTimers[raidId]);
    raidTimers[raidId] = setInterval(async () => {
      const st = stateOf(guildId); const rd = st.pendingRaids && st.pendingRaids[raidId];
      if (!rd) { clearInterval(raidTimers[raidId]); delete raidTimers[raidId]; return; }
      const secs = Math.max(0, Math.round((rd.endsAt - Date.now()) / 1000));
      if (secs <= 0) { clearInterval(raidTimers[raidId]); delete raidTimers[raidId]; await finishRaid(guildId, raidId); return; }
      try { if (msg) await msg.edit({ embeds: [raidLiveEmbed(st, rd, secs)], components: [reinforceRow(raidId)] }); } catch { /* ignore */ }
    }, 2000);
  }
  async function finishRaid(guildId, raidId) {
    const state = stateOf(guildId);
    const raid = state.pendingRaids && state.pendingRaids[raidId];
    if (!raid) return;
    delete state.pendingRaids[raidId];
    if (raidTimers[raidId]) { clearInterval(raidTimers[raidId]); delete raidTimers[raidId]; }
    const result = resolveRaid(state, db, guildId, saveData, raid, raid.reinforced ? REINFORCE_MULT : 1);
    saveData(guildId);
    if (!result) return;
    try {
      const ch = await client.channels.fetch(raid.channelId);
      const m = raid.messageId ? await ch.messages.fetch(raid.messageId).catch(() => null) : null;
      if (m) await m.edit({ content: '', embeds: [raidResultEmbed(result)], components: [] });
      else await ch.send({ embeds: [raidResultEmbed(result)] });
    } catch (e) { console.error('[diyar raid finish]', e.message); }
  }
  async function refreshBossMessage(guildId) {
    const state = stateOf(guildId); const b = state.boss;
    if (!b || !b.channelId || !b.messageId) return;
    try {
      const ch = await client.channels.fetch(b.channelId);
      const msg = await ch.messages.fetch(b.messageId);
      const embed = EmbedBuilder.from(msg.embeds[0]).setImage('attachment://diyar-boss.png');
      await msg.edit({ embeds: [embed], files: [renderBoss(b)] });
    } catch { /* message gone */ }
  }

  async function tick() {
    const now = Date.now();
    for (const guild of client.guilds.cache.values()) {
      const state = db[guild.id] && db[guild.id].__diyar;
      if (!state) continue;
      // expire an unbeaten boss
      if (state.boss && now > state.boss.endsAt) {
        const res = resolveBossExpire(state, db, guild.id, saveData);
        if (res && res.razed) {
          await announce(guild.id, { embeds: [new EmbedBuilder().setColor(COLOR.red).setTitle(`👹 ${res.name} escaped!`)
            .setDescription(`No one slew it in time. It pillaged **${res.razed.city}**${res.razed.owner ? ` (${res.razed.owner})` : ''} — 🛡 −${fmt(res.razed.garrisonLost)} garrison${res.razed.looted ? `, 💰 −${fmt(res.razed.looted)} Dinar` : ''}.`)] });
        }
      }
      // spawn due bosses (only if a war room is set)
      if (state.channelId) {
        const sched = ensureBossSched(state, saveData, guild.id, now);
        const due = sched.spawns.find(s => !s.fired && s.at <= now);
        if (due) {
          due.fired = true; saveData(guild.id);
          if (!state.boss) { spawnBoss(state, saveData, guild.id); await postBoss(guild.id); }
        }
      }
      // resolve any live raid whose window elapsed but whose timer was lost (e.g. a redeploy)
      for (const rid of Object.keys(state.pendingRaids || {})) {
        if (now > state.pendingRaids[rid].endsAt && !raidTimers[rid]) await finishRaid(guild.id, rid);
      }
    }
  }

  setTimeout(() => { tick().catch(e => console.error('[diyar tick]', e.message)); setInterval(() => tick().catch(e => console.error('[diyar tick]', e.message)), TICK_MS); }, 4000);

  // ----- interaction handling -----
  client.on('interactionCreate', async (interaction) => {
    try {
      // slash commands
      if (interaction.isChatInputCommand()) {
        const gid = interaction.guild?.id;
        if (!gid) return;

        // Single-channel lock: once a home channel is set, all Diyar play happens there.
        if (['diyar', 'diyar-map', 'diyar-leaderboard'].includes(interaction.commandName)) {
          const homeId = stateOf(gid).channelId;
          if (homeId && interaction.channelId !== homeId) {
            return interaction.reply(eph({ content: `🏰 Diyar is played in <#${homeId}> — head there to open your dashboard, raid rivals, and join the boss fights.` }));
          }
        }

        if (interaction.commandName === 'diyar') {
          const state = stateOf(gid);
          const name = interaction.member?.displayName || interaction.user.username;
          const { player, isNew, landless, startCity } = ensurePlayer(state, interaction.user.id, name, saveData, gid);
          const trib = claimTribute(state, db, gid, saveData, interaction.user.id);
          const tribLine = trib > 0 ? `\n\n🎁 **Daily tribute:** +${fmt(trib)} Dinar collected.` : '';
          if (isNew) {
            if (landless) {
              announce(gid, { content: `🏴 **${name}** has entered the war for Diyar — but every city is held! They march in **landless**, hungry for conquest.` });
              return interaction.reply(eph({ embeds: [new EmbedBuilder().setColor(COLOR.green).setTitle('🏴 Welcome to Diyar!')
                .setDescription(`Every city in Libya is already held, so you begin **landless** — with an army of **${STARTER_ARMY}** troops and nothing to lose. Open **⚔ Attack**, raid an owned city and **seize it** to plant your first banner. Recruit more troops, then strike the weakest holder you can reach. Until you hold a city, no one can touch you.${tribLine}`)],
                components: dashboard(state, db, gid, interaction.user.id).components, files: [] }));
            }
            announce(gid, { content: `🏴 **${name}** has entered the war for Diyar, raising their banner over **${startCity.name}**!` });
            return interaction.reply(eph({ embeds: [new EmbedBuilder().setColor(COLOR.green).setTitle('🏴 Welcome to Diyar!')
              .setDescription(`You've been granted **${startCity.name}** and an army of **${STARTER_ARMY}** troops.\n\nGrow your realm: recruit, upgrade, then raid neutral militias and rivals to expand. Open the dashboard below.${tribLine}`)],
              components: dashboard(state, db, gid, interaction.user.id).components, files: [] }));
          }
          return interaction.reply(eph({ ...(trib > 0 ? { content: `🎁 Daily tribute: +${fmt(trib)} Dinar collected.` } : {}), ...dashboard(state, db, gid, interaction.user.id) }));
        }
        if (interaction.commandName === 'diyar-map') {
          const state = stateOf(gid);
          if (!Object.keys(state.players).length) return interaction.reply(eph({ content: 'No one has joined Diyar yet. Use `/diyar` to start!' }));
          await interaction.deferReply();
          return interaction.editReply({ files: [renderMap(state)] });
        }
        if (interaction.commandName === 'diyar-leaderboard') {
          const state = stateOf(gid);
          return interaction.reply({ embeds: leaderboard(state).embeds, components: [] });   // public: no interactive buttons
        }
        if (interaction.commandName === 'diyar-set-channel') {
          const state = stateOf(gid);
          state.channelId = interaction.channelId; saveData(gid);
          return interaction.reply(eph({ content: `✅ This channel is now the **home of Diyar**. Dashboards, raids, and boss threats all live here — and the game is locked to this channel.` }));
        }
        if (interaction.commandName === 'diyar-reset') {
          if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild))
            return interaction.reply(eph({ content: 'You need the **Manage Server** permission to reset Diyar.' }));
          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('dy:reset_confirm').setLabel('Wipe & start new season').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId('dy:reset_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary));
          return interaction.reply(eph({ content: '⚠️ This wipes **all Diyar progress** — every player, city and ranking — and reseeds the map with fresh militias. Player **Dinar balances are not affected**. This cannot be undone.', components: [row] }));
        }
        return;
      }

      const isBtn = interaction.isButton?.();
      const isSel = interaction.isStringSelectMenu?.();
      if (!isBtn && !isSel) return;
      if (!interaction.customId.startsWith('dy:')) return;

      const gid = interaction.guild?.id;
      if (!gid) return;
      const state = stateOf(gid);
      const uid = interaction.user.id;
      const parts = interaction.customId.split(':');           // dy:action[:arg[:arg2]]
      const action = parts[1];

      // strike/damage come from the PUBLIC war-room message — they don't need a dashboard
      if (action === 'strike') {
        const r = strikeBoss(state, saveData, gid, uid);
        if (r.error) return interaction.reply(eph({ content: r.error }));
        await interaction.reply(eph({ content: `⚔ You hit **${state.boss ? state.boss.name : 'the enemy'}** for **${fmt(r.dmg)}**! (your total: ${fmt(r.total)})` }));
        if (r.killed) {
          const bm = state.boss ? { channelId: state.boss.channelId, messageId: state.boss.messageId, name: state.boss.name } : null;
          const res = resolveBossDefeat(state, db, gid, saveData);
          if (res) {
            const lines = res.rewards.slice(0, 5).map((w, i) => `${['🥇','🥈','🥉'][i] || `**${i+1}.**`} ${esc(w.name)} — ${fmt(w.dmg)} dmg → +${fmt(w.dinar)}💰${w.lp ? ` +${w.lp}LP` : ''}${w.weapon ? ' 🗡 weapon up!' : ''}`);
            for (const w of res.rewards) if (w.lp) awardLP(gid, w.uid, w.lp, 'diyar');
            await announce(gid, { embeds: [new EmbedBuilder().setColor(COLOR.green).setTitle('🎉 The threat is vanquished!')
              .setDescription(`The realm is safe. Spoils:\n\n${lines.join('\n')}`)] });
          }
          // re-edit the ORIGINAL threat message: show defeated, strip the strike/damage buttons + image
          if (bm && bm.channelId && bm.messageId) {
            try {
              const ch = await client.channels.fetch(bm.channelId);
              const msg = await ch.messages.fetch(bm.messageId);
              await msg.edit({ embeds: [new EmbedBuilder().setColor(COLOR.green).setTitle(`💀 ${bm.name} — DEFEATED`)
                .setDescription('The threat has been vanquished. The realm is safe.')], components: [], files: [], attachments: [] });
            } catch (e) { console.error('[diyar boss defeat edit]', e.message); }
          }
        } else {
          await refreshBossMessage(gid);
        }
        return;
      }
      if (action === 'bossdmg') return interaction.reply(eph(bossView(state)));

      if (action === 'reset_cancel') return interaction.update({ content: 'Reset cancelled — your realm is safe.', components: [] });
      if (action === 'reset_confirm') {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild))
          return interaction.reply(eph({ content: 'You need the **Manage Server** permission to do that.' }));
        resetSeason(state, saveData, gid);
        await interaction.update({ content: '✅ A new season of Diyar has begun — the map has been reseeded with fresh militias.', components: [] });
        await announce(gid, { embeds: [new EmbedBuilder().setColor(COLOR.green).setTitle('🏁 A new season of Diyar begins!')
          .setDescription('The map has been wiped and fresh militias hold every city. Run `/diyar` to claim your new starting city and begin the conquest again.')] });
        return;
      }

      // everything else requires being registered
      if (!state.players[uid]) return interaction.reply(eph({ content: 'Join first with `/diyar`.' }));
      if (reseedIfLanded(state, uid)) saveData(gid);   // resettle a knocked-out player (and persist it)

      const home = () => interaction.update(dashboard(state, db, gid, uid));

      if (action === 'home')        return home();
      if (action === 'city')        return interaction.update(cityView(state, db, gid, uid));
      if (action === 'army')        return interaction.update(armyView(state, db, gid, uid));
      if (action === 'upgrade')     return interaction.update(upgradeView(state, db, gid, uid));
      if (action === 'armoury')     return interaction.update(armouryView(state, db, gid, uid));
      if (action === 'reinforce')   return interaction.update(reinforceSelect(state, uid));
      if (action === 'leaderboard') return interaction.update(leaderboard(state));
      if (action === 'profile')     return interaction.update(profileView(state, db, gid, uid));
      if (action === 'boss')        return interaction.update(bossView(state));

      if (action === 'map') {
        await interaction.deferUpdate();
        return interaction.editReply({ embeds: [new EmbedBuilder().setColor(COLOR.gold).setTitle('🗺 Your Realm — Map of Libya').setImage('attachment://diyar-map.png')], components: [backRow()], files: [renderMap(state, uid)] });
      }
      if (action === 'collect') {
        const p = state.players[uid];
        const cdEnd = (p?.lastCollectAt || 0) + COLLECT_COOLDOWN_MS;
        if (Date.now() < cdEnd) {
          return interaction.reply(eph({ content: `⏳ You can collect again in **${msLeft(cdEnd)}**. Your cities keep earning (up to the ${INCOME_CAP_HRS}h cap) while you wait.` }));
        }
        const got = collectIncome(state, db, gid, saveData, uid);
        if (got > 0) {
          p.lastCollectAt = Date.now(); saveData(gid);
          const who = p?.name || interaction.member?.displayName || interaction.user.username;
          await interaction.reply({ content: `💰 **${who}** collected **${fmt(got)} Dinar** from their cities.` });   // public
          return;
        }
        const cities = ownedCities(state, uid);
        let msg;
        if (!cities.length) msg = '🪙 You hold no cities yet — capture one to start earning Dinar.';
        else {
          const ecoMult = 1 + p.upg.eco * 0.12;
          const ratePerHr = cities.reduce((s, c) => s + INCOME_BY_LEVEL[c.level] * ecoMult, 0);
          const capTotal = Math.floor(ratePerHr * INCOME_CAP_HRS);
          let soonestMs = Infinity;
          for (const c of cities) {
            const rc = INCOME_BY_LEVEL[c.level] * ecoMult;
            const pend = rc * clamp((Date.now() - c.lastIncomeAt) / 3600000, 0, INCOME_CAP_HRS);
            const need = 1 - (pend - Math.floor(pend));
            const ms = rc > 0 ? need / rc * 3600000 : Infinity;
            soonestMs = Math.min(soonestMs, ms);
          }
          const when = Number.isFinite(soonestMs) ? msLeft(Date.now() + soonestMs) : '—';
          msg = `🪙 Nothing to collect yet. Your **${cities.length}** cit${cities.length === 1 ? 'y' : 'ies'} earn about **${fmt(Math.round(ratePerHr))} Dinar/hour** (up to **${fmt(capTotal)}** after ${INCOME_CAP_HRS}h). Next Dinar ready in ~**${when}**.`;
        }
        await interaction.reply(eph({ content: msg }));
        return;
      }
      if (action === 'recruit') {
        const n = parseInt(parts[2], 10);
        if (Number.isFinite(n) && n > 0) recruit(state, db, gid, saveData, uid, n);
        return interaction.update(armyView(state, db, gid, uid));
      }
      if (action === 'upg') {
        const r = upgrade(state, db, gid, saveData, uid, parts[2]);
        return interaction.update(upgradeView(state, db, gid, uid));
      }
      if (action === 'buyweapon') {
        buyWeapon(state, db, gid, saveData, uid);
        return interaction.update(armouryView(state, db, gid, uid));
      }
      if (action === 'attack')      return interaction.update(targetSelect(state, uid));
      if (action === 'atk_target')  return interaction.update(sendAmount(state, uid, interaction.values[0]));
      if (action === 'rf_pick') return interaction.update(reinforceAmount(state, uid, interaction.values[0]));
      if (action === 'rf_do') {
        const cityId = parts[2];
        const amt = parts[3] === 'all' ? state.players[uid].army : parseInt(parts[3], 10);
        if (Number.isFinite(amt) && amt > 0) {
          const res = reinforce(state, saveData, gid, uid, cityId, amt);
          if (res.ok) {
            const city = state.cities[cityId];
            announce(gid, { content: `🛡 **${state.players[uid].name}** reinforced **${city.name}** with **${fmt(res.moved)}** troops — its defence is now **${fmt(effectiveDefence(state, city))}**.` });
          }
        }
        return interaction.update(reinforceAmount(state, uid, cityId));
      }
      if (action === 'atk') {
        const cityId = parts[2], pct = parts[3] === '50' ? 0.5 : 1.0;
        const start = startRaid(state, db, gid, saveData, uid, cityId, pct);
        if (start.error) return interaction.update({ embeds: [new EmbedBuilder().setColor(COLOR.grey).setTitle('⚔ Raid blocked').setDescription(start.error)], components: [backRow()], files: [] });
        const pending = start.pending;
        if (!pending.defenderId) {
          // neutral militia — resolve instantly, announce as text
          const result = resolveRaid(state, db, gid, saveData, pending, 1);
          announce(gid, { embeds: [raidResultEmbed(result)] });
          return interaction.update({ embeds: [raidResultEmbed(result)], components: [backRow()], files: [] });
        }
        // PvP — run a live 30s window so the defender can rally
        const raidId = 'r' + Date.now().toString(36) + Math.floor(Math.random() * 1000);
        state.pendingRaids = state.pendingRaids || {};
        state.pendingRaids[raidId] = { ...pending, id: raidId, endsAt: Date.now() + RAID_WINDOW_MS, reinforced: false, channelId: state.channelId, messageId: null };
        saveData(gid);
        launchRaid(gid, raidId).catch(e => console.error('[diyar raid]', e.message));
        return interaction.update({ embeds: [new EmbedBuilder().setColor(COLOR.red).setTitle('⚔ Raid launched!')
          .setDescription(`Your army marches on **${pending.cityName}**. The defender has **${Math.round(RAID_WINDOW_MS / 1000)}s** to rally — watch the war room for the outcome.`)], components: [backRow()], files: [] });
      }
      if (action === 'reinf') {
        const raidId = parts[2];
        const raid = state.pendingRaids && state.pendingRaids[raidId];
        if (!raid) return interaction.reply(eph({ content: 'That battle is already decided.' }));
        if (interaction.user.id !== raid.defenderId) return interaction.reply(eph({ content: 'Only the city\'s defender can send reinforcements.' }));
        if (Date.now() > raid.endsAt) return interaction.reply(eph({ content: '⏳ Too late — the battle is already decided!' }));
        if (raid.reinforced) return interaction.reply(eph({ content: '🛡 Your reinforcements are already on the way!' }));
        raid.reinforced = true; saveData(gid);
        const secs = Math.max(0, Math.round((raid.endsAt - Date.now()) / 1000));
        try { return await interaction.update({ embeds: [raidLiveEmbed(state, raid, secs)], components: [reinforceRow(raidId)] }); }
        catch { return interaction.reply(eph({ content: '🛡 Reinforcements sent — your garrison rallies!' })); }
      }
    } catch (e) {
      console.error('[diyar interaction]', e);
      try { if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) await interaction.reply(eph({ content: 'Something went wrong with that action.' })); } catch {}
    }
  });

  return {
    _test: {
      getState: () => stateOf, ensurePlayer, resolveAttack, recruit, upgrade, reinforce, collectIncome,
      spawnBoss, strikeBoss, resolveBossDefeat, resolveBossExpire, playerStrength, ensureBossSched,
      pendingIncome, renderMap, renderBoss, renderBattle, pickTimes, reseedIfLanded,
      claimTribute, buyWeapon, armouryView, profileView, resetSeason, targetSelect, reinforceSelect, effectiveDefence, effectiveAttack, startRaid, resolveRaid, troopCost, raidLiveEmbed, raidResultEmbed,
    },
  };
}

module.exports = { getDiyarCommands, initDiyar };
