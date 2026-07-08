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
  TextInputBuilder, TextInputStyle,
} = require('discord.js');
const path = require('path');
const fs = require('fs');
const { Resvg } = require('@resvg/resvg-js');
const { getDinar, spendDinar, awardDinar } = require('./gacha');

// ── prices & lifetime ──
const PRICE_SOLID    = 800;
const PRICE_GRADIENT = 1500;
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
      // Discord holographic is a fixed preset — request the holographic style; fall back to a plain role
      try { role = await guild.roles.create({ ...baseOpts, colors: { primaryColor: 0xeb459f, secondaryColor: 0x5865f2, tertiaryColor: 0x57f287 } }); }
      catch (e) { usedFallback = true; role = await guild.roles.create({ ...baseOpts, color: 0xeb459f }); }
    } else if (kind === 'gradient' || kind === 'customGrad') {
      const a = kind === 'customGrad' ? hexA : grad.a;
      const b = kind === 'customGrad' ? hexB : grad.b;
      try { role = await guild.roles.create({ ...baseOpts, colors: { primaryColor: a, secondaryColor: b } }); }
      catch (e) { usedFallback = true; role = await guild.roles.create({ ...baseOpts, color: a }); }
    } else if (kind === 'customSolid') {
      role = await guild.roles.create({ ...baseOpts, color: hex });
    } else {
      role = await guild.roles.create({ ...baseOpts, color: solid.hex });
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

  const hubEmbed = (isBooster) => new EmbedBuilder().setColor(0xE7B41A).setTitle('🏛️ The Community Hub')
    .setDescription(
      `Welcome! Pick an option below:\n\n` +
      `🎨 **Custom Roles** — a personalised, colour or gradient role, your name on it\n` +
      `🪙 **Coin Flip** — bet your Dinar on a flip of the coin\n` +
      `🔥 **Daily Streak** — check in every day for a growing Dinar reward\n` +
      `⭐ **Booster Perks** — ${isBooster ? '**unlocked!** free holographic & custom-hex roles' : '_boost the server to unlock free premium roles_'}\n\n` +
      `*More coming soon…*`);
  const hubRow = (isBooster) => new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('hub:roles').setLabel('Custom Roles').setEmoji('🎨').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('hub:flip').setLabel('Coin Flip').setEmoji('🪙').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('hub:streak').setLabel('Daily Streak').setEmoji('🔥').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('hub:booster').setLabel(isBooster ? 'Booster Perks' : 'Booster Perks (boost to unlock)').setEmoji('⭐').setStyle(ButtonStyle.Secondary).setDisabled(!isBooster),
    new ButtonBuilder().setCustomId('hub:help').setLabel('Help').setEmoji('❓').setStyle(ButtonStyle.Secondary));
  const backHubRow = () => new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('hub:home').setLabel('← Back to Hub').setStyle(ButtonStyle.Secondary));

  // roles section
  const rolesEmbed = (guildId, userId) => {
    const rec = stateOf(guildId).roles[userId];
    const owned = rec ? `\n\n🎟️ You currently own **${esc(rec.label)}** — expires <t:${Math.round(rec.expiresAt / 1000)}:R>. Buying again replaces it.` : '';
    return new EmbedBuilder().setColor(0xE7B41A).setTitle('🎨 Custom Roles')
      .setDescription(
        `Stand out with your own custom-named role!\n\n` +
        `🎨 **Custom Solid Role** — pick a name + a colour · **${fmt(PRICE_SOLID)} Dinar**\n` +
        `🌈 **Gradient Role** — pick a name + a gradient combo · **${fmt(PRICE_GRADIENT)} Dinar**\n\n` +
        `⏳ *Both roles last **1 month**, then are removed automatically. Re-buy anytime to refresh.*${owned}`)
      .setImage('attachment://palette.png');
  };
  const rolesRow = () => new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('shop:solid').setLabel(`Custom Solid — ${fmt(PRICE_SOLID)}`).setEmoji('🎨').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('shop:grad').setLabel(`Gradient — ${fmt(PRICE_GRADIENT)}`).setEmoji('🌈').setStyle(ButtonStyle.Success));

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
        { name: '🎨 Custom Roles', value: ['Buy a personalised, custom-named role:', '• **Solid** — pick from 48 colours · **800 Dinar**', '• **Gradient** — preset combos · **1,500 Dinar**', 'Both last **1 month**, then renew from `/hub`.'].join('\n') },
        { name: '🪙 Coin Flip', value: 'Bet **1–500 Dinar** on heads or tails, straight from the hub — the flip plays out publicly in the channel. One flip every 2h.' },
        { name: '🔥 Daily Streak', value: ['Check in once a day for a growing reward: **20 + 5 per day**, up to **100 Dinar**.', 'Miss a day and it resets. A leaderboard ranks the longest streaks.'].join('\n') },
        { name: '⭐ Booster Perks', value: ['**Boosters only** — free premium roles:', '• ✨ **Holographic** — Discord\'s shimmer style', '• 🎨 **Custom Solid** — any colour by hex code', '• 🌈 **Custom Gradient** — blend any two hex colours', 'These stay while you keep boosting, and you can change them free anytime.'].join('\n') },
      ], 'Your one-stop hub — open it with **`/hub`**.'),
    ];
    return pages;
  }
  const helpRow = (page, total) => new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`hub:help:${page - 1}`).setLabel('◀ Previous').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId(`hub:help:${page + 1}`).setLabel('Next ▶').setStyle(ButtonStyle.Primary).setDisabled(page === total - 1),
    new ButtonBuilder().setCustomId('hub:home').setLabel('← Back to Hub').setStyle(ButtonStyle.Secondary));

  // ═══════════════ INTERACTIONS ═══════════════
  client.on('interactionCreate', async (interaction) => {
    try {
      // /hub
      if (interaction.isChatInputCommand() && interaction.commandName === 'hub') {
        if (!interaction.guildId) return interaction.reply({ content: 'Use this in the server.', flags: 64 });
        const boosting = isBoosting(interaction);
        return interaction.reply({ embeds: [hubEmbed(boosting)], components: [hubRow(boosting)], flags: 64 });
      }
      if (!interaction.guildId) return;
      const gid = interaction.guildId, uid = interaction.user.id;
      const name = interaction.member?.displayName || interaction.user.username;

      // hub navigation
      if (interaction.isButton() && interaction.customId === 'hub:home') {
        const boosting = isBoosting(interaction);
        return interaction.update({ embeds: [hubEmbed(boosting)], components: [hubRow(boosting)], files: [], attachments: [] });
      }
      if (interaction.isButton() && interaction.customId === 'hub:roles') {
        const png = renderSwatch(paletteSwatch());
        return interaction.update({ embeds: [rolesEmbed(gid, uid)], components: [rolesRow(), backHubRow()],
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
            `Thank you for boosting! 💜 As a booster you get these **free** roles:\n\n` +
            `✨ **Holographic Role** — Discord's shimmering holographic style\n` +
            `🎨 **Custom Solid** — any colour you like, by hex code (e.g. \`#0fc0fc\`)\n` +
            `🌈 **Custom Gradient** — blend any two hex colours\n\n` +
            `Just name it — no Dinar needed. Your booster role stays as long as you keep boosting, and you can change it for free anytime.`);
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('boost:holo').setLabel('Holographic').setEmoji('✨').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('boost:solid').setLabel('Custom Solid (hex)').setEmoji('🎨').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('boost:grad').setLabel('Custom Gradient (hex)').setEmoji('🌈').setStyle(ButtonStyle.Success));
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
        return interaction.editReply({ content: `✨ **${esc(rname)}** is yours — a free **${styleName}** booster role! <@&${res.role.id}> has been added.\n💜 It stays as long as you keep boosting. Change it anytime for free from \`/hub\` → Booster Perks.${fallbackLine}` });
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
        return interaction.followUp({ content: msg, flags: 64 }).catch(() => {});
      }

      // ── roles: choose colour category ──
      if (interaction.isButton() && interaction.customId === 'shop:solid') {
        await interaction.reply({ content: `🎨 **Custom Solid Role** — **${fmt(PRICE_SOLID)} Dinar**. Pick a colour from either list, then you'll name it.\n⏳ *Lasts 1 month.*`, components: [solidSelectBright(), solidSelectSoft()], flags: 64 });
        return;
      }
      if (interaction.isButton() && interaction.customId === 'shop:grad') {
        await interaction.reply({ content: `🌈 **Gradient Role** — **${fmt(PRICE_GRADIENT)} Dinar**. Pick your combo, then you'll name it.\n⏳ *Lasts 1 month.*`, components: [gradSelect()], flags: 64 });
        return;
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
        return interaction.editReply({
          content: `✅ **${esc(rname)}** is yours! <@&${res.role.id}> has been added to you.\n💰 Paid **${fmt(price)} Dinar** — new balance **${fmt(newBal)}**.\n⏳ **This role expires <t:${Math.round(res.expiresAt / 1000)}:R>** (in 1 month). Open \`/hub\` anytime to refresh or change it.${styleLine}` });
      }
    } catch (e) { console.error('[hub interaction]', e.message); }
  });

  return { _test: {
    stateOf: () => stateOf, grantRole, sweep, nameProblem, paletteSwatch, choicePreview,
    renderSwatch, SOLID_COLORS, SOLID_BRIGHT, SOLID_SOFT, GRADIENTS, solidByKey, gradByKey,
    PRICE_SOLID, PRICE_GRADIENT, ROLE_LIFETIME_MS,
    doCheckIn, streakStatus, streakLeaderboard, streakReward, streakView, libyaDayNumber, parseHex, helpPages, helpRow,
  } };
}

module.exports = { getShopCommands, initShop };
