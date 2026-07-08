// ─────────────────────────────────────────────────────────────────────────────
// coinskins.js — cosmetic coin skins for the coin flip.
//   • Reskins ONLY the heads/tails result faces (the spin GIF & default coin are untouched).
//   • Skins are drawn in code (SVG → PNG), same pipeline as the lottery wheel / palette.
//   • Ownership + equipped choice live in db[guild].__coinskins.
// Exposes: getOwned, isOwned, equip, getEquipped, buy-eligibility, renderFace(skinKey, side),
//          SKINS list, and the shop UI helpers used by hub.js.
// ─────────────────────────────────────────────────────────────────────────────
const path = require('path');
const fs = require('fs');
const { Resvg } = require('@resvg/resvg-js');

// ── skins: flavour + rarity + price ladder ──
// key 'default' is the built-in coin (free, always owned, uses the existing PNG — not rendered here)
const SKINS = [
  { key: 'default', name: 'Classic Dinar',  rarity: 'Default',   price: 0,    emoji: '🪙' },
  { key: 'carbon',  name: 'Obsidian Carbon', rarity: 'Common',    price: 500,  emoji: '⬛' },
  { key: 'electric',name: 'Blue Electric',   rarity: 'Uncommon',  price: 1500, emoji: '⚡' },
  { key: 'galaxy',  name: 'Cosmic Galaxy',   rarity: 'Rare',      price: 4000, emoji: '🌌' },
  { key: 'marble',  name: 'White Marble',    rarity: 'Epic',      price: 9000, emoji: '🤍' },
  { key: 'gold',    name: 'Royal Gold',      rarity: 'Legendary', price: 20000,emoji: '👑' },
];
const skinByKey = (k) => SKINS.find(s => s.key === k);
const RARITY_COLOR = { Default: 0x8a94a6, Common: 0x9aa0aa, Uncommon: 0x27c4e5, Rare: 0xa855f7, Epic: 0xff5d8f, Legendary: 0xe7b41a };

// ── font (shared with the rest of the bot) ──
const FONT_CANDIDATES = [
  path.join(__dirname, 'DejaVuSans.ttf'), path.join(__dirname, 'fonts', 'DejaVuSans.ttf'),
  path.join(process.cwd(), 'DejaVuSans.ttf'), path.join(process.cwd(), 'fonts', 'DejaVuSans.ttf'),
];
let _font;
function resolveFont() {
  if (_font !== undefined) return _font;
  _font = FONT_CANDIDATES.find(f => { try { return fs.existsSync(f); } catch { return false; } }) || null;
  return _font;
}

// ── the crescent + star emblem, shared by every skin (colour configurable) ──
function emblem(cx, cy, r, fill, stroke) {
  // crescent = big circle with an offset circle punched out; star to its right
  const off = r * 0.42;
  const starR = r * 0.42, sx = cx + r * 0.95, sy = cy;
  // 5-point star path
  let star = '';
  for (let i = 0; i < 5; i++) {
    const aO = -Math.PI / 2 + i * (2 * Math.PI / 5);
    const aI = aO + Math.PI / 5;
    star += `${i === 0 ? 'M' : 'L'} ${(sx + Math.cos(aO) * starR).toFixed(1)} ${(sy + Math.sin(aO) * starR).toFixed(1)} `;
    star += `L ${(sx + Math.cos(aI) * starR * 0.45).toFixed(1)} ${(sy + Math.sin(aI) * starR * 0.45).toFixed(1)} `;
  }
  star += 'Z';
  return `<defs><mask id="cres"><rect x="${cx - r * 1.6}" y="${cy - r * 1.6}" width="${r * 3.2}" height="${r * 3.2}" fill="white"/>` +
    `<circle cx="${cx + off}" cy="${cy}" r="${r * 0.86}" fill="black"/></mask></defs>` +
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${r * 0.06}" mask="url(#cres)"/>` +
    `<path d="${star}" fill="${fill}" stroke="${stroke}" stroke-width="${r * 0.04}" stroke-linejoin="round"/>`;
}

// ── per-skin background + emblem/text palette ──
function skinPalette(key) {
  switch (key) {
    case 'carbon':   return { bg: `<rect width="100%" height="100%" rx="24" fill="#141416"/>` +
                                   `<rect width="100%" height="100%" rx="24" fill="url(#carbonhatch)"/>`,
                              defs: `<pattern id="carbonhatch" width="14" height="14" patternTransform="rotate(45)" patternUnits="userSpaceOnUse"><rect width="14" height="14" fill="#1b1b1e"/><rect width="7" height="14" fill="#242427"/></pattern>`,
                              ring: '#c9ccd1', emblem: '#e9ebee', text: '#f2f3f5', textStroke: '#000000' };
    case 'electric': return { bg: `<rect width="100%" height="100%" rx="24" fill="url(#elecg)"/>`,
                              defs: `<radialGradient id="elecg" cx="50%" cy="45%" r="75%"><stop offset="0" stop-color="#0a2a6b"/><stop offset="0.6" stop-color="#071947"/><stop offset="1" stop-color="#030c26"/></radialGradient>`,
                              ring: '#5fa8ff', emblem: '#dbe8ff', text: '#ffffff', textStroke: '#0a2a6b' };
    case 'galaxy':   return { bg: `<rect width="100%" height="100%" rx="24" fill="url(#galg)"/>`,
                              defs: `<radialGradient id="galg" cx="50%" cy="50%" r="75%"><stop offset="0" stop-color="#6d3bd6"/><stop offset="0.5" stop-color="#3b1d73"/><stop offset="1" stop-color="#160a2e"/></radialGradient>`,
                              ring: '#c9a6ff', emblem: '#f0e6ff', text: '#ffffff', textStroke: '#3b1d73' };
    case 'marble':   return { bg: `<rect width="100%" height="100%" rx="24" fill="url(#marbg)"/>`,
                              defs: `<linearGradient id="marbg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f7f7f4"/><stop offset="0.5" stop-color="#e9e9e6"/><stop offset="1" stop-color="#f2f2ef"/></linearGradient>`,
                              ring: '#c9a37a', emblem: '#c9a37a', text: '#5a4a38', textStroke: '#ffffff' };
    case 'gold':     return { bg: `<rect width="100%" height="100%" rx="24" fill="url(#goldg)"/>`,
                              defs: `<radialGradient id="goldg" cx="50%" cy="45%" r="75%"><stop offset="0" stop-color="#ffe071"/><stop offset="0.55" stop-color="#e7b41a"/><stop offset="1" stop-color="#9c7410"/></radialGradient>`,
                              ring: '#fff2b0', emblem: '#7a5a0e', text: '#5a4406', textStroke: '#fff2b0' };
    default:         return { bg: `<rect width="100%" height="100%" rx="24" fill="#2b2d31"/>`,
                              defs: '', ring: '#c9ccd1', emblem: '#e9ebee', text: '#ffffff', textStroke: '#000000' };
  }
}

// ── render one face (heads/tails) of a skin → PNG buffer ──
function renderFace(skinKey, side) {
  const W = 400, H = 400, cx = W / 2, cy = H / 2, R = 150;
  const p = skinPalette(skinKey);
  const label = side === 'heads' ? 'HEADS' : 'TAILS';
  const font = resolveFont();
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="DejaVu Sans, sans-serif">` +
    `<defs>${p.defs}</defs>` +
    // outer coin disc
    `<circle cx="${cx}" cy="${cy}" r="${R + 14}" fill="${p.ring}"/>` +
    `<clipPath id="disc"><circle cx="${cx}" cy="${cy}" r="${R + 6}"/></clipPath>` +
    `<g clip-path="url(#disc)">${p.bg}</g>` +
    `<circle cx="${cx}" cy="${cy}" r="${R + 6}" fill="none" stroke="${p.ring}" stroke-width="6"/>` +
    // emblem (crescent + star)
    emblem(cx - 14, cy, R * 0.42, p.emblem, p.ring) +
    // top + bottom label
    `<text x="${cx}" y="${cy - R * 0.62}" font-size="52" font-weight="bold" fill="${p.text}" text-anchor="middle" dominant-baseline="middle" style="paint-order:stroke;stroke:${p.textStroke};stroke-width:5px;">${label}</text>` +
    `<text x="${cx}" y="${cy + R * 0.66}" font-size="40" font-weight="bold" fill="${p.text}" text-anchor="middle" dominant-baseline="middle" style="paint-order:stroke;stroke:${p.textStroke};stroke-width:4px;">${label}</text>` +
    `</svg>`;
  return new Resvg(svg, {
    fitTo: { mode: 'width', value: W },
    font: font ? { fontFiles: [font], loadSystemFonts: false, defaultFontFamily: 'DejaVu Sans' } : { loadSystemFonts: true },
    background: 'rgba(0,0,0,0)',
  }).render().asPng();
}

module.exports = { SKINS, skinByKey, RARITY_COLOR, renderFace };

// ── ownership + equipped state (persisted in db[guild].__coinskins) ──
function coinState(db, guildId) {
  const data = db[guildId] || (db[guildId] = {});
  if (!data.__coinskins) data.__coinskins = { owned: {}, equipped: {} };  // owned:{uid:[keys]}, equipped:{uid:key}
  return data.__coinskins;
}
function getOwned(db, guildId, uid) {
  const st = coinState(db, guildId);
  const list = st.owned[uid] || [];
  return ['default', ...list.filter(k => k !== 'default')];   // everyone always owns default
}
function isOwned(db, guildId, uid, key) {
  if (key === 'default') return true;
  return (coinState(db, guildId).owned[uid] || []).includes(key);
}
function addOwned(db, guildId, uid, key, saveData) {
  const st = coinState(db, guildId);
  (st.owned[uid] ||= []);
  if (!st.owned[uid].includes(key)) st.owned[uid].push(key);
  if (saveData) saveData(guildId);
}
function getEquipped(db, guildId, uid) {
  const key = coinState(db, guildId).equipped[uid] || 'default';
  return isOwned(db, guildId, uid, key) ? key : 'default';
}
function equip(db, guildId, uid, key, saveData) {
  if (!isOwned(db, guildId, uid, key)) return false;
  coinState(db, guildId).equipped[uid] = key;
  if (saveData) saveData(guildId);
  return true;
}

module.exports = { SKINS, skinByKey, RARITY_COLOR, renderFace, coinState, getOwned, isOwned, addOwned, getEquipped, equip };
