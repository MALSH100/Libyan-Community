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
const { getDinar, spendDinar, awardDinar, getGachaPool } = require('./gacha');
const path = require('path');

// ─── Tuning ───────────────────────────────────────────────────────────────────
const STARTER_ARMY        = 40;
const GARRISON_CAP        = 3000;                   // max troops a single city can hold
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
const COLLECT_COOLDOWN_MS = 2 * 24 * 60 * 60 * 1000; // can only collect once per 2 days
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
const BOSS_DURATION_MS    = 20 * 60 * 1000;       // the siege lasts 20 minutes
const BOSS_STRIKE_CD_MS   = 3 * 1000;             // per-player strike cooldown (3s)
const THREAT_TICK_MS      = 3000;                  // live message edit + siege damage tick
const THREAT_DMG_MIN      = 4;                     // garrison damage per tick per city (min)
const THREAT_DMG_MAX      = 5;                     // garrison damage per tick per city (max)
const THREAT_CITY_DMG_CAP = 900;                   // total damage cap per city — it weakens, never demolishes
const THREAT_GARRISON_FLOOR = 20;                  // never grinds a garrison below this
const BOSS_HP_MIN         = 3000;                  // threat HP rolls randomly between these
const BOSS_HP_MAX         = 8000;
const BOSS_HP_PER_PLAYER  = 0;                     // flat HP (raise this to scale with player count)
const BOSS_SPAWNS_PER_DAY = 1;
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

// ─── Caravans ───────────────────────────────────────────────────────────────
// Once a day a caravan crosses between two real Libyan cities and posts in the war
// room with two buttons. FIRST CLICK WINS — the claim is taken synchronously before
// any await, so two people tapping at the same instant can never both be served.
const CARAVAN_SPAWNS_PER_DAY = 1;
const CARAVAN_WIN_START   = 12;                  // Libya-time window for the daily caravan
const CARAVAN_WIN_END     = 22;
const CARAVAN_EXPIRE_MS   = 60 * 60 * 1000;      // unclaimed, it moves on after an hour
const CARAVAN_FRAME_MS    = 1500;                // message-edit cadence for the result animation
const CARAVAN_FRAMES      = 6;                   // number of animation frames before the final card
const CARAVAN_REPEL_PAYOUT = 0.25;               // share of the purse you still grab if the escort drives you off
const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

// Every caravan is a different trade-off, and the offer message hints at which.
//   purse  — Dinar seized on a successful raid
//   guard  — soldiers you lose raiding (paid win OR lose)
//   folk   — recruits gained by inviting
//   risk   — chance the escort beats you back (you still pay `guard`, but only
//            keep CARAVAN_REPEL_PAYOUT of the purse)
//   minArmy— troops you must have in reserve to even attempt the raid
// Balanced around troop cost: at 1.5 Dinar/troop the two buttons are near-identical
// in value, so the real decision is your own position — landless rulers want the
// coin, sprawling empires (3 Dinar/troop) want the men.
const CARAVAN_DEFS = [
  // Tuned against  purse x (1 - 0.75*risk)  ==  1.5 x (guard + folk), which is the point
  // where both buttons pay the same. Most caravans sit near that line (a real coin-flip);
  // a few are deliberately skewed so not every day feels the same.
  { name: 'The Salt Caravan',     tag: 'camels bowed under slabs of Fezzan salt',
    purse: [700, 980], guard: [150, 260], folk: [200, 300], risk: 0.25, minArmy: 150 },
  { name: 'The Ghadames Traders', tag: 'silk, spice and rumours off the oasis road',
    purse: [740, 1010], guard: [190, 300], folk: [180, 280], risk: 0.25, minArmy: 190 },
  { name: 'The Tuareg Outriders', tag: 'blue-veiled riders who fight as well as they trade',
    purse: [1200, 1700], guard: [300, 480], folk: [260, 380], risk: 0.40, minArmy: 300 },
  { name: 'The Arms Dealers',     tag: 'crates nobody is meant to open',
    purse: [1150, 1600], guard: [350, 550], folk: [150, 250], risk: 0.35, minArmy: 350, weapon: true },
  { name: 'The Gold Convoy',      tag: 'sealed coin chests behind a wall of hired spears',
    purse: [1220, 1580], guard: [400, 650], folk: [90, 170], risk: 0.35, minArmy: 400 },
  { name: 'The Fuel Runners',     tag: 'a smuggler convoy running the desert highway',
    purse: [600, 900], guard: [120, 220], folk: [80, 160], risk: 0.45, minArmy: 120 },
  { name: 'The Wandering Column', tag: 'families walking north, looking for a home',
    purse: [150, 350], guard: [40, 110], folk: [380, 620], risk: 0.10, minArmy: 40 },
  { name: 'The Pilgrim Train',    tag: 'travellers on the long road east, lightly kept',
    purse: [200, 400], guard: [30, 90], folk: [300, 450], risk: 0.10, minArmy: 30 },
];
// A raid's purse scales with what troops actually cost you, because otherwise the choice
// is structurally unbalanced: soldiers are worth 1, 1.5 or 3 Dinar depending on how much
// land you hold, so a fixed purse makes raiding a no-brainer when troops are cheap and
// suicidal when they're dear. Scaling by the same factor makes the verdict depend on the
// CARAVAN, not on your rank — which is the whole point of the two buttons.
const cvPurseMult = (unitCost) => unitCost / 1.5;
// qualitative hints for the offer card — players see the shape of the trade, never the roll
const band = (v, lo, hi) => v <= lo ? 0 : v >= hi ? 2 : 1;
const PURSE_WORDS = ['light', 'worth taking', 'heavy'];
const FOLK_WORDS  = ['a handful', 'a fair number', 'a great many'];
const GUARD_WORDS = ['barely escorted', 'well escorted', 'heavily escorted'];
const RISK_WORDS  = ['unlikely to hold', 'may hold', 'likely to hold'];

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
    data.__diyar = { players: {}, cities: {}, boss: null, bossSched: null, caravan: null, caravanSched: null, wanted: null, wantedSched: null, channelId: null };
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
  const room = GARRISON_CAP - city.garrison;
  if (room <= 0) return { ok: false, capped: true, garrison: city.garrison };   // already full
  amt = Math.min(amt, p.army, room);                                            // never past the cap
  if (amt < 1) return { ok: false, noTroops: true };
  p.army -= amt; city.garrison += amt;
  saveData(guildId);
  return { ok: true, moved: amt, garrison: city.garrison, capped: city.garrison >= GARRISON_CAP };
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
  const attacker = state.players[raid.attackerId] || { weaponTier: 0, upg: { mil: 0 } };
  const aPow = effectiveAttack(attacker, raid.send);
  const dPow = effectiveDefence(state, city, raid.reinforced ? REINFORCE_MULT : 1);
  // who's winning the clash, and by how much (-1 defender-dominant … +1 attacker-dominant)
  const margin = (aPow - dPow) / Math.max(1, aPow + dPow);
  // each side's FINAL bar level — both start at 1.0 (full) and drain toward these. The loser
  // settles low but never fully empty (some troops always make it home); a close fight leaves
  // both near half, so a coin-flip result never contradicts the picture.
  const atkEnd = clamp(0.5 + margin * 0.55, 0.08, 0.92);
  const defEnd = clamp(0.5 - margin * 0.55, 0.08, 0.92);
  // progress is anchored to when the message posted and reaches 1 at ~90% of the window, so the
  // bars finish draining right as the countdown runs out — never zeroed out early, never mid-drain
  const elapsed = raid.animStart ? (Date.now() - raid.animStart) : 0;
  const prog = clamp(elapsed / (RAID_WINDOW_MS * 0.9), 0, 1);
  const atkFrac = 1 - (1 - atkEnd) * prog;
  const defFrac = 1 - (1 - defEnd) * prog;
  const status = raid.reinforced
    ? `🛡️ **Reinforced!** The garrison holds firm. ⏳ **${secsLeft}s** left…`
    : `⏳ **${secsLeft}s** left — defender, hit **🛡 Send Reinforcements** to rally your garrison!`;
  const desc =
    `**${raid.attackerName}** storms **${city.name}**${raid.defenderName ? ` — held by **${raid.defenderName}**` : ''}!\n\n` +
    `⚔ Attackers  ·  power **${fmt(Math.round(aPow * atkFrac))}**\n\`${raidBar(atkFrac, 1)}\`\n\n` +
    `🛡 Defenders  ·  power **${fmt(Math.round(dPow * defFrac))}**${raid.reinforced ? ' 🛡️' : ''}\n\`${raidBar(defFrac, 1)}\`\n\n${status}`;
  return new EmbedBuilder().setColor(raid.reinforced ? COLOR.blue : COLOR.red).setTitle(`⚔ Battle for ${city.name}`).setDescription(desc + inviteLine());
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

// ─── Threat (live siege) UI — text-based, distinct purple bar for the threat ──
const threatBar = (frac) => { const n = Math.max(0, Math.min(12, Math.round(frac * 12))); return '🟪'.repeat(n) + '⬛'.repeat(12 - n); };

function threatSiegeLines(state, b) {
  if (!b.targets || !b.targets.length) return '*It found no ruled cities to besiege — bring it down for the spoils!*';
  return b.targets.map(t => {
    const c = state.cities[t.cityId];
    const owner = c && c.ownerId ? state.players[c.ownerId]?.name : null;
    const status = t.done === 'cap' ? '✅ *withstood the assault*'
      : t.done === 'floor' ? '🏚 *defences shattered*'
      : `🔥 −**${fmt(t.dmg)}** troops so far`;
    return `🏙 **${esc(c.name)}**${owner ? ` (${esc(owner)})` : ''} — 🛡 **${fmt(c.garrison)}**  ${status}\n\`${raidBar(c.garrison, Math.max(1, t.startGarrison))}\``;
  }).join('\n');
}

// a small invite line permanently appended to threat/raid messages, so anyone watching the
// action always sees how to start — it's never "too many players" for a community game
function inviteLine() {
  return '\n\n*🏴 Not playing yet? Type `/diyar` to join the war for Libya.*';
}

function threatEmbed(state) {
  const b = state.boss;
  const log = (b.log || []).map(l => l.heavy
    ? `💥 **${esc(l.name)}** HEAVY hit for **${fmt(l.dmg)}**!`
    : `⚔ **${esc(l.name)}** struck for **${fmt(l.dmg)}**`).join('\n') || '*— no strikes yet — be the first!*';
  const desc =
    `*${b.tag}.* Strike it down before it razes the cities!\n\n` +
    `👹 **Threat** — **${fmt(Math.max(0, b.hp))} / ${fmt(b.hpMax)}** HP\n\`${threatBar(b.hp / b.hpMax)}\`\n\n` +
    `⚔ **Under siege**\n${threatSiegeLines(state, b)}\n\n` +
    `🗡 **Attack Log**\n${log}\n\n` +
    `⏳ **${msLeft(b.endsAt)}** left` + inviteLine();
  return new EmbedBuilder().setColor(COLOR.red).setTitle(`👹 ${b.name}`).setDescription(desc)
    .setFooter({ text: '⚔ Strike to attack — you can only strike once every 3s. Most damage = best loot.' });
}

function threatStrikeRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('dy:strike').setLabel('⚔ Strike!').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('dy:bossdmg').setLabel('📊 Damage').setStyle(ButtonStyle.Secondary));
}

function threatDefeatEmbed(state, b, rewards) {
  const lines = rewards.slice(0, 5).map((w, i) => `${['🥇','🥈','🥉'][i] || `**${i + 1}.**`} ${esc(w.name)} — ${fmt(w.dmg)} dmg → +${fmt(w.dinar)}💰${w.lp ? ` +${w.lp}LP` : ''}${w.weapon ? ' 🗡 weapon up!' : ''}`);
  const siege = (b.targets || []).filter(t => t.dmg > 0)
    .map(t => `🏙 ${esc(state.cities[t.cityId]?.name || t.cityId)} — lost **${fmt(t.dmg)}** troops to the siege`).join('\n');
  return new EmbedBuilder().setColor(COLOR.green).setTitle(`💀 ${b.name} — DEFEATED`)
    .setDescription(`The realm rallied and struck it down!\n\n**Spoils**\n${lines.join('\n') || '—'}${siege ? `\n\n**Siege toll**\n${siege}` : ''}${inviteLine()}`);
}

function threatWithdrawEmbed(res) {
  const siege = res.razedCities.filter(t => t.dmg > 0)
    .map(t => `🏙 ${esc(t.city)}${t.owner ? ` (${esc(t.owner)})` : ''} — lost **${fmt(t.dmg)}** troops`).join('\n');
  return new EmbedBuilder().setColor(COLOR.grey).setTitle(`👹 ${res.name} withdraws!`)
    .setDescription(`No one brought it down in time. It ravaged the land and slipped away.\n\n**Siege toll**\n${siege || '*The cities held — no lasting damage.*'}${inviteLine()}`);
}

// ─── Boss ─────────────────────────────────────────────────────────────────
// leaderboard order: most cities first, then strength — used to pick siege targets
function rankPlayers(state) {
  return Object.entries(state.players)
    .map(([id, p]) => ({ id, p, str: playerStrength(state, p), c: p.cities.length }))
    .filter(r => r.c > 0)
    .sort((a, b) => b.c - a.c || b.str - a.str);
}

function spawnBoss(state, saveData, guildId) {
  if (state.boss) return null;
  const def = BOSS_DEFS[Math.floor(Math.random() * BOSS_DEFS.length)];
  const ranked = rankPlayers(state);
  const taken = new Set();
  const randCityOf = (entry) => {
    if (!entry) return null;
    const pool = entry.p.cities.filter(id => !taken.has(id));
    return pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
  };
  const targets = [];
  const addTarget = (cityId) => {
    if (!cityId || taken.has(cityId)) return;
    taken.add(cityId);
    const c = state.cities[cityId];
    targets.push({ cityId, startGarrison: c.garrison, dmg: 0, done: null });
  };
  // 1st: always a random city of the #1 ranked ruler
  addTarget(randCityOf(ranked[0]));
  // 2nd: 70% a city of #2, 30% a city of #3 (falls back to whichever exists)
  const second = Math.random() < 0.7 ? (randCityOf(ranked[1]) || randCityOf(ranked[2]))
                                     : (randCityOf(ranked[2]) || randCityOf(ranked[1]));
  addTarget(second);
  // 3rd: any owned city not already under siege — owners with 2+ cities are 3× as likely
  const pool = [];
  for (const c of CITY_DEFS) {
    const city = state.cities[c.id];
    if (!city.ownerId || taken.has(c.id)) continue;
    const w = (state.players[city.ownerId]?.cities.length || 0) >= 2 ? 3 : 1;
    for (let k = 0; k < w; k++) pool.push(c.id);
  }
  if (pool.length) addTarget(pool[Math.floor(Math.random() * pool.length)]);

  state.boss = {
    name: def.name, tag: def.tag,
    hpMax: 0, hp: 0,   // set just below
    spawnedAt: Date.now(), endsAt: Date.now() + BOSS_DURATION_MS,
    damage: {}, targets, log: [], channelId: state.channelId, messageId: null,
  };
  const hp = Math.round((BOSS_HP_MIN + Math.random() * (BOSS_HP_MAX - BOSS_HP_MIN)) / 50) * 50;   // random 1,000–3,000
  state.boss.hpMax = hp; state.boss.hp = hp;
  if (saveData) saveData(guildId);
  return state.boss;
}

function strikeBoss(state, saveData, guildId, userId, heavy) {
  const b = state.boss;
  if (!b) return { error: 'No threat is active right now.' };
  if (b.hp <= 0) return { error: 'The enemy is already falling — the spoils are being tallied.' };
  const p = state.players[userId];
  if (!p) return { error: 'Join the game first with /diyar.' };
  const now = Date.now();
  if (now - p.lastStrikeAt < BOSS_STRIKE_CD_MS) return { error: `⏳ Catch your breath — you can strike again in **${Math.ceil((p.lastStrikeAt + BOSS_STRIKE_CD_MS - now) / 1000)}s**.` };
  // heavy attack only lands if the player currently has one primed; it's consumed either way
  const useHeavy = !!heavy && !!p.heavyReady;
  p.heavyReady = false;
  let dmg = Math.round((p.army * 0.06 * (1 + p.upg.mil * 0.1 + p.weaponTier * 0.15) + 12) * rnd(0.8, 1.2));   // chip damage — tuned for the 3s cooldown
  if (useHeavy) dmg *= 3;                                   // HEAVY ATTACK — triple damage
  b.hp -= dmg;
  b.damage[userId] = (b.damage[userId] || 0) + dmg;
  b.log = b.log || [];
  b.log.unshift({ name: p.name, dmg, heavy: useHeavy });    // newest first
  if (b.log.length > 3) b.log.length = 3;
  p.lastStrikeAt = now;
  p.stats.bossDmg += dmg;
  // 1-in-8 chance a normal strike primes a Heavy Attack for this player's next hit
  let heavyUnlocked = false;
  if (!useHeavy && Math.random() < 1 / 8) { p.heavyReady = true; heavyUnlocked = true; }
  const killed = b.hp <= 0;
  if (saveData) saveData(guildId);
  return { dmg, killed, hpLeft: Math.max(0, b.hp), total: b.damage[userId], usedHeavy: useHeavy, heavyUnlocked };
}

function resolveBossDefeat(state, db, guildId, saveData) {
  const b = state.boss; if (!b) return null;
  const ranked = Object.entries(b.damage).sort((a, b2) => b2[1] - a[1]);
  const rewards = [];
  // threat loot — rewarding but not runaway; flatter curve so participants who chip in
  // still feel it (top-to-bottom ~3.5× gap rather than 6×+). Tune these four values freely.
  ranked.forEach(([uid, dmg], i) => {
    const p = state.players[uid]; if (!p) return;
    let dinar = 0, lp = 0, weapon = false;
    if (i === 0)      { dinar = 350; lp = 22; weapon = p.weaponTier < 5; p.stats.bossKills++; }
    else if (i === 1) { dinar = 220; lp = 15; }
    else if (i === 2) { dinar = 130; lp = 10; }
    else              { dinar = 60;  lp = 5;  }
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
  // the siege damage was inflicted LIVE while it raged — expiry just means it withdraws unslain
  const razedCities = (b.targets || []).map(t => {
    const c = state.cities[t.cityId];
    return { city: c ? c.name : t.cityId, owner: c && c.ownerId ? (state.players[c.ownerId]?.name || null) : null, dmg: t.dmg };
  });
  state.boss = null;
  if (saveData) saveData(guildId);
  return { name: b.name, razedCities };
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

// ─── Caravans ───────────────────────────────────────────────────────────────
// Roll the whole outcome up front so the animation is just a replay of a result
// that already landed in the player's balance — a crash mid-animation can't rob them.
function spawnCaravan(state, saveData, guildId) {
  if (state.caravan) return null;
  const def = CARAVAN_DEFS[Math.floor(Math.random() * CARAVAN_DEFS.length)];
  const a = CITY_DEFS[Math.floor(Math.random() * CITY_DEFS.length)];
  let b = a;
  while (b.id === a.id) b = CITY_DEFS[Math.floor(Math.random() * CITY_DEFS.length)];
  const now = Date.now();
  state.caravan = {
    id: 'c' + now.toString(36),
    name: def.name, tag: def.tag, weapon: !!def.weapon,
    fromId: a.id, fromName: a.name, toId: b.id, toName: b.name,
    minArmy: def.minArmy,
    hint: {
      purse: band((def.purse[0] + def.purse[1]) / 2, 450, 1000),
      folk:  band((def.folk[0] + def.folk[1]) / 2, 200, 330),
      guard: band((def.guard[0] + def.guard[1]) / 2, 150, 400),
      risk:  band(def.risk, 0.2, 0.35),
    },
    roll: {
      purse:    randInt(def.purse[0], def.purse[1]),
      guard:    randInt(def.guard[0], def.guard[1]),
      folk:     randInt(def.folk[0], def.folk[1]),
      repelled: Math.random() < def.risk,          // pre-rolled, so the animation can't lie
    },
    spawnedAt: now, expiresAt: now + CARAVAN_EXPIRE_MS,
    claimedBy: null, claimedName: null, choice: null, result: null,
    channelId: state.channelId, messageId: null,
  };
  if (saveData) saveData(guildId);
  return state.caravan;
}

// FIRST CLICK WINS. Everything here is synchronous — no await between the
// claimedBy check and the claimedBy write — so the race is decided atomically.
function claimCaravan(state, db, guildId, saveData, userId, choice) {
  const c = state.caravan;
  if (!c) return { error: '🐪 That caravan has already moved on.' };
  if (c.claimedBy) return { error: `🐪 Too late — **${esc(c.claimedName)}** reached the caravan first.` };
  const p = state.players[userId];
  if (!p) return { error: 'Join the game first with `/diyar`.' };
  // gate the raid on a real commitment of men — otherwise an empty-handed player
  // could take the purse for free, and nobody would ever press Invite
  if (choice === 'raid' && p.army < c.minArmy)
    return { error: `🗡️ You need at least **${fmt(c.minArmy)}** troops in reserve to ride down this caravan — you have **${fmt(p.army)}**. Recruit, or welcome them in instead.` };

  c.claimedBy = userId; c.claimedName = p.name; c.choice = choice; c.claimedAt = Date.now();
  p.stats = p.stats || {};
  if (choice === 'raid') {
    const loss = Math.min(c.roll.guard, p.army);          // never below zero
    const repelled = c.roll.repelled;
    const purse = Math.round(c.roll.purse * cvPurseMult(troopCost(state, userId)));
    const dinar = repelled ? Math.round(purse * CARAVAN_REPEL_PAYOUT) : purse;
    let weapon = false;
    if (!repelled && c.weapon && p.weaponTier < ARMOURY_MAX_TIER) { p.weaponTier++; weapon = true; }
    p.army -= loss;
    awardDinar(db, guildId, userId, dinar, saveData);
    c.result = { loss, dinar, repelled, weapon, tier: p.weaponTier };
    p.stats.caravansRaided = (p.stats.caravansRaided || 0) + 1;
  } else {
    p.army += c.roll.folk;
    c.result = { recruits: c.roll.folk };
    p.stats.caravansJoined = (p.stats.caravansJoined || 0) + 1;
  }
  if (saveData) saveData(guildId);
  return { ok: true, caravan: c };
}

const cvBar = (pct, fill) => {
  const n = clamp(Math.round(pct * 12), 0, 12);
  return fill.repeat(n) + '⬛'.repeat(12 - n);
};

function caravanOfferEmbed(state) {
  const c = state.caravan; if (!c) return null;
  const h = c.hint;
  return new EmbedBuilder().setColor(COLOR.gold)
    .setTitle(`🐪 ${esc(c.name)} approaches!`)
    .setDescription(
      `*${esc(c.tag)}*\n\n` +
      `Travelling from **${esc(c.fromName)}** to **${esc(c.toName)}**. ` +
      `Word spreads fast — **the first ruler to act takes it.**\n\n` +
      `**Scouts report:** a **${PURSE_WORDS[h.purse]}** purse • **${FOLK_WORDS[h.folk]}** travelling • **${GUARD_WORDS[h.guard]}**` +
      (c.weapon ? ' • *the crates look like weapons*' : '') + '\n\n' +
      `🗡️ **Raid the Caravan** — take the purse by force. Costs you soldiers whatever happens, and the escort is **${RISK_WORDS[h.risk]}**. Needs **${fmt(c.minArmy)}+** troops in reserve.\n` +
      `🤝 **Invite the Caravan** — welcome them in. They settle and join your ranks as recruits. No cost, no risk.\n\n` +
      `⏳ It passes through in **${msLeft(c.expiresAt)}**.`)
    .setFooter({ text: 'First click wins — only one ruler gets this caravan.' });
}

function caravanRow(disabled) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('dy:cv_raid').setLabel('🗡️ Raid the Caravan').setStyle(ButtonStyle.Danger).setDisabled(!!disabled),
    new ButtonBuilder().setCustomId('dy:cv_invite').setLabel('🤝 Invite the Caravan').setStyle(ButtonStyle.Success).setDisabled(!!disabled));
}

// one animation frame — `step` runs 0 … CARAVAN_FRAMES, ramping toward the real totals
function caravanFrameEmbed(c, step) {
  const pct = clamp(step / CARAVAN_FRAMES, 0, 1);
  const ease = pct * pct * (3 - 2 * pct);          // smoothstep, so it doesn't crawl linearly
  if (c.choice === 'raid') {
    const loss  = Math.round(c.result.loss * ease);
    const dinar = Math.round(c.result.dinar * ease);
    // the escort only visibly holds in the last third, so the outcome isn't spoiled early
    const turned = c.result.repelled && pct > 0.6;
    return new EmbedBuilder().setColor(turned ? COLOR.grey : COLOR.red)
      .setTitle(`🗡️ ${esc(c.claimedName)} raids ${esc(c.name)}!`)
      .setDescription(
        (turned ? `The escort forms up and **holds the line** — your riders break off with what they can carry.\n\n`
                : `Riders sweep out of **${esc(c.toName)}** and fall on the convoy.\n\n`) +
        `🪖 **Soldiers lost**\n\`${cvBar(ease, '🟥')}\`  **−${fmt(loss)}**\n\n` +
        `💰 **Dinar seized**\n\`${cvBar(ease, '🟨')}\`  **+${fmt(dinar)}**` +
        (pct >= 1 ? '' : '\n\n*The dust hasn\'t settled…*'));
  }
  const men = Math.round(c.result.recruits * ease);
  return new EmbedBuilder().setColor(COLOR.green)
    .setTitle(`🤝 ${esc(c.claimedName)} welcomes ${esc(c.name)}`)
    .setDescription(
      `The gates of **${esc(c.toName)}** open and the travellers are led in.\n\n` +
      `🪖 **Recruits joining**\n\`${cvBar(ease, '🟩')}\`  **+${fmt(men)}**` +
      (pct >= 1 ? '' : '\n\n*More are still coming through the gate…*'));
}

function caravanFinalEmbed(c) {
  if (c.choice === 'raid') {
    const r = c.result;
    const short = r.loss < c.roll.guard
      ? `\n\n*They had barely enough men to press the attack — only **${fmt(r.loss)}** rode out, and none came back.*` : '';
    const prize = r.weapon ? `\n🗡 Seized weapons — **weapon tier ${r.tier}**!` : '';
    return new EmbedBuilder().setColor(r.repelled ? COLOR.grey : COLOR.red)
      .setTitle(r.repelled ? `🛡 ${esc(c.name)} — escort held` : `🗡️ ${esc(c.name)} — plundered`)
      .setDescription(
        (r.repelled
          ? `**${esc(c.claimedName)}** hit the caravan on the road to **${esc(c.toName)}**, but the escort held and drove them off with only scraps.`
          : `**${esc(c.claimedName)}** rode down the caravan on the road to **${esc(c.toName)}**.`) + '\n\n' +
        `💰 Took **${fmt(r.dinar)} Dinar**\n` +
        `🪖 Lost **${fmt(r.loss)}** soldiers${prize}${short}`)
      .setFooter({ text: 'A new caravan crosses Libya each day.' });
  }
  return new EmbedBuilder().setColor(COLOR.green)
    .setTitle(`🤝 ${esc(c.name)} — welcomed`)
    .setDescription(
      `**${esc(c.claimedName)}** took the travellers in at **${esc(c.toName)}**.\n\n` +
      `🪖 Gained **${fmt(c.result.recruits)}** recruits\n` +
      `💰 Cost **nothing**, risked **nothing**`)
    .setFooter({ text: 'A new caravan crosses Libya each day.' });
}

function caravanExpireEmbed(c) {
  return new EmbedBuilder().setColor(COLOR.grey)
    .setTitle(`🐪 ${esc(c.name)} passed through`)
    .setDescription(`No one moved on it. The caravan reached **${esc(c.toName)}** unharmed and carried on its way.`);
}

function ensureCaravanSched(state, saveData, guildId, nowMs) {
  const { dateStr, startOfDayUTC } = libyaDay(nowMs);
  if (!state.caravanSched || state.caravanSched.date !== dateStr) {
    const ws = startOfDayUTC + CARAVAN_WIN_START * 3600000;
    const we = startOfDayUTC + CARAVAN_WIN_END * 3600000;
    const eff = Math.max(ws, nowMs);
    const spawns = (we - eff > 5 * 60000) ? pickTimes(eff, we, CARAVAN_SPAWNS_PER_DAY, 90 * 60000).map(at => ({ at, fired: false })) : [];
    state.caravanSched = { date: dateStr, spawns };
    if (saveData) saveData(guildId);
  }
  return state.caravanSched;
}


// ─── Wanted (the Hunt) ──────────────────────────────────────────────────────
// An opted-in gacha member goes on the run and hides in one of the 25 cities.
// Every hour a fresh clue narrows it down and everyone gets one guess. First
// correct guess takes the bounty. Deliberately SLOW — caravans are the 30-second
// race, this is the all-afternoon one.
const WANTED_SPAWNS_PER_DAY = 1;
const WANTED_WIN_START  = 13;                    // Libya-time window
const WANTED_WIN_END    = 20;
const WANTED_CLUE_MS    = 60 * 60 * 1000;        // a new clue (and a fresh guess) every hour
const WANTED_MAX_CLUES  = 6;                     // hunt ends when the clues run out
const WANTED_SEARCH_FEE = 75;                    // Dinar per search — the sink that stops brute-forcing
const WANTED_CUT        = 0.20;                  // the hunted member's cut of their own bounty
const WANTED_BOUNTY = { Common: 400, Rare: 700, Epic: 1100, Legendary: 1700, Mythic: 2500 };
const WANTED_ESCAPE_CONSOLATION = 0.25;          // share of bounty split among searchers if they escape
// deliberately daft, so nobody's avatar ends up next to a real accusation
const WANTED_CRIMES = [
  'smuggling counterfeit tuna through three checkpoints',
  'ten years of unpaid Dinar, and counting',
  'selling the same generator to four different families',
  'running an unlicensed shawarma cart outside the palace',
  'rigging every coin flip in the souq',
  'impersonating a customs officer at Ras Ajdir',
  'making off with the garrison\'s entire tea supply',
  'forging travel papers for anyone with the coin',
  'reselling government fuel at desert prices',
  'losing a shipment of gold and blaming the weather',
];

// region straight off the map coordinates — no second list to keep in sync
function cityRegion(c) {
  if (c.lat < 29) return 'the deep south';
  if (c.lon < 15.5) return 'the west';
  if (c.lon > 19) return 'the east';
  return 'the centre';
}
// actual coastline, not a latitude guess — a cutoff made every western city "coastal"
const COASTAL = new Set(['zuwara','sabratha','zawiya','tripoli','khoms','zliten','misrata','sirte','benghazi','derna','tobruk']);
const isCoastal = (c) => COASTAL.has(c.id);
const SIZE_WORDS = ['a small settlement', 'a decent-sized town', 'one of the great cities'];

// clue `i` for the city they're hiding in — each one strictly narrows the field
function wantedClue(cityId, i) {
  const c = CITY_BY_ID[cityId];
  switch (i) {
    case 0: return `Word is they fled to **${cityRegion(c)}**.`;
    case 1: return isCoastal(c) ? 'They were seen near **the coast** — you can smell the sea from where they sleep.'
                                : 'No sea air where they are. They\'re **inland**.';
    case 2: return `They\'re holed up in **${SIZE_WORDS[c.level - 1]}**.`;
    case 3: {
      // nearest other city, as the crow flies — a strong but not decisive hint
      let best = null, bd = Infinity;
      for (const o of CITY_DEFS) {
        if (o.id === c.id) continue;
        const d = Math.hypot(o.lon - c.lon, o.lat - c.lat);
        if (d < bd) { bd = d; best = o; }
      }
      return `A trader passed them on the road — the nearest city over is **${best.name}**.`;
    }
    case 4: return `The name of the place begins with **${c.name[0].toUpperCase()}**.`;
    default: {
      const others = CITY_DEFS.filter(o => o.id !== c.id);
      const decoy = others[Math.floor(Math.random() * others.length)];
      const pair = Math.random() < 0.5 ? [c.name, decoy.name] : [decoy.name, c.name];
      return `Last chance — it\'s **${pair[0]}** or **${pair[1]}**. Nobody will say which.`;
    }
  }
}

function spawnWanted(state, db, guildId, saveData) {
  if (state.wanted) return null;
  // If diyar.js is deployed without the matching gacha.js, this export won't exist.
  // Degrade to "no hunts" instead of throwing inside the minute tick every minute.
  if (typeof getGachaPool !== 'function') {
    if (!spawnWanted._warned) { spawnWanted._warned = true; console.warn('⚠️ Diyar: gacha.js is missing getGachaPool — the Wanted hunt is disabled. Deploy the updated gacha.js alongside diyar.js.'); }
    return null;
  }
  let pool;
  try { pool = getGachaPool(db, guildId) || {}; }
  catch (e) { console.error('[diyar wanted pool]', e.message); return null; }
  const ids = Object.keys(pool);
  if (!ids.length) return null;                     // nobody has opted in yet
  const uid = ids[Math.floor(Math.random() * ids.length)];
  const rarity = pool[uid].rarity || 'Common';
  const city = CITY_DEFS[Math.floor(Math.random() * CITY_DEFS.length)];
  const now = Date.now();
  state.wanted = {
    id: 'w' + now.toString(36),
    userId: uid, rarity,
    bounty: WANTED_BOUNTY[rarity] || WANTED_BOUNTY.Common,
    crime: WANTED_CRIMES[Math.floor(Math.random() * WANTED_CRIMES.length)],
    cityId: city.id,                                // the secret
    clueIdx: 0, clues: [wantedClue(city.id, 0)],
    nextClueAt: now + WANTED_CLUE_MS,
    guesses: {},                                    // userId -> clue index they last guessed on
    searchers: {},                                  // userId -> how much they've spent searching
    startedAt: now, caughtBy: null,
    channelId: state.channelId, messageId: null,
  };
  if (saveData) saveData(guildId);
  return state.wanted;
}

// one guess per player per clue round, paid for up front
function guessWanted(state, db, guildId, saveData, userId, cityId) {
  const w = state.wanted;
  if (!w) return { error: '🔍 That hunt is over.' };
  if (w.caughtBy) return { error: '🔍 They\'ve already been caught.' };
  if (!state.players[userId]) return { error: 'Join the game first with `/diyar`.' };
  if (userId === w.userId) return { error: '🙃 You can\'t turn *yourself* in — sit tight and collect your cut.' };
  if (w.guesses[userId] === w.clueIdx)
    return { error: `🔍 You\'ve already searched since the last clue. The next one drops in **${msLeft(w.nextClueAt)}**.` };
  if (!spendDinar(db, guildId, userId, WANTED_SEARCH_FEE, saveData))
    return { error: `🔍 Searching a city costs **${fmt(WANTED_SEARCH_FEE)} Dinar** — you can\'t cover it right now.` };

  w.guesses[userId] = w.clueIdx;
  w.searchers[userId] = (w.searchers[userId] || 0) + WANTED_SEARCH_FEE;
  const found = cityId === w.cityId;
  if (found) {
    w.caughtBy = userId;
    const p = state.players[userId];
    p.stats = p.stats || {};
    p.stats.bountiesClaimed = (p.stats.bountiesClaimed || 0) + 1;
    const cut = Math.round(w.bounty * WANTED_CUT);
    awardDinar(db, guildId, userId, w.bounty, saveData);
    awardDinar(db, guildId, w.userId, cut, saveData);     // the hunted keep a slice — being wanted pays
    w.payout = { bounty: w.bounty, cut };
  }
  if (saveData) saveData(guildId);
  return { ok: true, found, city: CITY_BY_ID[cityId] };
}

// nobody found them in time — the search fees are partly refunded across everyone who tried
function escapeWanted(state, db, guildId, saveData) {
  const w = state.wanted; if (!w) return null;
  const ids = Object.keys(w.searchers);
  const pot = Math.round(w.bounty * WANTED_ESCAPE_CONSOLATION);
  const each = ids.length ? Math.floor(pot / ids.length) : 0;
  if (each > 0) for (const uid of ids) awardDinar(db, guildId, uid, each, saveData);
  const res = { cityId: w.cityId, refund: each, searchers: ids.length, wanted: w };
  state.wanted = null;
  if (saveData) saveData(guildId);
  return res;
}

function ensureWantedSched(state, saveData, guildId, nowMs) {
  const { dateStr, startOfDayUTC } = libyaDay(nowMs);
  if (!state.wantedSched || state.wantedSched.date !== dateStr) {
    const ws = startOfDayUTC + WANTED_WIN_START * 3600000;
    const we = startOfDayUTC + WANTED_WIN_END * 3600000;
    const eff = Math.max(ws, nowMs);
    const spawns = (we - eff > 5 * 60000) ? pickTimes(eff, we, WANTED_SPAWNS_PER_DAY, 60 * 60000).map(at => ({ at, fired: false })) : [];
    state.wantedSched = { date: dateStr, spawns };
    if (saveData) saveData(guildId);
  }
  return state.wantedSched;
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
  const cvn = (state.caravan && !state.caravan.claimedBy)
    ? `\n\n🐪 **${state.caravan.name}** is on the road to **${state.caravan.toName}** — first ruler to act in the war room takes it!` : '';
  const wtd = (state.wanted && !state.wanted.caughtBy)
    ? `\n\n🪧 A **${fmt(state.wanted.bounty)} Dinar bounty** is live — someone's hiding out there. Check the war room for clues.` : '';
  const embed = new EmbedBuilder().setColor(COLOR.gold)
    .setTitle(`⚔ Diyar — ${p.name}`)
    .setDescription(
      `**${cities.length}** cit${cities.length === 1 ? 'y' : 'ies'} • **${fmt(dinar)}** Dinar\n` +
      `🪖 Army: **${fmt(p.army)}**  •  🏰 Garrisons: **${fmt(garr)}**\n` +
      `🗡 Weapon tier **${p.weaponTier}**  •  Military **${p.upg.mil}** / Walls **${p.upg.for}** / Economy **${p.upg.eco}**\n` +
      `💰 Uncollected income: **${fmt(income)}**${shield}` + boss + cvn + wtd)
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
  const room = Math.max(0, GARRISON_CAP - city.garrison);
  const full = room <= 0;
  const amtRow = new ActionRowBuilder().addComponents(
    ...[10, 50, 100].map(n => new ButtonBuilder().setCustomId(`dy:rf_do:${cityId}:${n}`).setLabel(`+${n}`).setStyle(ButtonStyle.Success).setDisabled(p.army < n || full)),
    new ButtonBuilder().setCustomId(`dy:rf_do:${cityId}:all`).setLabel(`All (${fmt(Math.min(p.army, room))})`).setStyle(ButtonStyle.Success).setDisabled(p.army < 1 || full));
  const navRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('dy:reinforce').setLabel('↩ Another city').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('dy:home').setLabel('🏠 Done').setStyle(ButtonStyle.Secondary));
  const note = full
    ? `\n\n🛡 *This city is **full** — it holds the maximum of ${fmt(GARRISON_CAP)} troops and can't take any more.*`
    : p.army < 1 ? '\n\n*No troops left in reserve — recruit more or send your army elsewhere.*'
    : `\n\n*Room for **${fmt(room)}** more before the ${fmt(GARRISON_CAP)} cap.*`;
  return { embeds: [new EmbedBuilder().setColor(COLOR.blue).setTitle(`🛡 Reinforce ${esc(city.name)}`)
    .setDescription(`**${esc(city.name)}** — Lv ${city.level} • garrison **🛡${fmt(city.garrison)} / ${fmt(GARRISON_CAP)}**\nReserve army: **${fmt(p.army)}** troops.\n\nChoose how many to station here.${note}`)],
    components: [amtRow, navRow] };
}


// ─── Wanted UI ──────────────────────────────────────────────────────────────
const TIER_TINT = { Common: 0x95A5A6, Rare: 0x3498DB, Epic: 0x9B59B6, Legendary: 0xF1C40F, Mythic: 0xE74C3C };

function wantedPosterEmbed(state, avatarUrl, displayName) {
  const w = state.wanted; if (!w) return null;
  const clues = w.clues.map((c, i) => `**${i + 1}.** ${c}`).join('\n');
  const left = WANTED_MAX_CLUES - w.clues.length;
  const e = new EmbedBuilder().setColor(TIER_TINT[w.rarity] || COLOR.grey)
    .setTitle('🪧 WANTED — DEAD LINE OR ALIVE')
    .setDescription(
      `**${esc(displayName)}** *(${w.rarity})* has gone to ground somewhere in Libya.\n` +
      `Wanted for: *${w.crime}*.\n\n` +
      `💰 **Bounty: ${fmt(w.bounty)} Dinar**\n\n` +
      `**What the informants say**\n${clues}\n\n` +
      `🔍 Searching a city costs **${fmt(WANTED_SEARCH_FEE)} Dinar**. ` +
      `**One search each** — then wait for the next clue.\n` +
      (left > 0 ? `⏳ Next clue in **${msLeft(w.nextClueAt)}**  •  **${left}** clue${left === 1 ? '' : 's'} left before they slip away.`
                : '⏳ **Final clue.** After this they\'re gone for good.'))
    .setFooter({ text: 'The hunted keeps a cut of their own bounty — opt in with /gacha-optin' });
  if (/^https?:\/\//.test(avatarUrl || '')) e.setThumbnail(avatarUrl);   // a bad URL would throw and kill the whole poster
  return e;
}

// all 25 cities fit one Discord dropdown exactly
function wantedRow(disabled) {
  const menu = new StringSelectMenuBuilder().setCustomId('dy:wt_guess')
    .setPlaceholder(disabled ? 'The hunt is over' : `🔍 Search a city  (${fmt(WANTED_SEARCH_FEE)} Dinar)`)
    .setDisabled(!!disabled)
    .addOptions(CITY_DEFS.slice(0, 25).map(c => ({ label: c.name, description: `Lv ${c.level}`, value: c.id })));
  return new ActionRowBuilder().addComponents(menu);
}

function wantedCaughtEmbed(w, finderName, avatarUrl, displayName) {
  const e = new EmbedBuilder().setColor(COLOR.green)
    .setTitle('⛓ Caught!')
    .setDescription(
      `**${esc(finderName)}** kicked in a door in **${esc(CITY_BY_ID[w.cityId].name)}** and found **${esc(displayName)}** hiding there.\n\n` +
      `💰 Bounty **${fmt(w.payout.bounty)} Dinar** to ${esc(finderName)}\n` +
      `🪙 **${fmt(w.payout.cut)} Dinar** to ${esc(displayName)} — they talked their way to a cut`)
    .setFooter({ text: 'A new face goes on the run each day.' });
  if (/^https?:\/\//.test(avatarUrl || '')) e.setThumbnail(avatarUrl);   // a bad URL would throw and kill the whole poster
  return e;
}

function wantedEscapedEmbed(res, displayName) {
  return new EmbedBuilder().setColor(COLOR.grey)
    .setTitle('🌫 Gone.')
    .setDescription(
      `Nobody found **${esc(displayName)}**. They were in **${esc(CITY_BY_ID[res.cityId].name)}** the whole time, and they\'re long gone now.\n\n` +
      (res.searchers ? `🪙 **${fmt(res.refund)} Dinar** back to each of the **${res.searchers}** who searched.` : '*Not one soul went looking.*'))
    .setFooter({ text: 'A new face goes on the run each day.' });
}

function leaderboard(state, viewerId) {
  const viewer = viewerId ? state.players[viewerId] : null;
  const vStr = viewer ? playerStrength(state, viewer) : 0;
  const underRaid = new Set(Object.values(state.pendingRaids || {}).map(r => r.cityId));
  const rows = Object.entries(state.players)
    .map(([id, p]) => ({ id, p, str: playerStrength(state, p), c: p.cities.length }))
    .sort((a, b) => b.c - a.c || b.str - a.str).slice(0, 10);
  const medals = ['🥇', '🥈', '🥉'];
  let anyShield = false;
  const lines = rows.map((r, i) => {
    const s = r.p.stats;
    // fairness shield: the match-band protects rulers far weaker than the viewer — it applies
    // to the ruler, so it covers every city they hold
    const shielded = !!viewer && r.id !== viewerId && r.str * MATCH_BAND < vStr;
    if (shielded) anyShield = true;
    const cityList = r.p.cities.map(cid => {
      const c = state.cities[cid];
      return `${esc(c.name)} (L${c.level})${underRaid.has(cid) ? '⚔' : ''}${shielded ? '🕊' : ''}`;
    }).join(', ') || '*landless — raiding for a home*';
    return `${medals[i] || `**${i + 1}.**`} **${esc(r.p.name)}**${r.id === viewerId ? ' *(you)*' : ''} — **${r.c}** ${r.c === 1 ? 'city' : 'cities'} • ${fmt(r.str)} power\n` +
      `⚔ ${s.raidsWon}W / ${s.raidsLost}L raids • 🛡 ${s.defended} defended • 🏰 ${s.captured} taken / ${s.lost} lost • 👹 ${s.bossKills} boss kills\n` +
      `🏙 ${cityList}`;
  });
  const legend = [];
  if (anyShield) legend.push(`🕊 protected by the fairness system — too far below **${esc(viewer.name)}**'s strength for them to raid`);
  if (underRaid.size) legend.push('⚔ under attack right now');
  const desc = (lines.join('\n\n') || 'No rulers yet.') + (legend.length ? `\n\n*${legend.join('  •  ')}*` : '');
  return { embeds: [new EmbedBuilder().setColor(COLOR.gold).setTitle('🏆 Diyar — Conquerors').setDescription(desc)], components: [backRow()] };
}

function bossView(state) {
  const b = state.boss;
  if (!b) return { embeds: [new EmbedBuilder().setColor(COLOR.grey).setTitle('👹 Threat').setDescription('No threat is active. They strike at random times — watch the war room.')], components: [backRow()] };
  const ranked = Object.entries(b.damage).sort((a, c) => c[1] - a[1]).slice(0, 5)
    .map(([uid, d], i) => `**${i + 1}.** ${esc(state.players[uid]?.name || 'Unknown')} — ${fmt(d)}`);
  const embed = new EmbedBuilder().setColor(COLOR.red).setTitle(`👹 ${b.name}`)
    .setDescription(`👹 **${fmt(Math.max(0, b.hp))} / ${fmt(b.hpMax)}** HP • ⏳ ${msLeft(b.endsAt)} left\n\`${threatBar(b.hp / b.hpMax)}\`\n\n⚔ **Under siege**\n${threatSiegeLines(state, b)}\n\n**Top damage**\n${ranked.join('\n') || '— no strikes yet —'}`)
    .setFooter({ text: '⚔ You can only strike once every 3s.' });
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
  const dinar = getDinar(db, guildId, userId);
  const ecoMult = 1 + p.upg.eco * 0.12;
  const incomeHr = cities.reduce((t, c) => t + INCOME_BY_LEVEL[c.level] * ecoMult, 0);
  const pending = cities.reduce((t, c) => t + pendingIncome(state, c), 0);
  const cdEnd = (p.lastCollectAt || 0) + COLLECT_COOLDOWN_MS;
  const collectStr = Date.now() >= cdEnd ? 'ready ✅' : `in ${msLeft(cdEnd)}`;
  const unit = troopCost(state, userId);
  const underRaid = new Set(Object.values(state.pendingRaids || {}).map(r => r.cityId));
  const cityLines = cities.map(c =>
    `🏙 **${esc(c.name)}** (L${c.level})${underRaid.has(c.id) ? ' ⚔ *under attack!*' : ''} — 🛡 ${fmt(c.garrison)}/${fmt(GARRISON_CAP)} • 💰 ${fmt(Math.round(INCOME_BY_LEVEL[c.level] * ecoMult))}/hr • def power **${fmt(effectiveDefence(state, c))}**`
  ).join('\n') || '*Landless — raid a city to claim a home.*';
  const embed = new EmbedBuilder().setColor(COLOR.gold).setTitle(`📜 ${p.name} — War Record`)
    .setDescription(
      `Rank **#${rank}** of ${ranked.length}  •  **${fmt(str)}** power\n\n` +
      `**💰 Wealth**\nDinar **${fmt(dinar)}**  •  income **${fmt(Math.round(incomeHr))}/hr**  •  uncollected **${fmt(Math.floor(pending))}**  •  collect ${collectStr}\n\n` +
      `**🪖 Military**\nArmy **${fmt(p.army)}** in reserve  •  🗡 weapon tier **${p.weaponTier}**  •  troop cost **${unit}💰** each\n` +
      `Upgrades: ⚔ Military **${p.upg.mil}**/${UPG_MAX}  •  🧱 Fortifications **${p.upg.for}**/${UPG_MAX}  •  💰 Economy **${p.upg.eco}**/${UPG_MAX}\n\n` +
      `**🏙 Cities (${cities.length})**\n${cityLines}\n\n` +
      `**⚔ War Record**\nRaids **${s.raidsWon}W / ${s.raidsLost}L** (${winRate}% win rate)  •  🛡 **${s.defended}** defended\n` +
      `🏰 Captured **${s.captured}**  •  lost **${s.lost}**\n` +
      `👹 Boss kills **${s.bossKills}**  •  total boss damage **${fmt(s.bossDmg)}**\n` +
      `🐪 Caravans raided **${s.caravansRaided || 0}**  •  welcomed **${s.caravansJoined || 0}**\n` +
      `⛓ Bounties claimed **${s.bountiesClaimed || 0}**`)
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
  state.caravan = null;
  state.caravanSched = null;
  state.wanted = null;
  state.wantedSched = null;
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
    new SlashCommandBuilder().setName('diyar-spawn-threat').setDescription('(Admin) Unleash a threat on the realm right now')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).toJSON(),
    new SlashCommandBuilder().setName('diyar-spawn-caravan').setDescription('(Admin) Send a caravan across the realm right now')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).toJSON(),
    new SlashCommandBuilder().setName('diyar-spawn-wanted').setDescription('(Admin) Put a bounty on an opted-in member right now')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).toJSON(),
  ];
}

function initDiyar({ client, db, saveData, awardLP }) {
  const stateOf = (guildId) => getState(db, guildId, saveData);

  // ----- boss scheduler tick -----
  const threatTimers = {};   // in-memory siege intervals per guild (not persisted)
  async function postBoss(guildId) {
    const state = stateOf(guildId);
    const b = state.boss; if (!b || !state.channelId) return;
    try {
      const ch = await client.channels.fetch(state.channelId);
      // warn the rulers whose cities are under siege by pinging them above the threat
      const owners = [...new Set((b.targets || [])
        .map(t => state.cities[t.cityId]?.ownerId)
        .filter(id => id && state.players[id] && !state.players[id].npc))];
      const ping = owners.length
        ? `⚠️ ${owners.map(id => `<@${id}>`).join(' ')} — **your cities are under attack by ${esc(b.name)}!** Rally to defend them! 🛡`
        : null;
      const msg = await ch.send({ content: ping || undefined, embeds: [threatEmbed(state)], components: [threatStrikeRow()],
        allowedMentions: { users: owners } });
      b.messageId = msg.id; b.channelId = ch.id; saveData(guildId);
    } catch (e) { console.error('[diyar threat post]', e.message); }
    startThreatLoop(guildId);
  }
  function startThreatLoop(guildId) {
    if (threatTimers[guildId]) clearInterval(threatTimers[guildId]);
    threatTimers[guildId] = setInterval(() => threatTick(guildId).catch(e => console.error('[diyar threat tick]', e.message)), THREAT_TICK_MS);
  }
  async function threatTick(guildId) {
    const state = stateOf(guildId); const b = state.boss;
    if (!b) { clearInterval(threatTimers[guildId]); delete threatTimers[guildId]; return; }
    if (b.hp <= 0) return finishThreat(guildId, 'defeated');
    if (Date.now() > b.endsAt) return finishThreat(guildId, 'expired');
    // the siege grinds each targeted city by 2–5 troops per tick, capped so it weakens but never demolishes
    for (const t of (b.targets || [])) {
      if (t.done) continue;
      const c = state.cities[t.cityId]; if (!c) { t.done = 'floor'; continue; }
      let dmg = THREAT_DMG_MIN + Math.floor(Math.random() * (THREAT_DMG_MAX - THREAT_DMG_MIN + 1));
      dmg = Math.min(dmg, THREAT_CITY_DMG_CAP - t.dmg, Math.max(0, c.garrison - THREAT_GARRISON_FLOOR));
      if (dmg > 0) { c.garrison -= dmg; t.dmg += dmg; }
      if (t.dmg >= THREAT_CITY_DMG_CAP) t.done = 'cap';
      else if (c.garrison <= THREAT_GARRISON_FLOOR) t.done = 'floor';
    }
    saveData(guildId);
    if (b.channelId && b.messageId) {
      try {
        const ch = await client.channels.fetch(b.channelId);
        const msg = await ch.messages.fetch(b.messageId);
        await msg.edit({ embeds: [threatEmbed(state)], components: [threatStrikeRow()] });
      } catch { /* message gone — the siege still grinds on */ }
    }
  }
  async function finishThreat(guildId, how) {
    const state = stateOf(guildId); const b = state.boss;
    if (threatTimers[guildId]) { clearInterval(threatTimers[guildId]); delete threatTimers[guildId]; }
    if (!b) return;
    const bm = { channelId: b.channelId, messageId: b.messageId };
    let finale;
    if (how === 'defeated') {
      const snapshot = { name: b.name, targets: b.targets };
      const res = resolveBossDefeat(state, db, guildId, saveData);
      if (res) for (const w of res.rewards) if (w.lp) awardLP(guildId, w.uid, w.lp, 'diyar');
      finale = threatDefeatEmbed(state, snapshot, res ? res.rewards : []);
    } else {
      const res = resolveBossExpire(state, db, guildId, saveData);
      finale = threatWithdrawEmbed(res);
    }
    try {
      const ch = await client.channels.fetch(bm.channelId);
      const msg = bm.messageId ? await ch.messages.fetch(bm.messageId).catch(() => null) : null;
      if (msg) await msg.edit({ embeds: [finale], components: [] });
      else await announce(guildId, { embeds: [finale] });
    } catch (e) { console.error('[diyar threat finish]', e.message); }
  }
  // ----- caravans -----
  const caravanTimers = {};   // in-memory animation intervals (not persisted)
  async function postCaravan(guildId) {
    const state = stateOf(guildId);
    const c = state.caravan; if (!c || !state.channelId) return;
    try {
      const ch = await client.channels.fetch(state.channelId);
      const msg = await ch.send({ embeds: [caravanOfferEmbed(state)], components: [caravanRow(false)] });
      c.messageId = msg.id; c.channelId = ch.id; saveData(guildId);
    } catch (e) { console.error('[diyar caravan post]', e.message); }
  }
  // replay the already-committed result frame by frame, then swap in the final card
  async function animateCaravan(guildId) {
    const state = stateOf(guildId);
    const c = state.caravan;
    if (!c || !c.choice || !c.channelId) return;
    let msg = null;
    try {
      const ch = await client.channels.fetch(c.channelId);
      msg = c.messageId ? await ch.messages.fetch(c.messageId).catch(() => null) : null;
    } catch { /* channel gone — we still finish below */ }
    let step = 1;
    if (caravanTimers[guildId]) clearInterval(caravanTimers[guildId]);
    caravanTimers[guildId] = setInterval(async () => {
      const st = stateOf(guildId); const cv = st.caravan;
      if (!cv || !cv.choice) { clearInterval(caravanTimers[guildId]); delete caravanTimers[guildId]; return; }
      if (step >= CARAVAN_FRAMES) {
        clearInterval(caravanTimers[guildId]); delete caravanTimers[guildId];
        const final = caravanFinalEmbed(cv);
        st.caravan = null; saveData(guildId);                 // the day's caravan is spent
        try {
          if (msg) await msg.edit({ embeds: [final], components: [] });
          else await announce(guildId, { embeds: [final] });
        } catch (e) { console.error('[diyar caravan finish]', e.message); }
        return;
      }
      try { if (msg) await msg.edit({ embeds: [caravanFrameEmbed(cv, step)], components: [caravanRow(true)] }); } catch { /* ignore a dropped edit */ }
      step++;
    }, CARAVAN_FRAME_MS);
  }
  // a claimed caravan whose animation died with a redeploy — settle it immediately
  async function settleCaravan(guildId) {
    const state = stateOf(guildId); const c = state.caravan;
    if (!c || !c.choice) return;
    const final = caravanFinalEmbed(c);
    state.caravan = null; saveData(guildId);
    try {
      const ch = await client.channels.fetch(c.channelId);
      const msg = c.messageId ? await ch.messages.fetch(c.messageId).catch(() => null) : null;
      if (msg) await msg.edit({ embeds: [final], components: [] });
      else await ch.send({ embeds: [final] });
    } catch (e) { console.error('[diyar caravan settle]', e.message); }
  }
  async function expireCaravan(guildId) {
    const state = stateOf(guildId); const c = state.caravan;
    if (!c || c.claimedBy) return;
    const embed = caravanExpireEmbed(c);
    state.caravan = null; saveData(guildId);
    try {
      const ch = await client.channels.fetch(c.channelId);
      const msg = c.messageId ? await ch.messages.fetch(c.messageId).catch(() => null) : null;
      if (msg) await msg.edit({ embeds: [embed], components: [] });
    } catch (e) { console.error('[diyar caravan expire]', e.message); }
  }

  // ----- the Hunt -----
  // resolve the hunted member's face/name at display time, so avatar changes keep up
  async function wantedFace(guildId) {
    const state = stateOf(guildId); const w = state.wanted;
    if (!w) return { url: null, name: 'Unknown' };
    try {
      const g = await client.guilds.fetch(guildId);
      const m = await g.members.fetch(w.userId);
      return { url: m.displayAvatarURL({ extension: 'png', size: 256 }), name: m.displayName };
    } catch { return { url: null, name: 'a stranger' }; }
  }
  async function postWanted(guildId) {
    const state = stateOf(guildId); const w = state.wanted;
    if (!w || !state.channelId) return;
    try {
      const ch = await client.channels.fetch(state.channelId);
      const face = await wantedFace(guildId);
      const msg = await ch.send({ embeds: [wantedPosterEmbed(state, face.url, face.name)], components: [wantedRow(false)] });
      w.messageId = msg.id; w.channelId = ch.id; saveData(guildId);
    } catch (e) { console.error('[diyar wanted post]', e.message); }
  }
  async function refreshWanted(guildId) {
    const state = stateOf(guildId); const w = state.wanted;
    if (!w || !w.channelId || !w.messageId) return;
    try {
      const ch = await client.channels.fetch(w.channelId);
      const msg = await ch.messages.fetch(w.messageId);
      const face = await wantedFace(guildId);
      await msg.edit({ embeds: [wantedPosterEmbed(state, face.url, face.name)], components: [wantedRow(false)] });
    } catch { /* poster gone — the hunt carries on regardless */ }
  }
  async function finishWanted(guildId, how) {
    const state = stateOf(guildId); const w = state.wanted;
    if (!w) return;
    const face = await wantedFace(guildId);
    let embed;
    if (how === 'caught') {
      const finder = state.players[w.caughtBy]?.name || 'Someone';
      embed = wantedCaughtEmbed(w, finder, face.url, face.name);
      state.wanted = null; saveData(guildId);
    } else {
      const res = escapeWanted(state, db, guildId, saveData);
      embed = wantedEscapedEmbed(res, face.name);
    }
    try {
      const ch = await client.channels.fetch(w.channelId);
      const msg = w.messageId ? await ch.messages.fetch(w.messageId).catch(() => null) : null;
      if (msg) await msg.edit({ embeds: [embed], components: [wantedRow(true)] });
      else await announce(guildId, { embeds: [embed] });
    } catch (e) { console.error('[diyar wanted finish]', e.message); }
  }

  async function announce(guildId, payload) {
    const state = stateOf(guildId); if (!state.channelId) return;
    try { const ch = await client.channels.fetch(state.channelId); await ch.send(payload); } catch (e) { console.error('[diyar announce]', e.message); }
  }

  // post the bilingual "how to start" nudge, deleting the previous one so only one lives in the channel
  async function postNudge(guildId) {
    const state = stateOf(guildId); if (!state.channelId) return;
    try {
      const ch = await client.channels.fetch(state.channelId);
      if (state.nudgeMsgId) {
        const old = await ch.messages.fetch(state.nudgeMsgId).catch(() => null);
        if (old) await old.delete().catch(() => {});           // silent if already gone
      }
      const n = Object.keys(state.players || {}).length;
      const embed = new EmbedBuilder().setColor(COLOR.gold).setTitle('🏴 Diyar — Conquest of Libya')
        .setDescription(
          `**New here?** Type \`/diyar\` to raise your banner and join the war for Libya${n > 0 ? ` — **${n}** ${n === 1 ? 'ruler is' : 'rulers are'} already fighting!` : '!'}\n` +
          `Seize cities, build an army, defend your land and battle the threat.\n\n` +
          `**هل أنت جديد؟** اكتب ⁦\`/diyar\`⁩ لرفع رايتك والانضمام إلى معركة ليبيا${n > 0 ? ` — يقاتل بالفعل **${n}** ${n === 1 ? 'حاكم' : 'حكّام'}!` : '!'}\n` +
          `استولِ على المدن، ابنِ جيشك، دافع عن أرضك، وواجه التهديد.`);
      const msg = await ch.send({ embeds: [embed] });
      state.nudgeMsgId = msg.id; saveData(guildId);
    } catch (e) { console.error('[diyar nudge]', e.message); }
  }

  // ── new-player discovery nudge: after a burst of channel activity settles into a lull,
  //    post a bilingual "how to start" invite as the last message, so it's the first thing
  //    a newcomer sees. Counts ALL messages (bot's own included) as activity. ──
  const NUDGE_MSG_THRESHOLD = 30;                   // messages that must accumulate before a nudge can arm
  const NUDGE_QUIET_MS      = 10 * 60 * 1000;       // channel must be silent this long (the "dip")
  const NUDGE_COOLDOWN_MS   = 3 * 60 * 60 * 1000;   // at most one nudge every ~3 hours

  // count every message in the Diyar channel and stamp the last-activity time (bot msgs included)
  client.on('messageCreate', (msg) => {
    try {
      if (!msg.guildId) return;
      const state = db[msg.guildId] && db[msg.guildId].__diyar;
      if (!state || !state.channelId || msg.channelId !== state.channelId) return;
      state.msgCount = (state.msgCount || 0) + 1;
      state.lastMsgAt = Date.now();
    } catch { /* ignore */ }
  });

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
  async function tick() {
    const now = Date.now();
    for (const guild of client.guilds.cache.values()) {
      const state = db[guild.id] && db[guild.id].__diyar;
      if (!state) continue;
      // threat recovery: resolve an expired siege, or reattach the live loop after a redeploy
      if (state.boss) {
        if (now > state.boss.endsAt && !threatTimers[guild.id]) await finishThreat(guild.id, 'expired');
        else if (!threatTimers[guild.id]) startThreatLoop(guild.id);
      }
      // spawn due bosses (only if a war room is set)
      if (state.channelId) {
        const sched = ensureBossSched(state, saveData, guild.id, now);
        const due = sched.spawns.find(s => !s.fired && s.at <= now);
        if (due) {
          due.fired = true; saveData(guild.id);
          if (!state.boss) { spawnBoss(state, saveData, guild.id); await postBoss(guild.id); }
        }
        // caravan recovery: settle a claimed one whose animation was lost, or retire an
        // unclaimed one that has run its hour
        if (state.caravan) {
          if (state.caravan.choice && !caravanTimers[guild.id]) await settleCaravan(guild.id);
          else if (!state.caravan.claimedBy && now > state.caravan.expiresAt) await expireCaravan(guild.id);
        }
        // spawn the day's caravan — held back while a boss is live so the two events
        // never compete for the channel (it fires as soon as the siege ends)
        const cvSched = ensureCaravanSched(state, saveData, guild.id, now);
        const cvDue = cvSched.spawns.find(s => !s.fired && s.at <= now);
        if (cvDue && !state.boss && !state.caravan) {
          cvDue.fired = true; saveData(guild.id);
          spawnCaravan(state, saveData, guild.id);
          await postCaravan(guild.id);
        }
        // the Hunt: drop the next clue on the hour, or let them slip away when clues run out
        if (state.wanted) {
          const w = state.wanted;
          if (w.caughtBy) await finishWanted(guild.id, 'caught');
          else if (now >= w.nextClueAt) {
            if (w.clues.length >= WANTED_MAX_CLUES) await finishWanted(guild.id, 'escaped');
            else {
              w.clueIdx++;
              w.clues.push(wantedClue(w.cityId, w.clueIdx));
              w.nextClueAt = now + WANTED_CLUE_MS;
              saveData(guild.id);
              await refreshWanted(guild.id);
            }
          }
        }
        // start the day's hunt — needs opted-in gacha members, and stays clear of a live boss
        const wtSched = ensureWantedSched(state, saveData, guild.id, now);
        const wtDue = wtSched.spawns.find(s2 => !s2.fired && s2.at <= now);
        if (wtDue && !state.boss && !state.wanted) {
          wtDue.fired = true; saveData(guild.id);
          if (spawnWanted(state, db, guild.id, saveData)) await postWanted(guild.id);
        }
        // discovery nudge: a burst of activity (≥30 messages) has since settled into a lull
        // (≥10 min quiet), and we're past the cooldown → post the bilingual invite as the last
        // message, deleting the previous nudge so only one ever sits in the channel
        if ((state.msgCount || 0) >= NUDGE_MSG_THRESHOLD
            && state.lastMsgAt && now - state.lastMsgAt >= NUDGE_QUIET_MS
            && now - (state.lastNudgeAt || 0) > NUDGE_COOLDOWN_MS) {
          state.lastNudgeAt = now; state.msgCount = 0; saveData(guild.id);
          await postNudge(guild.id);
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
          return interaction.reply({ embeds: leaderboard(state, interaction.user.id).embeds, components: [] });   // public: no interactive buttons
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
        if (interaction.commandName === 'diyar-spawn-threat') {
          if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild))
            return interaction.reply(eph({ content: 'You need the **Manage Server** permission to unleash a threat.' }));
          const state = stateOf(gid);
          if (state.boss) return interaction.reply(eph({ content: `👹 **${state.boss.name}** is already ravaging the realm — deal with that one first.` }));
          if (!state.channelId) return interaction.reply(eph({ content: 'Set a war room first with `/diyar-set-channel` so the threat has somewhere to appear.' }));
          spawnBoss(state, saveData, gid);
          await interaction.reply(eph({ content: '👹 A threat has been unleashed — check the war room!' }));
          await postBoss(gid);
          return;
        }
        if (interaction.commandName === 'diyar-spawn-caravan') {
          if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild))
            return interaction.reply(eph({ content: 'You need the **Manage Server** permission to send a caravan.' }));
          const state = stateOf(gid);
          if (state.caravan) return interaction.reply(eph({ content: `🐪 **${state.caravan.name}** is already on the road — let that one resolve first.` }));
          if (!state.channelId) return interaction.reply(eph({ content: 'Set a war room first with `/diyar-set-channel` so the caravan has somewhere to appear.' }));
          spawnCaravan(state, saveData, gid);
          await interaction.reply(eph({ content: '🐪 A caravan is crossing the realm — check the war room!' }));
          await postCaravan(gid);
          return;
        }
        if (interaction.commandName === 'diyar-spawn-wanted') {
          if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild))
            return interaction.reply(eph({ content: 'You need the **Manage Server** permission to post a bounty.' }));
          const state = stateOf(gid);
          if (state.wanted) return interaction.reply(eph({ content: '🪧 A hunt is already running — let that one play out first.' }));
          if (!state.channelId) return interaction.reply(eph({ content: 'Set a war room first with `/diyar-set-channel`.' }));
          if (!spawnWanted(state, db, gid, saveData))
            return interaction.reply(eph({ content: 'Nobody has opted into the card pool yet — they need `/gacha-optin` before they can be hunted.' }));
          await interaction.reply(eph({ content: '🪧 A bounty is live — check the war room!' }));
          await postWanted(gid);
          return;
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
      if (action === 'strike' || action === 'heavy') {
        const r = strikeBoss(state, saveData, gid, uid, action === 'heavy');
        if (r.error) return interaction.reply(eph({ content: r.error }));
        // the hit lands in the public Attack Log on the next 3s edit — no public spam.
        // heavy attacks are personal, so we deliver them via a private ephemeral button:
        if (r.heavyUnlocked) {
          // just primed one → give this player a private Heavy Attack button to use on their next hit
          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('dy:heavy').setLabel('💥 Heavy Attack (3×)').setStyle(ButtonStyle.Success));
          return interaction.reply(eph({ content: '💥 **Heavy Attack unlocked!** Your next strike deals **triple** damage — tap below (mind the 3s cooldown):', components: [row] }));
        }
        if (r.usedHeavy) return interaction.reply(eph({ content: `💥 **HEAVY HIT!** You struck for **${fmt(r.dmg)}** — triple damage! Back to normal strikes now.` }));
        return interaction.deferUpdate();
      }
      // the Hunt's dropdown is on the PUBLIC poster, so it's handled before the dashboard gate
      if (action === 'wt_guess') {
        const pick = interaction.values?.[0];
        const r = guessWanted(state, db, gid, saveData, uid, pick);
        if (r.error) return interaction.reply(eph({ content: r.error }));
        if (r.found) {
          await interaction.reply({ content: `⛓ **${state.players[uid].name}** found them in **${r.city.name}**!` });
          finishWanted(gid, 'caught').catch(e => console.error('[diyar wanted]', e.message));
          return;
        }
        const w = state.wanted;
        await interaction.reply(eph({ content: `🔍 You turn over **${r.city.name}** and find nothing but tea glasses and a cold trail. **−${fmt(WANTED_SEARCH_FEE)} Dinar**.\n\nNext clue in **${msLeft(w.nextClueAt)}** — you get another search then.` }));
        return;
      }

      if (action === 'bossdmg') return interaction.reply(eph(bossView(state)));

      // caravan buttons also come from the PUBLIC war-room message. The claim below is
      // fully synchronous — there is no await between reading and writing claimedBy —
      // so of two simultaneous taps exactly one wins and the loser gets a quiet notice.
      if (action === 'cv_raid' || action === 'cv_invite') {
        const res = claimCaravan(state, db, gid, saveData, uid, action === 'cv_raid' ? 'raid' : 'invite');
        if (res.error) return interaction.reply(eph({ content: res.error }));
        try { await interaction.update({ embeds: [caravanFrameEmbed(res.caravan, 0)], components: [caravanRow(true)] }); }
        catch { /* someone else's edit landed first — the animation still takes over */ }
        animateCaravan(gid).catch(e => console.error('[diyar caravan]', e.message));
        return;
      }

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
      if (action === 'leaderboard') return interaction.update(leaderboard(state, uid));
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
        const city = state.cities[cityId];
        const amt = parts[3] === 'all' ? state.players[uid].army : parseInt(parts[3], 10);
        if (Number.isFinite(amt) && amt > 0) {
          const res = reinforce(state, saveData, gid, uid, cityId, amt);
          if (res.ok) {
            const capNote = res.capped ? ` — now at the **${fmt(GARRISON_CAP)}** troop cap` : '';
            announce(gid, { content: `🛡 **${state.players[uid].name}** reinforced **${city.name}** with **${fmt(res.moved)}** troops${capNote} — its defence is now **${fmt(effectiveDefence(state, city))}**.` });
          } else if (res.capped) {
            return interaction.reply(eph({ content: `🛡 **${city.name}** is already holding the maximum of **${fmt(GARRISON_CAP)}** troops, so it can't take any more. Station your army in one of your other cities instead.` }));
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
      getState: () => stateOf, ensurePlayer, resolveAttack, recruit, upgrade, reinforce, collectIncome, tick,
      spawnBoss, strikeBoss, resolveBossDefeat, resolveBossExpire, playerStrength, ensureBossSched,
      pendingIncome, renderMap, renderBoss, renderBattle, pickTimes, reseedIfLanded, rankPlayers, threatEmbed, threatSiegeLines, threatBar,
      spawnWanted, guessWanted, escapeWanted, ensureWantedSched, wantedClue, wantedPosterEmbed, wantedRow, cityRegion,
      spawnCaravan, claimCaravan, ensureCaravanSched, caravanOfferEmbed, caravanFrameEmbed, caravanFinalEmbed, caravanExpireEmbed, caravanRow,
      claimTribute, buyWeapon, armouryView, profileView, leaderboard, resetSeason, targetSelect, reinforceSelect, effectiveDefence, effectiveAttack, startRaid, resolveRaid, troopCost, raidLiveEmbed, raidResultEmbed, threatTick, finishThreat, inviteLine, postNudge, threatDefeatEmbed, threatWithdrawEmbed, strikeBoss,
    },
  };
}

module.exports = { getDiyarCommands, initDiyar };
