// ─────────────────────────────────────────────────────────────────────────────
// lottery.js — Daily Dinar Lottery Wheel
// Two unpredictable lotteries per day (11:00–23:00 Libya time, ≥2.5h apart).
// Users wager 1–500 Dinar via /dinar-lotto; odds are wager-weighted; winner
// takes the whole pool. Libyan-flag wheel rendered as animated GIFs.
// Wire-up in index.js:
//   const { getLottoCommands, initLotto } = require('./lottery');
//   commands.push(...getLottoCommands());
//   initLotto({ client, db, saveData });
// Requires: npm install gifenc   (plus existing @resvg/resvg-js, discord.js)
// ─────────────────────────────────────────────────────────────────────────────
const {
  SlashCommandBuilder, EmbedBuilder, AttachmentBuilder, PermissionFlagsBits,
} = require('discord.js');
const path = require('path');
const fs = require('fs');
const { Resvg } = require('@resvg/resvg-js');
const { GIFEncoder, quantize, applyPalette } = require('gifenc');
const { getDinar, spendDinar, awardDinar } = require('./gacha');

// ── rules ──
const WAGER_MIN        = 1;
const WAGER_MAX        = 500;
const LOTTO_DURATION_MS = 60 * 60 * 1000;   // each lottery runs for 1 hour
const REMIND_EVERY_MS  = 15 * 60 * 1000;    // channel reminder cadence
const PER_DAY          = 2;                 // lotteries per day
const WIN_START        = 11;                // Libya-time spawn window
const WIN_END          = 23;
const MIN_GAP_MS       = 150 * 60 * 1000;   // ≥2.5h between the two draws
const LIBYA_OFFSET_MS  = 2 * 3600 * 1000;   // UTC+2, no DST
const TICK_MS          = 60 * 1000;

// ── wheel look (flat, Libyan flag palette) ──
const WHEEL_SIZE = 300;
const COL_BG   = '#111214';
const COL_RIM  = '#3a3d42';
const COL_DARK = '#232428';
const COL_GREEN= '#1f8a3d';
const COL_RED  = '#cf2233';
const COL_CENTER = '#141518';
const WEDGE_COLORS = [COL_DARK, COL_GREEN, COL_RED];   // strict repeating order

const fmt = (n) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ── font (same fallback chain as the other renderers) ──
const FONT_CANDIDATES = [
  path.join(__dirname, 'DejaVuSans.ttf'), path.join(__dirname, 'fonts', 'DejaVuSans.ttf'),
  path.join(process.cwd(), 'DejaVuSans.ttf'), path.join(process.cwd(), 'fonts', 'DejaVuSans.ttf'),
];
let _font;
function resolveFont() {
  if (_font !== undefined) return _font;
  _font = FONT_CANDIDATES.find(f => { try { return fs.existsSync(f); } catch { return false; } }) || null;
  if (!_font) console.warn('[lottery] DejaVuSans.ttf not found — wheel text may not render');
  return _font;
}
function svgToPixels(svg) {
  const font = resolveFont();
  const r = new Resvg(svg, {
    fitTo: { mode: 'width', value: WHEEL_SIZE },
    font: font ? { fontFiles: [font], loadSystemFonts: false, defaultFontFamily: 'DejaVu Sans' } : { loadSystemFonts: true },
    background: COL_BG,
  });
  return r.render();   // { pixels (RGBA), width, height }
}

// ── wheel geometry ──
const CX = WHEEL_SIZE / 2, CY = WHEEL_SIZE / 2 + 10, R = 122;
function wedgePath(a0, a1, offset) {
  // offset slides the wedge outward along its bisector (for the join animation)
  const mid = (a0 + a1) / 2, rad = Math.PI / 180;
  const ox = Math.cos(mid * rad) * (offset || 0), oy = Math.sin(mid * rad) * (offset || 0);
  const x0 = CX + Math.cos(a0 * rad) * R + ox, y0 = CY + Math.sin(a0 * rad) * R + oy;
  const x1 = CX + Math.cos(a1 * rad) * R + ox, y1 = CY + Math.sin(a1 * rad) * R + oy;
  const large = (a1 - a0) > 180 ? 1 : 0;
  return `M ${(CX + ox).toFixed(1)} ${(CY + oy).toFixed(1)} L ${x0.toFixed(1)} ${y0.toFixed(1)} A ${R} ${R} 0 ${large} 1 ${x1.toFixed(1)} ${y1.toFixed(1)} Z`;
}

// wedges: [{name, wager}] proportional by wager; empty → 12 decorative slices
function buildWheelSVG({ rotation = 0, entries = [], pool = 0, highlightIdx = -1, slideOffset = 0 }) {
  let slices = '';
  const defs = entries.length
    ? (() => {
        const total = entries.reduce((t, e) => t + e.wager, 0) || 1;
        let a = -90; // first wedge starts at the pointer
        return entries.map((e, i) => {
          const span = e.wager / total * 360;
          const d = { a0: a, a1: a + span, color: WEDGE_COLORS[i % 3], name: e.name, wager: e.wager, i };
          a += span; return d;
        });
      })()
    : Array.from({ length: 12 }, (_, i) => ({ a0: -90 + i * 30, a1: -60 + i * 30, color: WEDGE_COLORS[i % 3], i }));

  for (const w of defs) {
    const isHi = w.i === highlightIdx;
    const off = isHi ? slideOffset : 0;
    slices += `<path d="${wedgePath(w.a0, w.a1, off)}" fill="${w.color}" stroke="${isHi ? '#ffffff' : '#0c0d0f'}" stroke-width="${isHi ? 3 : 1.5}"/>`;
    if (w.name && (w.a1 - w.a0) >= 14) {
      const mid = (w.a0 + w.a1) / 2, rad = Math.PI / 180;
      const tx = CX + Math.cos(mid * rad) * (R * 0.62) + Math.cos(mid * rad) * (off || 0);
      const ty = CY + Math.sin(mid * rad) * (R * 0.62) + Math.sin(mid * rad) * (off || 0);
      const nm = esc(String(w.name).slice(0, 10));
      slices += `<text x="${tx.toFixed(0)}" y="${ty.toFixed(0)}" font-size="11" fill="#ffffff" text-anchor="middle">${nm}</text>` +
                `<text x="${tx.toFixed(0)}" y="${(ty + 11).toFixed(0)}" font-size="9" fill="#e8e8e8" text-anchor="middle">${fmt(w.wager)}</text>`;
    }
  }

  // centre: black disc + white crescent & star (Libyan style) + pool overlay
  const centre =
    `<circle cx="${CX}" cy="${CY}" r="48" fill="${COL_CENTER}" stroke="#33363b" stroke-width="3"/>` +
    `<circle cx="${CX - 4}" cy="${CY - 10}" r="17" fill="#ffffff"/>` +
    `<circle cx="${CX + 2}" cy="${CY - 10}" r="14" fill="${COL_CENTER}"/>` +
    starPath(CX + 13, CY - 10, 8, '#ffffff') +
    `<text x="${CX}" y="${CY + 18}" font-size="8" fill="#9aa0a6" text-anchor="middle">POOL</text>` +
    `<text x="${CX}" y="${CY + 33}" font-size="14" font-weight="bold" fill="#ffffff" text-anchor="middle">${fmt(pool)}</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WHEEL_SIZE}" height="${WHEEL_SIZE}" font-family="DejaVu Sans, sans-serif">
    <rect width="${WHEEL_SIZE}" height="${WHEEL_SIZE}" fill="${COL_BG}"/>
    <circle cx="${CX}" cy="${CY}" r="${R + 6}" fill="#0c0d0f" stroke="${COL_RIM}" stroke-width="5"/>
    <g transform="rotate(${rotation.toFixed(2)}, ${CX}, ${CY})">${slices}</g>
    ${centre}
    <polygon points="${CX - 14},6 ${CX + 14},6 ${CX},40" fill="#ffffff" stroke="#0c0d0f" stroke-width="2"/>
  </svg>`;
}
function starPath(cx, cy, r, fill) {
  const pts = [];
  for (let k = 0; k < 10; k++) {
    const rr = k % 2 === 0 ? r : r * 0.42;
    const a = -Math.PI / 2 + k * Math.PI / 5;
    pts.push(`${(cx + Math.cos(a) * rr).toFixed(1)},${(cy + Math.sin(a) * rr).toFixed(1)}`);
  }
  return `<polygon points="${pts.join(' ')}" fill="${fill}"/>`;
}

// ── GIF assembly (streamed frame-by-frame to keep RAM low on Railway) ──
function encodeGif(frames /* [{rotation, ...opts, delay}] */, opts) {
  const gif = GIFEncoder();
  for (const f of frames) {
    const img = svgToPixels(buildWheelSVG({ ...opts, ...f }));
    const palette = quantize(img.pixels, 128);
    const indexed = applyPalette(img.pixels, palette);
    gif.writeFrame(indexed, img.width, img.height, { palette, delay: f.delay });
  }
  gif.finish();
  return Buffer.from(gif.bytes());
}

// the idle wheel: a gentle seamless loop (90° = one full colour cycle of 12 slices)
let _idleGifCache = null;
function renderIdleGif() {
  if (_idleGifCache) return _idleGifCache;
  const frames = Array.from({ length: 18 }, (_, i) => ({ rotation: i * 5, delay: 140 }));
  _idleGifCache = encodeGif(frames, { entries: [], pool: 0 });
  return _idleGifCache;
}

// join sequence: fast spin → ease to a stop → new wedge slides in highlighted → speeds back up
function renderJoinGif(entries, newIdx, pool) {
  const frames = [];
  let rot = Math.random() * 360;
  for (let i = 0; i < 18; i++) { rot += 44 - i * 0.6; frames.push({ rotation: rot % 360, delay: 110 }); }              // ~2s fast
  for (let i = 1; i <= 10; i++) { const t = i / 10; rot += 30 * (1 - t) * (1 - t); frames.push({ rotation: rot % 360, delay: 130 }); } // ease-out stop
  for (let i = 5; i >= 0; i--) frames.push({ rotation: rot % 360, delay: 120, highlightIdx: newIdx, slideOffset: i * 8 });             // slide in
  for (let i = 0; i < 5; i++) frames.push({ rotation: rot % 360, delay: 200, highlightIdx: newIdx, slideOffset: 0 });                  // hold, labelled
  for (let i = 1; i <= 14; i++) { rot += i * 3.2; frames.push({ rotation: rot % 360, delay: 110 }); }                                  // build speed
  return encodeGif(frames, { entries, pool });
}

// result: long spin easing out to land the winner's wedge under the pointer, then flash
function renderResultGif(entries, winnerIdx, pool) {
  const total = entries.reduce((t, e) => t + e.wager, 0) || 1;
  let a = -90;
  let bis = -90;
  entries.forEach((e, i) => { const span = e.wager / total * 360; if (i === winnerIdx) bis = a + span / 2; a += span; });
  const finalRot = 4 * 360 + ((-90 - bis) - 0) % 360;   // land winner bisector at the pointer
  const N = 34, frames = [];
  for (let i = 1; i <= N; i++) {
    const t = i / N, ease = 1 - Math.pow(1 - t, 3);
    frames.push({ rotation: (finalRot * ease) % 360, delay: i > N - 6 ? 160 : 110 });
  }
  for (let i = 0; i < 6; i++) frames.push({ rotation: finalRot % 360, delay: 240, highlightIdx: i % 2 === 0 ? winnerIdx : -1 });
  return encodeGif(frames, { entries, pool });
}

// ─────────────────────────────────────────────────────────────────────────────
// schedule: two unpredictable draws per Libya-day, ≥2.5h apart, inside 11–23
// ─────────────────────────────────────────────────────────────────────────────
function libyaDayKey(nowMs) {
  const lib = new Date(nowMs + LIBYA_OFFSET_MS);
  return `${lib.getUTCFullYear()}-${lib.getUTCMonth() + 1}-${lib.getUTCDate()}`;
}
function startOfLibyaDayUTC(nowMs) {
  const lib = new Date(nowMs + LIBYA_OFFSET_MS);
  return Date.UTC(lib.getUTCFullYear(), lib.getUTCMonth(), lib.getUTCDate()) - LIBYA_OFFSET_MS;
}
function pickTimes(startMs, endMs, count, minGapMs) {
  const win = endMs - startMs;
  let gap = minGapMs; if (win - (count - 1) * gap < 0) gap = Math.floor(win / count);
  const slack = win - (count - 1) * gap;
  const cuts = Array.from({ length: count }, () => Math.random() * slack).sort((a, b) => a - b);
  return cuts.map((c, i) => Math.round(startMs + c + i * gap));
}
function ensureSched(state, saveData, guildId, now) {
  const day = libyaDayKey(now);
  if (state.sched && state.sched.day === day) return state.sched;
  const day0 = startOfLibyaDayUTC(now);
  const ws = day0 + WIN_START * 3600000, we = day0 + WIN_END * 3600000;
  const eff = Math.max(now, ws);
  const spawns = (we - eff > 5 * 60000)
    ? pickTimes(eff, we, PER_DAY, MIN_GAP_MS).map(at => ({ at, fired: false })) : [];
  state.sched = { day, spawns };
  if (saveData) saveData(guildId);
  return state.sched;
}

// ─────────────────────────────────────────────────────────────────────────────
// state + core entry / winner logic (pure, testable)
// ─────────────────────────────────────────────────────────────────────────────
function getState(db, guildId) {
  const data = db[guildId] || (db[guildId] = {});
  if (!data.__lotto) data.__lotto = { channelId: null, sched: null, active: null, history: [] };
  if (!data.__lotto.history) data.__lotto.history = [];
  return data.__lotto;
}

function addEntry(state, db, guildId, saveData, userId, name, wager) {
  const L = state.active;
  if (!L) return { error: 'No lottery is live right now — they spin up **twice a day at random times**. Keep an eye on the lottery channel!' };
  if (Date.now() > L.endsAt) return { error: 'This lottery has just closed — catch the next one!' };
  wager = Math.floor(wager);
  if (!Number.isFinite(wager) || wager < WAGER_MIN) return { error: `Minimum wager is **${WAGER_MIN} Dinar**.` };
  if (wager > WAGER_MAX) return { error: `Maximum wager is **${fmt(WAGER_MAX)} Dinar**.` };
  if (L.entries[userId]) return { error: `You're already in this lottery with **${fmt(L.entries[userId].wager)} Dinar** — one entry per person!` };
  const bal = getDinar(db, guildId, userId);
  if (bal < wager) return { error: `You only have **${fmt(bal)} Dinar** — not enough for that wager.` };
  spendDinar(db, guildId, userId, wager, saveData);   // deducted immediately
  L.entries[userId] = { name, wager, at: Date.now() };
  L.pool += wager;
  if (saveData) saveData(guildId);
  const chance = wager / L.pool * 100;
  return { ok: true, wager, pool: L.pool, count: Object.keys(L.entries).length, chance };
}

function pickWinner(L) {
  const ids = Object.keys(L.entries);
  if (!ids.length) return null;
  let r = Math.random() * L.pool;
  for (const id of ids) { r -= L.entries[id].wager; if (r < 0) return id; }
  return ids[ids.length - 1];
}
const entryList = (L) => Object.entries(L.entries).map(([id, e]) => ({ id, name: e.name, wager: e.wager }));

// ─────────────────────────────────────────────────────────────────────────────
// commands + live wiring
// ─────────────────────────────────────────────────────────────────────────────
function getLottoCommands() {
  return [
    new SlashCommandBuilder().setName('dinar-lotto').setDescription('Enter the live Dinar lottery')
      .addIntegerOption(o => o.setName('wager').setDescription(`Your wager (${WAGER_MIN}–${WAGER_MAX} Dinar)`)
        .setRequired(true).setMinValue(WAGER_MIN).setMaxValue(WAGER_MAX)).toJSON(),
    new SlashCommandBuilder().setName('lottery-start').setDescription('(Admin) Start a lottery right now')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).toJSON(),
    new SlashCommandBuilder().setName('lottery-channel').setDescription('(Admin) Hold lotteries in this channel')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).toJSON(),
  ];
}

function initLotto({ client, db, saveData }) {
  const stateOf = (gid) => getState(db, gid);
  let renderChain = Promise.resolve();          // serialize GIF renders (RAM guard)
  const queueRender = (fn) => (renderChain = renderChain.then(fn, fn));

  const annEmbed = (L) => new EmbedBuilder().setColor(0xE7B41A).setTitle('🎡 DINAR LOTTERY — LIVE!')
    .setDescription(
      `The wheel is spinning! Wager your Dinar for a chance to take the **whole pool**.\n\n` +
      `🎟 Join with **\`/dinar-lotto <wager>\`** (max **${fmt(WAGER_MAX)}**, one entry each)\n` +
      `📈 Bigger wagers = bigger slice of the wheel = better odds\n` +
      `⏳ Ends <t:${Math.round(L.endsAt / 1000)}:R>`)
    .addFields(
      { name: '💰 Prize pool', value: `**${fmt(L.pool)} Dinar**`, inline: true },
      { name: '👥 Participants', value: `**${Object.keys(L.entries).length}**`, inline: true })
    .setImage('attachment://wheel.gif');

  async function startLottery(guildId) {
    const state = stateOf(guildId);
    if (state.active || !state.channelId) return false;
    state.active = {
      id: 'L' + Date.now().toString(36), startedAt: Date.now(), endsAt: Date.now() + LOTTO_DURATION_MS,
      pool: 0, entries: {}, remindersSent: 0, channelId: state.channelId, messageId: null,
    };
    saveData(guildId);
    try {
      const ch = await client.channels.fetch(state.channelId);
      const file = new AttachmentBuilder(renderIdleGif(), { name: 'wheel.gif' });
      const msg = await ch.send({ embeds: [annEmbed(state.active)], files: [file] });
      state.active.messageId = msg.id; saveData(guildId);
    } catch (e) { console.error('[lottery post]', e.message); }
    return true;
  }

  async function refreshAnnouncement(guildId) {
    const state = stateOf(guildId); const L = state.active;
    if (!L || !L.messageId) return;
    try {
      const ch = await client.channels.fetch(L.channelId);
      const msg = await ch.messages.fetch(L.messageId);
      await msg.edit({ embeds: [annEmbed(L)] });   // pool + count only; the GIF attachment stays
    } catch { /* announcement gone — carry on */ }
  }

  async function remind(guildId) {
    const state = stateOf(guildId); const L = state.active;
    if (!L) return;
    try {
      const ch = await client.channels.fetch(L.channelId);
      const file = new AttachmentBuilder(renderIdleGif(), { name: 'wheel.gif' });
      await ch.send({ embeds: [new EmbedBuilder().setColor(0xE7B41A).setTitle('🎉 Lottery is LIVE!')
        .setDescription(`💰 Prize pool: **${fmt(L.pool)} Dinar**\n👥 Participants: **${Object.keys(L.entries).length}**\n\n🎟 Join with **\`/dinar-lotto <wager>\`** (max ${fmt(WAGER_MAX)}) — ends <t:${Math.round(L.endsAt / 1000)}:R>`)
        .setImage('attachment://wheel.gif')], files: [file] });
    } catch (e) { console.error('[lottery remind]', e.message); }
  }

  async function closeLottery(guildId) {
    const state = stateOf(guildId); const L = state.active;
    if (!L) return;
    state.active = null;                          // stop entries immediately
    const winnerId = pickWinner(L);
    let winner = null;
    if (winnerId) {
      winner = { id: winnerId, ...L.entries[winnerId] };
      awardDinar(db, guildId, winnerId, L.pool, saveData);   // full pool, uncapped transfer
    }
    state.history.unshift({ id: L.id, endedAt: Date.now(), pool: L.pool, entries: Object.keys(L.entries).length, winnerId });
    state.history.length = Math.min(state.history.length, 10);
    saveData(guildId);
    try {
      const ch = await client.channels.fetch(L.channelId);
      if (winner) {
        const entries = entryList(L);
        const wIdx = entries.findIndex(e => e.id === winner.id);
        await queueRender(async () => {
          const gif = renderResultGif(entries, wIdx, L.pool);
          const chance = (winner.wager / L.pool * 100).toFixed(2);
          await ch.send({ content: `<@${winner.id}>`, embeds: [new EmbedBuilder().setColor(0x2ecc40)
            .setTitle('🏆 LOTTERY WINNER!')
            .setDescription(`The wheel has spoken — **${esc(winner.name)}** takes the pool!\n\n💰 Won **${fmt(L.pool)} Dinar** on a **${fmt(winner.wager)}** wager (${chance}% odds)\n👥 ${Object.keys(L.entries).length} entered • better luck next spin!`)
            .setImage('attachment://wheel.gif')], files: [new AttachmentBuilder(gif, { name: 'wheel.gif' })] });
        });
      } else {
        await ch.send({ embeds: [new EmbedBuilder().setColor(0x777777).setTitle('🎡 Lottery closed')
          .setDescription('Nobody dared to spin the wheel this time — the pool stays empty. Next one comes at a random time!')] });
      }
      // retire the original announcement
      if (L.messageId) {
        const msg = await ch.messages.fetch(L.messageId).catch(() => null);
        if (msg) await msg.edit({ embeds: [new EmbedBuilder().setColor(0x777777).setTitle('🎡 DINAR LOTTERY — ENDED')
          .setDescription(winner ? `🏆 **${esc(winner.name)}** won **${fmt(L.pool)} Dinar**!` : 'No entries this round.')], files: [], attachments: [] });
      }
    } catch (e) { console.error('[lottery close]', e.message); }
  }

  async function tick() {
    const now = Date.now();
    for (const [gid] of client.guilds.cache) {
      try {
        const state = stateOf(gid);
        if (!state.channelId) continue;
        ensureSched(state, saveData, gid, now);
        const due = state.sched.spawns.find(s => !s.fired && s.at <= now);
        if (due && !state.active) { due.fired = true; saveData(gid); await startLottery(gid); }
        const L = state.active;
        if (L) {
          if (now >= L.endsAt) { await closeLottery(gid); continue; }
          const owed = Math.floor((now - L.startedAt) / REMIND_EVERY_MS);
          if (owed > L.remindersSent && L.endsAt - now > 90 * 1000) { L.remindersSent = owed; saveData(gid); await remind(gid); }
        }
      } catch (e) { console.error('[lottery tick]', e.message); }
    }
  }
  setInterval(() => tick().catch(() => {}), TICK_MS);

  client.on('interactionCreate', async (interaction) => {
    try {
      if (!interaction.isChatInputCommand() || !interaction.guildId) return;
      const gid = interaction.guildId;
      const state = stateOf(gid);

      if (interaction.commandName === 'lottery-channel') {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild))
          return interaction.reply({ content: 'You need **Manage Server** to set the lottery channel.', flags: 64 });
        state.channelId = interaction.channelId; saveData(gid);
        return interaction.reply({ content: `🎡 Lotteries will now take place in <#${interaction.channelId}> — twice a day at unpredictable times!` });
      }

      if (interaction.commandName === 'lottery-start') {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild))
          return interaction.reply({ content: 'You need **Manage Server** to start a lottery.', flags: 64 });
        if (!state.channelId) return interaction.reply({ content: 'Set a lottery channel first with `/lottery-channel`.', flags: 64 });
        if (state.active) return interaction.reply({ content: 'A lottery is already live!', flags: 64 });
        await interaction.reply({ content: '🎡 Spinning one up now!', flags: 64 });
        await startLottery(gid);
        return;
      }

      if (interaction.commandName === 'dinar-lotto') {
        const wager = interaction.options.getInteger('wager');
        const name = interaction.member?.displayName || interaction.user.username;
        const r = addEntry(state, db, gid, saveData, interaction.user.id, name, wager);
        if (r.error) return interaction.reply({ content: r.error, flags: 64 });
        const L = state.active;
        refreshAnnouncement(gid).catch(() => {});
        const inLottoChannel = interaction.channelId === L.channelId;
        const summary = new EmbedBuilder().setColor(0xE7B41A)
          .setDescription(`🎟 **${esc(name)}** joined the lottery with **${fmt(r.wager)} Dinar**!\n📈 Current chance of winning: **${r.chance.toFixed(2)}%**\n💰 Prize pool: **${fmt(r.pool)} Dinar** • 👥 **${r.count}** in`);
        if (!inLottoChannel) await interaction.reply({ content: `🎟 You're in with **${fmt(r.wager)} Dinar**! Watch <#${L.channelId}> for the wheel.`, flags: 64 });
        else await interaction.deferReply();
        // the join animation: spin → stop → your wedge slides in → speeds back up → clean summary
        queueRender(async () => {
          try {
            const Lnow = stateOf(gid).active;
            const entries = Lnow && Lnow.id === L.id ? entryList(Lnow) : entryList(L);
            const idx = entries.findIndex(e => e.id === interaction.user.id);
            const gif = renderJoinGif(entries, idx, r.pool);
            const file = new AttachmentBuilder(gif, { name: 'wheel.gif' });
            const payload = { embeds: [new EmbedBuilder().setColor(0xE7B41A).setDescription(`🎡 **${esc(name)}** spins into the lottery…`).setImage('attachment://wheel.gif')], files: [file] };
            let msg;
            if (inLottoChannel) { await interaction.editReply(payload); msg = await interaction.fetchReply(); }
            else { const ch = await client.channels.fetch(L.channelId); msg = await ch.send(payload); }
            setTimeout(() => { msg.edit({ embeds: [summary], files: [], attachments: [] }).catch(() => {}); }, 9500);
          } catch (e) {
            console.error('[lottery join gif]', e.message);
            if (inLottoChannel) interaction.editReply({ embeds: [summary] }).catch(() => {});
          }
        });
        return;
      }
    } catch (e) { console.error('[lottery interaction]', e.message); }
  });

  return { _test: {
    getState: () => stateOf, addEntry, pickWinner, ensureSched, pickTimes, entryList,
    buildWheelSVG, renderIdleGif, renderJoinGif, renderResultGif,
    startLottery, closeLottery, tick, libyaDayKey, startOfLibyaDayUTC,
  } };
}

module.exports = { getLottoCommands, initLotto };
