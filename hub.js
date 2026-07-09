// ─────────────────────────────────────────────────────────────────────────────
// shop.js — /shop : buy a custom-named coloured role with Dinar.
//   • Custom Solid Role  (800 Dinar)  — pick a name + a colour from the palette
//   • Gradient Role      (1,500 Dinar) — pick a name + a preset gradient combo
//   Both roles last 30 days, then are removed & deleted automatically. Re-buying
//   swaps the old role and resets the 30 days (a recurring Dinar sink).
// Wire-up in index.js:
//   const { getShopCommands, initShop } = require('./shop');
//   commands.push(...getShopCommands());
//   initShop({ client, db, saveData });
// Needs the bot to have Manage Roles, and the bot's role ABOVE the shop roles.
// Gradient roles use Discord "Enhanced Role Styles" (boost perk); falls back to a
// solid colour automatically if that ever isn't available.
// ─────────────────────────────────────────────────────────────────────────────
const {
  SlashCommandBuilder, EmbedBuilder, AttachmentBuilder, ActionRowBuilder,
  StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, ModalBuilder,
  TextInputBuilder, TextInputStyle, UserSelectMenuBuilder,
} = require('discord.js');
const path = require('path');
const fs = require('fs');
const { Resvg } = require('@resvg/resvg-js');
const { getDinar, spendDinar, awardDinar } = require('./gacha');
const coins = require('./coinskins');
const clans = require('./clanfns');

// ── prices & lifetime ──
const PRICE_SOLID    = 800;
const PRICE_GRADIENT = 1500;
const ICON_PRICE     = 3000;   // custom image role icon (free for boosters)
const ROLE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;   // 1 month
const NAME_MAX = 20;
const CHECK_EVERY_MS = 10 * 60 * 1000;               // expiry sweep cadence

// ── daily streak ──
const STREAK_BASE      = 20;                          // Dinar for a check-in
const STREAK_PER_DAY   = 5;                           // + this per streak day
const STREAK_CAP       = 100;                         // reward never exceeds this (no spiral)
const LIBYA_OFFSET_MS  = 2 * 3600 * 1000;             // UTC+2, matches the rest of the bot

// ── solid colour palette, split into two categories (Discord selects cap at 25 each) ──
// Category 1: Bright & Bold
const SOLID_BRIGHT = [
  { key: 'flag_green', name: 'Libyan Green', hex: 0x239e46, emoji: '🟢' },
  { key: 'flag_red',   name: 'Libyan Red',   hex: 0xe70013, emoji: '🔴' },
  { key: 'crimson',    name: 'Crimson',      hex: 0xc0223b, emoji: '❤️' },
  { key: 'scarlet',    name: 'Scarlet',      hex: 0xff3b30, emoji: '🍎' },
  { key: 'ruby',       name: 'Ruby',         hex: 0xe0115f, emoji: '💎' },
  { key: 'orange',     name: 'Orange',       hex: 0xff7a1a, emoji: '🟠' },
  { key: 'tangerine',  name: 'Tangerine',    hex: 0xff9500, emoji: '🍊' },
  { key: 'amber',      name: 'Amber',        hex: 0xffb020, emoji: '🟡' },
  { key: 'gold',       name: 'Gold',         hex: 0xe7b41a, emoji: '🏆' },
  { key: 'lime',       name: 'Lime',         hex: 0x8bd450, emoji: '🍏' },
  { key: 'green',      name: 'Green',        hex: 0x2ecc40, emoji: '🟩' },
  { key: 'emerald',    name: 'Emerald',      hex: 0x1f8a3d, emoji: '🌿' },
  { key: 'teal',       name: 'Teal',         hex: 0x0fb5ae, emoji: '🩵' },
  { key: 'cyan',       name: 'Cyan',         hex: 0x27c4e5, emoji: '💧' },
  { key: 'sky',        name: 'Sky Blue',     hex: 0x3aa0ff, emoji: '🌤️' },
  { key: 'blue',       name: 'Royal Blue',   hex: 0x2e6bff, emoji: '🔵' },
  { key: 'cobalt',     name: 'Cobalt',       hex: 0x1a44dd, emoji: '🟦' },
  { key: 'indigo',     name: 'Indigo',       hex: 0x5b5bd6, emoji: '🌌' },
  { key: 'violet',     name: 'Violet',       hex: 0x8a5cf6, emoji: '🟣' },
  { key: 'purple',     name: 'Purple',       hex: 0xa133c8, emoji: '👑' },
  { key: 'magenta',    name: 'Magenta',      hex: 0xd53fb0, emoji: '🎆' },
  { key: 'hotpink',    name: 'Bright Pink',  hex: 0xff2d9c, emoji: '💗' },
  { key: 'pink',       name: 'Pink',         hex: 0xff77c8, emoji: '🌸' },
  { key: 'rose',       name: 'Rose',         hex: 0xff5d8f, emoji: '🌹' },
  { key: 'coral',      name: 'Coral',        hex: 0xff6f61, emoji: '🪸' },
];
// Category 2: Pastels, Earth & Neutrals
const SOLID_SOFT = [
  { key: 'blush',      name: 'Blush Pink',   hex: 0xffb3c8, emoji: '🌷' },
  { key: 'peach',      name: 'Peach',        hex: 0xffc9a3, emoji: '🍑' },
  { key: 'lavender',   name: 'Lavender',     hex: 0xc3b1f0, emoji: '💜' },
  { key: 'periwinkle', name: 'Periwinkle',   hex: 0xa6b1ff, emoji: '🔮' },
  { key: 'mint',       name: 'Mint',         hex: 0xa8e6cf, emoji: '🌱' },
  { key: 'seafoam',    name: 'Seafoam',      hex: 0x8fd9c7, emoji: '🫧' },
  { key: 'butter',     name: 'Butter',       hex: 0xffe9a8, emoji: '🧈' },
  { key: 'lemon',      name: 'Lemon',        hex: 0xf6e05e, emoji: '🍋' },
  { key: 'skypale',    name: 'Pale Sky',     hex: 0xbfe3ff, emoji: '☁️' },
  { key: 'aqua',       name: 'Aqua',         hex: 0x9fe4e4, emoji: '💠' },
  { key: 'lilac',      name: 'Lilac',        hex: 0xdcc2f0, emoji: '🪻' },
  { key: 'sand',       name: 'Desert Sand',  hex: 0xd8b072, emoji: '🏜️' },
  { key: 'khaki',      name: 'Khaki',        hex: 0xbdb76b, emoji: '🫒' },
  { key: 'terracotta', name: 'Terracotta',   hex: 0xc66b3d, emoji: '🏺' },
  { key: 'bronze',     name: 'Bronze',       hex: 0xb0793a, emoji: '🥉' },
  { key: 'coffee',     name: 'Coffee',       hex: 0x795548, emoji: '☕' },
  { key: 'olive',      name: 'Olive',        hex: 0x808000, emoji: '🥬' },
  { key: 'slate',      name: 'Slate',        hex: 0x8a94a6, emoji: '🩶' },
  { key: 'steel',      name: 'Steel',        hex: 0x5a6b7b, emoji: '⚙️' },
  { key: 'silver',     name: 'Silver',       hex: 0xc4c9d4, emoji: '🔩' },
  { key: 'white',      name: 'Snow White',   hex: 0xf2f3f5, emoji: '⚪' },
  { key: 'charcoal',   name: 'Charcoal',     hex: 0x4b4d52, emoji: '🌑' },
  { key: 'onyx',       name: 'Onyx',         hex: 0x2b2d31, emoji: '⚫' },
];
const SOLID_COLORS = [...SOLID_BRIGHT, ...SOLID_SOFT];

// ── preset gradient combos (primary → secondary), 14 options ──
const GRADIENTS = [
  { key: 'g_flag',    name: 'Libyan Flag',    a: 0x239e46, b: 0xe70013, emoji: '🇱🇾' },
  { key: 'g_sunset',  name: 'Desert Sunset',  a: 0xff9a1a, b: 0xe70013, emoji: '🌅' },
  { key: 'g_royal',   name: 'Royal Gold',     a: 0x8a2be2, b: 0xe7b41a, emoji: '👑' },
  { key: 'g_ocean',   name: 'Ocean Deep',     a: 0x0fb5ae, b: 0x2e6bff, emoji: '🌊' },
  { key: 'g_fire',    name: 'Wildfire',       a: 0xffcc00, b: 0xe70013, emoji: '🔥' },
  { key: 'g_mint',    name: 'Mint Fresh',     a: 0x8bd450, b: 0x0fb5ae, emoji: '🌿' },
  { key: 'g_grape',   name: 'Grape Soda',     a: 0x8a5cf6, b: 0xd53fb0, emoji: '🍇' },
  { key: 'g_candy',   name: 'Cotton Candy',   a: 0xff77c8, b: 0x8a5cf6, emoji: '🍬' },
  { key: 'g_dusk',    name: 'Twilight',       a: 0x2e6bff, b: 0x8a2be2, emoji: '🌆' },
  { key: 'g_ember',   name: 'Ember',          a: 0xff7a1a, b: 0xc0223b, emoji: '🪔' },
  { key: 'g_jade',    name: 'Jade Dynasty',   a: 0x1f8a3d, b: 0xe7b41a, emoji: '🐉' },
  { key: 'g_sahara',  name: 'Sahara Dunes',   a: 0xe7b41a, b: 0xb0793a, emoji: '🏜️' },
  { key: 'g_aurora',  name: 'Aurora',         a: 0x27c4e5, b: 0x8a5cf6, emoji: '🌌' },
  { key: 'g_rose',    name: 'Rose Petal',     a: 0xff5d8f, b: 0xff9a1a, emoji: '🌹' },
  { key: 'g_lagoon',  name: 'Lagoon',         a: 0x0fb5ae, b: 0x8bd450, emoji: '🏝️' },
  { key: 'g_peach',   name: 'Peach Melba',    a: 0xffc9a3, b: 0xff5d8f, emoji: '🍑' },
  { key: 'g_galaxy',  name: 'Galaxy',         a: 0x5b5bd6, b: 0x2b2d31, emoji: '🌠' },
  { key: 'g_lime',    name: 'Citrus Zest',    a: 0x8bd450, b: 0xffb020, emoji: '🍋' },
  { key: 'g_berry',   name: 'Berry Blast',    a: 0xd53fb0, b: 0xc0223b, emoji: '🫐' },
  { key: 'g_steel',   name: 'Steel Blue',     a: 0x5a6b7b, b: 0x2e6bff, emoji: '⚔️' },
  { key: 'g_lava',    name: 'Molten Lava',    a: 0xffcc00, b: 0xc0223b, emoji: '🌋' },
  { key: 'g_frost',   name: 'Frostbite',      a: 0xbfe3ff, b: 0x2e6bff, emoji: '❄️' },
  { key: 'g_pinky',   name: 'Pink Blossom',   a: 0xff77c8, b: 0xff2d9c, emoji: '🌸' },
  { key: 'g_neon',    name: 'Neon Nights',    a: 0xff2d9c, b: 0x27c4e5, emoji: '🎆' },
  { key: 'g_forest',  name: 'Deep Forest',    a: 0x1f8a3d, b: 0x2b2d31, emoji: '🌲' },
];

const solidByKey = (k) => SOLID_COLORS.find(c => c.key === k);
const gradByKey  = (k) => GRADIENTS.find(g => g.key === k);
const hexStr = (n) => '#' + n.toString(16).padStart(6, '0');
const fmt = (n) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');

// ── name safety: length, printable, and a profanity blocklist ──
// default list — common English + a few common Arabic transliterations. Not exhaustive;
// the aim is to stop the obvious stuff appearing in the member list.
const BLOCKLIST = [
  'fuck', 'shit', 'bitch', 'cunt', 'nigger', 'nigga', 'faggot', 'fag', 'retard',
  'rape', 'rapist', 'slut', 'whore', 'dick', 'cock', 'pussy', 'porn', 'nazi',
  'hitler', 'kike', 'spic', 'chink', 'tranny', 'pedo', 'paedo', 'incest',
  'sharmuta', 'sharmoota', 'khara', 'zebi', 'zubi', 'gahba', 'gehba', 'klb',
];
function nameProblem(raw) {
  const name = (raw || '').trim();
  if (name.length < 2) return 'Your role name needs to be at least 2 characters.';
  if (name.length > NAME_MAX) return `Role names can be at most ${NAME_MAX} characters.`;
  if (!/^[\p{L}\p{N} '_\-!.★☆✦✧♦♛♚👑]+$/u.test(name)) return 'Please use only letters, numbers, spaces and simple punctuation in the name.';
  const flat = name.toLowerCase().replace(/[^a-z\u0600-\u06ff]/g, '');
  if (BLOCKLIST.some(w => flat.includes(w))) return 'That name isn\'t allowed — please choose something else.';
  return null;
}

// ── swatch preview renderer (same resvg pipeline as the rest of the bot) ──
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
function renderSwatch(svg) {
  const font = resolveFont();
  return new Resvg(svg, {
    fitTo: { mode: 'width', value: 480 },
    font: font ? { fontFiles: [font], loadSystemFonts: false, defaultFontFamily: 'DejaVu Sans' } : { loadSystemFonts: true },
    background: '#2b2d31',
  }).render().asPng();
}
// a row of solid chips (used to preview the whole palette at a glance)
function paletteSwatch() {
  const cols = 5, size = 82, gap = 10, pad = 16;
  const rows = Math.ceil(SOLID_COLORS.length / cols);
  const w = pad * 2 + cols * size + (cols - 1) * gap;
  const h = pad * 2 + rows * size + (rows - 1) * gap;
  let cells = '';
  SOLID_COLORS.forEach((c, i) => {
    const x = pad + (i % cols) * (size + gap), y = pad + Math.floor(i / cols) * (size + gap);
    cells += `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="12" fill="${hexStr(c.hex)}" stroke="#00000055" stroke-width="1.5"/>` +
             `<text x="${x + size / 2}" y="${y + size - 10}" font-size="11" fill="#ffffff" text-anchor="middle" style="paint-order:stroke;stroke:#000000aa;stroke-width:3px;">${c.name}</text>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" font-family="DejaVu Sans, sans-serif"><rect width="${w}" height="${h}" fill="#2b2d31"/>${cells}</svg>`;
}
// a single big preview of one chosen solid or gradient, with the typed name on it
function choicePreview({ name, solid, grad }) {
  const w = 480, h = 150;
  let bg;
  if (grad) {
    bg = `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${hexStr(grad.a)}"/><stop offset="1" stop-color="${hexStr(grad.b)}"/></linearGradient></defs><rect width="${w}" height="${h}" rx="16" fill="url(#g)"/>`;
  } else {
    bg = `<rect width="${w}" height="${h}" rx="16" fill="${hexStr(solid.hex)}"/>`;
  }
  const label = esc(name || 'Your Name Here');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" font-family="DejaVu Sans, sans-serif">${bg}` +
    `<text x="${w / 2}" y="${h / 2 + 2}" font-size="30" font-weight="bold" fill="#ffffff" text-anchor="middle" dominant-baseline="middle" style="paint-order:stroke;stroke:#00000066;stroke-width:4px;">${label}</text>` +
    `<text x="${w / 2}" y="${h - 16}" font-size="13" fill="#ffffffcc" text-anchor="middle">preview</text></svg>`;
}
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// parse a "#RRGGBB" (or "RRGGBB") hex string → integer, or null if invalid
function parseHex(raw) {
  const m = String(raw || '').trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(m)) return null;
  return parseInt(m, 16);
}

// download an uploaded attachment for use as a role icon, auto-resized via Discord's own
// media proxy (?width=&height=) so we never need an image library. Discord caps role icons
// at 256KB; we request 128px which lands comfortably under it.
async function fetchIconBuffer(att) {
  if (typeof fetch !== 'function') return { error: 'Image fetching isn\'t available on this host right now.' };
  const ct = (att.contentType || '').toLowerCase();
  if (!/^image\/(png|jpe?g|webp)/.test(ct)) return { error: 'Please upload a **PNG or JPG** image (GIFs and other files can\'t be role icons).' };
  const base = att.proxyURL || att.url;
  const sep = base.includes('?') ? '&' : '?';
  const candidates = [`${base}${sep}width=128&height=128`, `${base}${sep}width=64&height=64`];
  if ((att.size || 0) <= 2 * 1024 * 1024) candidates.push(att.url);   // raw fallback only for smallish files
  for (const u of candidates) {
    try {
      const res = await fetch(u);
      if (!res || !res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 0 && buf.length <= 256 * 1024) return { buf };
    } catch { /* try the next candidate */ }
  }
  return { error: 'I couldn\'t get that image under Discord\'s **256KB** role-icon limit. Try a smaller, square image.' };
}

// ─────────────────────────────────────────────────────────────────────────────
// state helpers
// ─────────────────────────────────────────────────────────────────────────────
function shopState(db, guildId) {
  const data = db[guildId] || (db[guildId] = {});
  if (!data.__shop) data.__shop = { roles: {}, streaks: {} };   // roles: {uid:{...}}, streaks: {uid:{count,lastDay,best}}
  if (!data.__shop.streaks) data.__shop.streaks = {};
  return data.__shop;
}

// ── daily-streak helpers (Libya-time calendar day with a one-day grace window) ──
function libyaDayNumber(nowMs) {
  // integer day index in Libya time; consecutive days differ by exactly 1
  return Math.floor((nowMs + LIBYA_OFFSET_MS) / 86400000);
}
function nextLibyaMidnightMs(nowMs) {
  const day = libyaDayNumber(nowMs);
  return (day + 1) * 86400000 - LIBYA_OFFSET_MS;   // start of the next Libya day, in UTC ms
}
function streakReward(count) {
  return Math.min(STREAK_CAP, STREAK_BASE + STREAK_PER_DAY * count);
}
// returns the current status without mutating: 'ready' | 'done_today' | would-reset info
function streakStatus(rec, nowMs) {
  const today = libyaDayNumber(nowMs);
  if (!rec || rec.lastDay === undefined) return { state: 'ready', count: 0, fresh: true };
  if (rec.lastDay === today) return { state: 'done_today', count: rec.count, nextAt: nextLibyaMidnightMs(nowMs) };
  if (rec.lastDay === today - 1) return { state: 'ready', count: rec.count, continues: true };
  // missed a full day (grace exhausted) → next check-in starts a new streak
  return { state: 'ready', count: 0, reset: true, prev: rec.count };
}
// perform a check-in; mutates rec, returns outcome
function doCheckIn(state, db, guildId, saveData, userId, name, awardDinar, nowMs) {
  const today = libyaDayNumber(nowMs);
  const rec = state.streaks[userId] || (state.streaks[userId] = { count: 0, lastDay: undefined, best: 0, name });
  rec.name = name;
  if (rec.lastDay === today) {
    return { already: true, count: rec.count, nextAt: nextLibyaMidnightMs(nowMs) };
  }
  const continues = rec.lastDay === today - 1;
  const wasReset = rec.lastDay !== undefined && !continues;
  rec.count = continues ? rec.count + 1 : 1;
  rec.lastDay = today;
  if (rec.count > (rec.best || 0)) rec.best = rec.count;
  const reward = streakReward(rec.count);
  awardDinar(db, guildId, userId, reward, saveData);
  if (saveData) saveData(guildId);
  return { count: rec.count, reward, continues, wasReset, best: rec.best, nextAt: nextLibyaMidnightMs(nowMs) };
}
function streakLeaderboard(state, nowMs) {
  const today = libyaDayNumber(nowMs);
  return Object.entries(state.streaks || {})
    .map(([uid, r]) => {
      // a streak is "active" if checked in today or yesterday (grace); otherwise it's effectively 0
      const active = r.lastDay === today || r.lastDay === today - 1;
      return { uid, name: r.name || 'Someone', count: active ? r.count : 0, best: r.best || 0 };
    })
    .filter(r => r.best > 0)
    .sort((a, b) => b.count - a.count || b.best - a.best)
    .slice(0, 10);
}

// ─────────────────────────────────────────────────────────────────────────────
// commands
// ─────────────────────────────────────────────────────────────────────────────
function getShopCommands() {
  return [
    new SlashCommandBuilder().setName('hub').setDescription('Open the community hub — custom roles, coin flip, daily streak & more').toJSON(),
  ];
}

function initShop({ client, db, saveData, runFlip }) {
  const stateOf = (gid) => shopState(db, gid);

  // ── create (or recreate) a member's shop role, removing their previous one ──
  // kind: 'solid' | 'gradient' | 'holo' | 'customSolid' | 'customGrad'
  // booster=true marks a free role that lives while the member keeps boosting (no 30-day timer)
  async function grantRole(guild, member, { kind, name, solid, grad, hex, hexA, hexB, booster }) {
    const state = stateOf(guild.id);
    // remove any existing shop role for this user first
    const prev = state.roles[member.id];
    if (prev) {
      const old = guild.roles.cache.get(prev.roleId) || await guild.roles.fetch(prev.roleId).catch(() => null);
      if (old) await old.delete('Shop role replaced').catch(() => {});
      delete state.roles[member.id];
      saveData(guild.id);
    }
    let role = null, usedFallback = false;
    const baseOpts = { name, hoist: false, mentionable: false, permissions: [], reason: `Hub role for ${member.user.tag}` };
    if (kind === 'holo') {
      // Discord holographic requires these EXACT enforced values (primary/secondary/tertiary);
      // any other triple is rejected and falls back to solid. These are Discord's fixed preset.
      try { role = await guild.roles.create({ ...baseOpts, colors: { primaryColor: 11127295, secondaryColor: 16759788, tertiaryColor: 16761760 } }); }
      catch (e) { usedFallback = true; role = await guild.roles.create({ ...baseOpts, colors: { primaryColor: 11127295 } }); }
    } else if (kind === 'gradient' || kind === 'customGrad') {
      const a = kind === 'customGrad' ? hexA : grad.a;
      const b = kind === 'customGrad' ? hexB : grad.b;
      try { role = await guild.roles.create({ ...baseOpts, colors: { primaryColor: a, secondaryColor: b } }); }
      catch (e) { usedFallback = true; role = await guild.roles.create({ ...baseOpts, colors: { primaryColor: a } }); }
    } else if (kind === 'customSolid') {
      role = await guild.roles.create({ ...baseOpts, colors: { primaryColor: hex } });
    } else {
      role = await guild.roles.create({ ...baseOpts, colors: { primaryColor: solid.hex } });
    }
    // position just under the bot's highest role so the colour actually shows and can be assigned
    try {
      const me = guild.members.me;
      const top = me.roles.highest.position;
      await role.setPosition(Math.max(1, top - 1)).catch(() => {});
    } catch { /* best effort */ }
    await member.roles.add(role, 'Hub role').catch(() => { throw new Error('assign-failed'); });
    // booster roles have no timed expiry — the sweep removes them if the member stops boosting
    const expiresAt = booster ? null : Date.now() + ROLE_LIFETIME_MS;
    state.roles[member.id] = { roleId: role.id, expiresAt, kind, label: name, booster: !!booster };
    saveData(guild.id);
    return { role, usedFallback, expiresAt, booster: !!booster };
  }

  // ── expiry sweep: remove + delete roles whose month is up ──
  async function sweep() {
    const now = Date.now();
    for (const [gid] of client.guilds.cache) {
      const state = stateOf(gid);
      const guild = client.guilds.cache.get(gid);
      let changed = false;
      for (const [uid, rec] of Object.entries(state.roles)) {
        let remove = false;
        if (rec.booster) {
          // booster role lives only while the member is still boosting
          const member = guild.members.cache.get(uid) || await guild.members.fetch(uid).catch(() => null);
          if (!member || !member.premiumSince) remove = true;   // stopped boosting (or left)
        } else {
          if (rec.expiresAt && rec.expiresAt > now) continue;   // still within its 30 days
          remove = true;
        }
        if (!remove) continue;
        try {
          const role = guild.roles.cache.get(rec.roleId) || await guild.roles.fetch(rec.roleId).catch(() => null);
          if (role) await role.delete(rec.booster ? 'Booster role removed (no longer boosting)' : 'Shop role expired').catch(() => {});
        } catch { /* ignore */ }
        delete state.roles[uid]; changed = true;
      }
      if (changed) saveData(gid);
    }
  }
  setInterval(() => sweep().catch(() => {}), CHECK_EVERY_MS);

  // ═══════════════ UI BUILDERS ═══════════════
  // main hub menu
  // ⚠️ TESTING ONLY — user IDs here get booster access without actually boosting.
  // Remove your ID from this list when you're done testing.
  const BOOSTER_TEST_IDS = ['253230665586180096'];
  // is this member currently boosting the server? (Discord native — no role ID needed)
  const isBoosting = (interaction) => BOOSTER_TEST_IDS.includes(interaction.user?.id)
    || !!interaction.member?.premiumSince
    || !!(interaction.member && interaction.member.premiumSinceTimestamp);

  // in-memory "last action" per user, shown under the main hub menu (session-scoped)
  const lastAction = new Map();
  const setAction = (uid, text) => lastAction.set(uid, text);

  const hubEmbed = (isBooster, uid, gid) => {
    const la = uid && lastAction.get(uid);
    const bal = (uid && gid) ? getDinar(db, gid, uid) : 0;
    const inClan = (uid && gid) ? clans.userClan(db, gid, uid) : null;
    const e = new EmbedBuilder().setColor(0xE7B41A).setTitle('🏛️ The Community Hub')
      .setDescription(
        `Welcome! Pick an option below:\n\n` +
        `🛒 **Shop** — custom roles & coin designs, bought with Dinar\n` +
        `🪙 **Coin Flip** — bet your Dinar on a flip of the coin\n` +
        `🔥 **Daily Streak** — check in every day for a growing Dinar reward\n` +
        `⭐ **Booster Perks** — ${isBooster ? '**unlocked!** free holographic & custom-hex roles' : '_boost the server to unlock free premium roles_'}\n` +
        `⚔️ **Clan** — ${inClan ? `manage **${esc(inClan.name)}**` : `create or join a clan (from **${fmt(clans.CLAN_CREATE_COST)} Dinar**)`}\n` +
        `❓ **Help** — how everything works\n\n` +
        `*More coming soon…*`);
    if (uid) e.setAuthor({ name: `💰 ${fmt(bal)} Dinar` });
    if (la) e.addFields({ name: '\u200b', value: `📋 *Last action:* ${la}` });
    return e;
  };
  const hubRow = (isBooster) => new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('hub:shop').setLabel('Shop').setEmoji('🛒').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('hub:flip').setLabel('Coin Flip').setEmoji('🪙').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('hub:streak').setLabel('Daily Streak').setEmoji('🔥').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('hub:booster').setLabel(isBooster ? 'Booster Perks' : 'Booster Perks (boost to unlock)').setEmoji('⭐').setStyle(ButtonStyle.Secondary).setDisabled(!isBooster),
    new ButtonBuilder().setCustomId('hub:help').setLabel('Help').setEmoji('❓').setStyle(ButtonStyle.Secondary));
  const hubRow2 = () => new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('hub:clan').setLabel('Clan').setEmoji('⚔️').setStyle(ButtonStyle.Success));
  const hubComponents = (isBooster) => [hubRow(isBooster), hubRow2()];
  const backHubRow = () => new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('hub:home').setLabel('← Back to Hub').setStyle(ButtonStyle.Secondary));
  const backRolesRow = () => new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('hub:roles').setLabel('← Back to Custom Roles').setStyle(ButtonStyle.Secondary));

  // coin-designs shop: an overview embed + a dropdown of all skins, marking owned/equipped
  function coinShopView(gid, uid) {
    const equipped = coins.getEquipped(db, gid, uid);
    const lines = coins.SKINS.map(s => {
      const own = coins.isOwned(db, gid, uid, s.key);
      const eq = equipped === s.key;
      const tag = eq ? '✅ equipped' : own ? '🎟️ owned' : (s.price > 0 ? `💰 ${fmt(s.price)}` : 'free');
      return `${s.emoji} **${s.name}** — *${s.rarity}* · ${tag}`;
    }).join('\n');
    const embed = new EmbedBuilder().setColor(0xE7B41A).setTitle('🪙 Coin Designs')
      .setDescription(`Reskin your coin flip! Your equipped design shows on the **Heads/Tails** result.\n(The spin animation stays the same.)\n\n${lines}\n\n*Pick one below to preview, buy or equip.*`);
    const select = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId('hub:coinPick').setPlaceholder('Preview a coin design…')
        .addOptions(coins.SKINS.map(s => ({ label: `${s.name} (${s.rarity})`, value: s.key, emoji: s.emoji,
          description: coins.isOwned(db, gid, uid, s.key) ? (coins.getEquipped(db, gid, uid) === s.key ? 'Equipped' : 'Owned') : (s.price > 0 ? `${fmt(s.price)} Dinar` : 'Free') }))));
    const ownedCount = coins.getOwned(db, gid, uid).length;
    const nav = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('hub:mycoins').setLabel(`My Coins (${ownedCount})`).setEmoji('🎒').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('hub:home').setLabel('← Back to Hub').setStyle(ButtonStyle.Secondary));
    return { embeds: [embed], components: [select, nav], attachments: [] };
  }
  async function coinShopFiles() { return []; }   // overview has no image; previews attach on pick

  // "My Coins" — only what the user owns, with quick-equip and current equipped highlighted
  function myCoinsView(gid, uid) {
    const equipped = coins.getEquipped(db, gid, uid);
    const owned = coins.getOwned(db, gid, uid).map(k => coins.skinByKey(k)).filter(Boolean);
    const lines = owned.map(s => {
      const eq = equipped === s.key;
      return `${s.emoji} **${s.name}** — *${s.rarity}*${eq ? ' · ✅ **equipped**' : ''}`;
    }).join('\n');
    const locked = coins.SKINS.filter(s => !coins.isOwned(db, gid, uid, s.key)).length;
    const embed = new EmbedBuilder().setColor(0x5865F2).setTitle('🎒 My Coin Designs')
      .setDescription(
        `Coins you own (${owned.length}/${coins.SKINS.length}):\n\n${lines}\n\n` +
        (locked > 0 ? `🔒 **${locked}** more available in the shop.\n\n` : `🏆 You own every coin design!\n\n`) +
        `*Pick one below to equip it instantly.*`);
    const equipSelect = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId('hub:coinEquipPick').setPlaceholder('Equip one of your coins…')
        .addOptions(owned.map(s => ({ label: `${s.name} (${s.rarity})`, value: s.key, emoji: s.emoji,
          description: equipped === s.key ? 'Currently equipped' : 'Tap to equip' }))));
    const nav = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('hub:coins').setLabel('← Back to Shop').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('hub:home').setLabel('Hub').setStyle(ButtonStyle.Secondary));
    return { embeds: [embed], components: [equipSelect, nav], attachments: [] };
  }

  // roles section
  const rolesEmbed = (guildId, userId, isBooster) => {
    const rec = stateOf(guildId).roles[userId];
    const owned = rec ? `\n\n🎟️ You currently own **${esc(rec.label)}**${rec.icon ? ' 🖼️' : ''} — ${rec.booster ? 'yours while you keep boosting' : `expires <t:${Math.round((rec.expiresAt || 0) / 1000)}:R>`}. Buying again replaces it.` : '';
    return new EmbedBuilder().setColor(0xE7B41A).setTitle('🎨 Custom Roles')
      .setDescription(
        `Stand out with your own custom-named role!\n\n` +
        `🎨 **Custom Solid Role** — pick a name + a colour · **${fmt(PRICE_SOLID)} Dinar**\n` +
        `🌈 **Gradient Role** — pick a name + a gradient combo · **${fmt(PRICE_GRADIENT)} Dinar**\n` +
        `🖼️ **Role Icon** — add your own image next to your name · ${isBooster ? '**FREE** ⭐ (booster)' : `**${fmt(ICON_PRICE)} Dinar**`}\n\n` +
        `⏳ *Roles last **1 month**, then are removed automatically. Re-buy anytime to refresh. The icon lives on your current role.*${owned}`)
      .setImage('attachment://palette.png');
  };
  const rolesRow = (isBooster) => new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('shop:solid').setLabel(`Custom Solid — ${fmt(PRICE_SOLID)}`).setEmoji('🎨').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('shop:grad').setLabel(`Gradient — ${fmt(PRICE_GRADIENT)}`).setEmoji('🌈').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('shop:icon').setLabel(isBooster ? 'Role Icon — FREE ⭐' : `Role Icon — ${fmt(ICON_PRICE)}`).setEmoji('🖼️').setStyle(ButtonStyle.Secondary));

  // solid colours are split across two category selects (Discord caps a select at 25 options)
  const solidSelectBright = () => new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('shop:pickSolid:bright').setPlaceholder('🌈 Bright & Bold colours…')
      .addOptions(SOLID_BRIGHT.map(c => ({ label: c.name, value: c.key, emoji: c.emoji }))));
  const solidSelectSoft = () => new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('shop:pickSolid:soft').setPlaceholder('🎨 Pastels, Earth & Neutrals…')
      .addOptions(SOLID_SOFT.map(c => ({ label: c.name, value: c.key, emoji: c.emoji }))));
  const gradSelect = () => new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('shop:pickGrad').setPlaceholder('Choose a gradient…')
      .addOptions(GRADIENTS.map(g => ({ label: g.name, value: g.key, emoji: g.emoji }))));
  const backSolidRow = () => new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('shop:solid').setLabel('← Pick another colour').setStyle(ButtonStyle.Secondary));
  const backGradRow = () => new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('shop:grad').setLabel('← Pick another gradient').setStyle(ButtonStyle.Secondary));

  function nameModal(kind, choiceKey) {
    return new ModalBuilder().setCustomId(`shop:name:${kind}:${choiceKey}`).setTitle('Name your role')
      .addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('rolename').setLabel(`Role name (max ${NAME_MAX} chars)`)
          .setStyle(TextInputStyle.Short).setMaxLength(NAME_MAX).setMinLength(2).setRequired(true)
          .setPlaceholder('e.g. Sultan of Tripoli')));
  }

  // streak section
  function streakView(guildId, userId, name) {
    const state = stateOf(guildId);
    const rec = state.streaks[userId];
    const now = Date.now();
    const st = streakStatus(rec, now);
    const board = streakLeaderboard(state, now);
    const boardLines = board.length
      ? board.map((r, i) => `${['🥇', '🥈', '🥉'][i] || `**${i + 1}.**`} **${esc(r.name)}** — 🔥 ${r.count} day${r.count === 1 ? '' : 's'}${r.best > r.count ? ` (best ${r.best})` : ''}`).join('\n')
      : '*No active streaks yet — be the first!*';

    let statusLine, canCheck = false;
    if (st.state === 'done_today') {
      statusLine = `✅ **You've checked in today!** You're on a **${st.count}-day** streak.\n⏳ Next check-in unlocks <t:${Math.round(st.nextAt / 1000)}:R>.`;
    } else if (st.reset) {
      statusLine = `💔 **Your streak lapsed** (a day was missed) — your previous best was ${st.prev}. Check in now to start a fresh streak!`;
      canCheck = true;
    } else if (st.continues) {
      statusLine = `🔥 **Ready!** Check in now to extend your streak to **${st.count + 1} days** and earn **${fmt(streakReward(st.count + 1))} Dinar**.`;
      canCheck = true;
    } else {
      statusLine = `🔥 **Start your streak!** Check in now to earn **${fmt(streakReward(1))} Dinar** and begin day 1.`;
      canCheck = true;
    }

    const embed = new EmbedBuilder().setColor(0xFF6B35).setTitle('🔥 Daily Streak')
      .setDescription(
        `Check in **once a day** to keep your streak alive and earn a growing Dinar reward.\n` +
        `💰 Reward: **${STREAK_BASE} + ${STREAK_PER_DAY} per day**, up to **${STREAK_CAP} Dinar**. Miss a day and it resets.\n\n` +
        `${statusLine}\n\n` +
        `**🏆 Streak Leaderboard**\n${boardLines}`);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('hub:checkin').setLabel(canCheck ? 'Check in today ✅' : 'Already checked in').setEmoji('🔥').setStyle(ButtonStyle.Success).setDisabled(!canCheck),
      new ButtonBuilder().setCustomId('hub:home').setLabel('← Back to Hub').setStyle(ButtonStyle.Secondary));
    return { embeds: [embed], components: [row] };
  }

  const openHub = (interaction) => {
    const png = renderSwatch(paletteSwatch());
    return { embeds: [hubEmbed()], components: [hubRow()], files: [] };
  };

  // ── Role Icon flow: watch for an image upload in-channel, apply it to the user's hub role ──
  const iconSessions = new Map();   // uid → { collector, done }
  const iconRetryRow = () => new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('shop:icon').setLabel('Try Again').setEmoji('🖼️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('hub:home').setLabel('← Back to Hub').setStyle(ButtonStyle.Secondary));

  async function startIconFlow(interaction) {
    const gid = interaction.guildId, uid = interaction.user.id;
    const rec = stateOf(gid).roles[uid];
    const free = isBoosting(interaction);
    const backRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('hub:home').setLabel('← Back to Hub').setStyle(ButtonStyle.Secondary));
    if (!rec) {
      return interaction.update({ content: '', embeds: [new EmbedBuilder().setColor(0xE7B41A).setTitle('🖼️ Role Icon')
        .setDescription(`You need an active hub role first! Grab a **Custom Role** from the Shop${free ? ' or a free **Booster** role' : ''}, then come back to add your icon to it.`)],
        components: [backRow], files: [], attachments: [] });
    }
    if (!free && getDinar(db, gid, uid) < ICON_PRICE) {
      return interaction.update({ content: '', embeds: [new EmbedBuilder().setColor(0xE74C3C).setTitle('🖼️ Role Icon')
        .setDescription(`A custom role icon costs **${fmt(ICON_PRICE)} Dinar** and you have **${fmt(getDinar(db, gid, uid))}**. Keep earning and come back!`)],
        components: [backRow], files: [], attachments: [] });
    }
    if (!interaction.guild.features.includes('ROLE_ICONS')) {
      return interaction.update({ content: '', embeds: [new EmbedBuilder().setColor(0xE74C3C).setTitle('🖼️ Role Icon')
        .setDescription('This server doesn\'t currently have the **Role Icons** feature unlocked (it comes with Boost Level 2).')],
        components: [backRow], files: [], attachments: [] });
    }
    // one live session per user — replace any previous
    const prev = iconSessions.get(uid);
    if (prev) { prev.done = true; prev.collector.stop('replaced'); }

    const embed = new EmbedBuilder().setColor(0x5865F2).setTitle('🖼️ Role Icon — upload your image')
      .setDescription(
        `Send your icon **as an image message in this channel** within **60 seconds** and I'll grab it.\n\n` +
        `• Square **PNG or JPG** works best (it shows tiny, next to your name)\n` +
        `• I'll resize it automatically\n` +
        `• ${free ? '⭐ **Free** — booster perk!' : `💰 **${fmt(ICON_PRICE)} Dinar** — charged only once the icon is applied`}\n` +
        `• The icon lasts as long as your current role does`);
    const cancelRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('hub:iconCancel').setLabel('Cancel').setStyle(ButtonStyle.Danger));
    await interaction.update({ content: '', embeds: [embed], components: [cancelRow], files: [], attachments: [] });

    const collector = interaction.channel.createMessageCollector({
      filter: (m) => m.author.id === uid && m.attachments.size > 0, time: 60_000, max: 1 });
    const sess = { collector, done: false };
    iconSessions.set(uid, sess);

    collector.on('collect', async (m) => {
      if (sess.done) return;
      sess.done = true; iconSessions.delete(uid);
      const finish = (color, text) => interaction.editReply({ content: '', embeds: [new EmbedBuilder().setColor(color).setTitle('🖼️ Role Icon').setDescription(text)], components: [iconRetryRow()], files: [], attachments: [] }).catch(() => {});
      const got = await fetchIconBuffer(m.attachments.first());
      if (got.error) return finish(0xE74C3C, `⚠️ ${got.error}\nNothing was charged — hit **Try Again** to have another go.`);
      const role = interaction.guild.roles.cache.get(rec.roleId) || await interaction.guild.roles.fetch(rec.roleId).catch(() => null);
      if (!role) return finish(0xE74C3C, '⚠️ I couldn\'t find your role anymore — grab a fresh one from the Shop, then add the icon.');
      try { await role.setIcon(got.buf, `Role icon set by ${interaction.user.tag}`); }
      catch (e) {
        console.error('[hub icon]', e.message);
        return finish(0xE74C3C, '⚠️ Discord rejected that image (too large or unsupported format). Nothing was charged — try a smaller, square PNG/JPG.');
      }
      if (!free) spendDinar(db, gid, uid, ICON_PRICE, saveData);
      rec.icon = true; saveData(gid);
      m.delete().catch(() => {});   // tidy the channel if we have permission
      setAction(uid, `🖼️ Added a custom icon to **${esc(rec.label)}**${free ? ' (booster perk)' : ` (${fmt(ICON_PRICE)} Dinar)`}.`);
      const balLine = free ? '⭐ Free booster perk.' : `💰 Paid **${fmt(ICON_PRICE)} Dinar** — new balance **${fmt(getDinar(db, gid, uid))}**.`;
      return finish(0x2ECC71, `✅ Icon applied to **${esc(rec.label)}**! It now shows next to your name.\n${balLine}\n⏳ The icon lasts as long as this role does.`);
    });
    collector.on('end', (_collected, reason) => {
      if (sess.done || reason === 'cancel' || reason === 'replaced' || reason === 'limit') return;
      sess.done = true; iconSessions.delete(uid);
      interaction.editReply({ content: '', embeds: [new EmbedBuilder().setColor(0xE7B41A).setTitle('🖼️ Role Icon').setDescription('⏳ Timed out — no image received. Nothing was charged.')], components: [iconRetryRow()], files: [], attachments: [] }).catch(() => {});
    });
  }

  // ── Help pages (mirrors /libyan-commands, plus a Hub page) ──
  function helpPages() {
    const P = (color, title, fields, desc) => {
      const e = new EmbedBuilder().setColor(color).setTitle(title);
      if (desc) e.setDescription(desc);
      if (fields) e.addFields(fields);
      return e;
    };
    const pages = [
      P(0x5865F2, '🏛️ Libyan Community Bot — Page 1/9: Clan Management', [
        { name: '📋 Info', value: ['`/libyan-commands` — This menu', '`/clan-info [name]` — View clan details', '`/clan-list` — All clans ranked by XP', '`/clan-xp` — XP leaderboard', '`/libyan-stats [@user]` — View Libyan Points (LP) & Dinar'].join('\n') },
        { name: '🏰 Management', value: ['`/clan-create <name>` — Create a clan', '`/clan-disband` *(Leader)*', '`/clan-rename <name> [emoji]` *(Leader)*', '`/clan-description <text>` *(Leader/Officer)*', '`/clan-motto <text>` *(Leader/Officer)*', '`/clan-ranks <member> <officer> <leader>` *(Leader)*'].join('\n') },
        { name: '👥 Membership', value: ['`/clan-invite @user` *(Leader/Officer)*', '`/clan-invite-accept`', '`/clan-invite-decline`', '`/clan-kick @user` *(Leader/Officer)*', '`/clan-leave`'].join('\n') },
        { name: '🛡️ Ranks', value: ['`/clan-promote @user` *(Leader)*', '`/clan-demote @user` *(Leader)*', '`/clan-transfer @user` *(Leader)*'].join('\n') },
        { name: '📢 Channel & Wars', value: ['`/clan-channel-create` *(Leader)*', '`/clan-channel-link` *(Leader)*', '`/clan-channel-delete` *(Leader)*', '`/clan-war <clan>` *(Leader/Officer)*', '`/clan-war-accept`', '`/clan-war-decline`'].join('\n') },
      ]),
      P(0xFF0000, '🎮 Libyan Community Bot — Page 2/9: Pokémon', [
        { name: '🌿 Catching', value: ['`/pokemon-team` — Your Pokémon', '`/pokemon-stats <slot>` — Detailed stats + XP', '`/pokemon-view @user`', '`/pokemon-release <slot>`', '`/pokemon-nickname <slot> <name>`', '`/pokemon-info <name>`'].join('\n') },
        { name: '⚔️ Battles', value: ['`/pokemon-challenge @user <slot>`', '`/pokemon-accept <slot>`', '`/pokemon-decline`'].join('\n') },
        { name: '🎒 Items', value: ['`/pokemon-bag`', '`/pokemon-claim`'].join('\n') },
        { name: '🎴 Card Games', value: ['`/battlecards @user [target] [bet]` — Duel', '`/battlecards-leaderboard`', '`/battlecards-stats [user]`', '*Wins give LP 🏅 + optional Dinar wager 💰*'].join('\n') },
        { name: '📊 Stats', value: ['`/pokemon-leaderboard`', '`/pokemon-server`', '`/pokedex`'].join('\n') },
        { name: '⏱️ Timings', value: 'Wild Pokémon spawn every **5 hours**, flee after **3 hours**\nItem drops every **7 hours**\nShiny chance: 1 in 50 🌟' },
      ]),
      P(0xFFD700, '🏅 Libyan Community Bot — Page 3/9: Rank Permissions', [
        { name: '👑 Leader', value: ['✅ All permissions', '✅ Disband, rename, transfer', '✅ Promote, demote, kick', '✅ Start & accept wars', '✅ Create/delete clan channel'].join('\n') },
        { name: '🛡️ Officer', value: ['✅ Invite & kick members', '✅ Set description & motto', '✅ Start clan wars', '❌ Cannot disband/rename/transfer', '❌ Cannot kick other Officers'].join('\n') },
        { name: '⚔️ Member', value: ['✅ View clan info', '✅ Participate in games', '✅ Claim item drops', '✅ Leave the clan', '❌ Cannot invite, kick or start wars'].join('\n') },
        { name: '🏛️ Libyan Points (LP)', value: ['War win: **+50 LP**', 'War loss: **+10 LP**', 'Catch Pokémon: **+1 LP**', 'Win battle: **+15 LP**', 'Lose battle: **+3 LP**', 'Ya Rayt reaction: **+1 LP**', 'Ya Rayt winner: **+10 LP**'].join('\n') },
      ]),
      P(0x00AA44, '🇱🇾 Libyan Community Bot — Page 4/9: Ya Rayt & Post of the Day', [
        { name: '📖 What is Ya Rayt?', value: '"Ya Rayt" (يا ريت) means **"I wish"**.\nEvery 2 days at **6PM Libya time** a round opens; at **8PM** it closes.' },
        { name: '🎮 Commands', value: ['`/yarayt <wish>` — Submit your wish', '`/top-yarayt`', '`/top-relatable-yarayt`', '`/top-funny-yarayt`', '`/top-wholesome-yarayt`', '`/top-bold-yarayt`'].join('\n') },
        { name: '⭐ Reactions', value: ['🇱🇾 Relatable', '😂 Funny', '❤️ Wholesome', '🔥 Bold'].join('\n') },
        { name: '🏆 Post of the Day', value: 'Daily at **9PM Libya time**, the most-reacted message (min **3 reactions**) wins a hoisted **Poster of the Day** role for 24h.' },
        { name: '🎮 POTD Rewards', value: '`/potd-hall-of-fame`\nWinner: **+50 LP** · streak bonus (day 2+): **+25 LP/day**' },
      ]),
      P(0xE91E63, '🎴 Libyan Community Bot — Page 5/9: Collection Game (Qa\'ima)', [
        { name: '🚪 Getting in', value: ['`/gacha-optin`', '`/gacha-optout`', '`/gacha-list`'].join('\n') },
        { name: '🎲 Playing', value: ['`/gacha-roll` *(every 3h)*', '`/gacha-wish @user`', '`/gacha-wishlist`', '`/gacha-collection [@user]`', '`/gacha-rarest`'].join('\n') },
        { name: '💰 Dinar & trading', value: ['`/dinar [@user]`', '`/dinar-daily`', '`/dinar-flip <bet> <heads/tails>` *(every 2h)*', '`/dinar-richest`', '`/gacha-release @user`', '`/gacha-trade @with @give @receive`', '`/gacha-raid @owner @card`'].join('\n') },
        { name: '⚡ How a roll works', value: ['• Drops the card after **5s**', '• Anyone can Claim — first click wins', '• Expires after **60s**', '• Already-owned → a **💵 Dinar Drop** appears', '• Must be **opted in** to claim'].join('\n') },
      ], 'Collect your fellow members as cards! Everything runs on **Dinar** 💰.'),
      P(0xF1C40F, '💎 Libyan Community Bot — Page 6/9: Rarity & Earning Dinar', [
        { name: '⭐ How rarity is decided', value: ['An **activity score** from:', '• 🏆 Clan war wins', '• 🇱🇾 Ya Rayt', '• 📸 Post of the Day', '• 🎮 Pokémon', 'Ranked against everyone to set your tier.'].join('\n') },
        { name: '🏅 Tiers', value: ['🔴 **Mythic** — top 1% · 15,000', '🟡 **Legendary** — top 5% · 5,000', '🟣 **Epic** — top 20% · 1,500', '🔵 **Rare** — top 50% · 500', '⚪ **Common** · 100'].join('\n') },
        { name: '💰 Earning Dinar', value: ['• `/dinar-daily` **+50**', '• 💵 Dinar Drops', '• 🏆 Clan War **+100**', '• 🇱🇾 Ya Rayt **+500**', '• 📸 POTD **+300**', '• 🎮 Catch **+20** · battle **+75**', '• Wars & battles cap at **300/day**'].join('\n') },
      ], '**Your card\'s rarity is earned, not random** — based on how active you are.'),
      P(0xC8A24A, '🏛️ Libyan Community Bot — Page 7/9: Diyar (Conquest of Libya)', [
        { name: '🗺️ Getting started', value: ['`/diyar` — Your dashboard', '`/diyar-map`', '`/diyar-leaderboard`', 'Join landless & raid your way to a first city!'].join('\n') },
        { name: '⚔️ Playing', value: 'Raid cities, Recruit troops, Reinforce, Upgrade (Military/Fortifications/Economy), buy weapons, Collect income (every **90 min**), and Strike the threat.' },
        { name: '🛡️ Live raids', value: 'Raids run **live for 30s** — the defender is pinged and can **Send Reinforcements** for a defence boost.' },
        { name: '👹 The Threat', value: 'A monster besieges **3 cities** at once. Everyone can **Strike** it (every 3s). Slay it in **20 min** for the best loot. It never fully destroys a city.' },
        { name: '⚙️ Fairness', value: 'A match-band stops the strong punching down. Garrisons cap at **3,000** troops.' },
      ], 'Raise an army, seize cities across Libya, build an empire — running on **Dinar** 💰.'),
      P(0xE7B41A, '🎡 Libyan Community Bot — Page 8/9: Dinar Lottery', [
        { name: '🎟️ How to play', value: ['`/dinar-lotto <wager>` (**1–500**, one entry)', 'Bigger wager = better odds', 'Runs **1 hour**; reminders every 15 min'].join('\n') },
        { name: '🏆 Winning', value: ['Odds = your wager ÷ total pool', 'A suspense spin lands on the winner — they take the **whole pool**', '`/lottery-leaderboard`'].join('\n') },
      ], 'A lottery wheel that spins **twice a day** (11:00–23:00 Libya time). Winner takes the **entire pool** 💰.'),
      // NEW — the Hub itself
      P(0xF47FFF, '🏛️ Libyan Community Bot — Page 9/9: The Hub (/hub)', [
        { name: '🎨 Custom Roles', value: ['Buy a personalised, custom-named role:', '• **Solid** — pick from 48 colours · **800 Dinar**', '• **Gradient** — preset combos · **1,500 Dinar**', '• 🖼️ **Role Icon** — upload your own image · **3,000 Dinar** (free for boosters)', 'Both last **1 month**, then renew from `/hub`.'].join('\n') },
        { name: '🪙 Coin Flip', value: 'Bet **1–500 Dinar** on heads or tails, straight from the hub — the flip plays out publicly in the channel. One flip every 2h.' },
        { name: '🔥 Daily Streak', value: ['Check in once a day for a growing reward: **20 + 5 per day**, up to **100 Dinar**.', 'Miss a day and it resets. A leaderboard ranks the longest streaks.'].join('\n') },
        { name: '⭐ Booster Perks', value: ['**Boosters only** — free premium roles:', '• ✨ **Holographic** — Discord\'s shimmer style', '• 🎨 **Custom Solid** — any colour by hex code', '• 🌈 **Custom Gradient** — blend any two hex colours', '• 🖼️ **Role Icon** — upload your own image, free', 'These stay while you keep boosting, and you can change them free anytime.'].join('\n') },
      ], 'Your one-stop hub — open it with **`/hub`**.'),
    ];
    return pages;
  }
  const helpRow = (page, total) => new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`hub:help:${page - 1}`).setLabel('◀ Previous').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId(`hub:help:${page + 1}`).setLabel('Next ▶').setStyle(ButtonStyle.Primary).setDisabled(page === total - 1),
    new ButtonBuilder().setCustomId('hub:home').setLabel('← Back to Hub').setStyle(ButtonStyle.Secondary));

  // ═══════════════ CLAN UI ═══════════════
  const backHubOnly = () => new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('hub:home').setLabel('← Back to Hub').setStyle(ButtonStyle.Secondary));

  // entry: no clan → offer create/join; in a clan → dashboard
  function clanEntryView(gid, uid) {
    const mine = clans.userClan(db, gid, uid);
    if (mine) return clanDashboard(gid, uid);
    const all = clans.clanEntries(db, gid);
    const count = Object.keys(all).length;
    const bal = getDinar(db, gid, uid);
    const embed = new EmbedBuilder().setColor(0x5865F2).setTitle('⚔️ Clans')
      .setDescription(
        `You're not in a clan yet.\n\n` +
        `🏰 **Create your own clan** — become the Leader, get clan roles & a private channel\n` +
        `   Cost: **${fmt(clans.CLAN_CREATE_COST)} Dinar**\n\n` +
        `🤝 **Join an existing clan** — ${count > 0 ? `**${count}** on the server` : 'none yet — be the first!'}\n` +
        `   Cost: **${fmt(clans.CLAN_JOIN_COST)} Dinar**\n\n` +
        `💰 Your balance: **${fmt(bal)} Dinar**`);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('clan:create').setLabel(`Create — ${fmt(clans.CLAN_CREATE_COST)}`).setEmoji('🏰').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('clan:joinList').setLabel(`Join — ${fmt(clans.CLAN_JOIN_COST)}`).setEmoji('🤝').setStyle(ButtonStyle.Primary).setDisabled(count === 0));
    return { embeds: [embed], components: [row, backHubOnly()], files: [], attachments: [] };
  }

  function clanDashboard(gid, uid) {
    const mine = clans.userClan(db, gid, uid);
    if (!mine) return clanEntryView(gid, uid);
    const c = clans.normaliseClan(mine.clan);
    const rank = clans.userRank(c, uid);
    const isLeader = rank === 'Leader', isOfficerPlus = rank === 'Leader' || rank === 'Officer';
    const memberCount = 1 + c.officers.length + c.members.length;
    const winRate = (c.wins + c.losses) > 0 ? Math.round((c.wins / (c.wins + c.losses)) * 100) : 0;
    const embed = new EmbedBuilder().setColor(0x5865F2).setTitle(`${c.emoji} ${esc(mine.name)}`)
      .setDescription(c.description + (c.motto ? `\n\n*“${esc(c.motto)}”*` : ''))
      .addFields(
        { name: '👑 Leader', value: `<@${c.leader}>`, inline: true },
        { name: '👥 Members', value: `${memberCount}`, inline: true },
        { name: '🏅 Your Rank', value: clans.rankLabel(c, rank), inline: true },
        { name: '⭐ XP', value: `${fmt(c.xp)}`, inline: true },
        { name: '⚔️ Record', value: `${c.wins}W / ${c.losses}L (${winRate}%)`, inline: true },
        { name: '📢 Channel', value: c.channelId ? `<#${c.channelId}>` : '*none*', inline: true },
      );
    // row 1: everyone — view members; officers+ requests & settings
    const reqCount = isOfficerPlus ? clans.clanRequests(db, gid, mine.name).length : 0;
    const row1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('clan:members').setLabel('Members').setEmoji('👥').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('clan:settings').setLabel('Settings').setEmoji('⚙️').setStyle(ButtonStyle.Secondary).setDisabled(!isOfficerPlus),
      new ButtonBuilder().setCustomId('clan:requests').setLabel(`Join Requests${reqCount ? ` (${reqCount})` : ''}`).setEmoji('📥').setStyle(reqCount ? ButtonStyle.Success : ButtonStyle.Secondary).setDisabled(!isOfficerPlus));
    // row 2: leader management
    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('clan:manage').setLabel('Manage Members').setEmoji('🛡️').setStyle(ButtonStyle.Secondary).setDisabled(!isOfficerPlus),
      new ButtonBuilder().setCustomId('clan:channel').setLabel(c.channelId ? 'Channel' : `Create Channel — ${fmt(clans.CLAN_CHANNEL_COST)}`).setEmoji('📢').setStyle(ButtonStyle.Secondary).setDisabled(!isLeader));
    // row 3: leave/disband + back
    const row3 = new ActionRowBuilder().addComponents(
      isLeader
        ? new ButtonBuilder().setCustomId('clan:disband').setLabel('Disband').setEmoji('💥').setStyle(ButtonStyle.Danger)
        : new ButtonBuilder().setCustomId('clan:leave').setLabel('Leave Clan').setEmoji('🚪').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('hub:home').setLabel('← Back to Hub').setStyle(ButtonStyle.Secondary));
    return { content: '', embeds: [embed], components: [row1, row2, row3], files: [], attachments: [] };
  }

  function clanMembersView(gid, uid) {
    const mine = clans.userClan(db, gid, uid);
    if (!mine) return clanEntryView(gid, uid);
    const c = clans.normaliseClan(mine.clan);
    const line = (id) => `<@${id}>`;
    const embed = new EmbedBuilder().setColor(0x5865F2).setTitle(`👥 ${esc(mine.name)} — Members`)
      .setDescription(
        `👑 **${clans.rankLabel(c, 'Leader')}**\n${line(c.leader)}\n\n` +
        `🛡️ **${clans.rankLabel(c, 'Officer')}** (${c.officers.length})\n${c.officers.length ? c.officers.map(line).join('\n') : '*none*'}\n\n` +
        `⚔️ **${clans.rankLabel(c, 'Member')}** (${c.members.length})\n${c.members.length ? c.members.map(line).join('\n') : '*none*'}`);
    const back = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('hub:clan').setLabel('← Back to Clan').setStyle(ButtonStyle.Secondary));
    return { content: '', embeds: [embed], components: [back], files: [], attachments: [] };
  }

  function clanSettingsView(gid, uid) {
    const mine = clans.userClan(db, gid, uid);
    if (!mine) return clanEntryView(gid, uid);
    const c = clans.normaliseClan(mine.clan);
    const isLeader = c.leader === uid;
    const embed = new EmbedBuilder().setColor(0x5865F2).setTitle(`⚙️ ${esc(mine.name)} — Settings`)
      .setDescription(`Update your clan's details.`)
      .addFields(
        { name: 'Description', value: c.description || '*none*' },
        { name: 'Motto', value: c.motto || '*none*' },
        { name: 'Emoji', value: c.emoji || '⚔️', inline: true },
      );
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('clan:setDesc').setLabel('Edit Description').setEmoji('📝').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('clan:setMotto').setLabel('Edit Motto').setEmoji('💬').setStyle(ButtonStyle.Secondary));
    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('clan:rename').setLabel('Rename / Emoji').setEmoji('✏️').setStyle(ButtonStyle.Secondary).setDisabled(!isLeader),
      new ButtonBuilder().setCustomId('hub:clan').setLabel('← Back to Clan').setStyle(ButtonStyle.Secondary));
    return { content: '', embeds: [embed], components: [row, row2], files: [], attachments: [] };
  }

  function clanManageView(gid, uid) {
    const mine = clans.userClan(db, gid, uid);
    if (!mine) return clanEntryView(gid, uid);
    const c = clans.normaliseClan(mine.clan);
    const isLeader = c.leader === uid;
    const embed = new EmbedBuilder().setColor(0x5865F2).setTitle(`🛡️ ${esc(mine.name)} — Manage Members`)
      .setDescription(
        `Pick an action, then choose the member.\n\n` +
        `${isLeader ? '👑 As Leader you can promote, demote, kick and transfer leadership.' : '🛡️ As Officer you can kick Members.'}`);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('clan:act:kick').setLabel('Kick').setEmoji('🥾').setStyle(ButtonStyle.Danger));
    if (isLeader) row.addComponents(
      new ButtonBuilder().setCustomId('clan:act:promote').setLabel('Promote').setEmoji('⬆️').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('clan:act:demote').setLabel('Demote').setEmoji('⬇️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('clan:act:transfer').setLabel('Transfer').setEmoji('👑').setStyle(ButtonStyle.Primary));
    const back = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('hub:clan').setLabel('← Back to Clan').setStyle(ButtonStyle.Secondary));
    return { content: '', embeds: [embed], components: [row, back], files: [], attachments: [] };
  }

  function clanRequestsView(gid, uid) {
    const mine = clans.userClan(db, gid, uid);
    if (!mine) return clanEntryView(gid, uid);
    if (clans.userRank(mine.clan, uid) === 'Member') return clanDashboard(gid, uid);
    const reqs = clans.clanRequests(db, gid, mine.name);
    const embed = new EmbedBuilder().setColor(0x57F287).setTitle(`📥 ${esc(mine.name)} — Join Requests`)
      .setDescription(reqs.length
        ? `**${reqs.length}** pending request${reqs.length === 1 ? '' : 's'}. Accepting charges them **${fmt(clans.CLAN_JOIN_COST)} Dinar**; declining costs them nothing.\n\n` +
          reqs.map(r => `• <@${r.uid}> — requested <t:${Math.round(r.requestedAt / 1000)}:R>, expires <t:${Math.round(r.expiresAt / 1000)}:R>`).join('\n')
        : '*No pending requests right now.*');
    const rows = [];
    // one accept/decline row per request (max 4 to stay within component limits, + back row)
    reqs.slice(0, 4).forEach(r => {
      rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`clan:reqAccept:${r.uid}`).setLabel('Accept').setEmoji('✅').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`clan:reqDecline:${r.uid}`).setLabel('Decline').setEmoji('❌').setStyle(ButtonStyle.Danger)));
    });
    rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('hub:clan').setLabel('← Back to Clan').setStyle(ButtonStyle.Secondary)));
    return { content: reqs.length > 4 ? `Showing the first 4 of ${reqs.length} requests.` : '', embeds: [embed], components: rows, files: [], attachments: [] };
  }

  // ═══════════════ INTERACTIONS ═══════════════
  client.on('interactionCreate', async (interaction) => {
    try {
      // /hub
      if (interaction.isChatInputCommand() && interaction.commandName === 'hub') {
        if (!interaction.guildId) return interaction.reply({ content: 'Use this in the server.', flags: 64 });
        const boosting = isBoosting(interaction);
        const uname = interaction.member?.displayName || interaction.user.username;
        console.log(`🏛️ /hub opened by ${uname} (${interaction.user.id})${boosting ? ' [booster]' : ''}`);
        return interaction.reply({ embeds: [hubEmbed(boosting, interaction.user.id, interaction.guildId)], components: hubComponents(boosting), flags: 64 });
      }
      if (!interaction.guildId) return;
      const gid = interaction.guildId, uid = interaction.user.id;
      const name = interaction.member?.displayName || interaction.user.username;

      // hub navigation
      if (interaction.isButton() && interaction.customId === 'hub:home') {
        const boosting = isBoosting(interaction);
        return interaction.update({ embeds: [hubEmbed(boosting, uid, gid)], components: hubComponents(boosting), files: [], attachments: [] });
      }
      // ── Shop sub-menu: Custom Roles + Coin Designs ──
      if (interaction.isButton() && interaction.customId === 'hub:shop') {
        const embed = new EmbedBuilder().setColor(0xE7B41A).setTitle('🛒 The Shop')
          .setDescription(`Spend your Dinar 💰\n\n🎨 **Custom Roles** — a personalised colour or gradient role, plus your own 🖼️ image icon\n🪙 **Coin Designs** — reskin your coin flip with themed coins`);
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('hub:roles').setLabel('Custom Roles').setEmoji('🎨').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('hub:coins').setLabel('Coin Designs').setEmoji('🪙').setStyle(ButtonStyle.Success));
        return interaction.update({ content: '', embeds: [embed], components: [row, backHubRow()], files: [], attachments: [] });
      }
      // Coin Designs — browse, preview, buy & equip
      if (interaction.isButton() && interaction.customId === 'hub:coins') {
        return interaction.update({ ...coinShopView(gid, uid), content: '', files: (await coinShopFiles(gid, uid)) });
      }
      // My Coins — owned skins with quick-equip
      if (interaction.isButton() && interaction.customId === 'hub:mycoins') {
        return interaction.update({ ...myCoinsView(gid, uid), content: '', files: [] });
      }
      // quick-equip from the My Coins dropdown
      if (interaction.isStringSelectMenu() && interaction.customId === 'hub:coinEquipPick') {
        const key = interaction.values[0];
        const skin = coins.skinByKey(key);
        if (coins.equip(db, gid, uid, key, saveData) && skin) setAction(uid, `🪙 Equipped the **${skin.name}** coin design.`);
        return interaction.update({ ...myCoinsView(gid, uid), content: skin ? `✅ Equipped **${skin.name}** — it'll show on your next flip.` : '', files: [] });
      }
      // coin skin selected from the dropdown → preview + buy/equip
      if (interaction.isStringSelectMenu() && interaction.customId === 'hub:coinPick') {
        const key = interaction.values[0];
        const skin = coins.skinByKey(key);
        if (!skin) return interaction.deferUpdate();
        const owned = coins.isOwned(db, gid, uid, key);
        const equipped = coins.getEquipped(db, gid, uid) === key;
        const png = coins.renderFace(key, 'heads');
        const embed = new EmbedBuilder().setColor(coins.RARITY_COLOR[skin.rarity] || 0xE7B41A)
          .setTitle(`${skin.emoji} ${skin.name}`)
          .setDescription(`**Rarity:** ${skin.rarity}\n${skin.price > 0 ? `**Price:** ${fmt(skin.price)} Dinar` : '*Default coin — free*'}\n\n${equipped ? '✅ *Currently equipped.*' : owned ? '🎟️ *You own this — equip it below.*' : '🛒 *Buy it below to unlock.*'}`)
          .setImage('attachment://coinpreview.png');
        const row = new ActionRowBuilder();
        if (equipped) row.addComponents(new ButtonBuilder().setCustomId('hub:coins').setLabel('✓ Equipped').setStyle(ButtonStyle.Secondary).setDisabled(true));
        else if (owned) row.addComponents(new ButtonBuilder().setCustomId(`hub:coinEquip:${key}`).setLabel('Equip this coin').setEmoji('🪙').setStyle(ButtonStyle.Success));
        else row.addComponents(new ButtonBuilder().setCustomId(`hub:coinBuy:${key}`).setLabel(`Buy — ${fmt(skin.price)} Dinar`).setEmoji('🛒').setStyle(ButtonStyle.Success));
        const back = new ButtonBuilder().setCustomId('hub:coins').setLabel('← Back to Coins').setStyle(ButtonStyle.Secondary);
        return interaction.update({ content: '', embeds: [embed], components: [row.addComponents(back)], files: [new AttachmentBuilder(png, { name: 'coinpreview.png' })], attachments: [] });
      }
      // equip an owned coin
      if (interaction.isButton() && interaction.customId.startsWith('hub:coinEquip:')) {
        const key = interaction.customId.split(':')[2];
        coins.equip(db, gid, uid, key, saveData);
        const skin = coins.skinByKey(key);
        setAction(uid, `🪙 Equipped the **${skin ? skin.name : key}** coin design.`);
        return interaction.update({ ...coinShopView(gid, uid), content: `✅ Equipped **${skin ? skin.name : key}**! It'll show on your next flip.`, files: (await coinShopFiles(gid, uid)) });
      }
      // buy a coin
      if (interaction.isButton() && interaction.customId.startsWith('hub:coinBuy:')) {
        const key = interaction.customId.split(':')[2];
        const skin = coins.skinByKey(key);
        if (!skin || skin.price <= 0) return interaction.deferUpdate();
        if (coins.isOwned(db, gid, uid, key)) { coins.equip(db, gid, uid, key, saveData); return interaction.update({ ...coinShopView(gid, uid), files: (await coinShopFiles(gid, uid)) }); }
        const bal = getDinar(db, gid, uid);
        if (bal < skin.price)
          return interaction.reply({ content: `💰 You need **${fmt(skin.price)} Dinar** but only have **${fmt(bal)}**. Keep earning!`, flags: 64 });
        spendDinar(db, gid, uid, skin.price, saveData);
        coins.addOwned(db, gid, uid, key, saveData);
        coins.equip(db, gid, uid, key, saveData);   // auto-equip on purchase
        setAction(uid, `🪙 Bought & equipped the **${skin.name}** coin (${fmt(skin.price)} Dinar).`);
        return interaction.update({ ...coinShopView(gid, uid), content: `✅ **${skin.name}** unlocked & equipped! New balance **${fmt(getDinar(db, gid, uid))} Dinar**.`, files: (await coinShopFiles(gid, uid)) });
      }

      if (interaction.isButton() && interaction.customId === 'hub:roles') {
        const boosting = isBoosting(interaction);
        const png = renderSwatch(paletteSwatch());
        return interaction.update({ content: '', embeds: [rolesEmbed(gid, uid, boosting)], components: [rolesRow(boosting), backHubRow()],
          files: [new AttachmentBuilder(png, { name: 'palette.png' })], attachments: [] });
      }
      if (interaction.isButton() && interaction.customId === 'hub:flip') {
        if (!runFlip) return interaction.reply({ content: `🪙 Use **\`/dinar-flip <amount> <heads/tails>\`** to play.`, flags: 64 });
        const modal = new ModalBuilder().setCustomId('hub:flipAmount').setTitle('🪙 Coin Flip')
          .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('betamount').setLabel('How much Dinar to bet? (1–500)')
              .setStyle(TextInputStyle.Short).setMaxLength(4).setMinLength(1).setRequired(true).setPlaceholder('e.g. 100')));
        return interaction.showModal(modal);
      }
      // amount entered → show heads/tails buttons (carry the amount in the customId)
      if (interaction.isModalSubmit() && interaction.customId === 'hub:flipAmount') {
        const raw = interaction.fields.getTextInputValue('betamount').trim();
        const amount = parseInt(raw, 10);
        if (!Number.isFinite(amount) || amount < 1 || amount > 500)
          return interaction.reply({ content: '🪙 Please enter a whole number between **1 and 500**.', flags: 64 });
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`hub:flipGo:heads:${amount}`).setLabel('Heads').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`hub:flipGo:tails:${amount}`).setLabel('Tails').setStyle(ButtonStyle.Primary));
        return interaction.reply({ content: `🪙 Betting **${fmt(amount)} Dinar** — call it!`, components: [row], flags: 64 });
      }
      // side chosen → close the hub bits and fire the PUBLIC flip via the shared engine
      if (interaction.isButton() && interaction.customId.startsWith('hub:flipGo:')) {
        const [, , side, amtStr] = interaction.customId.split(':');
        const amount = parseInt(amtStr, 10);
        await interaction.update({ content: '🪙 Tossing your coin in the channel…', components: [] }).catch(() => {});
        setAction(uid, `🪙 Flipped **${fmt(amount)} Dinar** on **${side}** — watch the channel!`);
        const r = await runFlip({ guildId: gid, channel: interaction.channel, uid, name, amount, side });
        if (r && r.error) return interaction.editReply({ content: r.error, components: [] }).catch(() => {});
        return;
      }
      if (interaction.isButton() && interaction.customId === 'hub:streak') {
        return interaction.update({ ...streakView(gid, uid, name), files: [], attachments: [] });
      }

      // ── Help (paginated, mirrors /libyan-commands + a Hub page) ──
      if (interaction.isButton() && (interaction.customId === 'hub:help' || interaction.customId.startsWith('hub:help:'))) {
        const pages = helpPages();
        const parts = interaction.customId.split(':');
        let page = parts.length === 3 ? parseInt(parts[2], 10) : 0;
        if (!Number.isFinite(page) || page < 0) page = 0;
        if (page > pages.length - 1) page = pages.length - 1;
        return interaction.update({ embeds: [pages[page]], components: [helpRow(page, pages.length)], files: [], attachments: [] });
      }

      // ── Booster Perks (boosters only) ──
      if (interaction.isButton() && interaction.customId === 'hub:booster') {
        if (!isBoosting(interaction))
          return interaction.reply({ content: '⭐ This is a **booster perk** — boost the server to unlock free premium roles!', flags: 64 });
        const embed = new EmbedBuilder().setColor(0xf47fff).setTitle('⭐ Booster Perks')
          .setDescription(
            `Thank you for boosting! 💜 As a booster you get these **free** perks:\n\n` +
            `✨ **Holographic Role** — Discord's shimmering holographic style\n` +
            `🎨 **Custom Solid** — any colour you like, by hex code (e.g. \`#0fc0fc\`)\n` +
            `🌈 **Custom Gradient** — blend any two hex colours\n` +
            `🖼️ **Role Icon** — upload your own image, shown next to your name\n\n` +
            `Just name it — no Dinar needed. Your booster role stays as long as you keep boosting, and you can change it for free anytime.`);
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('boost:holo').setLabel('Holographic').setEmoji('✨').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('boost:solid').setLabel('Custom Solid (hex)').setEmoji('🎨').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('boost:grad').setLabel('Custom Gradient (hex)').setEmoji('🌈').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('boost:icon').setLabel('Role Icon').setEmoji('🖼️').setStyle(ButtonStyle.Primary));
        return interaction.update({ embeds: [embed], components: [row, backHubRow()], files: [], attachments: [] });
      }
      // holographic → just a name modal
      if (interaction.isButton() && interaction.customId === 'boost:holo') {
        if (!isBoosting(interaction)) return interaction.reply({ content: '⭐ Boosters only.', flags: 64 });
        const modal = new ModalBuilder().setCustomId('boost:name:holo').setTitle('✨ Holographic Role')
          .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('rolename').setLabel(`Role name (max ${NAME_MAX} chars)`)
              .setStyle(TextInputStyle.Short).setMaxLength(NAME_MAX).setMinLength(2).setRequired(true).setPlaceholder('e.g. Shining Star')));
        return interaction.showModal(modal);
      }
      // custom solid → name + one hex
      if (interaction.isButton() && interaction.customId === 'boost:solid') {
        if (!isBoosting(interaction)) return interaction.reply({ content: '⭐ Boosters only.', flags: 64 });
        const modal = new ModalBuilder().setCustomId('boost:name:solid').setTitle('🎨 Custom Solid Role')
          .addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('rolename').setLabel(`Role name (max ${NAME_MAX})`).setStyle(TextInputStyle.Short).setMaxLength(NAME_MAX).setMinLength(2).setRequired(true).setPlaceholder('e.g. Aqua Prince')),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('hex').setLabel('Colour hex (e.g. #0fc0fc)').setStyle(TextInputStyle.Short).setMaxLength(7).setMinLength(6).setRequired(true).setPlaceholder('#0fc0fc')));
        return interaction.showModal(modal);
      }
      // custom gradient → name + two hex
      if (interaction.isButton() && interaction.customId === 'boost:grad') {
        if (!isBoosting(interaction)) return interaction.reply({ content: '⭐ Boosters only.', flags: 64 });
        const modal = new ModalBuilder().setCustomId('boost:name:grad').setTitle('🌈 Custom Gradient Role')
          .addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('rolename').setLabel(`Role name (max ${NAME_MAX})`).setStyle(TextInputStyle.Short).setMaxLength(NAME_MAX).setMinLength(2).setRequired(true).setPlaceholder('e.g. Sunset Rider')),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('hexA').setLabel('First colour hex').setStyle(TextInputStyle.Short).setMaxLength(7).setMinLength(6).setRequired(true).setPlaceholder('#ff9a1a')),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('hexB').setLabel('Second colour hex').setStyle(TextInputStyle.Short).setMaxLength(7).setMinLength(6).setRequired(true).setPlaceholder('#e70013')));
        return interaction.showModal(modal);
      }
      // booster modal submitted → validate, grant free (booster-tied) role
      if (interaction.isModalSubmit() && interaction.customId.startsWith('boost:name:')) {
        if (!isBoosting(interaction))
          return interaction.reply({ content: '⭐ This perk is for boosters only.', flags: 64 });
        const btype = interaction.customId.split(':')[2];   // holo | solid | grad
        const rname = interaction.fields.getTextInputValue('rolename').trim();
        const problem = nameProblem(rname);
        if (problem) return interaction.reply({ content: `⚠️ ${problem}`, flags: 64 });

        let opts = { name: rname, booster: true };
        if (btype === 'holo') { opts.kind = 'holo'; }
        else if (btype === 'solid') {
          const hex = parseHex(interaction.fields.getTextInputValue('hex'));
          if (hex === null) return interaction.reply({ content: '⚠️ That colour hex isn\'t valid. Use a 6-digit hex like `#0fc0fc`.', flags: 64 });
          opts.kind = 'customSolid'; opts.hex = hex;
        } else {
          const hexA = parseHex(interaction.fields.getTextInputValue('hexA'));
          const hexB = parseHex(interaction.fields.getTextInputValue('hexB'));
          if (hexA === null || hexB === null) return interaction.reply({ content: '⚠️ One of those hex codes isn\'t valid. Use 6-digit hex like `#ff9a1a`.', flags: 64 });
          opts.kind = 'customGrad'; opts.hexA = hexA; opts.hexB = hexB;
        }

        await interaction.deferReply({ flags: 64 });
        const guild = interaction.guild;
        if (!guild.members.me.permissions.has('ManageRoles'))
          return interaction.editReply({ content: '⚠️ I need the **Manage Roles** permission to do this. Ask an admin to grant it.' });
        const member = await guild.members.fetch(uid);
        let res;
        try { res = await grantRole(guild, member, opts); }
        catch (e) {
          if (e.message === 'assign-failed')
            return interaction.editReply({ content: '⚠️ I made the role but couldn\'t assign it — my role needs to sit **above** the new role. Ask an admin to move my role higher.' });
          console.error('[booster grant]', e.message);
          return interaction.editReply({ content: '⚠️ Something went wrong creating your role. Please try again.' });
        }
        const styleName = btype === 'holo' ? 'holographic' : btype === 'solid' ? 'custom solid' : 'custom gradient';
        const fallbackLine = res.usedFallback ? `\n*(Premium styling wasn't available right now, so a solid colour was applied instead.)*` : '';
        setAction(uid, `✨ Got a free **${styleName}** booster role — **${esc(rname)}**.`);
        return interaction.editReply({ content: `✨ **${esc(rname)}** is yours — a free **${styleName}** booster role! <@&${res.role.id}> has been added.\n💜 It stays as long as you keep boosting. Change it anytime for free from \`/hub\` → Booster Perks.${fallbackLine}` });
      }

      // ── Role Icon (image upload) — free for boosters, otherwise costs Dinar ──
      if (interaction.isButton() && (interaction.customId === 'shop:icon' || interaction.customId === 'boost:icon')) {
        if (interaction.customId === 'boost:icon' && !isBoosting(interaction))
          return interaction.reply({ content: '⭐ Boosters only.', flags: 64 });
        return startIconFlow(interaction);
      }
      if (interaction.isButton() && interaction.customId === 'hub:iconCancel') {
        const sess = iconSessions.get(uid);
        if (sess) { sess.done = true; sess.collector.stop('cancel'); iconSessions.delete(uid); }
        const boosting = isBoosting(interaction);
        return interaction.update({ content: '', embeds: [hubEmbed(boosting, uid, gid)], components: hubComponents(boosting), files: [], attachments: [] });
      }

      if (interaction.isButton() && interaction.customId === 'hub:checkin') {
        const state = stateOf(gid);
        const res = doCheckIn(state, db, gid, saveData, uid, name, awardDinar, Date.now());
        if (res.already) {
          return interaction.reply({ content: `✅ You've already checked in today! Come back <t:${Math.round(res.nextAt / 1000)}:R>.`, flags: 64 });
        }
        // refresh the streak panel, and send a short private confirmation
        await interaction.update({ ...streakView(gid, uid, name), files: [], attachments: [] });
        const msg = res.wasReset
          ? `🔥 Fresh start! Day **1** of a new streak — **+${fmt(res.reward)} Dinar**.`
          : res.continues
            ? `🔥 Streak extended to **${res.count} days**! **+${fmt(res.reward)} Dinar**${res.reward >= STREAK_CAP ? ' (max reward!)' : ''}. Best: ${res.best}.`
            : `🔥 Day **1** — **+${fmt(res.reward)} Dinar**. Come back tomorrow!`;
        setAction(uid, `🔥 Checked in — ${res.wasReset ? 'started a new streak' : `day ${res.count}`} (+${fmt(res.reward)} Dinar).`);
        return interaction.followUp({ content: msg, flags: 64 }).catch(() => {});
      }

      // ═══════════════ CLAN HANDLERS ═══════════════
      if (interaction.isButton() && interaction.customId === 'hub:clan') {
        return interaction.update(clanEntryView(gid, uid));
      }
      // create clan → modal for name + description
      if (interaction.isButton() && interaction.customId === 'clan:create') {
        if (clans.userClan(db, gid, uid)) return interaction.reply({ content: 'You\'re already in a clan.', flags: 64 });
        if (getDinar(db, gid, uid) < clans.CLAN_CREATE_COST)
          return interaction.reply({ content: `💰 Creating a clan costs **${fmt(clans.CLAN_CREATE_COST)} Dinar** — you have **${fmt(getDinar(db, gid, uid))}**.`, flags: 64 });
        const modal = new ModalBuilder().setCustomId('clan:createModal').setTitle('🏰 Create a Clan')
          .addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('cname').setLabel('Clan name (2–30 chars)').setStyle(TextInputStyle.Short).setMinLength(2).setMaxLength(30).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('cdesc').setLabel('Description (optional)').setStyle(TextInputStyle.Paragraph).setMaxLength(300).setRequired(false)));
        return interaction.showModal(modal);
      }
      if (interaction.isModalSubmit() && interaction.customId === 'clan:createModal') {
        if (clans.userClan(db, gid, uid)) return interaction.reply({ content: 'You\'re already in a clan.', flags: 64 });
        if (getDinar(db, gid, uid) < clans.CLAN_CREATE_COST)
          return interaction.reply({ content: `💰 You no longer have enough Dinar.`, flags: 64 });
        const cname = interaction.fields.getTextInputValue('cname').trim();
        const cdesc = interaction.fields.getTextInputValue('cdesc');
        const problem = nameProblem(cname);
        if (problem) return interaction.reply({ content: `⚠️ ${problem}`, flags: 64 });
        await interaction.deferReply({ flags: 64 });
        const res = await clans.createClan(db, saveData, interaction.guild, uid, interaction.user.tag, cname, cdesc);
        if (res.error) return interaction.editReply({ content: `⚠️ ${res.error} No Dinar was taken.` });
        spendDinar(db, gid, uid, clans.CLAN_CREATE_COST, saveData);
        setAction(uid, `⚔️ Created the clan **${esc(res.name)}** (${fmt(clans.CLAN_CREATE_COST)} Dinar).`);
        return interaction.editReply({ content: `⚔️ **${esc(res.name)}** founded — you're the Leader! Paid **${fmt(clans.CLAN_CREATE_COST)} Dinar**. Open the Clan menu from \`/hub\` to manage it.` });
      }
      // join → pick a clan from a dropdown
      if (interaction.isButton() && interaction.customId === 'clan:joinList') {
        if (clans.userClan(db, gid, uid)) return interaction.reply({ content: 'You\'re already in a clan.', flags: 64 });
        const all = clans.clanEntries(db, gid);
        const names = Object.keys(all).slice(0, 25);
        if (!names.length) return interaction.reply({ content: 'There are no clans to join yet.', flags: 64 });
        const existing = clans.getRequest(db, gid, uid);
        const menu = new StringSelectMenuBuilder().setCustomId('clan:joinPick').setPlaceholder('Choose a clan to request…')
          .addOptions(names.map(n => ({ label: n.slice(0, 100), value: n, emoji: all[n].emoji || '⚔️', description: `${1 + (all[n].officers || []).length + (all[n].members || []).length} members` })));
        const note = existing ? `\n\n📤 You currently have a pending request to **${esc(existing.clanName)}** — picking another replaces it.` : '';
        return interaction.update({ content: `🤝 **Request to join a clan** — a Leader or Officer must approve you. You're only charged **${fmt(clans.CLAN_JOIN_COST)} Dinar** if accepted.${note}`, embeds: [], components: [new ActionRowBuilder().addComponents(menu), backHubOnly()], files: [], attachments: [] });
      }
      if (interaction.isStringSelectMenu() && interaction.customId === 'clan:joinPick') {
        if (clans.userClan(db, gid, uid)) return interaction.update(clanDashboard(gid, uid));
        const cname = interaction.values[0];
        const res = clans.requestJoin(db, saveData, gid, uid, cname);
        if (res.error) return interaction.update({ content: `⚠️ ${res.error}`, embeds: [], components: [backHubOnly()], files: [], attachments: [] });
        setAction(uid, `📤 Requested to join **${esc(cname)}**.`);
        // ping the clan channel so leaders/officers see it, if the clan has one
        const clan = db[gid][cname];
        if (clan && clan.channelId) {
          const ch = interaction.guild.channels.cache.get(clan.channelId);
          if (ch) ch.send({ content: `📥 <@${uid}> has requested to join **${esc(cname)}**! A Leader or Officer can approve via \`/hub\` → Clan → Join Requests.` }).catch(() => {});
        }
        const msg = res.replaced && !res.sameClan ? ` (replaced your request to ${esc(res.replaced)})` : '';
        return interaction.update({ content: `📤 Request sent to **${esc(cname)}**${msg}! You'll be added — and charged **${fmt(clans.CLAN_JOIN_COST)} Dinar** — once a Leader or Officer accepts. No charge if declined.`, embeds: [], components: [backHubOnly()], files: [], attachments: [] });
      }
      // dashboard sub-views
      if (interaction.isButton() && interaction.customId === 'clan:members') return interaction.update(clanMembersView(gid, uid));
      if (interaction.isButton() && interaction.customId === 'clan:settings') return interaction.update(clanSettingsView(gid, uid));
      if (interaction.isButton() && interaction.customId === 'clan:manage')   return interaction.update(clanManageView(gid, uid));
      if (interaction.isButton() && interaction.customId === 'clan:requests')  return interaction.update(clanRequestsView(gid, uid));

      // accept / decline a join request
      if (interaction.isButton() && interaction.customId.startsWith('clan:reqAccept:')) {
        const requesterId = interaction.customId.split(':')[2];
        await interaction.deferUpdate();
        const res = await clans.acceptRequest(db, saveData, interaction.guild, uid, requesterId, clans.CLAN_JOIN_COST, getDinar, spendDinar);
        if (res.error) return interaction.editReply(Object.assign(clanRequestsView(gid, uid), { content: `⚠️ ${res.error}` }));
        setAction(uid, `✅ Accepted <@${requesterId}> into the clan.`);
        // public ping in the clan channel (or current channel as fallback)
        const clan = db[gid][res.clanName];
        const pingCh = (clan && clan.channelId && interaction.guild.channels.cache.get(clan.channelId)) || interaction.channel;
        if (pingCh) pingCh.send({ content: `🎉 <@${requesterId}> has been accepted into **${esc(res.clanName)}**! Welcome!`, allowedMentions: { users: [requesterId] } }).catch(() => {});
        return interaction.editReply(clanRequestsView(gid, uid));
      }
      if (interaction.isButton() && interaction.customId.startsWith('clan:reqDecline:')) {
        const requesterId = interaction.customId.split(':')[2];
        await interaction.deferUpdate();
        const res = clans.declineRequest(db, saveData, interaction.guild, uid, requesterId);
        if (res.error) return interaction.editReply(Object.assign(clanRequestsView(gid, uid), { content: `⚠️ ${res.error}` }));
        setAction(uid, `❌ Declined <@${requesterId}>'s join request.`);
        const clan = db[gid][res.clanName];
        const pingCh = (clan && clan.channelId && interaction.guild.channels.cache.get(clan.channelId)) || interaction.channel;
        if (pingCh) pingCh.send({ content: `<@${requesterId}>, your request to join **${esc(res.clanName)}** was declined. No Dinar was charged.`, allowedMentions: { users: [requesterId] } }).catch(() => {});
        return interaction.editReply(clanRequestsView(gid, uid));
      }

      // manage actions → user picker carrying the action
      if (interaction.isButton() && interaction.customId.startsWith('clan:act:')) {
        const action = interaction.customId.split(':')[2];   // kick|promote|demote|transfer
        const mine = clans.userClan(db, gid, uid);
        if (!mine) return interaction.update(clanEntryView(gid, uid));
        const menu = new UserSelectMenuBuilder().setCustomId(`clan:actPick:${action}`).setPlaceholder(`Pick a member to ${action}…`);
        return interaction.update({ content: `🛡️ Choose who to **${action}**.`, embeds: [], components: [new ActionRowBuilder().addComponents(menu), new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('clan:manage').setLabel('← Back').setStyle(ButtonStyle.Secondary))], files: [], attachments: [] });
      }
      if (interaction.isUserSelectMenu() && interaction.customId.startsWith('clan:actPick:')) {
        const action = interaction.customId.split(':')[2];
        const target = interaction.users.first();
        if (!target) return interaction.reply({ content: 'Pick a member.', flags: 64 });
        await interaction.deferUpdate();
        let res;
        if (action === 'kick') res = await clans.kickMember(db, saveData, interaction.guild, uid, target.id, target.username);
        else if (action === 'promote') res = await clans.promoteMember(db, saveData, interaction.guild, uid, target.id, target.username);
        else if (action === 'demote') res = await clans.demoteMember(db, saveData, interaction.guild, uid, target.id, target.username);
        else if (action === 'transfer') res = await clans.transferLeader(db, saveData, interaction.guild, uid, target.id, target.username);
        if (res.error) return interaction.editReply(Object.assign(clanManageView(gid, uid), { content: `⚠️ ${res.error}` }));
        const verb = { kick: 'Kicked', promote: 'Promoted', demote: 'Demoted', transfer: 'Transferred leadership to' }[action];
        setAction(uid, `🛡️ ${verb} <@${target.id}> in the clan.`);
        return interaction.editReply(Object.assign(clanDashboard(gid, uid), { content: `✅ ${verb} <@${target.id}>.` }));
      }

      // settings edits
      if (interaction.isButton() && (interaction.customId === 'clan:setDesc' || interaction.customId === 'clan:setMotto')) {
        const isMotto = interaction.customId === 'clan:setMotto';
        const modal = new ModalBuilder().setCustomId(isMotto ? 'clan:mottoModal' : 'clan:descModal').setTitle(isMotto ? 'Edit Motto' : 'Edit Description')
          .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('val').setLabel(isMotto ? 'Motto (max 100)' : 'Description (max 300)').setStyle(TextInputStyle.Paragraph).setMaxLength(isMotto ? 100 : 300).setRequired(true)));
        return interaction.showModal(modal);
      }
      if (interaction.isModalSubmit() && (interaction.customId === 'clan:descModal' || interaction.customId === 'clan:mottoModal')) {
        const field = interaction.customId === 'clan:mottoModal' ? 'motto' : 'description';
        const val = interaction.fields.getTextInputValue('val');
        const res = clans.setText(db, saveData, gid, uid, field, val);
        if (res.error) return interaction.reply({ content: `⚠️ ${res.error}`, flags: 64 });
        setAction(uid, `⚙️ Updated clan ${field}.`);
        return interaction.update(clanSettingsView(gid, uid));
      }
      // rename
      if (interaction.isButton() && interaction.customId === 'clan:rename') {
        const mine = clans.userClan(db, gid, uid);
        if (!mine || mine.clan.leader !== uid) return interaction.reply({ content: 'Only the Leader can rename.', flags: 64 });
        const modal = new ModalBuilder().setCustomId('clan:renameModal').setTitle('Rename Clan')
          .addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('rn').setLabel('New clan name (2–30)').setStyle(TextInputStyle.Short).setMinLength(2).setMaxLength(30).setRequired(true).setValue(mine.name.slice(0, 30))),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('re').setLabel('New emoji (optional)').setStyle(TextInputStyle.Short).setMaxLength(8).setRequired(false)));
        return interaction.showModal(modal);
      }
      if (interaction.isModalSubmit() && interaction.customId === 'clan:renameModal') {
        const rn = interaction.fields.getTextInputValue('rn').trim();
        const re = interaction.fields.getTextInputValue('re');
        const problem = nameProblem(rn);
        if (problem) return interaction.reply({ content: `⚠️ ${problem}`, flags: 64 });
        await interaction.deferUpdate();
        const res = await clans.renameClan(db, saveData, interaction.guild, uid, rn, re);
        if (res.error) return interaction.editReply(Object.assign(clanSettingsView(gid, uid), { content: `⚠️ ${res.error}` }));
        setAction(uid, `✏️ Renamed clan to **${esc(res.name)}**.`);
        return interaction.editReply(clanSettingsView(gid, uid));
      }
      // channel create / view / delete
      if (interaction.isButton() && interaction.customId === 'clan:channel') {
        const mine = clans.userClan(db, gid, uid);
        if (!mine || mine.clan.leader !== uid) return interaction.reply({ content: 'Only the Leader can manage the channel.', flags: 64 });
        if (mine.clan.channelId) {
          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('clan:channelDelete').setLabel('Delete Channel').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId('hub:clan').setLabel('← Back to Clan').setStyle(ButtonStyle.Secondary));
          return interaction.update({ content: `📢 Your clan channel: <#${mine.clan.channelId}>`, embeds: [], components: [row], files: [], attachments: [] });
        }
        if (getDinar(db, gid, uid) < clans.CLAN_CHANNEL_COST)
          return interaction.reply({ content: `💰 A clan channel costs **${fmt(clans.CLAN_CHANNEL_COST)} Dinar** — you have **${fmt(getDinar(db, gid, uid))}**.`, flags: 64 });
        await interaction.deferUpdate();
        const res = await clans.createChannel(db, saveData, interaction.guild, client, uid);
        if (res.error) return interaction.editReply(Object.assign(clanDashboard(gid, uid), { content: `⚠️ ${res.error} No Dinar taken.` }));
        spendDinar(db, gid, uid, clans.CLAN_CHANNEL_COST, saveData);
        setAction(uid, `📢 Created a clan channel (${fmt(clans.CLAN_CHANNEL_COST)} Dinar).`);
        return interaction.editReply(Object.assign(clanDashboard(gid, uid), { content: `✅ Channel ${res.channel} created! Paid **${fmt(clans.CLAN_CHANNEL_COST)} Dinar**.` }));
      }
      if (interaction.isButton() && interaction.customId === 'clan:channelDelete') {
        await interaction.deferUpdate();
        const res = await clans.deleteChannel(db, saveData, interaction.guild, uid);
        if (res.error) return interaction.editReply(Object.assign(clanDashboard(gid, uid), { content: `⚠️ ${res.error}` }));
        setAction(uid, `🗑️ Deleted the clan channel.`);
        return interaction.editReply({ content: '✅ Clan channel deleted.', ...clanDashboard(gid, uid) });
      }
      // leave / disband
      if (interaction.isButton() && interaction.customId === 'clan:leave') {
        await interaction.deferUpdate();
        const res = await clans.leaveClan(db, saveData, interaction.guild, uid);
        if (res.error) return interaction.editReply(Object.assign(clanDashboard(gid, uid), { content: `⚠️ ${res.error}` }));
        setAction(uid, `🚪 Left the clan **${esc(res.name)}**.`);
        return interaction.editReply(Object.assign(clanEntryView(gid, uid), { content: `👋 You left **${esc(res.name)}**.` }));
      }
      if (interaction.isButton() && interaction.customId === 'clan:disband') {
        const mine = clans.userClan(db, gid, uid);
        if (!mine || mine.clan.leader !== uid) return interaction.reply({ content: 'Only the Leader can disband.', flags: 64 });
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('clan:disbandYes').setLabel('Yes, disband').setEmoji('💥').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId('hub:clan').setLabel('Cancel').setStyle(ButtonStyle.Secondary));
        return interaction.update({ content: `⚠️ **Disband ${esc(mine.name)}?** This deletes the clan, its roles and channel. This can't be undone.`, embeds: [], components: [row], files: [], attachments: [] });
      }
      if (interaction.isButton() && interaction.customId === 'clan:disbandYes') {
        await interaction.deferUpdate();
        const res = await clans.disbandClan(db, saveData, interaction.guild, uid);
        if (res.error) return interaction.editReply(Object.assign(clanDashboard(gid, uid), { content: `⚠️ ${res.error}` }));
        setAction(uid, `💥 Disbanded the clan **${esc(res.name)}**.`);
        return interaction.editReply(Object.assign(clanEntryView(gid, uid), { content: `💥 **${esc(res.name)}** has been disbanded.` }));
      }

      // ── roles: choose colour category ──
      if (interaction.isButton() && interaction.customId === 'shop:solid') {
        return interaction.update({ content: `🎨 **Custom Solid Role** — **${fmt(PRICE_SOLID)} Dinar**. Pick a colour from either list, then you'll name it.\n⏳ *Lasts 1 month.*`, embeds: [], files: [], attachments: [], components: [solidSelectBright(), solidSelectSoft(), backRolesRow()] });
      }
      if (interaction.isButton() && interaction.customId === 'shop:grad') {
        return interaction.update({ content: `🌈 **Gradient Role** — **${fmt(PRICE_GRADIENT)} Dinar**. Pick your combo, then you'll name it.\n⏳ *Lasts 1 month.*`, embeds: [], files: [], attachments: [], components: [gradSelect(), backRolesRow()] });
      }

      // colour picked → preview + "name & buy" + a BACK button to pick another
      if (interaction.isStringSelectMenu() && interaction.customId.startsWith('shop:pickSolid')) {
        const c = solidByKey(interaction.values[0]); if (!c) return;
        const png = renderSwatch(choicePreview({ name: '', solid: c }));
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`shop:buy:solid:${c.key}`).setLabel(`Name it & buy — ${fmt(PRICE_SOLID)}`).setEmoji('🎨').setStyle(ButtonStyle.Success));
        return interaction.update({ content: `Selected **${c.name}**. Name it & buy, or go back to pick another.\n⏳ *Lasts 1 month.*`,
          embeds: [], files: [new AttachmentBuilder(png, { name: 'preview.png' })], attachments: [], components: [row, backSolidRow()] });
      }
      if (interaction.isStringSelectMenu() && interaction.customId === 'shop:pickGrad') {
        const g = gradByKey(interaction.values[0]); if (!g) return;
        const png = renderSwatch(choicePreview({ name: '', grad: g }));
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`shop:buy:grad:${g.key}`).setLabel(`Name it & buy — ${fmt(PRICE_GRADIENT)}`).setEmoji('🌈').setStyle(ButtonStyle.Success));
        return interaction.update({ content: `Selected **${g.name}**. Name it & buy, or go back to pick another.\n⏳ *Lasts 1 month.*`,
          embeds: [], files: [new AttachmentBuilder(png, { name: 'preview.png' })], attachments: [], components: [row, backGradRow()] });
      }

      // "name it & buy" → open the modal
      if (interaction.isButton() && interaction.customId.startsWith('shop:buy:')) {
        const [, , kind, choiceKey] = interaction.customId.split(':');
        return interaction.showModal(nameModal(kind, choiceKey));
      }

      // modal submitted → validate, charge, grant
      if (interaction.isModalSubmit() && interaction.customId.startsWith('shop:name:')) {
        const [, , kind, choiceKey] = interaction.customId.split(':');
        const rname = interaction.fields.getTextInputValue('rolename').trim();
        const problem = nameProblem(rname);
        if (problem) return interaction.reply({ content: `⚠️ ${problem}`, flags: 64 });
        const price = (kind === 'gradient' || kind === 'grad') ? PRICE_GRADIENT : PRICE_SOLID;
        const bal = getDinar(db, gid, uid);
        if (bal < price) return interaction.reply({ content: `💰 You need **${fmt(price)} Dinar** but only have **${fmt(bal)}**. Earn more and come back!`, flags: 64 });

        const solid = kind === 'solid' ? solidByKey(choiceKey) : null;
        const grad  = (kind === 'grad' || kind === 'gradient') ? gradByKey(choiceKey) : null;
        if (kind === 'solid' && !solid) return interaction.reply({ content: 'That colour is no longer available.', flags: 64 });
        if ((kind === 'grad' || kind === 'gradient') && !grad) return interaction.reply({ content: 'That gradient is no longer available.', flags: 64 });

        await interaction.deferReply({ flags: 64 });
        const guild = interaction.guild;
        const me = guild.members.me;
        if (!me.permissions.has('ManageRoles'))
          return interaction.editReply({ content: '⚠️ I need the **Manage Roles** permission to do this. Ask an admin to grant it.' });

        const member = await guild.members.fetch(uid);
        let res;
        try {
          res = await grantRole(guild, member, { kind: (kind === 'grad' ? 'gradient' : kind), name: rname, solid, grad });
        } catch (e) {
          if (e.message === 'assign-failed')
            return interaction.editReply({ content: '⚠️ I made the role but couldn\'t assign it — my role needs to sit **above** the new role. Ask an admin to move my role higher, then try again.' });
          console.error('[shop grant]', e.message);
          return interaction.editReply({ content: '⚠️ Something went wrong creating your role. No Dinar was taken — please try again.' });
        }
        spendDinar(db, gid, uid, price, saveData);
        const newBal = getDinar(db, gid, uid);
        const styleLine = res.usedFallback
          ? `\n*(Gradient styling wasn't available right now, so it was applied as a solid colour — it'll upgrade automatically next time you re-buy while boosts are active.)*`
          : '';
        setAction(uid, `🎨 Bought a ${kind === 'solid' ? 'solid' : 'gradient'} role — **${esc(rname)}** (${fmt(price)} Dinar).`);
        return interaction.editReply({
          content: `✅ **${esc(rname)}** is yours! <@&${res.role.id}> has been added to you.\n💰 Paid **${fmt(price)} Dinar** — new balance **${fmt(newBal)}**.\n⏳ **This role expires <t:${Math.round(res.expiresAt / 1000)}:R>** (in 1 month). Open \`/hub\` anytime to refresh or change it.${styleLine}` });
      }
    } catch (e) { console.error('[hub interaction]', e.message); }
  });

  return { _test: {
    stateOf: () => stateOf, grantRole, sweep, nameProblem, paletteSwatch, choicePreview,
    renderSwatch, SOLID_COLORS, SOLID_BRIGHT, SOLID_SOFT, GRADIENTS, solidByKey, gradByKey,
    PRICE_SOLID, PRICE_GRADIENT, ROLE_LIFETIME_MS, ICON_PRICE, fetchIconBuffer, startIconFlow, iconSessions,
    doCheckIn, streakStatus, streakLeaderboard, streakReward, streakView, libyaDayNumber, parseHex, helpPages, helpRow,
  } };
}

module.exports = { getShopCommands, initShop };
