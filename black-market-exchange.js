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
  const hyphenPatterns = [
    { currency: 'USD', regex: /-dollar\s*\$1\s*=\s*(\d{1,2}(?:[.,]\d{1,2})?)\s*LYD\.?/i },
    { currency: 'EUR', regex: /-Euro\s*€1\s*=\s*(\d{1,2}(?:[.,]\d{1,2})?)\s*LYD\.?/i },
    { currency: 'GBP', regex: /-Pound\s*£1\s*=\s*(\d{1,2}(?:[.,]\d{1,2})?)\s*LYD\.?/i },
  ];
  for (const p of hyphenPatterns) {
    const match = text.match(p.regex);
    if (match) rates[p.currency] = num(match[1]);
  }
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
  if (rates.USD === null) rates.USD = findRateNearKeyword(text, ['usd', 'dollar', 'dolar', '$']);
  if (rates.EUR === null) rates.EUR = findRateNearKeyword(text, ['eur', 'euro', '€']);
  if (rates.GBP === null) rates.GBP = findRateNearKeyword(text, ['gbp', 'pound', 'sterling', '£']);
  if (CURRENCIES.every(c => rates[c] === null)) {
    console.error('❌ All parsing methods failed. Text sample (first 500 chars):', text.slice(0, 500));
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
  // Filter entries with valid rate for the selected currency, sort by date
  let rows = (history || [])
    .filter(entry => entry.rates && typeof entry.rates[mainCurrency] === 'number')
    .sort((a, b) => new Date(a.scrapedAt) - new Date(b.scrapedAt));
  
  if (rows.length === 0) return `<svg width="900" height="480"></svg>`;

  const width = 900;
  const height = 480;
  const pad = { left: 70, right: 40, top: 50, bottom: 70 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  
  // Build candlestick data (open = previous close, high/low derived)
  const candles = [];
  for (let i = 0; i < rows.length; i++) {
    const close = rows[i].rates[mainCurrency];
    const open = i === 0 ? close : rows[i-1].rates[mainCurrency];
    const high = Math.max(open, close);
    const low = Math.min(open, close);
    const date = new Date(rows[i].scrapedAt);
    // Color: green if close < open (dinar strengthens), red if close > open (dinar weakens)
    const color = close < open ? '#26a69a' : (close > open ? '#ef5350' : '#888888');
    candles.push({ date, open, high, low, close, color });
  }
  
  // Y‑axis range with padding
  let allValues = candles.flatMap(c => [c.high, c.low]);
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
  for (let i = niceMin; i <= niceMax + 0.001; i += niceStep) tickValues.push(i);
  
  const yFor = (value) => pad.top + (1 - ((value - niceMin) / (niceMax - niceMin))) * plotH;
  const xFor = (idx) => pad.left + (idx / (candles.length - 1)) * plotW;
  const candleWidth = Math.max(3, Math.min(10, plotW / candles.length * 0.6));
  const halfWidth = candleWidth / 2;
  
  // Grid and Y‑axis labels
  const grid = [];
  for (const val of tickValues) {
    const y = yFor(val);
    if (y < pad.top - 5 || y > pad.top + plotH + 5) continue;
    grid.push(`<line x1="${pad.left}" y1="${y}" x2="${width - pad.right}" y2="${y}" stroke="#4e5058" stroke-width="1"/>`);
    grid.push(`<text x="${pad.left - 10}" y="${y + 4}" text-anchor="end" font-size="12" fill="#b9bbbe">${val.toFixed(2)}</text>`);
  }
  
  // Draw candlesticks
  const candlesSvg = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const x = xFor(i);
    const highY = yFor(c.high);
    const lowY = yFor(c.low);
    const openY = yFor(c.open);
    const closeY = yFor(c.close);
    const bodyTop = Math.min(openY, closeY);
    const bodyBottom = Math.max(openY, closeY);
    const bodyHeight = Math.max(1, bodyBottom - bodyTop);
    // Wick
    candlesSvg.push(`<line x1="${x}" y1="${highY}" x2="${x}" y2="${lowY}" stroke="${c.color}" stroke-width="1.5"/>`);
    // Candle body
    candlesSvg.push(`<rect x="${x - halfWidth}" y="${bodyTop}" width="${candleWidth}" height="${bodyHeight}" fill="${c.color}" stroke="${c.color}" stroke-width="1"/>`);
  }
  
  // Callout for the latest closing value
  const lastCandle = candles[candles.length - 1];
  const lastX = xFor(candles.length - 1);
  const lastY = yFor(lastCandle.close);
  const offsetX = 35, yOffset = -28;
  let labelX = lastX + offsetX;
  let labelY = lastY + yOffset;
  labelX = Math.min(Math.max(labelX, pad.left + 20), width - pad.right - 55);
  labelY = Math.min(Math.max(labelY, pad.top + 15), height - pad.bottom - 20);
  const boxW = 55, boxH = 20;
  const boxX = labelX > lastX ? labelX : labelX - boxW;
  const boxCenterX = boxX + boxW/2;
  const boxCenterY = labelY;
  const currencySymbols = { USD: '$', EUR: '€', GBP: '£' };
  const symbol = currencySymbols[mainCurrency] || '';
  const callouts = [
    `<line x1="${lastX.toFixed(1)}" y1="${lastY.toFixed(1)}" x2="${lastX.toFixed(1)}" y2="${boxCenterY.toFixed(1)}" stroke="#888888" stroke-width="1" stroke-dasharray="2,2"/>`,
    `<line x1="${lastX.toFixed(1)}" y1="${boxCenterY.toFixed(1)}" x2="${boxCenterX.toFixed(1)}" y2="${boxCenterY.toFixed(1)}" stroke="#888888" stroke-width="1" stroke-dasharray="2,2"/>`,
    `<rect x="${boxX}" y="${labelY - 10}" width="${boxW}" height="${boxH}" rx="4" fill="#2f3136" stroke="#888888" stroke-width="1"/>`,
    `<text x="${boxCenterX}" y="${labelY + 3}" text-anchor="middle" fill="#ffffff" font-size="11" font-weight="bold">${symbol}${lastCandle.close.toFixed(2)}</text>`
  ];
  
  // X‑axis labels: one per unique date
  const xLabels = [];
  const seenDates = new Set();
  for (let i = 0; i < candles.length; i++) {
    const date = candles[i].date;
    const dateKey = `${date.getDate()}/${date.getMonth() + 1}`;
    if (!seenDates.has(dateKey)) {
      seenDates.add(dateKey);
      xLabels.push(`<text x="${xFor(i).toFixed(1)}" y="${height - 30}" text-anchor="middle" font-size="10" fill="#b9bbbe">${svgEscape(dateKey)}</text>`);
    }
  }
  const labels = xLabels.join('\n');
  
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#36393f"/>
  <text x="${pad.left}" y="24" font-size="16" font-weight="700" fill="#ffffff">Libyan Dinar Strength – ${mainCurrency}/LYD (Green = Dinar Strengthens, Red = Weakens)</text>
  ${grid.join('\n')}
  <line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${pad.top + plotH}" stroke="#4e5058" stroke-width="1.5"/>
  <line x1="${pad.left}" y1="${pad.top + plotH}" x2="${width - pad.right}" y2="${pad.top + plotH}" stroke="#4e5058" stroke-width="1.5"/>
  ${candlesSvg.join('\n')}
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
