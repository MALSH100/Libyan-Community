// ═══════════════════════════════════════════════════════════════════════════════
// LIBYA VIDEOS — drip-fed video feed (v4)
//
// Two separate jobs, so the channel never gets a rush of videos:
//
//   1. SEARCH (rare, budgeted): a few times a day the bot searches for fresh videos
//      about a topic (default ليبيا, past 24h) and puts the good ones in a QUEUE that is
//      saved in MongoDB. Nothing is posted at this point.
//   2. DRIP (frequent, gentle): every minute the bot checks whether it's time to post
//      ONE video from the queue. Gaps are 20–90 min (random ±20%) and stretch or shrink
//      so the queue drains over roughly 12 hours; videos only go out during active hours
//      (08:00–23:59 Libya time), and consecutive posts come from different platforms
//      where possible. Videos still queued after 36 h are dropped as stale.
//
// Search budget (SerpApi free plan = 250 searches/month): the bot asks SerpApi's free
// Account API how many searches are left and when the plan renews, keeps 10 in reserve for
// /videos-feed test and fetch, and spreads the rest evenly over the days left. At the start of
// a month that is about one search every 3 hours; if some are spent or skipped the pace
// adjusts itself. If the account lookup fails it falls back to counting its own searches.
// It also pauses searching while 40+ videos are already waiting (no point buying more).
//
// Search engine: SerpApi's google_short_videos, i.e. Google's "Short videos" tab (udm=39), which
// reports each clip's length. Clips longer than 3 minutes are dropped when the length is known.
//
// Each search targets ONE platform (YouTube → TikTok → Facebook → Instagram → …), so a platform
// with lots of results can't crowd out the others.
//
// Only four sources are kept, and only SHORT videos: YouTube Shorts, TikTok videos, Facebook
// reels and Instagram reels. Regular/long videos, live streams and news broadcasts are
// skipped (set VIDEOS_SHORTS_ONLY=0 to allow them again). Each link is rewritten so Discord
// can embed it:
//   YouTube    → https://www.youtube.com/watch?v=ID                (Discord's own player)
//   TikTok     → https://www.tiktok.com/@user/video/ID             (Discord's own embed)
//                or a fixer host if TIKTOK_EMBED_HOST is set (e.g. tnktok.com)
//   Facebook   → https://facebed.com/reel/ID                        (facebed embed fixer)
//   Instagram  → https://c.instagramfix.com/reel/CODE/              (instagramfix "media only")
// Videos with the same or near-identical TITLE are queued only once, even when they come
// from different accounts or platforms (Arabic spelling variants, hashtags and punctuation
// are ignored when comparing).
//
// Data source (set ONE of these in Railway → Variables):
//   SERPAPI_KEY       Google Videos results via SerpApi — covers all four platforms.
//   YOUTUBE_API_KEY   YouTube Data API v3 — free quota, YouTube videos only (one search per
//                     hour by default).
// If both are set SerpApi wins; force the other with VIDEO_PROVIDER=youtube.
//
// Optional variables (all have sensible defaults):
//   SERPAPI_MONTHLY_LIMIT  plan size used only if the account lookup fails (default 250)
//   SERPAPI_RESERVE        searches kept back for manual use (default 10)
//   VIDEOS_INTERVAL_MIN    force a fixed minutes-between-searches instead of budget pacing
//   VIDEOS_MIN_GAP_MIN / VIDEOS_MAX_GAP_MIN   posting gap limits, default 20 / 90
//   VIDEOS_DRAIN_HOURS     aim to empty the queue in about this long (default 12)
//   VIDEOS_ACTIVE_HOURS    hours videos may be posted, default 8-23 ("off" = any time)
//   VIDEOS_TZ              time zone for those hours (default Africa/Tripoli)
//   VIDEOS_QUEUE_TTL_HOURS drop queued videos older than this (default 36)
//   SERPAPI_ENGINE         google_short_videos (default) or google_videos (general Videos tab)
//   VIDEOS_MAX_SECONDS     longest clip counted as "short" when its length is known (default 180)
//   VIDEOS_SHORTS_ONLY     set to 0 to also allow long videos (YouTube watch links, Facebook
//                          /videos and /watch links, Instagram IGTV). Default: shorts only.
//   VIDEOS_WINDOW          h = past hour, d = past 24h (default), w = past week
//   VIDEOS_SITE_FILTER     set to 0 to stop adding site: filters to the SerpApi query
//   VIDEOS_ROTATE          set to 0 to search all four platforms in one query instead of one
//                          platform per search, in turn (default)
//   VIDEOS_GL / VIDEOS_HL  Google country / language for SerpApi, default ly / ar
//                          (set either to "off" to leave it out)
//   FACEBOOK_EMBED_HOST    default facebed.com
//   INSTAGRAM_EMBED_HOST   default c.instagramfix.com
//   TIKTOK_EMBED_HOST      default empty = TikTok's own link
//
// Per-guild settings, the queue and the already-posted lists live in db[guildId].__videos
// and persist through the bot's normal MongoDB save, so redeploys lose nothing.
// Everything is controlled with ONE slash command, /videos-feed (a single command slot).
// ═══════════════════════════════════════════════════════════════════════════════

const {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const crypto = require('crypto');

const KEY = '__videos';
const SCHEMA = 5;                 // 2 = plain links · 3 = Arabic + title de-dupe · 4 = queue + drip · 5 = shorts only
const DEFAULT_QUERY = 'ليبيا';
const WINDOW = ['h', 'd', 'w'].includes(process.env.VIDEOS_WINDOW) ? process.env.VIDEOS_WINDOW : 'd';
const WINDOW_MS = { h: 3600e3, d: 86400e3, w: 604800e3 }[WINDOW];
const WINDOW_LABEL = { h: 'past hour', d: 'past 24h', w: 'past week' }[WINDOW];
const SEEN_CAP = 800;             // remembered video IDs per guild (queued + posted)
const TITLES_CAP = 300;           // remembered titles per guild
const TITLE_SIMILARITY = 0.7;     // 0–1: how alike two titles must be to count as the same video
const FETCH_TIMEOUT_MS = 15000;
const POST_GAP_MS = 1500;         // pause between preview posts from /videos-feed test
const HEARTBEAT_MS = 60 * 1000;   // how often the drip checks whether it's time to act
const FIRST_BEAT_DELAY_MS = 90 * 1000;   // let MongoDB finish loading before the first check
const MANUAL_COOLDOWN_MS = 60 * 1000;    // /videos-feed fetch and test each spend one search
const EMBED_COLOR = 0xe70013;
const SITE_FILTER = process.env.VIDEOS_SITE_FILTER !== '0';
const SHORTS_ONLY = process.env.VIDEOS_SHORTS_ONLY !== '0';
const ROTATE = process.env.VIDEOS_ROTATE !== '0';
const PLATFORM_SITES = ['youtube.com', 'tiktok.com', 'facebook.com', 'instagram.com'];
const SITE_QUERY = '(site:youtube.com OR site:tiktok.com OR site:facebook.com OR site:instagram.com)';

const intEnv = (name, def) => {
  const n = parseInt(process.env[name], 10);
  return n > 0 ? n : def;
};
const geoParam = (v, fallback) => {
  const x = String(v == null ? fallback : v).trim().toLowerCase();
  return x && x !== 'off' ? x : null;
};
const GL = geoParam(process.env.VIDEOS_GL, 'ly');
const HL = geoParam(process.env.VIDEOS_HL, 'ar');
const ENGINE = process.env.SERPAPI_ENGINE === 'google_videos' ? 'google_videos' : 'google_short_videos';
const MAX_SHORT_SECONDS = intEnv('VIDEOS_MAX_SECONDS', 180);

// Drip settings
const MIN_GAP_MS = intEnv('VIDEOS_MIN_GAP_MIN', 20) * 60e3;
const MAX_GAP_MS = Math.max(MIN_GAP_MS, intEnv('VIDEOS_MAX_GAP_MIN', 90) * 60e3);
const DRAIN_MS = intEnv('VIDEOS_DRAIN_HOURS', 12) * 3600e3;
const QUEUE_TTL_MS = intEnv('VIDEOS_QUEUE_TTL_HOURS', 36) * 3600e3;
const QUEUE_CAP = 120;            // hard limit on stored videos
const QUEUE_PAUSE_AT = 40;        // don't search while this many are already waiting

// Search budget settings
const PLAN_LIMIT = intEnv('SERPAPI_MONTHLY_LIMIT', 250);
const RESERVE = Number(process.env.SERPAPI_RESERVE) >= 0 && process.env.SERPAPI_RESERVE !== undefined && process.env.SERPAPI_RESERVE !== ''
  ? Number(process.env.SERPAPI_RESERVE) : 10;
const MIN_SEARCH_GAP_MS = 30 * 60e3;     // never search more often than this
const FIXED_INTERVAL_MS = intEnv('VIDEOS_INTERVAL_MIN', 0) * 60e3;   // 0 = pace by budget

// Active hours (when posting is allowed)
const TZ = process.env.VIDEOS_TZ || 'Africa/Tripoli';
const ACTIVE = (() => {
  const raw = String(process.env.VIDEOS_ACTIVE_HOURS || '8-23').trim().toLowerCase();
  if (raw === 'off' || raw === 'always') return null;
  const m = raw.match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 23) return [8, 23];
  return [Number(m[1]), Number(m[2])];
})();

const cleanHost = (h, fallback) => {
  const v = String(h || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
  return /^[a-z0-9.-]+$/.test(v) ? v : fallback;
};
const FACEBOOK_HOST = cleanHost(process.env.FACEBOOK_EMBED_HOST, 'facebed.com');
const INSTAGRAM_HOST = cleanHost(process.env.INSTAGRAM_EMBED_HOST, 'c.instagramfix.com');
const TIKTOK_HOST = cleanHost(process.env.TIKTOK_EMBED_HOST, '');   // '' = TikTok's own link

let client = null;
let db = null;
let saveData = () => {};
let provider = null;

// ─── Small helpers ───────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

function clip(s, n) {
  s = String(s || '').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => (Number(n) < 0x110000 ? String.fromCodePoint(Number(n)) : ''))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

// Used for de-duplication IDs. (Kept identical to v1 so videos posted before the
// upgrades are still recognised.)
function canonical(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid$|igshid$|gclid$|si$|feature$)/i.test(k)) u.searchParams.delete(k);
    }
    u.hostname = u.hostname.replace(/^(www|m)\./, '');
    return u.toString().replace(/\/$/, '');
  } catch {
    return String(url || '');
  }
}

function videoId(url) {
  return crypto.createHash('sha1').update(canonical(url)).digest('base64url').slice(0, 12);
}

const isHttp = u => typeof u === 'string' && /^https?:\/\//i.test(u);

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'unknown'; }
}

function fmtDur(ms) {
  const mins = Math.max(1, Math.round(ms / 60000));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${String(m).padStart(2, '0')}m` : `${h}h`;
}

const unix = ms => Math.floor(ms / 1000);

// "0:47" → 47, "1:02:03" → 3723, anything else → NaN
function parseDuration(s) {
  const m = String(s || '').trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
  if (!m) return NaN;
  return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

// ─── Active hours ────────────────────────────────────────────────────────────

function localHour() {
  try {
    return Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: TZ })
      .format(new Date(Date.now())));
  } catch {
    return new Date(Date.now()).getUTCHours();
  }
}

function isActiveNow() {
  if (!ACTIVE) return true;
  const h = localHour();
  const [a, b] = ACTIVE;
  return a <= b ? (h >= a && h <= b) : (h >= a || h <= b);
}

const activeLabel = () => (ACTIVE ? `${String(ACTIVE[0]).padStart(2, '0')}:00–${String(ACTIVE[1]).padStart(2, '0')}:59 ${TZ}` : 'any time');

// ─── Title de-duplication ────────────────────────────────────────────────────

// Reduces a title to a comparable form: lower-case, no links/#hashtags/@mentions,
// no Arabic diacritics or tatweel, alef/ya/ta-marbuta variants unified, no punctuation or emoji.
function normTitle(t) {
  return String(t || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[#@]\S+/g, ' ')
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const tokenSet = norm => new Set(String(norm).split(' ').filter(w => w.length > 1));

function jaccard(a, b) {
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter || 1);
}

// Titles with fewer than 3 real words ("فيديو", "ليبيا اليوم") are too generic to compare.
const MIN_TITLE_TOKENS = 3;

// ─── Link curation: keep only YouTube / TikTok / Facebook / Instagram VIDEOS ─

// Turns any result URL into:
//   source – 'YouTube' | 'TikTok' | 'Facebook' | 'Instagram'
//   key    – the clean original-platform link (de-dupe key, Watch button)
//   url    – the link we actually post, rewritten so Discord gives a playable embed
// Returns null for anything else (other sites, channel pages, profiles, photo posts…).
function curateUrl(raw, opts = {}) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;

  const host = u.hostname.toLowerCase().replace(/^(www|m|mobile|web|mbasic)\./, '');
  const path = u.pathname.replace(/\/+$/, '');

  // YouTube: Shorts (or any video when shorts-only is off) → the standard watch link.
  // opts.short = the search itself guarantees a short clip (Short Videos tab / YouTube API search);
  // opts.seconds = the clip length when the search reports it.
  if (host === 'youtube.com' || host === 'youtu.be') {
    let id = null;
    let isShortUrl = false;
    if (host === 'youtu.be') id = path.split('/')[1];
    else if (path === '/watch') id = u.searchParams.get('v');
    else {
      const m = path.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})(?:\/|$)/);
      if (m) { id = m[1]; isShortUrl = path.startsWith('/shorts/'); }
    }
    if (!id || !/^[\w-]{11}$/.test(id)) return null;
    if (SHORTS_ONLY && !isShortUrl && !opts.short) return null;   // regular videos and live streams are skipped
    const link = `https://www.youtube.com/watch?v=${id}`;
    return { source: 'YouTube', key: link, url: link };
  }

  // TikTok: only real video pages (@user/video/ID). Profiles, tags and slideshows are skipped.
  if (host === 'tiktok.com') {
    const m = path.match(/^\/(@[^/]+)\/video\/(\d+)$/);
    if (!m) return null;
    const tail = `/${m[1]}/video/${m[2]}`;
    return {
      source: 'TikTok',
      key: `https://www.tiktok.com${tail}`,
      url: `https://${TIKTOK_HOST || 'www.tiktok.com'}${tail}`,
    };
  }

  // Facebook: reels (/reel/ID, share/r links). Other links (/<page>/videos/<id>, /watch?v=, share/v,
  // and /<page>/posts/... holding a video) are only accepted when they come from the Short Videos
  // search (Google vouches that they are short clips; clips with a reported length over the limit
  // were already dropped), or when shorts-only is off. General Videos tab results never qualify.
  if (host === 'facebook.com') {
    let tail = null;
    if (/^\/reel\/\d+$/.test(path)) tail = path;
    else if (/^\/share\/r\/[\w-]+$/.test(path)) tail = path;
    else if (!SHORTS_ONLY || opts.short) {
      const vm = path.match(/^(\/[^/]+\/videos)\/(?:[^/]+\/)?(\d+)$/);
      if (/^\/share\/v\/[\w-]+$/.test(path)) tail = path;
      else if (vm) tail = `${vm[1]}/${vm[2]}`;       // drop the long title slug, the ID is enough
      else if (path === '/watch' && /^\d+$/.test(u.searchParams.get('v') || '')) tail = `/watch/?v=${u.searchParams.get('v')}`;
      // Posts that hold a short video (the Short Videos tab lists plenty of these). Only with a
      // reported clip length, as proof there is a video in it; facebed reads the video out of the post.
      else if ((!SHORTS_ONLY || Number.isFinite(opts.seconds)) && /^\/[^/]+\/posts\/.+/.test(path)) tail = path;
    }
    if (!tail) return null;
    return {
      source: 'Facebook',
      key: `https://www.facebook.com${tail}`,
      url: `https://${FACEBOOK_HOST}${tail}`,
    };
  }

  // Instagram: reels only (plain /p/ posts may be photos, IGTV is long). Media-only embed.
  if (host === 'instagram.com') {
    const m = path.match(SHORTS_ONLY
      ? /^(?:\/[^/]+)?\/(reel|reels)\/([\w-]+)$/
      : /^(?:\/[^/]+)?\/(reel|reels|tv)\/([\w-]+)$/);
    if (!m) return null;
    const kind = m[1] === 'reels' ? 'reel' : m[1];
    return {
      source: 'Instagram',
      key: `https://www.instagram.com/${kind}/${m[2]}/`,
      url: `https://${INSTAGRAM_HOST}/${kind}/${m[2]}/`,
    };
  }

  return null;
}

const FOUR_HOSTS = /^(youtube\.com|youtu\.be|tiktok\.com|facebook\.com|instagram\.com)$/;

// Filters a provider's raw results down to the four sources and rewrites their links.
// droppedItems keeps a few examples with the reason, for /videos-feed test.
function curate(rawVideos) {
  const kept = [];
  const dropped = new Map();      // host → how many were thrown away
  const droppedItems = [];
  const keys = new Set();
  const drop = (v, label, reason) => {
    dropped.set(label, (dropped.get(label) || 0) + 1);
    if (droppedItems.length < 12) droppedItems.push({ url: v.url, duration: v.duration || '', short: !!v.short, reason });
  };
  for (const v of rawVideos) {
    const seconds = parseDuration(v.duration);
    if (SHORTS_ONLY && Number.isFinite(seconds) && seconds > MAX_SHORT_SECONDS) {
      drop(v, 'too long', 'too long');
      continue;
    }
    const c = curateUrl(v.url, { short: v.short, seconds });
    if (!c) {
      const h = hostOf(v.url);
      drop(v, h, FOUR_HOSTS.test(h.replace(/^(m|mobile|web|mbasic)\./, '')) ? 'not a short-video link' : 'other site');
      continue;
    }
    if (keys.has(c.key)) continue;
    keys.add(c.key);
    kept.push({ ...v, ...c, raw: v.url, id: videoId(c.key) });
  }
  return { kept, dropped, droppedItems };
}

// ─── Providers ───────────────────────────────────────────────────────────────

function pickProvider() {
  const want = (process.env.VIDEO_PROVIDER || '').toLowerCase();
  const has = { serpapi: !!process.env.SERPAPI_KEY, youtube: !!process.env.YOUTUBE_API_KEY };
  if (has[want]) return want;
  if (has.serpapi) return 'serpapi';
  if (has.youtube) return 'youtube';
  return null;
}

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${clip(body, 200)}`);
  }
  return res.json();
}

// Which sites this search is limited to. By default each search targets ONE platform and they
// take turns, so a platform with lots of results (Facebook) can't crowd out the others.
function siteQuery(c, override) {
  if (override) return `site:${override}`;
  if (!SITE_FILTER) return '';
  if (!ROTATE) return SITE_QUERY;
  return `site:${PLATFORM_SITES[(c.rot || 0) % PLATFORM_SITES.length]}`;
}

// Google Videos via SerpApi. tbs=qdr:d is the "past 24 hours" filter. The site: filter asks
// Google for the four platforms only, so the ~10 results per search aren't wasted on sites
// that get dropped anyway; gl/hl bias the results towards Libya and Arabic.
async function fetchSerpApi(query, site) {
  const params = new URLSearchParams({
    engine: ENGINE,
    q: site ? `${query} ${site}` : query,
    tbs: `qdr:${WINDOW}`,
    api_key: process.env.SERPAPI_KEY,
  });
  if (GL) params.set('gl', GL);
  if (HL) params.set('hl', HL);
  const data = await getJson(`https://serpapi.com/search.json?${params}`);
  if (data.error) {
    // SerpApi answers a search that found nothing with an "error" message. That is an empty
    // result (it happens often for quiet platforms), not a failure.
    if (/hasn't returned any results|no results/i.test(String(data.error))) {
      console.log(`[videos] SerpApi: no results for "${params.get('q')}"`);
      return [];
    }
    throw new Error(`SerpApi: ${data.error}`);
  }

  // Short Videos tab results are short clips by definition; general video_results are not.
  const rows = [];
  for (const [arr, short] of [[data.short_video_results, true], [data.short_videos, true], [data.video_results, false]]) {
    if (Array.isArray(arr)) for (const r of arr) rows.push({ r, short });
  }
  if (!rows.length) {
    // Helps spot a changed response shape: shows what the API actually returned.
    console.log(`[videos] SerpApi (${ENGINE}) returned no video rows. Response keys:`, Object.keys(data).join(', '));
  }

  return rows
    .map(({ r, short }) => {
      const url = r.link || r.video_link || r.url;
      if (!isHttp(url)) return null;
      return {
        url,
        title: decodeEntities(r.title) || 'Video',
        snippet: decodeEntities(r.snippet || ''),
        thumbnail: isHttp(r.thumbnail) ? r.thumbnail : null,   // data: URIs can't be used in embeds
        channel: typeof r.channel === 'string' ? r.channel : (typeof r.profile_name === 'string' ? r.profile_name : ''),
        date: r.date || '',
        duration: r.duration || '',
        short,
      };
    })
    .filter(Boolean);
}

// YouTube Data API. Short (under 4 min) videos, newest first, inside the time window.
// search.list costs 100 quota units; the free daily quota is 10,000.
async function fetchYouTube(query) {
  const params = new URLSearchParams({
    part: 'snippet',
    type: 'video',
    order: 'date',
    videoDuration: 'short',
    maxResults: '25',
    q: query,
    publishedAfter: new Date(Date.now() - WINDOW_MS).toISOString(),
    key: process.env.YOUTUBE_API_KEY,
  });
  if (HL) params.set('relevanceLanguage', HL);
  const data = await getJson(`https://www.googleapis.com/youtube/v3/search?${params}`);
  if (data.error) throw new Error(`YouTube: ${data.error.message || 'unknown error'}`);

  return (data.items || [])
    .filter(i => i.id && i.id.videoId)
    .map(i => {
      const s = i.snippet || {};
      const th = s.thumbnails || {};
      const pic = (th.high || th.medium || th.default || {}).url;
      return {
        url: `https://www.youtube.com/watch?v=${i.id.videoId}`,
        title: decodeEntities(s.title) || 'Video',
        snippet: decodeEntities(s.description || ''),
        thumbnail: isHttp(pic) ? pic : null,
        channel: decodeEntities(s.channelTitle || ''),
        date: '',
        duration: '',
        short: true,       // search was limited to videos under 4 minutes
      };
    });
}

function fetchVideos(query, site) {
  return provider === 'youtube' ? fetchYouTube(query) : fetchSerpApi(query, site);
}

// ─── Search budget ───────────────────────────────────────────────────────────

// SerpApi's Account API is free and does not use up searches. It tells us how many
// searches are left and (when present) the real renewal date of the plan.
let acct = { at: 0, data: null };

async function getAccount() {
  if (provider !== 'serpapi') return null;
  if (Date.now() - acct.at < 30 * 60e3) return acct.data;
  try {
    const data = await getJson(`https://serpapi.com/account.json?${new URLSearchParams({ api_key: process.env.SERPAPI_KEY })}`);
    acct = { at: Date.now(), data: data && typeof data === 'object' && !data.error ? data : null };
  } catch (e) {
    console.warn('[videos] SerpApi account lookup failed (using own count instead):', e.message);
    acct = { at: Date.now(), data: null };
  }
  return acct.data;
}

const monthKey = () => new Date(Date.now()).toISOString().slice(0, 7);

function daysLeftInMonth() {
  const d = new Date(Date.now());
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return (end - d.getTime()) / 86400e3;
}

// Fallback counter: successful searches this calendar month, summed over all guilds.
function usedLocal() {
  const mk = monthKey();
  let n = 0;
  for (const g of Object.keys(db)) {
    const u = db[g] && db[g][KEY] && db[g][KEY].usage;
    if (u && u.month === mk) n += u.count || 0;
  }
  return n;
}

function charge(c) {
  const mk = monthKey();
  if (!c.usage || c.usage.month !== mk) c.usage = { month: mk, count: 0 };
  c.usage.count++;
  acct = { at: 0, data: null };      // re-read the real number next time
}

// How often may we search? Spendable searches (left minus the reserve) are spread evenly
// over the days remaining, so unused or extra searches automatically change the pace.
async function searchPlan(activeGuilds = 1) {
  if (provider !== 'serpapi') {
    return { ok: true, left: null, daysLeft: null, renews: null, basis: 'fixed', intervalMs: FIXED_INTERVAL_MS || 3600e3 };
  }
  const info = await getAccount();
  let left;
  let daysLeft;
  let renews = null;
  let basis;
  if (info && Number.isFinite(Number(info.plan_searches_left))) {
    left = Number(info.plan_searches_left);
    const renew = info.plan_renewal_date ? Date.parse(`${String(info.plan_renewal_date).slice(0, 10)}T00:00:00Z`) : NaN;
    if (Number.isFinite(renew) && renew > Date.now()) {
      daysLeft = (renew - Date.now()) / 86400e3;
      renews = String(info.plan_renewal_date).slice(0, 10);
      basis = 'your SerpApi account';
    } else {
      daysLeft = daysLeftInMonth();
      basis = 'your SerpApi account, calendar month';
    }
  } else {
    left = Math.max(0, PLAN_LIMIT - usedLocal());
    daysLeft = daysLeftInMonth();
    basis = 'own count (account lookup unavailable)';
  }
  const spendable = left - RESERVE;
  if (spendable <= 0) return { ok: false, left, daysLeft, renews, basis, intervalMs: 0 };
  const perDay = spendable / Math.max(daysLeft, 0.25) / Math.max(activeGuilds, 1);
  const paced = Math.max(MIN_SEARCH_GAP_MS, 86400e3 / perDay);
  return { ok: true, left, daysLeft, renews, basis, intervalMs: FIXED_INTERVAL_MS || paced };
}

// ─── Per-guild settings ──────────────────────────────────────────────────────

// Used once on upgrade to shorts-only: removes already-queued videos that the new rules reject
// (long Facebook videos, IGTV). Queued YouTube items can't be re-checked and are kept.
function stillWanted(item) {
  if (!SHORTS_ONLY || !item || !item.key) return true;
  if (item.source === 'Facebook') return /\/(reel\/\d+|share\/r\/)/.test(item.key);
  if (item.source === 'Instagram') return !/\/tv\//.test(item.key);
  return true;
}

function upgrade(c) {
  const v = c.ver || 0;
  if (v < 2) c.mode = 'link';                                   // v2: plain links become the default
  if (v < 3 && (!c.query || c.query.toLowerCase() === 'libya')) c.query = DEFAULT_QUERY;   // v3: Arabic search
  if (!Array.isArray(c.seen)) c.seen = [];
  if (!Array.isArray(c.titles)) c.titles = [];
  if (!Array.isArray(c.queue)) c.queue = [];                    // v4: waiting videos
  if (!c.usage || typeof c.usage !== 'object') c.usage = { month: '', count: 0 };
  if (v < 5) c.queue = c.queue.filter(stillWanted);              // v5: shorts only
  if (typeof c.rot !== 'number') c.rot = 0;
  if (!c.lastSearch) c.lastSearch = c.lastRun || 0;
  c.nextPostAt = c.nextPostAt || 0;
  c.lastSource = c.lastSource || '';
  c.ver = SCHEMA;
  return c;
}

function cfg(guildId, create = false) {
  if (!db[guildId]) {
    if (!create) return null;
    db[guildId] = {};
  }
  if (!db[guildId][KEY]) {
    if (!create) return null;
    db[guildId][KEY] = {
      ver: SCHEMA,
      channelId: null,
      query: DEFAULT_QUERY,
      mode: 'link',       // 'link' = bare link (Discord's own embed/player), 'embed' = branded card
      paused: false,
      seen: [],
      titles: [],
      queue: [],
      usage: { month: '', count: 0 },
      lastSearch: 0,
      rot: 0,
      nextPostAt: 0,
      lastSource: '',
      lastPosted: 0,
    };
  }
  return upgrade(db[guildId][KEY]);
}

// Per-guild lock so the heartbeat and slash commands never change the queue at the same time.
const locks = new Set();
async function withLock(gid, fn) {
  if (locks.has(gid)) return { busy: true };
  locks.add(gid);
  try {
    return await fn();
  } finally {
    locks.delete(gid);
  }
}

// ─── Fetching and queueing ───────────────────────────────────────────────────

// Fetch, keep the four sources, and work out which of them this guild hasn't had yet.
async function gather(c, getVideos, siteOverride) {
  const site = siteQuery(c, siteOverride);
  const raw = await getVideos(c.query, site);
  const { kept, dropped, droppedItems } = curate(raw);
  const seen = new Set(c.seen);
  // v.raw check = videos posted by v1 (their IDs were made from the raw search-result URL)
  const unseen = kept.filter(v => !seen.has(v.id) && !seen.has(videoId(v.raw)));

  // Same story posted by several accounts / platforms: keep the first, skip look-alike titles.
  const known = (c.titles || []).map(tokenSet);
  const fresh = [];
  const dupTitles = [];
  for (const v of unseen) {
    v.titleNorm = normTitle(v.title);
    const tok = tokenSet(v.titleNorm);
    if (tok.size >= MIN_TITLE_TOKENS) {
      if (known.some(k => k.size >= MIN_TITLE_TOKENS && jaccard(tok, k) >= TITLE_SIMILARITY)) {
        dupTitles.push(v);
        continue;
      }
      known.push(tok);     // later results in this same batch are compared against this one
    }
    fresh.push(v);
  }
  return {
    rawCount: raw.length, kept, dropped, droppedItems, fresh, dupTitles, site,
    alreadyPosted: kept.length - unseen.length,
  };
}

function rememberTitle(c, v) {
  if (!v.titleNorm || tokenSet(v.titleNorm).size < MIN_TITLE_TOKENS) return;
  c.titles.push(v.titleNorm.slice(0, 120));
  if (c.titles.length > TITLES_CAP) c.titles = c.titles.slice(-TITLES_CAP);
}

function enqueue(c, v) {
  const q = { id: v.id, url: v.url, key: v.key, source: v.source, title: clip(v.title, 150), at: Date.now() };
  if (c.mode === 'embed') {        // extras only needed for the branded card
    q.snippet = clip(v.snippet, 160);
    q.thumbnail = v.thumbnail;
    q.channel = v.channel;
    q.duration = v.duration;
    q.date = v.date;
  }
  c.queue.push(q);
  c.seen.push(v.id);               // queued counts as seen, so it is never queued twice
  rememberTitle(c, v);
}

// Run one search now and put the new videos in the queue. Nothing is posted here.
async function searchAndQueue(gid, c) {
  c.lastSearch = Date.now();       // set first, so a failure can't turn into a rapid retry loop
  const label = (siteQuery(c) || 'all sites').replace('site:', '');
  let g;
  try {
    g = await gather(c, fetchVideos);
  } catch (e) {
    c.rot = (c.rot || 0) + 1;      // a failing platform must never block the rotation
    c.lastNote = clip(`${label}: failed — ${e.message}`, 120);
    saveData(gid);
    throw e;
  }
  charge(c);                       // a successful search counts against the budget
  c.rot = (c.rot || 0) + 1;        // next search targets the next platform

  let added = 0;
  for (const v of g.fresh) {
    if (c.queue.length >= QUEUE_CAP) break;
    enqueue(c, v);
    added++;
  }
  for (const d of g.dupTitles) c.seen.push(d.id);     // look-alike titles are not re-checked every time
  if (c.seen.length > SEEN_CAP) c.seen = c.seen.slice(-SEEN_CAP);
  c.lastNote = `${label}: ${g.rawCount} result(s), ${g.kept.length} usable, ${added} queued`;
  saveData(gid);
  return {
    added, site: g.site, rawCount: g.rawCount, usable: g.kept.length,
    alreadyPosted: g.alreadyPosted, dupTitles: g.dupTitles.length,
  };
}

function expireQueue(c) {
  const cutoff = Date.now() - QUEUE_TTL_MS;
  const before = c.queue.length;
  c.queue = c.queue.filter(v => (v.at || 0) >= cutoff);
  return before - c.queue.length;
}

// ─── Posting (the drip) ──────────────────────────────────────────────────────

async function postVideo(channel, v, mode) {
  if (mode !== 'embed') return channel.send({ content: v.url });

  const meta = [v.source, v.channel, v.duration, v.date].filter(Boolean).join(' · ');
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(clip(v.title, 250))
    .setURL(v.key)
    .setFooter({ text: clip(`Source: ${meta || v.source}`, 200) });
  if (v.snippet) embed.setDescription(clip(v.snippet, 300));
  if (v.thumbnail) embed.setImage(v.thumbnail);

  const payload = { embeds: [embed] };
  if (v.key.length <= 512) {
    payload.components = [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Watch').setURL(v.key),
      ),
    ];
  }
  return channel.send(payload);
}

// Prefer a video from a different platform than the last one, otherwise the oldest.
function pickNext(c) {
  if (!c.queue.length) return -1;
  const i = c.queue.findIndex(v => v.source !== c.lastSource);
  return i >= 0 ? i : 0;
}

// Time until the next post: stretches when few videos are waiting, shrinks when many are,
// stays inside [min, max], and gets ±20% randomness so it doesn't look robotic.
function gapMs(queueLen) {
  const target = DRAIN_MS / Math.max(queueLen, 1);
  const gap = Math.min(MAX_GAP_MS, Math.max(MIN_GAP_MS, target));
  return Math.round(gap * (0.8 + Math.random() * 0.4));
}

async function postNext(gid, c) {
  if (!c.queue.length) return { posted: false, note: 'The queue is empty.' };
  const channel = await client.channels.fetch(c.channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    return { posted: false, note: 'I can no longer see the configured channel — set it again with `/videos-feed channel`.' };
  }

  const idx = pickNext(c);
  const v = c.queue[idx];
  try {
    await postVideo(channel, v, c.mode);
  } catch (e) {
    console.error('[videos] post failed:', e.message);
    if (e.code === 50013 || e.code === 50001) {       // missing permissions: keep the video, retry later
      c.nextPostAt = Date.now() + 15 * 60e3;
      saveData(gid);
      return { posted: false, note: 'I\'m missing permissions in that channel (need Send Messages + Embed Links).' };
    }
    c.queue.splice(idx, 1);                           // a video Discord rejects must not block the queue
    c.nextPostAt = Date.now() + 60e3;
    saveData(gid);
    return { posted: false, note: 'Discord rejected that video, so I skipped it.' };
  }

  c.queue.splice(idx, 1);
  c.lastSource = v.source;
  c.lastPosted = Date.now();
  c.nextPostAt = c.queue.length ? Date.now() + gapMs(c.queue.length) : 0;   // empty queue: next video goes out right away
  saveData(gid);
  return { posted: true, video: v };
}

// ─── Heartbeat: runs every minute, decides everything from saved timestamps ──

async function maybeSearch(gid, c, activeGuilds) {
  if (!provider) return;
  if (c.queue.length >= QUEUE_PAUSE_AT) return;                       // plenty waiting already
  if (Date.now() - c.lastSearch < MIN_SEARCH_GAP_MS) return;          // cheap check first
  const plan = await searchPlan(activeGuilds);
  if (!plan.ok) return;
  if (Date.now() - c.lastSearch < plan.intervalMs) return;
  try {
    const r = await searchAndQueue(gid, c);
    console.log(`[videos] guild ${gid}: search done (${r.site || 'no site filter'}) — ${r.added} queued (${c.queue.length} waiting)` +
      (plan.left != null ? ` · ~${plan.left - 1} searches left` : ''));
  } catch (e) {
    console.error(`[videos] guild ${gid} search failed:`, e.message);
    saveData(gid);
  }
}

async function maybePost(gid, c) {
  if (!c.queue.length) return;
  if (!isActiveNow()) return;
  if (Date.now() < (c.nextPostAt || 0)) return;
  const r = await postNext(gid, c);
  if (r.note) console.warn(`[videos] guild ${gid}: ${r.note}`);
}

let beating = false;
async function heartbeat() {
  if (beating) return;
  beating = true;
  try {
    const gids = Object.keys(db).filter(g => {
      const c = db[g] && db[g][KEY];
      return c && c.channelId && !c.paused;
    });
    for (const gid of gids) {
      try {
        await withLock(gid, async () => {
          const c = cfg(gid);
          if (expireQueue(c)) saveData(gid);
          await maybeSearch(gid, c, gids.length);
          await maybePost(gid, c);
        });
      } catch (e) {
        console.error(`[videos] guild ${gid} heartbeat failed:`, e.message);
      }
    }
  } finally {
    beating = false;
  }
}

// ─── /videos-feed command ────────────────────────────────────────────────────

function getLibyaVideosCommands() {
  return [
    new SlashCommandBuilder()
      .setName('videos-feed')
      .setDescription('Drip-feed the latest Libya videos into a channel (admin only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .setDMPermission(false)
      .addSubcommand(s => s
        .setName('channel')
        .setDescription('Set the channel videos are posted to')
        .addChannelOption(o => o
          .setName('channel')
          .setDescription('Text channel')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(true)))
      .addSubcommand(s => s
        .setName('query')
        .setDescription('Change the search term (default: ليبيا)')
        .addStringOption(o => o
          .setName('text')
          .setDescription('e.g. ليبيا, طرابلس, libya')
          .setMaxLength(100)
          .setRequired(true)))
      .addSubcommand(s => s
        .setName('style')
        .setDescription('How videos are posted')
        .addStringOption(o => o
          .setName('mode')
          .setDescription('Plain link (playable embed) or a branded card')
          .setRequired(true)
          .addChoices(
            { name: 'Plain link (playable embed) — default', value: 'link' },
            { name: 'Embed card (title, thumbnail, Watch button)', value: 'embed' },
          )))
      .addSubcommand(s => s.setName('pause').setDescription('Stop searching and posting'))
      .addSubcommand(s => s.setName('resume').setDescription('Resume searching and posting'))
      .addSubcommand(s => s.setName('fetch').setDescription('Search now and add new videos to the queue (they are posted gradually)'))
      .addSubcommand(s => s.setName('next').setDescription('Post the next queued video right now'))
      .addSubcommand(s => s
        .setName('test')
        .setDescription('Dry run: search now and show what would be queued (nothing is saved)')
        .addStringOption(o => o
          .setName('site')
          .setDescription('Search just one platform (default: the next one in the rotation)')
          .addChoices(
            { name: 'YouTube', value: 'youtube.com' },
            { name: 'TikTok', value: 'tiktok.com' },
            { name: 'Facebook', value: 'facebook.com' },
            { name: 'Instagram', value: 'instagram.com' },
          ))
        .addBooleanOption(o => o
          .setName('post')
          .setDescription('Also post up to 3 of them in THIS channel to preview how they embed')))
      .addSubcommand(s => s.setName('clear').setDescription('Empty the queue of waiting videos'))
      .addSubcommand(s => s.setName('status').setDescription('Show settings, queue and search budget')),
  ];
}

const manualCooldown = new Map();

function providerLabel() {
  if (provider === 'serpapi') return ENGINE === 'google_short_videos' ? 'Google Short Videos via SerpApi' : 'Google Videos via SerpApi';
  if (provider === 'youtube') return 'YouTube Data API';
  return '❌ none — set SERPAPI_KEY or YOUTUBE_API_KEY in Railway';
}

function cooldownLeft(gid) {
  return (manualCooldown.get(gid) || 0) + MANUAL_COOLDOWN_MS - Date.now();
}

function nextPostText(c) {
  if (!c.queue.length) return 'nothing queued';
  if (!isActiveNow()) return `when active hours start (${activeLabel()})`;
  if (!c.nextPostAt || c.nextPostAt <= Date.now()) return 'within a minute';
  return `<t:${unix(c.nextPostAt)}:R>`;
}

async function handleVideosFeed(i) {
  const gid = i.guild.id;
  const sub = i.options.getSubcommand();
  const say = content => i.reply({ content, flags: 64 });

  if (!i.memberPermissions || !i.memberPermissions.has(PermissionFlagsBits.Administrator)) {
    return say('❌ Only server administrators can use this command.');
  }

  if (sub === 'status') {
    await i.deferReply({ flags: 64 });
    const c = cfg(gid);
    const guilds = Object.keys(db).filter(g => db[g] && db[g][KEY] && db[g][KEY].channelId && !db[g][KEY].paused).length;
    const plan = await searchPlan(Math.max(guilds, 1));
    let searchLine;
    if (provider === 'serpapi') {
      searchLine = plan.ok
        ? `Searches: **${plan.left}** left${plan.renews ? ` (plan renews ${plan.renews})` : ''} → one search about every **${fmtDur(plan.intervalMs)}** · ${plan.basis}`
        : `Searches: **${plan.left}** left — only the ${RESERVE} reserve remain, so automatic searching is paused until the plan renews`;
    } else if (provider === 'youtube') {
      searchLine = `Searches: YouTube API, one every ${fmtDur(plan.intervalMs)}`;
    } else {
      searchLine = `Searches: ${providerLabel()}`;
    }
    return i.editReply({
      content: [
        '📺 **Libya videos feed**',
        `Channel: ${c && c.channelId ? `<#${c.channelId}>` : 'not set'}`,
        `Search: \`${(c && c.query) || DEFAULT_QUERY}\` · ${WINDOW_LABEL}${GL || HL ? ` · region ${GL || '-'}/${HL || '-'}` : ''}${provider === 'serpapi' && SITE_FILTER && ROTATE ? ` · next platform: ${PLATFORM_SITES[((c && c.rot) || 0) % PLATFORM_SITES.length]}` : ''}`,
        `Style: ${c && c.mode === 'embed' ? 'embed card' : 'plain link (playable embed)'}`,
        `State: ${!c || !c.channelId ? 'not configured' : c.paused ? '⏸️ paused' : '▶️ running'}`,
        c ? `Queue: **${c.queue.length}** waiting · next post ${nextPostText(c)}` : 'Queue: 0 waiting',
        `Drip: one video every ${fmtDur(MIN_GAP_MS)}–${fmtDur(MAX_GAP_MS)} (adapts to the queue), ${activeLabel()}`,
        searchLine,
        `Sources kept (${SHORTS_ONLY ? 'shorts only' : 'all video lengths'}): YouTube · TikTok${TIKTOK_HOST ? ` (→ ${TIKTOK_HOST})` : ''} · Facebook (→ ${FACEBOOK_HOST}) · Instagram (→ ${INSTAGRAM_HOST})`,
        c && c.lastSearch ? `Last search: <t:${unix(c.lastSearch)}:R>${c.lastNote ? ` (${c.lastNote})` : ''}${c.lastPosted ? ` · last post: <t:${unix(c.lastPosted)}:R>` : ''}` : 'Last search: never',
      ].join('\n'),
    });
  }

  if (sub === 'channel') {
    const ch = i.options.getChannel('channel', true);
    const me = i.guild.members.me || await i.guild.members.fetchMe();
    const perms = ch.permissionsFor(me);
    const need = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];
    if (!perms || !perms.has(need)) {
      return say(`❌ I need **View Channel**, **Send Messages** and **Embed Links** in ${ch}.`);
    }
    const c = cfg(gid, true);
    c.channelId = ch.id;
    c.paused = false;
    saveData(gid);
    return say(
      `✅ Videos will be posted in ${ch}.` +
      (provider ? ' The first search runs within a few minutes, then videos trickle in. Use `/videos-feed status` to watch the queue.' : '\n⚠️ No API key is configured yet, so nothing will happen until you add SERPAPI_KEY or YOUTUBE_API_KEY in Railway.'),
    );
  }

  if (sub === 'query') {
    const c = cfg(gid, true);
    c.query = i.options.getString('text', true).trim();
    saveData(gid);
    return say(`✅ Now searching for \`${c.query}\`. Videos already in the queue stay there; use \`/videos-feed clear\` to empty it.`);
  }

  if (sub === 'style') {
    const c = cfg(gid, true);
    c.mode = i.options.getString('mode', true);
    saveData(gid);
    return say(`✅ Style set to **${c.mode === 'embed' ? 'embed card' : 'plain link'}**.`);
  }

  if (sub === 'pause' || sub === 'resume') {
    const c = cfg(gid);
    if (!c || !c.channelId) return say('❌ Set a channel first with `/videos-feed channel`.');
    c.paused = sub === 'pause';
    saveData(gid);
    return say(c.paused ? '⏸️ Paused. Nothing will be searched or posted; the queue is kept.' : '▶️ Resumed.');
  }

  if (sub === 'clear') {
    const c = cfg(gid);
    const n = c ? c.queue.length : 0;
    if (c) {
      c.queue = [];
      c.nextPostAt = 0;
      saveData(gid);
    }
    return say(`🧹 Queue cleared (${n} video(s) removed).`);
  }

  if (sub === 'next') {
    const c = cfg(gid);
    if (!c || !c.channelId) return say('❌ Set a channel first with `/videos-feed channel`.');
    await i.deferReply({ flags: 64 });
    const out = await withLock(gid, () => postNext(gid, c));
    if (out.busy) return i.editReply({ content: '⏳ The feed is busy for a moment — try again.' });
    return i.editReply({
      content: out.posted
        ? `✅ Posted a ${out.video.source} video. **${c.queue.length}** left in the queue.`
        : `⚠️ ${out.note}`,
    });
  }

  if (sub === 'fetch') {
    const c = cfg(gid);
    if (!c || !c.channelId) return say('❌ Set a channel first with `/videos-feed channel`.');
    if (!provider) return say(`❌ No video source configured: ${providerLabel()}`);
    const wait = cooldownLeft(gid);
    if (wait > 0) return say(`⏳ Try again in ${Math.ceil(wait / 1000)}s (each fetch or test uses one search).`);
    manualCooldown.set(gid, Date.now());

    await i.deferReply({ flags: 64 });
    try {
      const out = await withLock(gid, async () => {
        const plan = await searchPlan(1);
        if (provider === 'serpapi' && plan.left !== null && plan.left <= 0) {
          return { refused: 'No SerpApi searches are left this month.' };
        }
        return { r: await searchAndQueue(gid, c), left: plan.left };
      });
      if (out.busy) return i.editReply({ content: '⏳ The feed is busy for a moment — try again.' });
      if (out.refused) return i.editReply({ content: `⚠️ ${out.refused}` });
      const { r } = out;
      const budget = out.left != null ? ` Searches left ≈ ${Math.max(out.left - 1, 0)}.` : '';
      return i.editReply({
        content: r.added
          ? `✅ Searched ${r.site ? r.site.replace('site:', '') : 'all sites'} and added **${r.added}** new video(s) to the queue — **${c.queue.length}** waiting. They go out gradually (use \`/videos-feed next\` to post one now).${budget}`
          : `ℹ️ Nothing new to queue (${r.rawCount} raw, ${r.usable} usable, ${r.alreadyPosted} already seen, ${r.dupTitles} duplicate titles). **${c.queue.length}** still waiting.${budget}`,
      });
    } catch (e) {
      console.error('[videos] manual fetch failed:', e.message);
      return i.editReply({ content: `❌ Fetch failed: ${clip(e.message, 300)}` });
    }
  }

  if (sub === 'test') {
    if (!provider) return say(`❌ No video source configured: ${providerLabel()}`);
    const wait = cooldownLeft(gid);
    if (wait > 0) return say(`⏳ Try again in ${Math.ceil(wait / 1000)}s (each fetch or test uses one search).`);
    manualCooldown.set(gid, Date.now());

    await i.deferReply({ flags: 64 });
    try {
      const c = cfg(gid, true);
      const plan = await searchPlan(1);
      if (provider === 'serpapi' && plan.left !== null && plan.left <= 0) {
        return i.editReply({ content: '⚠️ No SerpApi searches are left this month.' });
      }
      const g = await gather(c, fetchVideos, i.options.getString('site'));
      charge(c);
      saveData(gid);

      const bySource = {};
      for (const v of g.kept) bySource[v.source] = (bySource[v.source] || 0) + 1;
      const lines = [
        `🧪 **Fetch test** — ${providerLabel()} · \`${c.query}${g.site ? ` ${g.site}` : ''}\` · ${WINDOW_LABEL}`,
        `Raw results: **${g.rawCount}**`,
        `Usable videos: **${g.kept.length}**` +
          (g.kept.length ? ` (${Object.entries(bySource).map(([k, n]) => `${k} ${n}`).join(', ')})` : ''),
        `Already seen: ${g.alreadyPosted} · Duplicate titles skipped: ${g.dupTitles.length} · Would be queued: **${g.fresh.length}**`,
      ];
      if (g.dropped.size) {
        lines.push(`Dropped: ${clip([...g.dropped].map(([h, n]) => `${h} ×${n}`).join(', '), 300)}`);
      }
      if (g.droppedItems.length) {
        lines.push('Examples dropped:');
        g.droppedItems.slice(0, 5).forEach((d, n) => {
          let where = d.url;
          try { const u = new URL(d.url); where = decodeURIComponent(u.hostname.replace(/^www\./, '') + u.pathname); } catch { /* keep raw */ }
          lines.push(`${n + 1}. ${clip(where, 70)} · ${d.duration || 'no length'} · ${d.reason}`);
        });
      }
      if (g.dupTitles.length) {
        lines.push(`Skipped as look-alikes: ${clip(g.dupTitles.slice(0, 3).map(v => clip(v.title, 40)).join(' | '), 250)}`);
      }
      if (!g.rawCount) lines.push('⚠️ Google returned no results for this search (normal for a quiet platform — try another one).');
      if (plan.left != null) lines.push(`Searches left ≈ ${Math.max(plan.left - 1, 0)}`);
      if (g.fresh.length) {
        lines.push('', 'Next links that would be queued:');
        g.fresh.slice(0, 8).forEach((v, n) => {
          let shown = `<${v.url}>`;
          if (v.url.length > 110) {        // long percent-encoded Arabic links: show a readable, shortened form
            let readable = v.url;
            try { readable = decodeURIComponent(v.url); } catch { /* keep encoded */ }
            shown = clip(readable.replace(/^https?:\/\//, ''), 90);
          }
          lines.push(`${n + 1}. ${v.source} — ${shown}`);
        });
      }

      if (i.options.getBoolean('post') && g.fresh.length) {
        const target = i.channel || await i.client.channels.fetch(i.channelId).catch(() => null);
        const batch = g.fresh.slice(0, 3);
        let sent = 0;
        try {
          for (const v of batch) {
            await postVideo(target, v, c.mode);
            sent++;
            await sleep(POST_GAP_MS);
          }
        } catch (e) {
          lines.push('', `⚠️ Couldn't post here: ${clip(e.message, 150)}`);
        }
        if (sent) lines.push('', `📨 Posted ${sent} here as a preview. Nothing was queued or saved, so the feed may post these again later.`);
      }

      return i.editReply({ content: clip(lines.join('\n'), 1950) });
    } catch (e) {
      console.error('[videos] test failed:', e.message);
      return i.editReply({ content: `❌ Test failed: ${clip(e.message, 300)}` });
    }
  }
}

// ─── Init ────────────────────────────────────────────────────────────────────

function initLibyaVideos(deps) {
  client = deps.client;
  db = deps.db;
  saveData = deps.saveData || (() => {});
  provider = pickProvider();

  if (!provider) {
    console.warn('[videos] No SERPAPI_KEY or YOUTUBE_API_KEY set — feed is idle (the /videos-feed command still works).');
  } else {
    console.log(`[videos] Provider: ${providerLabel()} · drip ${fmtDur(MIN_GAP_MS)}–${fmtDur(MAX_GAP_MS)} · active ${activeLabel()} · window: ${WINDOW_LABEL}`);
  }

  client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'videos-feed') return;
    if (!interaction.guild) return;
    try {
      await handleVideosFeed(interaction);
    } catch (e) {
      console.error('[videos] command error:', e.message);
      const payload = { content: '❌ Something went wrong. Please try again.', flags: 64 };
      if (interaction.deferred || interaction.replied) interaction.editReply(payload).catch(() => {});
      else interaction.reply(payload).catch(() => {});
    }
  });

  client.once('clientReady', () => {
    if (!provider) return;
    // Wait for index.js to finish loading MongoDB before the first check.
    setTimeout(() => {
      heartbeat().catch(e => console.error('[videos] heartbeat error:', e.message));
      setInterval(() => heartbeat().catch(e => console.error('[videos] heartbeat error:', e.message)), HEARTBEAT_MS);
    }, FIRST_BEAT_DELAY_MS);
  });
}

module.exports = {
  initLibyaVideos,
  getLibyaVideosCommands,
  curateUrl,
  _test: { heartbeat, isActiveNow, gapMs, pickNext, searchPlan, normTitle },
};
