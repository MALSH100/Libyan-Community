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
function emblem(cx, cy, r, fill, stroke, sw) {
  sw = sw || r * 0.06;
  const off = r * 0.42;
  const starR = r * 0.44, sx = cx + r * 1.0, sy = cy;
  let star = '';
  for (let i = 0; i < 5; i++) {
    const aO = -Math.PI / 2 + i * (2 * Math.PI / 5);
    const aI = aO + Math.PI / 5;
    star += `${i === 0 ? 'M' : 'L'} ${(sx + Math.cos(aO) * starR).toFixed(1)} ${(sy + Math.sin(aO) * starR).toFixed(1)} `;
    star += `L ${(sx + Math.cos(aI) * starR * 0.45).toFixed(1)} ${(sy + Math.sin(aI) * starR * 0.45).toFixed(1)} `;
  }
  star += 'Z';
  const mid = `cres${Math.round(cx)}${Math.round(cy)}`;
  return `<defs><mask id="${mid}"><rect x="${cx - r * 1.8}" y="${cy - r * 1.8}" width="${r * 3.6}" height="${r * 3.6}" fill="white"/>` +
    `<circle cx="${cx + off}" cy="${cy}" r="${r * 0.86}" fill="black"/></mask></defs>` +
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" mask="url(#${mid})"/>` +
    `<path d="${star}" fill="${fill}" stroke="${stroke}" stroke-width="${sw * 0.7}" stroke-linejoin="round"/>`;
}

// ── per-skin palette (background gradient, rim, emblem/text colours) ──
function skinPalette(key) {
  switch (key) {
    case 'carbon':   return { defs: `<pattern id="carbonhatch" width="16" height="16" patternTransform="rotate(45)" patternUnits="userSpaceOnUse"><rect width="16" height="16" fill="#17181b"/><rect width="8" height="16" fill="#232427"/></pattern>`,
                              bg: `<rect width="100%" height="100%" fill="#141416"/><rect width="100%" height="100%" fill="url(#carbonhatch)"/>`,
                              ring: '#c9ccd1', emblem: '#eef0f3', text: '#f2f3f5', textStroke: '#000000' };
    case 'electric': return { defs: `<radialGradient id="elecg" cx="50%" cy="45%" r="72%"><stop offset="0" stop-color="#123a86"/><stop offset="0.6" stop-color="#0a1f52"/><stop offset="1" stop-color="#050d2a"/></radialGradient>`,
                              bg: `<rect width="100%" height="100%" fill="url(#elecg)"/>`,
                              ring: '#5fa8ff', emblem: '#eaf4ff', text: '#ffffff', textStroke: '#0a1f52' };
    case 'galaxy':   return { defs: `<radialGradient id="galg" cx="50%" cy="45%" r="75%"><stop offset="0" stop-color="#7a44e0"/><stop offset="0.5" stop-color="#3b1d73"/><stop offset="1" stop-color="#120826"/></radialGradient>`,
                              bg: `<rect width="100%" height="100%" fill="url(#galg)"/>`,
                              ring: '#c9a6ff', emblem: '#f3ecff', text: '#ffffff', textStroke: '#2a1250' };
    case 'marble':   return { defs: `<linearGradient id="marbg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fbfbf9"/><stop offset="0.5" stop-color="#e8e8e4"/><stop offset="1" stop-color="#f3f3ef"/></linearGradient>`,
                              bg: `<rect width="100%" height="100%" fill="url(#marbg)"/>`,
                              ring: '#c9a37a', emblem: '#b98e5f', text: '#5a4a38', textStroke: '#ffffff' };
    case 'gold':     return { defs: `<radialGradient id="goldg" cx="50%" cy="44%" r="72%"><stop offset="0" stop-color="#ffe98a"/><stop offset="0.5" stop-color="#e7b41a"/><stop offset="1" stop-color="#a9790f"/></radialGradient>`,
                              bg: `<rect width="100%" height="100%" fill="url(#goldg)"/>`,
                              ring: '#fff2b0', emblem: '#7a5a0e', text: '#5a4406', textStroke: '#fff2b0' };
    default:         return { defs: '', bg: `<rect width="100%" height="100%" fill="#2b2d31"/>`,
                              ring: '#c9ccd1', emblem: '#e9ebee', text: '#ffffff', textStroke: '#000000' };
  }
}

// ── per-skin decorative overlay (the thing that makes each coin genuinely distinct) ──
function skinDecoration(key, cx, cy, R) {
  const RAD = Math.PI / 180;
  switch (key) {
    case 'carbon': {
      // hexagon tech ring + corner brackets
      let hex = '';
      const hr = R - 20;
      let pts = [];
      for (let i = 0; i < 6; i++) { const a = (i * 60 - 90) * RAD; pts.push(`${(cx + Math.cos(a) * hr).toFixed(1)},${(cy + Math.sin(a) * hr).toFixed(1)}`); }
      hex = `<polygon points="${pts.join(' ')}" fill="none" stroke="#3a3d42" stroke-width="2.5"/>`;
      let ticks = '';
      for (let i = 0; i < 48; i++) { const a = i * 7.5 * RAD; const r0 = R - 8, r1 = R - (i % 4 === 0 ? 16 : 12); ticks += `<line x1="${cx + Math.cos(a) * r0}" y1="${cy + Math.sin(a) * r0}" x2="${cx + Math.cos(a) * r1}" y2="${cy + Math.sin(a) * r1}" stroke="#4a4d52" stroke-width="1.5"/>`; }
      return hex + ticks;
    }
    case 'electric': {
      const bolt = (x0, y0, x1, y1, w, seed) => {
        const segs = 5; let d = `M ${x0} ${y0} `; let rnd = seed;
        const rand = () => { rnd = (rnd * 9301 + 49297) % 233280; return rnd / 233280; };
        for (let i = 1; i <= segs; i++) { const t = i / segs; const jx = (rand() - 0.5) * 32, jy = (rand() - 0.5) * 16; d += `L ${(x0 + (x1 - x0) * t + jx).toFixed(1)} ${(y0 + (y1 - y0) * t + jy).toFixed(1)} `; }
        return `<path d="${d}" fill="none" stroke="#7fc0ff" stroke-width="${w * 2.4}" opacity="0.3" stroke-linejoin="round" stroke-linecap="round"/><path d="${d}" fill="none" stroke="#eaf4ff" stroke-width="${w}" opacity="0.95" stroke-linejoin="round" stroke-linecap="round"/>`;
      };
      return bolt(cx - 82, cy - 92, cx - 20, cy, 3.5, 11) + bolt(cx + 82, cy - 80, cx + 18, cy, 3.5, 29) +
             bolt(cx - 76, cy + 96, cx - 18, cy + 6, 3, 47) + bolt(cx + 80, cy + 92, cx + 20, cy + 6, 3, 83) +
             `<circle cx="${cx}" cy="${cy}" r="64" fill="#1a4aa0" opacity="0.55"/>`;
    }
    case 'galaxy': {
      // scattered stars + orbital rings
      let stars = ''; let rnd = 7;
      const rand = () => { rnd = (rnd * 9301 + 49297) % 233280; return rnd / 233280; };
      for (let i = 0; i < 40; i++) {
        const a = rand() * Math.PI * 2, rr = 30 + rand() * (R - 34);
        const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr, sz = 0.6 + rand() * 1.8;
        stars += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${sz.toFixed(1)}" fill="#ffffff" opacity="${(0.4 + rand() * 0.6).toFixed(2)}"/>`;
      }
      const ring = (rx, ry, rot, op) => `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="none" stroke="#c9a6ff" stroke-width="1.5" opacity="${op}" transform="rotate(${rot} ${cx} ${cy})"/>`;
      return stars + ring(R - 24, R - 70, -20, 0.5) + ring(R - 40, R - 90, 35, 0.4) + `<circle cx="${cx}" cy="${cy}" r="60" fill="#5a2ea6" opacity="0.4"/>`;
    }
    case 'marble': {
      // grey veining + laurel wreath border
      let veins = ''; let rnd = 3;
      const rand = () => { rnd = (rnd * 9301 + 49297) % 233280; return rnd / 233280; };
      for (let i = 0; i < 5; i++) {
        const y0 = 60 + rand() * 280; let d = `M ${20 + rand() * 40} ${y0} `;
        for (let x = 60; x < 360; x += 40) d += `Q ${x} ${y0 + (rand() - 0.5) * 60}, ${x + 20} ${y0 + (rand() - 0.5) * 40} `;
        veins += `<path d="${d}" fill="none" stroke="#c8c8c2" stroke-width="${1 + rand() * 1.5}" opacity="0.5"/>`;
      }
      // laurel: little leaves around the lower arc
      let laurel = '';
      for (let i = 0; i < 20; i++) {
        const a = (200 + i * 8) * RAD; const lr = R - 16;
        const x = cx + Math.cos(a) * lr, y = cy + Math.sin(a) * lr;
        laurel += `<ellipse cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" rx="7" ry="3" fill="#b98e5f" opacity="0.8" transform="rotate(${(a / RAD) + 90} ${x.toFixed(1)} ${y.toFixed(1)})"/>`;
      }
      return veins + laurel;
    }
    case 'gold': {
      // radiating sunburst + dotted inner ring
      let rays = '';
      const rayCount = 48;
      for (let i = 0; i < rayCount; i++) {
        const a = (i / rayCount) * Math.PI * 2; const r0 = 34, r1 = R - 8; const w = i % 2 === 0 ? 0.05 : 0.018;
        const a1 = a + w, a2 = a - w;
        rays += `<path d="M ${cx + Math.cos(a1) * r0} ${cy + Math.sin(a1) * r0} L ${cx + Math.cos(a1) * r1} ${cy + Math.sin(a1) * r1} L ${cx + Math.cos(a2) * r1} ${cy + Math.sin(a2) * r1} L ${cx + Math.cos(a2) * r0} ${cy + Math.sin(a2) * r0} Z" fill="${i % 2 === 0 ? '#fff0b0' : '#d69e12'}" opacity="${i % 2 === 0 ? 0.5 : 0.4}"/>`;
      }
      let dots = '';
      for (let i = 0; i < 40; i++) { const a = (i / 40) * Math.PI * 2; dots += `<circle cx="${cx + Math.cos(a) * (R - 18)}" cy="${cy + Math.sin(a) * (R - 18)}" r="2.2" fill="#7a5a0e"/>`; }
      return rays + dots + `<circle cx="${cx}" cy="${cy}" r="66" fill="#c8960f" opacity="0.3"/>`;
    }
    default: return '';
  }
}

// ── render one face (heads/tails) of a skin → PNG buffer ──
function renderFace(skinKey, side) {
  const W = 400, H = 400, cx = W / 2, cy = H / 2, R = 150;
  const p = skinPalette(skinKey);
  const label = side === 'heads' ? 'HEADS' : 'TAILS';
  const font = resolveFont();
  const emScale = skinKey === 'gold' || skinKey === 'marble' ? 0.38 : 0.4;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="DejaVu Sans, sans-serif">` +
    `<defs>${p.defs}</defs>` +
    // layered rim for depth
    `<circle cx="${cx}" cy="${cy}" r="${R + 15}" fill="${p.ring}" opacity="0.5"/>` +
    `<circle cx="${cx}" cy="${cy}" r="${R + 11}" fill="${p.ring}"/>` +
    `<clipPath id="disc"><circle cx="${cx}" cy="${cy}" r="${R + 6}"/></clipPath>` +
    `<g clip-path="url(#disc)">${p.bg}${skinDecoration(skinKey, cx, cy, R)}</g>` +
    `<circle cx="${cx}" cy="${cy}" r="${R + 6}" fill="none" stroke="${p.ring}" stroke-width="6"/>` +
    // emblem
    emblem(cx - 12, cy, R * emScale, p.emblem, p.ring, 3.5) +
    // labels
    `<text x="${cx}" y="${cy - R * 0.64}" font-size="48" font-weight="bold" fill="${p.text}" text-anchor="middle" dominant-baseline="middle" style="paint-order:stroke;stroke:${p.textStroke};stroke-width:6px;">${label}</text>` +
    `<text x="${cx}" y="${cy + R * 0.68}" font-size="36" font-weight="bold" fill="${p.text}" text-anchor="middle" dominant-baseline="middle" style="paint-order:stroke;stroke:${p.textStroke};stroke-width:5px;">${label}</text>` +
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

// ── overhead spinning-coin animation (per skin) ──
// Top-down view: the disc squishes horizontally (scaleX 1→0→1) like a coin spinning on its
// edge, so you see the skin's colours/rim rotating but never a readable HEADS/TAILS face.
const { GIFEncoder, quantize, applyPalette } = require('gifenc');

// one spin frame at horizontal scale sx (1 = full face-ish, ~0 = edge-on)
function spinFrameSVG(skinKey, sx, edgeShade) {
  const W = 320, H = 320, cx = W / 2, cy = H / 2, R = 130;
  const p = skinPalette(skinKey);
  // when nearly edge-on, show the coin's "side" (a thin shaded ellipse) instead of the face
  const faceW = Math.max(2, R * Math.abs(sx));
  const showFace = Math.abs(sx) > 0.12;
  const grad = `<defs>${p.defs}<clipPath id="disc"><ellipse cx="${cx}" cy="${cy}" rx="${faceW}" ry="${R}"/></clipPath></defs>`;
  let body;
  if (showFace) {
    // squished disc showing skin background + decoration + emblem hint (no readable text)
    body =
      `<ellipse cx="${cx}" cy="${cy}" rx="${faceW + 6}" ry="${R + 6}" fill="${p.ring}"/>` +
      `<g clip-path="url(#disc)"><g transform="translate(${cx},${cy}) scale(${sx},1) translate(${-cx},${-cy})">${p.bg}${skinDecoration(skinKey, cx, cy, R)}</g></g>` +
      // faint emblem, scaled with the squish so it rotates with the face but stays unreadable
      `<g clip-path="url(#disc)" opacity="0.9"><g transform="translate(${cx},${cy}) scale(${sx},1) translate(${-cx},${-cy})">${emblem(cx - 10, cy, R * 0.4, p.emblem, p.ring, 3)}</g></g>` +
      `<ellipse cx="${cx}" cy="${cy}" rx="${faceW + 6}" ry="${R + 6}" fill="none" stroke="${p.ring}" stroke-width="5"/>`;
  } else {
    // edge-on: a thin bright sliver (the coin's rim catching light)
    body = `<ellipse cx="${cx}" cy="${cy}" rx="6" ry="${R + 6}" fill="${p.ring}"/>` +
           `<ellipse cx="${cx}" cy="${cy}" rx="3" ry="${R}" fill="${edgeShade}"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${grad}${body}</svg>`;
}

// build the spin GIF for one skin (seamless loop: face → edge → face → edge …)
function renderSpinGif(skinKey) {
  const font = resolveFont();
  const opts = { fitTo: { mode: 'width', value: 320 },
    font: font ? { fontFiles: [font], loadSystemFonts: false, defaultFontFamily: 'DejaVu Sans' } : { loadSystemFonts: true },
    background: 'rgba(0,0,0,0)' };
  const p = skinPalette(skinKey);
  const edge = p.ring;
  const gif = GIFEncoder();
  const STEPS = 16;               // frames for a half-turn; full cycle mirrors it
  let first = true;
  // scaleX sweeps 1 → -1 → 1 over a full rotation; sign flip = the back coming around
  for (let i = 0; i < STEPS * 2; i++) {
    const ang = (i / (STEPS * 2)) * Math.PI * 2;
    const sx = Math.cos(ang);     // 1 → 0 → -1 → 0 → 1
    const img = new Resvg(spinFrameSVG(skinKey, sx, edge), opts).render();
    const palette = quantize(img.pixels, 64);
    const indexed = applyPalette(img.pixels, palette);
    const o = { palette, delay: 55 };
    if (first) { o.repeat = 0; first = false; }   // loop forever
    gif.writeFrame(indexed, img.width, img.height, o);
  }
  gif.finish();
  return Buffer.from(gif.bytes());
}

// lazy cache: render each skin's spin GIF once on first use, then reuse (Option 2 — no per-flip cost)
const _spinCache = {};
function getSpinGif(skinKey) {
  if (skinKey === 'default') return null;             // default uses the existing committed GIF
  if (_spinCache[skinKey]) return _spinCache[skinKey];
  try { _spinCache[skinKey] = renderSpinGif(skinKey); return _spinCache[skinKey]; }
  catch (e) { return null; }
}

module.exports = { SKINS, skinByKey, RARITY_COLOR, renderFace, coinState, getOwned, isOwned, addOwned, getEquipped, equip, renderSpinGif, getSpinGif };
