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
const SCRAPE_INTERVAL_MS = 60 * 60 * 1000;
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
  const cleaned = text
    .replace(/\u00a0/g, ' ')
    .replace(/[£€$]/g, match => ` ${match} `)
    .replace(/\s+/g, ' ');

  const rates = {
    USD: null,
    EUR: null,
    GBP: null,
  };

  const compact = cleaned.toLowerCase();
  const sequencePatterns = [
    {
      order: ['USD', 'EUR', 'GBP'],
      re: /(?:usd|dollar|dolar|دولار)\D{0,40}(\d{1,2}(?:[.,]\d{1,4})?)\D{0,80}(?:eur|euro|يورو)\D{0,40}(\d{1,2}(?:[.,]\d{1,4})?)\D{0,80}(?:gbp|pound|sterling|باوند|جنيه|استرليني)\D{0,40}(\d{1,2}(?:[.,]\d{1,4})?)/i,
    },
    {
      order: ['USD', 'GBP', 'EUR'],
      re: /(?:usd|dollar|dolar|دولار)\D{0,40}(\d{1,2}(?:[.,]\d{1,4})?)\D{0,80}(?:gbp|pound|sterling|باوند|جنيه|استرليني)\D{0,40}(\d{1,2}(?:[.,]\d{1,4})?)\D{0,80}(?:eur|euro|يورو)\D{0,40}(\d{1,2}(?:[.,]\d{1,4})?)/i,
    },
  ];

  for (const pattern of sequencePatterns) {
    const match = compact.match(pattern.re);
    if (!match) continue;
    pattern.order.forEach((currency, idx) => {
      rates[currency] = num(match[idx + 1]);
    });
    break;
  }

  if (rates.USD === null) rates.USD = findRateNearKeyword(text, ['usd', 'dollar', 'dolar', '$', 'دولار']);
  if (rates.EUR === null) rates.EUR = findRateNearKeyword(text, ['eur', 'euro', '€', 'يورو']);
  if (rates.GBP === null) rates.GBP = findRateNearKeyword(text, ['gbp', 'pound', 'sterling', '£', 'باوند', 'جنيه', 'استرليني']);

  if (CURRENCIES.every(c => rates[c] === null)) return null;
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
    if (!rates) throw new Error('Could not find USD/EUR/GBP rates in the Facebook page text.');

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

function inverseTrend(history, currency, latestInverse) {
  const previousEntry = [...history].reverse().find(entry => 
    entry.rates && typeof entry.rates[currency] === 'number' && entry.rates[currency] > 0
  );
  if (!previousEntry) return { label: 'No previous data', delta: null };
  const previousInverse = 1 / previousEntry.rates[currency];
  const delta = Math.round((latestInverse - previousInverse) * 10000) / 10000;
  if (delta > 0) return { label: `Up +${delta.toFixed(4)}`, delta };
  if (delta < 0) return { label: `Down ${delta.toFixed(4)}`, delta };
  return { label: 'No change', delta: 0 };
}

function buildRateEmbed(exchangeData, latest, forced = false) {
  const history = exchangeData.history || [];
  const embed = new EmbedBuilder()
    .setColor(0x1B8F5A)
    .setTitle('Libyan Black Market Exchange Rate')
    .setURL(SOURCE_URL)
    .setDescription(forced ? 'Manual refresh from the configured Facebook source.' : 'Latest hourly update from the configured Facebook source.')
    .setTimestamp(new Date(latest.scrapedAt || Date.now()))
    .setFooter({ text: 'Source: Dollar Euro Pound Libya Black Market Exchange Rate | Showing how much foreign currency you get for 1 LYD' });

  for (const currency of CURRENCIES) {
    const value = latest.rates[currency];
    if (value === null || value === undefined || value <= 0) {
      embed.addFields({
        name: currency,
        value: 'Not found',
        inline: true,
      });
      continue;
    }

    const inverse = 1 / value;
    const displayInverse = Math.round(inverse * 10000) / 10000;
    const trendData = inverseTrend(history.slice(0, -1), currency, inverse);
    
    embed.addFields({
      name: `1 LYD → ${currency}`,
      value: `**${displayInverse.toFixed(4)} ${currency}**\n${trendData.label}`,
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
  const height = 430;
  const pad = { left: 62, right: 24, top: 34, bottom: 72 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const palette = { USD: '#16a34a', EUR: '#2563eb', GBP: '#dc2626' };
  const allValues = [];

  for (const row of rows) {
    for (const c of CURRENCIES) {
      if (typeof row.rates[c] === 'number') allValues.push(row.rates[c]);
    }
  }

  const min = allValues.length ? Math.floor((Math.min(...allValues) - 0.1) * 10) / 10 : 0;
  const max = allValues.length ? Math.ceil((Math.max(...allValues) + 0.1) * 10) / 10 : 1;
  const span = Math.max(0.1, max - min);
  const xFor = idx => pad.left + (rows.length <= 1 ? plotW / 2 : (idx / (rows.length - 1)) * plotW);
  const yFor = value => pad.top + (1 - ((value - min) / span)) * plotH;

  const grid = [];
  for (let i = 0; i <= 5; i++) {
    const y = pad.top + (i / 5) * plotH;
    const value = max - (i / 5) * span;
    grid.push(`<line x1="${pad.left}" y1="${y}" x2="${width - pad.right}" y2="${y}" stroke="#e5e7eb" stroke-width="1"/>`);
    grid.push(`<text x="${pad.left - 12}" y="${y + 4}" text-anchor="end" font-size="13" fill="#475569">${value.toFixed(2)}</text>`);
  }

  const paths = CURRENCIES.map(currency => {
    const points = rows
      .map((row, idx) => {
        const value = row.rates[currency];
        if (typeof value !== 'number') return null;
        return `${xFor(idx).toFixed(1)},${yFor(value).toFixed(1)}`;
      })
      .filter(Boolean);
    if (points.length < 2) return '';
    return `<polyline points="${points.join(' ')}" fill="none" stroke="${palette[currency]}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`;
  }).join('\n');

  const dots = CURRENCIES.map(currency => rows.map((row, idx) => {
    const value = row.rates[currency];
    if (typeof value !== 'number') return '';
    return `<circle cx="${xFor(idx).toFixed(1)}" cy="${yFor(value).toFixed(1)}" r="4" fill="${palette[currency]}"/>`;
  }).join('\n')).join('\n');

  const labels = rows.map((row, idx) => {
    if (idx !== 0 && idx !== rows.length - 1 && idx % Math.ceil(rows.length / 4) !== 0) return '';
    const date = new Date(row.scrapedAt || row.createdAt || Date.now());
    const label = `${date.getDate()}/${date.getMonth() + 1} ${String(date.getHours()).padStart(2, '0')}:00`;
    return `<text x="${xFor(idx).toFixed(1)}" y="${height - 32}" text-anchor="middle" font-size="12" fill="#475569">${svgEscape(label)}</text>`;
  }).join('\n');

  const legend = CURRENCIES.map((currency, idx) => {
    const x = pad.left + idx * 112;
    return `<rect x="${x}" y="${height - 58}" width="14" height="14" rx="3" fill="${palette[currency]}"/><text x="${x + 22}" y="${height - 46}" font-size="14" fill="#0f172a">${currency}</text>`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <text x="${pad.left}" y="24" font-size="20" font-weight="700" fill="#0f172a">Libyan Black Market Exchange Trend</text>
  <text x="${width - pad.right}" y="24" text-anchor="end" font-size="13" fill="#64748b">LYD per 1 currency unit</text>
  ${grid.join('\n')}
  <line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${pad.top + plotH}" stroke="#94a3b8" stroke-width="1.5"/>
  <line x1="${pad.left}" y1="${pad.top + plotH}" x2="${width - pad.right}" y2="${pad.top + plotH}" stroke="#94a3b8" stroke-width="1.5"/>
  ${paths}
  ${dots}
  ${labels}
  ${legend}
</svg>`;
}

function chartAttachment(exchangeData) {
  const svg = buildChartSvg(exchangeData.history || []);
  return new AttachmentBuilder(Buffer.from(svg, 'utf8'), { name: 'libya-exchange-chart.svg' });
}

async function postUpdate(client, guildId, exchangeData, latest, forced = false) {
  if (!exchangeData.channelId) return false;
  const channel = await client.channels.fetch(exchangeData.channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return false;

  const files = [];
  if ((exchangeData.history || []).length >= 2) files.push(chartAttachment(exchangeData));

  await channel.send({
    embeds: [buildRateEmbed(exchangeData, latest, forced)],
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
