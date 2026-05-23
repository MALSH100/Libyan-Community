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
} = require('discord.js');

const SOURCE_URL = 'https://www.facebook.com/p/Dollar-Euro-Pound-Libya-Black-Market-Exchange-Rate-100064752788893/';
const SCRAPE_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
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
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch (err) {
    throw new Error('Playwright is not installed. Add "playwright" to package.json dependencies.');
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage({
      viewport: { width: 1365, height: 900 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
      locale: 'en-GB',
    });

    await page.goto(SOURCE_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(5000);

    for (let i = 0; i < 4; i++) {
      await page.mouse.wheel(0, 900);
      await page.waitForTimeout(1000);
    }

    const text = await page.locator('body').innerText({ timeout: 15000 });
    const rates = parseRatesFromText(text);
    if (!rates) {
      console.error('Facebook page text (first 1000 chars):', text.slice(0, 1000));
      throw new Error('Could not find USD/EUR/GBP rates in the Facebook page text.');
    }

    return {
      rates,
      scrapedAt: new Date().toISOString(),
      sourceUrl: SOURCE_URL,
      sample: text.slice(0, 1200),
    };
  } finally {
    await browser.close().catch(() => {});
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

function buildChartSvg(history) {
  const rows = (history || []).filter(entry => entry.rates).slice(-CHART_POINTS);
  const width = 900;
  const height = 480; // increased for legend and callouts
  const pad = { left: 70, right: 40, top: 50, bottom: 90 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const palette = { USD: '#16a34a', EUR: '#2563eb', GBP: '#dc2626' };
  
  // Collect all values
  let allValues = [];
  for (const row of rows) {
    for (const c of CURRENCIES) {
      if (typeof row.rates[c] === 'number') allValues.push(row.rates[c]);
    }
  }
  if (allValues.length === 0) return `<svg width="${width}" height="${height}"></svg>`;

  let min = Math.min(...allValues);
  let max = Math.max(...allValues);
  const padRange = (max - min) * 0.15;
  min = Math.max(0, min - padRange);
  max = max + padRange;
  
  // Y-axis ticks
  const range = max - min;
  const tickCount = 5;
  let step = range / (tickCount - 1);
  const stepMagnitude = Math.pow(10, Math.floor(Math.log10(step)));
  const stepNormalized = step / stepMagnitude;
  let niceStep;
  if (stepNormalized <= 1.5) niceStep = stepMagnitude * 1;
  else if (stepNormalized <= 3) niceStep = stepMagnitude * 2;
  else if (stepNormalized <= 7) niceStep = stepMagnitude * 5;
  else niceStep = stepMagnitude * 10;
  let niceMin = Math.floor(min / niceStep) * niceStep;
  let niceMax = Math.ceil(max / niceStep) * niceStep;
  const niceRange = niceMax - niceMin;
  const steps = Math.round(niceRange / niceStep);
  
  const xFor = idx => pad.left + (rows.length <= 1 ? plotW / 2 : (idx / (rows.length - 1)) * plotW);
  const yFor = value => pad.top + (1 - ((value - niceMin) / niceRange)) * plotH;
  
  // Grid & Y-axis
  const grid = [];
  for (let i = 0; i <= steps; i++) {
    const value = niceMin + i * niceStep;
    const y = pad.top + (1 - ((value - niceMin) / niceRange)) * plotH;
    grid.push(`<line x1="${pad.left}" y1="${y}" x2="${width - pad.right}" y2="${y}" stroke="#4e5058" stroke-width="1"/>`);
    grid.push(`<text x="${pad.left - 10}" y="${y + 4}" text-anchor="end" font-size="12" fill="#b9bbbe">${value.toFixed(2)}</text>`);
  }
  
  // Lines
  const paths = CURRENCIES.map(currency => {
    const points = rows
      .map((row, idx) => {
        const value = row.rates[currency];
        if (typeof value !== 'number') return null;
        return `${xFor(idx).toFixed(1)},${yFor(value).toFixed(1)}`;
      })
      .filter(Boolean);
    if (points.length < 2) return '';
    return `<polyline points="${points.join(' ')}" fill="none" stroke="${palette[currency]}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`;
  }).join('\n');
  
  // Small circles for all points
  const dots = CURRENCIES.map(currency => rows.map((row, idx) => {
    const value = row.rates[currency];
    if (typeof value !== 'number') return '';
    const cx = xFor(idx).toFixed(1);
    const cy = yFor(value).toFixed(1);
    return `<circle cx="${cx}" cy="${cy}" r="3" fill="#36393f" stroke="${palette[currency]}" stroke-width="1.5"/>`;
  }).join('\n')).join('\n');
  
  // Callouts: only last 2 points per currency (latest and previous)
  const callouts = [];
  const lastPoints = {};
  for (const currency of CURRENCIES) {
    // Collect last 2 points
    const points = [];
    for (let idx = Math.max(0, rows.length - 2); idx < rows.length; idx++) {
      const row = rows[idx];
      const value = row.rates[currency];
      if (typeof value === 'number') {
        points.push({ idx, value, x: xFor(idx), y: yFor(value) });
      }
    }
    if (points.length === 0) continue;
    lastPoints[currency] = points[points.length-1].value;
    
    for (const p of points) {
const isLast = (p.idx === rows.length-1);
// For the previous point, use a larger offset to the left
const offsetX = isLast ? 35 : -75; // further apart to avoid overlap
      const yOffset = -28;                 // higher above the curve
      let labelX = p.x + offsetX;
      let labelY = p.y + yOffset;
      // Bounds checking – keep inside the canvas
      labelX = Math.min(Math.max(labelX, pad.left + 20), width - pad.right - 55);
      labelY = Math.min(Math.max(labelY, pad.top + 15), height - pad.bottom - 20);
      
      // Leader line: vertical segment then horizontal
      const midY = p.y + yOffset/2;   // halfway up
      callouts.push(`<line x1="${p.x.toFixed(1)}" y1="${p.y.toFixed(1)}" x2="${p.x.toFixed(1)}" y2="${midY.toFixed(1)}" stroke="${palette[currency]}" stroke-width="1" stroke-dasharray="2,2"/>`);
      callouts.push(`<line x1="${p.x.toFixed(1)}" y1="${midY.toFixed(1)}" x2="${labelX.toFixed(1)}" y2="${midY.toFixed(1)}" stroke="${palette[currency]}" stroke-width="1" stroke-dasharray="2,2"/>`);
      
      // Box around the value
      const boxW = 50;
      const boxH = 20;
      const boxX = (labelX > p.x) ? labelX : labelX - boxW;
      callouts.push(`<rect x="${boxX}" y="${labelY - 10}" width="${boxW}" height="${boxH}" rx="4" fill="#2f3136" stroke="${palette[currency]}" stroke-width="1"/>`);
      callouts.push(`<text x="${boxX + boxW/2}" y="${labelY + 3}" text-anchor="middle" fill="#ffffff" font-size="11" font-weight="bold">${p.value.toFixed(2)}</text>`);
    }
  }
  
  // X-axis labels (every 2nd point)
  const labels = rows.map((row, idx) => {
    if (idx !== 0 && idx !== rows.length - 1 && idx % 2 !== 0) return '';
    const date = new Date(row.scrapedAt || row.createdAt || Date.now());
    const label = `${date.getDate()}/${date.getMonth() + 1}\n${String(date.getHours()).padStart(2, '0')}:00`;
    return `<text x="${xFor(idx).toFixed(1)}" y="${height - 55}" text-anchor="middle" font-size="10" fill="#b9bbbe">${svgEscape(label)}</text>`;
  }).join('\n');
  
  // Horizontal legend below title
  const legendY = 72;
  const legendStartX = pad.left;
  const legendItems = CURRENCIES.map((currency, i) => {
    const x = legendStartX + i * 130;
    return `<rect x="${x}" y="${legendY}" width="12" height="12" rx="2" fill="${palette[currency]}"/>
            <text x="${x + 18}" y="${legendY + 10}" fill="#e3e5e8" font-size="13">${currency} ${lastPoints[currency] ? lastPoints[currency].toFixed(2) : '?'}</text>`;
  }).join('');
  
  // Title and subtitle
  const latestText = CURRENCIES.map(c => `${c}: ${lastPoints[c] ? lastPoints[c].toFixed(2) : '?'} LYD`).join('  •  ');
  
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#36393f"/>
  <text x="${pad.left}" y="24" font-size="16" font-weight="700" fill="#ffffff">Libyan Black Market Exchange Trend (LYD per 1 unit)</text>
  <text x="${pad.left}" y="46" font-size="11" fill="#b9bbbe">${svgEscape(latestText)}</text>
  ${legendItems}
  ${grid.join('\n')}
  <line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${pad.top + plotH}" stroke="#4e5058" stroke-width="1.5"/>
  <line x1="${pad.left}" y1="${pad.top + plotH}" x2="${width - pad.right}" y2="${pad.top + plotH}" stroke="#4e5058" stroke-width="1.5"/>
  ${paths}
  ${dots}
  ${callouts.join('\n')}
  ${labels}
</svg>`;
}

async function chartAttachment(exchangeData) {
  const svg = buildChartSvg(exchangeData.history || []);
  const pngBuffer = await svgToPngBuffer(svg);
  return new AttachmentBuilder(pngBuffer, { name: 'libya-exchange-chart.png' });
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
  exchangeData.history.push(latest);
  exchangeData.history = exchangeData.history.slice(-MAX_HISTORY);

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
        return safeReply(interaction, {
          content: 'Recent Libyan black market exchange trend:',
          files: [chartAttachment(exchangeData)],
          flags: 64,
        });
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
