// =============================================================================
// LIBYAN BLACK MARKET EXCHANGE RATE
// =============================================================================

const fs = require('fs');
const path = require('path');

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
const COOKIE_PATH = path.resolve('./fb-session.json');

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
// Data & helper functions
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

  // Check for holiday or no-update message
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

// ----------------------------------------------------------------------
// FIX 1: Content-based login detection helper
// ----------------------------------------------------------------------
function isLoginPage(url, bodyText) {
  if (url.includes('login') || url.includes('checkpoint')) return true;
  const t = bodyText.toLowerCase();
  return (
    t.includes('email address or phone number') ||
    t.includes('forgotten password') ||
    t.includes('log in to facebook') ||
    t.includes('create new account') && t.includes('log in')
  );
}

async function scrapeFacebookRates() {
  // playwright-extra + stealth plugin defeats Facebook's headless browser detection.
  // Install with: npm install playwright-extra puppeteer-extra-plugin-stealth
  const { chromium: chromiumExtra } = require('playwright-extra');
  const StealthPlugin = require('puppeteer-extra-plugin-stealth');
  chromiumExtra.use(StealthPlugin());

  let browser, context, page;
  try {
    browser = await chromiumExtra.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--window-size=1365,900',
      ],
    });

    // Reuse saved session cookies if available to skip login
    const storageState = fs.existsSync(COOKIE_PATH) ? COOKIE_PATH : undefined;
    if (storageState) {
      console.log('[Exchange] Reusing saved Facebook session from', COOKIE_PATH);
    }

    context = await browser.newContext({
      viewport: { width: 1365, height: 900 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'en-GB',
      timezoneId: 'Africa/Tripoli',
      storageState,
      extraHTTPHeaders: {
        'Accept-Language': 'en-GB,en;q=0.9',
      },
    });

    // Mask webdriver property at the page level as an extra measure
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-GB', 'en'] });
      window.chrome = { runtime: {} };
    });

    page = await context.newPage();

      // Go to the exchange page with a more robust wait
    let retries = 2;
    let loaded = false;
    for (let attempt = 1; attempt <= retries; attempt++) {
      console.log(`[Exchange] Loading page attempt ${attempt}...`);
      await page.goto(SOURCE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(5000);

      const currentUrl = page.url();
      const earlyText = await page.locator('body').innerText({ timeout: 10000 }).catch(() => '');
      console.log('[Exchange] Initial URL:', currentUrl);
      console.log('[Exchange] Initial body length:', earlyText.length);

      // Check for challenge page (empty body or security text)
      if (earlyText.length < 100 && (earlyText.includes('Checking your browser') || earlyText.includes('captcha') || earlyText.includes('security'))) {
        console.log('[Exchange] Challenge page detected. Waiting 15 seconds before retry...');
        await page.waitForTimeout(15000);
        continue;
      }

      loaded = true;
      break;
    }
    if (!loaded) throw new Error('Facebook is presenting a challenge (captcha/cloudflare). The bot cannot bypass it. Consider using a different source.');

    const currentUrl = page.url();
    const earlyText = await page.locator('body').innerText({ timeout: 10000 }).catch(() => '');
    console.log('[Exchange] Final URL after loading attempts:', currentUrl);

    if (isLoginPage(currentUrl, earlyText)) {
      console.log('[Exchange] Login wall detected. Logging in...');

      // ... (keep your existing login code exactly as you have it, but add a check after login for empty body)
      // ... paste your login code here (the one that types email/password) ...

      // After login, wait for navigation and then re-check for empty body
      await page.waitForTimeout(5000);
      const afterLoginText = await page.locator('body').innerText({ timeout: 15000 }).catch(() => '');
      if (afterLoginText.length < 100 && (afterLoginText.includes('Checking your browser') || afterLoginText.includes('security'))) {
        throw new Error('Login succeeded but Facebook returned a challenge page. Manual intervention required.');
      }
    }

    // If we got redirected to the home feed, go back to the exchange page
    const afterLoginUrl = page.url();
    if (!afterLoginUrl.includes('100064752788893') && !afterLoginUrl.includes('Dollar-Euro-Pound')) {
      console.log('[Exchange] Redirected away from exchange page, navigating back...');
      await page.goto(SOURCE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(6000);
    }

    // Wait for real post content
    console.log('[Exchange] Waiting for post content...');
    try {
      await page.waitForSelector('[role="article"], [role="main"] [data-ad-comet-preview], [role="main"]', { timeout: 30000 });
    } catch {
      console.log('[Exchange] Article selector timed out, but continuing...');
    }

    // Scroll to load lazy content
    for (let i = 0; i < 5; i++) {
      await page.mouse.wheel(0, 800);
      await page.waitForTimeout(1500);
    }
    await page.waitForTimeout(3000);

    const finalUrl = page.url();
    const text = await page.locator('body').innerText({ timeout: 15000 }).catch(() => '');
    const html = await page.content().catch(() => '');

    console.log('[Exchange] Final URL:', finalUrl);
    console.log('[Exchange] Body text length:', text.length);
    console.log('[Exchange] Body text (first 2000 chars):\n', text.slice(0, 2000));
    if (text.length < 200) {
      console.log('[Exchange] HTML (first 3000 chars):\n', html.slice(0, 3000));
    }

    if (isLoginPage(finalUrl, text)) {
      throw new Error('Still on login page after login attempt - check FACEBOOK_EMAIL / FACEBOOK_PASSWORD env vars.');
    }

    if (text.length < 100) {
      throw new Error(`Page body is empty (${text.length} chars) - stealth may not be installed or Facebook is serving a challenge. HTML logged above.`);
    }

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
  const GREEN       = '#22c55e';
  const GREEN_LIGHT = '#4ade80';
  const RED         = '#ef4444';
  const RED_LIGHT   = '#f87171';
  const NEUTRAL     = '#94a3b8';

  const candles = [];
  for (let i = 0; i < rows.length; i++) {
    const close = rows[i].rates[mainCurrency];
    const open  = i === 0 ? close : rows[i - 1].rates[mainCurrency];
    const high  = Math.max(open, close);
    const low   = Math.min(open, close);
    const ts    = new Date(rows[i].scrapedAt);
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
  const vPad = dataRange * 0.15;
  minVal = Math.max(0, minVal - vPad);
  maxVal = maxVal + vPad;

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

  // ── 6. X-axis date labels ─────────────────────────────────────────────────
  const xLabels   = [];
  let   lastDay   = null;
  const dayBoundaries = [];
  for (let i = 0; i < candles.length; i++) {
    const dayKey = candles[i].ts.toISOString().slice(0, 10);
    if (dayKey !== lastDay) {
      dayBoundaries.push({ i, ts: candles[i].ts });
      lastDay = dayKey;
    }
  }
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

  // ── 8. Latest price tag ───────────────────────────────────────────────────
  const last     = candles[candles.length - 1];
  const lastY    = yFor(last.close);
  const tagColor = last.dinarStrengthened ? GREEN : RED;
  const TAG_W = 62, TAG_H = 22, TAG_X = pad.left + plotW + 4;
  const priceLine = `<line x1="${pad.left}" y1="${lastY.toFixed(1)}" x2="${(TAG_X - 2).toFixed(1)}" y2="${lastY.toFixed(1)}" stroke="${tagColor}" stroke-width="1" stroke-dasharray="3,3" opacity="0.55"/>`;
  const priceTag  = [
    priceLine,
    `<rect x="${TAG_X}" y="${(lastY - TAG_H/2).toFixed(1)}" width="${TAG_W}" height="${TAG_H}" rx="4" fill="${tagColor}"/>`,
    `<text x="${(TAG_X + TAG_W/2).toFixed(1)}" y="${(lastY + 5).toFixed(1)}" text-anchor="middle" font-family="'Segoe UI',Arial,sans-serif" font-size="12" font-weight="700" fill="#ffffff">${last.close.toFixed(2)}</text>`,
  ];

  // ── 9. Header block ───────────────────────────────────────────────────────
  const SYM   = { USD: '$', EUR: '€', GBP: '£' };
  const NAMES = { USD: 'US Dollar', EUR: 'Euro', GBP: 'British Pound' };
  const sym   = SYM[mainCurrency]   || '';
  const cName = NAMES[mainCurrency] || mainCurrency;

  const periodDelta    = candles.length > 1 ? last.close - candles[0].close : 0;
  const deltaTxt       = (periodDelta > 0 ? '+' : '') + periodDelta.toFixed(3);
  const deltaColor     = periodDelta < 0 ? GREEN : (periodDelta > 0 ? RED : NEUTRAL);
  const deltaArrow     = periodDelta < 0 ? '▼' : (periodDelta > 0 ? '▲' : '');

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

  <!-- Header -->
  <text x="${pad.left}" y="26" font-family="'Segoe UI',Arial,sans-serif" font-size="15" font-weight="700" fill="#f9fafb">${svgEscape(cName)} / LYD</text>
  <text x="${pad.left}" y="46" font-family="'Segoe UI',Arial,sans-serif" font-size="11" fill="#6b7280">${svgEscape(dateRange)}</text>
  <text x="${pad.left + plotW}" y="26" text-anchor="end" font-family="'Segoe UI',Arial,sans-serif" font-size="20" font-weight="700" fill="#f9fafb">${sym}${last.close.toFixed(2)} LYD</text>
  <text x="${pad.left + plotW}" y="46" text-anchor="end" font-family="'Segoe UI',Arial,sans-serif" font-size="12" font-weight="600" fill="${deltaColor}">${deltaArrow} ${svgEscape(deltaTxt)}</text>

  <!-- Bottom legend -->
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

        // Acknowledge the click immediately so Discord doesn't show "interaction failed"
        await i.deferUpdate();

        const newChart = await chartAttachment(exchangeData, currency);
        const updatedEmbed = EmbedBuilder.from(embed)
          .setImage(`attachment://libya-exchange-chart-${currency}.png`);

        // FIX 3: Edit the shared message directly rather than i.editReply()
        // This ensures all users see the update, not just whoever clicked
        await message.edit({
          embeds: [updatedEmbed],
          files: [newChart],
          components: [row],
          attachments: [], // clear the previous chart image so the new one takes over
        });
      } catch (err) {
        console.error('[Exchange] Button error:', err);
        await i.followUp({ content: 'Failed to update chart.', ephemeral: true }).catch(() => {});
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
