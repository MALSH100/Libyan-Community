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
  
  // Log the raw text for debugging
  console.log('[Exchange] Page text sample (first 500 chars):\n', text.slice(0, 500));
  
  // Method 1: Direct patterns like "$1=08.32 LYD"
  const directPatterns = [
    { currency: 'USD', regex: /\$1\s*=\s*(\d{1,2}(?:[.,]\d{1,2})?)\s*LYD/i },
    { currency: 'EUR', regex: /€1\s*=\s*(\d{1,2}(?:[.,]\d{1,2})?)\s*LYD/i },
    { currency: 'GBP', regex: /£1\s*=\s*(\d{1,2}(?:[.,]\d{1,2})?)\s*LYD/i },
  ];
  for (const p of directPatterns) {
    const match = text.match(p.regex);
    if (match) rates[p.currency] = num(match[1]);
  }
  
  // Method 2: Look for any number near the currency symbol
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
  
  // Method 3: Keyword proximity
  if (rates.USD === null) rates.USD = findRateNearKeyword(text, ['dollar', 'usd', '$']);
  if (rates.EUR === null) rates.EUR = findRateNearKeyword(text, ['euro', 'eur', '€']);
  if (rates.GBP === null) rates.GBP = findRateNearKeyword(text, ['pound', 'gbp', 'sterling', '£']);
  
  // If still missing, log the failure
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
    if (!rates) throw new Error('Could not find USD/EUR/GBP rates.');
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
  // Group by date (take the last entry of each day)
  const dailyMap = new Map();
  (history || [])
    .filter(entry => entry.rates && typeof entry.rates[mainCurrency] === 'number')
    .forEach(entry => {
      const dateKey = entry.scrapedAt.slice(0, 10); // YYYY-MM-DD
      if (!dailyMap.has(dateKey) || new Date(entry.scrapedAt) > new Date(dailyMap.get(dateKey).scrapedAt)) {
        dailyMap.set(dateKey, entry);
      }
    });

  let rows = Array.from(dailyMap.values())
    .sort((a, b) => new Date(a.scrapedAt) - new Date(b.scrapedAt))
    .slice(-30); // last 30 days

  if (rows.length === 0) return `<svg width="960" height="520"></svg>`;

  // -----------------------------------------------------------------
  // Build candles
  // Each day: open = previous day's close, close = today's rate.
  // COLOR CONVENTION (standard financial chart):
  //   Green (bullish)  = close > open  → LYD rate rose  (foreign currency costs more)
  //   Red   (bearish)  = close < open  → LYD rate fell  (foreign currency costs less / dinar strengthened)
  // The subtitle clarifies this for the reader.
  // -----------------------------------------------------------------
  const candles = [];
  for (let i = 0; i < rows.length; i++) {
    const close = rows[i].rates[mainCurrency];
    const open  = i === 0 ? close : rows[i - 1].rates[mainCurrency];
    const high  = Math.max(open, close);
    const low   = Math.min(open, close);
    const date  = new Date(rows[i].scrapedAt);
    // Standard: green when price closes higher (rate went up), red when lower
    const bullish = close >= open;
    const color      = bullish ? '#26a69a' : '#ef5350'; // teal-green / red
    const colorLight = bullish ? '#4db6ac' : '#ff7043';
    candles.push({ date, open, high, low, close, color, colorLight, bullish });
  }

  // Y-axis range with comfortable padding
  const allVals = candles.flatMap(c => [c.high, c.low]);
  let minVal = Math.min(...allVals);
  let maxVal = Math.max(...allVals);
  const range = maxVal - minVal || 0.01;
  const pad0  = range * 0.12;
  minVal -= pad0;
  maxVal += pad0;
  if (minVal < 0) minVal = 0;

  // Nice Y ticks
  const tickCount = 6;
  const rawStep = (maxVal - minVal) / (tickCount - 1);
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const niceStep  = Math.ceil(rawStep / magnitude) * magnitude;
  const niceMin   = Math.floor(minVal / niceStep) * niceStep;
  const tickValues = [];
  for (let i = 0; i <= tickCount; i++) {
    const v = niceMin + i * niceStep;
    if (v >= minVal - 1e-9 && v <= maxVal + 1e-9) tickValues.push(v);
  }

  // Layout
  const width  = 960;
  const height = 520;
  const pad    = { left: 80, right: 30, top: 80, bottom: 70 };
  const plotW  = width  - pad.left - pad.right;
  const plotH  = height - pad.top  - pad.bottom;

  const yFor = (v) => pad.top + (1 - (v - minVal) / (maxVal - minVal)) * plotH;
  const xFor = (i) => {
    if (candles.length === 1) return pad.left + plotW / 2;
    return pad.left + (i / (candles.length - 1)) * plotW;
  };

  const candleBodyW = Math.max(4, Math.min(18, (plotW / candles.length) * 0.55));
  const halfW       = candleBodyW / 2;

  // ── Background panels (alternating subtle bands) ────────────────
  const bands = [];
  for (let i = 0; i < candles.length; i++) {
    if (i % 2 === 0) continue;
    const x0 = i === 0 ? pad.left : (xFor(i - 1) + xFor(i)) / 2;
    const x1 = i === candles.length - 1 ? pad.left + plotW : (xFor(i) + xFor(i + 1)) / 2;
    bands.push(`<rect x="${x0.toFixed(1)}" y="${pad.top}" width="${(x1 - x0).toFixed(1)}" height="${plotH}" fill="rgba(255,255,255,0.018)"/>`);
  }

  // ── Grid lines ───────────────────────────────────────────────────
  const gridLines = [];
  for (const val of tickValues) {
    const y = yFor(val);
    gridLines.push(
      `<line x1="${pad.left}" y1="${y.toFixed(1)}" x2="${pad.left + plotW}" y2="${y.toFixed(1)}" stroke="#3a3d45" stroke-width="1" stroke-dasharray="4,3"/>`,
      `<text x="${pad.left - 12}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-family="'Segoe UI',Arial,sans-serif" font-size="12" fill="#72767d">${val.toFixed(3)}</text>`
    );
  }

  // ── Candlestick bodies & wicks ───────────────────────────────────
  const candlesSvg = [];
  for (let i = 0; i < candles.length; i++) {
    const c      = candles[i];
    const x      = xFor(i);
    const highY  = yFor(c.high);
    const lowY   = yFor(c.low);
    const openY  = yFor(c.open);
    const closeY = yFor(c.close);
    const bodyTop    = Math.min(openY, closeY);
    const bodyBottom = Math.max(openY, closeY);
    const bodyH      = Math.max(2, bodyBottom - bodyTop);

    // Wick
    if (c.high !== c.low) {
      candlesSvg.push(`<line x1="${x.toFixed(1)}" y1="${highY.toFixed(1)}" x2="${x.toFixed(1)}" y2="${lowY.toFixed(1)}" stroke="${c.color}" stroke-width="1.5" stroke-linecap="round"/>`);
    }

    // Body with gradient fill for depth
    const gradId = `cg${i}`;
    candlesSvg.push(
      `<defs><linearGradient id="${gradId}" x1="0" y1="0" x2="1" y2="0">` +
        `<stop offset="0%" stop-color="${c.colorLight}"/>` +
        `<stop offset="100%" stop-color="${c.color}"/>` +
      `</linearGradient></defs>`,
      `<rect x="${(x - halfW).toFixed(1)}" y="${bodyTop.toFixed(1)}" width="${candleBodyW.toFixed(1)}" height="${bodyH.toFixed(1)}" rx="2" ry="2" fill="url(#${gradId})" stroke="${c.color}" stroke-width="0.8"/>`
    );
  }

  // ── Trend line (simple moving average of close prices) ───────────
  const maLine = [];
  const maWindow = Math.min(7, candles.length);
  for (let i = maWindow - 1; i < candles.length; i++) {
    const avg = candles.slice(i - maWindow + 1, i + 1).reduce((s, c) => s + c.close, 0) / maWindow;
    const px  = xFor(i);
    const py  = yFor(avg);
    maLine.push(i === maWindow - 1 ? `M${px.toFixed(1)},${py.toFixed(1)}` : `L${px.toFixed(1)},${py.toFixed(1)}`);
  }
  const trendPath = maLine.length > 1
    ? `<path d="${maLine.join(' ')}" fill="none" stroke="#f0c040" stroke-width="1.5" stroke-dasharray="5,3" opacity="0.7"/>`
    : '';

  // ── Latest price tag on right axis ──────────────────────────────
  const last   = candles[candles.length - 1];
  const lastY  = yFor(last.close);
  const tagColor = last.bullish ? '#26a69a' : '#ef5350';
  const priceTagW = 68;
  const priceTag = [
    `<line x1="${pad.left}" y1="${lastY.toFixed(1)}" x2="${pad.left + plotW}" y2="${lastY.toFixed(1)}" stroke="${tagColor}" stroke-width="1" stroke-dasharray="4,3" opacity="0.6"/>`,
    `<rect x="${pad.left + plotW - 2}" y="${(lastY - 11).toFixed(1)}" width="${priceTagW}" height="22" rx="4" fill="${tagColor}"/>`,
    `<text x="${(pad.left + plotW + priceTagW / 2 - 2).toFixed(1)}" y="${(lastY + 5).toFixed(1)}" text-anchor="middle" font-family="'Segoe UI',Arial,sans-serif" font-size="12" font-weight="700" fill="#ffffff">${last.close.toFixed(3)}</text>`
  ];

  // ── X-axis date labels (show ~8 evenly spaced) ───────────────────
  const xLabels = [];
  const maxLabels = Math.min(8, candles.length);
  const step = Math.max(1, Math.round(candles.length / maxLabels));
  for (let i = 0; i < candles.length; i++) {
    if (i % step !== 0 && i !== candles.length - 1) continue;
    const d       = candles[i].date;
    const dateStr = `${d.getDate()} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()]}`;
    xLabels.push(
      `<text x="${xFor(i).toFixed(1)}" y="${height - pad.bottom + 22}" text-anchor="middle" font-family="'Segoe UI',Arial,sans-serif" font-size="11" fill="#72767d">${svgEscape(dateStr)}</text>`,
      `<line x1="${xFor(i).toFixed(1)}" y1="${pad.top + plotH}" x2="${xFor(i).toFixed(1)}" y2="${pad.top + plotH + 5}" stroke="#3a3d45" stroke-width="1"/>`
    );
  }

  // ── Header ───────────────────────────────────────────────────────
  const currencyNames  = { USD: 'US Dollar', EUR: 'Euro', GBP: 'British Pound' };
  const currencySymbol = { USD: '$', EUR: '€', GBP: '£' };
  const sym    = currencySymbol[mainCurrency] || '';
  const cName  = currencyNames[mainCurrency]  || mainCurrency;
  const delta  = candles.length > 1 ? last.close - candles[0].close : 0;
  const deltaTxt = (delta >= 0 ? '+' : '') + delta.toFixed(3);
  const deltaColor = delta >= 0 ? '#26a69a' : '#ef5350';

  // ── Legend ───────────────────────────────────────────────────────
  const legendY = pad.top - 28;
  const legend = [
    `<rect x="${pad.left + plotW - 200}" y="${legendY - 9}" width="12" height="12" rx="2" fill="#26a69a"/>`,
    `<text x="${pad.left + plotW - 185}" y="${legendY}" font-family="'Segoe UI',Arial,sans-serif" font-size="11" fill="#72767d">Rate Up (Dinar Weaker)</text>`,
    `<rect x="${pad.left + plotW - 60}" y="${legendY - 9}" width="12" height="12" rx="2" fill="#ef5350"/>`,
    `<text x="${pad.left + plotW - 45}" y="${legendY}" font-family="'Segoe UI',Arial,sans-serif" font-size="11" fill="#72767d">Rate Down</text>`,
  ].join('\n');

  const maLegendY = legendY + 16;
  const maLegend = maLine.length > 1
    ? `<line x1="${pad.left + plotW - 200}" y1="${maLegendY - 4}" x2="${pad.left + plotW - 185}" y2="${maLegendY - 4}" stroke="#f0c040" stroke-width="1.5" stroke-dasharray="5,3" opacity="0.7"/>
       <text x="${pad.left + plotW - 183}" y="${maLegendY}" font-family="'Segoe UI',Arial,sans-serif" font-size="11" fill="#72767d">${maWindow}-day MA</text>`
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bgGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="#1e2124"/>
      <stop offset="100%" stop-color="#292b2f"/>
    </linearGradient>
    <clipPath id="plotClip">
      <rect x="${pad.left}" y="${pad.top}" width="${plotW}" height="${plotH}"/>
    </clipPath>
  </defs>

  <!-- Background -->
  <rect width="${width}" height="${height}" fill="url(#bgGrad)" rx="12"/>
  <rect x="${pad.left}" y="${pad.top}" width="${plotW}" height="${plotH}" fill="#1a1c1f" rx="4"/>

  <!-- Alternating bands -->
  ${bands.join('\n')}

  <!-- Grid -->
  ${gridLines.join('\n')}

  <!-- Axis lines -->
  <line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${pad.top + plotH}" stroke="#4e5058" stroke-width="1.5"/>
  <line x1="${pad.left}" y1="${pad.top + plotH}" x2="${pad.left + plotW}" y2="${pad.top + plotH}" stroke="#4e5058" stroke-width="1.5"/>

  <!-- Chart content (clipped) -->
  <g clip-path="url(#plotClip)">
    ${candlesSvg.join('\n')}
    ${trendPath}
  </g>

  <!-- Latest price tag (outside clip so it shows on right edge) -->
  ${priceTag.join('\n')}

  <!-- X labels -->
  ${xLabels.join('\n')}

  <!-- Header -->
  <text x="${pad.left}" y="30" font-family="'Segoe UI',Arial,sans-serif" font-size="18" font-weight="700" fill="#ffffff">${cName} / LYD</text>
  <text x="${pad.left}" y="52" font-family="'Segoe UI',Arial,sans-serif" font-size="13" fill="#72767d">Libyan Black Market Rate · Last 30 Days</text>
  <text x="${pad.left + 160}" y="30" font-family="'Segoe UI',Arial,sans-serif" font-size="22" font-weight="700" fill="#ffffff">${sym}${last.close.toFixed(3)} LYD</text>
  <text x="${pad.left + 280}" y="30" font-family="'Segoe UI',Arial,sans-serif" font-size="14" font-weight="600" fill="${deltaColor}">${deltaTxt}</text>

  <!-- Legend -->
  ${legend}
  ${maLegend}
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
  const latest = await scrapeFacebookRates();
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
