// =============================================================================
// LIBYAN BLACK MARKET EXCHANGE RATE
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

const SOURCE_URL = 'https://www.facebook.com/p/Dollar-Euro-Pound-Libya-Black-Market-Exchange-Rate-100064752788893/';
const SCRAPE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const MAX_HISTORY = 120;
const CHART_POINTS = 30;
const CURRENCIES = ['USD', 'EUR', 'GBP'];

const exchangeCommands = [
  new SlashCommandBuilder()
    .setName('exchange-set-channel')
    .setDescription('Set the channel for hourly Libyan black market exchange updates')
    .addChannelOption(o => o.setName('channel').setDescription('Channel to post exchange updates in').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName('exchange-rate')
    .setDescription('Show the latest saved Libyan black market exchange rate')
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName('exchange-refresh')
    .setDescription('Admin: scrape Facebook now and post the latest exchange rate')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),
  
  new SlashCommandBuilder()
    .setName('exchange-debug')
    .setDescription('Admin: show last 5 exchange rate entries (for debugging)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),
].map(c => c.toJSON());

// ----------------------------------------------------------------------
// Data & helper functions (unchanged)
// ----------------------------------------------------------------------
function getExchangeData(db, guildId) {
  if (!db[guildId]) db[guildId] = {};
  if (!db[guildId].__exchange) {
    db[guildId].__exchange = {
      channelId: null,
      lastRates: null,
      lastPostedKey: null,
      lastCheckedAt: null,
      history: [],
    };
  }
  return db[guildId].__exchange;
}

function num(value) {
  if (value === null || value === undefined) return null;
  const n = Number(String(value).replace(',', '.').replace(/[^\d.]/g, ''));
  if (!Number.isFinite(n)) return null;
  if (n < 1 || n > 30) return null;
  return Math.round(n * 1000) / 1000;
}

function findRateNearKeyword(text, keywords) {
  const lines = text.split(/\n+/).map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const lineLower = lines[i].toLowerCase();
    if (!keywords.some(k => lineLower.includes(k))) continue;
    const window = [lines[i], lines[i + 1] || '', lines[i - 1] || ''].join(' ');
    const matches = window.match(/\b\d{1,2}(?:[.,]\d{1,4})?\b/g) || [];
    const rates = matches.map(num).filter(v => v !== null);
    if (rates.length) return rates[0];
  }
  return null;
}

function parseRatesFromText(text) {
  const rates = { USD: null, EUR: null, GBP: null };
  
  console.log('[Exchange] Page text sample (first 500 chars):\n', text.slice(0, 500));
  
  // Check for holiday or no‑update message
  if (text.includes('no black market exchange rate updates') || text.includes('holiday')) {
    console.log('[Exchange] Holiday or no update detected – skipping');
    return null;
  }
  
  const directPatterns = [
    { currency: 'USD', regex: /\$1\s*=\s*(\d{1,2}(?:[.,]\d{1,2})?)\s*LYD/i },
    { currency: 'EUR', regex: /€1\s*=\s*(\d{1,2}(?:[.,]\d{1,2})?)\s*LYD/i },
    { currency: 'GBP', regex: /£1\s*=\s*(\d{1,2}(?:[.,]\d{1,2})?)\s*LYD/i },
  ];
  for (const p of directPatterns) {
    const match = text.match(p.regex);
    if (match) rates[p.currency] = num(match[1]);
  }
  
  const nearSymbol = [
    { currency: 'USD', regex: /\$\s*(\d{1,2}(?:[.,]\d{1,2})?)/i },
    { currency: 'EUR', regex: /€\s*(\d{1,2}(?:[.,]\d{1,2})?)/i },
    { currency: 'GBP', regex: /£\s*(\d{1,2}(?:[.,]\d{1,2})?)/i },
  ];
  for (const p of nearSymbol) {
    if (rates[p.currency] === null) {
      const match = text.match(p.regex);
      if (match) rates[p.currency] = num(match[1]);
    }
  }
  
  if (rates.USD === null) rates.USD = findRateNearKeyword(text, ['dollar', 'usd', '$']);
  if (rates.EUR === null) rates.EUR = findRateNearKeyword(text, ['euro', 'eur', '€']);
  if (rates.GBP === null) rates.GBP = findRateNearKeyword(text, ['pound', 'gbp', 'sterling', '£']);
  
  if (CURRENCIES.every(c => rates[c] === null)) {
    console.error('❌ All parsing methods failed. Full text sample (first 1000 chars):\n', text.slice(0, 1000));
    return null;
  }
  
  console.log(`✅ Parsed rates: USD=${rates.USD}, EUR=${rates.EUR}, GBP=${rates.GBP}`);
  return rates;
}

async function scrapeFacebookRates() {
  const { chromium } = require('playwright');
  let browser, context, page;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
    });
    context = await browser.newContext({ viewport: { width: 1365, height: 900 }, locale: 'en-GB' });
    page = await context.newPage();
    await page.goto(SOURCE_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(5000);
    const currentUrl = page.url();
    if (currentUrl.includes('login') || currentUrl.includes('checkpoint')) {
      console.log('[Exchange] Login required. Attempting to log in...');
      await page.waitForSelector('input[type="email"], input[name="email"], #email', { timeout: 10000 });
      const emailInput = await page.$('input[type="email"], input[name="email"], #email');
      if (emailInput) await emailInput.fill(process.env.FACEBOOK_EMAIL);
      const passInput = await page.$('input[type="password"], input[name="pass"], #pass');
      if (passInput) await passInput.fill(process.env.FACEBOOK_PASSWORD);
      const loginButton = await page.$('button[type="submit"], button[name="login"], #loginbutton, div[aria-label="Log in"]');
      if (loginButton) await loginButton.click();
      else await page.keyboard.press('Enter');
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(3000);
      const saveInfoBtn = await page.$('button[value="1"], button[data-testid="save-login-button"]');
      if (saveInfoBtn) await saveInfoBtn.click();
      await page.waitForTimeout(2000);
      console.log('[Exchange] Login successful.');
    }
    for (let i = 0; i < 4; i++) {
      await page.mouse.wheel(0, 900);
      await page.waitForTimeout(1000);
    }
    const text = await page.locator('body').innerText({ timeout: 15000 });
    const rates = parseRatesFromText(text);
    if (!rates) {
      if (text.includes('no black market exchange rate updates') || text.includes('holiday')) {
        throw new Error('No rates posted today (holiday or break). Skipping update.');
      }
      throw new Error('Could not find USD/EUR/GBP rates.');
    }
    return { rates, scrapedAt: new Date().toISOString(), sourceUrl: SOURCE_URL, sample: text.slice(0, 1200) };
  } catch (error) {
    console.error('[Exchange] Scrape failed:', error.message);
    throw error;
  } finally {
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

function rateKey(rates) {
  return CURRENCIES.map(c => `${c}:${rates[c] ?? 'na'}`).join('|');
}

function trend(history, currency, latestValue) {
  const previous = [...history].reverse().find(entry => entry.rates && entry.rates[currency] != null);
  if (!previous || latestValue == null) return { label: 'No previous data', delta: null };
  const delta = Math.round((latestValue - previous.rates[currency]) * 1000) / 1000;
  if (delta > 0) return { label: `🔴 ↑ +${delta.toFixed(3)}`, delta };
  if (delta < 0) return { label: `🟢 ↓ ${delta.toFixed(3)}`, delta };
  return { label: '⚪ No change', delta: 0 };
}

function buildRateEmbed(exchangeData, latest, forced = false) {
  const history = exchangeData.history || [];
  const embed = new EmbedBuilder()
    .setColor(0x1B8F5A)
    .setTitle('Libyan Black Market Exchange Rate')
    .setDescription(forced ? 'Manual refresh from the configured source.' : 'Latest hourly update from the configured source.')
    .setTimestamp(new Date(latest.scrapedAt || Date.now()))
    .setFooter({ text: 'Live Libyan black market rates • Updated hourly' });
  for (const currency of CURRENCIES) {
    const value = latest.rates[currency];
    const t = trend(history.slice(0, -1), currency, value);
    embed.addFields({ name: currency, value: value == null ? 'Not found' : `**${value.toFixed(2)} LYD**\n${t.label}`, inline: true });
  }
  return embed;
}

function svgEscape(value) {
  return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function buildChartSvg(history, mainCurrency = 'USD') {
  // ── 1. Aggregate: one data point per day (last entry of each day wins) ────
  const dailyMap = new Map();
  (history || [])
    .filter(entry => entry.rates && typeof entry.rates[mainCurrency] === 'number')
    .forEach(entry => {
      const key = entry.scrapedAt.slice(0, 10); // YYYY-MM-DD
      if (!dailyMap.has(key) || new Date(entry.scrapedAt) > new Date(dailyMap.get(key).scrapedAt)) {
        dailyMap.set(key, entry);
      }
    });

  const rows = Array.from(dailyMap.values())
    .sort((a, b) => new Date(a.scrapedAt) - new Date(b.scrapedAt))
    .slice(-30); // last 30 days

  if (rows.length === 0) return `<svg width="960" height="400" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#1a1c22"/></svg>`;

  // ── 2. Build candles ─────────────────────────────────────────────────────
  // LIBYAN COLOR LOGIC (intentional, matches reference image):
  //   GREEN = close < open  → rate fell → Dinar STRENGTHENED
  //   RED   = close > open  → rate rose → Dinar WEAKENED
  const GREEN       = '#22c55e';  // vibrant green  (dinar strengthens)
  const GREEN_LIGHT = '#4ade80';
  const RED         = '#ef4444';  // clear red      (dinar weakens)
  const RED_LIGHT   = '#f87171';
  const NEUTRAL     = '#94a3b8';

  const candles = [];
  for (let i = 0; i < rows.length; i++) {
    const close = rows[i].rates[mainCurrency];
    const open  = i === 0 ? close : rows[i - 1].rates[mainCurrency];
    const high  = Math.max(open, close);
    const low   = Math.min(open, close);
    const ts    = new Date(rows[i].scrapedAt);
    // Dinar-centric: green when rate drops (dinar stronger)
    const dinarStrengthened = close < open;
    const dinarWeakened     = close > open;
    const color      = dinarStrengthened ? GREEN  : (dinarWeakened ? RED  : NEUTRAL);
    const colorLight = dinarStrengthened ? GREEN_LIGHT : (dinarWeakened ? RED_LIGHT : NEUTRAL);
    candles.push({ ts, open, high, low, close, color, colorLight, dinarStrengthened });
  }

  // ── 3. Y-axis: tight range around actual data ────────────────────────────
  const allVals = candles.flatMap(c => [c.high, c.low]);
  let minVal = Math.min(...allVals);
  let maxVal = Math.max(...allVals);
  const dataRange = maxVal - minVal || 0.05;
  // Only add a small padding (15%) — keeps the chart tight like the reference
  const vPad = dataRange * 0.15;
  minVal = Math.max(0, minVal - vPad);
  maxVal = maxVal + vPad;

  // Nice round tick values
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
  for (let v = niceMinTick; v <= maxVal + niceTickStep * 0.01; v = Math.round((v + niceTickStep) * 1e6) / 1e6) {
    if (v >= minVal - 1e-9) tickValues.push(v);
    if (tickValues.length >= 8) break;
  }

  // ── 4. Layout ────────────────────────────────────────────────────────────
  const W    = 960;
  const H    = 420;
  const pad  = { left: 68, right: 80, top: 72, bottom: 56 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top  - pad.bottom;

  const yFor = v  => pad.top + (1 - (v - minVal) / (maxVal - minVal)) * plotH;
  const xFor = i  => candles.length === 1
    ? pad.left + plotW / 2
    : pad.left + (i / (candles.length - 1)) * plotW;

  // Candle width: narrower for more candles (like reference), capped nicely
  const spacing   = candles.length > 1 ? plotW / (candles.length - 1) : plotW;
  const bodyW     = Math.max(3, Math.min(14, spacing * 0.5));
  const halfW     = bodyW / 2;

  // ── 5. Grid lines ────────────────────────────────────────────────────────
  const gridLines = [];
  for (const val of tickValues) {
    const y = yFor(val);
    if (y < pad.top - 2 || y > pad.top + plotH + 2) continue;
    gridLines.push(
      `<line x1="${pad.left}" y1="${y.toFixed(1)}" x2="${pad.left + plotW}" y2="${y.toFixed(1)}" stroke="#2a2d35" stroke-width="1"/>`,
      `<text x="${(pad.left - 8).toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-family="'Segoe UI',Arial,sans-serif" font-size="12" fill="#6b7280">${val.toFixed(2)}</text>`
    );
  }

  // ── 6. X-axis date labels — show "DD Mon" at day boundaries ─────────────
  const xLabels   = [];
  let   lastDay   = null;
  // Collect unique day-boundary positions
  const dayBoundaries = [];
  for (let i = 0; i < candles.length; i++) {
    const dayKey = candles[i].ts.toISOString().slice(0, 10);
    if (dayKey !== lastDay) {
      dayBoundaries.push({ i, ts: candles[i].ts });
      lastDay = dayKey;
    }
  }
  // Space them out: skip if too close
  const minLabelSpacing = 60;
  let lastLabelX = -999;
  for (const { i, ts } of dayBoundaries) {
    const x = xFor(i);
    if (x - lastLabelX < minLabelSpacing && lastLabelX !== -999) continue;
    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const label  = `${ts.getUTCDate()} ${MONTHS[ts.getUTCMonth()]}`;
    xLabels.push(
      `<line x1="${x.toFixed(1)}" y1="${(pad.top + plotH).toFixed(1)}" x2="${x.toFixed(1)}" y2="${(pad.top + plotH + 6).toFixed(1)}" stroke="#374151" stroke-width="1"/>`,
      `<text x="${x.toFixed(1)}" y="${(H - pad.bottom + 22).toFixed(1)}" text-anchor="middle" font-family="'Segoe UI',Arial,sans-serif" font-size="12" fill="#9ca3af">${svgEscape(label)}</text>`
    );
    lastLabelX = x;
  }

  // ── 7. Candlestick SVG elements ──────────────────────────────────────────
  // All gradients are defined up front in <defs> to keep the SVG clean
  const gradDefs   = [];
  const candleElems = [];

  for (let i = 0; i < candles.length; i++) {
    const c      = candles[i];
    const x      = xFor(i);
    const openY  = yFor(c.open);
    const closeY = yFor(c.close);
    const highY  = yFor(c.high);
    const lowY   = yFor(c.low);
    const bodyTop    = Math.min(openY, closeY);
    const bodyBottom = Math.max(openY, closeY);
    const bodyH      = Math.max(2, bodyBottom - bodyTop);

    // Wick (same color as body, thin)
    candleElems.push(
      `<line x1="${x.toFixed(1)}" y1="${highY.toFixed(1)}" x2="${x.toFixed(1)}" y2="${lowY.toFixed(1)}" stroke="${c.color}" stroke-width="1.2" stroke-linecap="round"/>`
    );

    // Gradient for body
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

  // ── 8. Latest price tag — pinned to right edge like the reference ────────
  const last     = candles[candles.length - 1];
  const lastY    = yFor(last.close);
  const tagColor = last.dinarStrengthened ? GREEN : RED;
  // Dashed horizontal line across the whole plot
  const priceLineX2 = pad.left + plotW + pad.right - 2; // extends into right margin
  const TAG_W = 62, TAG_H = 22, TAG_X = pad.left + plotW + 4;
  const priceLine = `<line x1="${pad.left}" y1="${lastY.toFixed(1)}" x2="${(TAG_X - 2).toFixed(1)}" y2="${lastY.toFixed(1)}" stroke="${tagColor}" stroke-width="1" stroke-dasharray="3,3" opacity="0.55"/>`;
  const priceTag  = [
    priceLine,
    `<rect x="${TAG_X}" y="${(lastY - TAG_H/2).toFixed(1)}" width="${TAG_W}" height="${TAG_H}" rx="4" fill="${tagColor}"/>`,
    `<text x="${(TAG_X + TAG_W/2).toFixed(1)}" y="${(lastY + 5).toFixed(1)}" text-anchor="middle" font-family="'Segoe UI',Arial,sans-serif" font-size="12" font-weight="700" fill="#ffffff">${last.close.toFixed(2)}</text>`,
  ];

  // ── 9. Header block ──────────────────────────────────────────────────────
  const SYM   = { USD: '$', EUR: '€', GBP: '£' };
  const NAMES = { USD: 'US Dollar', EUR: 'Euro', GBP: 'British Pound' };
  const sym   = SYM[mainCurrency]   || '';
  const cName = NAMES[mainCurrency] || mainCurrency;

  // Period delta: first candle vs last
  const periodDelta    = candles.length > 1 ? last.close - candles[0].close : 0;
  const deltaTxt       = (periodDelta > 0 ? '+' : '') + periodDelta.toFixed(3);
  // For delta color: rate went down = dinar stronger = green; rate went up = red
  const deltaColor     = periodDelta < 0 ? GREEN : (periodDelta > 0 ? RED : NEUTRAL);
  const deltaArrow     = periodDelta < 0 ? '▼' : (periodDelta > 0 ? '▲' : '');

  // Date range label
  const first = candles[0].ts;
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const dateRange = candles.length > 1
    ? `${first.getUTCDate()} ${MONTHS[first.getUTCMonth()]} – ${last.ts.getUTCDate()} ${MONTHS[last.ts.getUTCMonth()]} ${last.ts.getUTCFullYear()}`
    : `${last.ts.getUTCDate()} ${MONTHS[last.ts.getUTCMonth()]} ${last.ts.getUTCFullYear()}`;

  // ── 10. Bottom legend ─────────────────────────────────────────────────────
  const legY  = H - 14;
  const legCX = W / 2;
  const legend = [
    `<rect x="${legCX - 170}" y="${legY - 10}" width="12" height="12" rx="2" fill="${GREEN}"/>`,
    `<text x="${legCX - 154}" y="${legY}" font-family="'Segoe UI',Arial,sans-serif" font-size="11" fill="${GREEN}">Green = Dinar Strengthens (Rate Falls)</text>`,
    `<rect x="${legCX + 60}" y="${legY - 10}" width="12" height="12" rx="2" fill="${RED}"/>`,
    `<text x="${legCX + 76}" y="${legY}" font-family="'Segoe UI',Arial,sans-serif" font-size="11" fill="${RED}">Red = Dinar Weakens (Rate Rises)</text>`,
  ].join('\n');

  // ── 11. Assemble SVG ──────────────────────────────────────────────────────
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    ${gradDefs.join('\n    ')}
    <clipPath id="plotClip">
      <rect x="${pad.left}" y="${pad.top}" width="${plotW}" height="${plotH}"/>
    </clipPath>
  </defs>

  <!-- Background -->
  <rect width="${W}" height="${H}" fill="#1a1c22" rx="10"/>
  <!-- Plot area background -->
  <rect x="${pad.left}" y="${pad.top}" width="${plotW}" height="${plotH}" fill="#14151a" rx="3"/>

  <!-- Grid -->
  ${gridLines.join('\n  ')}

  <!-- Axis lines -->
  <line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${pad.top + plotH}" stroke="#374151" stroke-width="1"/>
  <line x1="${pad.left}" y1="${pad.top + plotH}" x2="${pad.left + plotW}" y2="${pad.top + plotH}" stroke="#374151" stroke-width="1"/>

  <!-- Candles (clipped to plot area) -->
  <g clip-path="url(#plotClip)">
    ${candleElems.join('\n    ')}
  </g>

  <!-- Price tag (outside clip, in right margin) -->
  ${priceTag.join('\n  ')}

  <!-- X-axis labels -->
  ${xLabels.join('\n  ')}

  <!-- ── Header ── -->
  <!-- Currency name + date range -->
  <text x="${pad.left}" y="26" font-family="'Segoe UI',Arial,sans-serif" font-size="15" font-weight="700" fill="#f9fafb">${svgEscape(cName)} / LYD</text>
  <text x="${pad.left}" y="46" font-family="'Segoe UI',Arial,sans-serif" font-size="11" fill="#6b7280">${svgEscape(dateRange)}</text>

  <!-- Latest rate (large, right-aligned in header) -->
  <text x="${pad.left + plotW}" y="26" text-anchor="end" font-family="'Segoe UI',Arial,sans-serif" font-size="20" font-weight="700" fill="#f9fafb">${sym}${last.close.toFixed(2)} LYD</text>
  <!-- Period delta badge -->
  <text x="${pad.left + plotW}" y="46" text-anchor="end" font-family="'Segoe UI',Arial,sans-serif" font-size="12" font-weight="600" fill="${deltaColor}">${deltaArrow} ${svgEscape(deltaTxt)}</text>

  <!-- ── Bottom legend ── -->
  ${legend}
</svg>`;
}

async function chartAttachment(exchangeData, currency = 'USD') {
  const svg = buildChartSvg(exchangeData.history || [], currency);
  const pngBuffer = await svgToPngBuffer(svg);
  return new AttachmentBuilder(pngBuffer, { name: `libya-exchange-chart-${currency}.png` });
}

async function svgToPngBuffer(svgString) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setContent(`<html><body style="margin:0;display:flex;justify-content:center;align-items:center;background:white;">${svgString}</body></html>`);
    await page.waitForSelector('svg');
    const element = await page.$('svg');
    return await element.screenshot({ type: 'png' });
  } finally {
    await browser.close();
  }
}

async function postUpdate(client, guildId, exchangeData, latest, forced = false) {
  if (!exchangeData.channelId) return false;
  const channel = await client.channels.fetch(exchangeData.channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return false;

  const embed = buildRateEmbed(exchangeData, latest, forced);
  const files = [];
  let row = null;

  if ((exchangeData.history || []).length >= 2) {
    const chartFile = await chartAttachment(exchangeData, 'USD');
    files.push(chartFile);
    embed.setImage('attachment://libya-exchange-chart-USD.png');
    row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('chart_usd').setLabel('$ USD').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('chart_eur').setLabel('€ EUR').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('chart_gbp').setLabel('£ GBP').setStyle(ButtonStyle.Primary),
    );
  }

  const message = await channel.send({ embeds: [embed], files, components: row ? [row] : [] });

  if (row && message) {
    const filter = i => ['chart_usd', 'chart_eur', 'chart_gbp'].includes(i.customId);
    const collector = message.createMessageComponentCollector({ filter, time: 300000 });
    collector.on('collect', async i => {
      try {
        let currency = 'USD';
        if (i.customId === 'chart_eur') currency = 'EUR';
        if (i.customId === 'chart_gbp') currency = 'GBP';
        const newChart = await chartAttachment(exchangeData, currency);
        // Clone the original embed and update its image URL to match the new attachment
        const updatedEmbed = EmbedBuilder.from(embed)
          .setImage(`attachment://libya-exchange-chart-${currency}.png`);
        await i.update({
          embeds: [updatedEmbed],
          files: [newChart],
          components: [row],
        });
      } catch (err) {
        console.error('[Exchange] Button error:', err);
        await i.reply({ content: 'Failed to update chart.', ephemeral: true });
      }
    });
    collector.on('end', () => message.edit({ components: [] }).catch(() => {}));
  }
  return true;
}

async function updateRates({ client, db, saveData, guildId, forcePost = false }) {
  const exchangeData = getExchangeData(db, guildId);
  exchangeData.lastCheckedAt = new Date().toISOString();
  
  let latest;
  try {
    latest = await scrapeFacebookRates();
  } catch (err) {
    if (err.message && err.message.includes('No rates posted today')) {
      console.log('[Exchange] Skipping update:', err.message);
      return { latest: null, posted: false, changed: false };
    }
    throw err;
  }
  
  const key = rateKey(latest.rates);
  const changed = key !== exchangeData.lastPostedKey;
  exchangeData.lastRates = latest;
  exchangeData.history = exchangeData.history || [];
  if (forcePost || changed) {
    const today = new Date().toISOString().slice(0, 10);
    const existingIndex = exchangeData.history.findIndex(entry => new Date(entry.scrapedAt).toISOString().slice(0, 10) === today);
    if (existingIndex !== -1) exchangeData.history[existingIndex] = latest;
    else exchangeData.history.push(latest);
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

module.exports = function initBlackMarketExchange({ client, db, saveData }) {
  const timers = new Map();
  function scheduleGuild(guildId) {
    if (timers.has(guildId)) clearInterval(timers.get(guildId));
    const timer = setInterval(() => {
      updateRates({ client, db, saveData, guildId }).catch(err => console.error(`Exchange update failed: ${err.message}`));
    }, SCRAPE_INTERVAL_MS);
    timers.set(guildId, timer);
  }
  client.once('clientReady', async () => {
    setTimeout(() => {
      for (const guild of client.guilds.cache.values()) {
        const exchangeData = getExchangeData(db, guild.id);
        if (exchangeData.channelId) {
          console.log(`Exchange updates enabled for guild ${guild.id}, channel ${exchangeData.channelId}`);
          scheduleGuild(guild.id);
        }
      }
    }, 6000);
  });
  client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand() || !interaction.guild) return;
    const { commandName, guild } = interaction;
    if (!commandName.startsWith('exchange-')) return;
    const exchangeData = getExchangeData(db, guild.id);
    try {
      if (commandName === 'exchange-set-channel') {
        if (!isAdmin(interaction)) return safeReply(interaction, { content: 'Only admins can set the exchange update channel.', flags: 64 });
        const channel = interaction.options.getChannel('channel');
        if (!channel || !channel.isTextBased()) return safeReply(interaction, { content: 'Please choose a text channel.', flags: 64 });
        exchangeData.channelId = channel.id;
        saveData(guild.id);
        scheduleGuild(guild.id);
        await safeReply(interaction, { content: `Exchange updates will post in ${channel} every hour. Scraping the latest rate now...`, flags: 64 });
        await updateRates({ client, db, saveData, guildId: guild.id, forcePost: true });
        return;
      }
      if (commandName === 'exchange-rate') {
        const latest = exchangeData.lastRates;
        if (!latest) return safeReply(interaction, { content: 'No exchange rate has been saved yet.', flags: 64 });
        return safeReply(interaction, { embeds: [buildRateEmbed(exchangeData, latest, true)], flags: 64 });
      }
      if (commandName === 'exchange-refresh') {
        if (!isAdmin(interaction)) return safeReply(interaction, { content: 'Only admins can refresh.', flags: 64 });
        await interaction.deferReply({ flags: 64 });
        const result = await updateRates({ client, db, saveData, guildId: guild.id, forcePost: true });
        const postedText = result.posted ? 'Posted to configured channel.' : 'Saved, but no exchange channel is configured yet.';
        return safeReply(interaction, { content: `Exchange rates refreshed. ${postedText}` });
      }
      if (commandName === 'exchange-debug') {
        if (!isAdmin(interaction)) return safeReply(interaction, { content: 'Admin only.', flags: 64 });
        const lastFew = exchangeData.history.slice(-5);
        if (!lastFew.length) return safeReply(interaction, { content: 'No data yet.', flags: 64 });
        let msg = '**Last 5 exchange rates (oldest → newest):**\n';
        lastFew.forEach((entry, i) => {
          const d = new Date(entry.scrapedAt);
          msg += `\n${i+1}. ${d.toLocaleString()}: USD=${entry.rates.USD}, EUR=${entry.rates.EUR}, GBP=${entry.rates.GBP}`;
        });
        return safeReply(interaction, { content: msg, flags: 64 });
      }
    } catch (err) {
      console.error(`Exchange command failed (${commandName}):`, err);
      return safeReply(interaction, { content: `❌ Exchange error: ${err.message?.slice(0, 200)}`, flags: 64 });
    }
  });
};

module.exports.commands = exchangeCommands;
module.exports.parseRatesFromText = parseRatesFromText;
