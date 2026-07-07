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
const { getDinar, spendDinar } = require('./gacha');

// ── prices & lifetime ──
const PRICE_SOLID    = 800;
const PRICE_GRADIENT = 1500;
const ROLE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;   // 1 month
const NAME_MAX = 20;
const CHECK_EVERY_MS = 10 * 60 * 1000;               // expiry sweep cadence

// ── solid colour palette (Discord select caps at 25 options) ──
// a clean full-spectrum set + Libyan flag colours + neutrals
const SOLID_COLORS = [
  { key: 'flag_green', name: 'Libyan Green', hex: 0x239e46, emoji: '🟢' },
  { key: 'flag_red',   name: 'Libyan Red',   hex: 0xe70013, emoji: '🔴' },
  { key: 'crimson',    name: 'Crimson',      hex: 0xc0223b, emoji: '❤️' },
  { key: 'scarlet',    name: 'Scarlet',      hex: 0xff3b30, emoji: '🍎' },
  { key: 'orange',     name: 'Orange',       hex: 0xff7a1a, emoji: '🟠' },
  { key: 'amber',      name: 'Amber',        hex: 0xffb020, emoji: '🟡' },
  { key: 'gold',       name: 'Gold',         hex: 0xe7b41a, emoji: '🏆' },
  { key: 'lime',       name: 'Lime',         hex: 0x8bd450, emoji: '🍏' },
  { key: 'emerald',    name: 'Emerald',      hex: 0x1f8a3d, emoji: '🌿' },
  { key: 'teal',       name: 'Teal',         hex: 0x0fb5ae, emoji: '🩵' },
  { key: 'cyan',       name: 'Cyan',         hex: 0x27c4e5, emoji: '💧' },
  { key: 'sky',        name: 'Sky Blue',     hex: 0x3aa0ff, emoji: '🌤️' },
  { key: 'blue',       name: 'Royal Blue',   hex: 0x2e6bff, emoji: '🔵' },
  { key: 'indigo',     name: 'Indigo',       hex: 0x5b5bd6, emoji: '🌌' },
  { key: 'violet',     name: 'Violet',       hex: 0x8a5cf6, emoji: '🟣' },
  { key: 'purple',     name: 'Purple',       hex: 0xa133c8, emoji: '👑' },
  { key: 'magenta',    name: 'Magenta',      hex: 0xd53fb0, emoji: '🎀' },
  { key: 'pink',       name: 'Pink',         hex: 0xff77c8, emoji: '🌸' },
  { key: 'rose',       name: 'Rose',         hex: 0xff5d8f, emoji: '🌹' },
  { key: 'coral',      name: 'Coral',        hex: 0xff6f61, emoji: '🪸' },
  { key: 'sand',       name: 'Desert Sand',  hex: 0xd8b072, emoji: '🏜️' },
  { key: 'bronze',     name: 'Bronze',       hex: 0xb0793a, emoji: '🥉' },
  { key: 'slate',      name: 'Slate',        hex: 0x8a94a6, emoji: '🩶' },
  { key: 'white',      name: 'Snow White',   hex: 0xf2f3f5, emoji: '⚪' },
  { key: 'black',      name: 'Onyx',         hex: 0x2b2d31, emoji: '⚫' },
];

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

// ─────────────────────────────────────────────────────────────────────────────
// state helpers
// ─────────────────────────────────────────────────────────────────────────────
function shopState(db, guildId) {
  const data = db[guildId] || (db[guildId] = {});
  if (!data.__shop) data.__shop = { roles: {} };   // roles: { userId: { roleId, expiresAt, kind, label } }
  return data.__shop;
}

// ─────────────────────────────────────────────────────────────────────────────
// commands
// ─────────────────────────────────────────────────────────────────────────────
function getShopCommands() {
  return [
    new SlashCommandBuilder().setName('shop').setDescription('Buy a custom-named coloured role with Dinar').toJSON(),
  ];
}

function initShop({ client, db, saveData }) {
  const stateOf = (gid) => shopState(db, gid);

  // ── create (or recreate) a member's shop role, removing their previous one ──
  async function grantRole(guild, member, { kind, name, solid, grad }) {
    const state = stateOf(guild.id);
    // remove any existing shop role for this user first
    const prev = state.roles[member.id];
    if (prev) {
      const old = guild.roles.cache.get(prev.roleId) || await guild.roles.fetch(prev.roleId).catch(() => null);
      if (old) await old.delete('Shop role replaced').catch(() => {});
      delete state.roles[member.id];
      saveData(guild.id);
    }
    // build the colour options; try gradient first, fall back to solid on failure
    let role = null, usedFallback = false;
    const baseOpts = { name, hoist: false, mentionable: false, permissions: [], reason: `Shop purchase by ${member.user.tag}` };
    if (kind === 'gradient') {
      try {
        role = await guild.roles.create({ ...baseOpts, colors: { primaryColor: grad.a, secondaryColor: grad.b } });
      } catch (e) {
        // Enhanced Role Styles unavailable (or API rejected) → solid fallback using the primary colour
        usedFallback = true;
        role = await guild.roles.create({ ...baseOpts, color: grad.a });
      }
    } else {
      role = await guild.roles.create({ ...baseOpts, color: solid.hex });
    }
    // position just under the bot's highest role so the colour actually shows and can be assigned
    try {
      const me = guild.members.me;
      const top = me.roles.highest.position;
      await role.setPosition(Math.max(1, top - 1)).catch(() => {});
    } catch { /* best effort */ }
    await member.roles.add(role, 'Shop purchase').catch(() => { throw new Error('assign-failed'); });
    const expiresAt = Date.now() + ROLE_LIFETIME_MS;
    state.roles[member.id] = { roleId: role.id, expiresAt, kind, label: name };
    saveData(guild.id);
    return { role, usedFallback, expiresAt };
  }

  // ── expiry sweep: remove + delete roles whose month is up ──
  async function sweep() {
    const now = Date.now();
    for (const [gid] of client.guilds.cache) {
      const state = stateOf(gid);
      let changed = false;
      for (const [uid, rec] of Object.entries(state.roles)) {
        if (rec.expiresAt > now) continue;
        try {
          const guild = client.guilds.cache.get(gid);
          const role = guild.roles.cache.get(rec.roleId) || await guild.roles.fetch(rec.roleId).catch(() => null);
          if (role) await role.delete('Shop role expired').catch(() => {});
        } catch { /* ignore */ }
        delete state.roles[uid]; changed = true;
      }
      if (changed) saveData(gid);
    }
  }
  setInterval(() => sweep().catch(() => {}), CHECK_EVERY_MS);

  // ── UI builders ──
  const menuEmbed = (guildId, userId) => {
    const rec = stateOf(guildId).roles[userId];
    const owned = rec ? `\n\n🎟️ You currently own **${esc(rec.label)}** — expires <t:${Math.round(rec.expiresAt / 1000)}:R>. Buying again replaces it.` : '';
    return new EmbedBuilder().setColor(0xE7B41A).setTitle('🛒 The Souk — Custom Roles')
      .setDescription(
        `Stand out with your own custom-named coloured role!\n\n` +
        `🎨 **Custom Solid Role** — pick a name + a colour · **${fmt(PRICE_SOLID)} Dinar**\n` +
        `🌈 **Gradient Role** — pick a name + a gradient combo · **${fmt(PRICE_GRADIENT)} Dinar**\n\n` +
        `⏳ *Both roles last **1 month**, then are removed automatically. Re-buy anytime to refresh.*${owned}`);
  };
  const menuRow = () => new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('shop:solid').setLabel(`Custom Solid — ${fmt(PRICE_SOLID)}`).setEmoji('🎨').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('shop:grad').setLabel(`Gradient — ${fmt(PRICE_GRADIENT)}`).setEmoji('🌈').setStyle(ButtonStyle.Success));

  const solidSelect = () => new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('shop:pickSolid').setPlaceholder('Choose a colour…')
      .addOptions(SOLID_COLORS.map(c => ({ label: c.name, value: c.key, emoji: c.emoji }))));
  const gradSelect = () => new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('shop:pickGrad').setPlaceholder('Choose a gradient…')
      .addOptions(GRADIENTS.map(g => ({ label: g.name, value: g.key, emoji: g.emoji }))));

  function nameModal(kind, choiceKey) {
    return new ModalBuilder().setCustomId(`shop:name:${kind}:${choiceKey}`).setTitle('Name your role')
      .addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('rolename').setLabel(`Role name (max ${NAME_MAX} chars)`)
          .setStyle(TextInputStyle.Short).setMaxLength(NAME_MAX).setMinLength(2).setRequired(true)
          .setPlaceholder('e.g. Sultan of Tripoli')));
  }

  // ── interactions ──
  client.on('interactionCreate', async (interaction) => {
    try {
      if (interaction.isChatInputCommand() && interaction.commandName === 'shop') {
        if (!interaction.guildId) return interaction.reply({ content: 'Use this in the server.', flags: 64 });
        const png = renderSwatch(paletteSwatch());
        return interaction.reply({ embeds: [menuEmbed(interaction.guildId, interaction.user.id).setImage('attachment://palette.png')],
          components: [menuRow()], files: [new AttachmentBuilder(png, { name: 'palette.png' })], flags: 64 });
      }

      if (interaction.isButton() && interaction.customId === 'shop:solid') {
        return interaction.reply({ content: `🎨 **Custom Solid Role** — **${fmt(PRICE_SOLID)} Dinar**. Pick your colour, then you'll name it.\n⏳ *Lasts 1 month.*`, components: [solidSelect()], flags: 64 });
      }
      if (interaction.isButton() && interaction.customId === 'shop:grad') {
        return interaction.reply({ content: `🌈 **Gradient Role** — **${fmt(PRICE_GRADIENT)} Dinar**. Pick your combo, then you'll name it.\n⏳ *Lasts 1 month.*`, components: [gradSelect()], flags: 64 });
      }

      // colour picked → show a preview + a "name & buy" button that opens the modal
      if (interaction.isStringSelectMenu() && interaction.customId === 'shop:pickSolid') {
        const c = solidByKey(interaction.values[0]); if (!c) return;
        const png = renderSwatch(choicePreview({ name: '', solid: c }));
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`shop:buy:solid:${c.key}`).setLabel(`Name it & buy — ${fmt(PRICE_SOLID)} Dinar`).setEmoji('🎨').setStyle(ButtonStyle.Success));
        return interaction.update({ content: `Selected **${c.name}**. Tap below to name your role and buy it.\n⏳ *Lasts 1 month.*`,
          embeds: [], files: [new AttachmentBuilder(png, { name: 'preview.png' })], components: [row] });
      }
      if (interaction.isStringSelectMenu() && interaction.customId === 'shop:pickGrad') {
        const g = gradByKey(interaction.values[0]); if (!g) return;
        const png = renderSwatch(choicePreview({ name: '', grad: g }));
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`shop:buy:grad:${g.key}`).setLabel(`Name it & buy — ${fmt(PRICE_GRADIENT)} Dinar`).setEmoji('🌈').setStyle(ButtonStyle.Success));
        return interaction.update({ content: `Selected **${g.name}**. Tap below to name your role and buy it.\n⏳ *Lasts 1 month.*`,
          embeds: [], files: [new AttachmentBuilder(png, { name: 'preview.png' })], components: [row] });
      }

      // "name it & buy" → open the modal
      if (interaction.isButton() && interaction.customId.startsWith('shop:buy:')) {
        const [, , kind, choiceKey] = interaction.customId.split(':');
        return interaction.showModal(nameModal(kind, choiceKey));
      }

      // modal submitted → validate, charge, grant
      if (interaction.isModalSubmit() && interaction.customId.startsWith('shop:name:')) {
        const [, , kind, choiceKey] = interaction.customId.split(':');
        const name = interaction.fields.getTextInputValue('rolename').trim();
        const problem = nameProblem(name);
        if (problem) return interaction.reply({ content: `⚠️ ${problem}`, flags: 64 });
        const price = kind === 'gradient' || kind === 'grad' ? PRICE_GRADIENT : PRICE_SOLID;
        const gid = interaction.guildId, uid = interaction.user.id;
        const bal = getDinar(db, gid, uid);
        if (bal < price) return interaction.reply({ content: `💰 You need **${fmt(price)} Dinar** but only have **${fmt(bal)}**. Earn more and come back!`, flags: 64 });

        const solid = kind === 'solid' ? solidByKey(choiceKey) : null;
        const grad  = (kind === 'grad' || kind === 'gradient') ? gradByKey(choiceKey) : null;
        if (kind === 'solid' && !solid) return interaction.reply({ content: 'That colour is no longer available.', flags: 64 });
        if ((kind === 'grad' || kind === 'gradient') && !grad) return interaction.reply({ content: 'That gradient is no longer available.', flags: 64 });

        await interaction.deferReply({ flags: 64 });
        // permission / hierarchy guard
        const guild = interaction.guild;
        const me = guild.members.me;
        if (!me.permissions.has('ManageRoles'))
          return interaction.editReply({ content: '⚠️ I need the **Manage Roles** permission to do this. Ask an admin to grant it.' });

        const member = await guild.members.fetch(uid);
        let res;
        try {
          res = await grantRole(guild, member, { kind: (kind === 'grad' ? 'gradient' : kind), name, solid, grad });
        } catch (e) {
          if (e.message === 'assign-failed')
            return interaction.editReply({ content: '⚠️ I made the role but couldn\'t assign it — my role needs to sit **above** the new role. Ask an admin to move my role higher, then try again.' });
          console.error('[shop grant]', e.message);
          return interaction.editReply({ content: '⚠️ Something went wrong creating your role. No Dinar was taken — please try again.' });
        }
        // only charge once the role is safely assigned
        spendDinar(db, gid, uid, price, saveData);
        const newBal = getDinar(db, gid, uid);
        const styleLine = res.usedFallback
          ? `\n*(Gradient styling wasn't available right now, so it was applied as a solid colour — it'll upgrade automatically next time you re-buy while boosts are active.)*`
          : '';
        return interaction.editReply({
          content: `✅ **${esc(name)}** is yours! <@&${res.role.id}> has been added to you.\n💰 Paid **${fmt(price)} Dinar** — new balance **${fmt(newBal)}**.\n⏳ **This role expires <t:${Math.round(res.expiresAt / 1000)}:R>** (in 1 month). Visit \`/shop\` anytime to refresh or change it.${styleLine}` });
      }
    } catch (e) { console.error('[shop interaction]', e.message); }
  });

  return { _test: {
    stateOf: () => stateOf, grantRole, sweep, nameProblem, paletteSwatch, choicePreview,
    renderSwatch, SOLID_COLORS, GRADIENTS, solidByKey, gradByKey, PRICE_SOLID, PRICE_GRADIENT, ROLE_LIFETIME_MS,
  } };
}

module.exports = { getShopCommands, initShop };
