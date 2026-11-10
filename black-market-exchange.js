// =============================================================================
// LIBYAN PARALLEL-MARKET RATE (USD) — source: Fulus API (https://fulus.ly/api/v1)
// Requires the environment variable FULUS_TOKEN. Posts when the cash rate moves;
// bank certificate rates are shown in the embed.
// =============================================================================

const {
  SlashCommandBuilder,
  EmbedBuilder,
  AttachmentBuilder,
  PermissionFlagsBits,
} = require('discord.js');

const FULUS_BASE         = 'https://fulus.ly/api/v1';
const FULUS_TOKEN        = process.env.FULUS_TOKEN;
const CURRENCY           = 'USD';
const SCRAPE_INTERVAL_MS = 60 * 60 * 1000;     // 1 hour; each run makes 2 requests (cash + banks)
const REQUEST_TIMEOUT_MS = 15_000;
const STALE_AFTER_MS     = 6 * 60 * 60 * 1000; // warn if Fulus' own timestamp is older than this
const MAX_HISTORY        = 72;                 // stored rate MOVES
const MAX_POINTS         = 20;                 // points shown on the chart

const fmt2     = v => (v == null || isNaN(v) ? 'N/A' : Number(v).toFixed(2));
const fmtDelta = d => { const m = Math.abs(d); return m >= 0.1 ? m.toFixed(2) : m.toFixed(3); };
const unix     = iso => Math.floor(new Date(iso).getTime() / 1000);

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------
const exchangeCommands = [
  new SlashCommandBuilder()
    .setName('exchange-set-channel')
    .setDescription('Set the channel for Libyan dinar USD rate updates')
    .addChannelOption(o =>
      o.setName('channel')
        .setDescription('Channel to post rate updates in')
        .setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName('exchange-rate')
    .setDescription('Show the latest saved Libyan dinar USD rate')
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName('exchange-refresh')
    .setDescription('Admin: fetch the latest rate right now')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName('exchange-debug')
    .setDescription('Admin: show the last 5 rate moves (for debugging)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),
].map(c => c.toJSON());

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------
function getExchangeData(db, guildId) {
  if (!db[guildId]) db[guildId] = {};
  const ex = db[guildId].__exchange || (db[guildId].__exchange = {
    channelId: null, lastCheckedAt: null, pausedUntil: null, history: [],
  });
  // drop entries saved by the old multi-currency version
  ex.history = (ex.history || []).filter(e => e && typeof e.rate === 'number');
  return ex;
}

// Fulus' daily request limit resets at midnight UTC+2.
function nextResetMs() {
  const u2 = new Date(Date.now() + 2 * 3600e3);
  return Date.UTC(u2.getUTCFullYear(), u2.getUTCMonth(), u2.getUTCDate() + 1) - 2 * 3600e3;
}

// ---------------------------------------------------------------------------
// Fulus API client
// ---------------------------------------------------------------------------
class FulusError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function fulus(path, params = {}) {
  if (!FULUS_TOKEN) throw new FulusError('FULUS_TOKEN is not set');
  const url = new URL(FULUS_BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${FULUS_TOKEN}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // 401 uses "message", 403/404/422/429 use "error"
    throw new FulusError(body.error || body.message || `HTTP ${res.status}`, res.status);
  }
  return body;
}

async function fetchUsdRates() {
  const cashBody = await fulus('/rates/current', { currency: CURRENCY, rate_type: 'cash' });
  const cash = cashBody.data || {};
  const rate = Number(cash.rate);
  if (!(rate > 0)) throw new FulusError('Fulus returned no valid cash rate');

  let banks = [];
  try {
    const bankBody = await fulus('/rates/banks', { currency: CURRENCY });
    banks = (bankBody.data || [])
      .map(b => ({ name: b.bank_name, rate: Number(b.rate), timestamp: b.timestamp }))
      .filter(b => b.rate > 0)
      .sort((a, b) => a.rate - b.rate);
  } catch (err) {
    // bank list is optional — the plan may not include it
    console.warn(`[Exchange] bank rates unavailable: ${err.message}`);
  }

  return {
    rate,
    timestamp: cash.timestamp || null,   // Fulus' own time for this rate
    scrapedAt: new Date().toISOString(), // when we fetched it
    banks,
  };
}

function isStale(latest) {
  const t = Date.parse(latest.timestamp);
  return !isNaN(t) && Date.now() - t > STALE_AFTER_MS;
}

// ---------------------------------------------------------------------------
// Embed
// ---------------------------------------------------------------------------
function buildRateEmbed(ex, latest) {
  const h = ex.history || [];
  const sourceTs = unix(latest.timestamp || latest.scrapedAt);

  let move = 'No previous move recorded yet.';
  if (h.length >= 2) {
    const prev = h.at(-2);
    const now  = h.at(-1);
    const d    = now.rate - prev.rate;
    const when = unix(now.timestamp || now.scrapedAt);
    const marker = d > 0 ? '🔴 ↑ +' : '🟢 ↓ −';   // red = dinar weaker, green = dinar stronger
    move = `${marker}${fmtDelta(d)} (${fmt2(prev.rate)} → ${fmt2(now.rate)}) at <t:${when}:f>`;
  }

  const lines = [
    `**${fmt2(latest.rate)} LYD per USD** (parallel market, cash)`,
    `Source updated: <t:${sourceTs}:f> (<t:${sourceTs}:R>)`,
    `Last move: ${move}`,
  ];
  if (isStale(latest)) {
    lines.push(`⚠️ Fulus' timestamp is more than ${STALE_AFTER_MS / 3600e3} hours old. The rate may be out of date.`);
  }

  const embed = new EmbedBuilder()
    .setColor(0x1B8F5A)
    .setTitle('🇱🇾 Libyan Dinar — USD Parallel Rate')
    .setDescription(lines.join('\n'))
    .setTimestamp(new Date(latest.timestamp || latest.scrapedAt))
    .setFooter({ text: 'Created & Designed by Captain' });

  if (latest.banks && latest.banks.length) {
    const value = latest.banks.map(b => `${b.name}: **${fmt2(b.rate)}**`).join('\n').slice(0, 1024);
    embed.addFields({ name: '🏦 Bank certificate rates', value });
  }
  return embed;
}

// ---------------------------------------------------------------------------
// Chart — SVG line of the cash rate after each move
// ---------------------------------------------------------------------------
function svgEscape(value) {
  return String(value).replace(
    /[&<>"']/g,
    ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])
  );
}

function buildChartSvg(history) {
  const cName = 'US Dollar';
  const pts = (history || [])
    .filter(e => e && typeof e.rate === 'number' && e.scrapedAt)
    .map(e => ({ ts: new Date(e.scrapedAt), v: e.rate }))
    .filter(p => !isNaN(p.ts))
    .sort((a, b) => a.ts - b.ts)
    .slice(-MAX_POINTS);

  const W = 1000, H = 470;
  const bg = '#12141a', panel = '#171a21';
  const font = "'DejaVu Sans',Arial,sans-serif";

  if (pts.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
      <rect width="${W}" height="${H}" fill="${bg}" rx="14"/>
      <text x="${W / 2}" y="${H / 2}" text-anchor="middle" font-family="${font}"
        font-size="18" fill="#6b7280">No exchange-rate data yet</text></svg>`;
  }

  const first = pts[0].v, last = pts[pts.length - 1].v;
  const change = last - first;
  const up = change > 0, flat = Math.abs(change) < 1e-9;
  const ACCENT = flat ? '#94a3b8' : (up ? '#ef4444' : '#22c55e');
  const ACCENT_SOFT = flat ? '#64748b' : (up ? '#f87171' : '#4ade80');

  const pad = { left: 74, right: 92, top: 96, bottom: 76 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  // y scale with round ticks
  const vals = pts.map(p => p.v);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi - lo < 1e-9) { const b = Math.max(0.02, Math.abs(hi) * 0.01); lo -= b; hi += b; }
  const headroom = (hi - lo) * 0.22;
  lo = Math.max(0, lo - headroom); hi = hi + headroom;

  const niceStep = range => {
    const exp = Math.floor(Math.log10(range || 1));
    const f = range / Math.pow(10, exp);
    return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * Math.pow(10, exp);
  };
  const step = niceStep((hi - lo) / 4);
  const ticks = [];
  for (let v = Math.floor(lo / step) * step; v <= hi + step * 0.001; v += step) {
    const r = Math.round(v * 1e6) / 1e6;
    if (r >= lo - 1e-9 && r <= hi + 1e-9) ticks.push(r);
    if (ticks.length > 8) break;
  }
  const tickDecimals = step >= 0.01 ? 2 : step >= 0.001 ? 3 : 4;

  const yFor = v => pad.top + (1 - (v - lo) / (hi - lo)) * plotH;
  const xFor = i => pts.length === 1
    ? pad.left + plotW / 2
    : pad.left + (i / (pts.length - 1)) * plotW;

  const grid = ticks.map(v => {
    const y = yFor(v).toFixed(1);
    return `<line x1="${pad.left}" y1="${y}" x2="${pad.left + plotW}" y2="${y}" stroke="#252932" stroke-width="1"/>
    <text x="${pad.left - 12}" y="${(+y + 4).toFixed(1)}" text-anchor="end" font-family="${font}" font-size="12" fill="#7c8798">${v.toFixed(tickDecimals)}</text>`;
  }).join('\n  ');

  // x labels: date-led over multi-day windows, time-led otherwise
  const spanMs = pts.length > 1 ? (pts[pts.length - 1].ts - pts[0].ts) : 0;
  const dateLed = spanMs > 36 * 3600 * 1000;
  const MIN_LABEL_PX = dateLed ? 58 : 74;
  const spacing = pts.length > 1 ? plotW / (pts.length - 1) : plotW;
  const every = Math.max(1, Math.ceil(MIN_LABEL_PX / spacing));
  const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const two = n => String(n).padStart(2, '0');
  const xLabels = [];
  let lastMonth = null;
  pts.forEach((p, i) => {
    const isLast = i === pts.length - 1;
    if (!(i === 0 || isLast || i % every === 0)) return;
    if (!isLast && i !== 0 && (pts.length - 1 - i) * spacing < MIN_LABEL_PX * 0.8) return;
    const x = xFor(i);
    const y = pad.top + plotH;
    const primary = dateLed
      ? `${p.ts.getDate()} ${MON[p.ts.getMonth()]}`
      : `${two(p.ts.getHours())}:${two(p.ts.getMinutes())}`;
    let secondary = '';
    if (dateLed) {
      secondary = `${two(p.ts.getHours())}:${two(p.ts.getMinutes())}`;
    } else {
      const monthKey = `${p.ts.getDate()}-${p.ts.getMonth()}`;
      if (monthKey !== lastMonth) { secondary = `${p.ts.getDate()} ${MON[p.ts.getMonth()]}`; lastMonth = monthKey; }
    }
    xLabels.push(
      `<line x1="${x.toFixed(1)}" y1="${y}" x2="${x.toFixed(1)}" y2="${y + 5}" stroke="#3b4250" stroke-width="1"/>`,
      `<text x="${x.toFixed(1)}" y="${y + 21}" text-anchor="middle" font-family="${font}" font-size="11" font-weight="${isLast ? 700 : 600}" fill="${isLast ? '#e5e7eb' : '#8b95a6'}">${primary}</text>`,
      secondary
        ? `<text x="${x.toFixed(1)}" y="${y + 36}" text-anchor="middle" font-family="${font}" font-size="9.5" fill="#5b6474">${secondary}</text>`
        : ''
    );
  });

  const linePts = pts.map((p, i) => `${xFor(i).toFixed(1)},${yFor(p.v).toFixed(1)}`);
  const areaPath = `M ${xFor(0).toFixed(1)},${(pad.top + plotH).toFixed(1)} L ${linePts.join(' L ')} `
    + `L ${xFor(pts.length - 1).toFixed(1)},${(pad.top + plotH).toFixed(1)} Z`;

  const hiIdx = vals.indexOf(Math.max(...vals));
  const loIdx = vals.indexOf(Math.min(...vals));
  const dots = pts.map((p, i) => {
    if (i === pts.length - 1) return '';
    return `<circle cx="${xFor(i).toFixed(1)}" cy="${yFor(p.v).toFixed(1)}" r="4" fill="${panel}" stroke="${ACCENT}" stroke-width="2"/>`;
  }).join('\n    ');

  const lastX = xFor(pts.length - 1), lastY = yFor(last);
  const endMarker = `
    <circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="11" fill="${ACCENT}" opacity="0.18"/>
    <circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="6.5" fill="${ACCENT}" stroke="#0b0d12" stroke-width="2"/>`;

  const tagW = 78, tagH = 26;
  const tagX = Math.min(pad.left + plotW + 8, W - tagW - 8);
  const priceTag = `
    <line x1="${pad.left}" y1="${lastY.toFixed(1)}" x2="${(pad.left + plotW).toFixed(1)}" y2="${lastY.toFixed(1)}"
      stroke="${ACCENT}" stroke-width="1" stroke-dasharray="4 4" opacity="0.55"/>
    <rect x="${tagX}" y="${(lastY - tagH / 2).toFixed(1)}" width="${tagW}" height="${tagH}" rx="6" fill="${ACCENT}"/>
    <text x="${(tagX + tagW / 2).toFixed(1)}" y="${(lastY + 5).toFixed(1)}" text-anchor="middle" font-family="${font}" font-size="13" font-weight="700" fill="#0b0d12">${fmt2(last)}</text>`;

  const callout = (idx, label, colour) => {
    if (pts.length < 3 || idx === pts.length - 1) return '';
    if (hiIdx === loIdx || Math.abs(vals[hiIdx] - vals[loIdx]) < 1e-9) return '';
    const x = xFor(idx), y = yFor(pts[idx].v);
    const above = idx === hiIdx;
    const ly = above ? y - 14 : y + 22;
    const nearLeft = x < pad.left + 46, nearRight = x > pad.left + plotW - 46;
    const anchor = nearLeft ? 'start' : nearRight ? 'end' : 'middle';
    const lx = nearLeft ? pad.left + 6 : nearRight ? pad.left + plotW - 6 : x;
    return `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="${anchor}" font-family="${font}" font-size="10.5" font-weight="600" fill="${colour}">${label} ${fmt2(pts[idx].v)}</text>`;
  };

  const pct = first !== 0 ? (change / first) * 100 : 0;
  const arrow = flat ? '—' : (up ? '▲' : '▼');
  const mag = Math.abs(change);
  const deltaDecimals = mag >= 0.1 ? 2 : mag >= 0.01 ? 3 : mag >= 0.001 ? 4 : 5;
  const deltaTxt = flat
    ? 'No change over this period'
    : `${arrow} ${up ? '+' : '−'}${mag.toFixed(deltaDecimals)} (${up ? '+' : '−'}${Math.abs(pct).toFixed(2)}%)`;
  const meaning = flat ? '' : (up ? 'dinar weaker' : 'dinar stronger');

  const fmtStamp = d => `${d.getDate()} ${MON[d.getMonth()]} ${two(d.getHours())}:${two(d.getMinutes())}`;
  const spanTxt = pts.length > 1
    ? `${fmtStamp(pts[0].ts)}  →  ${fmtStamp(pts[pts.length - 1].ts)}`
    : fmtStamp(pts[0].ts);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${ACCENT}" stop-opacity="0.34"/>
      <stop offset="100%" stop-color="${ACCENT}" stop-opacity="0.02"/>
    </linearGradient>
    <linearGradient id="lineGrad" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${ACCENT_SOFT}"/>
      <stop offset="100%" stop-color="${ACCENT}"/>
    </linearGradient>
    <clipPath id="plotClip"><rect x="${pad.left}" y="${pad.top}" width="${plotW}" height="${plotH}"/></clipPath>
  </defs>

  <rect width="${W}" height="${H}" fill="${bg}" rx="14"/>
  <rect x="${pad.left}" y="${pad.top}" width="${plotW}" height="${plotH}" fill="${panel}" rx="6"/>
  ${grid}

  <g clip-path="url(#plotClip)">
    <path d="${areaPath}" fill="url(#areaFill)"/>
    <polyline points="${linePts.join(' ')}" fill="none" stroke="url(#lineGrad)" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>
    ${dots}
    ${endMarker}
  </g>
  ${callout(hiIdx, 'high', '#f87171')}
  ${callout(loIdx, 'low', '#4ade80')}
  ${priceTag}

  <line x1="${pad.left}" y1="${pad.top + plotH}" x2="${pad.left + plotW}" y2="${pad.top + plotH}" stroke="#3b4250" stroke-width="1"/>
  <line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${pad.top + plotH}" stroke="#3b4250" stroke-width="1"/>
  ${xLabels.join('\n  ')}

  <text x="${pad.left}" y="34" font-family="${font}" font-size="17" font-weight="700" fill="#f3f4f6">${svgEscape(cName)} / Libyan Dinar</text>
  <text x="${pad.left}" y="55" font-family="${font}" font-size="11.5" fill="#6b7280">Parallel market · last ${pts.length} move${pts.length === 1 ? '' : 's'}</text>
  <text x="${pad.left}" y="73" font-family="${font}" font-size="11" fill="#565f6e">${svgEscape(spanTxt)}</text>

  <text x="${W - pad.right + 60}" y="38" text-anchor="end" font-family="${font}" font-size="30" font-weight="700" fill="#f9fafb">${fmt2(last)}</text>
  <text x="${W - pad.right + 60}" y="58" text-anchor="end" font-family="${font}" font-size="12" font-weight="600" fill="${ACCENT}">${svgEscape(deltaTxt)}</text>
  ${meaning ? `<text x="${W - pad.right + 60}" y="75" text-anchor="end" font-family="${font}" font-size="10.5" fill="#6b7280">${meaning}</text>` : ''}

  <text x="${pad.left}" y="${H - 14}" font-family="${font}" font-size="10" fill="#4b5563">Green = dinar stronger · Red = dinar weaker</text>
  <text x="${W - 20}" y="${H - 14}" text-anchor="end" font-family="${font}" font-size="10" fill="#4b5563">Created &amp; Designed by Captain</text>
</svg>`;
}

const FONT_CANDIDATES = [
  require('path').join(__dirname, 'fonts', 'DejaVuSans.ttf'),
  require('path').join(__dirname, 'DejaVuSans.ttf'),
];
const FONT_PATH = FONT_CANDIDATES.find(f => { try { return require('fs').existsSync(f); } catch { return false; } }) || FONT_CANDIDATES[0];

async function svgToPngBuffer(svgString) {
  const { Resvg } = require('@resvg/resvg-js');
  const resvg = new Resvg(svgString, {
    background: '#1a1c22',
    font: {
      loadSystemFonts: false,
      fontFiles: [FONT_PATH],
      defaultFontFamily: 'DejaVu Sans',
    },
  });
  return resvg.render().asPng();
}

async function chartAttachment(ex) {
  const pngBuffer = await svgToPngBuffer(buildChartSvg(ex.history));
  return new AttachmentBuilder(pngBuffer, { name: 'libya-usd-chart.png' });
}

// ---------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------
async function postUpdate(client, guildId, ex, latest) {
  if (!ex.channelId) return false;
  const channel = await client.channels.fetch(ex.channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return false;

  const embed = buildRateEmbed(ex, latest);
  const payload = { embeds: [embed] };
  try {
    const att = await chartAttachment(ex);
    embed.setImage(`attachment://${att.name}`);
    payload.files = [att];
  } catch (err) {
    console.warn(`[Exchange] Chart render failed (posting without it): ${err.message}`);
  }
  await channel.send(payload);
  return true;
}

// ---------------------------------------------------------------------------
// Core update
// ---------------------------------------------------------------------------
async function updateRates({ client, db, saveData, guildId, forcePost = false }) {
  const ex = getExchangeData(db, guildId);
  ex.lastCheckedAt = new Date().toISOString();

  if (!forcePost && ex.pausedUntil && Date.now() < ex.pausedUntil) {
    saveData(guildId);
    return { posted: false, changed: false, skipped: true };
  }

  let latest;
  try {
    latest = await fetchUsdRates();
    ex.pausedUntil = null;
  } catch (err) {
    if (err.status === 429) ex.pausedUntil = nextResetMs();
    console.error(`[Exchange] Fetch failed${err.status ? ` (HTTP ${err.status})` : ''}: ${err.message}`);
    saveData(guildId);
    throw err;
  }

  ex.lastRate = latest;
  const lastMove = ex.history.at(-1);
  const changed = !lastMove || lastMove.rate !== latest.rate;
  if (changed) {
    ex.history.push({ rate: latest.rate, timestamp: latest.timestamp, scrapedAt: latest.scrapedAt });
    ex.history = ex.history.slice(-MAX_HISTORY);
  }

  let posted = false;
  if (forcePost || changed) posted = await postUpdate(client, guildId, ex, latest);

  saveData(guildId);
  return { latest, changed, posted, skipped: false };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function isAdmin(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
}

async function safeReply(interaction, payload) {
  try {
    if (interaction.replied) return interaction.followUp(payload);
    if (interaction.deferred) return interaction.editReply(payload);
    return interaction.reply(payload);
  } catch (err) {
    console.error('Exchange safeReply failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Module entry point
// ---------------------------------------------------------------------------
module.exports = function initBlackMarketExchange({ client, db, saveData }) {
  const timers = new Map();

  if (!FULUS_TOKEN) console.error('[Exchange] FULUS_TOKEN is not set — exchange updates are disabled.');

  function scheduleGuild(guildId) {
    if (!FULUS_TOKEN) return;
    if (timers.has(guildId)) clearInterval(timers.get(guildId));
    const timer = setInterval(() => {
      updateRates({ client, db, saveData, guildId }).catch(() => {}); // already logged inside
    }, SCRAPE_INTERVAL_MS);
    timers.set(guildId, timer);
  }

  client.once('clientReady', async () => {
    // The database may load after clientReady, so retry the startup check.
    [6_000, 15_000, 30_000].forEach(delay => {
      setTimeout(() => {
        for (const guild of client.guilds.cache.values()) {
          const ex = getExchangeData(db, guild.id);
          if (ex.channelId && !timers.has(guild.id)) {
            console.log(`[Exchange] Updates enabled for guild ${guild.id} (loaded after ${delay / 1000}s)`);
            scheduleGuild(guild.id);
            updateRates({ client, db, saveData, guildId: guild.id }).catch(() => {});
          }
        }
      }, delay);
    });
  });

  client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    if (!interaction.guild) return;
    const { commandName, guild } = interaction;
    if (!commandName.startsWith('exchange-')) return;

    const ex = getExchangeData(db, guild.id);

    try {
      // ── /exchange-set-channel ────────────────────────────────────────────
      if (commandName === 'exchange-set-channel') {
        if (!isAdmin(interaction))
          return safeReply(interaction, { content: 'Only admins can set the exchange update channel.', flags: 64 });
        const channel = interaction.options.getChannel('channel');
        if (!channel || !channel.isTextBased())
          return safeReply(interaction, { content: 'Please choose a text channel.', flags: 64 });
        ex.channelId = channel.id;
        saveData(guild.id);
        scheduleGuild(guild.id);
        await safeReply(interaction, {
          content: `Rate updates will post in ${channel} when the rate changes (checked hourly). Fetching the latest rate now...`,
          flags: 64,
        });
        await updateRates({ client, db, saveData, guildId: guild.id, forcePost: true }).catch(() => {});
        return;
      }

      // ── /exchange-rate ───────────────────────────────────────────────────
      if (commandName === 'exchange-rate') {
        if (!ex.lastRate)
          return safeReply(interaction, { content: 'No exchange rate has been saved yet.', flags: 64 });
        const embed = buildRateEmbed(ex, ex.lastRate);
        const payload = { embeds: [embed], flags: 64 };
        try {
          const att = await chartAttachment(ex);
          embed.setImage(`attachment://${att.name}`);
          payload.files = [att];
        } catch { /* post without chart if render fails */ }
        return safeReply(interaction, payload);
      }

      // ── /exchange-refresh ────────────────────────────────────────────────
      if (commandName === 'exchange-refresh') {
        if (!isAdmin(interaction))
          return safeReply(interaction, { content: 'Only admins can refresh.', flags: 64 });
        await interaction.deferReply({ flags: 64 });
        let result;
        try {
          result = await updateRates({ client, db, saveData, guildId: guild.id, forcePost: false });
        } catch (err) {
          return safeReply(interaction, { content: `❌ Couldn't fetch the rate: ${err.message?.slice(0, 150)}` });
        }
        const status = result.posted
          ? 'New rate posted to the configured channel.'
          : !ex.channelId
            ? 'Rate saved, but no channel is configured yet. Use `/exchange-set-channel` first.'
            : 'Rate unchanged since last post.';
        return safeReply(interaction, { content: `Exchange rate refreshed. ${status}` });
      }

      // ── /exchange-debug ──────────────────────────────────────────────────
      if (commandName === 'exchange-debug') {
        if (!isAdmin(interaction))
          return safeReply(interaction, { content: 'Admin only.', flags: 64 });
        const lastFew = ex.history.slice(-5);
        if (!lastFew.length)
          return safeReply(interaction, { content: 'No data yet.', flags: 64 });
        let msg = '**Last 5 rate moves (oldest → newest):**';
        lastFew.forEach((e, i) => {
          msg += `\n${i + 1}. <t:${unix(e.timestamp || e.scrapedAt)}:f>: ${fmt2(e.rate)} LYD`;
        });
        return safeReply(interaction, { content: msg, flags: 64 });
      }
    } catch (err) {
      console.error(`[Exchange] Command failed (${commandName}):`, err);
      return safeReply(interaction, { content: `❌ Exchange error: ${err.message?.slice(0, 200)}`, flags: 64 });
    }
  });
};

module.exports.commands = exchangeCommands;

// Hub API: render the latest saved rate without making a new request.
module.exports.getHubView = async function (db, guildId) {
  const ex = getExchangeData(db, guildId);
  if (!ex.lastRate) return null;
  const embed = buildRateEmbed(ex, ex.lastRate);
  const payload = { embeds: [embed] };
  try {
    const att = await chartAttachment(ex);
    embed.setImage(`attachment://${att.name}`);
    payload.files = [att];
  } catch { /* show without chart if render fails */ }
  return payload;
};
