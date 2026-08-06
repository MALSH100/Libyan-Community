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
  TextInputBuilder, TextInputStyle, UserSelectMenuBuilder, PermissionFlagsBits,
} = require('discord.js');
const path = require('path');
const fs = require('fs');
const { Resvg } = require('@resvg/resvg-js');
const { getDinar, spendDinar, awardDinar } = require('./gacha');
const coins = require('./coinskins');
const clans = require('./clanfns');

// Determine an image's true MIME type from its magic bytes (file signature), because
// filenames and Discord content-types are unreliable — a PNG is often served as ".webp".
// resvg renders by the data-URI MIME, so a wrong label produces a blank image. Returns
// one of image/png|jpeg|gif|webp, or null if it's not a supported image.
function sniffImageMime(buf) {
  if (!buf || buf.length < 12) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  // JPEG: FF D8 FF
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  // GIF: "GIF87a" / "GIF89a"
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  // WEBP: "RIFF" .... "WEBP"
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

// Convert a WEBP image buffer to a PNG buffer, because resvg cannot render WEBP.
// Uses `sharp` if it's installed; if not, returns null and the caller asks the user to
// re-upload as PNG/JPG. (Adding `sharp` to package.json enables automatic conversion.)
let _sharp; let _sharpTried = false;
async function webpToPng(buf) {
  if (!_sharpTried) { _sharpTried = true; try { _sharp = require('sharp'); } catch { _sharp = null; console.warn('[profile] sharp not installed — WEBP uploads will be rejected. Add "sharp" to package.json to auto-convert them.'); } }
  if (!_sharp) return null;
  try { return await _sharp(buf).png().toBuffer(); }
  catch (e) { console.error('[profile] webp→png conversion failed:', e.message); return null; }
}

// Channel where clan join-request alerts (new request / accepted / declined) are posted,
// and where leaders/officers get pinged. Set to null to disable the dedicated alerts channel.
const CLAN_ALERTS_CHANNEL_ID = '908343919287341096';

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

// Work out where a bot-created custom role should sit so mods can still moderate the
// people who own it. Discord rule: you can only action a member whose HIGHEST role is
// BELOW your own highest role. So custom roles must sit below the mod role, not just
// below the bot. We find the lowest-positioned role that carries a moderation
// permission (ModerateMembers / KickMembers / BanMembers / ManageRoles, but NOT the
// bot's own role) and place the custom role just beneath it. Falls back to just-under-
// the-bot only if no such role exists.
//
// `db[gid].__shop.modRoleId` (set via /hub-mod-role) overrides auto-detection if present.
// `guild.members.me` is only populated from cache and comes back NULL if the bot's own
// member object hasn't been cached yet (common right after a restart, or in a guild the
// bot hasn't interacted with). Dereferencing it then throws
// "Cannot read properties of null (reading 'permissions')" — which, once an interaction
// has been deferred, leaves the user staring at "thinking..." until Discord times out.
// Always resolve through this instead, which fetches the member when the cache is empty.
async function resolveMe(guild) {
  try {
    return guild.members.me || await guild.members.fetchMe();
  } catch {
    try { return await guild.members.fetch(guild.client.user.id); } catch { return null; }
  }
}

function customRoleTargetPosition(guild, db) {
  const me = guild.members.me;
  const botTop = me ? me.roles.highest.position : 1;
  let ceiling = botTop; // never at/above the bot (it must stay able to manage the role)

  // explicit override
  let lowestModPos = null;
  const overrideId = db && db[guild.id] && db[guild.id].__shop && db[guild.id].__shop.modRoleId;
  if (overrideId) {
    const r = guild.roles.cache.get(overrideId);
    if (r) lowestModPos = r.position;
  }

  if (lowestModPos == null) {
    // auto-detect: lowest role (above @everyone) that can moderate, excluding the bot's own managed role
    const modPerms = ['ModerateMembers', 'KickMembers', 'BanMembers', 'ManageRoles', 'Administrator'];
    for (const role of guild.roles.cache.values()) {
      if (role.id === guild.id) continue;                       // @everyone
      if (me && role.id === me.roles.highest.id) continue;      // the bot's top role
      if (role.managed && me && role.members && role.members.has(me.id)) continue; // bot integration roles
      const canMod = modPerms.some(p => { try { return role.permissions.has(p); } catch { return false; } });
      if (!canMod) continue;
      if (lowestModPos == null || role.position < lowestModPos) lowestModPos = role.position;
    }
  }

  // We want to sit BELOW the mod role. Target = one under the lowest mod role, but still
  // under the bot. If no mod role found, fall back to just under the bot (old behaviour).
  let target;
  if (lowestModPos != null) target = Math.min(ceiling - 1, lowestModPos - 1);
  else                      target = ceiling - 1;
  return Math.max(1, target);
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
    new SlashCommandBuilder()
      .setName('profile')
      .setDescription('Show your profile card (or someone else\'s)')
      .addUserOption(o => o.setName('user').setDescription('Whose profile to show (defaults to you)').setRequired(false))
      .toJSON(),
    new SlashCommandBuilder()
      .setName('profile-image')
      .setDescription('Add an image or GIF to your profile card — works in any channel')
      .addAttachmentOption(o => o.setName('image')
        .setDescription('PNG, JPG, GIF or WEBP (max 8MB)')
        .setRequired(true))
      .toJSON(),
    new SlashCommandBuilder()
      .setName('role-icon')
      .setDescription('Set your custom role\'s icon — works in any channel')
      .addAttachmentOption(o => o.setName('image')
        .setDescription('Square PNG or JPG works best')
        .setRequired(true))
      .toJSON(),
    new SlashCommandBuilder()
      .setName('coin-image')
      .setDescription('Boosters: set your custom coin face — works in any channel')
      .addAttachmentOption(o => o.setName('image')
        .setDescription('PNG or JPG')
        .setRequired(true))
      .toJSON(),
    new SlashCommandBuilder()
      .setName('hub-panel')
      .setDescription('Post the permanent Hub board in this channel (admin only)')
      .setDefaultMemberPermissions(0)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('hub-channel')
      .setDescription('Set this channel as the Hub home — shown to new members (admin only)')
      .setDefaultMemberPermissions(0)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('hub-mod-role')
      .setDescription('Set the moderator role — bot-made custom roles will always sit below it (admin only)')
      .addRoleOption(o => o.setName('role').setDescription('Your moderator role (custom roles go below this). Leave empty to auto-detect.').setRequired(false))
      .setDefaultMemberPermissions(0)   // admins only (Manage Server / Administrator via 0 = no default, admin override)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('topprofiles')
      .setDescription('See the most-hearted profiles — and how to get yours on the board')
      .toJSON(),
  ];
}

function initShop({ client, db, saveData, runFlip, warApi, gachaApi, exchangeView, profileApi }) {
  const stateOf = (gid) => shopState(db, gid);

  // Post a clan alert. Prefers the dedicated alerts channel; falls back to the clan's own
  // channel, then the interaction channel. `pingIds` are mentioned (leaders/officers or requester).
  async function clanAlert(guild, clan, content, pingIds, fallbackChannel) {
    let channel = null;
    if (CLAN_ALERTS_CHANNEL_ID) {
      channel = guild.channels.cache.get(CLAN_ALERTS_CHANNEL_ID)
        || await guild.channels.fetch(CLAN_ALERTS_CHANNEL_ID).catch(() => null);
    }
    if (!channel && clan && clan.channelId) channel = guild.channels.cache.get(clan.channelId) || null;
    if (!channel) channel = fallbackChannel || null;
    if (!channel || typeof channel.send !== 'function') return;
    await channel.send({
      content,
      allowedMentions: { users: (pingIds || []).slice(0, 20) },
    }).catch((e) => console.error('[clan alert] send failed:', e.message));
  }

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
    // Position the role BELOW the mod role so moderators can still punish people who own
    // it (Discord only lets you action members whose highest role is below yours). Falls
    // back to just-under-the-bot if no mod role can be identified.
    try {
      const target = customRoleTargetPosition(guild, db);
      await role.setPosition(target).catch(() => {});
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
      // custom coins are a booster perk — remove them if the owner stops boosting
      const cs = db[gid] && db[gid].__coinskins;
      if (cs && cs.custom) {
        for (const uid of Object.keys(cs.custom)) {
          const member = guild.members.cache.get(uid) || await guild.members.fetch(uid).catch(() => null);
          if (!member || !member.premiumSince) { coins.clearCustomImage(db, gid, uid, saveData); changed = true; }
        }
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
        `⭐ **Boosters Only** — ${isBooster ? '**unlocked!** free holographic & custom-hex roles' : '_boost the server to unlock free premium roles_'}\n` +
        `⚔️ **Clan** — ${inClan ? `manage **${esc(inClan.name)}**` : `create or join a clan (from **${fmt(clans.CLAN_CREATE_COST)} Dinar**)`}\n` +
        `🃏 **Collection** — your cards, daily Dinar, leaderboards & wishlist\n` +
        `💱 **Exchange Rate** — latest Libyan black-market currency rates\n` +
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
    new ButtonBuilder().setCustomId('hub:booster').setLabel(isBooster ? 'Boosters Only' : 'Boosters Only (boost to unlock)').setEmoji('⭐').setStyle(ButtonStyle.Secondary).setDisabled(!isBooster),
    new ButtonBuilder().setCustomId('hub:help').setLabel('Help').setEmoji('❓').setStyle(ButtonStyle.Secondary));
  const hubRow2 = () => new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('hub:clan').setLabel('Clan').setEmoji('⚔️').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('hub:collection').setLabel('Collection').setEmoji('🃏').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('hub:exchange').setLabel('Exchange Rate').setEmoji('💱').setStyle(ButtonStyle.Secondary).setDisabled(!exchangeView));
  const hubRow3 = () => new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('hub:profile').setLabel('My Profile').setEmoji('🪪').setStyle(ButtonStyle.Primary).setDisabled(!profileApi),
    new ButtonBuilder().setCustomId('hub:showcase:0').setLabel('Profile Showcase').setEmoji('❤️').setStyle(ButtonStyle.Secondary).setDisabled(!profileApi));
  const hubComponents = (isBooster) => profileApi ? [hubRow(isBooster), hubRow2(), hubRow3()] : [hubRow(isBooster), hubRow2()];

  /* The Shop landing view, shared by the in-hub button and the public board so
     both always show the same thing. */
  function shopEntryView() {
    const embed = new EmbedBuilder().setColor(0xE7B41A).setTitle('🛒 The Shop')
      .setDescription(`Spend your Dinar 💰\n\n🎨 **Custom Roles** — a personalised colour or gradient role, plus your own 🖼️ image icon\n🪙 **Coin Designs** — reskin your coin flip with themed coins`);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('hub:roles').setLabel('Custom Roles').setEmoji('🎨').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('hub:coins').setLabel('Coin Designs').setEmoji('🪙').setStyle(ButtonStyle.Success));
    return { embeds: [embed], components: [row] };
  }

  /* Lets the shared (public) flip engine play out inside a private reply.
     runFlip() posts a spinning-coin message and then edits it to the result, so
     it needs something channel-shaped. This stands in for one: send() creates an
     ephemeral follow-up, and the object it hands back edits that same follow-up,
     so the whole animation happens where only the player can see it. The flip
     engine itself is untouched — /dinar-flip stays public as before. */
  function ephemeralFlipChannel(interaction) {
    return {
      send: async (payload) => {
        const m = await interaction.followUp({ ...payload, flags: 64 });
        return {
          id: m.id,
          edit: async (p) => {
            try { return await interaction.webhook.editMessage(m.id, p); }
            catch { try { return await m.edit(p); } catch { return m; } }
          },
          delete: async () => {},
        };
      },
    };
  }

  /* ── the permanent Hub board ──────────────────────────────────────────────
     A public, pinned message that never expires. Its buttons live in their own
     `hubp:` namespace because every one of them must REPLY privately — the
     existing `hub:` buttons call interaction.update(), which on a shared message
     would rewrite the board for everybody at once. Each click here opens the
     clicker's own ephemeral hub, so any number of people can use the same board
     and the channel stays clean.
     Deliberately static: no live figures, so it never needs re-editing and costs
     nothing to keep sitting there.                                              */
  function hubPanelMessage() {
    const embed = new EmbedBuilder()
      .setColor(0xE7B41A)
      .setTitle('🏛️  Community Hub')
      .setDescription(
        'Everything the server has to offer, in one place. **Tap a button below** — '
        + 'whatever you open is private and only visible to you.\n\u200b')
      .addFields(
        { name: '🪪  Profile Cards', value: 'Design your own card with colours, borders, images and live stats.', inline: false },
        { name: '🎨  Custom Roles & Coins', value: 'Spend Dinar on your own colour role, an image icon, or a themed coin.', inline: false },
        { name: '🔥  Daily Streak', value: 'Check in each day to build a streak and earn Dinar.', inline: false },
        { name: '⚔️  Clans', value: 'Create or join a clan, level it up and go to war.', inline: false },
      )
      .setFooter({ text: 'New here? Start with "Open the Hub" — everything is free to look at.' });

    const rows = [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('hubp:open').setLabel('Open the Hub').setEmoji('🏛️').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('hubp:profile').setLabel('My Profile Card').setEmoji('🪪').setStyle(ButtonStyle.Success).setDisabled(!profileApi),
        new ButtonBuilder().setCustomId('hubp:streak').setLabel('Daily Check-in').setEmoji('🔥').setStyle(ButtonStyle.Success)),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('hubp:shop').setLabel('Shop').setEmoji('🛒').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('hubp:clan').setLabel('Clans').setEmoji('⚔️').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('hubp:help').setLabel('How it works').setEmoji('❓').setStyle(ButtonStyle.Secondary)),
    ];
    return { embeds: [embed], components: rows };
  }
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
        `**Easiest way:** run **\`/role-icon\`** and attach your image — that works in every channel, even ones where you can't type.\n\n` +
        `Or send your icon **as an image message here** within **60 seconds** and I'll grab it.\n\n` +
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

  // ── Booster Custom Coin: upload an image → becomes your coin's heads/tails faces ──
  const coinSessions = new Map();
  const coinRetryRow = () => new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('boost:coin').setLabel('Try Again').setEmoji('🪙').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('hub:home').setLabel('← Back to Hub').setStyle(ButtonStyle.Secondary));

  // fetch an uploaded image for the coin face (larger allowance than a role icon; we render it big)
  async function fetchCoinBuffer(att) {
    if (typeof fetch !== 'function') return { error: 'Image fetching isn\'t available on this host right now.' };
    const ct = (att.contentType || '').toLowerCase();
    if (!/^image\/(png|jpe?g|webp)/.test(ct)) return { error: 'Please upload a **PNG or JPG** image.' };
    const base = att.proxyURL || att.url;
    const sep = base.includes('?') ? '&' : '?';
    const candidates = [`${base}${sep}width=400&height=400`, `${base}${sep}width=256&height=256`, att.url];
    for (const u of candidates) {
      try {
        const res = await fetch(u);
        if (!res || !res.ok) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 0 && buf.length <= 3 * 1024 * 1024) return { buf, mime: ct.startsWith('image/jp') ? 'image/jpeg' : 'image/png' };
      } catch { /* next */ }
    }
    return { error: 'I couldn\'t fetch that image (must be a PNG/JPG under 3MB). Try a smaller, square image.' };
  }

  async function startCoinFlow(interaction) {
    const gid = interaction.guildId, uid = interaction.user.id;
    const backRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('hub:home').setLabel('← Back to Hub').setStyle(ButtonStyle.Secondary));
    if (!isBoosting(interaction)) {
      return interaction.reply({ content: '⭐ Custom coins are a booster-only perk.', flags: 64 });
    }
    const prev = coinSessions.get(uid);
    if (prev) { prev.done = true; prev.collector.stop('replaced'); }

    const has = coins.getCustomImage(db, gid, uid);
    const embed = new EmbedBuilder().setColor(0xE6B840).setTitle('🪙 Custom Coin — upload your image')
      .setDescription(
        `**Easiest way:** run **\`/coin-image\`** and attach your picture — that works in every channel, even ones where you can't type.\n\n` +
        `Or send an image **as a message here** within **60 seconds** and it becomes your coin.\n\n` +
        `• Square **PNG or JPG** works best (it fills the coin face)\n` +
        `• **HEADS** / **TAILS** text is added on top automatically\n` +
        `• The spin animation stays the same — your image shows when the coin lands\n` +
        `• ⭐ **Free** booster perk${has ? '\n• This replaces your current custom coin' : ''}\n` +
        `• Lasts while you keep boosting`);
    const cancelRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('hub:coinCancel').setLabel('Cancel').setStyle(ButtonStyle.Danger));
    await interaction.update({ content: '', embeds: [embed], components: [cancelRow], files: [], attachments: [] });

    const collector = interaction.channel.createMessageCollector({
      filter: (m) => m.author.id === uid && m.attachments.size > 0, time: 60_000, max: 1 });
    const sess = { collector, done: false };
    coinSessions.set(uid, sess);

    collector.on('collect', async (m) => {
      if (sess.done) return;
      sess.done = true; coinSessions.delete(uid);
      const finish = (color, text, files, attachments) => interaction.editReply({ content: '', embeds: [new EmbedBuilder().setColor(color).setTitle('🪙 Custom Coin').setDescription(text)], components: [coinRetryRow()], files: files || [], attachments: attachments || [] }).catch(() => {});
      const got = await fetchCoinBuffer(m.attachments.first());
      if (got.error) return finish(0xE74C3C, `⚠️ ${got.error}\nNothing changed — hit **Try Again**.`);
      let previewPng;
      try {
        // store it, then render a heads preview to confirm
        coins.setCustomImage(db, gid, uid, got.buf.toString('base64'), got.mime, saveData);
        previewPng = coins.renderCustomFace(got.buf, got.mime, 'heads');
      } catch (e) {
        console.error('[hub coin]', e.message);
        return finish(0xE74C3C, '⚠️ I couldn\'t process that image. Try a different PNG/JPG.');
      }
      m.delete().catch(() => {});
      setAction(uid, `🪙 Set a custom coin design (booster perk).`);
      const prev = new AttachmentBuilder(previewPng, { name: 'coin-preview.png' });
      return finish(0x2ECC71,
        `✅ Your custom coin is set and equipped! Here's how **heads** will look — **tails** uses the same image.\nIt'll show whenever you win or lose a coin flip. ⭐ Free booster perk.\n*Switch back anytime from Shop → Coin Designs.*`,
        [prev]);
    });
    collector.on('end', (_c, reason) => {
      if (sess.done || reason === 'cancel' || reason === 'replaced' || reason === 'limit') return;
      sess.done = true; coinSessions.delete(uid);
      interaction.editReply({ content: '', embeds: [new EmbedBuilder().setColor(0xE7B41A).setTitle('🪙 Custom Coin').setDescription('⏳ Timed out — no image received. Nothing changed.')], components: [coinRetryRow()], files: [], attachments: [] }).catch(() => {});
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
        { name: '⭐ Boosters Only', value: ['**Boosters only** — free premium roles:', '• ✨ **Holographic** — Discord\'s shimmer style', '• 🎨 **Custom Solid** — any colour by hex code', '• 🌈 **Custom Gradient** — blend any two hex colours', '• 🖼️ **Role Icon** — upload your own image, free', 'These stay while you keep boosting, and you can change them free anytime.'].join('\n') },
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

  // ─── PROFILE CARD SYSTEM ──────────────────────────────────────────────────
  // Renders a member's card and returns a message payload (embed image + buttons).
  async function profileHomeView(gid, member) {
    const uid = (member.user || member).id;
    const card = await profileApi.renderCard(gid, member, {});
    const published = profileApi.isPublished(gid, uid);
    const hearts = profileApi.heartsFor(gid, uid);
    const embed = new EmbedBuilder()
      .setColor(0x6366f1)
      .setTitle('🪪 Your Profile Card')
      .setDescription(`❤️ **${fmt(hearts)}** heart${hearts===1?'':'s'} received${published ? ' · 🌍 published to the showcase' : ' · not yet published'}\nUse **Edit Layout** to add text, stickers & stats and move them anywhere. Buy backgrounds, frames & effects in the **🛒 Shop**.`)
      .setImage(`attachment://${card.name}`);
    const rows = [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('prof:edit').setLabel('Edit Layout').setEmoji('🎨').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('prof:upload').setLabel('Upload Image').setEmoji('📤').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(published ? 'prof:unpublish' : 'prof:publish').setLabel(published ? 'Unpublish' : 'Publish to Showcase').setEmoji(published ? '🙈' : '🌍').setStyle(published ? ButtonStyle.Secondary : ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('hub:showcase:0').setLabel('View Showcase').setEmoji('❤️').setStyle(ButtonStyle.Secondary)),
      backHubOnly(),
    ];
    return { content: '', embeds: [embed], files: [card], components: rows, attachments: [] };
  }

  // ─── PATH A EDITOR ────────────────────────────────────────────────────────
  // Editor home: renders the card with the selected element highlighted, plus
  // controls to select/add/move/resize/rotate/layer/delete elements & toggle stats.
  // selMap tracks each user's currently-selected element id (in-memory; fine to reset).
  const profileSel = new Map();  // uid -> elementId
  async function profileEditorView(gid, member, note) {
    const uid = (member.user || member).id;
    const layout = profileApi.getLayout(gid, uid);
    let selId = profileSel.get(uid);
    if (selId && !layout.elements.find(e => e.id === selId)) { selId = null; profileSel.delete(uid); }
    const card = await profileApi.renderCard(gid, member, { selectedId: selId, forceStatic: true, preview: true });
    const sel = selId ? layout.elements.find(e => e.id === selId) : null;

    const desc = sel
      ? `**Selected:** ${elLabel(sel)}\nNudge it with the arrows, resize with ➖/➕, rotate with ↻, or change its layer. The blue dashed box shows what's selected.`
      : layout.elements.length
        ? 'Pick an element below to move it, or add a new one. Nothing selected yet.'
        : 'Your card is empty of custom items. **Add** text, a sticker or a stat below, then move it anywhere.';

    const embed = new EmbedBuilder().setColor(0x10b981).setTitle('🎨 Edit Your Card').setDescription((note ? `${note}\n\n` : '') + desc)
      .setImage(`attachment://${card.name}`);

    const rows = [];
    // row 1: element picker (select which element to edit)
    if (layout.elements.length) {
      const menu = new StringSelectMenuBuilder().setCustomId('prof:sel').setPlaceholder('Select an element to move/edit…')
        .addOptions(layout.elements.slice(0, 25).map(e => ({
          label: elLabel(e).slice(0, 100), value: e.id,
          description: `x${Math.round(e.x)} y${Math.round(e.y)} · ${e.w}×${e.h}${e.rot?` · ${e.rot}°`:''}`.slice(0,100),
          emoji: e.type==='text'?'🔤':e.type==='stat'?'📊':e.type==='avatar'?'🖼️':e.type==='name'?'🏷️':e.type==='clan'?'⚔️':'🖼️',
          default: e.id === selId,
        })));
      rows.push(new ActionRowBuilder().addComponents(menu));
    }
    // row 2: movement (disabled if nothing selected)
    const noSel = !sel;
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('prof:mv:up').setLabel('▲').setStyle(ButtonStyle.Secondary).setDisabled(noSel),
      new ButtonBuilder().setCustomId('prof:mv:down').setLabel('▼').setStyle(ButtonStyle.Secondary).setDisabled(noSel),
      new ButtonBuilder().setCustomId('prof:mv:left').setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(noSel),
      new ButtonBuilder().setCustomId('prof:mv:right').setLabel('▶').setStyle(ButtonStyle.Secondary).setDisabled(noSel),
      new ButtonBuilder().setCustomId('prof:step').setLabel(`Movement Speed: ${(moveStep.get(uid)||80)}x`).setStyle(ButtonStyle.Primary)));
    // row 3: size / rotate / layer / delete
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('prof:sz:down').setLabel('➖').setStyle(ButtonStyle.Secondary).setDisabled(noSel),
      new ButtonBuilder().setCustomId('prof:sz:up').setLabel('➕').setStyle(ButtonStyle.Secondary).setDisabled(noSel),
      new ButtonBuilder().setCustomId('prof:rot').setLabel('↻ Rotate').setStyle(ButtonStyle.Secondary).setDisabled(noSel),
      new ButtonBuilder().setCustomId('prof:layer:front').setLabel('Bring Front').setStyle(ButtonStyle.Secondary).setDisabled(noSel),
      new ButtonBuilder().setCustomId('prof:del').setLabel('Delete').setEmoji('🗑️').setStyle(ButtonStyle.Danger).setDisabled(noSel)));
    // row 4: add-new + manage images + reset
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('prof:add:text').setLabel('Add Text').setEmoji('🔤').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('prof:add:stat').setLabel('Add Stat/Info').setEmoji('📊').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('prof:border').setLabel('Border').setEmoji('🖼️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('prof:images').setLabel('Manage Images').setEmoji('🗂️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('prof:reset').setLabel('Reset').setEmoji('♻️').setStyle(ButtonStyle.Danger)));
    // row 5: contextual actions for the selected element + back
    const backRow = new ActionRowBuilder();
    if (sel) backRow.addComponents(new ButtonBuilder().setCustomId('prof:rename').setLabel('Rename Item').setEmoji('🏷️').setStyle(ButtonStyle.Secondary));
    if (sel && sel.type === 'text') backRow.addComponents(new ButtonBuilder().setCustomId('prof:text:edit').setLabel('Edit Text').setEmoji('✏️').setStyle(ButtonStyle.Primary));
    if (sel && sel.type === 'stat') backRow.addComponents(new ButtonBuilder().setCustomId('prof:stat:change').setLabel('Change Stat').setEmoji('🔀').setStyle(ButtonStyle.Primary));
    if (sel && (sel.type === 'sticker' || sel.type === 'image')) backRow.addComponents(new ButtonBuilder().setCustomId('prof:img:circle').setLabel('Toggle Circle').setEmoji('⭕').setStyle(ButtonStyle.Primary));
    backRow.addComponents(new ButtonBuilder().setCustomId('hub:profile').setLabel('← Done').setStyle(ButtonStyle.Secondary));
    rows.push(backRow);

    return { content:'', embeds:[embed], files:[card], attachments:[], components: rows.slice(0, 5) };
  }
  const elTypeLabel = (e) => e.type==='text' ? `Text: “${(e.data?.text||'').slice(0,18)}”` : e.type==='stat' ? `Stat: ${(e.data?.stat||'').toUpperCase()}` : e.type==='avatar' ? 'Profile Avatar' : e.type==='name' ? 'Profile Name' : e.type==='clan' ? 'Clan Info' : e.type==='sticker' ? 'Sticker' : 'Image';
  const elEmoji = (e) => e.type==='text'?'🔤':e.type==='stat'?'📊':e.type==='avatar'?'🖼️':e.type==='name'?'🏷️':e.type==='clan'?'⚔️':'🖼️';
  const elLabel = (e) => e.data?.name ? `${elEmoji(e)} ${e.data.name}` : elTypeLabel(e);

  // Manage Images: shows usage vs cap, a dropdown to delete an image, and one to pick a banner.
  function manageImagesView(gid, uid) {
    const imgs = profileApi.userImages(gid, uid);
    const keys = Object.keys(imgs);
    const used = keys.length, max = profileApi.MAX_IMAGES;
    const banner = profileApi.getBanner(gid, uid);
    // map each image key → the custom name given to its element (if any), so the dropdowns
    // show "My Logo" instead of a generic "Image 3" once the user has renamed it.
    const layout = profileApi.getLayout(gid, uid);
    const nameByKey = {};
    for (const el of (layout.elements || [])) {
      if (el.data?.imageKey && el.data?.name) nameByKey[el.data.imageKey] = el.data.name;
    }
    const imgLabel = (k, i) => nameByKey[k] ? nameByKey[k].slice(0, 60) : `Image ${i+1}`;
    const embed = new EmbedBuilder().setColor(0x8b5cf6).setTitle('🖼️ Manage Images')
      .setDescription(`You're using **${used} / ${max}** image slots.\nPress **📤 Upload Image** then drop an image in the channel — or caption any image with \`!cardimg\`.\n\n• **Delete** an image to free a slot (also removes it from your card).\n• **Set as Banner** to make an image fill your whole card background${banner ? ' *(one is currently set)*' : ''}.`);
    const rows = [];
    if (used) {
      const delOpts = keys.slice(0, 25).map((k, i) => ({ label: `${imgLabel(k, i)}${banner===k?' (banner)':''}`.slice(0, 100), value: k, emoji: '🗑️' }));
      rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('prof:imgDelete').setPlaceholder('Delete an image…').addOptions(delOpts)));
      const banOpts = [{ label: 'No banner (use background cosmetic)', value: '__none__', emoji: '🚫' },
        ...keys.slice(0, 24).map((k, i) => ({ label: `${imgLabel(k, i)} as banner`.slice(0, 100), value: k, emoji: '🖼️', default: banner===k }))];
      rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('prof:imgBanner').setPlaceholder('Set a banner…').addOptions(banOpts)));
    }
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('prof:upload').setLabel('Upload Image').setEmoji('📤').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('prof:edit').setLabel('← Back to Editor').setStyle(ButtonStyle.Secondary)));
    return { content: '', embeds: [embed], components: rows, files: [], attachments: [], flags: 64 };
  }
  const moveStep = new Map();  // uid -> px step

  // The cosmetics shop for one slot (background/frame/namecolor/title/effect).
  function profileShopView(gid, uid, slot) {
    const cat = profileApi.CATALOGUE[slot] || [];
    const equipped = profileApi.getEquipped(gid, uid);
    const bal = (gachaApi ? gachaApi.balance(gid, uid) : 0);
    const slotRow = new ActionRowBuilder().addComponents(
      ...['background','frame','namecolor','title','effect'].map(s =>
        new ButtonBuilder().setCustomId(`prof:shop:${s}`).setLabel(profileApi.SLOT_LABEL[s]).setStyle(s===slot?ButtonStyle.Primary:ButtonStyle.Secondary)));
    // dropdown of items in this slot
    const opts = cat.slice(0, 25).map(it => {
      const owned = it.free || profileApi.isOwned(gid, uid, slot, it.key);
      const isEq  = equipped[slot] === it.key;
      const price = it.free ? 'Free' : `${fmt(it.price)} Dinar`;
      return {
        label: `${it.name}${it.anim ? ' ✨' : ''}`.slice(0, 100),
        value: it.key,
        description: (isEq ? 'Equipped · ' : owned ? 'Owned · ' : `${price} · `) + (it.anim ? 'Animated GIF' : SLOT_HINT(slot)),
        emoji: isEq ? '✅' : owned ? '📦' : '🔒',
      };
    });
    const menu = new StringSelectMenuBuilder().setCustomId(`prof:pick:${slot}`).setPlaceholder(`Choose a ${profileApi.SLOT_LABEL[slot].toLowerCase()}…`).addOptions(opts);
    const embed = new EmbedBuilder()
      .setColor(0x10b981)
      .setTitle(`🎨 Customize — ${profileApi.SLOT_LABEL[slot]}`)
      .setDescription(`Your balance: **${fmt(bal)} Dinar**\nPick an item below to **equip** it (if owned) or **buy** it. ✨ = animated GIF (premium).`);
    return { content:'', embeds: [embed], files: [], attachments: [], components: [slotRow, new ActionRowBuilder().addComponents(menu),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('hub:profile').setLabel('← Back to Card').setStyle(ButtonStyle.Secondary))] };
  }
  const SLOT_HINT = (slot) => ({background:'card background',frame:'card border',namecolor:'name colour',title:'profile title',effect:'card effect'}[slot]||'');

  // Showcase — browse published cards sorted by hearts (most-loved first).
  async function showcaseView(gid, viewerId, idx, guild) {
    let list = profileApi.publishedList(gid);
    // sort by hearts desc so the "card of the moment" leads
    list = list.map(id => ({ id, hearts: profileApi.heartsFor(gid, id) })).sort((a,b) => b.hearts - a.hearts);
    if (!list.length) {
      return { content:'', embeds: [new EmbedBuilder().setColor(0xfb7185).setTitle('❤️ Profile Showcase')
        .setDescription('No one has published a card yet!\nOpen **🪪 My Profile** → **Publish to Showcase** to be the first.')], files: [], attachments: [], components: [backHubOnly()] };
    }
    const n = list.length;
    idx = ((idx % n) + n) % n;   // wrap
    const entry = list[idx];
    let member;
    try { member = await guild.members.fetch(entry.id); } catch { member = null; }
    if (!member) {
      // member left — skip by rendering a placeholder and letting them navigate on
      const embed = new EmbedBuilder().setColor(0xfb7185).setTitle(`❤️ Profile Showcase — ${idx+1}/${n}`)
        .setDescription('This member is no longer in the server.');
      return { content:'', embeds:[embed], files:[], attachments:[], components:[navRow(idx,n,entry.id,viewerId,true), backHubOnly()] };
    }
    const card = await profileApi.renderCard(gid, member, {});
    const rank = idx + 1;
    const medal = rank===1?'🥇':rank===2?'🥈':rank===3?'🥉':`#${rank}`;
    const embed = new EmbedBuilder().setColor(0xfb7185)
      .setTitle(`❤️ Profile Showcase — ${medal} of ${n}`)
      .setDescription(`**${esc(member.displayName || member.user.username)}** · ❤️ **${fmt(entry.hearts)}** heart${entry.hearts===1?'':'s'}`)
      .setImage(`attachment://${card.name}`);
    return { content:'', embeds:[embed], files:[card], attachments:[], components:[navRow(idx,n,entry.id,viewerId,false), backHubOnly()] };
  }
  function navRow(idx, n, targetId, viewerId, disabledHeart) {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`hub:showcase:${idx-1}`).setLabel('◀ Prev').setStyle(ButtonStyle.Secondary).setDisabled(n<=1),
      new ButtonBuilder().setCustomId(`prof:heart:${targetId}:${idx}`).setLabel('Heart').setEmoji('❤️').setStyle(ButtonStyle.Secondary).setDisabled(disabledHeart || targetId===viewerId),
      new ButtonBuilder().setCustomId(`hub:showcase:${idx+1}`).setLabel('Next ▶').setStyle(ButtonStyle.Secondary).setDisabled(n<=1));
  }

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
      new ButtonBuilder().setCustomId('clan:channel').setLabel(c.channelId ? 'Channel' : `Create Channel — ${fmt(clans.CLAN_CHANNEL_COST)}`).setEmoji('📢').setStyle(ButtonStyle.Secondary).setDisabled(!isLeader),
      new ButtonBuilder().setCustomId('clan:wars').setLabel('Wars').setEmoji('⚔️').setStyle(ButtonStyle.Danger).setDisabled(!isOfficerPlus || !warApi));
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

  function clanWarsView(gid, uid) {
    const mine = clans.userClan(db, gid, uid);
    if (!mine) return clanEntryView(gid, uid);
    if (clans.userRank(mine.clan, uid) === 'Member' || !warApi) return clanDashboard(gid, uid);
    const st = warApi.getState(gid, mine.name);
    const rows = [];
    let desc;
    if (st.state === 'incoming') {
      desc = `⚔️ **${esc(st.challenger)}** has challenged you to war!\nAccept to pick a game and fight, or decline.`;
      rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('clan:warAccept').setLabel('Accept War').setEmoji('⚔️').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('clan:warDecline').setLabel('Decline').setEmoji('🏳️').setStyle(ButtonStyle.Danger)));
    } else if (st.state === 'outgoing') {
      desc = `⏳ Your challenge to **${esc(st.defender)}** is pending their response (expires within 2 minutes).`;
    } else if (st.state === 'active') {
      desc = `🔥 A war is currently underway: **${esc(st.challenger)}** vs **${esc(st.defender)}**. Watch the channel!`;
    } else if (st.state === 'busy') {
      desc = `⚔️ Another clan war is in progress on the server. Wait for it to finish before starting yours.`;
    } else {
      const targets = warApi.targets(gid, mine.name);
      if (!targets.length) {
        desc = `There are no other clans to challenge yet.`;
      } else {
        desc = `Challenge another clan to war! The winner earns XP, LP and glory.\nPick an opponent below (Leaders & Officers only).`;
        const menu = new StringSelectMenuBuilder().setCustomId('clan:warPick').setPlaceholder('Choose a clan to challenge…')
          .addOptions(targets.slice(0, 25).map(n => ({ label: n.slice(0, 100), value: n, emoji: (db[gid][n] && db[gid][n].emoji) || '⚔️' })));
        rows.push(new ActionRowBuilder().addComponents(menu));
      }
    }
    const embed = new EmbedBuilder().setColor(0xFF0000).setTitle(`⚔️ ${esc(mine.name)} — Clan Wars`).setDescription(desc);
    rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('hub:clan').setLabel('← Back to Clan').setStyle(ButtonStyle.Secondary)));
    return { content: '', embeds: [embed], components: rows, files: [], attachments: [] };
  }

  // ═══════════════ COLLECTION (gacha) UI ═══════════════
  function collectionHome(gid, uid) {
    if (!gachaApi) return { content: 'The collection game is unavailable right now.', embeds: [], components: [backHubOnly()], files: [], attachments: [] };
    const bal = gachaApi.balance(gid, uid);
    const col = gachaApi.collection(gid, uid);
    const daily = gachaApi.dailyStatus(gid, uid);
    const embed = new EmbedBuilder().setColor(0x9B59B6).setTitle('🃏 Your Collection')
      .setDescription(
        `💰 **Balance:** ${fmt(bal)} Dinar\n` +
        `🎴 **Cards owned:** ${col.count}  ·  **Value:** ${fmt(col.totalValue)} Dinar\n` +
        `🎁 **Daily:** ${daily.ready ? '**ready to claim!**' : `claimed — back in ${gachaApi.fmtDur(daily.retryMs)}`}\n\n` +
        `Roll for new cards with \`/gacha-roll\` in the channel.`);
    const row1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('col:daily').setLabel(daily.ready ? 'Claim Daily' : 'Daily Claimed').setEmoji('🎁').setStyle(daily.ready ? ButtonStyle.Success : ButtonStyle.Secondary).setDisabled(!daily.ready),
      new ButtonBuilder().setCustomId('col:mine').setLabel('My Cards').setEmoji('🎴').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('col:wishlist').setLabel('Wishlist').setEmoji('⭐').setStyle(ButtonStyle.Secondary));
    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('col:boardCollectors').setLabel('Top Collectors').setEmoji('🏆').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('col:boardRichest').setLabel('Richest').setEmoji('💰').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('col:rarest').setLabel('Rarest Cards').setEmoji('💎').setStyle(ButtonStyle.Secondary));
    return { content: '', embeds: [embed], components: [row1, row2, backHubOnly()], files: [], attachments: [] };
  }
  const colBack = () => new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('hub:collection').setLabel('← Back to Collection').setStyle(ButtonStyle.Secondary));

  function myCardsView(gid, uid) {
    const col = gachaApi.collection(gid, uid);
    const lines = [];
    for (const t of [...col.tiers].reverse()) {
      const arr = col.byTier[t];
      if (arr && arr.length) lines.push(`${col.emoji[t]} **${t}** (${arr.length}): ${arr.map(c => `<@${c}>`).join(', ')}`);
    }
    const embed = new EmbedBuilder().setColor(0x9B59B6).setTitle('🎴 My Cards')
      .setDescription(col.count ? lines.join('\n') : '_Empty — roll with `/gacha-roll` and claim someone!_')
      .addFields({ name: 'Owned', value: `${col.count}`, inline: true }, { name: 'Total value', value: `💰 ${fmt(col.totalValue)}`, inline: true });
    return { content: '', embeds: [embed], components: [colBack()], files: [], attachments: [] };
  }
  function boardView(gid, kind) {
    const medals = ['🥇', '🥈', '🥉'];
    let embed;
    if (kind === 'collectors') {
      const rows = gachaApi.collectionBoard(gid);
      embed = new EmbedBuilder().setColor(0xF1C40F).setTitle('🏆 Collection Leaderboard')
        .setDescription(rows.length ? rows.map((r, i) => `${medals[i] || `**${i + 1}.**`} <@${r.id}> — ${r.count} cards · 💰 ${fmt(r.value)}`).join('\n') : '_No collections yet._');
    } else if (kind === 'richest') {
      const rows = gachaApi.richest(gid);
      embed = new EmbedBuilder().setColor(0xF1C40F).setTitle('💰 Richest — Top 10')
        .setDescription(rows.length ? rows.map((r, i) => `${medals[i] || `**${i + 1}.**`} <@${r.id}> — **${fmt(r.bal)}** Dinar`).join('\n') : '_Nobody has Dinar yet._');
    } else {
      const rows = gachaApi.rarest(gid);
      embed = new EmbedBuilder().setColor(0xE74C3C).setTitle('💎 Top 15 Rarest Cards')
        .setDescription(rows.length ? rows.map((e, i) => `**${i + 1}.** ${e.emoji} <@${e.id}> · ${e.rarity} · 💰 ${fmt(e.value)} · ${e.owner ? `owned by <@${e.owner}>` : '_unclaimed_'}`).join('\n') : '_Nobody has opted in yet._');
    }
    return { content: '', embeds: [embed], components: [colBack()], files: [], attachments: [] };
  }
  function wishlistView(gid, uid) {
    const wl = gachaApi.wishlist(gid, uid);
    const embed = new EmbedBuilder().setColor(0xE7B41A).setTitle('⭐ Your Wishlist')
      .setDescription(wl.length ? wl.map(w => `• <@${w}>`).join('\n') : '_Empty — add someone with `/gacha-wish @user`._');
    const rows = [];
    if (wl.length) {
      const menu = new StringSelectMenuBuilder().setCustomId('col:wishRemove').setPlaceholder('Remove someone…')
        .addOptions(wl.slice(0, 25).map(w => ({ label: `Remove`, value: w, description: w })));
      // labels can't be a mention; use ids
      menu.setOptions(wl.slice(0, 25).map(w => ({ label: `User ${w.slice(-4)}`, value: w })));
      rows.push(new ActionRowBuilder().addComponents(menu));
    }
    rows.push(colBack());
    return { content: '', embeds: [embed], components: rows, files: [], attachments: [] };
  }

  // ═══════════════ INTERACTIONS ═══════════════
  // Image upload for profile cards. Two ways to trigger:
  //  (a) post an image with the caption "!cardimg", or
  //  (b) press the "Upload Image" button (arms a 2-minute window, then just post any image).
  // We fetch it, store as a data URI, and add it as a sticker element. Trusted community.
  const awaitingUpload = new Map();   // uid -> expiry timestamp
  const UPLOAD_WINDOW_MS = 2 * 60 * 1000;
  /* Stores an uploaded image on a user's profile card. Shared by the
     message-based flows (!cardimg / the armed upload button) and by
     /profile-image, so all three behave identically.
     Returns { ok, text, components? } — the caller decides how to deliver it. */
  async function storeProfileImage(guildId, userId, att) {
    if (!att) return { ok: false, text: '📎 No image attached.' };
    const name = (att.name || '').toLowerCase();
    const typeOk = (att.contentType || '').startsWith('image/');
    const extOk = /\.(png|jpe?g|gif|webp)$/i.test(name);
    if (!typeOk && !extOk)
      return { ok: false, text: `That doesn't look like an image (got \`${att.contentType || name || 'unknown'}\`). Use a PNG, JPG, GIF or WEBP.` };
    if (att.size > 8 * 1024 * 1024)
      return { ok: false, text: 'That image is too large — please keep it under 8MB.' };
    const used = profileApi.imageCount(guildId, userId);
    if (used >= profileApi.MAX_IMAGES)
      return { ok: false, text: `🚫 You've reached the max of **${profileApi.MAX_IMAGES} images**. Delete one from **🪪 My Profile → Edit Layout → Manage Images** before adding another.` };

    const res = await fetch(att.url, { signal: AbortSignal.timeout(12000) })
      .catch((e) => { console.error('[profile] image fetch error:', e.message); return null; });
    if (!res || !res.ok) return { ok: false, text: 'Couldn\'t download that image — try uploading it again.' };
    const buf = Buffer.from(await res.arrayBuffer());
    // Real format comes from the magic bytes, not the filename — Discord (especially
    // mobile) often serves a PNG named ".webp", and a wrong label renders blank.
    const sniffed = sniffImageMime(buf);
    if (!sniffed)
      return { ok: false, text: 'That image is in a format I can\'t use (I support PNG, JPG, GIF and WEBP). Try re-saving it as a PNG.' };
    let finalBuf = buf, finalMime = sniffed;
    if (sniffed === 'image/webp') {
      const converted = await webpToPng(buf);
      if (!converted)
        return { ok: false, text: 'That\'s a WEBP image, which I can\'t display. Please re-save it as a **PNG** or **JPG** and upload again.' };
      finalBuf = converted; finalMime = 'image/png';
    }
    const dataUri = `data:${finalMime};base64,${finalBuf.toString('base64')}`;
    const key = profileApi.addUserImage(guildId, userId, dataUri);
    profileApi.addElement(guildId, userId, 'sticker', { imageKey: key, circle: false });
    console.log(`[profile] image stored for ${userId} (key=${key}, ${(buf.length/1024).toFixed(0)}KB, original=${sniffed}, final=${finalMime})`);
    const doneRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('prof:editmine').setLabel('Open Editor').setEmoji('🎨').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('prof:images').setLabel('Manage Images').setEmoji('🖼️').setStyle(ButtonStyle.Secondary));
    return {
      ok: true,
      text: '🖼️ **Added to your card!** Tap **Open Editor** to position it, or **Manage Images** to set it as a banner. (It starts near the top-left.)',
      components: [doneRow],
    };
  }

  if (profileApi) client.on('messageCreate', async (message) => {
    try {
      if (message.author?.bot || !message.guild) return;
      const content = (message.content || '').trim().toLowerCase();
      const armedUntil = awaitingUpload.get(message.author.id) || 0;
      const isArmed = Date.now() < armedUntil && (message.attachments?.size > 0);
      const hasCaption = content.startsWith('!cardimg');
      if (!hasCaption && !isArmed) return;
      if (isArmed) awaitingUpload.delete(message.author.id);   // consume the armed window
      console.log(`[profile] image trigger from ${message.author.id} (${hasCaption?'!cardimg':'button-armed'}) — attachments: ${message.attachments?.size || 0}`);
      const att = message.attachments?.first();
      if (!att) {
        if (hasCaption) return message.reply('📎 Attach an image **in the same message** as `!cardimg` (drag the image in, then type `!cardimg` as the caption before sending).').catch(()=>{});
        return;
      }
      const name = (att.name || '').toLowerCase();
      const extOk = /\.(png|jpe?g|gif|webp)$/.test(name);
      const typeOk = att.contentType && att.contentType.startsWith('image/');
      const out = await storeProfileImage(message.guild.id, message.author.id, att);
      await message.reply(out.ok
        ? { content: out.text, components: out.components }
        : { content: out.text }).catch(()=>{});
    } catch (e) {
      console.error('[profile] image upload failed:', e.message, e.stack?.split('\n')[1]);
      try { await message.reply('⚠️ Something went wrong adding that image. Check the logs or try again.'); } catch {}
    }
  });

  client.on('interactionCreate', async (interaction) => {
    try {
      // /hub
      if (interaction.isChatInputCommand() && interaction.commandName === 'profile') {
        if (!interaction.guildId) return interaction.reply({ content: 'Use this in the server.', flags: 64 });
        if (!profileApi) return interaction.reply({ content: 'Profiles aren\'t available right now.', flags: 64 });
        const target = interaction.options.getUser('user') || interaction.user;
        await interaction.deferReply();
        try {
          const member = await interaction.guild.members.fetch(target.id).catch(() => null);
          if (!member) return interaction.editReply({ content: 'That user isn\'t in this server.' });
          const card = await profileApi.renderCard(interaction.guildId, member, {});
          const hearts = profileApi.heartsFor(interaction.guildId, target.id);
          const isMe = target.id === interaction.user.id;
          const embed = new EmbedBuilder().setColor(0x6366f1)
            .setTitle(`🪪 ${esc(member.displayName || target.username)}'s Profile`)
            .setDescription(`❤️ **${fmt(hearts)}** heart${hearts===1?'':'s'}`)
            .setImage(`attachment://${card.name}`);
          // Two buttons: "Edit your Profile" (opens the clicker's OWN editor) and "Heart".
          // The Heart button always shows (the card is public, so anyone who sees it can
          // heart it) — the handler itself blocks hearting your own profile with a private
          // note, so it's safe to show even on your own /profile.
          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('prof:editmine').setLabel('Edit your Profile').setEmoji('🎨').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`prof:heartp:${target.id}`).setLabel('Heart').setEmoji('❤️').setStyle(ButtonStyle.Secondary).setDisabled(target.bot));
          return interaction.editReply({ embeds: [embed], files: [card], components: [row] });
        } catch (e) {
          console.error('[profile] command failed:', e.message);
          return interaction.editReply({ content: '⚠️ Couldn\'t render that profile card.' });
        }
      }
      if (interaction.isChatInputCommand() && interaction.commandName === 'topprofiles') {
        if (!interaction.guildId) return interaction.reply({ content: 'Use this in the server.', flags: 64 });
        if (!profileApi) return interaction.reply({ content: 'Profiles aren\'t available right now.', flags: 64 });
        const g = interaction.guildId;
        // rank published profiles by hearts (desc)
        const ranked = profileApi.publishedList(g)
          .map(id => ({ id, hearts: profileApi.heartsFor(g, id) }))
          .sort((a, b) => b.hearts - a.hearts)
          .slice(0, 10);

        const howTo =
          '**❤️ Want your profile on this board?**\n' +
          '1️⃣ Run `/hub` → **🪪 My Profile** (or `/profile`) and design your card.\n' +
          '2️⃣ Hit **🌍 Publish to Showcase** so others can see it.\n' +
          '3️⃣ People heart it with **/profile @you** → the **❤️ Heart** button.\n' +
          'The more hearts, the higher you climb!';

        if (!ranked.length) {
          return interaction.reply({
            embeds: [new EmbedBuilder().setColor(0xec4899).setTitle('🏆 Top Profiles')
              .setDescription(`No published profiles yet — be the first!\n\n${howTo}`)],
          });
        }

        const medals = ['🥇', '🥈', '🥉'];
        const lines = ranked.map((r, i) => {
          const rank = medals[i] || `**${i + 1}.**`;
          return `${rank} <@${r.id}> — **${fmt(r.hearts)}** heart${r.hearts === 1 ? '' : 's'}`;
        });

        return interaction.reply({
          embeds: [new EmbedBuilder().setColor(0xec4899)
            .setTitle('🏆 Top Profiles — Most Hearted')
            .setDescription(lines.join('\n') + `\n\n${howTo}`)
            .setFooter({ text: 'Tip: /profile @someone to view and heart their card' })
            .setTimestamp()],
        });
      }
      if (interaction.isChatInputCommand() && interaction.commandName === 'hub-mod-role') {
        if (!interaction.guildId) return interaction.reply({ content: 'Use this in the server.', flags: 64 });
        // admin check
        const isAdmin = interaction.memberPermissions?.has('Administrator') || interaction.memberPermissions?.has('ManageGuild');
        if (!isAdmin) return interaction.reply({ content: '❌ You need **Manage Server** or **Administrator** to set the mod role.', flags: 64 });
        const role = interaction.options.getRole('role');
        const st = shopState(db, interaction.guildId);
        if (role) {
          st.modRoleId = role.id;
          saveData(interaction.guildId);
          return interaction.reply({ content: `✅ Mod role set to **${esc(role.name)}**. New custom roles from the hub will always be placed **below** it so moderators can act on their owners.\n\n*Note: this only affects roles created from now on. Existing custom roles that sit too high may need repositioning once — I can add a re-sort if you want.*`, flags: 64 });
        } else {
          delete st.modRoleId;
          saveData(interaction.guildId);
          return interaction.reply({ content: '✅ Cleared the manual mod role. I\'ll **auto-detect** it instead — I place custom roles below the lowest role that can moderate (kick/ban/timeout/manage roles).', flags: 64 });
        }
      }
      if (interaction.isChatInputCommand() && interaction.commandName === 'hub') {
        if (!interaction.guildId) return interaction.reply({ content: 'Use this in the server.', flags: 64 });
        const boosting = isBoosting(interaction);
        const uname = interaction.member?.displayName || interaction.user.username;
        console.log(`🏛️ /hub opened by ${uname} (${interaction.user.id})${boosting ? ' [booster]' : ''}`);
        return interaction.reply({ embeds: [hubEmbed(boosting, interaction.user.id, interaction.guildId)], components: hubComponents(boosting), flags: 64 });
      }
      // ── /profile-image ─────────────────────────────────────────────────
      // Attachment-bearing slash command. This is the reliable way to upload in a
      // locked-down channel: running a slash command needs "Use Application
      // Commands", not "Send Messages", so it still works where members can't type.
      if (interaction.isChatInputCommand() && interaction.commandName === 'profile-image') {
        if (!interaction.guildId) return interaction.reply({ content: 'Use this in the server.', flags: 64 });
        if (!profileApi) return interaction.reply({ content: 'Profiles aren\'t available right now.', flags: 64 });
        await interaction.deferReply({ flags: 64 });
        try {
          const att = interaction.options.getAttachment('image');
          const out = await storeProfileImage(interaction.guildId, interaction.user.id, att);
          return interaction.editReply(out.ok
            ? { content: out.text, components: out.components }
            : { content: out.text });
        } catch (e) {
          console.error('[profile-image]', e.message);
          return interaction.editReply({ content: '⚠️ Something went wrong adding that image. Try again in a moment.' }).catch(() => {});
        }
      }

      // ── /role-icon ─────────────────────────────────────────────────────
      // Same reasoning as /profile-image: an attachment on a slash command needs
      // only "Use Application Commands", so this works in a channel where members
      // can't post. The old "upload an image here" collector flow still works too.
      if (interaction.isChatInputCommand() && interaction.commandName === 'role-icon') {
        if (!interaction.guildId) return interaction.reply({ content: 'Use this in the server.', flags: 64 });
        const gidR = interaction.guildId, uidR = interaction.user.id;
        const rec = stateOf(gidR).roles[uidR];
        if (!rec) return interaction.reply({ content: '🖼️ You need an active hub role first — grab a **Custom Role** from `/hub` → Shop, then set your icon.', flags: 64 });
        await interaction.deferReply({ flags: 64 });
        try {
          const free = isBoosting(interaction);
          const got = await fetchIconBuffer(interaction.options.getAttachment('image'));
          if (got.error) return interaction.editReply({ content: `⚠️ ${got.error}\nNothing was charged.` });
          if (!free && getDinar(db, gidR, uidR) < ICON_PRICE)
            return interaction.editReply({ content: `💰 A role icon costs **${fmt(ICON_PRICE)} Dinar** — you have **${fmt(getDinar(db, gidR, uidR))}**.` });
          const role = interaction.guild.roles.cache.get(rec.roleId)
            || await interaction.guild.roles.fetch(rec.roleId).catch(() => null);
          if (!role) return interaction.editReply({ content: '⚠️ I couldn\'t find your role anymore — grab a fresh one from the Shop, then add the icon.' });
          try { await role.setIcon(got.buf, `Role icon set by ${interaction.user.tag}`); }
          catch (e) {
            console.error('[role-icon]', e.message);
            return interaction.editReply({ content: '⚠️ Discord rejected that image (too large or unsupported). Nothing was charged — try a smaller, square PNG/JPG.' });
          }
          if (!free) spendDinar(db, gidR, uidR, ICON_PRICE, saveData);
          rec.icon = true; saveData(gidR);
          setAction(uidR, `🖼️ Added a custom icon to **${esc(rec.label)}**${free ? ' (booster perk)' : ` (${fmt(ICON_PRICE)} Dinar)`}.`);
          const balLine = free ? '⭐ Free booster perk.' : `💰 Paid **${fmt(ICON_PRICE)} Dinar** — new balance **${fmt(getDinar(db, gidR, uidR))}**.`;
          return interaction.editReply({ content: `✅ Icon applied to **${esc(rec.label)}**! It now shows next to your name.\n${balLine}` });
        } catch (e) {
          console.error('[role-icon]', e.message);
          return interaction.editReply({ content: '⚠️ Something went wrong setting that icon. Try again in a moment.' }).catch(() => {});
        }
      }

      // ── /coin-image (booster perk) ─────────────────────────────────────
      if (interaction.isChatInputCommand() && interaction.commandName === 'coin-image') {
        if (!interaction.guildId) return interaction.reply({ content: 'Use this in the server.', flags: 64 });
        if (!isBoosting(interaction))
          return interaction.reply({ content: '⭐ Custom coins are a **booster perk** — boost the server to unlock it!', flags: 64 });
        const gidC = interaction.guildId, uidC = interaction.user.id;
        await interaction.deferReply({ flags: 64 });
        try {
          const got = await fetchCoinBuffer(interaction.options.getAttachment('image'));
          if (got.error) return interaction.editReply({ content: `⚠️ ${got.error}` });
          let previewPng;
          try {
            coins.setCustomImage(db, gidC, uidC, got.buf.toString('base64'), got.mime, saveData);
            previewPng = coins.renderCustomFace(got.buf, got.mime, 'heads');
          } catch (e) {
            console.error('[coin-image]', e.message);
            return interaction.editReply({ content: '⚠️ I couldn\'t process that image. Try a different PNG/JPG.' });
          }
          setAction(uidC, '🪙 Set a custom coin design (booster perk).');
          return interaction.editReply({
            content: '✅ Your custom coin is set and equipped! Here\'s how **heads** will look — **tails** uses the same image.\n*Switch back anytime from Shop → Coin Designs.*',
            files: [new AttachmentBuilder(previewPng, { name: 'coin-preview.png' })],
          });
        } catch (e) {
          console.error('[coin-image]', e.message);
          return interaction.editReply({ content: '⚠️ Something went wrong setting that coin. Try again in a moment.' }).catch(() => {});
        }
      }

      // ── Hub board: admin commands ──────────────────────────────────────
      if (interaction.isChatInputCommand() && interaction.commandName === 'hub-panel') {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator))
          return interaction.reply({ content: '❌ Admins only.', flags: 64 });
        try {
          const msg = await interaction.channel.send(hubPanelMessage());
          try { await msg.pin(); } catch { /* needs Manage Messages — not fatal */ }
          const st = stateOf(interaction.guildId);
          st.panel = { channelId: interaction.channelId, messageId: msg.id };
          saveData(interaction.guildId);
          return interaction.reply({
            content: `✅ Hub board posted${msg.pinned ? ' and pinned' : ''}.\n`
              + `Tip: deny **Send Messages** for @everyone in this channel so the board stays the only thing here, `
              + `then point Discord **Onboarding** at it for new members.`,
            flags: 64,
          });
        } catch (e) {
          console.error('[hub-panel]', e.message);
          return interaction.reply({ content: `⚠️ Couldn't post the board: ${e.message}. Check I can send messages and embeds here.`, flags: 64 });
        }
      }
      if (interaction.isChatInputCommand() && interaction.commandName === 'hub-channel') {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator))
          return interaction.reply({ content: '❌ Admins only.', flags: 64 });
        const st = stateOf(interaction.guildId);
        st.homeChannelId = interaction.channelId;
        saveData(interaction.guildId);
        return interaction.reply({ content: `✅ <#${interaction.channelId}> is now the Hub home. Run **/hub-panel** here to post the board.`, flags: 64 });
      }

      // ── Hub board: buttons ─────────────────────────────────────────────
      // These must REPLY (never update) — the board is a shared public message.
      if (interaction.isButton() && interaction.customId.startsWith('hubp:')) {
        const what = interaction.customId.slice(5);
        const gid2 = interaction.guildId, uid2 = interaction.user.id;
        const boosting = isBoosting(interaction);
        const name2 = interaction.member?.displayName || interaction.user.username;
        // Every board reply carries a Dismiss control. Discord won't let a bot
        // delete someone's ephemeral messages later on, so the only reliable way
        // to keep a user's view tidy is to let them clear it themselves.
        const dismiss = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('hubp:dismiss').setLabel('Dismiss').setEmoji('✖️').setStyle(ButtonStyle.Secondary));
        const withDismiss = (view) => {
          const comps = [...(view.components || [])];
          if (comps.length < 5) comps.push(dismiss);
          return { ...view, components: comps, flags: 64 };
        };
        try {
          if (what === 'dismiss') {
            // Removes the ephemeral message this button lives on.
            return interaction.update({ content: '✔️ Closed.', embeds: [], components: [], files: [], attachments: [] })
              .then(() => interaction.deleteReply().catch(() => {}))
              .catch(() => {});
          }
          if (what === 'profile') {
            if (!profileApi) return interaction.reply({ content: 'Profiles aren\'t available right now.', flags: 64 });
            await interaction.deferReply({ flags: 64 });
            const member = interaction.member || await interaction.guild.members.fetch(uid2);
            return interaction.editReply(withDismiss(await profileHomeView(gid2, member)));
          }
          if (what === 'streak') {
            return interaction.reply(withDismiss(streakView(gid2, uid2, name2)));
          }
          if (what === 'shop') {
            return interaction.reply(withDismiss(shopEntryView()));
          }
          if (what === 'clan') {
            return interaction.reply(withDismiss(clanEntryView(gid2, uid2)));
          }
          if (what === 'help') {
            const pages = helpPages();
            return interaction.reply(withDismiss({ embeds: [pages[0]], components: [helpRow(0, pages.length)] }));
          }
          // 'open' and anything unrecognised → the normal hub home
          return interaction.reply(withDismiss({
            embeds: [hubEmbed(boosting, uid2, gid2)],
            components: hubComponents(boosting),
          }));
        } catch (e) {
          console.error('[hub panel button]', e.message);
          const m = '⚠️ Couldn\'t open that. Try again in a moment.';
          if (interaction.deferred && !interaction.replied) return interaction.editReply({ content: m, embeds: [], components: [] }).catch(() => {});
          if (!interaction.replied) return interaction.reply({ content: m, flags: 64 }).catch(() => {});
        }
        return;
      }

      if (!interaction.guildId) return;
      const gid = interaction.guildId, uid = interaction.user.id;
      const name = interaction.member?.displayName || interaction.user.username;

      // hub navigation
      if (interaction.isButton() && interaction.customId === 'hub:home') {
        const boosting = isBoosting(interaction);
        return interaction.update({ embeds: [hubEmbed(boosting, uid, gid)], components: hubComponents(boosting), files: [], attachments: [] });
      }
      // "View Profile Showcase" from a public /profile card → open the PRIVATE
      // "Edit your Profile" from a /profile card → open the editor for the CLICKER'S OWN
      // profile as a fresh ephemeral reply (works even when viewing someone else's card).
      if (interaction.isButton() && interaction.customId === 'prof:editmine') {
        if (!profileApi) return interaction.reply({ content: 'Profiles aren\'t available right now.', flags: 64 });
        const who = interaction.user?.username || uid;
        console.log(`🎨 "Edit your Profile" pressed by ${who} (${uid}) in ${interaction.guild?.name || gid}`);
        await interaction.deferReply({ flags: 64 });
        try {
          const member = interaction.member || await interaction.guild.members.fetch(uid);
          return interaction.editReply(await profileEditorView(gid, member));
        } catch (e) {
          console.error('[profile] editmine failed:', e.message);
          return interaction.editReply({ content: '⚠️ Couldn\'t open the editor. Try /hub → 🪪 My Profile → Edit Layout.' });
        }
      }
      // "Your Profile Card" view (Edit Layout / Publish / View Showcase / Back to Hub),
      // as a fresh ephemeral reply so the public /profile message is never modified.
      if (interaction.isButton() && interaction.customId === 'prof:openhub') {
        if (!profileApi) return interaction.reply({ content: 'Profiles aren\'t available right now.', flags: 64 });
        await interaction.deferReply({ flags: 64 });
        try {
          const member = interaction.member || await interaction.guild.members.fetch(uid);
          return interaction.editReply(await profileHomeView(gid, member));
        } catch (e) {
          console.error('[profile] openhub failed:', e.message);
          return interaction.editReply({ content: '⚠️ Couldn\'t open your profile. Try /hub → 🪪 My Profile.' });
        }
      }
      // ── Shop sub-menu: Custom Roles + Coin Designs ──
      if (interaction.isButton() && interaction.customId === 'hub:shop') {
        const v = shopEntryView();
        return interaction.update({ content: '', embeds: v.embeds, components: [...v.components, backHubRow()], files: [], attachments: [] });
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
      // side chosen → play the flip out privately, in this user's own reply
      if (interaction.isButton() && interaction.customId.startsWith('hub:flipGo:')) {
        const [, , side, amtStr] = interaction.customId.split(':');
        const amount = parseInt(amtStr, 10);
        await interaction.update({ content: '🪙 Tossing your coin…', components: [] }).catch(() => {});
        setAction(uid, `🪙 Flipped **${fmt(amount)} Dinar** on **${side}**`);
        const r = await runFlip({
          guildId: gid, channel: ephemeralFlipChannel(interaction), uid, name, amount, side,
        });
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
        const embed = new EmbedBuilder().setColor(0xf47fff).setTitle('⭐ Boosters Only')
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
          new ButtonBuilder().setCustomId('boost:icon').setLabel('Role Icon').setEmoji('🖼️').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('boost:coin').setLabel('Custom Coin').setEmoji('🪙').setStyle(ButtonStyle.Primary));
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
        const me = await resolveMe(guild);
        if (!me)
          return interaction.editReply({ content: '⚠️ I couldn\'t read my own permissions in this server. Try again in a moment, or ask an admin to re-invite me.' });
        if (!me.permissions.has('ManageRoles'))
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
      // Booster Custom Coin upload
      if (interaction.isButton() && interaction.customId === 'boost:coin') {
        if (!isBoosting(interaction)) return interaction.reply({ content: '⭐ Custom coins are a booster-only perk.', flags: 64 });
        return startCoinFlow(interaction);
      }
      if (interaction.isButton() && interaction.customId === 'hub:coinCancel') {
        const sess = coinSessions.get(uid);
        if (sess) { sess.done = true; sess.collector.stop('cancel'); coinSessions.delete(uid); }
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
        // Alert the clan's leader + officers in the alerts channel (and/or clan channel)
        const clan = db[gid][cname];
        if (clan) {
          const officers = [clan.leader, ...(clan.officers || [])].filter(Boolean);
          await clanAlert(
            interaction.guild, clan,
            `📥 ${officers.map(id => `<@${id}>`).join(' ')} — <@${uid}> has requested to join **${esc(cname)}**!\nApprove or decline via \`/hub\` → Clan → 📥 Join Requests.`,
            officers.concat(uid),
            interaction.channel,
          );
        }
        const msg = res.replaced && !res.sameClan ? ` (replaced your request to ${esc(res.replaced)})` : '';
        return interaction.update({ content: `📤 Request sent to **${esc(cname)}**${msg}! You'll be added — and charged **${fmt(clans.CLAN_JOIN_COST)} Dinar** — once a Leader or Officer accepts. No charge if declined.`, embeds: [], components: [backHubOnly()], files: [], attachments: [] });
      }
      // dashboard sub-views
      if (interaction.isButton() && interaction.customId === 'clan:members') return interaction.update(clanMembersView(gid, uid));
      if (interaction.isButton() && interaction.customId === 'clan:settings') return interaction.update(clanSettingsView(gid, uid));
      if (interaction.isButton() && interaction.customId === 'clan:manage')   return interaction.update(clanManageView(gid, uid));
      if (interaction.isButton() && interaction.customId === 'clan:requests')  return interaction.update(clanRequestsView(gid, uid));
      if (interaction.isButton() && interaction.customId === 'clan:wars')      return interaction.update(clanWarsView(gid, uid));

      // war: challenge a chosen clan
      if (interaction.isStringSelectMenu() && interaction.customId === 'clan:warPick') {
        if (!warApi) return interaction.reply({ content: 'Wars are unavailable right now.', flags: 64 });
        const mine = clans.userClan(db, gid, uid);
        if (!mine) return interaction.update(clanEntryView(gid, uid));
        const defenderName = interaction.values[0];
        await interaction.deferUpdate();
        const res = await warApi.challenge(interaction.guild, interaction.channel, mine.name, defenderName, uid);
        if (res.error) return interaction.editReply(Object.assign(clanWarsView(gid, uid), { content: `⚠️ ${res.error}` }));
        setAction(uid, `⚔️ Challenged **${esc(defenderName)}** to a clan war.`);
        return interaction.editReply(Object.assign(clanWarsView(gid, uid), { content: `⚔️ Challenge sent to **${esc(defenderName)}**! They have 2 minutes to respond.` }));
      }
      // war: accept (this launches the actual war engine in the channel)
      if (interaction.isButton() && interaction.customId === 'clan:warAccept') {
        if (!warApi) return interaction.reply({ content: 'Wars are unavailable right now.', flags: 64 });
        const mine = clans.userClan(db, gid, uid);
        if (!mine) return interaction.update(clanEntryView(gid, uid));
        await interaction.update(Object.assign(clanDashboard(gid, uid), { content: '⚔️ War accepted — head to the channel, it\'s starting now!' }));
        const res = await warApi.accept(interaction.guild, interaction.channel, mine.name, uid);
        if (res && res.error) return interaction.followUp({ content: `⚠️ ${res.error}`, flags: 64 }).catch(() => {});
        setAction(uid, `⚔️ Accepted a clan war.`);
        return;
      }
      // war: decline
      if (interaction.isButton() && interaction.customId === 'clan:warDecline') {
        if (!warApi) return interaction.reply({ content: 'Wars are unavailable right now.', flags: 64 });
        const mine = clans.userClan(db, gid, uid);
        if (!mine) return interaction.update(clanEntryView(gid, uid));
        await interaction.deferUpdate();
        const res = await warApi.decline(interaction.guild, mine.name, uid);
        if (res.error) return interaction.editReply(Object.assign(clanWarsView(gid, uid), { content: `⚠️ ${res.error}` }));
        setAction(uid, `🏳️ Declined a war challenge.`);
        interaction.channel.send(`🏳️ **${esc(mine.name)}** declined the war challenge from **${esc(res.challengerName)}**.`).catch(() => {});
        return interaction.editReply(Object.assign(clanWarsView(gid, uid), { content: `🏳️ You declined the challenge from **${esc(res.challengerName)}**.` }));
      }

      // ═══════════════ COLLECTION HANDLERS ═══════════════
      if (interaction.isButton() && interaction.customId === 'hub:collection') return interaction.update(collectionHome(gid, uid));
      // Exchange Rate — shows the last pulled rates instantly (no refresh)
      if (interaction.isButton() && interaction.customId === 'hub:exchange') {
        if (!exchangeView) return interaction.reply({ content: 'The exchange rate feature isn\'t available right now.', flags: 64 });
        await interaction.deferUpdate();
        let view;
        try { view = await exchangeView(db, gid); }
        catch (e) { view = null; }
        if (!view) {
          return interaction.editReply({ content: '💱 No exchange rate has been saved yet — an admin needs to set it up with `/exchange-set-channel` first.', embeds: [], components: [backHubOnly()], files: [], attachments: [] });
        }
        // append a back-to-hub row beneath the currency chart buttons (respecting the 5-row max)
        const rows = (view.components || []).slice(0, 4);
        rows.push(new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('hub:home').setLabel('← Back to Hub').setStyle(ButtonStyle.Secondary)));
        return interaction.editReply({ content: '', embeds: view.embeds, files: view.files || [], attachments: [], components: rows });
      }
      // ─── PROFILE CARD HANDLERS ──────────────────────────────────────────
      if (interaction.isButton() && interaction.customId === 'hub:profile') {
        if (!profileApi) return interaction.reply({ content: 'Profiles aren\'t available right now.', flags: 64 });
        await interaction.deferUpdate();
        try {
          const member = interaction.member || await interaction.guild.members.fetch(uid);
          return interaction.editReply(await profileHomeView(gid, member));
        } catch (e) {
          console.error('[profile] home failed:', e.message);
          return interaction.editReply({ content: '⚠️ Couldn\'t render your card. Try again in a moment.', embeds: [], components: [backHubOnly()], files: [], attachments: [] });
        }
      }
      if (interaction.isButton() && interaction.customId.startsWith('prof:shop:')) {
        if (!profileApi) return interaction.reply({ content: 'Unavailable.', flags: 64 });
        const slot = interaction.customId.split(':')[2];
        return interaction.update(profileShopView(gid, uid, slot));
      }
      // ── EDITOR ──
      if (interaction.isButton() && interaction.customId === 'prof:edit') {
        if (!profileApi) return interaction.reply({ content: 'Unavailable.', flags: 64 });
        await interaction.deferUpdate();
        const member = interaction.member || await interaction.guild.members.fetch(uid);
        return interaction.editReply(await profileEditorView(gid, member));
      }
      if (interaction.isStringSelectMenu() && interaction.customId === 'prof:sel') {
        profileSel.set(uid, interaction.values[0]);
        await interaction.deferUpdate();
        const member = interaction.member || await interaction.guild.members.fetch(uid);
        return interaction.editReply(await profileEditorView(gid, member));
      }
      if (interaction.isButton() && interaction.customId === 'prof:step') {
        const cur = moveStep.get(uid) || 80;
        // cycle 1x → 5x → 20x → 50x → 80x → 120x → 1x  (value = pixels moved per nudge)
        const next = cur === 1 ? 5 : cur === 5 ? 20 : cur === 20 ? 50 : cur === 50 ? 80 : cur === 80 ? 120 : 1;
        moveStep.set(uid, next);
        await interaction.deferUpdate();
        const member = interaction.member || await interaction.guild.members.fetch(uid);
        return interaction.editReply(await profileEditorView(gid, member));
      }
      if (interaction.isButton() && interaction.customId.startsWith('prof:mv:')) {
        const dir = interaction.customId.split(':')[2];
        const selId = profileSel.get(uid);
        if (selId) {
          const el = profileApi.getElement(gid, uid, selId);
          if (el) {
            const step = moveStep.get(uid) || 80;
            const patch = {};
            if (dir === 'up') patch.y = el.y - step;
            if (dir === 'down') patch.y = el.y + step;
            if (dir === 'left') patch.x = el.x - step;
            if (dir === 'right') patch.x = el.x + step;
            profileApi.updateElement(gid, uid, selId, patch);
          }
        }
        await interaction.deferUpdate();
        const member = interaction.member || await interaction.guild.members.fetch(uid);
        return interaction.editReply(await profileEditorView(gid, member));
      }
      if (interaction.isButton() && interaction.customId.startsWith('prof:sz:')) {
        const dir = interaction.customId.split(':')[2];
        const selId = profileSel.get(uid);
        if (selId) {
          const el = profileApi.getElement(gid, uid, selId);
          if (el) {
            const f = dir === 'up' ? 1.15 : 0.87;
            const patch = { w: Math.round(el.w * f), h: Math.round(el.h * f) };
            // text-based elements scale their font size too
            if (el.type === 'text' || el.type === 'name' || el.type === 'clan') patch.data = { size: Math.max(10, Math.round((el.data?.size || 30) * f)) };
            profileApi.updateElement(gid, uid, selId, patch);
          }
        }
        await interaction.deferUpdate();
        const member = interaction.member || await interaction.guild.members.fetch(uid);
        return interaction.editReply(await profileEditorView(gid, member));
      }
      if (interaction.isButton() && interaction.customId === 'prof:rot') {
        const selId = profileSel.get(uid);
        if (selId) { const el = profileApi.getElement(gid, uid, selId); if (el) profileApi.updateElement(gid, uid, selId, { rot: (el.rot || 0) + 15 }); }
        await interaction.deferUpdate();
        const member = interaction.member || await interaction.guild.members.fetch(uid);
        return interaction.editReply(await profileEditorView(gid, member));
      }
      if (interaction.isButton() && interaction.customId === 'prof:layer:front') {
        const selId = profileSel.get(uid);
        if (selId) profileApi.reorderElement(gid, uid, selId, 'front');
        await interaction.deferUpdate();
        const member = interaction.member || await interaction.guild.members.fetch(uid);
        return interaction.editReply(await profileEditorView(gid, member));
      }
      if (interaction.isButton() && interaction.customId === 'prof:del') {
        const selId = profileSel.get(uid);
        if (selId) { profileApi.removeElement(gid, uid, selId); profileSel.delete(uid); }
        await interaction.deferUpdate();
        const member = interaction.member || await interaction.guild.members.fetch(uid);
        return interaction.editReply(await profileEditorView(gid, member, '🗑️ Element deleted.'));
      }
      if (interaction.isButton() && interaction.customId === 'prof:reset') {
        profileApi.resetLayout(gid, uid); profileSel.delete(uid);
        await interaction.deferUpdate();
        const member = interaction.member || await interaction.guild.members.fetch(uid);
        return interaction.editReply(await profileEditorView(gid, member, '♻️ Card reset to the default template.'));
      }
      if (interaction.isButton() && interaction.customId === 'prof:add:text') {
        const fontList = profileApi.FONTS.map(f => f.key).join(' / ');
        const modal = new ModalBuilder().setCustomId('prof:textModal:new').setTitle('Add Text');
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('t').setLabel('Text').setStyle(TextInputStyle.Short).setMaxLength(40).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('c').setLabel('Colour hex (e.g. #fbbf24) — optional').setStyle(TextInputStyle.Short).setMaxLength(7).setRequired(false)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('sz').setLabel('Size 10-80 — optional (default 30)').setStyle(TextInputStyle.Short).setMaxLength(2).setRequired(false)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('f').setLabel('Font — optional').setStyle(TextInputStyle.Short).setMaxLength(8).setRequired(false).setPlaceholder(fontList.slice(0, 100))));
        return interaction.showModal(modal);
      }
      // Border picker — all frames are free; equips the chosen one on the card
      if (interaction.isButton() && interaction.customId === 'prof:border') {
        if (!profileApi) return interaction.reply({ content: 'Unavailable.', flags: 64 });
        const current = profileApi.getEquipped(gid, uid).frame;
        const frames = profileApi.CATALOGUE.frame || [];
        const menu = new StringSelectMenuBuilder().setCustomId('prof:borderPick').setPlaceholder('Choose a border…')
          .addOptions(frames.slice(0, 25).map(fr => ({
            label: fr.name, value: fr.key,
            description: fr.anim ? 'Animated' : fr.key === 'none' ? 'No border' : 'Free',
            emoji: fr.key === current ? '✅' : '🖼️',
            default: fr.key === current,
          })));
        return interaction.reply({ content: '🖼️ Pick a border for your card (all free):', components: [new ActionRowBuilder().addComponents(menu)], flags: 64 });
      }
      if (interaction.isStringSelectMenu() && interaction.customId === 'prof:borderPick') {
        profileApi.equipItem(gid, uid, 'frame', interaction.values[0]);
        const fr = profileApi.catalogueItem('frame', interaction.values[0]);
        await interaction.update({ content: `✅ Border set to **${fr ? fr.name : interaction.values[0]}** — reopen the editor to see it.`, components: [] });
        return;
      }
      if (interaction.isButton() && interaction.customId === 'prof:add:stat') {
        // dropdown of things to add: profile pieces (avatar/name/clan) + live stats
        const specials = [
          { label: 'Profile Avatar', value: '__avatar', emoji: '🖼️', description: 'Your Discord avatar (circular)' },
          { label: 'Profile Name', value: '__name', emoji: '🏷️', description: 'Your display name' },
          { label: 'Clan (name & rank)', value: '__clan', emoji: '⚔️', description: 'Your clan and rank' },
        ];
        const statOpts = profileApi.STAT_KEYS.map(k => ({ label: profileApi.STAT_DEFS[k].label, value: k, emoji: '📊' }));
        const menu = new StringSelectMenuBuilder().setCustomId('prof:addStatPick').setPlaceholder('Add a profile piece or a stat…')
          .addOptions([...specials, ...statOpts].slice(0, 25));
        return interaction.reply({ content: 'Pick something to place on your card:', components: [new ActionRowBuilder().addComponents(menu)], flags: 64 });
      }
      if (interaction.isStringSelectMenu() && interaction.customId === 'prof:addStatPick') {
        const v = interaction.values[0];
        let el;
        if (v === '__avatar') el = profileApi.addElement(gid, uid, 'avatar', {});
        else if (v === '__name') el = profileApi.addElement(gid, uid, 'name', { color: '#ffffff', size: 40 });
        else if (v === '__clan') el = profileApi.addElement(gid, uid, 'clan', { color: '#a5b4fc', size: 18 });
        else {
          el = profileApi.addElement(gid, uid, 'stat', { stat: v });
          // list-style stats need room for several lines
          if (v === 'cities') profileApi.updateElement(gid, uid, el.id, { w: 300, h: 116 });
        }
        profileSel.set(uid, el.id);
        const label = v === '__avatar' ? 'Avatar' : v === '__name' ? 'Name' : v === '__clan' ? 'Clan' : 'Stat';
        await interaction.update({ content: `✅ ${label} added — go back to the editor to position it.`, components: [] });
        return;
      }
      if (interaction.isButton() && interaction.customId === 'prof:add:sticker') {
        return interaction.reply({ content: '🖼️ **To add a sticker or image:** upload an image in this channel with the message text `!cardimg` (as the caption). I\'ll add it to your card automatically. Then reopen the editor to position it.\n\n*Tip: PNG with transparency works best for stickers.*', flags: 64 });
      }
      // Manage Images: list uploaded images, delete them (frees the cap), or set one as banner
      // "Upload Image" button — arms a short window, then the user just posts an image
      // in the channel (no caption needed). Also works via the !cardimg caption anytime.
if (interaction.isButton() && interaction.customId === 'prof:upload') {
  if (!profileApi) {
    return interaction.reply({
      content: 'Unavailable.',
      flags: 64
    }).catch(() => {});
  }

  const used = profileApi.imageCount(gid, uid);

  if (used >= profileApi.MAX_IMAGES) {
    return interaction.reply({
      content: `🚫 You're at the max of **${profileApi.MAX_IMAGES} images**. Delete one in **Edit Layout → Manage Images** first.`,
      flags: 64
    }).catch(() => {});
  }

  // Arm the upload window before acknowledging the interaction
  awaitingUpload.set(uid, Date.now() + UPLOAD_WINDOW_MS);

  try {
    await interaction.reply({
      content: `📤 **Ready for your image!**\n\n**Easiest way:** run **\`/profile-image\`** and attach your picture — that works in every channel, even ones where you can't type.\n\nOr, within the next **2 minutes**, just drag an image into any channel you can post in and send it (no caption needed).\n\n*PNG, JPG, GIF or WEBP, up to 8MB. You can also caption any image with \`!cardimg\` anytime.*`,
      flags: 64
    });
  } catch (err) {
    console.error('[profile] upload button reply failed:', err.message);
  }

  return;
}
      if (interaction.isButton() && interaction.customId === 'prof:images') {
        return interaction.reply(manageImagesView(gid, uid));
      }
      if (interaction.isStringSelectMenu() && interaction.customId === 'prof:imgDelete') {
        profileApi.removeUserImage(gid, uid, interaction.values[0]);
        return interaction.update(Object.assign(manageImagesView(gid, uid), { content: '🗑️ Image deleted — a slot is free again.' }));
      }
      if (interaction.isStringSelectMenu() && interaction.customId === 'prof:imgBanner') {
        const val = interaction.values[0];
        if (val === '__none__') { profileApi.setBanner(gid, uid, null); return interaction.update(Object.assign(manageImagesView(gid, uid), { content: '🖼️ Banner cleared — your background cosmetic shows again.' })); }
        profileApi.setBanner(gid, uid, val);
        return interaction.update(Object.assign(manageImagesView(gid, uid), { content: '🖼️ Banner set! It now fills your card background.' }));
      }
      if (interaction.isButton() && interaction.customId === 'prof:img:circle') {
        const selId = profileSel.get(uid);
        if (selId) { const el = profileApi.getElement(gid, uid, selId); if (el) profileApi.updateElement(gid, uid, selId, { data: { circle: !el.data?.circle } }); }
        await interaction.deferUpdate();
        const member = interaction.member || await interaction.guild.members.fetch(uid);
        return interaction.editReply(await profileEditorView(gid, member));
      }
      // Rename the selected element (gives it a friendly label in the picker)
      if (interaction.isButton() && interaction.customId === 'prof:rename') {
        const selId = profileSel.get(uid);
        const el = selId && profileApi.getElement(gid, uid, selId);
        if (!el) return interaction.reply({ content: 'Select an item first.', flags: 64 });
        const modal = new ModalBuilder().setCustomId('prof:renameModal').setTitle('Rename Item');
        modal.addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('n').setLabel('Item name (shown in the picker)').setStyle(TextInputStyle.Short).setMaxLength(30).setRequired(true).setValue(el.data?.name || '')));
        return interaction.showModal(modal);
      }
      if (interaction.isModalSubmit() && interaction.customId === 'prof:renameModal') {
        const selId = profileSel.get(uid);
        const nm = interaction.fields.getTextInputValue('n').trim().slice(0, 30);
        if (selId) profileApi.updateElement(gid, uid, selId, { data: { name: nm } });
        await interaction.deferUpdate().catch(()=>{});
        const member = interaction.member || await interaction.guild.members.fetch(uid);
        return interaction.editReply(await profileEditorView(gid, member));
      }
      if (interaction.isButton() && interaction.customId === 'prof:text:edit') {
        const selId = profileSel.get(uid);
        const el = selId && profileApi.getElement(gid, uid, selId);
        if (!el) return interaction.reply({ content: 'Select a text element first.', flags: 64 });
        const fontList = profileApi.FONTS.map(f => f.key).join(' / ');
        const modal = new ModalBuilder().setCustomId('prof:textModal:edit').setTitle('Edit Text');
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('t').setLabel('Text').setStyle(TextInputStyle.Short).setMaxLength(40).setRequired(true).setValue(el.data?.text || '')),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('c').setLabel('Colour hex (e.g. #fbbf24)').setStyle(TextInputStyle.Short).setMaxLength(7).setRequired(false).setValue(el.data?.color || '')),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('sz').setLabel('Size 10-80').setStyle(TextInputStyle.Short).setMaxLength(2).setRequired(false).setValue(String(el.data?.size || 30))),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('f').setLabel('Font').setStyle(TextInputStyle.Short).setMaxLength(8).setRequired(false).setValue(el.data?.font || 'sans').setPlaceholder(fontList.slice(0,100))));
        return interaction.showModal(modal);
      }
      if (interaction.isModalSubmit() && interaction.customId.startsWith('prof:textModal:')) {
        const mode = interaction.customId.split(':')[2];
        const text = interaction.fields.getTextInputValue('t');
        const colorRaw = (interaction.fields.getTextInputValue('c') || '').trim();
        const color = /^#?[0-9a-fA-F]{6}$/.test(colorRaw) ? (colorRaw.startsWith('#') ? colorRaw : '#'+colorRaw) : undefined;
        const validFonts = profileApi.FONTS.map(f => f.key);
        let font;
        try { const fr = (interaction.fields.getTextInputValue('f') || '').trim().toLowerCase(); if (validFonts.includes(fr)) font = fr; } catch { /* no field */ }
        let size;
        try { const sr = parseInt(interaction.fields.getTextInputValue('sz'), 10); if (sr >= 10 && sr <= 80) size = sr; } catch { /* no field */ }
        await interaction.deferUpdate().catch(()=>{});
        if (mode === 'new') {
          const el = profileApi.addElement(gid, uid, 'text', { text, color: color || '#ffffff', size: size || 30, font: font || 'sans' });
          profileSel.set(uid, el.id);
        } else {
          const selId = profileSel.get(uid);
          if (selId) profileApi.updateElement(gid, uid, selId, { data: { text, ...(color?{color}:{}), ...(font?{font}:{}), ...(size?{size}:{}) } });
        }
        const member = interaction.member || await interaction.guild.members.fetch(uid);
        return interaction.editReply(await profileEditorView(gid, member));
      }
      if (interaction.isButton() && interaction.customId === 'prof:stat:change') {
        const menu = new StringSelectMenuBuilder().setCustomId('prof:statChange').setPlaceholder('Change this stat to…')
          .addOptions(profileApi.STAT_KEYS.map(k => ({ label: profileApi.STAT_DEFS[k].label, value: k })));
        return interaction.reply({ content: 'Pick the stat to show here:', components: [new ActionRowBuilder().addComponents(menu)], flags: 64 });
      }
      if (interaction.isStringSelectMenu() && interaction.customId === 'prof:statChange') {
        const selId = profileSel.get(uid);
        if (selId) profileApi.updateElement(gid, uid, selId, { data: { stat: interaction.values[0] } });
        return interaction.update({ content: '✅ Stat changed — reopen the editor to see it.', components: [] });
      }

      if (interaction.isStringSelectMenu() && interaction.customId.startsWith('prof:pick:')) {
        const slot = interaction.customId.split(':')[2];
        const key  = interaction.values[0];
        if (profileApi.isOwned(gid, uid, slot, key)) {
          profileApi.equipItem(gid, uid, slot, key);
          setAction(uid, `🪪 Equipped a new ${profileApi.SLOT_LABEL[slot].toLowerCase()}.`);
          return interaction.update(profileShopView(gid, uid, slot));
        }
        const res = profileApi.buy(gid, uid, slot, key);
        if (res.error) return interaction.update(Object.assign(profileShopView(gid, uid, slot), { content: `⚠️ ${res.error}` }));
        profileApi.equipItem(gid, uid, slot, key);   // auto-equip on purchase
        setAction(uid, `🪪 Bought & equipped **${res.item.name}**.`);
        return interaction.update(Object.assign(profileShopView(gid, uid, slot), { content: `✅ Bought & equipped **${res.item.name}**!` }));
      }
      if (interaction.isButton() && interaction.customId === 'prof:publish') {
        profileApi.setPublished(gid, uid, true);
        setAction(uid, '🌍 Published your profile to the showcase.');
        await interaction.deferUpdate();
        const member = interaction.member || await interaction.guild.members.fetch(uid);
        return interaction.editReply(await profileHomeView(gid, member));
      }
      if (interaction.isButton() && interaction.customId === 'prof:unpublish') {
        profileApi.setPublished(gid, uid, false);
        setAction(uid, '🙈 Removed your profile from the showcase.');
        await interaction.deferUpdate();
        const member = interaction.member || await interaction.guild.members.fetch(uid);
        return interaction.editReply(await profileHomeView(gid, member));
      }
      // Showcase: browse published cards, heart them. customId hub:showcase:<index>
      if (interaction.isButton() && interaction.customId.startsWith('hub:showcase:')) {
        if (!profileApi) return interaction.reply({ content: 'Unavailable.', flags: 64 });
        const idx = parseInt(interaction.customId.split(':')[2], 10) || 0;
        await interaction.deferUpdate();
        return interaction.editReply(await showcaseView(gid, uid, idx, interaction.guild));
      }
      // Heart from a /profile card. New heart → PUBLIC confirmation. Already hearted →
      // PRIVATE "you already hearted" message. Never un-hearts (add-only). The public
      // /profile message itself is never edited.
      if (interaction.isButton() && interaction.customId.startsWith('prof:heartp:')) {
        const targetId = interaction.customId.split(':')[2];
        if (targetId === uid) return interaction.reply({ content: '😅 You can\'t heart your own profile!', flags: 64 });
        if (profileApi.hasHearted(gid, targetId, uid)) {
          return interaction.reply({ content: `💗 You've already hearted <@${targetId}>'s profile.`, flags: 64 });
        }
        const { total } = profileApi.toggleHeart(gid, targetId, uid);   // adds the heart
        return interaction.reply({
          content: `❤️ <@${uid}> hearted <@${targetId}>'s profile! They now have **${fmt(total)}** heart${total===1?'':'s'}.`,
          // public (no ephemeral flag)
        });
      }
      if (interaction.isButton() && interaction.customId.startsWith('prof:heart:')) {
        const targetId = interaction.customId.split(':')[2];
        const idx = parseInt(interaction.customId.split(':')[3], 10) || 0;
        if (targetId === uid) return interaction.reply({ content: '😅 You can\'t heart your own card!', flags: 64 });
        const { hearted, total } = profileApi.toggleHeart(gid, targetId, uid);
        await interaction.deferUpdate();
        const view = await showcaseView(gid, uid, idx, interaction.guild);
        return interaction.editReply(Object.assign(view, { content: hearted ? `❤️ You hearted this card! (${fmt(total)} total)` : `💔 Heart removed. (${fmt(total)} total)` }));
      }

      if (interaction.isButton() && interaction.customId === 'col:mine')       return interaction.update(myCardsView(gid, uid));
      if (interaction.isButton() && interaction.customId === 'col:wishlist')   return interaction.update(wishlistView(gid, uid));
      if (interaction.isButton() && interaction.customId === 'col:boardCollectors') return interaction.update(boardView(gid, 'collectors'));
      if (interaction.isButton() && interaction.customId === 'col:boardRichest')    return interaction.update(boardView(gid, 'richest'));
      if (interaction.isButton() && interaction.customId === 'col:rarest')          return interaction.update(boardView(gid, 'rarest'));
      if (interaction.isButton() && interaction.customId === 'col:daily') {
        if (!gachaApi) return interaction.reply({ content: 'Unavailable right now.', flags: 64 });
        const res = gachaApi.claimDaily(gid, uid);
        if (res.error === 'cooldown') return interaction.reply({ content: `⏳ Already claimed — come back in ${gachaApi.fmtDur(res.retryMs)}.`, flags: 64 });
        setAction(uid, `🎁 Claimed daily — +${fmt(res.total)} Dinar.`);
        return interaction.update(Object.assign(collectionHome(gid, uid), { content: `💰 Daily claimed: **+${fmt(res.total)} Dinar** (${fmt(res.base)} base${res.bonus ? ` + ${fmt(res.bonus)} collection bonus` : ''})! Balance: **${fmt(res.balance)}**.` }));
      }
      if (interaction.isStringSelectMenu() && interaction.customId === 'col:wishRemove') {
        gachaApi.removeWish(gid, uid, interaction.values[0]);
        setAction(uid, `⭐ Updated wishlist.`);
        return interaction.update(wishlistView(gid, uid));
      }

      // accept / decline a join request
      if (interaction.isButton() && interaction.customId.startsWith('clan:reqAccept:')) {
        const requesterId = interaction.customId.split(':')[2];
        await interaction.deferUpdate();
        const res = await clans.acceptRequest(db, saveData, interaction.guild, uid, requesterId, clans.CLAN_JOIN_COST, getDinar, spendDinar);
        if (res.error) return interaction.editReply(Object.assign(clanRequestsView(gid, uid), { content: `⚠️ ${res.error}` }));
        setAction(uid, `✅ Accepted <@${requesterId}> into the clan.`);
        const clan = db[gid][res.clanName];
        await clanAlert(
          interaction.guild, clan,
          `🎉 <@${requesterId}> has been accepted into **${esc(res.clanName)}**! Welcome!` + (res.roleWarning ? `\n⚠️ (${res.roleWarning})` : ''),
          [requesterId],
          interaction.channel,
        );
        return interaction.editReply(Object.assign(clanRequestsView(gid, uid), res.roleWarning ? { content: `✅ Accepted <@${requesterId}> — but ${res.roleWarning}` } : {}));
      }
      if (interaction.isButton() && interaction.customId.startsWith('clan:reqDecline:')) {
        const requesterId = interaction.customId.split(':')[2];
        await interaction.deferUpdate();
        const res = clans.declineRequest(db, saveData, interaction.guild, uid, requesterId);
        if (res.error) return interaction.editReply(Object.assign(clanRequestsView(gid, uid), { content: `⚠️ ${res.error}` }));
        setAction(uid, `❌ Declined <@${requesterId}>'s join request.`);
        const clan = db[gid][res.clanName];
        await clanAlert(
          interaction.guild, clan,
          `<@${requesterId}>, your request to join **${esc(res.clanName)}** was declined. No Dinar was charged.`,
          [requesterId],
          interaction.channel,
        );
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
        const me = await resolveMe(guild);
        if (!me)
          return interaction.editReply({ content: '⚠️ I couldn\'t read my own permissions in this server. Try again in a moment, or ask an admin to re-invite me.' });
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
    } catch (e) {
      console.error('[hub interaction]', e.message, (e.stack || '').split('\n')[1] || '');
      // Without this the interaction is simply abandoned: if it was already deferred the
      // user sits on "thinking..." until Discord gives up minutes later. Always close the
      // loop, using whichever reply method is still valid for this interaction's state.
      const msg = '⚠️ Something went wrong there. Please try again — if it keeps happening, let an admin know.';
      try {
        if (interaction.deferred && !interaction.replied) await interaction.editReply({ content: msg });
        else if (!interaction.replied) await interaction.reply({ content: msg, flags: 64 });
        else await interaction.followUp({ content: msg, flags: 64 });
      } catch { /* interaction expired or already resolved — nothing more we can do */ }
    }
  });

  return { _test: {
    stateOf: () => stateOf, grantRole, sweep, nameProblem, paletteSwatch, choicePreview,
    renderSwatch, SOLID_COLORS, SOLID_BRIGHT, SOLID_SOFT, GRADIENTS, solidByKey, gradByKey,
    PRICE_SOLID, PRICE_GRADIENT, ROLE_LIFETIME_MS, ICON_PRICE, fetchIconBuffer, startIconFlow, iconSessions,
    doCheckIn, streakStatus, streakLeaderboard, streakReward, streakView, libyaDayNumber, parseHex, helpPages, helpRow,
  } };
}

module.exports = { getShopCommands, initShop };
