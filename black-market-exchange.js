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

const SOURCE_URL        = 'https://en.blackmarketlive.org/lyd/';   // legacy scrape (unused now, kept for reference)
const API_URL           = 'https://libyadollar.usdtoegp.com/api/api_blackmarket_all.php'; // primary — parallel rates by id
const DOLLAR2DAY_URL    = 'https://www.dollar2day.com/wp-json/dollar2day/v1/rates';        // fallback source
const SCRAPE_INTERVAL_MS = 1 * 60 * 60 * 1000; // 1 hour
const MAX_HISTORY        = 72;              // up to 72 stored rate CHANGES (history only grows when the rate moves)

// The 7 currencies we display, mapped to the libyadollar API's numeric id.
// USD uses id 1 (the Tripoli rate) and is shown simply as "USD".
// d2d = the currency key on the dollar2day fallback API.
const CURRENCY_META = {
  USD: { flag: '🇺🇸', name: 'US Dollar',       id: 1,  d2d: 'usd' },
  EUR: { flag: '🇪🇺', name: 'Euro',            id: 12, d2d: 'eur' },
  GBP: { flag: '🇬🇧', name: 'British Pound',   id: 13, d2d: 'gbp' },
  EGP: { flag: '🇪🇬', name: 'Egyptian Pound',  id: 11, d2d: 'egp' },
  TND: { flag: '🇹🇳', name: 'Tunisian Dinar',  id: 15, d2d: 'tnd' },
  TRY: { flag: '🇹🇷', name: 'Turkish Lira',    id: 16, d2d: 'try' },
  JOD: { flag: '🇯🇴', name: 'Jordanian Dinar', id: 14, d2d: null },
};
const CURRENCIES       = Object.keys(CURRENCY_META);
const MAJOR_CURRENCIES = ['USD', 'EUR', 'GBP'];   // auto-posts trigger only when one of these moves

// small rates (EGP 0.17, TRY 0.18) need 3 decimals to be meaningful
const fmtRate = (v) => (v == null ? null : (v >= 1 ? v.toFixed(2) : v.toFixed(3)));

// ---------------------------------------------------------------------------
// Slash commands (unchanged from original — no breaking changes)
// ---------------------------------------------------------------------------
const exchangeCommands = [
  new SlashCommandBuilder()
    .setName('exchange-set-channel')
    .setDescription('Set the channel for Libyan black market exchange updates')
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
// Auto-posts trigger only on major-currency moves — otherwise tiny TRY/DZD
// fluctuations would spam the channel several times a day. This key matches the
// old stored lastPostedKey format exactly, so deploys don't cause a false repost.
function majorKey(rates) {
  return MAJOR_CURRENCIES.map(c => `${c}:${rates[c] ?? 'na'}`).join('|');
}

// ---------------------------------------------------------------------------
// Scraper — simple HTTP fetch + cheerio, no browser required
// ---------------------------------------------------------------------------

/**
 * Fetches the exchange rate page and parses the USD, EUR, and GBP rates.
 * Returns { rates: { USD, EUR, GBP }, scrapedAt, sourceUrl, siteTimestamp }
 */
// ---------------------------------------------------------------------------
// Primary source: the libyadollar.usdtoegp.com app API. Returns an array of
// { id, p (price/parallel rate in LYD), d (daily change) } keyed by numeric id.
// This feed has no official rate — only the parallel/black-market price.
// ---------------------------------------------------------------------------
async function fetchLibyaDollar() {
  const res = await fetch(API_URL, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
        'AppleWebKit/537.36 (KHTML, like Gecko) ' +
        'Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching libyadollar API`);
  const json = await res.json();
  if (!Array.isArray(json)) throw new Error('libyadollar API did not return an array');

  // index the array by id for quick lookup
  const byId = {};
  for (const row of json) if (row && typeof row.id === 'number') byId[row.id] = row;

  const rates = {}, changes = {};
  for (const c of CURRENCIES) {
    const row = byId[CURRENCY_META[c].id];
    rates[c]   = (row && typeof row.p === 'number' && row.p > 0) ? row.p : null;
    changes[c] = (row && typeof row.d === 'number') ? row.d : null;
  }
  if (CURRENCIES.every(c => rates[c] == null)) throw new Error('libyadollar API returned no usable rates');

  console.log(`[Exchange] libyadollar rates: USD(Tripoli)=${rates.USD}, EUR=${rates.EUR}, GBP=${rates.GBP} (+${CURRENCIES.filter(c => rates[c] != null).length - 3} more)`);
  return {
    rates,
    changes,                 // source's own daily delta per currency
    official: {},            // this feed has no official rate
    scrapedAt:     new Date().toISOString(),
    sourceUrl:     'https://libyadollar.usdtoegp.com/',
    source:        'libyadollar',
    siteTimestamp: null,
  };
}

// Fallback source: dollar2day.com public API (used only if libyadollar is down).
async function fetchDollar2Day() {
  const res = await fetch(DOLLAR2DAY_URL, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
        'AppleWebKit/537.36 (KHTML, like Gecko) ' +
        'Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
      'Referer': 'https://www.dollar2day.com/',
      'Origin': 'https://www.dollar2day.com',
      'X-Requested-With': 'XMLHttpRequest',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching dollar2day API`);
  const json = await res.json();
  if (!json || !json.rates) throw new Error('dollar2day API returned no rates object');

  const rates = {}, changes = {};
  for (const c of CURRENCIES) {
    const key = CURRENCY_META[c].d2d;           // JOD isn't on dollar2day → null
    const r   = key && json.rates[key];
    rates[c]   = (r && typeof r.parallel === 'number' && r.parallel > 0) ? Math.round(r.parallel * 1000) / 1000 : null;
    changes[c] = null;
  }
  if (CURRENCIES.every(c => rates[c] == null)) throw new Error('dollar2day API returned no usable parallel rates');

  console.log(`[Exchange] (fallback) dollar2day rates: USD=${rates.USD}, EUR=${rates.EUR}, GBP=${rates.GBP}`);
  return {
    rates,
    changes,
    official:      {},
    scrapedAt:     new Date().toISOString(),
    sourceUrl:     'https://www.dollar2day.com/',
    source:        'dollar2day',
    siteTimestamp: json.last_update || null,
  };
}

// Try the primary (libyadollar) first; fall back to dollar2day if it's down.
async function getLatestRates() {
  try {
    return await fetchLibyaDollar();
  } catch (err) {
    console.warn(`[Exchange] libyadollar API failed (${err.message}) — falling back to dollar2day`);
    return await fetchDollar2Day();
  }
}

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

  const missing = MAJOR_CURRENCIES.filter(c => rates[c] === null);
  if (missing.length === MAJOR_CURRENCIES.length) {
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
  // Discord renders <t:UNIX:...> in each viewer's OWN local timezone automatically,
  // so everyone sees their own clock. :F = full date+time, :R = "2 hours ago".
  const unix       = Math.floor(new Date(latest.scrapedAt || Date.now()).getTime() / 1000);
  const pulledAt   = `<t:${unix}:F> (<t:${unix}:R>)`;
  const siteNote   = latest.siteTimestamp
    ? `\nSource last updated: ${latest.siteTimestamp}`
    : '';

  const embed = new EmbedBuilder()
    .setColor(0x1B8F5A)
    .setTitle('🇱🇾 Libyan Black Market Exchange Rate')
    .setDescription(
      (forced ? `Manual refresh — pulled ` : `Rates pulled `) +
      pulledAt + siteNote +
      `\nParallel-market prices in LYD` +
      `\n*Tap a currency button below for its chart.*`
    )
    .setTimestamp(new Date(latest.scrapedAt || Date.now()))
    .setFooter({
      text: `USD shown is the Tripoli rate • Checked hourly • Created & Designed by Captain`,
    });

  for (const currency of CURRENCIES) {
    const meta   = CURRENCY_META[currency];
    const value  = latest.rates[currency];
    let line;
    if (value == null) {
      line = 'Not available';
    } else {
      // Prefer the source's own daily change (d); fall back to computed trend from history
      const d = latest.changes && latest.changes[currency];
      let trendLabel;
      if (typeof d === 'number' && d !== 0) {
        // Coloured circle + arrow, matching the trend() labels below:
        // red = rate rose (dinar weaker), green = rate fell (dinar stronger).
        const marker = d > 0 ? '🔴 ↑' : '🟢 ↓';
        trendLabel = `${marker} ${d > 0 ? '+' : '−'}${fmtRate(Math.abs(d))} today`;
      } else if (typeof d === 'number' && d === 0) {
        trendLabel = '⚪ No change today';
      } else {
        trendLabel = trend(history.slice(0, -1), currency, value).label;
      }
      line = `**${fmtRate(value)} LYD**\n${trendLabel}`;
    }
    embed.addFields({ name: `${meta.flag} ${currency}`, value: line, inline: true });
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
  const meta  = CURRENCY_META[mainCurrency] || {};
  const cName = meta.name || mainCurrency;

  // ── build the series ────────────────────────────────────────────────────
  // Consecutive identical readings are collapsed, so every plotted point is a
  // real movement rather than the same number repeated hourly. The most recent
  // reading is always kept so the chart ends on "now".
  const readings = (history || [])
    .filter(e => e && e.rates && typeof e.rates[mainCurrency] === 'number' && e.scrapedAt)
    .map(e => ({ ts: new Date(e.scrapedAt), v: e.rates[mainCurrency] }))
    .filter(p => !isNaN(p.ts))
    .sort((a, b) => a.ts - b.ts);

  const deduped = [];
  for (const p of readings) {
    const prev = deduped[deduped.length - 1];
    if (!prev || prev.v !== p.v) deduped.push(p);
    else prev.ts = p.ts;            // same rate still holding — move its timestamp forward
  }

  // ── ROLLING WINDOW: only ever the newest MAX_POINTS ─────────────────────
  // Fixed count means the chart never compresses as history grows; a new point
  // enters on the right and the oldest drops off the left.
  const MAX_POINTS = 20;   // ~20 rate movements; at roughly one change a day that is about three weeks of history
  // If the rate has barely moved, deduping can leave one or two points and the
  // chart says nothing. Fall back to the raw readings so there's still a
  // timeline to read.
  const source = deduped.length >= 3 ? deduped : readings;
  const pts = source.slice(-MAX_POINTS);

  const W = 1000, H = 470;
  const bg = '#12141a', panel = '#171a21';

  if (pts.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
      <rect width="${W}" height="${H}" fill="${bg}" rx="14"/>
      <text x="${W/2}" y="${H/2}" text-anchor="middle" font-family="'DejaVu Sans',Arial,sans-serif"
        font-size="18" fill="#6b7280">No exchange-rate data yet</text></svg>`;
  }

  // Libyan convention: rate UP = dinar weaker = RED, rate DOWN = dinar stronger = GREEN
  const first = pts[0].v, last = pts[pts.length - 1].v;
  const change = last - first;
  const up = change > 0, flat = Math.abs(change) < 1e-9;
  const ACCENT = flat ? '#94a3b8' : (up ? '#ef4444' : '#22c55e');
  const ACCENT_SOFT = flat ? '#64748b' : (up ? '#f87171' : '#4ade80');

  const pad = { left: 74, right: 92, top: 96, bottom: 76 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  // ── y scale with nice round ticks ───────────────────────────────────────
  const vals = pts.map(p => p.v);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi - lo < 1e-9) { const b = Math.max(0.02, Math.abs(hi) * 0.01); lo -= b; hi += b; }
  const headroom = (hi - lo) * 0.22;
  lo = Math.max(0, lo - headroom); hi = hi + headroom;

  const niceStep = (range) => {
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

  const yFor = v => pad.top + (1 - (v - lo) / (hi - lo)) * plotH;
  // Evenly spaced by INDEX, not by timestamp — irregular scrape gaps would
  // otherwise bunch points together and leave dead space.
  const xFor = i => pts.length === 1
    ? pad.left + plotW / 2
    : pad.left + (i / (pts.length - 1)) * plotW;

  // Label precision has to follow the tick step, not a fixed 2 decimals. EGP and
  // TRY trade around 0.18–0.25, where two decimals would print the same number on
  // every gridline ("0.24, 0.24, 0.24…") and make the axis useless.
  const tickDecimals = step >= 1 ? 2
    : step >= 0.1 ? 2
    : step >= 0.01 ? 3
    : step >= 0.001 ? 4
    : 5;

  // ── grid + y labels ─────────────────────────────────────────────────────
  const grid = ticks.map(v => {
    const y = yFor(v).toFixed(1);
    return `<line x1="${pad.left}" y1="${y}" x2="${pad.left + plotW}" y2="${y}" stroke="#252932" stroke-width="1"/>
    <text x="${pad.left - 12}" y="${(+y + 4).toFixed(1)}" text-anchor="end" font-family="'DejaVu Sans',Arial,sans-serif"
      font-size="12" fill="#7c8798">${v.toFixed(tickDecimals)}</text>`;
  }).join('\n  ');

  // ── x labels: date + time, thinned so they never collide ────────────────
  // The axis adapts to what the data actually is. Rates usually move about once
  // a day, so across a multi-day window the DATE is the useful label and the
  // clock time is noise — we lead with the date and shrink the time. If the
  // window happens to cover only a few hours, we flip it round.
  const spanMs = pts.length > 1 ? (pts[pts.length - 1].ts - pts[0].ts) : 0;
  const dateLed = spanMs > 36 * 3600 * 1000;          // more than ~1.5 days
  const MIN_LABEL_PX = dateLed ? 58 : 74;
  const spacing = pts.length > 1 ? plotW / (pts.length - 1) : plotW;
  const every = Math.max(1, Math.ceil(MIN_LABEL_PX / spacing));
  const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const two = n => String(n).padStart(2, '0');
  const xLabels = [];
  let lastMonth = null;
  pts.forEach((p, i) => {
    const isLast = i === pts.length - 1;
    // always label the first and last point, then every Nth in between
    if (!(i === 0 || isLast || i % every === 0)) return;
    // don't let the penultimate label crowd the (always-shown) last one
    if (!isLast && i !== 0 && (pts.length - 1 - i) * spacing < MIN_LABEL_PX * 0.8) return;
    const x = xFor(i);
    const y = pad.top + plotH;
    const primary = dateLed ? `${p.ts.getDate()} ${MON[p.ts.getMonth()]}` : `${two(p.ts.getHours())}:${two(p.ts.getMinutes())}`;
    // secondary line: the clock time when date-led, the date when time-led —
    // and only when it changes, so it never repeats down the whole axis.
    let secondary = '';
    if (dateLed) {
      secondary = `${two(p.ts.getHours())}:${two(p.ts.getMinutes())}`;
    } else {
      const monthKey = `${p.ts.getDate()}-${p.ts.getMonth()}`;
      if (monthKey !== lastMonth) { secondary = `${p.ts.getDate()} ${MON[p.ts.getMonth()]}`; lastMonth = monthKey; }
    }
    xLabels.push(
      `<line x1="${x.toFixed(1)}" y1="${y}" x2="${x.toFixed(1)}" y2="${y + 5}" stroke="#3b4250" stroke-width="1"/>`,
      `<text x="${x.toFixed(1)}" y="${y + 21}" text-anchor="middle" font-family="'DejaVu Sans',Arial,sans-serif"
        font-size="11" font-weight="${isLast ? 700 : 600}" fill="${isLast ? '#e5e7eb' : '#8b95a6'}">${primary}</text>`,
      secondary
        ? `<text x="${x.toFixed(1)}" y="${y + 36}" text-anchor="middle" font-family="'DejaVu Sans',Arial,sans-serif"
            font-size="9.5" fill="#5b6474">${secondary}</text>`
        : ''
    );
  });

  // ── the line + area ─────────────────────────────────────────────────────
  const linePts = pts.map((p, i) => `${xFor(i).toFixed(1)},${yFor(p.v).toFixed(1)}`);
  const areaPath = `M ${xFor(0).toFixed(1)},${(pad.top + plotH).toFixed(1)} L ${linePts.join(' L ')} `
    + `L ${xFor(pts.length - 1).toFixed(1)},${(pad.top + plotH).toFixed(1)} Z`;

  // ── markers ─────────────────────────────────────────────────────────────
  const hiIdx = vals.indexOf(Math.max(...vals));
  const loIdx = vals.indexOf(Math.min(...vals));
  const dots = pts.map((p, i) => {
    const x = xFor(i), y = yFor(p.v);
    const isLast = i === pts.length - 1;
    if (isLast) return '';                       // drawn separately with a halo
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4" fill="${panel}" stroke="${ACCENT}" stroke-width="2"/>`;
  }).join('\n    ');

  const lastX = xFor(pts.length - 1), lastY = yFor(last);
  const endMarker = `
    <circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="11" fill="${ACCENT}" opacity="0.18"/>
    <circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="6.5" fill="${ACCENT}" stroke="#0b0d12" stroke-width="2"/>`;

  // dashed guide + price tag at the current rate
  const tagW = 78, tagH = 26;
  const tagX = Math.min(pad.left + plotW + 8, W - tagW - 8);
  const priceTag = `
    <line x1="${pad.left}" y1="${lastY.toFixed(1)}" x2="${(pad.left + plotW).toFixed(1)}" y2="${lastY.toFixed(1)}"
      stroke="${ACCENT}" stroke-width="1" stroke-dasharray="4 4" opacity="0.55"/>
    <rect x="${tagX}" y="${(lastY - tagH / 2).toFixed(1)}" width="${tagW}" height="${tagH}" rx="6" fill="${ACCENT}"/>
    <text x="${(tagX + tagW / 2).toFixed(1)}" y="${(lastY + 5).toFixed(1)}" text-anchor="middle"
      font-family="'DejaVu Sans',Arial,sans-serif" font-size="13" font-weight="700" fill="#0b0d12">${fmtRate(last)}</text>`;

  // high / low callouts, only when they aren't the current point
  const callout = (idx, label, colour) => {
    // Nothing useful to say when the series is flat, or when high and low land on
    // the same point — they'd just print on top of each other.
    if (pts.length < 3 || idx === pts.length - 1) return '';
    if (hiIdx === loIdx || Math.abs(vals[hiIdx] - vals[loIdx]) < 1e-9) return '';
    const x = xFor(idx), y = yFor(pts[idx].v);
    const above = idx === hiIdx;
    const ly = above ? y - 14 : y + 22;
    // Nudge the end labels inward so they don't run off the plot edges.
    const nearLeft = x < pad.left + 46, nearRight = x > pad.left + plotW - 46;
    const anchor = nearLeft ? 'start' : nearRight ? 'end' : 'middle';
    const lx = nearLeft ? pad.left + 6 : nearRight ? pad.left + plotW - 6 : x;
    return `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="${anchor}"
      font-family="'DejaVu Sans',Arial,sans-serif" font-size="10.5" font-weight="600" fill="${colour}">${label} ${fmtRate(pts[idx].v)}</text>`;
  };

  // ── header ──────────────────────────────────────────────────────────────
  const pct = first !== 0 ? (change / first) * 100 : 0;
  const arrow = flat ? '—' : (up ? '▲' : '▼');
  // A currency trading near 0.20 can move by 0.0008 — fmtRate's 3 decimals would
  // round that to "0.001" or even "0.000", so small deltas get extra precision.
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
    <polyline points="${linePts.join(' ')}" fill="none" stroke="url(#lineGrad)" stroke-width="3"
      stroke-linejoin="round" stroke-linecap="round"/>
    ${dots}
    ${endMarker}
  </g>
  ${callout(hiIdx, 'high', '#f87171')}
  ${callout(loIdx, 'low', '#4ade80')}
  ${priceTag}

  <line x1="${pad.left}" y1="${pad.top + plotH}" x2="${pad.left + plotW}" y2="${pad.top + plotH}" stroke="#3b4250" stroke-width="1"/>
  <line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${pad.top + plotH}" stroke="#3b4250" stroke-width="1"/>
  ${xLabels.join('\n  ')}

  <text x="${pad.left}" y="34" font-family="'DejaVu Sans',Arial,sans-serif" font-size="17" font-weight="700" fill="#f3f4f6">${svgEscape(cName)} / Libyan Dinar</text>
  <text x="${pad.left}" y="55" font-family="'DejaVu Sans',Arial,sans-serif" font-size="11.5" fill="#6b7280">Black market rate · last ${pts.length} update${pts.length === 1 ? '' : 's'}</text>
  <text x="${pad.left}" y="73" font-family="'DejaVu Sans',Arial,sans-serif" font-size="11" fill="#565f6e">${svgEscape(spanTxt)}</text>

  <text x="${W - pad.right + 60}" y="38" text-anchor="end" font-family="'DejaVu Sans',Arial,sans-serif" font-size="30" font-weight="700" fill="#f9fafb">${fmtRate(last)}</text>
  <text x="${W - pad.right + 60}" y="58" text-anchor="end" font-family="'DejaVu Sans',Arial,sans-serif" font-size="12" font-weight="600" fill="${ACCENT}">${svgEscape(deltaTxt)}</text>
  ${meaning ? `<text x="${W - pad.right + 60}" y="75" text-anchor="end" font-family="'DejaVu Sans',Arial,sans-serif" font-size="10.5" fill="#6b7280">${meaning}</text>` : ''}

  <text x="${pad.left}" y="${H - 14}" font-family="'DejaVu Sans',Arial,sans-serif" font-size="10" fill="#4b5563">Green = dinar stronger · Red = dinar weaker</text>
  <text x="${W - 20}" y="${H - 14}" text-anchor="end" font-family="'DejaVu Sans',Arial,sans-serif" font-size="10" fill="#4b5563">Created &amp; Designed by Captain</text>
</svg>`;
}

const FONT_CANDIDATES = [
  require('path').join(__dirname, 'fonts', 'DejaVuSans.ttf'),
  require('path').join(__dirname, 'DejaVuSans.ttf'),          // repo root (where it's committed)
];
const FONT_PATH = FONT_CANDIDATES.find(f => { try { return require('fs').existsSync(f); } catch { return false; } }) || FONT_CANDIDATES[0];

async function svgToPngBuffer(svgString) {
  // Lightweight SVG → PNG rasterizer (replaces the old headless-Chromium one,
  // which cost 150–300 MB per render). resvg needs a real font file to draw
  // text — and the runtime has no system fonts, so we ship one in the repo
  // (./fonts/DejaVuSans.ttf) and point resvg straight at it. This is why text
  // works regardless of whether the host installed any fonts.
  const { Resvg } = require('@resvg/resvg-js');
  const resvg = new Resvg(svgString, {
    background: '#1a1c22',
    font: {
      loadSystemFonts: false,           // don't depend on the OS having fonts
      fontFiles: [FONT_PATH],           // the bundled font travels with the code
      defaultFontFamily: 'DejaVu Sans', // the SVG asks for Segoe UI/Arial; map to this
    },
  });
  return resvg.render().asPng();
}

async function chartAttachment(exchangeData, currency = 'USD') {
  const svg       = buildChartSvg(exchangeData.history || [], currency);
  const pngBuffer = await svgToPngBuffer(svg);
  return new AttachmentBuilder(pngBuffer, { name: `libya-exchange-chart-${currency}.png` });
}

// one chart button per currency, rows of 5 (Discord's per-row limit)
function chartButtonRows(guildId) {
  const rows = [];
  let row = new ActionRowBuilder();
  CURRENCIES.forEach((c, i) => {
    if (i > 0 && i % 5 === 0) { rows.push(row); row = new ActionRowBuilder(); }
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`chart_${c.toLowerCase()}_${guildId}`)
        .setLabel(c)
        .setEmoji(CURRENCY_META[c].flag)
        .setStyle(ButtonStyle.Secondary));
  });
  rows.push(row);
  return rows;
}

// ---------------------------------------------------------------------------
// Post to Discord channel
// ---------------------------------------------------------------------------
async function postUpdate(client, guildId, exchangeData, latest, forced = false) {
  if (!exchangeData.channelId) return false;
  const channel = await client.channels.fetch(exchangeData.channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return false;

  const embed = buildRateEmbed(exchangeData, latest, forced);
  const payload = { embeds: [embed], components: chartButtonRows(guildId) };
  // attach the USD chart by default; buttons swap it to any other currency
  try {
    const att = await chartAttachment(exchangeData, 'USD');
    embed.setImage(`attachment://${att.name}`);
    payload.files = [att];
  } catch (err) {
    console.warn(`[Exchange] Chart render failed (posting without it): ${err.message}`);
  }
  await channel.send(payload);
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
    latest = await getLatestRates();
  } catch (err) {
    console.error(`[Exchange] Rate fetch failed: ${err.message}`);
    throw err;
  }

  const fullKey     = rateKey(latest.rates);
  const prevFullKey = exchangeData.lastRates ? rateKey(exchangeData.lastRates.rates) : null;
  const changedAny  = fullKey !== prevFullKey;                 // any of the 11 moved → record history
  const mKey        = majorKey(latest.rates);
  const changed     = mKey !== exchangeData.lastPostedKey;     // USD/EUR/GBP moved → auto-post

  exchangeData.lastRates = latest;
  exchangeData.history   = exchangeData.history || [];

  if (forcePost || changedAny) {
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
    if (posted) exchangeData.lastPostedKey = mKey;
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
    // MongoDB may not have loaded into db by the time clientReady fires.
    // Retry at 6s, 15s, and 30s — whichever attempt first finds the channelId
    // wins; the !timers.has() guard prevents double-scheduling on later retries.
    [6_000, 15_000, 30_000].forEach(delay => {
      setTimeout(() => {
        for (const guild of client.guilds.cache.values()) {
          const exchangeData = getExchangeData(db, guild.id);
          if (exchangeData.channelId && !timers.has(guild.id)) {
            console.log(`[Exchange] Updates enabled for guild ${guild.id}, channel ${exchangeData.channelId} (loaded after ${delay / 1000}s)`);
            scheduleGuild(guild.id);
            updateRates({ client, db, saveData, guildId: guild.id })
              .catch(err => console.error(`[Exchange] Startup check failed for guild ${guild.id}: ${err.message}`));
          }
        }
      }, delay);
    });
  });

  client.on('interactionCreate', async interaction => {
    // --- Chart button handler (all currencies; also revives old chart_usd_/eur_/gbp_ buttons) ---
    if (interaction.isButton() && /^chart_[a-z]{3}_/.test(interaction.customId)) {
      const cur = interaction.customId.split('_')[1].toUpperCase();
      if (!CURRENCIES.includes(cur)) {
        return interaction.reply({ content: 'Unknown currency.', flags: 64 }).catch(() => {});
      }
      const exchangeData = getExchangeData(db, interaction.guildId);
      if (!exchangeData.lastRates) {
        return interaction.reply({ content: 'No rate data saved yet.', flags: 64 }).catch(() => {});
      }
      try {
        await interaction.deferUpdate();
        const att   = await chartAttachment(exchangeData, cur);
        const embed = buildRateEmbed(exchangeData, exchangeData.lastRates, false)
          .setImage(`attachment://${att.name}`);
        await interaction.editReply({
          embeds: [embed],
          files: [att],
          attachments: [],   // drop the previous chart attachment
          components: chartButtonRows(interaction.guildId),
        });
      } catch (err) {
        console.error(`[Exchange] Chart button failed (${cur}): ${err.message}`);
        await interaction.followUp({ content: `❌ Couldn't render the ${cur} chart: ${err.message?.slice(0, 150)}`, flags: 64 }).catch(() => {});
      }
      return;
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
          content: `Exchange updates will post in ${channel} whenever the rate changes (checked every 5h). Fetching the latest rate now...`,
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
        const embed = buildRateEmbed(exchangeData, latest, true);
        const payload = { embeds: [embed], components: chartButtonRows(guild.id), flags: 64 };
        try {
          const att = await chartAttachment(exchangeData, 'USD');
          embed.setImage(`attachment://${att.name}`);
          payload.files = [att];
        } catch { /* post without chart if render fails */ }
        return safeReply(interaction, payload);
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
          const stored = CURRENCIES.filter(c => entry.rates && entry.rates[c] != null).length;
          msg += `\n${i + 1}. ${d.toLocaleString('en-GB')}: USD=${entry.rates.USD ?? 'N/A'}, EUR=${entry.rates.EUR ?? 'N/A'}, GBP=${entry.rates.GBP ?? 'N/A'} (${stored}/${CURRENCIES.length} currencies stored)`;
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
// Hub API: render the latest saved rate (embed + USD chart + currency buttons).
// The hub calls this so its Exchange button shows the last pulled rates instantly, no new fetch.
module.exports.getHubView = async function (db, guildId) {
  const exchangeData = getExchangeData(db, guildId);
  const latest = exchangeData.lastRates;
  if (!latest) return null;
  const embed = buildRateEmbed(exchangeData, latest, false);
  const payload = { embeds: [embed], components: chartButtonRows(guildId) };
  try {
    const att = await chartAttachment(exchangeData, 'USD');
    embed.setImage(`attachment://${att.name}`);
    payload.files = [att];
  } catch (e) { /* show without chart if render fails */ }
  return payload;
};

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
