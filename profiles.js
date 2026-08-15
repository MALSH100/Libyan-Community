// profiles.js — Rich player profile cards for the Hub.
//
// A landscape "trading card" rendered via SVG → resvg (PNG), or animated GIF for
// premium cosmetics. Surfaces live stats from the existing systems (gacha flip
// stats, Dinar + wealth rank, gacha collection, clan, equipped coin) and layers
// purchasable cosmetics on top: backgrounds, frames, name colours, titles, badges,
// effects. Includes a server showcase where members publish their card and others
// give it ❤ — the heart count is shown on the card itself.
//
// Wiring (in index.js initShop call): pass `profileApi: initProfiles({ db, saveData, gachaApi, getDinar, spendDinar })`
// then hub.js consumes it. All Dinar goes through the shared getDinar/spendDinar so
// balances never desync.

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, StringSelectMenuBuilder, ButtonStyle } = require('discord.js');
const { Resvg } = require('@resvg/resvg-js');
const fs   = require('fs');
const path = require('path');
const clans = require('./clanfns');
let coins = null; try { coins = require('./coinskins'); } catch { /* optional */ }

// ── font (mirrors the exchange module's resolution: fonts/ dir or repo root) ──
const FONT_CANDIDATES = [
  path.join(__dirname, 'fonts', 'DejaVuSans.ttf'),
  path.join(__dirname, 'DejaVuSans.ttf'),
];
const FONT_PATH = FONT_CANDIDATES.find(f => { try { return fs.existsSync(f); } catch { return false; } }) || FONT_CANDIDATES[0];
const FONT_BOLD_CANDIDATES = [
  path.join(__dirname, 'fonts', 'DejaVuSans-Bold.ttf'),
  path.join(__dirname, 'DejaVuSans-Bold.ttf'),
];
const FONT_BOLD = FONT_BOLD_CANDIDATES.find(f => { try { return fs.existsSync(f); } catch { return false; } }) || null;

// Collect every font file we can find (from /fonts or repo root) for resvg, so the
// wacky fonts render. Missing files are skipped; text falls back to DejaVu Sans.
function collectFontFiles() {
  const wanted = ['DejaVuSans.ttf','DejaVuSans-Bold.ttf','DejaVuSerif.ttf','DejaVuSansMono.ttf','Bangers.ttf','PermanentMarker.ttf','Pacifico.ttf','PressStart2P.ttf','Creepster.ttf','Righteous.ttf'];
  const found = [];
  for (const name of wanted) {
    for (const dir of [path.join(__dirname, 'fonts'), __dirname]) {
      const p = path.join(dir, name);
      try { if (fs.existsSync(p)) { found.push(p); break; } } catch { /* */ }
    }
  }
  if (!found.length) found.push(FONT_PATH);
  return found;
}
const ALL_FONT_FILES = collectFontFiles();

const fmt = (n) => Math.round(n || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ───────────────────────────────────────────────────────────────────────────
// COSMETIC CATALOGUE
// Prices tuned so a casual affords an entry cosmetic fast, with prestige/animated
// items to save toward. free:true = owned by everyone from the start.
// GIF/animated items are the premium tier (pricier), per the design.
// ───────────────────────────────────────────────────────────────────────────

// Backgrounds define the card's base. `render(ctx)` returns the SVG for the
// background layer. `anim:true` marks animated (GIF) backgrounds — pricier.
const BACKGROUNDS = [
  { key: 'slate',    name: 'Slate',           price: 0,     free: true,  kind: 'solid',    colors: ['#1e293b'] },
  { key: 'charcoal', name: 'Charcoal',        price: 0,     free: true,  kind: 'solid',    colors: ['#111827'] },
  { key: 'sand',     name: 'Desert Sand',     price: 400,   kind: 'gradient', colors: ['#d4a574', '#8b5a2b'] },
  { key: 'ocean',    name: 'Ocean',           price: 400,   kind: 'gradient', colors: ['#0ea5e9', '#0c4a6e'] },
  { key: 'sunset',   name: 'Sunset',          price: 600,   kind: 'gradient', colors: ['#f97316', '#7c2d12'] },
  { key: 'emerald',  name: 'Emerald',         price: 600,   kind: 'gradient', colors: ['#10b981', '#064e3b'] },
  { key: 'grape',    name: 'Grape',           price: 600,   kind: 'gradient', colors: ['#8b5cf6', '#4c1d95'] },
  { key: 'rose',     name: 'Rose Gold',       price: 900,   kind: 'gradient', colors: ['#fb7185', '#881337'] },
  { key: 'mesh',     name: 'Neon Mesh',       price: 1500,  kind: 'mesh',     colors: ['#6366f1', '#ec4899', '#06b6d4'] },
  { key: 'carbon',   name: 'Carbon Fibre',    price: 1800,  kind: 'carbon',   colors: ['#1f2937', '#111827'] },
  { key: 'aurora',   name: 'Aurora (animated)', price: 6000, anim: true, kind: 'aurora', colors: ['#22d3ee', '#a855f7', '#ec4899'] },
  { key: 'starfield',name: 'Starfield (animated)', price: 8000, anim: true, kind: 'starfield', colors: ['#0b1026', '#1e1b4b'] },
];

// Frames = the border around the card. `render` supplies stroke styling.
const FRAMES = [
  { key: 'none',    name: 'None',            price: 0, free: true, stroke: null },
  { key: 'bronze',  name: 'Bronze',          price: 0, free: true, stroke: '#b08d57', width: 6 },
  { key: 'silver',  name: 'Silver',          price: 0, free: true, stroke: '#cbd5e1', width: 6 },
  { key: 'gold',    name: 'Gold',            price: 0, free: true, stroke: '#fbbf24', width: 7, glow: '#f59e0b' },
  { key: 'emerald', name: 'Emerald',         price: 0, free: true, stroke: '#34d399', width: 7, glow: '#10b981' },
  { key: 'ruby',    name: 'Ruby',            price: 0, free: true, stroke: '#fb7185', width: 7, glow: '#e11d48' },
  { key: 'pink',    name: 'Pink',            price: 0, free: true, stroke: '#f472b6', width: 7, glow: '#ec4899' },
  { key: 'rose',    name: 'Rose Gold',       price: 0, free: true, stroke: '#fda4af', width: 7, glow: '#fb7185' },
  { key: 'lilac',   name: 'Lilac',           price: 0, free: true, stroke: '#c4b5fd', width: 7, glow: '#a855f7' },
  { key: 'sky',     name: 'Sky Blue',        price: 0, free: true, stroke: '#38bdf8', width: 7, glow: '#0ea5e9' },
  { key: 'crimson', name: 'Crimson',         price: 0, free: true, stroke: '#ef4444', width: 7, glow: '#dc2626' },
  { key: 'white',   name: 'White',           price: 0, free: true, stroke: '#f8fafc', width: 6 },
  { key: 'black',   name: 'Black',           price: 0, free: true, stroke: '#1e293b', width: 7 },
  { key: 'ornate',  name: 'Ornate Gold',     price: 0, free: true, stroke: '#fcd34d', width: 9, glow: '#f59e0b', ornate: true },
  { key: 'ornatepink', name: 'Ornate Pink',  price: 0, free: true, stroke: '#f9a8d4', width: 9, glow: '#ec4899', ornate: true },
  // ── animated frames ──
  { key: 'rainbow',    name: 'Rainbow ✨',       price: 0, free: true, anim: true,      stroke: 'rainbow', width: 8 },
  { key: 'goldpulse',  name: 'Gold Pulse ✨',    price: 0, free: true, anim: 'pulse',   stroke: '#fbbf24', width: 7, glow: '#f59e0b' },
  { key: 'pinkpulse',  name: 'Pink Pulse ✨',    price: 0, free: true, anim: 'pulse',   stroke: '#f472b6', width: 7, glow: '#ec4899' },
  { key: 'rubypulse',  name: 'Ruby Pulse ✨',    price: 0, free: true, anim: 'pulse',   stroke: '#fb7185', width: 7, glow: '#e11d48' },
  { key: 'skypulse',   name: 'Sky Pulse ✨',     price: 0, free: true, anim: 'pulse',   stroke: '#38bdf8', width: 7, glow: '#0ea5e9' },
  { key: 'emeraldpulse', name: 'Emerald Pulse ✨', price: 0, free: true, anim: 'pulse', stroke: '#34d399', width: 7, glow: '#10b981' },
  { key: 'lilacpulse', name: 'Lilac Pulse ✨',   price: 0, free: true, anim: 'pulse',   stroke: '#c4b5fd', width: 7, glow: '#a855f7' },
  { key: 'goldshimmer', name: 'Gold Shimmer ✨', price: 0, free: true, anim: 'shimmer', stroke: '#b8860b', shimmerHi: '#fff4c2', width: 8, glow: '#f59e0b' },
  { key: 'silvershimmer', name: 'Silver Shimmer ✨', price: 0, free: true, anim: 'shimmer', stroke: '#94a3b8', shimmerHi: '#ffffff', width: 8, glow: '#cbd5e1' },
  { key: 'pinkshimmer', name: 'Pink Shimmer ✨', price: 0, free: true, anim: 'shimmer', stroke: '#db2777', shimmerHi: '#fce7f3', width: 8, glow: '#ec4899' },
];

// Name colours (solid or gradient text fill for the display name)
const NAMECOLORS = [
  { key: 'white',   name: 'White',      price: 0,    free: true, colors: ['#ffffff'] },
  { key: 'gold',    name: 'Gold',       price: 500,  colors: ['#fbbf24'] },
  { key: 'sky',     name: 'Sky',        price: 500,  colors: ['#38bdf8'] },
  { key: 'mint',    name: 'Mint',       price: 500,  colors: ['#34d399'] },
  { key: 'rose',    name: 'Rose',       price: 500,  colors: ['#fb7185'] },
  { key: 'fire',    name: 'Fire',       price: 1200, colors: ['#fbbf24', '#ef4444'] },
  { key: 'ocean',   name: 'Ocean',      price: 1200, colors: ['#22d3ee', '#3b82f6'] },
  { key: 'candy',   name: 'Candy',      price: 1200, colors: ['#f472b6', '#a855f7'] },
  { key: 'chrome',  name: 'Chrome (animated)', price: 4000, anim: true, colors: ['#e5e7eb', '#9ca3af', '#f9fafb'] },
];

// Titles — a line of flavour text under the name. Some are prestige (earned).
const TITLES = [
  { key: 'none',      name: '(no title)',        price: 0,    free: true, text: '' },
  { key: 'newcomer',  name: 'Newcomer',          price: 200,  text: 'Newcomer' },
  { key: 'regular',   name: 'Regular',           price: 500,  text: 'Regular' },
  { key: 'highroller',name: 'High Roller',       price: 1500, text: 'High Roller' },
  { key: 'collector', name: 'The Collector',     price: 1500, text: 'The Collector' },
  { key: 'legend',    name: 'Living Legend',     price: 4000, text: 'Living Legend' },
  { key: 'sultan',    name: 'Sultan',            price: 6000, text: 'Sultan' },
  { key: 'gambler',   name: 'Lucky Devil',       price: 2500, text: 'Lucky Devil' },
];

// Effects = an overlay on the whole card (holo sheen, particles). Some animated.
const EFFECTS = [
  { key: 'none',   name: 'None',              price: 0,    free: true },
  { key: 'holo',   name: 'Holographic',       price: 2000, kind: 'holo' },
  { key: 'sparkle',name: 'Sparkles (animated)', price: 5000, anim: true, kind: 'sparkle' },
  { key: 'confetti',name: 'Confetti (animated)', price: 5000, anim: true, kind: 'confetti' },
];

const CATALOGUE = { background: BACKGROUNDS, frame: FRAMES, namecolor: NAMECOLORS, title: TITLES, effect: EFFECTS };
const SLOT_LABEL = { background: 'Background', frame: 'Frame', namecolor: 'Name Colour', title: 'Title', effect: 'Effect' };
const DEFAULT_EQUIP = { background: 'slate', frame: 'none', namecolor: 'white', title: 'none', effect: 'none' };

const catalogueItem = (slot, key) => (CATALOGUE[slot] || []).find(i => i.key === key) || null;

// ───────────────────────────────────────────────────────────────────────────
// STATE  (db[guildId].__profiles)
//   owned:    { uid: { background:[keys], frame:[], namecolor:[], title:[], effect:[] } }
//   equipped: { uid: { background, frame, namecolor, title, effect } }
//   hearts:   { uid: [voterId, ...] }          who hearted this profile
//   published:{ uid: true }                    appears in the showcase
// ───────────────────────────────────────────────────────────────────────────
function pState(db, gid) {
  const g = (db[gid] ||= {});
  const p = (g.__profiles ||= {});
  p.owned     ||= {};
  p.equipped  ||= {};
  p.hearts    ||= {};
  p.published ||= {};
  return p;
}
function ownedSlots(db, gid, uid) {
  const p = pState(db, gid);
  const o = (p.owned[uid] ||= {});
  for (const slot of Object.keys(CATALOGUE)) o[slot] ||= [];
  return o;
}
function isOwned(db, gid, uid, slot, key) {
  const item = catalogueItem(slot, key);
  if (!item) return false;
  if (item.free) return true;
  return ownedSlots(db, gid, uid)[slot].includes(key);
}
function addOwned(db, gid, uid, slot, key, saveData) {
  const o = ownedSlots(db, gid, uid);
  if (!o[slot].includes(key)) o[slot].push(key);
  if (saveData) saveData(gid);
}
function getEquipped(db, gid, uid) {
  const p = pState(db, gid);
  const e = (p.equipped[uid] ||= { ...DEFAULT_EQUIP });
  for (const slot of Object.keys(DEFAULT_EQUIP)) {
    if (!e[slot] || !isOwned(db, gid, uid, slot, e[slot])) e[slot] = DEFAULT_EQUIP[slot];
  }
  return e;
}
function equipItem(db, gid, uid, slot, key, saveData) {
  if (!isOwned(db, gid, uid, slot, key)) return false;
  const p = pState(db, gid);
  (p.equipped[uid] ||= { ...DEFAULT_EQUIP })[slot] = key;
  if (saveData) saveData(gid);
  return true;
}
function heartsFor(db, gid, uid) { return (pState(db, gid).hearts[uid] || []).length; }
function hasHearted(db, gid, uid, voterId) { return (pState(db, gid).hearts[uid] || []).includes(voterId); }
function toggleHeart(db, gid, uid, voterId, saveData) {
  const p = pState(db, gid);
  const arr = (p.hearts[uid] ||= []);
  const i = arr.indexOf(voterId);
  let hearted;
  if (i === -1) { arr.push(voterId); hearted = true; } else { arr.splice(i, 1); hearted = false; }
  if (saveData) saveData(gid);
  return { hearted, total: arr.length };
}

// ───────────────────────────────────────────────────────────────────────────
// LAYOUT / EDITOR SYSTEM  (Path A — customizable card)
//
// Each user has a `layout` describing a free-form card:
//   { elements: [ {id, type, x, y, w, h, rot, z, data} ], stats: [statKeys...] }
// Elements render in z-order on top of the equipped background+frame. Types:
//   'text'    data:{ text, font, size, color, bold }
//   'sticker' data:{ imageKey }            (custom uploaded image, stored base64)
//   'stat'    data:{ stat }                (a live stat block: dinar, flips, etc.)
//   'image'   data:{ imageKey, circle }    (uploaded background/photo element)
// Custom uploaded images live in p.images[uid][imageKey] = dataURI (base64), so the
// renderer is fully self-contained (resvg embeds them; no network at render time).
//
// Fonts available to text elements (all must exist as files, else fall back to DejaVu):
const FONTS = [
  { key: 'sans',    name: 'Sans',            family: 'DejaVu Sans',      file: null },
  { key: 'serif',   name: 'Serif',           family: 'DejaVu Serif',     file: 'DejaVuSerif.ttf' },
  { key: 'mono',    name: 'Monospace',       family: 'DejaVu Sans Mono', file: 'DejaVuSansMono.ttf' },
  { key: 'comic',   name: 'Comic (Bangers)', family: 'Bangers',          file: 'Bangers.ttf' },
  { key: 'marker',  name: 'Marker',          family: 'Permanent Marker', file: 'PermanentMarker.ttf' },
  { key: 'script',  name: 'Script (Pacifico)', family: 'Pacifico',       file: 'Pacifico.ttf' },
  { key: 'arcade',  name: 'Arcade (8-bit)',  family: 'Press Start 2P',   file: 'PressStart2P.ttf' },
  { key: 'spooky',  name: 'Spooky',          family: 'Creepster',        file: 'Creepster.ttf' },
  { key: 'bold',    name: 'Chunky',          family: 'Righteous',        file: 'Righteous.ttf' },
];
const fontByKey = (k) => FONTS.find(f => f.key === k) || FONTS[0];

// Which live stats a user can place as stat elements
const STAT_DEFS = {
  dinar:     { label: 'DINAR',       accent: '#fbbf24', get: (s) => fmt(s.dinar) },
  rank:      { label: 'WEALTH RANK', accent: '#f9fafb', get: (s) => s.wealthRank ? `#${s.wealthRank}` : 'Unranked' },
  activity:  { label: 'ACTIVITY RANK', accent: '#fb923c', get: (s) => s.activityRank ? `#${s.activityRank}` : 'Unranked' },
  flips:     { label: 'COIN FLIPS',  accent: '#34d399', get: (s) => `${(s.flip||{}).wins||0}W / ${(s.flip||{}).losses||0}L` },
  winrate:   { label: 'WIN RATE',    accent: '#38bdf8', get: (s) => `${((s.flip||{}).winPct||0).toFixed(0)}%` },
  net:       { label: 'NET FLIP',    accent: '#34d399', get: (s) => { const n=(s.flip||{}).net||0; return `${n>=0?'+':''}${fmt(n)}`; } },
  streak:    { label: 'STREAK',      accent: '#f472b6', get: (s) => { const k=(s.flip||{}).streak||0; return k>0?`${k}W`:k<0?`${Math.abs(k)}L`:'—'; } },
  cards:     { label: 'CARDS',       accent: '#c4b5fd', get: (s) => `${(s.collection||{}).count||0}` },
  coin:      { label: 'COIN DESIGN', accent: '#fcd34d', get: (s) => s.coin || 'Default' },
  clan:      { label: 'CLAN',        accent: '#a5b4fc', get: (s) => s.clan ? s.clan.name : 'None' },
  joined:    { label: 'JOINED',      accent: '#67e8f9', get: (s) => s.joined || '—' },
  cities:    { label: 'CITIES HELD', accent: '#f87171', multiline: true,
               get: (s) => (s.cities && s.cities.length) ? s.cities.join(', ') : 'None' },
};
const STAT_KEYS = Object.keys(STAT_DEFS);

// ── text fitting ──────────────────────────────────────────────────────────
// resvg gives us no way to measure text before drawing, so we approximate.
// DejaVu Sans Bold averages ~0.60x the font size per character; digits and caps
// run a little wider, so 0.62 keeps us on the safe side of the box.
const CHAR_W = 0.62;
const textWidth = (s, size) => String(s).length * size * CHAR_W;
function fitFont(text, maxW, preferred, min) {
  if (textWidth(text, preferred) <= maxW) return preferred;
  return Math.max(min, Math.floor(maxW / (Math.max(1, String(text).length) * CHAR_W)));
}
// Greedy word wrap. Falls back to hard-splitting a single over-long word, and
// marks the final line with an ellipsis if we run out of room.
function wrapToWidth(text, maxW, size, maxLines) {
  const words = String(text).split(/[\s,]+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? `${cur}, ${w}` : w;
    if (textWidth(test, size) <= maxW) { cur = test; continue; }
    if (cur) lines.push(cur);
    cur = w;
    while (textWidth(cur, size) > maxW && cur.length > 1) {
      const keep = Math.max(1, Math.floor(maxW / (size * CHAR_W)) - 1);
      lines.push(cur.slice(0, keep));
      cur = cur.slice(keep);
    }
    if (lines.length >= maxLines) break;
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  if (lines.length > maxLines) lines.length = maxLines;
  const consumed = lines.join(', ').length;
  if (consumed < String(text).length && lines.length) {
    const last = lines[lines.length - 1];
    lines[lines.length - 1] = last.replace(/[,\s]+$/, '') + '…';
  }
  return lines;
}

let __eid = 0;
const newElementId = () => `e${Date.now().toString(36)}${(__eid++).toString(36)}`;

function getLayout(db, gid, uid) {
  const p = pState(db, gid);
  const layouts = (p.layouts ||= {});
  if (!layouts[uid]) layouts[uid] = defaultLayout();
  return layouts[uid];
}
function defaultLayout() {
  // a sensible starting layout mirroring the classic card: a name text + a row of stat boxes
  return {
    custom: false,   // becomes true once the user edits — until then we render the classic template
    elements: [],
    stats: ['dinar', 'rank', 'flips', 'winrate', 'net', 'streak', 'cards', 'coin'],
  };
}
function userImages(db, gid, uid) {
  const p = pState(db, gid);
  const imgs = (p.images ||= {});
  return (imgs[uid] ||= {});
}
function addUserImage(db, gid, uid, dataUri, saveData) {
  const imgs = userImages(db, gid, uid);
  const key = `img${Date.now().toString(36)}${Math.floor(Math.random()*1e4).toString(36)}`;
  imgs[key] = dataUri;
  if (saveData) saveData(gid);
  return key;
}
const MAX_IMAGES = 8;
function imageCount(db, gid, uid) { return Object.keys(userImages(db, gid, uid)).length; }
function removeUserImage(db, gid, uid, imageKey, saveData) {
  const imgs = userImages(db, gid, uid);
  if (!(imageKey in imgs)) return false;
  delete imgs[imageKey];
  const layout = getLayout(db, gid, uid);
  layout.elements = layout.elements.filter(e => e.data?.imageKey !== imageKey);
  if (layout.bannerKey === imageKey) delete layout.bannerKey;
  if (saveData) saveData(gid);
  return true;
}
function setBanner(db, gid, uid, imageKey, saveData) {
  const layout = getLayout(db, gid, uid);
  if (imageKey && userImages(db, gid, uid)[imageKey]) { layout.bannerKey = imageKey; layout.custom = true; }
  else delete layout.bannerKey;
  if (saveData) saveData(gid);
  return layout.bannerKey || null;
}
function clampEl(el) {
  el.x = Math.max(-40, Math.min(CARD_W - 10, el.x));
  el.y = Math.max(-40, Math.min(CARD_H - 10, el.y));
  el.w = Math.max(16, Math.min(CARD_W, el.w));
  el.h = Math.max(16, Math.min(CARD_H, el.h));
  el.rot = ((el.rot % 360) + 360) % 360;
  return el;
}
function addElement(db, gid, uid, type, data, saveData) {
  const layout = getLayout(db, gid, uid);
  layout.custom = true;
  const maxZ = layout.elements.reduce((m, e) => Math.max(m, e.z || 0), 0);
  // sensible default size per type
  const size = type === 'text' ? { w: 240, h: 44 }
    : type === 'stat' ? { w: 198, h: 70 }
    : type === 'avatar' ? { w: 132, h: 132 }
    : type === 'name' ? { w: 300, h: 50 }
    : type === 'clan' ? { w: 260, h: 26 }
    : { w: 140, h: 140 };
  const el = clampEl({ id: newElementId(), type, x: 60, y: 60, ...size, rot: 0, z: maxZ + 1, data: data || {} });
  layout.elements.push(el);
  if (saveData) saveData(gid);
  return el;
}
function getElement(db, gid, uid, elId) {
  return getLayout(db, gid, uid).elements.find(e => e.id === elId) || null;
}
function updateElement(db, gid, uid, elId, patch, saveData) {
  const el = getElement(db, gid, uid, elId);
  if (!el) return null;
  const origData = el.data || {};
  const { data: patchData, ...rest } = patch;   // keep data out of the top-level assign
  Object.assign(el, rest);
  if (patchData) el.data = { ...origData, ...patchData };   // merge, never replace
  clampEl(el);
  getLayout(db, gid, uid).custom = true;
  if (saveData) saveData(gid);
  return el;
}
function removeElement(db, gid, uid, elId, saveData) {
  const layout = getLayout(db, gid, uid);
  const before = layout.elements.length;
  layout.elements = layout.elements.filter(e => e.id !== elId);
  if (saveData) saveData(gid);
  return layout.elements.length < before;
}
function reorderElement(db, gid, uid, elId, dir, saveData) {
  // dir: 'front' | 'back'
  const layout = getLayout(db, gid, uid);
  const el = layout.elements.find(e => e.id === elId);
  if (!el) return false;
  const maxZ = layout.elements.reduce((m, e) => Math.max(m, e.z || 0), 0);
  const minZ = layout.elements.reduce((m, e) => Math.min(m, e.z || 0), 0);
  el.z = dir === 'front' ? maxZ + 1 : minZ - 1;
  if (saveData) saveData(gid);
  return true;
}
function toggleStat(db, gid, uid, statKey, saveData) {
  const layout = getLayout(db, gid, uid);
  layout.stats ||= [];
  const i = layout.stats.indexOf(statKey);
  if (i === -1) layout.stats.push(statKey); else layout.stats.splice(i, 1);
  layout.custom = true;
  if (saveData) saveData(gid);
  return layout.stats.includes(statKey);
}
function resetLayout(db, gid, uid, saveData) {
  const p = pState(db, gid);
  (p.layouts ||= {})[uid] = defaultLayout();
  if (saveData) saveData(gid);
}


// ───────────────────────────────────────────────────────────────────────────
// STATS GATHERING — pulls live data from the other systems for the card.
// gachaApi (hubApi) gives flip stats via flipBoard, Dinar via balance, collection.
// ───────────────────────────────────────────────────────────────────────────
function gatherStats(ctx, gid, uid, member) {
  const { db, gachaApi, getDinar } = ctx;
  const out = { dinar: 0, wealthRank: null, activityRank: null, flip: null, collection: null,
                clan: null, coin: null, potd: 0, cities: [], joined: null };

  // ── activity rank: position on the LP (levels/activity) board ──
  try {
    const lp = (db[gid] && db[gid].__lp) || {};
    const board = Object.entries(lp)
      .map(([id, v]) => ({ id, total: (v && v.total) || 0 }))
      .filter(e => e.total > 0)
      .sort((a, b) => b.total - a.total);
    const i = board.findIndex(e => e.id === uid);
    if (i !== -1) out.activityRank = i + 1;
  } catch { /* */ }

  // ── cities conquered in Diyar ──
  try {
    const d = db[gid] && db[gid].__diyar;
    if (d && d.cities) {
      out.cities = Object.values(d.cities)
        .filter(c => c && c.ownerId === uid)
        .map(c => c.name)
        .sort();
    }
  } catch { /* */ }

  // ── server join date ──
  try {
    const at = member && member.joinedAt ? new Date(member.joinedAt) : null;
    if (at && !isNaN(at)) out.joined = at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch { /* */ }


  try { out.dinar = getDinar ? getDinar(db, gid, uid) : (gachaApi ? gachaApi.balance(gid, uid) : 0); } catch { /* */ }

  // wealth rank from the richest board
  try {
    const rich = gachaApi ? gachaApi.richest(gid) : [];
    const idx = rich.findIndex(r => r.id === uid);
    if (idx !== -1) out.wealthRank = idx + 1;
  } catch { /* */ }

  // coin-flip record — flipBoard only returns players with games>0; if absent, zeros
  try {
    const board = gachaApi ? gachaApi.flipBoard(gid) : [];
    const mine = board.find(r => r.id === uid);
    // flipBoard filters to games>0 and top 10; for full accuracy read state directly if exposed
    if (mine) out.flip = { wins: mine.wins, losses: mine.losses, games: mine.games, net: mine.net, winPct: mine.winPct };
    // pull streak straight from raw state if we can reach it
    const s = db[gid] && (db[gid].__gacha || db[gid].gacha);
    const fstat = s && s.flipStats && s.flipStats[uid];
    if (fstat) {
      out.flip = out.flip || { wins: fstat.wins || 0, losses: fstat.losses || 0, games: (fstat.wins||0)+(fstat.losses||0), net: (fstat.won||0)-(fstat.lost||0), winPct: ((fstat.wins||0)+(fstat.losses||0)) ? (fstat.wins/((fstat.wins||0)+(fstat.losses||0)))*100 : 0 };
      out.flip.streak = fstat.streak || 0;
      out.flip.won = fstat.won || 0; out.flip.lost = fstat.lost || 0;
    }
  } catch { /* */ }

  // gacha collection
  try {
    const col = gachaApi ? gachaApi.collection(gid, uid) : null;
    if (col) out.collection = { count: col.count, value: col.totalValue, byTier: col.byTier, emoji: col.emoji, tiers: col.tiers };
  } catch { /* */ }

  // clan
  try {
    const c = clans.userClan(db, gid, uid);
    if (c) out.clan = { name: c.name, rank: clans.userRank ? clans.userRank(c.clan, uid) : 'Member' };
  } catch { /* */ }

  // equipped coin design
  try {
    if (coins) {
      const key = coins.getEquipped(db, gid, uid);
      const skin = coins.skinByKey ? coins.skinByKey(key) : null;
      out.coin = skin ? skin.name : (key || 'Default');
    }
  } catch { /* */ }

  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// SVG CARD RENDER
// Landscape trading card, 900×420. Avatar (as a data-URI PNG) top-left, name +
// title beside it, stats grid below, hearts + tier bottom corners.
// ───────────────────────────────────────────────────────────────────────────
const CARD_W = 900, CARD_H = 420;

function bgSvg(bg, frame) {
  // returns { defs, rect } for the background layer
  const colors = bg.colors || ['#1e293b'];
  let defs = '', fill = colors[0];
  if (bg.kind === 'gradient') {
    defs += `<linearGradient id="bgGrad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${colors[0]}"/><stop offset="100%" stop-color="${colors[1] || colors[0]}"/></linearGradient>`;
    fill = 'url(#bgGrad)';
  } else if (bg.kind === 'mesh') {
    defs += `<radialGradient id="m1" cx="20%" cy="20%" r="60%"><stop offset="0%" stop-color="${colors[0]}"/><stop offset="100%" stop-color="#0b1026" stop-opacity="0"/></radialGradient>
      <radialGradient id="m2" cx="80%" cy="30%" r="60%"><stop offset="0%" stop-color="${colors[1]}"/><stop offset="100%" stop-color="#0b1026" stop-opacity="0"/></radialGradient>
      <radialGradient id="m3" cx="50%" cy="90%" r="70%"><stop offset="0%" stop-color="${colors[2]||colors[0]}"/><stop offset="100%" stop-color="#0b1026" stop-opacity="0"/></radialGradient>`;
    fill = '#0b1026';
  } else if (bg.kind === 'carbon') {
    defs += `<pattern id="carbon" width="12" height="12" patternUnits="userSpaceOnUse">
      <rect width="12" height="12" fill="${colors[0]}"/>
      <rect width="6" height="6" fill="${colors[1]}"/><rect x="6" y="6" width="6" height="6" fill="${colors[1]}"/></pattern>`;
    fill = 'url(#carbon)';
  } else if (bg.kind === 'aurora' || bg.kind === 'starfield') {
    // animated kinds render their static base here; frames add motion in GIF path
    defs += `<linearGradient id="bgGrad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${colors[0]}"/><stop offset="100%" stop-color="${colors[colors.length-1]}"/></linearGradient>`;
    fill = bg.kind === 'starfield' ? (colors[0] || '#0b1026') : 'url(#bgGrad)';
  }
  const meshRects = bg.kind === 'mesh'
    ? `<rect width="${CARD_W}" height="${CARD_H}" fill="url(#m1)"/><rect width="${CARD_W}" height="${CARD_H}" fill="url(#m2)"/><rect width="${CARD_W}" height="${CARD_H}" fill="url(#m3)"/>`
    : '';
  return { defs, rect: `<rect width="${CARD_W}" height="${CARD_H}" fill="${fill}"/>${meshRects}` };
}

function frameSvg(frame, phase = 0) {
  if (!frame || !frame.stroke) return { defs: '', el: '' };
  const inset = 5, w = frame.width || 6;
  let defs = '', stroke = frame.stroke;
  let extraGlowStd = 4;
  let strokeOpacity = 1;
  if (frame.stroke === 'rainbow') {
    // animated rainbow: rotate hue by phase
    const hue = Math.floor(phase * 360);
    defs += `<linearGradient id="rbF" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="hsl(${hue},90%,60%)"/>
      <stop offset="50%" stop-color="hsl(${(hue+120)%360},90%,60%)"/>
      <stop offset="100%" stop-color="hsl(${(hue+240)%360},90%,60%)"/></linearGradient>`;
    stroke = 'url(#rbF)';
  } else if (frame.anim === 'pulse') {
    // animated glow pulse: the border's glow blur + opacity breathe with phase
    const t = 0.5 + 0.5 * Math.sin(phase * Math.PI * 2);   // 0..1..0
    extraGlowStd = 2 + t * 7;                               // glow swells and shrinks
    strokeOpacity = 0.7 + 0.3 * t;                          // brightness breathes
  } else if (frame.anim === 'shimmer') {
    // animated shimmer: a bright band sweeps around the border via a moving gradient
    const p = phase % 1;
    const c = frame.stroke, hi = frame.shimmerHi || '#ffffff';
    defs += `<linearGradient id="shm_${frame.key}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="${Math.max(0,(p-0.15)).toFixed(3)}" stop-color="${c}"/>
      <stop offset="${p.toFixed(3)}" stop-color="${hi}"/>
      <stop offset="${Math.min(1,(p+0.15)).toFixed(3)}" stop-color="${c}"/></linearGradient>`;
    stroke = `url(#shm_${frame.key})`;
  }
  const glow = frame.glow ? `<filter id="fglow"><feGaussianBlur stdDeviation="${extraGlowStd.toFixed(2)}" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>` : '';
  const filterAttr = frame.glow ? ` filter="url(#fglow)"` : '';
  const opAttr = strokeOpacity < 1 ? ` stroke-opacity="${strokeOpacity.toFixed(2)}"` : '';
  const el = `<rect x="${inset}" y="${inset}" width="${CARD_W-inset*2}" height="${CARD_H-inset*2}" rx="18" fill="none" stroke="${stroke}" stroke-width="${w}"${filterAttr}${opAttr}/>`
    + (frame.ornate ? `<rect x="${inset+8}" y="${inset+8}" width="${CARD_W-(inset+8)*2}" height="${CARD_H-(inset+8)*2}" rx="12" fill="none" stroke="${stroke}" stroke-width="1.5" stroke-opacity="0.6"/>` : '');
  return { defs: glow + defs, el };
}

function nameFill(nc) {
  const colors = nc.colors || ['#ffffff'];
  if (colors.length === 1) return { defs: '', fill: colors[0] };
  const defs = `<linearGradient id="nameGrad" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0%" stop-color="${colors[0]}"/><stop offset="100%" stop-color="${colors[colors.length-1]}"/></linearGradient>`;
  return { defs, fill: 'url(#nameGrad)' };
}

function statBox(x, y, w, label, value, accent) {
  return `<g>
    <rect x="${x}" y="${y}" width="${w}" height="70" rx="10" fill="#000000" fill-opacity="0.55"/>
    <text x="${x+14}" y="${y+26}" font-family="'DejaVu Sans'" font-size="13" fill="#cbd5e1" letter-spacing="1">${esc(label)}</text>
    <text x="${x+14}" y="${y+54}" font-family="'DejaVu Sans'" font-size="24" font-weight="700" fill="${accent||'#ffffff'}">${esc(value)}</text>
  </g>`;
}

function truncate(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

// Build the full card SVG. avatarDataUri may be null (falls back to a monogram).
// Snug hearts pill, hugging the top-right edge — width fits heart + digits (no empty gap).
function heartBadgeSvg(hearts) {
  const label = fmt(hearts);
  const digits = label.length;
  const padL = 14, heartW = 22, gap = 6, digitW = 13, padR = 12;
  const badgeW = padL + heartW + gap + digits * digitW + padR;
  const badgeX = CARD_W - badgeW - 18;
  const y = 24, h = 38;
  const hx = badgeX + padL + heartW / 2, hy = y + 14;
  const heartPath = `M ${hx} ${hy+4} C ${hx} ${hy+1}, ${hx-4} ${hy-3}, ${hx-8} ${hy-1} C ${hx-12} ${hy+1}, ${hx-11} ${hy+6}, ${hx} ${hy+13} C ${hx+11} ${hy+6}, ${hx+12} ${hy+1}, ${hx+8} ${hy-1} C ${hx+4} ${hy-3}, ${hx} ${hy+1}, ${hx} ${hy+4} Z`;
  const textX = badgeX + padL + heartW + gap;
  return `<g>
    <rect x="${badgeX}" y="${y}" width="${badgeW}" height="${h}" rx="${h/2}" fill="#000000" fill-opacity="0.6"/>
    <path d="${heartPath}" fill="#ef4444" stroke="#b91c1c" stroke-width="1"/>
    <text x="${textX}" y="${y+26}" font-family="'DejaVu Sans'" font-size="22" font-weight="700" fill="#fb7185">${label}</text>
  </g>`;
}

function cardSvg(ctx, gid, member, stats, equip, opts = {}) {
  const phase = opts.phase || 0;
  const bg    = catalogueItem('background', equip.background) || BACKGROUNDS[0];
  const frame = catalogueItem('frame', equip.frame) || FRAMES[0];
  const nc    = catalogueItem('namecolor', equip.namecolor) || NAMECOLORS[0];
  const title = catalogueItem('title', equip.title) || TITLES[0];
  const effect= catalogueItem('effect', equip.effect) || EFFECTS[0];

  const bgL = bgSvg(bg, frame);
  const frL = frameSvg(frame, phase);
  const nmL = nameFill(nc);

  const name  = truncate(member.displayName || member.username || 'Player', 20);
  const av    = opts.avatarDataUri;
  const AVX = 34, AVY = 34, AVR = 66;

  // avatar circle (image or monogram)
  const avatar = av
    ? `<clipPath id="avc"><circle cx="${AVX+AVR}" cy="${AVY+AVR}" r="${AVR}"/></clipPath>
       <image href="${av}" x="${AVX}" y="${AVY}" width="${AVR*2}" height="${AVR*2}" clip-path="url(#avc)" preserveAspectRatio="xMidYMid slice"/>
       <circle cx="${AVX+AVR}" cy="${AVY+AVR}" r="${AVR}" fill="none" stroke="#ffffff" stroke-opacity="0.85" stroke-width="3"/>`
    : `<circle cx="${AVX+AVR}" cy="${AVY+AVR}" r="${AVR}" fill="#334155"/>
       <text x="${AVX+AVR}" y="${AVY+AVR+14}" text-anchor="middle" font-family="'DejaVu Sans'" font-size="46" font-weight="700" fill="#e2e8f0">${esc((name[0]||'?').toUpperCase())}</text>
       <circle cx="${AVX+AVR}" cy="${AVY+AVR}" r="${AVR}" fill="none" stroke="#ffffff" stroke-opacity="0.5" stroke-width="3"/>`;

  // header text
  const nameX = AVX + AVR*2 + 26;
  const titleLine = title.text
    ? `<text x="${nameX}" y="106" font-family="'DejaVu Sans'" font-size="20" font-style="italic" fill="#e2e8f0" fill-opacity="0.92">“${esc(truncate(title.text,26))}”</text>`
    : '';
  const clanLine = stats.clan
    ? `<text x="${nameX}" y="${title.text?134:112}" font-family="'DejaVu Sans'" font-size="16" fill="#a5b4fc">⚔ ${esc(truncate(stats.clan.name,22))} · ${esc(stats.clan.rank)}</text>`
    : '';

  // stats grid (bottom area)
  const gy = 186, gx = 30, gw = 198, gap = 14;
  const flip = stats.flip || { wins:0, losses:0, games:0, net:0, winPct:0, streak:0 };
  const streakTxt = flip.streak > 0 ? `${flip.streak}W🔥` : flip.streak < 0 ? `${Math.abs(flip.streak)}L❄` : '—';
  const col = stats.collection || { count:0, value:0 };
  const grid = [
    statBox(gx + (gw+gap)*0, gy, gw, 'DINAR', fmt(stats.dinar), '#fbbf24'),
    statBox(gx + (gw+gap)*1, gy, gw, 'WEALTH RANK', stats.wealthRank ? `#${stats.wealthRank}` : 'Unranked', '#f9fafb'),
    statBox(gx + (gw+gap)*2, gy, gw, 'COIN FLIPS', `${flip.wins}W / ${flip.losses}L`, '#34d399'),
    statBox(gx + (gw+gap)*3, gy, gw, 'WIN RATE', `${(flip.winPct||0).toFixed(0)}%`, '#38bdf8'),
    statBox(gx + (gw+gap)*0, gy+84, gw, 'NET FLIP', `${flip.net>=0?'+':''}${fmt(flip.net)}`, flip.net>=0?'#34d399':'#fb7185'),
    statBox(gx + (gw+gap)*1, gy+84, gw, 'STREAK', streakTxt, '#f472b6'),
    statBox(gx + (gw+gap)*2, gy+84, gw, 'CARDS', `${col.count}`, '#c4b5fd'),
    statBox(gx + (gw+gap)*3, gy+84, gw, 'COIN DESIGN', truncate(stats.coin || 'Default', 12), '#fcd34d'),
  ].join('');

  // hearts badge (top-right) — snug pill hugging the right edge
  const hearts = opts.hearts || 0;
  const heartBadge = heartBadgeSvg(hearts);

  // effect overlay
  let effectOverlay = '', effectDefs = '';
  if (effect.kind === 'holo') {
    effectDefs += `<linearGradient id="holo" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.0"/>
      <stop offset="45%" stop-color="#a5f3fc" stop-opacity="0.12"/>
      <stop offset="55%" stop-color="#f0abfc" stop-opacity="0.12"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.0"/></linearGradient>`;
    effectOverlay = `<rect width="${CARD_W}" height="${CARD_H}" rx="18" fill="url(#holo)"/>`;
  } else if (effect.kind === 'sparkle' || effect.kind === 'confetti') {
    // animated particles: deterministic positions shifted by phase
    let parts = '';
    const N = effect.kind === 'confetti' ? 26 : 18;
    for (let i = 0; i < N; i++) {
      const seed = (i * 97.13) % 1;
      const x = ((seed * CARD_W) + phase * (40 + i*3)) % CARD_W;
      const y = ((i * 53.7) % CARD_H + phase * 60 * (effect.kind==='confetti'?1:0)) % CARD_H;
      const size = 3 + (i % 3);
      const colors = ['#fbbf24','#f472b6','#34d399','#38bdf8','#c4b5fd'];
      if (effect.kind === 'confetti') {
        parts += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${size+2}" height="${size+2}" fill="${colors[i%colors.length]}" fill-opacity="0.85" transform="rotate(${(i*40+phase*120)%360} ${x.toFixed(1)} ${y.toFixed(1)})"/>`;
      } else {
        const tw = 0.5 + 0.5*Math.abs(Math.sin(phase*Math.PI*2 + i));
        parts += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${size*0.6}" fill="#ffffff" fill-opacity="${tw.toFixed(2)}"/>`;
      }
    }
    effectOverlay = parts;
  }

  // starfield animated background dots
  let starLayer = '';
  if (bg.kind === 'starfield') {
    for (let i = 0; i < 60; i++) {
      const x = (i * 137.5) % CARD_W;
      const y = (i * 89.3) % CARD_H;
      const tw = 0.3 + 0.7*Math.abs(Math.sin(phase*Math.PI*2 + i*0.7));
      starLayer += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(i%3===0?1.6:1)}" fill="#ffffff" fill-opacity="${tw.toFixed(2)}"/>`;
    }
  }
  // aurora animated ribbons
  let auroraLayer = '';
  if (bg.kind === 'aurora') {
    const cols = bg.colors;
    for (let b = 0; b < 3; b++) {
      const yBase = 120 + b*80;
      const off = Math.sin(phase*Math.PI*2 + b) * 40;
      auroraLayer += `<path d="M0 ${yBase+off} Q ${CARD_W*0.25} ${yBase-60+off}, ${CARD_W*0.5} ${yBase+off} T ${CARD_W} ${yBase+off} V ${CARD_H} H 0 Z" fill="${cols[b%cols.length]}" fill-opacity="0.16"/>`;
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}" viewBox="0 0 ${CARD_W} ${CARD_H}">
    <defs>${bgL.defs}${frL.defs}${nmL.defs}${effectDefs}
      <clipPath id="card"><rect width="${CARD_W}" height="${CARD_H}" rx="18"/></clipPath>
    </defs>
    <g clip-path="url(#card)">
      ${bgL.rect}
      ${starLayer}${auroraLayer}
      <rect width="${CARD_W}" height="${CARD_H}" fill="#000000" fill-opacity="0.12"/>
      ${avatar}
      <text x="${nameX}" y="76" font-family="'DejaVu Sans'" font-size="40" font-weight="700" fill="${nmL.fill}">${esc(name)}</text>
      ${titleLine}${clanLine}
      ${grid}
      ${heartBadge}
      ${effectOverlay}
    </g>
    ${frL.el}
  </svg>`;
}

// ── render one element to SVG ────────────────────────────────────────────────
function elementSvg(el, ctx2) {
  const { stats, images, selectedId, member, avatarDataUri: av } = ctx2;
  const cx = el.x + el.w / 2, cy = el.y + el.h / 2;
  const rot = el.rot ? ` transform="rotate(${el.rot} ${cx} ${cy})"` : '';
  let inner = '';
  if (el.type === 'text') {
    const d = el.data || {};
    const font = fontByKey(d.font).family;
    const size = d.size || 30;
    const color = d.color || '#ffffff';
    const weight = (d.bold === false) ? '' : ' font-weight="700"';   // bold by default
    inner = `<text x="${el.x}" y="${el.y + size}" font-family="'${font}'" font-size="${size}" fill="${color}"${weight}>${esc(truncate(d.text || 'Text', 40))}</text>`;
  } else if (el.type === 'stat') {
    const def = STAT_DEFS[el.data?.stat] || STAT_DEFS.dinar;
    const pad = 14, innerW = Math.max(20, el.w - pad * 2);
    const raw = String(def.get(stats) ?? '');
    // Label shrinks if the box is narrow so it never spills either.
    const labSize = fitFont(def.label, innerW, 13, 8);
    const labBase = el.y + 10 + labSize;              // label baseline
    const valTop  = labBase + 6;                      // value area starts under the label
    const availH  = Math.max(12, el.y + el.h - valTop - 8);
    // A dark outline behind the glyphs lifts the value off the panel so it reads
    // clearly against any background image. paint-order keeps the stroke behind
    // the fill so the letterforms stay crisp rather than looking bloated.
    const pop = `stroke="#000000" stroke-opacity="0.55" stroke-width="0.5" paint-order="stroke fill"`;
    let body;
    if (def.multiline) {
      // Lists (e.g. captured cities) wrap onto as many lines as the box allows.
      // Grow the type until either the line count or the box height runs out.
      let lnSize = 22, lines = null;
      for (; lnSize >= 11; lnSize--) {
        const lh = lnSize * 1.24;
        const maxLines = Math.max(1, Math.floor(availH / lh));
        const cand = wrapToWidth(raw, innerW, lnSize, maxLines);
        if (cand.length && cand.length * lh <= availH && !cand[cand.length - 1].endsWith('…')) { lines = cand; break; }
        if (!lines && lnSize === 11) lines = cand;
      }
      lines = lines || [raw];
      const lh = lnSize * 1.24;
      const startY = valTop + Math.max(0, (availH - lines.length * lh) / 2) + lnSize;
      body = lines.map((ln, i) =>
        `<text x="${el.x+pad}" y="${(startY + i*lh).toFixed(1)}" font-family="'DejaVu Sans'" font-size="${lnSize}" font-weight="700" fill="${def.accent}" ${pop}>${esc(ln)}</text>`
      ).join('');
    } else {
      // Single values grow to fill the panel, limited by width AND height so a big
      // box gets big type instead of leaving the gray space half empty.
      const byW = fitFont(raw, innerW, 38, 11);
      const byH = Math.floor(availH / 1.18);
      const size = Math.max(11, Math.min(byW, byH, 38));
      const base = valTop + Math.max(0, (availH - size * 1.18) / 2) + size;
      body = `<text x="${el.x+pad}" y="${base.toFixed(1)}" font-family="'DejaVu Sans'" font-size="${size}" font-weight="700" fill="${def.accent}" ${pop}>${esc(raw)}</text>`;
    }
    inner = `<g>
      <rect x="${el.x}" y="${el.y}" width="${el.w}" height="${el.h}" rx="10" fill="#000000" fill-opacity="0.55"/>
      <text x="${el.x+pad}" y="${labBase}" font-family="'DejaVu Sans'" font-size="${labSize}" font-weight="700" fill="#e2e8f0" letter-spacing="1">${esc(def.label)}</text>
      ${body}
    </g>`;
  } else if (el.type === 'avatar') {
    // circular avatar (or monogram fallback)
    const r = Math.min(el.w, el.h) / 2;
    const name = (member && (member.displayName || member.username)) || 'Player';
    if (av) {
      const clipId = `av_${el.id}`;
      inner = `<clipPath id="${clipId}"><circle cx="${cx}" cy="${cy}" r="${r}"/></clipPath>
        <image href="${av}" x="${el.x}" y="${el.y}" width="${el.w}" height="${el.h}" clip-path="url(#${clipId})" preserveAspectRatio="xMidYMid slice"/>
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#ffffff" stroke-opacity="0.85" stroke-width="3"/>`;
    } else {
      inner = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#334155"/>
        <text x="${cx}" y="${cy + r*0.32}" text-anchor="middle" font-family="'DejaVu Sans'" font-size="${r*0.9}" font-weight="700" fill="#e2e8f0">${esc((name[0]||'?').toUpperCase())}</text>
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#ffffff" stroke-opacity="0.5" stroke-width="3"/>`;
    }
  } else if (el.type === 'name') {
    const d = el.data || {};
    const size = d.size || 40;
    const color = d.color || '#ffffff';
    const name = truncate((member && (member.displayName || member.username)) || 'Player', 20);
    inner = `<text x="${el.x}" y="${el.y + size}" font-family="'DejaVu Sans'" font-size="${size}" font-weight="700" fill="${color}">${esc(name)}</text>`;
  } else if (el.type === 'clan') {
    const size = (el.data?.size) || 18;
    const clanTxt = stats.clan ? `⚔ ${truncate(stats.clan.name, 22)} · ${stats.clan.rank}` : 'No clan';
    inner = `<text x="${el.x}" y="${el.y + size}" font-family="'DejaVu Sans'" font-size="${size}" fill="${el.data?.color || '#a5b4fc'}">${esc(clanTxt)}</text>`;
  } else if (el.type === 'sticker' || el.type === 'image') {
    const uri = images[el.data?.imageKey];
    if (uri) {
      if (el.data?.circle) {
        const clipId = `clip_${el.id}`;
        inner = `<clipPath id="${clipId}"><circle cx="${cx}" cy="${cy}" r="${Math.min(el.w,el.h)/2}"/></clipPath>
          <image href="${uri}" x="${el.x}" y="${el.y}" width="${el.w}" height="${el.h}" clip-path="url(#${clipId})" preserveAspectRatio="xMidYMid slice"/>`;
      } else {
        inner = `<image href="${uri}" x="${el.x}" y="${el.y}" width="${el.w}" height="${el.h}" preserveAspectRatio="xMidYMid meet"/>`;
      }
    } else {
      inner = `<rect x="${el.x}" y="${el.y}" width="${el.w}" height="${el.h}" rx="8" fill="#334155" fill-opacity="0.5"/>
        <text x="${cx}" y="${cy}" text-anchor="middle" font-family="'DejaVu Sans'" font-size="14" fill="#94a3b8">image?</text>`;
    }
  }
  const sel = (selectedId && el.id === selectedId)
    ? `<rect x="${el.x-3}" y="${el.y-3}" width="${el.w+6}" height="${el.h+6}" rx="6" fill="none" stroke="#38bdf8" stroke-width="2.5" stroke-dasharray="7 5"/>`
    : '';
  return `<g${rot}>${inner}${sel}</g>`;
}

// ── render a fully custom layout ─────────────────────────────────────────────
function customCardSvg(ctx, gid, member, stats, equip, layout, opts = {}) {
  const phase = opts.phase || 0;
  const bg    = catalogueItem('background', equip.background) || BACKGROUNDS[0];
  const frame = catalogueItem('frame', equip.frame) || FRAMES[0];
  const effect= catalogueItem('effect', equip.effect) || EFFECTS[0];
  const bgL = bgSvg(bg, frame);
  const frL = frameSvg(frame, phase);
  const images = opts.images || {};
  const selectedId = opts.selectedId || null;

  let starLayer = '', auroraLayer = '';
  if (bg.kind === 'starfield') for (let i=0;i<60;i++){const x=(i*137.5)%CARD_W,y=(i*89.3)%CARD_H,tw=0.3+0.7*Math.abs(Math.sin(phase*Math.PI*2+i*0.7));starLayer+=`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${i%3===0?1.6:1}" fill="#fff" fill-opacity="${tw.toFixed(2)}"/>`;}
  if (bg.kind === 'aurora') { const cols=bg.colors; for(let b=0;b<3;b++){const yBase=120+b*80,off=Math.sin(phase*Math.PI*2+b)*40;auroraLayer+=`<path d="M0 ${yBase+off} Q ${CARD_W*0.25} ${yBase-60+off}, ${CARD_W*0.5} ${yBase+off} T ${CARD_W} ${yBase+off} V ${CARD_H} H 0 Z" fill="${cols[b%cols.length]}" fill-opacity="0.16"/>`;} }

  const els = (layout.elements || []).slice().sort((a,b)=>(a.z||0)-(b.z||0));
  const elementLayer = els.map(el => elementSvg(el, { stats, images, selectedId, member, avatarDataUri: opts.avatarDataUri })).join('\n');

  let autoStats = '';
  const hasStatEls = els.some(e => e.type === 'stat');
  if (!hasStatEls && layout.stats && layout.stats.length) {
    const chosen = layout.stats.filter(k => STAT_DEFS[k]).slice(0, 8);
    const gw = 198, gap = 14, gx = 30, gy = CARD_H - 160;
    chosen.forEach((k, idx) => {
      const def = STAT_DEFS[k];
      const col = idx % 4, row = Math.floor(idx / 4);
      const x = gx + (gw+gap)*col, y = gy + row*84;
      autoStats += `<g>
        <rect x="${x}" y="${y}" width="${gw}" height="70" rx="10" fill="#000000" fill-opacity="0.55"/>
        <text x="${x+14}" y="${y+26}" font-family="'DejaVu Sans'" font-size="13" fill="#cbd5e1" letter-spacing="1">${esc(def.label)}</text>
        <text x="${x+14}" y="${y+54}" font-family="'DejaVu Sans'" font-size="24" font-weight="700" fill="${def.accent}">${esc(def.get(stats))}</text>
      </g>`;
    });
  }

  const hearts = opts.hearts || 0;
  const heartBadge = heartBadgeSvg(hearts);

  let effectOverlay = '', effectDefs = '';
  if (effect.kind === 'holo') { effectDefs += `<linearGradient id="holo" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#fff" stop-opacity="0"/><stop offset="45%" stop-color="#a5f3fc" stop-opacity="0.12"/><stop offset="55%" stop-color="#f0abfc" stop-opacity="0.12"/><stop offset="100%" stop-color="#fff" stop-opacity="0"/></linearGradient>`; effectOverlay = `<rect width="${CARD_W}" height="${CARD_H}" rx="18" fill="url(#holo)"/>`; }
  else if (effect.kind === 'sparkle' || effect.kind === 'confetti') { let parts=''; const N=effect.kind==='confetti'?26:18; const colors=['#fbbf24','#f472b6','#34d399','#38bdf8','#c4b5fd']; for(let i=0;i<N;i++){const seed=(i*97.13)%1;const x=((seed*CARD_W)+phase*(40+i*3))%CARD_W;const y=((i*53.7)%CARD_H+phase*60*(effect.kind==='confetti'?1:0))%CARD_H;const size=3+(i%3);if(effect.kind==='confetti'){parts+=`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${size+2}" height="${size+2}" fill="${colors[i%colors.length]}" fill-opacity="0.85" transform="rotate(${(i*40+phase*120)%360} ${x.toFixed(1)} ${y.toFixed(1)})"/>`;}else{const tw=0.5+0.5*Math.abs(Math.sin(phase*Math.PI*2+i));parts+=`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${size*0.6}" fill="#fff" fill-opacity="${tw.toFixed(2)}"/>`;}} effectOverlay = parts; }

  // banner: a user-uploaded image that replaces the whole background
  const bannerUri = layout.bannerKey ? images[layout.bannerKey] : null;
  const bannerLayer = bannerUri
    ? `<image href="${bannerUri}" x="0" y="0" width="${CARD_W}" height="${CARD_H}" preserveAspectRatio="xMidYMid slice"/>`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}" viewBox="0 0 ${CARD_W} ${CARD_H}">
    <defs>${bgL.defs}${frL.defs}${effectDefs}<clipPath id="card"><rect width="${CARD_W}" height="${CARD_H}" rx="18"/></clipPath></defs>
    <g clip-path="url(#card)">
      ${bannerLayer || bgL.rect}
      ${bannerUri ? '' : `${starLayer}${auroraLayer}`}
      <rect width="${CARD_W}" height="${CARD_H}" fill="#000000" fill-opacity="${bannerUri ? '0.22' : '0.12'}"/>
      ${autoStats}
      ${elementLayer}
      ${heartBadge}
      ${effectOverlay}
    </g>
    ${frL.el}
  </svg>`;
}

// ── render helpers ──────────────────────────────────────────────────────────
// `width` lets callers render a cheaper image. Editor previews re-render on every
// nudge/resize/select, so shipping those at full size was a large share of the
// bot's outbound bandwidth — they now render small, while the real card that
// people actually see stays full quality.
function svgToPng(svg, width) {
  const r = new Resvg(svg, {
    font: { fontFiles: ALL_FONT_FILES, loadSystemFonts: false, defaultFontFamily: 'DejaVu Sans' },
    fitTo: { mode: 'width', value: Math.max(120, Math.round(width || CARD_W)) },
  });
  return r.render().asPng();
}
const PREVIEW_W = 520;   // editor preview width (vs 900 for a real card)

// ── GIF optimiser ─────────────────────────────────────────────────────────
// gifsicle rewrites a finished GIF to store only the changed region of each
// frame, typically cutting a card by 50-70% with pixel-identical output. It
// runs as a separate process, so unlike the frame rendering it does NOT block
// Node's event loop. If the binary is missing or fails for any reason we simply
// return the original GIF — cards must never break over an optimisation.
let GIFSICLE = null;
try { GIFSICLE = require('gifsicle'); } catch { GIFSICLE = null; }
if (GIFSICLE && typeof GIFSICLE === 'object') GIFSICLE = GIFSICLE.default || null;
if (GIFSICLE) { try { fs.accessSync(GIFSICLE, fs.constants.X_OK); } catch {
  try { fs.chmodSync(GIFSICLE, 0o755); } catch { GIFSICLE = null; } } }
if (!GIFSICLE) console.warn('[profile] gifsicle not available — animated cards will be sent unoptimised.');

function optimiseGif(buf) {
  return new Promise((resolve) => {
    if (!GIFSICLE || !buf || !buf.length) return resolve(buf);
    let done = false;
    const finish = (out) => { if (!done) { done = true; resolve(out); } };
    try {
      const { execFile } = require('child_process');
      const child = execFile(GIFSICLE, ['-O3', '--no-warnings'],
        { encoding: 'buffer', maxBuffer: 96 * 1024 * 1024, timeout: 20000 },
        (err, stdout) => {
          if (err || !stdout || !stdout.length) return finish(buf);
          finish(stdout.length < buf.length ? stdout : buf);   // never send a bigger file
        });
      child.on('error', () => finish(buf));
      child.stdin.on('error', () => finish(buf));
      child.stdin.end(buf);
    } catch { finish(buf); }
  });
}

// Cache of finished renders, keyed by everything that can change the picture.
const _renderCache = new Map();
function _renderSig(uid, layout, equip, hearts, images, av, opts, outW) {
  // image bodies are huge — fingerprint by key + length instead of content
  const imgSig = Object.keys(images || {}).sort()
    .map(k => `${k}:${(images[k] || '').length}`).join(',');
  return JSON.stringify({
    uid, outW, hearts,
    l: layout, e: equip, i: imgSig,
    a: av ? av.length : 0,
    s: opts.selectedId || null, f: !!opts.forceStatic, p: !!opts.preview,
  });
}

// fetch a Discord avatar and return a data URI (so resvg can embed it offline)
// Avatar fetches hit Discord's CDN over the network — cache the resulting data URI by
// avatar URL for a few minutes so repeated card renders don't pay that round-trip each time.
const _avatarCache = new Map();   // url -> { uri, expires }
const _AVATAR_TTL_MS = 10 * 60 * 1000;
async function avatarDataUri(member) {
  try {
    const user = member.user || member;
    const url = user.displayAvatarURL
      ? user.displayAvatarURL({ extension: 'png', size: 128, forceStatic: true })
      : (typeof member.avatarURL === 'function' ? member.avatarURL() : null);
    if (!url) return null;
    const hit = _avatarCache.get(url);
    if (hit && hit.expires > Date.now()) return hit.uri;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const uri = `data:image/png;base64,${buf.toString('base64')}`;
    if (_avatarCache.size > 200) _avatarCache.clear();
    _avatarCache.set(url, { uri, expires: Date.now() + _AVATAR_TTL_MS });
    return uri;
  } catch { return null; }
}

const isAnimatedEquip = (equip) =>
  ['background','frame','namecolor','effect'].some(slot => {
    const it = catalogueItem(slot, equip[slot]); return it && it.anim;
  });

const isGifUri = (uri) => typeof uri === 'string' && uri.startsWith('data:image/gif');

// Decode a GIF data URI into an array of per-frame PNG data URIs (so each frame can be
// embedded in the SVG and rendered by resvg). Cached on the images object by key to
// avoid re-decoding every render. Returns [] if not a GIF or on failure.
function decodeGifFrames(dataUri) {
  if (!isGifUri(dataUri)) return null;
  try {
    const { GifReader } = require('omggif');
    const { PNG } = require('pngjs');
    const b64 = dataUri.split(',')[1];
    const buf = Buffer.from(b64, 'base64');
    const reader = new GifReader(buf);
    const w = reader.width, h = reader.height;
    const n = reader.numFrames();
    if (n <= 1) return null;  // single-frame gif → treat as static
    const frames = [];
    // omggif frames are usually PARTIAL — a GIF stores only the pixels that changed
    // since the previous frame, blitted onto a persistent canvas. So every frame must
    // be decoded in order or the canvas is left half-composed (which showed up as
    // overlapping, smeared, "fuzzy" animation). We decode all of them and only choose
    // which ones to KEEP, rather than skipping the decode itself.
    //
    // decodeAndBlitFrameRGBA on its own only PAINTS a frame's own pixels onto the
    // canvas — it never clears or restores anything. Per the GIF spec, each frame
    // also carries a "disposal method" that says what to do with that frame's
    // region *after* it's been shown, before the next one is drawn:
    //   0/1 = leave it as-is (fine — this is what we were already doing)
    //   2   = restore that region to background/transparent (sparkle/particle-style
    //         GIFs — like the sparkles/hearts in this card — rely on this to "erase"
    //         themselves each frame)
    //   3   = restore that region to whatever was underneath it before this frame
    // Skipping disposal is exactly what causes the ghosting/overlap: pixels from a
    // frame that was supposed to clear itself just stay on the canvas forever, so
    // every subsequent frame gets drawn on top of an ever-growing smear of old ones.
    const canvas = new Uint8Array(w * h * 4);
    const MAX = 34;                                   // cap on frames we keep (matches the card's frame cap)
    const step = n > MAX ? n / MAX : 1;               // fractional: spreads evenly, keeps the end
    let nextKeep = 0;
    let lastDelay = 8;
    const delays = [];

    const clearRegion = (info) => {
      for (let y = 0; y < info.height; y++) {
        const row = (info.y + y) * w;
        for (let x = 0; x < info.width; x++) {
          const idx = (row + info.x + x) * 4;
          canvas[idx] = 0; canvas[idx + 1] = 0; canvas[idx + 2] = 0; canvas[idx + 3] = 0;
        }
      }
    };
    const snapshotRegion = (info) => {
      const snap = new Uint8Array(info.width * info.height * 4);
      let o = 0;
      for (let y = 0; y < info.height; y++) {
        const row = (info.y + y) * w;
        for (let x = 0; x < info.width; x++) {
          const idx = (row + info.x + x) * 4;
          snap[o++] = canvas[idx]; snap[o++] = canvas[idx + 1]; snap[o++] = canvas[idx + 2]; snap[o++] = canvas[idx + 3];
        }
      }
      return snap;
    };
    const restoreRegion = (info, snap) => {
      let o = 0;
      for (let y = 0; y < info.height; y++) {
        const row = (info.y + y) * w;
        for (let x = 0; x < info.width; x++) {
          const idx = (row + info.x + x) * 4;
          canvas[idx] = snap[o++]; canvas[idx + 1] = snap[o++]; canvas[idx + 2] = snap[o++]; canvas[idx + 3] = snap[o++];
        }
      }
    };

    let prevInfo = null;
    let savedUnder = null;   // snapshot of what's under prevInfo, only kept when disposal===3
    for (let i = 0; i < n; i++) {
      const info = reader.frameInfo(i);

      // Disposal happens "after" a frame is shown, i.e. right before the next one is
      // composited — so apply the PREVIOUS frame's disposal now, before blitting this one.
      if (prevInfo) {
        if (prevInfo.disposal === 2) clearRegion(prevInfo);
        else if (prevInfo.disposal === 3 && savedUnder) restoreRegion(prevInfo, savedUnder);
      }
      // If this frame itself wants "restore to previous" afterwards, snapshot what's
      // sitting underneath it right now, before we overwrite it.
      savedUnder = (info.disposal === 3) ? snapshotRegion(info) : null;

      reader.decodeAndBlitFrameRGBA(i, canvas);       // ALWAYS decode, never skip
      prevInfo = info;

      // Keep this frame if it's on the sampling schedule, or if it's the very last one —
      // otherwise the animation visibly stops short of its true end.
      if (i + 1e-9 >= nextKeep || i === n - 1) {
        const png = new PNG({ width: w, height: h });
        png.data = Buffer.from(canvas);
        frames.push('data:image/png;base64,' + PNG.sync.write(png).toString('base64'));
        lastDelay = info.delay || lastDelay;
        // when we drop frames, the kept ones must hold longer so timing is preserved
        delays.push(Math.max(2, Math.round(lastDelay * step)));
        nextKeep += step;
      }
    }
    return frames.length > 1 ? { frames, delays } : null;
  } catch (e) {
    console.error('[profile] gif decode failed:', e.message);
    return null;
  }
}

// Cache decoded GIF frames so the same uploaded GIF isn't re-decoded (~hundreds of ms)
// on every render. Keyed by a cheap hash of the data URI; capped to avoid unbounded growth.
const _gifFrameCache = new Map();   // hash -> [pngDataUri,...]
const _GIF_CACHE_MAX = 40;
function _hashUri(s) {
  let h = 5381;
  const step = Math.max(1, Math.floor(s.length / 4096));   // sample for speed
  for (let i = 0; i < s.length; i += step) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `${s.length}_${h}`;
}
function decodeGifFramesCached(dataUri) {
  if (!isGifUri(dataUri)) return null;
  const key = _hashUri(dataUri);
  if (_gifFrameCache.has(key)) return _gifFrameCache.get(key);
  const frames = decodeGifFrames(dataUri);
  if (frames) {
    if (_gifFrameCache.size >= _GIF_CACHE_MAX) _gifFrameCache.delete(_gifFrameCache.keys().next().value);
    _gifFrameCache.set(key, frames);
  }
  return frames;
}

// Build a frame cache for every GIF image referenced by the layout (banner + elements).
// Returns { key: [pngDataUri,...] } for GIFs, and the max frame count across them.
function buildGifCache(layout, images) {
  const cache = {};
  let maxFrames = 1;
  const keys = new Set();
  if (layout.bannerKey) keys.add(layout.bannerKey);
  for (const el of (layout.elements || [])) if (el.data?.imageKey) keys.add(el.data.imageKey);
  let srcDelay = 0;
  for (const key of keys) {
    const uri = images[key];
    if (isGifUri(uri)) {
      const got = decodeGifFramesCached(uri);
      const frames = got && (got.frames || got);        // tolerate the older array shape
      if (frames && frames.length > 1) {
        cache[key] = frames;
        maxFrames = Math.max(maxFrames, frames.length);
        // keep the source GIF's own pace so it doesn't play too fast or too slow
        if (got && got.delays && got.delays.length) {
          const avg = got.delays.reduce((a, b) => a + b, 0) / got.delays.length;
          srcDelay = Math.max(srcDelay, avg);
        }
      }
    }
  }
  return { cache, maxFrames, srcDelay };
}

// Render the card as a PNG buffer, or an animated GIF if any equipped cosmetic OR any
// uploaded GIF sticker/banner is animated. Static layout+cosmetics → PNG.
// opts.selectedId highlights an element (editor preview). opts.forceStatic forces PNG.
async function renderCard(ctx, gid, member, opts = {}) {
  const { db } = ctx;
  const uid = (member.user || member).id;
  const stats = gatherStats(ctx, gid, uid, member);
  const equip = getEquipped(db, gid, uid);
  const hearts = heartsFor(db, gid, uid);
  const layout = getLayout(db, gid, uid);
  const images = userImages(db, gid, uid);
  // Right after a restart an image body may still be the '__EXTERNAL__' placeholder
  // because the background load hasn't reached it yet. Pull just the ones this card
  // needs so a profile viewed seconds after a redeploy still renders properly.
  if (ctx.ensureImages) {
    const pending = [];
    const wantKey = (k) => { if (k && images[k] === '__EXTERNAL__') pending.push(`img:${uid}:${k}`); };
    for (const el of (layout.elements || [])) wantKey(el.data?.imageKey);
    wantKey(layout.bannerKey);
    if (pending.length) {
      try { await ctx.ensureImages(gid, [...new Set(pending)]); } catch { /* render without it */ }
    }
  }
  const av = await avatarDataUri(member);

  // decode any GIF stickers/banner into frames (skipped for static editor previews)
  const wantAnim = !opts.forceStatic && !opts.selectedId;
  const { cache: gifCache, maxFrames: gifFrames, srcDelay } = wantAnim ? buildGifCache(layout, images) : { cache: {}, maxFrames: 1, srcDelay: 0 };
  const hasGif = Object.keys(gifCache).length > 0;

  // For a given animation frame f, produce the images map where each GIF key resolves to
  // that frame's still PNG (cycling through the GIF's own frames).
  const imagesForFrame = (f) => {
    if (!hasGif) return images;
    const out = { ...images };
    for (const key of Object.keys(gifCache)) {
      const frames = gifCache[key];
      out[key] = frames[f % frames.length];
    }
    return out;
  };

  const drawSvg = (phase, f) => {
    const base = { avatarDataUri: av, hearts, images: imagesForFrame(f), selectedId: opts.selectedId || null };
    return (layout.custom)
      ? customCardSvg(ctx, gid, member, stats, equip, layout, { ...base, phase })
      : cardSvg(ctx, gid, member, stats, equip, { ...base, phase });
  };

  const animate = wantAnim && (isAnimatedEquip(equip) || hasGif);
  // Editor previews are re-rendered constantly, so they go out small.
  const outW = opts.preview ? PREVIEW_W : CARD_W;

  // ── render cache ─────────────────────────────────────────────────────────
  // Identical inputs produce an identical image. Re-rendering a card that has
  // not changed wastes CPU (which blocks the event loop and makes Discord
  // interactions time out with "Unknown interaction") and re-uploads bytes we
  // already sent. Cache on a signature of everything that affects the output.
  const sig = _renderSig(uid, layout, equip, hearts, images, av, opts, outW);
  const hit = _renderCache.get(sig);
  if (hit && hit.exp > Date.now()) return { ...hit.res, cached: true };

  const finish = (res) => {
    if (_renderCache.size > 60) _renderCache.delete(_renderCache.keys().next().value);
    _renderCache.set(sig, { res, exp: Date.now() + 5 * 60 * 1000 });
    return res;
  };

  if (!animate) {
    const png = svgToPng(drawSvg(0, 0), outW);
    return finish({ attachment: png, name: `profile-${uid}.png`, animated: false });
  }
  const { GIFEncoder, quantize, applyPalette } = require('gifenc');
  const enc = GIFEncoder();
  // Fewer frames = dramatically smaller GIFs. 14 still reads as smooth motion
  // but roughly halves the bytes of the old 20-30 frame cards.
  // gifsicle roughly halves the finished file, which buys back the smoothness we
  // previously had to trade away for bandwidth.
  // Enough frames that an uploaded GIF plays through to its end and looks smooth,
  // capped so a single card can't tie up the CPU for too long. Measured: worst-case
  // block on OTHER users' interactions stays ~450-500ms up to 34 frames (well under
  // Discord's 3s deadline) thanks to yielding every 3 frames below. Total render time
  // (~3s at 34) is fine since every render happens after deferReply, which gives 15
  // minutes — the per-tick block, not total time, is what protects other users.
  const FRAMES_N = Math.min(34, Math.max(16, gifFrames));
  // Match the uploaded GIF's own timing where we know it (omggif delays are in
  // hundredths of a second); otherwise fall back to a smooth default.
  const DELAY = srcDelay ? Math.min(200, Math.max(40, Math.round(srcDelay * 10))) : 80;

  // Render every frame's RGBA first, then build ONE shared palette from a sample of all
  // frames and apply it to each. Re-quantizing per frame (the old approach) gives each
  // frame a slightly different palette + dithering, which causes the shimmer/pixel-crawl
  // and colour distortion between frames. A single global palette keeps colours stable.
  const rgbaFrames = [];
  let W = 0, H = 0;
  for (let f = 0; f < FRAMES_N; f++) {
    const png = svgToPng(drawSvg(f / FRAMES_N, f), outW);
    const { data, width, height } = pngToRGBA(png);
    W = width; H = height;
    rgbaFrames.push(data);
    // Each frame is synchronous CPU work. Without yielding, a 20-frame card blocks
    // the event loop for seconds and other people's button presses expire with
    // "Unknown interaction". Handing control back between frames keeps the bot
    // responsive throughout the render.
    if (f % 3 === 2) await new Promise(r => setImmediate(r));
  }
  // Build a representative sample by combining pixels across frames (subsampled for speed),
  // so the shared palette covers colours that appear in any frame.
  // quantize() is a single synchronous library call with no yield points we can add
  // inside it — measured at 3.8s on a 10.5MB sample (roughly 7 full-resolution frames).
  // That one call was the actual multi-second block, not the frame-render loop. Frame
  // count alone doesn't fix this — a bigger card or a busier sticker hits the same wall
  // at a lower frame count. So the sample is capped by BYTES, not just frame count:
  // pick ~6 frames as before for colour coverage over time, then also subsample pixels
  // within each of those frames so the total never exceeds SAMPLE_BUDGET regardless of
  // canvas size. Palette quality is unaffected in practice — 256 colours don't need
  // every pixel to be represented, just a good spread of them.
  const SAMPLE_BUDGET = 1_500_000; // bytes — keeps quantize() well under ~500ms
  const sampleStride = Math.max(1, Math.floor(rgbaFrames.length / 6));  // ~6 frames sampled
  let sample;
  if (rgbaFrames.length === 1) {
    sample = rgbaFrames[0].length > SAMPLE_BUDGET ? _pixelSubsample(rgbaFrames[0], SAMPLE_BUDGET) : rgbaFrames[0];
  } else {
    const chunks = [];
    for (let i = 0; i < rgbaFrames.length; i += sampleStride) chunks.push(rgbaFrames[i]);
    const estTotal = chunks.reduce((s, c) => s + c.length, 0);
    const pixelStride = estTotal > SAMPLE_BUDGET ? Math.ceil(estTotal / SAMPLE_BUDGET) : 1;
    const parts = pixelStride > 1 ? chunks.map(c => _pixelSubsample(c, Infinity, pixelStride)) : chunks;
    const totalLen = parts.reduce((s, c) => s + c.length, 0);
    sample = new Uint8Array(totalLen);
    let off = 0;
    for (const c of parts) { sample.set(c, off); off += c.length; }
  }
  const palette = quantize(sample, 256);
  // This loop does real per-pixel work (palette matching + LZW encoding) for every
  // frame and previously had NO yield point at all — for a large uploaded sticker at
  // higher frame counts this alone produced a multi-second uninterrupted block (measured:
  // 5.2s on a 34-frame card with a big composited GIF), which is exactly the kind of
  // stall that makes other people's unrelated button presses fail. Yielding here closes
  // that gap the same way the decode loop above already does.
  for (let f = 0; f < FRAMES_N; f++) {
    const index = applyPalette(rgbaFrames[f], palette);
    enc.writeFrame(index, W, H, { palette, delay: DELAY, first: f === 0 });
    if (f % 3 === 2) await new Promise(r => setImmediate(r));
  }
  enc.finish();
  const raw = Buffer.from(enc.bytes());
  const out = await optimiseGif(raw);
  return finish({ attachment: out, name: `profile-${uid}.gif`, animated: true });
}

// decode a PNG buffer to raw RGBA for gifenc
// Takes every Nth RGBA pixel from a frame buffer. Used to keep the sample fed to
// quantize() small regardless of card size — a random or even spread of pixels
// represents the colour palette just as well as every pixel does, for the purpose
// of picking 256 representative colours.
function _pixelSubsample(rgba, targetBytes, forcedStride) {
  const pixelCount = rgba.length / 4;
  const stride = forcedStride || Math.max(1, Math.ceil(rgba.length / Math.max(4, targetBytes)));
  if (stride <= 1) return rgba;
  const outCount = Math.ceil(pixelCount / stride);
  const out = new Uint8Array(outCount * 4);
  let o = 0;
  for (let p = 0; p < pixelCount; p += stride) {
    const i = p * 4;
    out[o] = rgba[i]; out[o + 1] = rgba[i + 1]; out[o + 2] = rgba[i + 2]; out[o + 3] = rgba[i + 3];
    o += 4;
  }
  return out;
}

function pngToRGBA(pngBuf) {
  // resvg output is PNG; use pngjs-free path via Resvg? Simpler: use 'upng-js' style not available.
  // Use the built-in: sharp isn't guaranteed. Decode via pngjs.
  const { PNG } = require('pngjs');
  const png = PNG.sync.read(pngBuf);
  return { data: new Uint8Array(png.data), width: png.width, height: png.height };
}

// ───────────────────────────────────────────────────────────────────────────
// EXPORTS — a factory the hub consumes
// ───────────────────────────────────────────────────────────────────────────
function initProfiles({ db, saveData, gachaApi, getDinar, spendDinar, ensureImages }) {
  const ctx = { db, saveData, gachaApi, getDinar, spendDinar, ensureImages };

  return {
    CATALOGUE, SLOT_LABEL, catalogueItem,
    isOwned:   (gid, uid, slot, key) => isOwned(db, gid, uid, slot, key),
    addOwned:  (gid, uid, slot, key) => addOwned(db, gid, uid, slot, key, saveData),
    getEquipped: (gid, uid) => getEquipped(db, gid, uid),
    equipItem: (gid, uid, slot, key) => equipItem(db, gid, uid, slot, key, saveData),
    ownedSlots: (gid, uid) => ownedSlots(db, gid, uid),

    heartsFor:  (gid, uid) => heartsFor(db, gid, uid),
    hasHearted: (gid, uid, voter) => hasHearted(db, gid, uid, voter),
    toggleHeart:(gid, uid, voter) => toggleHeart(db, gid, uid, voter, saveData),

    isPublished: (gid, uid) => !!pState(db, gid).published[uid],
    setPublished:(gid, uid, on) => { pState(db, gid).published[uid] = !!on; saveData(gid); },
    publishedList:(gid) => Object.keys(pState(db, gid).published).filter(u => pState(db, gid).published[u]),

    gatherStats: (gid, uid, member) => gatherStats(ctx, gid, uid, member),
    renderCard:  (gid, member, opts) => renderCard(ctx, gid, member, opts),

    // ── layout / editor API ──
    FONTS, STAT_DEFS, STAT_KEYS,
    getLayout:      (gid, uid) => getLayout(db, gid, uid),
    addElement:     (gid, uid, type, data) => addElement(db, gid, uid, type, data, saveData),
    getElement:     (gid, uid, elId) => getElement(db, gid, uid, elId),
    updateElement:  (gid, uid, elId, patch) => updateElement(db, gid, uid, elId, patch, saveData),
    removeElement:  (gid, uid, elId) => removeElement(db, gid, uid, elId, saveData),
    reorderElement: (gid, uid, elId, dir) => reorderElement(db, gid, uid, elId, dir, saveData),
    toggleStat:     (gid, uid, statKey) => toggleStat(db, gid, uid, statKey, saveData),
    resetLayout:    (gid, uid) => resetLayout(db, gid, uid, saveData),
    addUserImage:   (gid, uid, dataUri) => addUserImage(db, gid, uid, dataUri, saveData),
    userImages:     (gid, uid) => userImages(db, gid, uid),
    imageCount:     (gid, uid) => imageCount(db, gid, uid),
    removeUserImage:(gid, uid, imageKey) => removeUserImage(db, gid, uid, imageKey, saveData),
    setBanner:      (gid, uid, imageKey) => setBanner(db, gid, uid, imageKey, saveData),
    getBanner:      (gid, uid) => getLayout(db, gid, uid).bannerKey || null,
    MAX_IMAGES,

    // buy: validates ownership + funds, spends Dinar, grants. returns {ok}|{error}
    buy(gid, uid, slot, key) {
      const item = catalogueItem(slot, key);
      if (!item) return { error: 'Unknown item.' };
      if (item.free || isOwned(db, gid, uid, slot, key)) return { error: 'You already own that.' };
      const bal = getDinar ? getDinar(db, gid, uid) : gachaApi.balance(gid, uid);
      if (bal < item.price) return { error: `You need **${fmt(item.price)} Dinar** — you have **${fmt(bal)}**.` };
      if (spendDinar) spendDinar(db, gid, uid, item.price, saveData);
      addOwned(db, gid, uid, slot, key, saveData);
      return { ok: true, item };
    },
  };
}

module.exports = { initProfiles, CATALOGUE, SLOT_LABEL, BACKGROUNDS, FRAMES, NAMECOLORS, TITLES, EFFECTS };
