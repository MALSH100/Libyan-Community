// =============================================================================
// LIBYAN BLACK MARKET EXCHANGE RATE
// Scrapes the configured public Facebook page with Playwright, parses USD/EUR/GBP
// rates, stores history in the existing MongoDB-backed db object, and posts
// updates to a configured Discord channel every hour.
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

  new SlashCommandBuilder()
    .setName('exchange-chart')
    .setDescription('Show a line graph of recent USD/EUR/GBP exchange rates')
    .setDMPermission(false),
].map(c => c.toJSON());

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
  const lines = text
    .split(/\n+/)
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

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

  // New: Direct patterns for the current Facebook post format:
  // "-dollar $1=08.39 LYD."
  // "-Euro €1=9.69 LYD."
  // "-Pound £1=10.93 LYD."
  const hyphenPatterns = [
    { currency: 'USD', regex: /-dollar\s*\$1\s*=\s*(\d{1,2}(?:[.,]\d{1,2})?)\s*LYD\.?/i },
    { currency: 'EUR', regex: /-Euro\s*€1\s*=\s*(\d{1,2}(?:[.,]\d{1,2})?)\s*LYD\.?/i },
    { currency: 'GBP', regex: /-Pound\s*£1\s*=\s*(\d{1,2}(?:[.,]\d{1,2})?)\s*LYD\.?/i },
  ];

  for (const p of hyphenPatterns) {
    const match = text.match(p.regex);
    if (match) rates[p.currency] = num(match[1]);
  }

  // If still missing, try generic patterns (without hyphen)
  if (rates.USD === null) {
    const match = text.match(/\$1\s*=\s*(\d{1,2}(?:[.,]\d{1,2})?)\s*LYD/i);
    if (match) rates.USD = num(match[1]);
  }
  if (rates.EUR === null) {
    const match = text.match(/€1\s*=\s*(\d{1,2}(?:[.,]\d{1,2})?)\s*LYD/i);
    if (match) rates.EUR = num(match[1]);
  }
  if (rates.GBP === null) {
    const match = text.match(/£1\s*=\s*(\d{1,2}(?:[.,]\d{1,2})?)\s*LYD/i);
    if (match) rates.GBP = num(match[1]);
  }

  // Use keyword proximity as a final fallback
  if (rates.USD === null) rates.USD = findRateNearKeyword(text, ['usd', 'dollar', 'dolar', '$']);
  if (rates.EUR === null) rates.EUR = findRateNearKeyword(text, ['eur', 'euro', '€']);
  if (rates.GBP === null) rates.GBP = findRateNearKeyword(text, ['gbp', 'pound', 'sterling', '£']);

  // Ultra fallback: scan each line for any number near a currency symbol
  if (rates.USD === null) {
    const lines = text.split(/\n/);
    for (const line of lines) {
      if (/\$/.test(line) || /dollar/i.test(line)) {
        const match = line.match(/\b(\d{1,2}(?:[.,]\d{1,2})?)\b/);
        if (match) { rates.USD = num(match[1]); break; }
      }
    }
  }
  if (rates.EUR === null) {
    const lines = text.split(/\n/);
    for (const line of lines) {
      if (/€/.test(line) || /euro/i.test(line)) {
        const match = line.match(/\b(\d{1,2}(?:[.,]\d{1,2})?)\b/);
        if (match) { rates.EUR = num(match[1]); break; }
      }
    }
  }
  if (rates.GBP === null) {
    const lines = text.split(/\n/);
    for (const line of lines) {
      if (/£/.test(line) || /pound|sterling/i.test(line)) {
        const match = line.match(/\b(\d{1,2}(?:[.,]\d{1,2})?)\b/);
        if (match) { rates.GBP = num(match[1]); break; }
      }
    }
  }

  if (CURRENCIES.every(c => rates[c] === null)) {
    console.error('❌ All parsing methods failed. Text sample (first 500 chars):', text.slice(0, 500));
    return null;
  }

  console.log(`✅ Parsed rates: USD=${rates.USD}, EUR=${rates.EUR}, GBP=${rates.GBP}`);
  return rates;
}

async function scrapeFacebookRates() {
  let browser;
  let context;
  let page;
  
  try {
    const { chromium } = require('playwright');
    
    // Launch browser with persistent user data directory
    // This saves cookies and session so you stay logged in across runs
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36'
      ],
    });
    
    // Use a persistent context to save cookies (optional but recommended)
    context = await browser.newContext({
      viewport: { width: 1365, height: 900 },
      locale: 'en-GB',
    });
    
    page = await context.newPage();
    
    // Navigate to the page
    await page.goto(SOURCE_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(5000);
    
    // Check if we're on a login page
    const currentUrl = page.url();
    if (currentUrl.includes('login') || currentUrl.includes('checkpoint')) {
      console.log('[Exchange] Login required. Attempting to log in...');
      
      // Wait for the login form to be present
      await page.waitForSelector('input[type="email"], input[name="email"], #email', { timeout: 10000 });
      
      // Fill email – try multiple selectors
      const emailInput = await page.$('input[type="email"], input[name="email"], #email');
      if (emailInput) await emailInput.fill(process.env.FACEBOOK_EMAIL);
      
      // Fill password
      const passInput = await page.$('input[type="password"], input[name="pass"], #pass');
      if (passInput) await passInput.fill(process.env.FACEBOOK_PASSWORD);
      
      // Click login button – try multiple selectors, then fallback to Enter key
      const loginButton = await page.$('button[type="submit"], button[name="login"], #loginbutton, div[aria-label="Log in"]');
      if (loginButton) {
        await loginButton.click();
      } else {
        // Fallback: press Enter after filling
        await page.keyboard.press('Enter');
      }
      
      // Wait for navigation (may be a redirect, not necessarily networkidle)
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      
      // Handle "Save login info?" popup if present
      await page.waitForTimeout(3000);
      const saveInfoBtn = await page.$('button[value="1"], button[data-testid="save-login-button"]');
      if (saveInfoBtn) {
        await saveInfoBtn.click();
        await page.waitForTimeout(2000);
      }
      
      console.log('[Exchange] Login successful.');
    }
    
    // Scroll to ensure content loads
    for (let i = 0; i < 4; i++) {
      await page.mouse.wheel(0, 900);
      await page.waitForTimeout(1000);
    }
    
    const text = await page.locator('body').innerText({ timeout: 15000 });
    const rates = parseRatesFromText(text);
    
    if (!rates) {
      console.error('[Exchange] Failed to parse rates. Page text sample:', text.slice(0, 500));
      throw new Error('Could not find USD/EUR/GBP rates in the Facebook page text.');
    }
    
    return {
      rates,
      scrapedAt: new Date().toISOString(),
      sourceUrl: SOURCE_URL,
      sample: text.slice(0, 1200),
    };
    
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
  const previous = [...history].reverse().find(entry => entry.rates && entry.rates[currency] !== null && entry.rates[currency] !== undefined);
  if (!previous || latestValue === null || latestValue === undefined) return { label: 'No previous data', delta: null };
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
embed.addFields({
  name: currency,
  value: value === null || value === undefined ? 'Not found' : `**${value.toFixed(2)} LYD**\n${t.label}`,
  inline: true,
});
  }

  return embed;
}

function svgEscape(value) {
  return String(value).replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function buildChartSvg(history, mainCurrency = 'USD') {
  // Sort by date, oldest first
  let rows = (history || [])
    .filter(entry => entry.rates && typeof entry.rates[mainCurrency] === 'number')
    .sort((a, b) => new Date(a.scrapedAt) - new Date(b.scrapedAt))
    .slice(-CHART_POINTS);
  
  if (rows.length === 0) return `<svg width="900" height="480"></svg>`;

  const width = 900;
  const height = 480;
  const pad = { left: 70, right: 40, top: 50, bottom: 70 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const palette = { USD: '#16a34a', EUR: '#2563eb', GBP: '#dc2626' };
  const currencySymbols = { USD: '$', EUR: '€', GBP: '£' };
  const color = palette[mainCurrency];
  
  // Collect values for Y range
  let allValues = rows.map(r => r.rates[mainCurrency]).filter(v => typeof v === 'number');
  if (allValues.length === 0) return `<svg width="900" height="480"></svg>`;
  
  let min = Math.min(...allValues);
  let max = Math.max(...allValues);
  const padVal = (max - min) * 0.1;
  min = Math.max(0, min - padVal);
  max = max + padVal;
  
  // Nice Y‑axis ticks
  const step = (max - min) / 4;
  let niceStep = Math.ceil(step / 0.5) * 0.5;
  if (niceStep < 0.1) niceStep = 0.1;
  let niceMin = Math.floor(min / niceStep) * niceStep;
  let niceMax = Math.ceil(max / niceStep) * niceStep;
  const tickValues = [];
  for (let i = niceMin; i <= niceMax + 0.001; i += niceStep) {
    tickValues.push(i);
  }
  
  const yFor = (value) => pad.top + (1 - ((value - niceMin) / (niceMax - niceMin))) * plotH;
  const xFor = (idx) => pad.left + (idx / (rows.length - 1)) * plotW;
  
  // Grid and Y‑axis
  const grid = [];
  for (const val of tickValues) {
    const y = yFor(val);
    if (y < pad.top - 5 || y > pad.top + plotH + 5) continue;
    grid.push(`<line x1="${pad.left}" y1="${y}" x2="${width - pad.right}" y2="${y}" stroke="#4e5058" stroke-width="1"/>`);
    grid.push(`<text x="${pad.left - 10}" y="${y + 4}" text-anchor="end" font-size="12" fill="#b9bbbe">${val.toFixed(2)}</text>`);
  }
  
  // Line and points
  const points = rows.map((row, idx) => {
    const val = row.rates[mainCurrency];
    if (typeof val !== 'number') return null;
    return `${xFor(idx).toFixed(1)},${yFor(val).toFixed(1)}`;
  }).filter(Boolean);
  
  const line = points.length >= 2 ? `<polyline points="${points.join(' ')}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>` : '';
  const dots = points.map((point, i) => {
    const [x, y] = point.split(',');
    return `<circle cx="${x}" cy="${y}" r="3" fill="#36393f" stroke="${color}" stroke-width="1.5"/>`;
  }).join('\n');
  
  // Callout only for the latest point
  const lastRow = rows[rows.length - 1];
  const lastVal = lastRow.rates[mainCurrency];
  const lastX = xFor(rows.length - 1);
  const lastY = yFor(lastVal);
  const callouts = [];
  const offsetX = 35;
  const yOffset = -28;
  let labelX = lastX + offsetX;
  let labelY = lastY + yOffset;
  labelX = Math.min(Math.max(labelX, pad.left + 20), width - pad.right - 55);
  labelY = Math.min(Math.max(labelY, pad.top + 15), height - pad.bottom - 20);
  const boxW = 55;
  const boxH = 20;
  const boxX = (labelX > lastX) ? labelX : labelX - boxW;
  const boxCenterX = boxX + boxW/2;
  const boxCenterY = labelY;
  callouts.push(`<line x1="${lastX.toFixed(1)}" y1="${lastY.toFixed(1)}" x2="${lastX.toFixed(1)}" y2="${boxCenterY.toFixed(1)}" stroke="${color}" stroke-width="1" stroke-dasharray="2,2"/>`);
  callouts.push(`<line x1="${lastX.toFixed(1)}" y1="${boxCenterY.toFixed(1)}" x2="${boxCenterX.toFixed(1)}" y2="${boxCenterY.toFixed(1)}" stroke="${color}" stroke-width="1" stroke-dasharray="2,2"/>`);
  callouts.push(`<rect x="${boxX}" y="${labelY - 10}" width="${boxW}" height="${boxH}" rx="4" fill="#2f3136" stroke="${color}" stroke-width="1"/>`);
  const symbol = currencySymbols[mainCurrency] || '';
  callouts.push(`<text x="${boxCenterX}" y="${labelY + 3}" text-anchor="middle" fill="#ffffff" font-size="11" font-weight="bold">${symbol}${lastVal.toFixed(2)}</text>`);
  
  // X‑axis labels (unique dates)
  const xLabels = [];
  const seenDates = new Set();
  for (let i = 0; i < rows.length; i++) {
    const date = new Date(rows[i].scrapedAt);
    const dateKey = `${date.getDate()}/${date.getMonth() + 1}`;
    if (!seenDates.has(dateKey)) {
      seenDates.add(dateKey);
      const x = xFor(i);
      xLabels.push(`<text x="${x.toFixed(1)}" y="${height - 30}" text-anchor="middle" font-size="10" fill="#b9bbbe">${svgEscape(dateKey)}</text>`);
    }
  }
  const labels = xLabels.join('\n');
  
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#36393f"/>
  <text x="${pad.left}" y="24" font-size="16" font-weight="700" fill="#ffffff">Libyan Black Market Exchange Trend – ${mainCurrency} (LYD per 1 unit)</text>
  ${grid.join('\n')}
  <line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${pad.top + plotH}" stroke="#4e5058" stroke-width="1.5"/>
  <line x1="${pad.left}" y1="${pad.top + plotH}" x2="${width - pad.right}" y2="${pad.top + plotH}" stroke="#4e5058" stroke-width="1.5"/>
  ${line}
  ${dots}
  ${callouts.join('\n')}
  ${labels}
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
    await page.setContent(`
      <html>
        <body style="margin:0; display:flex; justify-content:center; align-items:center; background:white;">
          ${svgString}
        </body>
      </html>
    `);
    // Wait for SVG to render
    await page.waitForSelector('svg');
    const element = await page.$('svg');
    const pngBuffer = await element.screenshot({ type: 'png' });
    return pngBuffer;
  } finally {
    await browser.close();
  }
}

async function postUpdate(client, guildId, exchangeData, latest, forced = false) {
  if (!exchangeData.channelId) return false;
  const channel = await client.channels.fetch(exchangeData.channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return false;

   const files = [];
  let embed = buildRateEmbed(exchangeData, latest, forced);
  
  if ((exchangeData.history || []).length >= 2) {
    const chartFile = await chartAttachment(exchangeData);
    files.push(chartFile);
    embed.setImage('attachment://libya-exchange-chart.png');
  }

  await channel.send({
    embeds: [embed],
    files,
  });
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

  // Only push to history if the rates changed OR it's a forced refresh
  if (forcePost || changed) {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    // Check if we already have an entry for today
    const existingIndex = exchangeData.history.findIndex(entry => 
      new Date(entry.scrapedAt).toISOString().slice(0, 10) === today
    );
    if (existingIndex !== -1) {
      // Replace today's entry with the latest
      exchangeData.history[existingIndex] = latest;
    } else {
      // Add new entry
      exchangeData.history.push(latest);
    }
    // Keep only the last MAX_HISTORY days
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
      updateRates({ client, db, saveData, guildId }).catch(err => {
        console.error(`Exchange update failed for guild ${guildId}:`, err.message);
      });
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
      console.log(`[Exchange] Received command: ${interaction.commandName}`);
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
        if (!latest) {
          return safeReply(interaction, { content: 'No exchange rate has been saved yet. Ask an admin to run /exchange-refresh or /exchange-set-channel.', flags: 64 });
        }
        return safeReply(interaction, { embeds: [buildRateEmbed(exchangeData, latest, true)], flags: 64 });
      }

if (commandName === 'exchange-chart') {
  if (!exchangeData.history || exchangeData.history.length < 2) {
    return safeReply(interaction, { content: 'Not enough exchange history yet. The chart needs at least two saved updates.', flags: 64 });
  }
  
  await interaction.deferReply({ flags: 64 });
  
  try {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('chart_usd').setLabel('$ USD').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('chart_eur').setLabel('€ EUR').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('chart_gbp').setLabel('£ GBP').setStyle(ButtonStyle.Primary),
    );
    
    // Initial chart (USD)
    const initialChart = await chartAttachment(exchangeData, 'USD');
    await interaction.editReply({
      content: '📈 Select a currency to view its exchange rate trend:',
      files: [initialChart],
      components: [row],
    });
    
    const msg = await interaction.fetchReply();
    const filter = i => i.user.id === interaction.user.id && ['chart_usd','chart_eur','chart_gbp'].includes(i.customId);
    const collector = msg.createMessageComponentCollector({ filter, time: 60000 });
    
    collector.on('collect', async i => {
      let currency = 'USD';
      if (i.customId === 'chart_eur') currency = 'EUR';
      if (i.customId === 'chart_gbp') currency = 'GBP';
      const newChart = await chartAttachment(exchangeData, currency);
      await i.update({ files: [newChart], components: [row] });
    });
    
    collector.on('end', () => {
      interaction.editReply({ components: [] }).catch(() => {});
    });
  } catch (err) {
    console.error('[Exchange] Chart error:', err);
    await interaction.editReply({ content: '❌ Failed to generate chart. Please try again later.' });
  }
  return;
}

      if (commandName === 'exchange-refresh') {
        if (!isAdmin(interaction)) return safeReply(interaction, { content: 'Only admins can refresh and post exchange updates.', flags: 64 });
        await interaction.deferReply({ flags: 64 });
        const result = await updateRates({ client, db, saveData, guildId: guild.id, forcePost: true });
        const postedText = result.posted ? 'Posted to the configured channel.' : 'Saved, but no exchange channel is configured yet.';
        return safeReply(interaction, { content: `Exchange rates refreshed. ${postedText}` });
      }

      if (commandName === 'exchange-debug') {
        if (!isAdmin(interaction)) return safeReply(interaction, { content: 'Admin only.', flags: 64 });
        const exchangeData = getExchangeData(db, guild.id);
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
      // Truncate error message — Discord limit is 2000 chars
      const shortErr = err.message?.slice(0, 200) || 'Unknown error';
      return safeReply(interaction, { content: `❌ Exchange feature error: ${shortErr}`, flags: 64 });
    }
  });
};

module.exports.commands = exchangeCommands;
module.exports.parseRatesFromText = parseRatesFromText;
