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
const WAGER_MIN         = 1;
const WAGER_MAX         = 500;
const LOTTO_DURATION_MS = 60 * 60 * 1000;   // each lottery runs for 1 hour
const REMIND_EVERY_MS   = 15 * 60 * 1000;   // channel reminder cadence
const JOIN_COOLDOWN_MS  = 8 * 1000;         // gap between ANY two entries (anti-spam)
const PER_DAY           = 2;                // lotteries per day
const WIN_START         = 11;               // Libya-time spawn window
const WIN_END           = 23;
const MIN_GAP_MS        = 150 * 60 * 1000;  // ≥2.5h between the two draws
const LIBYA_OFFSET_MS   = 2 * 3600 * 1000;  // UTC+2, no DST
const TICK_MS           = 60 * 1000;

// ── wheel look (flat, Libyan flag palette) ──
const WHEEL_SIZE = 400;
const COL_BG    = '#111214';
const COL_RIM   = '#3a3d42';
const COL_DARK  = '#232428';
const COL_GREEN = '#1f8a3d';
const COL_RED   = '#cf2233';
const COL_CENTER = '#141518';
const WEDGE_COLORS = [COL_GREEN, COL_RED, COL_DARK];   // strict repeating order (green first)

const fmt = (n) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const sleep = (ms) => new Promise(res => setTimeout(res, ms));
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

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
function resvgOpts() {
  const font = resolveFont();
  return {
    fitTo: { mode: 'width', value: WHEEL_SIZE },
    font: font ? { fontFiles: [font], loadSystemFonts: false, defaultFontFamily: 'DejaVu Sans' } : { loadSystemFonts: true },
    background: COL_BG,
  };
}
const svgToPixels = (svg) => new Resvg(svg, resvgOpts()).render();          // RGBA pixmap
const svgToPng = (svg) => new Resvg(svg, resvgOpts()).render().asPng();    // PNG buffer

// ── wheel geometry (rotation is baked into every wedge so a slice can fly in screen space) ──
const CX = WHEEL_SIZE / 2, CY = WHEEL_SIZE / 2 + 12, R = 162;
const RAD = Math.PI / 180;
function wedgePath(a0, a1, ox, oy) {
  ox = ox || 0; oy = oy || 0;
  const x0 = CX + Math.cos(a0 * RAD) * R + ox, y0 = CY + Math.sin(a0 * RAD) * R + oy;
  const x1 = CX + Math.cos(a1 * RAD) * R + ox, y1 = CY + Math.sin(a1 * RAD) * R + oy;
  const large = (a1 - a0) > 180 ? 1 : 0;
  return `M ${(CX + ox).toFixed(1)} ${(CY + oy).toFixed(1)} L ${x0.toFixed(1)} ${y0.toFixed(1)} A ${R} ${R} 0 ${large} 1 ${x1.toFixed(1)} ${y1.toFixed(1)} Z`;
}
// a wedge spanning the whole wheel (a lone participant) must be drawn as a circle —
// an SVG arc whose start and end coincide renders as nothing at all
function wedgeShape(a0, a1, fill, stroke, sw, dash, ox, oy) {
  const d = dash ? ` stroke-dasharray="${dash}"` : '';
  if ((a1 - a0) >= 359.9)
    return `<circle cx="${(CX + (ox || 0)).toFixed(1)}" cy="${(CY + (oy || 0)).toFixed(1)}" r="${R}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${d}/>`;
  return `<path d="${wedgePath(a0, a1, ox, oy)}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${d}/>`;
}
function wedgeDefs(entries) {
  if (!entries.length) return Array.from({ length: 12 }, (_, i) => ({ a0: -90 + i * 30, a1: -60 + i * 30, color: WEDGE_COLORS[i % 3], i }));
  const total = entries.reduce((t, e) => t + e.wager, 0) || 1;
  let a = -90;
  const n = entries.length;
  return entries.map((e, i) => {
    const span = e.wager / total * 360;
    // strict Green→Red→Dark cycle, but never let the last wedge share a colour
    // with the first one it wraps round to touch
    let color = WEDGE_COLORS[i % 3];
    if (n > 1 && i === n - 1 && i % 3 === 0) color = WEDGE_COLORS[1];
    const d = { a0: a, a1: a + span, color, name: e.name, wager: e.wager, i };
    a += span; return d;
  });
}
function wedgeLabel(w, rot, ox, oy) {
  // labels sit at the wedge's centre; overlap with neighbours is fine — ownership is
  // obvious because each label sits in the middle of its own slice
  if (!w.name || (w.a1 - w.a0) < 6) return '';
  const mid = (w.a0 + w.a1) / 2 + rot;
  const tx = CX + Math.cos(mid * RAD) * (R * 0.6) + (ox || 0);
  const ty = CY + Math.sin(mid * RAD) * (R * 0.6) + (oy || 0);
  const nm = esc(String(w.name).slice(0, 12));
  return `<text x="${tx.toFixed(0)}" y="${ty.toFixed(0)}" font-size="16" font-weight="bold" fill="#ffffff" text-anchor="middle">${nm}</text>` +
         `<text x="${tx.toFixed(0)}" y="${(ty + 15).toFixed(0)}" font-size="12" fill="#f0f0f0" text-anchor="middle">${fmt(w.wager)}</text>`;
}

// modes: gapIdx — draw that wedge as an empty waiting slot; fly {idx, t} — that wedge
// flies in from the top-right corner (t: 0 corner → 1 seated); highlightIdx — white flash
function buildWheelSVG({ rotation = 0, entries = [], pool = 0, highlightIdx = -1, gapIdx = -1, fly = null }) {
  const defs = wedgeDefs(entries);
  let slices = '', flying = '';
  for (const w of defs) {
    const a0 = w.a0 + rotation, a1 = w.a1 + rotation;
    const isFly = fly && fly.idx === w.i;
    if (w.i === gapIdx || (isFly && fly.t < 1)) {
      // the waiting slot: a dark cut-out with a dashed edge
      slices += wedgeShape(a0, a1, '#0b0c0e', '#4a4f57', 2, '6 5');
    }
    if (isFly) {
      const mid = (w.a0 + w.a1) / 2 + rotation;
      const centX = CX + Math.cos(mid * RAD) * R * 0.55, centY = CY + Math.sin(mid * RAD) * R * 0.55;
      const startX = WHEEL_SIZE - 46, startY = 44;                 // top-right corner
      const k = 1 - clamp(fly.t, 0, 1);
      const ox = (startX - centX) * k, oy = (startY - centY) * k;
      flying += wedgeShape(a0, a1, w.color, '#ffffff', 3, null, ox, oy) + wedgeLabel(w, rotation, ox, oy);
      continue;
    }
    if (w.i === gapIdx) continue;
    const isHi = w.i === highlightIdx;
    slices += wedgeShape(a0, a1, w.color, isHi ? '#ffffff' : '#0c0d0f', isHi ? 4 : 1.5, null) + wedgeLabel(w, rotation);
  }
  const centre =
    `<circle cx="${CX}" cy="${CY}" r="62" fill="${COL_CENTER}" stroke="#33363b" stroke-width="4"/>` +
    `<circle cx="${CX - 5}" cy="${CY - 13}" r="22" fill="#ffffff"/>` +
    `<circle cx="${CX + 3}" cy="${CY - 13}" r="18" fill="${COL_CENTER}"/>` +
    starPath(CX + 17, CY - 13, 10, '#ffffff') +
    `<text x="${CX}" y="${CY + 22}" font-size="10" fill="#9aa0a6" text-anchor="middle">POOL</text>` +
    `<text x="${CX}" y="${CY + 42}" font-size="18" font-weight="bold" fill="#ffffff" text-anchor="middle">${fmt(pool)}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WHEEL_SIZE}" height="${WHEEL_SIZE}" font-family="DejaVu Sans, sans-serif">
    <rect width="${WHEEL_SIZE}" height="${WHEEL_SIZE}" fill="${COL_BG}"/>
    <circle cx="${CX}" cy="${CY}" r="${R + 8}" fill="#0c0d0f" stroke="${COL_RIM}" stroke-width="6"/>
    ${slices}${flying}
    ${centre}
    <polygon points="${CX - 18},8 ${CX + 18},8 ${CX},52" fill="#ffffff" stroke="#0c0d0f" stroke-width="2"/>
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
// opts.once = play a single time, then freeze on the last frame (used for the winner reveal)
function encodeGif(frames, base, once) {
  const gif = GIFEncoder();
  let first = true;
  for (const f of frames) {
    const img = svgToPixels(buildWheelSVG({ ...base, ...f }));
    const palette = quantize(img.pixels, 128);
    const indexed = applyPalette(img.pixels, palette);
    const o = { palette, delay: f.delay };
    if (first) { o.repeat = once ? -1 : 0; first = false; }
    gif.writeFrame(indexed, img.width, img.height, o);
  }
  gif.finish();
  return Buffer.from(gif.bytes());
}

// live wheel for the announcement + reminders: full 360° seamless loop with current
// participants and pool baked in
function renderLiveGif(entries, pool) {
  const frames = Array.from({ length: 24 }, (_, i) => ({ rotation: i * 15, delay: 140 }));
  return encodeGif(frames, { entries, pool });
}

// join sequence: the wheel is already spinning FAST with an empty slot waiting → it smoothly
// loses speed (never gaining any) until it halts with the slot at the top-right → the new
// wedge pops in at the corner and slides into the slot → holds, labelled → builds speed back
// up to the original fast spin. Deceleration starts at exactly the cruising speed so there is
// no lurch before the stop.
function planJoinFrames(entries, newIdx) {
  const frames = [];
  let rot = Math.random() * 360;
  let v = 46;
  for (let i = 0; i < 26; i++) { rot += v; v -= 0.5; frames.push({ rotation: rot % 360, gapIdx: newIdx, delay: 130 }); }   // fast cruise, 46 → 33.5°/f
  // ease-out stop whose initial slope equals the current speed — lands the slot at -45°
  const defs = wedgeDefs(entries);
  const bis = (defs[newIdx].a0 + defs[newIdx].a1) / 2;
  const target = -45 - bis;
  const D = ((target - rot) % 360 + 360) % 360 + 360;          // at least one full extra turn
  const N = Math.max(10, Math.round(2 * D / v));               // quad ease-out initial velocity = 2D/N = v
  const rot0 = rot;
  for (let i = 1; i <= N; i++) { const t = i / N; frames.push({ rotation: (rot0 + D * (1 - (1 - t) * (1 - t))) % 360, gapIdx: newIdx, delay: 130 }); }
  rot = rot0 + D;
  for (let i = 0; i < 8; i++) frames.push({ rotation: rot % 360, fly: { idx: newIdx, t: easeOutCubic(i / 7) }, delay: 125 });
  for (let i = 0; i < 3; i++) frames.push({ rotation: rot % 360, highlightIdx: newIdx, delay: 220 });
  let v2 = 3;
  for (let i = 0; i < 28; i++) { rot += v2; v2 = Math.min(46, v2 + 1.7); frames.push({ rotation: rot % 360, delay: 130 }); }   // build back to cruise
  return frames;
}
// the insert plays ONCE and freezes on its final frame; the message then swaps to the
// seamless looping wheel (like the announcement), so the wedge only slides in a single time
function renderJoinGif(entries, newIdx, pool) {
  return encodeGif(planJoinFrames(entries, newIdx), { entries, pool }, true);
}
// build the frames + matching duration together (planJoinFrames is randomised each call)
function buildJoinGif(entries, newIdx, pool) {
  const frames = planJoinFrames(entries, newIdx);
  return { buf: encodeGif(frames, { entries, pool }, true), ms: frames.reduce((t, f) => t + f.delay, 0) };
}

// winner reveal: a long suspense spin (~12s) easing out over two slow extra turns, halting
// on the winner's wedge with a white flash. Plays ONCE and freezes on the winner.
function renderResultGif(entries, winnerIdx, pool) {
  const defs = wedgeDefs(entries);
  const bis = (defs[winnerIdx].a0 + defs[winnerIdx].a1) / 2;
  const frames = [];
  let rot = Math.random() * 360;
  for (let i = 0; i < 58; i++) { rot += 48 - i * 0.25; frames.push({ rotation: rot % 360, delay: 200 }); }
  const target = -90 - bis;                                   // winner bisector under the pointer
  const delta = ((target - rot) % 360 + 360) % 360 + 720;     // two agonising final turns
  const rot0 = rot;
  for (let i = 1; i <= 26; i++) frames.push({ rotation: (rot0 + delta * easeOutCubic(i / 26)) % 360, delay: 150 });
  rot = rot0 + delta;
  for (let i = 0; i < 8; i++) frames.push({ rotation: rot % 360, highlightIdx: i % 2 === 0 ? winnerIdx : -1, delay: 260 });
  frames.push({ rotation: rot % 360, highlightIdx: winnerIdx, delay: 400 });   // freeze on the glow
  return encodeGif(frames, { entries, pool }, true);
}
const RESULT_GIF_MS = 58 * 200 + 26 * 150 + 8 * 260 + 400;   // ≈ 18,180ms

// a still of the final landed frame, used when the reveal message is edited to name the winner
function renderWinnerStill(entries, winnerIdx, pool) {
  const defs = wedgeDefs(entries);
  const bis = (defs[winnerIdx].a0 + defs[winnerIdx].a1) / 2;
  return svgToPng(buildWheelSVG({ rotation: -90 - bis, entries, pool, highlightIdx: winnerIdx }));
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
  if (!data.__lotto) data.__lotto = { channelId: null, sched: null, active: null, history: [], stats: {} };
  if (!data.__lotto.history) data.__lotto.history = [];
  if (!data.__lotto.stats) data.__lotto.stats = {};
  return data.__lotto;
}

function addEntry(state, db, guildId, saveData, userId, name, wager) {
  const L = state.active;
  if (!L) return { error: 'No lottery is live right now — they spin up **twice a day at random times**. Keep an eye on the lottery channel!' };
  const now = Date.now();
  if (now > L.endsAt) return { error: 'This lottery has just closed — catch the next one!' };
  if (L.lastJoinAt && now - L.lastJoinAt < JOIN_COOLDOWN_MS)
    return { error: `⏳ The wheel is still settling from the last entry — try again in **${Math.ceil((L.lastJoinAt + JOIN_COOLDOWN_MS - now) / 1000)}s**.` };
  wager = Math.floor(wager);
  if (!Number.isFinite(wager) || wager < WAGER_MIN) return { error: `Minimum wager is **${WAGER_MIN} Dinar**.` };
  if (wager > WAGER_MAX) return { error: `Maximum wager is **${fmt(WAGER_MAX)} Dinar**.` };
  if (L.entries[userId]) return { error: `You're already in this lottery with **${fmt(L.entries[userId].wager)} Dinar** — one entry per person!` };
  const bal = getDinar(db, guildId, userId);
  if (bal < wager) return { error: `You only have **${fmt(bal)} Dinar** — not enough for that wager.` };
  spendDinar(db, guildId, userId, wager, saveData);   // deducted immediately
  L.entries[userId] = { name, wager, at: now };
  L.pool += wager;
  L.lastJoinAt = now;
  const st = state.stats[userId] || (state.stats[userId] = { name, wins: 0, won: 0, entries: 0, wagered: 0 });
  st.name = name; st.entries++; st.wagered += wager;
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
    new SlashCommandBuilder().setName('lottery-leaderboard').setDescription('The lottery hall of fame — top winners').toJSON(),
    new SlashCommandBuilder().setName('lottery-start').setDescription('(Admin) Start a lottery right now')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).toJSON(),
    new SlashCommandBuilder().setName('lottery-cancel').setDescription('(Admin) Stop the current lottery, refund all wagers and clear it')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).toJSON(),
    new SlashCommandBuilder().setName('lottery-channel').setDescription('(Admin) Hold lotteries in this channel')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).toJSON(),
  ];
}

function initLotto({ client, db, saveData }) {
  const stateOf = (gid) => getState(db, gid);
  let renderChain = Promise.resolve();          // serialize GIF renders (RAM guard)
  const queueRender = (fn) => (renderChain = renderChain.then(fn, fn));
  const liveCache = {};                         // { gid: { key, buf } } — cached live wheel

  function liveWheel(gid, L) {
    const key = `${L.id}:${Object.keys(L.entries).length}:${L.pool}`;
    if (liveCache[gid]?.key === key) return liveCache[gid].buf;
    const buf = renderLiveGif(entryList(L), L.pool);
    liveCache[gid] = { key, buf };
    return buf;
  }

  const joinSummaryEmbed = (d) => new EmbedBuilder().setColor(0xE7B41A)
    .setDescription(`🎟 **${esc(d.name)}** joined the lottery with **${fmt(d.wager)} Dinar**!\n📈 Current chance of winning: **${Number(d.chance).toFixed(2)}%**\n💰 Prize pool: **${fmt(d.pool)} Dinar** • 👥 **${d.count}** in`);

  // collapse the previous participant's wheel message down to its clean summary
  async function collapseJoin(L) {
    if (!L || !L.lastJoin) return;
    const d = L.lastJoin; L.lastJoin = null;
    try {
      const ch = await client.channels.fetch(d.channelId);
      const msg = await ch.messages.fetch(d.messageId);
      await msg.edit({ embeds: [joinSummaryEmbed(d.summary)], files: [], attachments: [] });
    } catch { /* message gone — nothing to collapse */ }
  }

  // once the insert has played its single time, swap the join message to the seamless
  // looping wheel so it keeps spinning (like the announcement) until it's superseded
  async function toLiveLoop(gid, messageId, summaryData) {
    const cur = stateOf(gid).active;
    if (!cur || !cur.lastJoin || cur.lastJoin.messageId !== messageId) return;   // superseded or closed
    try {
      const ch = await client.channels.fetch(cur.lastJoin.channelId);
      const msg = await ch.messages.fetch(messageId);
      const file = new AttachmentBuilder(liveWheel(gid, cur), { name: 'wheel.gif' });
      await msg.edit({ embeds: [joinSummaryEmbed(summaryData).setImage('attachment://wheel.gif')], files: [file], attachments: [] });
    } catch { /* message gone — nothing to swap */ }
  }

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
      pool: 0, entries: {}, remindersSent: 0, lastJoinAt: 0, reminderMsgIds: [], lastJoin: null, channelId: state.channelId, messageId: null,
    };
    saveData(guildId);
    try {
      const ch = await client.channels.fetch(state.channelId);
      const file = new AttachmentBuilder(liveWheel(guildId, state.active), { name: 'wheel.gif' });
      const msg = await ch.send({ embeds: [annEmbed(state.active)], files: [file] });
      state.active.messageId = msg.id; saveData(guildId);
    } catch (e) { console.error('[lottery post]', e.message); }
    return true;
  }

  // refresh the permanent announcement: latest wheel graphic (participants + pool) AND the text
  async function refreshAnnouncement(guildId) {
    const state = stateOf(guildId); const L = state.active;
    if (!L || !L.messageId) return;
    try {
      const ch = await client.channels.fetch(L.channelId);
      const msg = await ch.messages.fetch(L.messageId);
      const file = new AttachmentBuilder(liveWheel(guildId, L), { name: 'wheel.gif' });
      await msg.edit({ embeds: [annEmbed(L)], files: [file], attachments: [] });
    } catch { /* announcement gone — carry on */ }
  }

  const remindEmbed = (L) => new EmbedBuilder().setColor(0xE7B41A).setTitle('🎉 Reminder - Lottery is LIVE!')
    .setDescription(`💰 Prize pool: **${fmt(L.pool)} Dinar**\n👥 Participants: **${Object.keys(L.entries).length}**\n\n🎟 Join with **\`/dinar-lotto <wager>\`** (max ${fmt(WAGER_MAX)}) — ends <t:${Math.round(L.endsAt / 1000)}:R>`)
    .setImage('attachment://wheel.gif');

  async function remind(guildId) {
    const state = stateOf(guildId); const L = state.active;
    if (!L) return;
    try {
      const ch = await client.channels.fetch(L.channelId);
      const file = new AttachmentBuilder(liveWheel(guildId, L), { name: 'wheel.gif' });
      const msg = await ch.send({ embeds: [remindEmbed(L)], files: [file] });
      L.reminderMsgIds = L.reminderMsgIds || [];
      L.reminderMsgIds.push(msg.id);
      if (L.reminderMsgIds.length > 4) L.reminderMsgIds.shift();   // only keep recent ones live
      saveData(guildId);
    } catch (e) { console.error('[lottery remind]', e.message); }
  }

  // keep the posted reminder messages current too (latest participants + pool + wheel)
  async function refreshReminders(guildId) {
    const state = stateOf(guildId); const L = state.active;
    if (!L || !L.reminderMsgIds || !L.reminderMsgIds.length) return;
    try {
      const ch = await client.channels.fetch(L.channelId);
      const file = new AttachmentBuilder(liveWheel(guildId, L), { name: 'wheel.gif' });
      for (const id of L.reminderMsgIds) {
        const msg = await ch.messages.fetch(id).catch(() => null);
        if (msg) await msg.edit({ embeds: [remindEmbed(L)], files: [file], attachments: [] });
      }
    } catch (e) { console.error('[lottery remind refresh]', e.message); }
  }

  async function closeLottery(guildId) {
    const state = stateOf(guildId); const L = state.active;
    if (!L) return;
    state.active = null;                          // stop entries immediately
    await collapseJoin(L).catch(() => {});        // last participant wheel → summary
    const winnerId = pickWinner(L);
    let winner = null;
    if (winnerId) {
      winner = { id: winnerId, ...L.entries[winnerId] };
      awardDinar(db, guildId, winnerId, L.pool, saveData);   // full pool, uncapped transfer
      const st = state.stats[winnerId] || (state.stats[winnerId] = { name: winner.name, wins: 0, won: 0, entries: 0, wagered: 0 });
      st.wins++; st.won += L.pool; st.name = winner.name;
    }
    state.history.unshift({ id: L.id, endedAt: Date.now(), pool: L.pool, entries: Object.keys(L.entries).length, winnerId });
    state.history.length = Math.min(state.history.length, 10);
    saveData(guildId);
    try {
      const ch = await client.channels.fetch(L.channelId);
      if (winner) {
        // build suspense: a teaser, a pause, then a "Choosing winner…" reveal that names no one
        await ch.send({ content: '🎰 **The wheel is about to decide…** the lottery winner will be revealed in **10 seconds** — hold your breath!' });
        await sleep(10000);
        const entries = entryList(L);
        const wIdx = entries.findIndex(e => e.id === winner.id);
        await queueRender(async () => {
          const gif = renderResultGif(entries, wIdx, L.pool);
          const msg = await ch.send({ embeds: [new EmbedBuilder().setColor(0xE7B41A)
            .setTitle('🎡 Choosing winner…')
            .setDescription('The wheel is spinning. Whose name will it stop on?')
            .setImage('attachment://wheel.gif')], files: [new AttachmentBuilder(gif, { name: 'wheel.gif' })] });
          // once the single-play spin has landed, name the winner on the same message
          setTimeout(async () => {
            try {
              const still = renderWinnerStill(entries, wIdx, L.pool);
              const chance = (winner.wager / L.pool * 100).toFixed(2);
              await msg.edit({ content: `<@${winner.id}>`, embeds: [new EmbedBuilder().setColor(0x2ecc40)
                .setTitle('🏆 LOTTERY WINNER!')
                .setDescription(`The wheel has spoken — **${esc(winner.name)}** takes the pool!\n\n💰 Won **${fmt(L.pool)} Dinar** on a **${fmt(winner.wager)}** wager (${chance}% odds)\n👥 ${Object.keys(L.entries).length} entered • better luck next spin!`)
                .setImage('attachment://wheel.png')], files: [new AttachmentBuilder(still, { name: 'wheel.png' })], attachments: [] });
            } catch (e) { console.error('[lottery reveal]', e.message); }
          }, RESULT_GIF_MS + 1200);
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

  // admin stop: cancel an active lottery, refund every wager (no winner), wipe its cache
  async function cancelLottery(guildId) {
    const state = stateOf(guildId); const L = state.active;
    if (!L) return { none: true };
    state.active = null;                                  // stop entries immediately
    await collapseJoin(L).catch(() => {});                // last participant wheel → summary
    delete liveCache[guildId];                            // drop the cached wheel graphic
    let refunded = 0, players = 0;
    for (const [uid, e] of Object.entries(L.entries)) { awardDinar(db, guildId, uid, e.wager, saveData); refunded += e.wager; players++; }
    state.history.unshift({ id: L.id, endedAt: Date.now(), pool: L.pool, entries: players, winnerId: null, cancelled: true });
    state.history.length = Math.min(state.history.length, 10);
    saveData(guildId);
    try {
      const ch = await client.channels.fetch(L.channelId);
      await ch.send({ embeds: [new EmbedBuilder().setColor(0x777777).setTitle('🛑 Lottery cancelled')
        .setDescription(players ? `An admin stopped the lottery. **All ${players} wager${players === 1 ? '' : 's'} refunded** — **${fmt(refunded)} Dinar** returned in full.` : 'An admin stopped the lottery. No entries to refund.')] });
      if (L.messageId) {
        const msg = await ch.messages.fetch(L.messageId).catch(() => null);
        if (msg) await msg.edit({ embeds: [new EmbedBuilder().setColor(0x777777).setTitle('🛑 DINAR LOTTERY — CANCELLED')
          .setDescription('This lottery was stopped by an admin. All wagers were refunded.')], files: [], attachments: [] });
      }
    } catch (e) { console.error('[lottery cancel]', e.message); }
    return { refunded, players };
  }

  function leaderboardEmbed(state) {
    const rows = Object.values(state.stats).filter(s => s.wins > 0)
      .sort((a, b) => b.won - a.won).slice(0, 10);
    const medals = ['🥇', '🥈', '🥉'];
    const lines = rows.map((s, i) =>
      `${medals[i] || `**${i + 1}.**`} **${esc(s.name)}** — 💰 **${fmt(s.won)}** won • 🏆 ${s.wins} win${s.wins === 1 ? '' : 's'} • 🎟 ${s.entries} entr${s.entries === 1 ? 'y' : 'ies'}`);
    return new EmbedBuilder().setColor(0xE7B41A).setTitle('🏆 Lottery — Hall of Fame')
      .setDescription(lines.join('\n') || 'No winners yet — the wheel awaits its first champion!');
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

      if (interaction.commandName === 'lottery-cancel') {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild))
          return interaction.reply({ content: 'You need **Manage Server** to cancel a lottery.', flags: 64 });
        if (!state.active) return interaction.reply({ content: 'There is no lottery running right now.', flags: 64 });
        await interaction.reply({ content: '🛑 Stopping the lottery and refunding all wagers…', flags: 64 });
        const res = await cancelLottery(gid);
        await interaction.editReply({ content: res.none ? '🛑 No active lottery to cancel.' : `🛑 Lottery cancelled — refunded **${fmt(res.refunded)} Dinar** across **${res.players}** player${res.players === 1 ? '' : 's'}.` });
        return;
      }

      if (interaction.commandName === 'lottery-leaderboard') {
        return interaction.reply({ embeds: [leaderboardEmbed(state)] });
      }

      if (interaction.commandName === 'dinar-lotto') {
        const wager = interaction.options.getInteger('wager');
        const name = interaction.member?.displayName || interaction.user.username;
        const r = addEntry(state, db, gid, saveData, interaction.user.id, name, wager);
        if (r.error) return interaction.reply({ content: r.error, flags: 64 });
        const L = state.active;
        const inLottoChannel = interaction.channelId === L.channelId;
        const summaryData = { name, wager: r.wager, chance: r.chance, pool: r.pool, count: r.count };
        if (!inLottoChannel) await interaction.reply({ content: `🎟 You're in with **${fmt(r.wager)} Dinar**! Watch <#${L.channelId}> for the wheel.`, flags: 64 });
        else await interaction.deferReply();
        // the join animation plays the insert ONCE, then the message settles into a
        // continuous spin (like the announcement). Only the LATEST participant keeps a wheel —
        // the previous one collapses to its clean summary the moment someone newer joins.
        queueRender(async () => {
          try {
            const Lnow = stateOf(gid).active;
            const live = Lnow && Lnow.id === L.id ? Lnow : L;
            await collapseJoin(live);                                  // retire the previous wheel
            const entries = entryList(live);
            const idx = entries.findIndex(e => e.id === interaction.user.id);
            const { buf, ms } = buildJoinGif(entries, idx, r.pool);    // plays once, then freezes
            const file = new AttachmentBuilder(buf, { name: 'wheel.gif' });
            const payload = { embeds: [new EmbedBuilder().setColor(0xE7B41A).setDescription(`🎡 **${esc(name)}** spins into the lottery…`).setImage('attachment://wheel.gif')], files: [file] };
            let msg;
            if (inLottoChannel) { await interaction.editReply(payload); msg = await interaction.fetchReply(); }
            else { const ch = await client.channels.fetch(L.channelId); msg = await ch.send(payload); }
            live.lastJoin = { channelId: L.channelId, messageId: msg.id, summary: summaryData };
            saveData(gid);
            // after the single insert play, swap in the seamless looping wheel so it keeps spinning
            setTimeout(() => queueRender(() => toLiveLoop(gid, msg.id, summaryData)), ms + 120);
          } catch (e) {
            console.error('[lottery join gif]', e.message);
            if (inLottoChannel) interaction.editReply({ embeds: [joinSummaryEmbed(summaryData)] }).catch(() => {});
          }
        });
        // keep the permanent announcement's wheel + numbers current
        queueRender(() => refreshAnnouncement(gid));
        queueRender(() => refreshReminders(gid));
        return;
      }
    } catch (e) { console.error('[lottery interaction]', e.message); }
  });

  return { _test: {
    getState: () => stateOf, addEntry, pickWinner, ensureSched, pickTimes, entryList,
    buildWheelSVG, renderLiveGif, renderJoinGif, renderResultGif, renderWinnerStill,
    startLottery, closeLottery, cancelLottery, remind, refreshReminders, tick, libyaDayKey, startOfLibyaDayUTC, leaderboardEmbed,
    planJoinFrames, buildJoinGif, collapseJoin, toLiveLoop, joinSummaryEmbed, liveWheel, RESULT_GIF_MS,
  } };
}

module.exports = { getLottoCommands, initLotto };
