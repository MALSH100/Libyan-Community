// =============================================================================
// LIBYAN BLACK MARKET EXCHANGE RATE
// Source: https://en.blackmarketlive.org/lyd/
// =============================================================================

const {
  SlashCommandBuilder,
  EmbedBuilder,
  AttachmentBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

const SOURCE_URL        = 'https://en.blackmarketlive.org/lyd/';
const SCRAPE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const MAX_HISTORY        = 168;             // ~7 days of hourly snapshots
const CURRENCIES         = ['USD', 'EUR', 'GBP'];

// ---------------------------------------------------------------------------
// Slash commands (unchanged from original — no breaking changes)
// ---------------------------------------------------------------------------
const exchangeCommands = [
  new SlashCommandBuilder()
    .setName('exchange-set-channel')
    .setDescription('Set the channel for hourly Libyan black market exchange updates')
    .addChannelOption(o =>
      o.setName('channel')
        .setDescription('Channel to post exchange updates in')
        .setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName('exchange-rate')
    .setDescription('Show the latest saved Libyan black market exchange rate')
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName('exchange-refresh')
    .setDescription('Admin: fetch the latest exchange rate right now')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName('exchange-debug')
    .setDescription('Admin: show last 5 exchange rate entries (for debugging)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),
].map(c => c.toJSON());

// ---------------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------------
function getExchangeData(db, guildId) {
  if (!db[guildId]) db[guildId] = {};
  if (!db[guildId].__exchange) {
    db[guildId].__exchange = {
      channelId:      null,
      lastRates:      null,
      lastPostedKey:  null,
      lastCheckedAt:  null,
      history:        [],
    };
  }
  return db[guildId].__exchange;
}

function rateKey(rates) {
  return CURRENCIES.map(c => `${c}:${rates[c] ?? 'na'}`).join('|');
}

// ---------------------------------------------------------------------------
// Scraper — simple HTTP fetch + cheerio, no browser required
// ---------------------------------------------------------------------------

/**
 * Fetches the exchange rate page and parses the USD, EUR, and GBP rates.
 * Returns { rates: { USD, EUR, GBP }, scrapedAt, sourceUrl, siteTimestamp }
 */
async function scrapeRates() {
  const cheerio = require('cheerio');

  const res = await fetch(SOURCE_URL, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
        'AppleWebKit/537.36 (KHTML, like Gecko) ' +
        'Chrome/124.0.0.0 Safari/537.36',
      'Accept-Language': 'en-GB,en;q=0.9',
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${SOURCE_URL}`);
  }

  const html = await res.text();
  const $    = cheerio.load(html);

  // --- Pull the site's own "last updated" timestamp from the intro paragraph ---
  let siteTimestamp = null;
  $('p, strong, b, span').each((_, el) => {
    const txt = $(el).text();
    // Matches patterns like "Jun 2, 2026 / 4:50 am Libya Time"
    const m = txt.match(/\b(\w{3}\s+\d{1,2},\s+\d{4}\s*\/\s*[\d:]+\s*[ap]m[^)]*)/i);
    if (m && !siteTimestamp) siteTimestamp = m[1].trim();
  });

  // --- Parse the rates table ---
  const rates = { USD: null, EUR: null, GBP: null };

  $('table tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 2) return;

    // The first cell contains an <img> + plain text currency name.
    // $(cells[0]).text() gives us the alt text of the image + the label,
    // e.g. "eur Euro" or just "Euro" depending on the render.
    // We lowercase and strip whitespace to keep matching simple.
    const nameTxt = $(cells[0]).text().replace(/\s+/g, ' ').trim().toLowerCase();
    const priceTxt = $(cells[1]).text().trim();
    const price    = parseFloat(priceTxt);

    if (!isNaN(price) && price > 0 && price < 200) {
      if (nameTxt.includes('us dollar') || (nameTxt.includes('dollar') && !nameTxt.includes('canadian') && !nameTxt.includes('aus'))) {
        rates.USD = Math.round(price * 1000) / 1000;
      } else if (nameTxt.includes('euro')) {
        rates.EUR = Math.round(price * 1000) / 1000;
      } else if (nameTxt.includes('british pound') || (nameTxt.includes('pound') && !nameTxt.includes('egyptian'))) {
        rates.GBP = Math.round(price * 1000) / 1000;
      }
    }
  });

  const missing = CURRENCIES.filter(c => rates[c] === null);
  if (missing.length === CURRENCIES.length) {
    throw new Error(
      `Could not parse any rates from ${SOURCE_URL}. ` +
      'The page structure may have changed.'
    );
  }
  if (missing.length > 0) {
    console.warn(`[Exchange] Warning: could not parse ${missing.join(', ')}`);
  }

  console.log(`[Exchange] Scraped rates: USD=${rates.USD}, EUR=${rates.EUR}, GBP=${rates.GBP}`);

  return {
    rates,
    scrapedAt:     new Date().toISOString(),
    sourceUrl:     SOURCE_URL,
    siteTimestamp: siteTimestamp ?? null,
  };
}

// ---------------------------------------------------------------------------
// Trend helper
// ---------------------------------------------------------------------------
function trend(history, currency, latestValue) {
  const previous = [...history]
    .reverse()
    .find(entry => entry.rates && entry.rates[currency] != null);

  if (!previous || latestValue == null) return { label: 'No previous data', delta: null };
  const delta = Math.round((latestValue - previous.rates[currency]) * 1000) / 1000;
  if (delta > 0) return { label: `🔴 ↑ +${delta.toFixed(3)}`, delta };
  if (delta < 0) return { label: `🟢 ↓ ${delta.toFixed(3)}`, delta };
  return { label: '⚪ No change', delta: 0 };
}

// ---------------------------------------------------------------------------
// Embed builder
// ---------------------------------------------------------------------------
function buildRateEmbed(exchangeData, latest, forced = false) {
  const history    = exchangeData.history || [];
  const pulledAt   = new Date(latest.scrapedAt || Date.now())
    .toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short' });
  const siteNote   = latest.siteTimestamp
    ? `\nSite last updated: ${latest.siteTimestamp}`
    : '';

  const embed = new EmbedBuilder()
    .setColor(0x1B8F5A)
    .setTitle('🇱🇾 Libyan Black Market Exchange Rate')
    .setDescription(
      (forced ? `Manual refresh — pulled on ` : `Rates pulled on `) +
      pulledAt + siteNote
    )
    .setTimestamp(new Date(latest.scrapedAt || Date.now()))
    .setFooter({
      text: 'Live Libyan Black Market Rates • Updated every hour • Created & Designed by Captain',
    });

  for (const currency of CURRENCIES) {
    const value = latest.rates[currency];
    const t     = trend(history.slice(0, -1), currency, value);
    embed.addFields({
      name:   currency,
      value:  value == null
        ? 'Not available'
        : `**${value.toFixed(2)} LYD**\n${t.label}`,
      inline: true,
    });
  }

  return embed;
}

// ---------------------------------------------------------------------------
// Chart (SVG candlestick — identical logic, no Facebook dependency)
// ---------------------------------------------------------------------------
function svgEscape(value) {
  return String(value).replace(
    /[&<>"']/g,
    ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])
  );
}

function buildChartSvg(history, mainCurrency = 'USD') {
  // Aggregate: one data point per day (last entry of each day wins)
  const dailyMap = new Map();
  (history || [])
    .filter(entry => entry.rates && typeof entry.rates[mainCurrency] === 'number')
    .forEach(entry => {
      const key = entry.scrapedAt.slice(0, 10);
      if (!dailyMap.has(key) || new Date(entry.scrapedAt) > new Date(dailyMap.get(key).scrapedAt)) {
        dailyMap.set(key, entry);
      }
    });

  const rows = Array.from(dailyMap.values())
    .sort((a, b) => new Date(a.scrapedAt) - new Date(b.scrapedAt))
    .slice(-30);

  if (rows.length === 0) {
    return `<svg width="960" height="420" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#1a1c22" rx="10"/><text x="480" y="210" text-anchor="middle" font-family="'Segoe UI',Arial,sans-serif" font-size="18" fill="#6b7280">Not enough data for chart yet</text></svg>`;
  }

  // LIBYAN COLOR LOGIC: GREEN = rate fell (dinar strengthened), RED = rate rose (dinar weakened)
  const GREEN       = '#22c55e';
  const GREEN_LIGHT = '#4ade80';
  const RED         = '#ef4444';
  const RED_LIGHT   = '#f87171';
  const NEUTRAL     = '#94a3b8';

  const candles = [];
  for (let i = 0; i < rows.length; i++) {
    const close              = rows[i].rates[mainCurrency];
    const open               = i === 0 ? close : rows[i - 1].rates[mainCurrency];
    const high               = Math.max(open, close);
    const low                = Math.min(open, close);
    const ts                 = new Date(rows[i].scrapedAt);
    const dinarStrengthened  = close < open;
    const dinarWeakened      = close > open;
    const color              = dinarStrengthened ? GREEN  : (dinarWeakened ? RED  : NEUTRAL);
    const colorLight         = dinarStrengthened ? GREEN_LIGHT : (dinarWeakened ? RED_LIGHT : NEUTRAL);
    candles.push({ ts, open, high, low, close, color, colorLight, dinarStrengthened });
  }

  const allVals  = candles.flatMap(c => [c.high, c.low]);
  let minVal     = Math.min(...allVals);
  let maxVal     = Math.max(...allVals);
  const dataRange = maxVal - minVal || 0.05;
  const vPad     = dataRange * 0.15;
  minVal         = Math.max(0, minVal - vPad);
  maxVal         = maxVal + vPad;

  function niceNumber(range, round) {
    const exp = Math.floor(Math.log10(range));
    const f   = range / Math.pow(10, exp);
    let nf;
    if (round) { nf = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10; }
    else        { nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10; }
    return nf * Math.pow(10, exp);
  }

  const niceTickStep = niceNumber((maxVal - minVal) / 4, true);
  const niceMinTick  = Math.floor(minVal / niceTickStep) * niceTickStep;
  const tickValues   = [];
  for (
    let v = niceMinTick;
    v <= maxVal + niceTickStep * 0.01;
    v = Math.round((v + niceTickStep) * 1e6) / 1e6
  ) {
    if (v >= minVal - 1e-9) tickValues.push(v);
    if (tickValues.length >= 8) break;
  }

  const W     = 960;
  const H     = 420;
  const pad   = { left: 68, right: 80, top: 72, bottom: 56 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top  - pad.bottom;

  const yFor = v => pad.top + (1 - (v - minVal) / (maxVal - minVal)) * plotH;
  const xFor = i => candles.length === 1
    ? pad.left + plotW / 2
    : pad.left + (i / (candles.length - 1)) * plotW;

  const spacing = candles.length > 1 ? plotW / (candles.length - 1) : plotW;
  const bodyW   = Math.max(3, Math.min(14, spacing * 0.5));
  const halfW   = bodyW / 2;

  // Grid lines
  const gridLines = [];
  for (const val of tickValues) {
    const y = yFor(val);
    if (y < pad.top - 2 || y > pad.top + plotH + 2) continue;
    gridLines.push(
      `<line x1="${pad.left}" y1="${y.toFixed(1)}" x2="${pad.left + plotW}" y2="${y.toFixed(1)}" stroke="#2a2d35" stroke-width="1"/>`,
      `<text x="${(pad.left - 8).toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-family="'Segoe UI',Arial,sans-serif" font-size="12" fill="#6b7280">${val.toFixed(2)}</text>`
    );
  }

  // X-axis labels
  const xLabels        = [];
  let   lastDay        = null;
  const dayBoundaries  = [];
  for (let i = 0; i < candles.length; i++) {
    const dayKey = candles[i].ts.toISOString().slice(0, 10);
    if (dayKey !== lastDay) { dayBoundaries.push({ i, ts: candles[i].ts }); lastDay = dayKey; }
  }
  const MONTHS      = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  let   lastLabelX  = -999;
  for (const { i, ts } of dayBoundaries) {
    const x = xFor(i);
    if (x - lastLabelX < 60 && lastLabelX !== -999) continue;
    const label = `${ts.getUTCDate()} ${MONTHS[ts.getUTCMonth()]}`;
    xLabels.push(
      `<line x1="${x.toFixed(1)}" y1="${(pad.top + plotH).toFixed(1)}" x2="${x.toFixed(1)}" y2="${(pad.top + plotH + 6).toFixed(1)}" stroke="#374151" stroke-width="1"/>`,
      `<text x="${x.toFixed(1)}" y="${(H - pad.bottom + 22).toFixed(1)}" text-anchor="middle" font-family="'Segoe UI',Arial,sans-serif" font-size="12" fill="#9ca3af">${svgEscape(label)}</text>`
    );
    lastLabelX = x;
  }

  // Candlestick elements
  const gradDefs    = [];
  const candleElems = [];
  for (let i = 0; i < candles.length; i++) {
    const c          = candles[i];
    const x          = xFor(i);
    const openY      = yFor(c.open);
    const closeY     = yFor(c.close);
    const highY      = yFor(c.high);
    const lowY       = yFor(c.low);
    const bodyTop    = Math.min(openY, closeY);
    const bodyBottom = Math.max(openY, closeY);
    const bodyH      = Math.max(2, bodyBottom - bodyTop);

    candleElems.push(
      `<line x1="${x.toFixed(1)}" y1="${highY.toFixed(1)}" x2="${x.toFixed(1)}" y2="${lowY.toFixed(1)}" stroke="${c.color}" stroke-width="1.2" stroke-linecap="round"/>`
    );
    const gid = `g${i}`;
    gradDefs.push(
      `<linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">` +
        `<stop offset="0%" stop-color="${c.colorLight}" stop-opacity="1"/>` +
        `<stop offset="100%" stop-color="${c.color}" stop-opacity="1"/>` +
      `</linearGradient>`
    );
    candleElems.push(
      `<rect x="${(x - halfW).toFixed(1)}" y="${bodyTop.toFixed(1)}" width="${bodyW.toFixed(1)}" height="${bodyH.toFixed(1)}" rx="1.5" fill="url(#${gid})" stroke="${c.color}" stroke-width="0.5"/>`
    );
  }

  // Latest price tag
  const last      = candles[candles.length - 1];
  const lastY     = yFor(last.close);
  const tagColor  = last.dinarStrengthened ? GREEN : RED;
  const TAG_W = 62, TAG_H = 22, TAG_X = pad.left + plotW + 4;
  const priceTag  = [
    `<line x1="${pad.left}" y1="${lastY.toFixed(1)}" x2="${(TAG_X - 2).toFixed(1)}" y2="${lastY.toFixed(1)}" stroke="${tagColor}" stroke-width="1" stroke-dasharray="3,3" opacity="0.55"/>`,
    `<rect x="${TAG_X}" y="${(lastY - TAG_H / 2).toFixed(1)}" width="${TAG_W}" height="${TAG_H}" rx="4" fill="${tagColor}"/>`,
    `<text x="${(TAG_X + TAG_W / 2).toFixed(1)}" y="${(lastY + 5).toFixed(1)}" text-anchor="middle" font-family="'Segoe UI',Arial,sans-serif" font-size="12" font-weight="700" fill="#ffffff">${last.close.toFixed(2)}</text>`,
  ];

  // Header
  const SYM   = { USD: '$', EUR: '€', GBP: '£' };
  const NAMES = { USD: 'US Dollar', EUR: 'Euro', GBP: 'British Pound' };
  const sym   = SYM[mainCurrency] || '';
  const cName = NAMES[mainCurrency] || mainCurrency;

  const periodDelta = candles.length > 1 ? last.close - candles[0].close : 0;
  const deltaTxt    = (periodDelta > 0 ? '+' : '') + periodDelta.toFixed(3);
  const deltaColor  = periodDelta < 0 ? GREEN : (periodDelta > 0 ? RED : NEUTRAL);
  const deltaArrow  = periodDelta < 0 ? '▼' : (periodDelta > 0 ? '▲' : '');

  const first     = candles[0].ts;
  const dateRange = candles.length > 1
    ? `${first.getUTCDate()} ${MONTHS[first.getUTCMonth()]} – ${last.ts.getUTCDate()} ${MONTHS[last.ts.getUTCMonth()]} ${last.ts.getUTCFullYear()}`
    : `${last.ts.getUTCDate()} ${MONTHS[last.ts.getUTCMonth()]} ${last.ts.getUTCFullYear()}`;

  // Legend
  const legY  = H - 14;
  const legCX = W / 2;
  const legend = [
    `<rect x="${legCX - 170}" y="${legY - 10}" width="12" height="12" rx="2" fill="${GREEN}"/>`,
    `<text x="${legCX - 154}" y="${legY}" font-family="'Segoe UI',Arial,sans-serif" font-size="11" fill="${GREEN}">Green = Dinar Strengthens (Rate Falls)</text>`,
    `<rect x="${legCX + 60}" y="${legY - 10}" width="12" height="12" rx="2" fill="${RED}"/>`,
    `<text x="${legCX + 76}" y="${legY}" font-family="'Segoe UI',Arial,sans-serif" font-size="11" fill="${RED}">Red = Dinar Weakens (Rate Rises)</text>`,
  ].join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    ${gradDefs.join('\n    ')}
    <clipPath id="plotClip">
      <rect x="${pad.left}" y="${pad.top}" width="${plotW}" height="${plotH}"/>
    </clipPath>
  </defs>
  <rect width="${W}" height="${H}" fill="#1a1c22" rx="10"/>
  <rect x="${pad.left}" y="${pad.top}" width="${plotW}" height="${plotH}" fill="#14151a" rx="3"/>
  ${gridLines.join('\n  ')}
  <line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${pad.top + plotH}" stroke="#374151" stroke-width="1"/>
  <line x1="${pad.left}" y1="${pad.top + plotH}" x2="${pad.left + plotW}" y2="${pad.top + plotH}" stroke="#374151" stroke-width="1"/>
  <g clip-path="url(#plotClip)">
    ${candleElems.join('\n    ')}
  </g>
  ${priceTag.join('\n  ')}
  ${xLabels.join('\n  ')}
  <text x="${pad.left}" y="26" font-family="'Segoe UI',Arial,sans-serif" font-size="15" font-weight="700" fill="#f9fafb">${svgEscape(cName)} / LYD</text>
  <text x="${pad.left}" y="46" font-family="'Segoe UI',Arial,sans-serif" font-size="11" fill="#6b7280">${svgEscape(dateRange)}</text>
  <text x="${pad.left + plotW}" y="26" text-anchor="end" font-family="'Segoe UI',Arial,sans-serif" font-size="20" font-weight="700" fill="#f9fafb">${sym}${last.close.toFixed(2)} LYD</text>
  <text x="${pad.left + plotW}" y="46" text-anchor="end" font-family="'Segoe UI',Arial,sans-serif" font-size="12" font-weight="600" fill="${deltaColor}">${deltaArrow} ${svgEscape(deltaTxt)}</text>
  ${legend}
</svg>`;
}

async function svgToPngBuffer(svgString) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setContent(
      `<html><body style="margin:0;display:flex;justify-content:center;align-items:center;background:#1a1c22;">${svgString}</body></html>`
    );
    await page.waitForSelector('svg');
    const element = await page.$('svg');
    return await element.screenshot({ type: 'png' });
  } finally {
    await browser.close();
  }
}

async function chartAttachment(exchangeData, currency = 'USD') {
  const svg       = buildChartSvg(exchangeData.history || [], currency);
  const pngBuffer = await svgToPngBuffer(svg);
  return new AttachmentBuilder(pngBuffer, { name: `libya-exchange-chart-${currency}.png` });
}

// ---------------------------------------------------------------------------
// Post to Discord channel
// ---------------------------------------------------------------------------
async function postUpdate(client, guildId, exchangeData, latest, forced = false) {
  if (!exchangeData.channelId) return false;
  const channel = await client.channels.fetch(exchangeData.channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return false;

  const embed = buildRateEmbed(exchangeData, latest, forced);
  const files = [];
  let row     = null;

  if ((exchangeData.history || []).length >= 2) {
    const chartFile = await chartAttachment(exchangeData, 'USD');
    files.push(chartFile);
    embed.setImage('attachment://libya-exchange-chart-USD.png');
    row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`chart_usd_${guildId}`).setLabel('$ USD').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`chart_eur_${guildId}`).setLabel('€ EUR').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`chart_gbp_${guildId}`).setLabel('£ GBP').setStyle(ButtonStyle.Primary),
    );
  }

  await channel.send({ embeds: [embed], files, components: row ? [row] : [] });
  return true;
}

// ---------------------------------------------------------------------------
// Core update logic
// ---------------------------------------------------------------------------
async function updateRates({ client, db, saveData, guildId, forcePost = false }) {
  const exchangeData        = getExchangeData(db, guildId);
  exchangeData.lastCheckedAt = new Date().toISOString();

  let latest;
  try {
    latest = await scrapeRates();
  } catch (err) {
    console.error(`[Exchange] Scrape failed: ${err.message}`);
    throw err;
  }

  const key     = rateKey(latest.rates);
  const changed = key !== exchangeData.lastPostedKey;

  exchangeData.lastRates = latest;
  exchangeData.history   = exchangeData.history || [];

  if (forcePost || changed) {
    // One entry per hour: replace today's existing entry if rates are
    // the same hour, otherwise append.
    const thisHour = new Date(latest.scrapedAt).toISOString().slice(0, 13); // "YYYY-MM-DDTHH"
    const existingIdx = exchangeData.history
      .findIndex(e => new Date(e.scrapedAt).toISOString().slice(0, 13) === thisHour);
    if (existingIdx !== -1) exchangeData.history[existingIdx] = latest;
    else                    exchangeData.history.push(latest);
    exchangeData.history = exchangeData.history.slice(-MAX_HISTORY);
  }

  let posted = false;
  if (forcePost || changed) {
    posted = await postUpdate(client, guildId, exchangeData, latest, forcePost);
    if (posted) exchangeData.lastPostedKey = key;
  }

  saveData(guildId);
  return { latest, posted, changed };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function isAdmin(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
}

async function safeReply(interaction, payload) {
  try {
    if (interaction.replied)  return interaction.followUp(payload);
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

  function scheduleGuild(guildId) {
    if (timers.has(guildId)) clearInterval(timers.get(guildId));
    const timer = setInterval(() => {
      updateRates({ client, db, saveData, guildId })
        .catch(err => console.error(`[Exchange] Scheduled update failed: ${err.message}`));
    }, SCRAPE_INTERVAL_MS);
    timers.set(guildId, timer);
  }

  client.once('clientReady', async () => {
    setTimeout(() => {
      for (const guild of client.guilds.cache.values()) {
        const exchangeData = getExchangeData(db, guild.id);
        if (exchangeData.channelId) {
          console.log(`[Exchange] Updates enabled for guild ${guild.id}, channel ${exchangeData.channelId}`);
          scheduleGuild(guild.id);
        }
      }
    }, 6000);
  });

  client.on('interactionCreate', async interaction => {
    // --- Chart button handler ---
    if (interaction.isButton()) {
      const { customId } = interaction;
      if (
        customId.startsWith('chart_usd_') ||
        customId.startsWith('chart_eur_') ||
        customId.startsWith('chart_gbp_')
      ) {
        await interaction.deferUpdate();
        let currency = 'USD';
        if (customId.startsWith('chart_eur_')) currency = 'EUR';
        if (customId.startsWith('chart_gbp_')) currency = 'GBP';

        const guildId    = customId.split('_').pop();
        const exchangeData = getExchangeData(db, guildId);

        if (!exchangeData.history || exchangeData.history.length < 2) {
          await interaction.followUp({ content: 'Not enough history to update chart.', ephemeral: true });
          return;
        }

        const newChart     = await chartAttachment(exchangeData, currency);
        const message      = interaction.message;
        if (!message) {
          await interaction.followUp({ content: 'Could not find original message.', ephemeral: true });
          return;
        }
        const updatedEmbed = EmbedBuilder.from(message.embeds[0])
          .setImage(`attachment://libya-exchange-chart-${currency}.png`);
        await message.edit({ embeds: [updatedEmbed], files: [newChart], components: message.components });
        return;
      }
    }

    // --- Slash commands ---
    if (!interaction.isChatInputCommand()) return;
    if (!interaction.guild) return;
    const { commandName, guild } = interaction;
    if (!commandName.startsWith('exchange-')) return;

    const exchangeData = getExchangeData(db, guild.id);

    try {
      // ── /exchange-set-channel ──────────────────────────────────────────────
      if (commandName === 'exchange-set-channel') {
        if (!isAdmin(interaction))
          return safeReply(interaction, { content: 'Only admins can set the exchange update channel.', flags: 64 });
        const channel = interaction.options.getChannel('channel');
        if (!channel || !channel.isTextBased())
          return safeReply(interaction, { content: 'Please choose a text channel.', flags: 64 });
        exchangeData.channelId = channel.id;
        saveData(guild.id);
        scheduleGuild(guild.id);
        await safeReply(interaction, {
          content: `Exchange updates will post in ${channel} every hour. Fetching the latest rate now...`,
          flags: 64,
        });
        await updateRates({ client, db, saveData, guildId: guild.id, forcePost: true });
        return;
      }

      // ── /exchange-rate ─────────────────────────────────────────────────────
      if (commandName === 'exchange-rate') {
        const latest = exchangeData.lastRates;
        if (!latest)
          return safeReply(interaction, { content: 'No exchange rate has been saved yet.', flags: 64 });
        return safeReply(interaction, { embeds: [buildRateEmbed(exchangeData, latest, true)], flags: 64 });
      }

      // ── /exchange-refresh ──────────────────────────────────────────────────
      if (commandName === 'exchange-refresh') {
        if (!isAdmin(interaction))
          return safeReply(interaction, { content: 'Only admins can refresh.', flags: 64 });
        await interaction.deferReply({ flags: 64 });
        const result = await updateRates({ client, db, saveData, guildId: guild.id });
        let statusText;
        if (result.posted) {
          statusText = 'New rates detected and posted to the configured channel.';
        } else if (!exchangeData.channelId) {
          statusText = 'Rates saved, but no exchange channel is configured yet. Use `/exchange-set-channel` first.';
        } else {
          statusText = 'Rates are unchanged since last post — nothing new to send.';
        }
        return safeReply(interaction, { content: `Exchange rates refreshed. ${statusText}` });
      }

      // ── /exchange-debug ────────────────────────────────────────────────────
      if (commandName === 'exchange-debug') {
        if (!isAdmin(interaction))
          return safeReply(interaction, { content: 'Admin only.', flags: 64 });
        const lastFew = exchangeData.history.slice(-5);
        if (!lastFew.length)
          return safeReply(interaction, { content: 'No data yet.', flags: 64 });
        let msg = '**Last 5 exchange rate entries (oldest → newest):**\n';
        lastFew.forEach((entry, i) => {
          const d = new Date(entry.scrapedAt);
          msg += `\n${i + 1}. ${d.toLocaleString('en-GB')}: USD=${entry.rates.USD ?? 'N/A'}, EUR=${entry.rates.EUR ?? 'N/A'}, GBP=${entry.rates.GBP ?? 'N/A'}`;
        });
        return safeReply(interaction, { content: msg, flags: 64 });
      }

    } catch (err) {
      console.error(`[Exchange] Command failed (${commandName}):`, err);
      return safeReply(interaction, { content: `❌ Exchange error: ${err.message?.slice(0, 200)}`, flags: 64 });
    }
  });
};

module.exports.commands         = exchangeCommands;
module.exports.parseRatesFromHtml = async function (html) {
  const cheerio = require('cheerio');
  const $       = cheerio.load(html);
  const rates   = { USD: null, EUR: null, GBP: null };
  $('table tr').each((_, row) => {
    const cells    = $(row).find('td');
    if (cells.length < 2) return;
    const nameTxt  = $(cells[0]).text().replace(/\s+/g, ' ').trim().toLowerCase();
    const price    = parseFloat($(cells[1]).text().trim());
    if (isNaN(price) || price <= 0 || price >= 200) return;
    if (nameTxt.includes('us dollar') || (nameTxt.includes('dollar') && !nameTxt.includes('canadian') && !nameTxt.includes('aus')))
      rates.USD = Math.round(price * 1000) / 1000;
    else if (nameTxt.includes('euro'))
      rates.EUR = Math.round(price * 1000) / 1000;
    else if (nameTxt.includes('british pound') || (nameTxt.includes('pound') && !nameTxt.includes('egyptian')))
      rates.GBP = Math.round(price * 1000) / 1000;
  });
  return rates;
};
