// ═══════════════════════════════════════════════════════════════════════════════
// LIBYA VIDEOS — drip-fed video feed (v4)
//
// Two separate jobs, so the channel never gets a rush of videos:
//
//   1. SEARCH (rare, budgeted): a few times a day the bot searches for fresh videos
//      about a topic (default ليبيا, past 24h) and puts the good ones in a QUEUE that is
//      saved in MongoDB. Nothing is posted at this point.
//   2. DRIP (frequent, gentle): every minute the bot checks whether it's time to post
//      ONE video from the queue. Gaps are 10–90 min (random ±20%) and stretch or shrink
//      so the queue drains over roughly 6 hours: a big backlog is posted faster, a small
//      one slower. Videos only go out during active hours (08:00–23:59 Libya time). The
//      NEWEST videos go first (a backlog never buries fresh ones; the oldest simply age
//      out), and among the latest batches consecutive posts come from different platforms
//      where possible. Queued videos are dropped when stale: news after 12 h, entertainment after 72 h.
//
// What gets searched: a LIST of terms (/videos-feed terms ...), mostly Libyan-dialect entertainment
// terms looking back a week, plus one news term looking back a day. Each search takes the next term
// (liked terms more often, disliked ones less) on the next platform. News is capped at 1 in every 4
// posts, so it never floods the feed but never disappears either.
//
// Member votes: every posted video gets 👍 and 👎 reactions. The bot reads the counts back and learns
// which terms and accounts members like. It is deliberately slow to react: a single vote (or a single
// troll) barely moves anything; only a clear, repeated pattern changes what is searched or blocked.
// See /videos-feed votes and /videos-feed terms list.
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
// Before a Facebook or TikTok link is posted the bot asks the embed service for it exactly like
// Discord does. If the service can't produce a video (facebed answers with a picture-only card;
// fxTikTok answers with an error), the link is skipped and the next one is used instead. TikTok
// failures are often temporary, so such a video is retried later and only dropped after 3 failures.
// Any doubt (network error, rate limit, unexpected page) never blocks a post.
//
// Only four sources are kept, and only SHORT videos: YouTube Shorts, TikTok videos, Facebook
// reels and Instagram reels. Regular/long videos, live streams and news broadcasts are
// skipped (set VIDEOS_SHORTS_ONLY=0 to allow them again). Each link is rewritten so Discord
// can embed it:
//   YouTube    → https://www.youtube.com/watch?v=ID                (Discord's own player)
//   TikTok     → https://d.tnktok.com/@user/video/ID               (fxTikTok "direct": video only,
//                                                                    H.264 so it plays in Discord;
//                                                                    TikTok's own embed buffers forever)
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
//   VIDEOS_MIN_GAP_MIN / VIDEOS_MAX_GAP_MIN   posting gap limits, default 10 / 90
//   VIDEOS_DRAIN_HOURS     aim to empty the queue in about this long (default 6)
//   VIDEOS_ACTIVE_HOURS    hours videos may be posted, default 8-23 ("off" = any time)
//   VIDEOS_TZ              time zone for those hours (default Africa/Tripoli)
//   VIDEOS_NEWS_TTL_HOURS / VIDEOS_FUN_TTL_HOURS   queue lifetime of news / entertainment (default 12 / 72)
//   VIDEOS_NEWS_SHARE      news share of the feed, 0.05–0.9 (default 0.25 = 1 in 4 posts)
//   SERPAPI_ENGINE         google_short_videos (default) or google_videos (general Videos tab)
//   VIDEOS_MAX_SECONDS     longest clip counted as "short" when its length is known (default 180)
//   VIDEOS_SHORTS_ONLY     set to 0 to also allow long videos (YouTube watch links, Facebook
//                          /videos and /watch links, Instagram IGTV). Default: shorts only.
//   VIDEOS_WINDOW          h, d or w: window for terms added without one (default w = past week)
//   VIDEOS_SITE_FILTER     set to 0 to stop adding site: filters to the SerpApi query
//   VIDEOS_VERIFY_EMBEDS   set to 0 to stop checking Facebook/TikTok links before posting
//   VIDEOS_ROTATE          set to 0 to search all four platforms in one query instead of one
//                          platform per search, in turn (default)
//   VIDEOS_GL / VIDEOS_HL  Google country / language for SerpApi, default ly / ar
//                          (set either to "off" to leave it out)
//   FACEBOOK_EMBED_HOST    default facebed.com
//   INSTAGRAM_EMBED_HOST   default c.instagramfix.com
//   TIKTOK_EMBED_HOST      default d.tnktok.com (video only). Use tnktok.com for the full card with
//                          likes and caption, or "off" for TikTok's own link
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
const SCHEMA = 6;                 // 2 plain links · 3 Arabic + title de-dupe · 4 queue + drip · 5 shorts only · 6 terms + votes
const DEFAULT_QUERY = 'ليبيا';
const WINDOW = ['h', 'd', 'w'].includes(process.env.VIDEOS_WINDOW) ? process.env.VIDEOS_WINDOW : 'w';   // window for terms added without one
const WIN = { h: { ms: 3600e3, label: 'past hour' }, d: { ms: 86400e3, label: 'past 24h' }, w: { ms: 604800e3, label: 'past week' } };
const winOf = w => WIN[w] || WIN.d;
const WINDOW_MS = { h: 3600e3, d: 86400e3, w: 604800e3 }[WINDOW];
const WINDOW_LABEL = { h: 'past hour', d: 'past 24h', w: 'past week' }[WINDOW];
const SEEN_CAP = 1500;            // remembered video IDs per guild (queued + posted)
const TITLES_CAP = 400;           // remembered titles per guild
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
const VERIFY_EMBEDS = process.env.VIDEOS_VERIFY_EMBEDS !== '0';
const DISCORD_UA = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)';
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
const MIN_GAP_MS = intEnv('VIDEOS_MIN_GAP_MIN', 10) * 60e3;
const MAX_GAP_MS = Math.max(MIN_GAP_MS, intEnv('VIDEOS_MAX_GAP_MIN', 90) * 60e3);
const DRAIN_MS = intEnv('VIDEOS_DRAIN_HOURS', 6) * 3600e3;
const QUEUE_TTL_MS = intEnv('VIDEOS_QUEUE_TTL_HOURS', 24) * 3600e3;
const FRESH_BAND_MS = 3 * 3600e3;   // "latest batches": queued within this long of the newest video
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
// d.tnktok.com = fxTikTok "direct" embed (video only, H.264 so it plays in Discord). 'off' = TikTok's own link.
const TIKTOK_HOST = /^(off|native|none)$/i.test(String(process.env.TIKTOK_EMBED_HOST || '').trim())
  ? ''
  : cleanHost(process.env.TIKTOK_EMBED_HOST, 'd.tnktok.com');

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

// ─── Search terms, news mix and member votes ─────────────────────────────────

// Starting list. Entertainment terms look back a week (they don't expire like news does); the one
// news term looks back a day and its videos also expire from the queue much sooner. Edit the list
// with /videos-feed terms add / remove / list / reset. The bot learns which terms members like.
const STARTER_TERMS = [
  { q: 'ليبيا', kind: 'news', w: 'd' },
  { q: 'بالليبي', kind: 'fun', w: 'w' },
  { q: 'كوميديا ليبية', kind: 'fun', w: 'w' },
  { q: 'طرائف ليبية', kind: 'fun', w: 'w' },
  { q: 'مقالب ليبية', kind: 'fun', w: 'w' },
  { q: 'أكلات ليبية', kind: 'fun', w: 'w' },
  { q: 'أغاني ليبية', kind: 'fun', w: 'w' },
  { q: 'عرس ليبي', kind: 'fun', w: 'w' },
  { q: 'الدوري الليبي', kind: 'fun', w: 'w' },
];
const starterTerms = () => STARTER_TERMS.map(t => ({ ...t, credit: 0 }));
const TERMS_CAP = 20;

const NEWS_TTL_MS = intEnv('VIDEOS_NEWS_TTL_HOURS', 12) * 3600e3;     // news goes stale fast…
const FUN_TTL_MS = intEnv('VIDEOS_FUN_TTL_HOURS', 72) * 3600e3;       // …entertainment doesn't
const NEWS_WINDOW = 4;                                                // news share is judged over the last 4 posts
const NEWS_MAX = Math.max(1, Math.round(Math.min(0.9, Math.max(0.05, Number(process.env.VIDEOS_NEWS_SHARE) || 0.25)) * NEWS_WINDOW));
const NEWS_IDLE_MS = 3 * 3600e3;      // if nothing was posted for this long, a news video may go out anyway

// Votes (👍/👎 reactions on posted videos). Designed so a lone troll can't move anything:
//  · a score is (👍 + 3) / (👍 + 👎 + 6), i.e. it starts neutral at 0.5 and each vote only nudges it
//  · one video counts at most 5 votes per direction, and old votes fade (half-life 14 days)
//  · a term only gets searched less (never below 35% of normal); an account is only blocked after
//    6+ 👎 spread over 3+ different videos with a score under 0.28
const POLL_MS = 10 * 60e3;            // how often reaction counts are read back
const VOTE_WINDOW_MS = 3 * 86400e3;   // posts keep collecting votes for 3 days
const VOTE_CAP = 5;
const VOTE_PRIOR = 3;
const VOTE_HALF_LIFE_MS = 14 * 86400e3;
const LEDGER_CAP = 400;
const BLOCK_SCORE = 0.28;
const BLOCK_MIN_DOWNS = 6;
const BLOCK_MIN_VIDEOS = 3;

// Words that mark a news-style title (matched as whole words after Arabic normalisation).
const NEWS_WORDS = new Set([
  'عاجل', 'العاجل', 'نشره', 'النشره', 'اخبار', 'الاخبار', 'تصريحات', 'تصريح', 'بيان', 'مباشر',
  'الدبيبه', 'حفتر', 'المنفي', 'ترامب', 'اشتباكات', 'الاشتباكات',
]);
let reactWarned = false;

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

const isNewsTitle = norm => [...tokenSet(norm)].some(w => NEWS_WORDS.has(w));

// "tt:@name", "fb:pagename", … or '' when the account can't be told (e.g. Instagram reel links).
function acctOf(v) {
  try {
    const seg = new URL(v.key).pathname.split('/').filter(Boolean);
    if (v.source === 'TikTok' && seg[0] && seg[0][0] === '@') return `tt:${seg[0].toLowerCase()}`;
    if (v.source === 'Facebook' && seg[0] && !['reel', 'share', 'watch', 'groups', 'people', 'profile.php'].includes(seg[0])) return `fb:${seg[0].toLowerCase()}`;
  } catch { /* fall through */ }
  if (v.channel && typeof v.channel === 'string') return `${String(v.source || 'x').slice(0, 2).toLowerCase()}:${v.channel.toLowerCase().slice(0, 40)}`;
  return '';
}

const scoreOf = x => (!x ? 0.5 : (x.u + VOTE_PRIOR) / (x.u + x.d + 2 * VOTE_PRIOR));

// Aggregates the vote ledger per term and per account, with the caps and fading described above.
function voteStats(c) {
  const now = Date.now();
  const terms = {};
  const accts = {};
  let up = 0;
  let down = 0;
  let rated = 0;
  const add = (m, k, u, d) => {
    const x = m[k] || (m[k] = { u: 0, d: 0, n: 0, dv: 0, ru: 0, rd: 0 });
    x.u += u.w; x.d += d.w; x.n++; x.ru += u.raw; x.rd += d.raw;
    if (d.raw > 0) x.dv++;
  };
  for (const e of c.ledger || []) {
    const f = Math.pow(0.5, Math.max(0, now - (e.at || now)) / VOTE_HALF_LIFE_MS);
    const u = Math.min(e.u || 0, VOTE_CAP);
    const d = Math.min(e.d || 0, VOTE_CAP);
    if (u || d) rated++;
    up += u;
    down += d;
    if (e.q) add(terms, e.q, { w: u * f, raw: u }, { w: d * f, raw: d });
    if (e.a) add(accts, e.a, { w: u * f, raw: u }, { w: d * f, raw: d });
  }
  return { terms, accts, up, down, rated };
}

const isBlocked = (st, acct) => {
  const x = acct && st.accts[acct];
  return !!x && x.dv >= BLOCK_MIN_VIDEOS && x.d >= BLOCK_MIN_DOWNS && scoreOf(x) < BLOCK_SCORE;
};

const termWeight = (t, st) => Math.min(1.8, Math.max(0.35, 2 * scoreOf(st.terms[t.q])));

// Smooth weighted round-robin: every term is searched in proportion to its weight (liked terms
// more, disliked ones less, never below 35%), in a steady rotation. commit=false only peeks.
function nextTerm(c, commit = true) {
  if (!Array.isArray(c.terms) || !c.terms.length) c.terms = starterTerms();
  const st = voteStats(c);
  const w = c.terms.map(t => termWeight(t, st));
  const total = w.reduce((a, b) => a + b, 0);
  let bi = 0;
  let bc = -Infinity;
  c.terms.forEach((t, i) => {
    const cr = (t.credit || 0) + w[i];
    if (cr > bc) { bc = cr; bi = i; }
  });
  const term = c.terms[bi];
  if (commit) {
    c.terms.forEach((t, i) => { t.credit = (t.credit || 0) + w[i]; });
    term.credit -= total;
  }
  return term;
}

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
async function fetchSerpApi(query, site, w) {
  const params = new URLSearchParams({
    engine: ENGINE,
    q: site ? `${query} ${site}` : query,
    tbs: `qdr:${WIN[w] ? w : 'd'}`,
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
async function fetchYouTube(query, _site, w) {
  const params = new URLSearchParams({
    part: 'snippet',
    type: 'video',
    order: 'date',
    videoDuration: 'short',
    maxResults: '25',
    q: query,
    publishedAfter: new Date(Date.now() - winOf(w).ms).toISOString(),
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

function fetchVideos(query, site, w) {
  return provider === 'youtube' ? fetchYouTube(query, site, w) : fetchSerpApi(query, site, w);
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
  if (!Array.isArray(c.terms) || !c.terms.length) {               // v6: a list of search terms
    c.terms = starterTerms();
    if (c.query && c.query !== DEFAULT_QUERY && !c.terms.some(t => t.q === c.query)) {
      c.terms.push({ q: c.query, kind: 'fun', w: WINDOW, credit: 0 });   // keep a custom single term the admin had set
    }
  }
  if (!Array.isArray(c.ledger)) c.ledger = [];                    // v6: posted videos + their 👍/👎 counts
  if (!Array.isArray(c.hist)) c.hist = [];                        // v6: kinds of the latest posts
  if (v < 6) {                                                    // videos queued before v6 came from the news-style search
    c.queue.forEach(it => { if (!it.k) { it.k = 'n'; it.q = it.q || DEFAULT_QUERY; it.a = it.a || acctOf(it); } });
  }
  c.lastPoll = c.lastPoll || 0;
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
      terms: starterTerms(),
      ledger: [],
      hist: [],
      lastPoll: 0,
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
async function gather(c, getVideos, opts = {}) {
  const term = opts.term || nextTerm(c, false);
  const site = siteQuery(c, opts.site);
  const raw = await getVideos(term.q, site, term.w);
  const { kept, dropped, droppedItems } = curate(raw);
  const st = voteStats(c);
  const seen = new Set(c.seen);
  // v.raw check = videos posted by v1 (their IDs were made from the raw search-result URL)
  const unseen = kept.filter(v => !seen.has(v.id) && !seen.has(videoId(v.raw)));

  // Same story posted by several accounts / platforms: keep the first, skip look-alike titles.
  const known = (c.titles || []).map(tokenSet);
  const fresh = [];
  const dupTitles = [];
  const blocked = [];
  for (const v of unseen) {
    v.titleNorm = normTitle(v.title);
    v.q = term.q;
    v.a = acctOf(v);
    v.k = term.kind === 'news' || isNewsTitle(v.titleNorm) ? 'n' : 'f';
    if (isBlocked(st, v.a)) {          // members have clearly voted this account down
      blocked.push(v);
      continue;
    }
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
    rawCount: raw.length, kept, dropped, droppedItems, fresh, dupTitles, blocked, site, term,
    alreadyPosted: kept.length - unseen.length,
  };
}

function rememberTitle(c, v) {
  if (!v.titleNorm || tokenSet(v.titleNorm).size < MIN_TITLE_TOKENS) return;
  c.titles.push(v.titleNorm.slice(0, 120));
  if (c.titles.length > TITLES_CAP) c.titles = c.titles.slice(-TITLES_CAP);
}

function enqueue(c, v, at = Date.now()) {
  const q = { id: v.id, url: v.url, key: v.key, source: v.source, title: clip(v.title, 150), at, q: clip(v.q || '', 40), k: v.k || 'f', a: v.a || '' };
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
  const term = nextTerm(c, true);   // terms rotate by weight, platforms rotate evenly; both move on even if the search fails
  const label = `${term.q} · ${(siteQuery(c) || 'all sites').replace('site:', '')}`;
  let g;
  try {
    g = await gather(c, fetchVideos, { term });
  } catch (e) {
    c.rot = (c.rot || 0) + 1;      // a failing platform must never block the rotation
    c.lastNote = clip(`${label}: failed — ${e.message}`, 120);
    saveData(gid);
    throw e;
  }
  charge(c);                       // a successful search counts against the budget
  c.rot = (c.rot || 0) + 1;        // next search targets the next platform

  let added = 0;
  const batchAt = Date.now();      // all videos from one search share a timestamp
  for (const v of g.fresh) {
    if (c.queue.length >= QUEUE_CAP) break;
    enqueue(c, v, batchAt);
    added++;
  }
  for (const d of g.dupTitles) c.seen.push(d.id);     // look-alike titles are not re-checked every time
  for (const b of g.blocked) c.seen.push(b.id);       // videos from voted-down accounts aren't re-checked either
  if (c.seen.length > SEEN_CAP) c.seen = c.seen.slice(-SEEN_CAP);
  c.lastNote = `${label}: ${g.rawCount} result(s), ${g.kept.length} usable, ${added} queued${g.blocked.length ? `, ${g.blocked.length} from blocked accounts` : ''}`;
  saveData(gid);
  return {
    added, site: g.site, term: term.q, rawCount: g.rawCount, usable: g.kept.length,
    alreadyPosted: g.alreadyPosted, dupTitles: g.dupTitles.length,
  };
}

const ttlOf = v => (v.k === 'n' ? NEWS_TTL_MS : v.k === 'f' ? FUN_TTL_MS : QUEUE_TTL_MS);

function expireQueue(c) {
  const now = Date.now();
  const before = c.queue.length;
  c.queue = c.queue.filter(v => (v.at || 0) >= now - ttlOf(v));
  return before - c.queue.length;
}

// ─── Posting (the drip) ──────────────────────────────────────────────────────

// Asks the embed fixer for a Facebook link exactly like Discord does (facebed sends browsers to
// Facebook and gives crawlers the embed page). Returns:
//   true  – the page carries a video (og:video / twitter:player tags)
//   false – facebed answered with a picture-only card, so Discord would show no video
//   null  – couldn't tell (not a Facebook link, check disabled, network error, rate limit,
//           unexpected page). Only a clear `false` ever stops a post.
async function embedOk(v) {
  if (!VERIFY_EMBEDS || !v) return null;
  if (v.source === 'TikTok') return TIKTOK_HOST ? tiktokOk(v) : null;
  if (v.source !== 'Facebook') return null;
  try {
    const res = await fetch(v.url, {
      headers: { 'User-Agent': DISCORD_UA },
      redirect: 'manual',
      signal: AbortSignal.timeout(12000),
    });
    if (res.status !== 200) return null;
    const html = (await res.text()).slice(0, 300000);
    if (/(?:property|name)="(?:og:video(?::url|:secure_url)?|twitter:player(?::stream)?)"/i.test(html)) return true;
    if (/name="twitter:card"/i.test(html)) return false;
    return null;
  } catch {
    return null;
  }
}

// One request like Discord's crawler: no redirects followed. Reads the page only when it is HTML.
async function crawlerHop(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': DISCORD_UA },
    redirect: 'manual',
    signal: AbortSignal.timeout(12000),
  });
  const type = res.headers.get('content-type') || '';
  const out = { status: res.status, location: res.headers.get('location') || '', type, html: '' };
  if (res.status === 200 && /text\/html/i.test(type)) out.html = (await res.text()).slice(0, 300000);
  else { try { await res.body?.cancel(); } catch { /* ignore */ } }
  return out;
}

// fxTikTok: d.tnktok.com answers 302 → offload.tnktok.com/generate/video/ID → 302 → TikTok's CDN file.
// When it can't fetch the video (TikTok blocks or limits it, region-locked, removed...) it answers with
// an HTTP error, and Discord then shows just the link. Same answers to us, same outcome, so we can tell
// BEFORE posting. true = reaches a video file, false = clear error, null = can't tell.
async function tiktokOk(v) {
  try {
    const fixer = TIKTOK_HOST.split('.').slice(-2).join('.');
    let url = v.url;
    for (let step = 0; step < 4; step++) {
      const r = await crawlerHop(url);
      if ([301, 302, 303, 307, 308].includes(r.status)) {
        if (!r.location) return null;
        url = new URL(r.location, url).toString();
        const host = new URL(url).hostname.toLowerCase();
        if (host !== fixer && !host.endsWith(`.${fixer}`)) return true;   // left the fixer: it is the video file's own address
        continue;
      }
      if (r.status === 200) {
        if (/^video\//i.test(r.type)) return true;
        if (/(?:property|name)="(?:og:video(?::url|:secure_url)?|twitter:player(?::stream)?)"/i.test(r.html)) return true;
        if (/name="twitter:card"|property="og:title"/i.test(r.html)) return false;   // a card without a video
        return null;
      }
      if (r.status === 429 || r.status === 408) return null;               // rate limited: don't judge
      if (r.status >= 400) return false;
      return null;
    }
    return null;
  } catch {
    return null;
  }
}

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

// News gets a limited share of the feed: at most NEWS_MAX of the last NEWS_WINDOW posts (1 in 4 by
// default). Entertainment goes first whenever the limit is reached.
function newsAllowed(c) {
  return (c.hist || []).slice(-NEWS_WINDOW).filter(x => x === 'n').length < NEWS_MAX;
}

// How much the members' votes favour a video: its search term and its account, 0–1 (0.5 = no opinion).
function itemScore(st, v) {
  return 0.5 * scoreOf(st.terms[v.q]) + 0.5 * (v.a ? scoreOf(st.accts[v.a]) : 0.5);
}

// Newest first, so a backlog never buries fresh videos (older ones simply age out). Among the
// latest batches (see FRESH_BAND_MS) a different platform than the last post is preferred, then
// the video the members' votes favour most, then the best-ranked search result.
// Returns -1 when only news is waiting and the news limit says to hold it back for now.
function pickNext(c, skip = new Set(), opts = {}) {
  let all = c.queue.map((_, i) => i).filter(i => !skip.has(c.queue[i].id));
  if (!all.length) return -1;
  if (!opts.ignoreNewsCap && !newsAllowed(c)) {
    const entertainment = all.filter(i => c.queue[i].k !== 'n');
    if (entertainment.length) all = entertainment;
    else if (Date.now() - (c.lastPosted || 0) < NEWS_IDLE_MS) return -1;      // only news waiting: hold it back…
  }                                                                            // …unless the feed has been silent for hours
  const st = voteStats(c);
  const at = i => c.queue[i].at || 0;
  const newest = Math.max(...all.map(at));
  const band = all.filter(i => at(i) >= newest - FRESH_BAND_MS);
  const other = band.filter(i => c.queue[i].source !== c.lastSource);
  const pool = other.length ? other : band;
  const sc = i => itemScore(st, c.queue[i]);
  let best = pool[0];
  for (const i of pool) {
    const d = sc(i) - sc(best);
    if (d > 1e-9 || (Math.abs(d) <= 1e-9 && at(i) > at(best))) best = i;       // ties: newest, then best-ranked (lowest index)
  }
  return best;
}

// Time until the next post: stretches when few videos are waiting, shrinks when many are,
// stays inside [min, max], and gets ±20% randomness so it doesn't look robotic.
function gapMs(queueLen) {
  const target = DRAIN_MS / Math.max(queueLen, 1);
  const gap = Math.min(MAX_GAP_MS, Math.max(MIN_GAP_MS, target));
  return Math.round(gap * (0.8 + Math.random() * 0.4));
}

// After a video is posted: add the 👍/👎 buttons and note the message so the votes can be read back.
async function recordPost(c, v, msg) {
  try {
    if (msg && typeof msg.react === 'function') {
      await msg.react('👍');
      await msg.react('👎');
      c.reactErr = '';
    }
  } catch (e) {
    c.reactErr = e.code === 50013 ? 'I need the Add Reactions permission in the feed channel' : clip(e.message, 80);
    if (!reactWarned) {
      reactWarned = true;
      console.warn('[videos] could not add 👍/👎 reactions:', e.message);
    }
  }
  if (msg && msg.id) {
    c.ledger.push({ m: msg.id, q: v.q || '', a: v.a || '', k: v.k || 'f', s: v.source, at: Date.now(), u: 0, d: 0 });
    if (c.ledger.length > LEDGER_CAP) c.ledger = c.ledger.slice(-LEDGER_CAP);
  }
  c.hist.push(v.k === 'n' ? 'n' : 'f');
  if (c.hist.length > 12) c.hist = c.hist.slice(-12);
}

// Reads the 👍/👎 counts of recent posts back from Discord (a couple of requests every 10 minutes,
// works without any special bot intents). The bot's own reaction is not counted.
async function pollVotes(gid, c) {
  try {
    const now = Date.now();
    if (now - (c.lastPoll || 0) < POLL_MS) return;
    const want = new Map();
    for (const e of c.ledger) if (now - e.at < VOTE_WINDOW_MS) want.set(e.m, e);
    if (!want.size) return;
    c.lastPoll = now;
    const channel = await client.channels.fetch(c.channelId).catch(() => null);
    if (!channel || !channel.messages) return;
    let before;
    let changed = false;
    for (let page = 0; page < 3 && want.size; page++) {
      const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) }).catch(() => null);
      if (!batch || !batch.size) break;
      for (const m of batch.values()) {
        const e = want.get(m.id);
        if (!e) continue;
        want.delete(m.id);
        const count = emoji => {
          const r = m.reactions && m.reactions.cache ? m.reactions.cache.get(emoji) : null;
          return r ? Math.max(0, r.count - (r.me ? 1 : 0)) : 0;
        };
        const u = count('👍');
        const d = count('👎');
        if (u !== e.u || d !== e.d) { e.u = u; e.d = d; changed = true; }
      }
      before = batch.last().id;
      const oldestWanted = want.size ? Math.min(...[...want.values()].map(x => x.at)) : Infinity;
      if (batch.last().createdTimestamp < oldestWanted - 60e3) break;     // paged past everything we're looking for
    }
    if (changed) saveData(gid);
  } catch (e) {
    console.warn('[videos] reading votes failed:', e.message);
  }
}

async function postNext(gid, c, opts = {}) {
  if (!c.queue.length) return { posted: false, note: 'The queue is empty.' };
  const channel = await client.channels.fetch(c.channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    return { posted: false, note: 'I can no longer see the configured channel — set it again with `/videos-feed channel`.' };
  }

  let skipped = 0;
  const deferred = new Set();        // failed the check this round, kept in the queue to be retried later
  while (skipped < 5) {
    const idx = pickNext(c, deferred, { ignoreNewsCap: !!opts.force });
    if (idx < 0) break;
    const v = c.queue[idx];
    if (v.source === 'TikTok' && v.key) {              // always use the current TikTok embed host, even for items queued earlier
      v.url = v.key.replace(/^https:\/\/www\.tiktok\.com/, `https://${TIKTOK_HOST || 'www.tiktok.com'}`);
    }

    if ((await embedOk(v)) === false) {               // the embed service has no video for this one
      skipped++;
      v.tries = (v.tries || 0) + 1;
      // TikTok failures are often temporary: keep the video and retry later, drop it after 3 failures.
      // Facebook answers "no video" definitively, so that one is dropped straight away.
      if (v.source === 'TikTok' && v.tries < 3) deferred.add(v.id);
      else c.queue.splice(idx, 1);
      console.log(`[videos] ${v.source} link can't be played as video (try ${v.tries}${deferred.has(v.id) ? ', will retry' : ', dropped'}): ${v.url.slice(0, 120)}`);
      continue;
    }

    let msg;
    try {
      msg = await postVideo(channel, v, c.mode);
    } catch (e) {
      console.error('[videos] post failed:', e.message);
      if (e.code === 50013 || e.code === 50001) {     // missing permissions: keep the video, retry later
        c.nextPostAt = Date.now() + 15 * 60e3;
        saveData(gid);
        return { posted: false, note: 'I\'m missing permissions in that channel (need Send Messages + Embed Links).' };
      }
      c.queue.splice(idx, 1);                         // a video Discord rejects must not block the queue
      c.nextPostAt = Date.now() + 60e3;
      saveData(gid);
      return { posted: false, note: 'Discord rejected that video, so I skipped it.' };
    }

    c.queue.splice(idx, 1);
    c.lastSource = v.source;
    c.lastPosted = Date.now();
    await recordPost(c, v, msg);
    c.nextPostAt = c.queue.length ? Date.now() + gapMs(c.queue.length) : 0;   // empty queue: next video goes out right away
    saveData(gid);
    return { posted: true, video: v, skipped };
  }

  const held = !skipped && c.queue.length > 0;       // nothing posted only because the news limit is holding news back
  c.nextPostAt = c.queue.length ? Date.now() + (deferred.size || held ? 5 * 60e3 : 60e3) : 0;
  saveData(gid);
  return {
    posted: false,
    note: skipped
      ? `Skipped ${skipped} link(s) the embed service couldn't turn into a playable video${deferred.size ? ` (${deferred.size} will be retried)` : ''}.`
      : held
        ? 'Only news is waiting, so it is being held back to keep the feed varied (use /videos-feed next to post it anyway).'
        : 'The queue is empty.',
  };
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
          await pollVotes(gid, c);
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
      .addSubcommandGroup(g => g
        .setName('terms')
        .setDescription('The search terms the feed rotates through')
        .addSubcommand(s => s.setName('list').setDescription('Show the terms, how members rated them and how often each is searched'))
        .addSubcommand(s => s
          .setName('add')
          .setDescription('Add a search term')
          .addStringOption(o => o.setName('text').setDescription('e.g. أكلات ليبية').setMaxLength(100).setRequired(true))
          .addStringOption(o => o
            .setName('kind')
            .setDescription('Entertainment (default) or news')
            .addChoices({ name: 'Entertainment', value: 'fun' }, { name: 'News', value: 'news' }))
          .addStringOption(o => o
            .setName('window')
            .setDescription('How far back to look (default: a week for entertainment, 24 hours for news)')
            .addChoices({ name: 'Past hour', value: 'h' }, { name: 'Past 24 hours', value: 'd' }, { name: 'Past week', value: 'w' })))
        .addSubcommand(s => s
          .setName('remove')
          .setDescription('Remove a search term')
          .addStringOption(o => o.setName('text').setDescription('The term to remove').setMaxLength(100).setRequired(true)))
        .addSubcommand(s => s.setName('reset').setDescription('Go back to the starting list of terms')))
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
        .addStringOption(o => o.setName('term').setDescription('Test one specific search term (default: the next one in the rotation)').setMaxLength(100))
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
      .addSubcommand(s => s.setName('votes').setDescription('Show what members have voted: liked and disliked terms and accounts'))
      .addSubcommand(s => s.setName('status').setDescription('Show settings, queue, votes and search budget')),
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

const KIND_ICON = { news: '📰', fun: '🎭' };

function nextSearchText(c) {
  if (!c) return '';
  const t = nextTerm(c, false);
  const site = provider === 'serpapi' && SITE_FILTER && ROTATE ? ` on ${PLATFORM_SITES[(c.rot || 0) % PLATFORM_SITES.length]}` : '';
  return ` · next search: ${t.q}${site}`;
}

// /videos-feed terms list | add | remove | reset
async function handleTerms(i, sub) {
  const gid = i.guild.id;
  const say = content => i.reply({ content, flags: 64 });
  const c = cfg(gid, true);

  if (sub === 'list') {
    const st = voteStats(c);
    const lines = c.terms.map(t => {
      const x = st.terms[t.q];
      const votes = x && (x.ru || x.rd) ? ` · 👍 ${x.ru} 👎 ${x.rd}` : '';
      return `${KIND_ICON[t.kind] || '🎭'} ${t.q} — ${winOf(t.w).label} · searched ×${termWeight(t, st).toFixed(2)}${votes}`;
    });
    return say(clip(`🔎 **Search terms** (${c.terms.length}) — 📰 news · 🎭 entertainment\n${lines.join('\n')}\n\n×1.00 is normal. Terms members like are searched more, ones they dislike less (never below ×0.35).`, 1950));
  }

  if (sub === 'add') {
    const text = i.options.getString('text', true).trim();
    const kind = i.options.getString('kind') || 'fun';
    const w = i.options.getString('window') || (kind === 'news' ? 'd' : WINDOW);
    if (!text) return say('❌ Type a search term.');
    const existing = c.terms.find(t => t.q.toLowerCase() === text.toLowerCase());
    if (existing) {
      existing.kind = kind;
      existing.w = w;
      saveData(gid);
      return say(`✅ Updated **${text}** → ${KIND_ICON[kind]} ${winOf(w).label}.`);
    }
    if (c.terms.length >= TERMS_CAP) return say(`❌ The list is full (${TERMS_CAP} terms). Remove one first.`);
    c.terms.push({ q: text, kind, w, credit: 0 });
    saveData(gid);
    return say(`✅ Added ${KIND_ICON[kind]} **${text}** (${winOf(w).label}). It joins the rotation now; preview it with \`/videos-feed test\` and this term.`);
  }

  if (sub === 'remove') {
    const text = i.options.getString('text', true).trim().toLowerCase();
    const idx = c.terms.findIndex(t => t.q.toLowerCase() === text);
    if (idx < 0) return say('❌ That term isn\'t in the list. Use `/videos-feed terms list` to see them.');
    if (c.terms.length <= 1) return say('❌ At least one term has to stay.');
    const [gone] = c.terms.splice(idx, 1);
    saveData(gid);
    return say(`🗑️ Removed **${gone.q}**.`);
  }

  if (sub === 'reset') {
    c.terms = starterTerms();
    saveData(gid);
    return say(`🔄 Back to the starting list (${c.terms.length} terms).`);
  }
}

async function handleVideosFeed(i) {
  const gid = i.guild.id;
  const sub = i.options.getSubcommand();
  const say = content => i.reply({ content, flags: 64 });

  if (!i.memberPermissions || !i.memberPermissions.has(PermissionFlagsBits.Administrator)) {
    return say('❌ Only server administrators can use this command.');
  }

  if (i.options.getSubcommandGroup(false) === 'terms') return handleTerms(i, sub);

  if (sub === 'votes') {
    const c = cfg(gid);
    const st = voteStats(c || { ledger: [] });
    const rows = (m, min) => Object.entries(m)
      .filter(([, x]) => x.n >= min && x.ru + x.rd > 0)
      .map(([k, x]) => ({ k, s: scoreOf(x), ru: x.ru, rd: x.rd }));
    const fmt = r => `${r.k} (${r.s.toFixed(2)} · 👍${r.ru} 👎${r.rd})`;
    const liked = arr => arr.filter(r => r.s > 0.5).sort((a, b) => b.s - a.s).slice(0, 3).map(fmt).join(' · ') || '—';
    const disliked = arr => arr.filter(r => r.s < 0.5).sort((a, b) => a.s - b.s).slice(0, 3).map(fmt).join(' · ') || '—';
    const terms = rows(st.terms, 1);
    const accts = rows(st.accts, 2);
    const blocked = Object.keys(st.accts).filter(k => isBlocked(st, k));
    return say(clip([
      `👍👎 **Votes** — ${st.rated} rated video(s) · 👍 ${st.up} · 👎 ${st.down}`,
      `Liked terms: ${liked(terms)}`,
      `Disliked terms: ${disliked(terms)}`,
      `Liked accounts: ${liked(accts)}`,
      `Disliked accounts: ${disliked(accts)}`,
      `Blocked accounts: ${blocked.length ? blocked.join(', ') : 'none'}`,
      '',
      'Scores run 0–1 and 0.50 means no opinion. A single vote barely moves a score, so one person can\'t sway the feed.',
    ].join('\n'), 1950));
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
        `Terms: ${c ? c.terms.length : STARTER_TERMS.length} (${c ? c.terms.filter(t => t.kind === 'news').length : 1} news · ${c ? c.terms.filter(t => t.kind !== 'news').length : STARTER_TERMS.length - 1} entertainment)${GL || HL ? ` · region ${GL || '-'}/${HL || '-'}` : ''}${nextSearchText(c)}`,
        `Style: ${c && c.mode === 'embed' ? 'embed card' : 'plain link (playable embed)'}`,
        `State: ${!c || !c.channelId ? 'not configured' : c.paused ? '⏸️ paused' : '▶️ running'}`,
        c ? `Queue: **${c.queue.length}** waiting (📰 ${c.queue.filter(v => v.k === 'n').length} · 🎭 ${c.queue.filter(v => v.k !== 'n').length}) · next post ${nextPostText(c)}` : 'Queue: 0 waiting',
        c ? `Mix: news limited to ${NEWS_MAX} of every ${NEWS_WINDOW} posts · votes: ${voteStats(c).rated} rated (👍 ${voteStats(c).up} · 👎 ${voteStats(c).down})` : null,
        c && c.reactErr ? `⚠️ Reactions: ${c.reactErr}` : null,
        `Drip: one video every ${fmtDur(MIN_GAP_MS)}–${fmtDur(MAX_GAP_MS)} (adapts to the queue), ${activeLabel()}`,
        searchLine,
        `Sources kept (${SHORTS_ONLY ? 'shorts only' : 'all video lengths'}): YouTube · TikTok${TIKTOK_HOST ? ` (→ ${TIKTOK_HOST})` : ''} · Facebook (→ ${FACEBOOK_HOST}) · Instagram (→ ${INSTAGRAM_HOST})`,
        c && c.lastSearch ? `Last search: <t:${unix(c.lastSearch)}:R>${c.lastNote ? ` (${c.lastNote})` : ''}${c.lastPosted ? ` · last post: <t:${unix(c.lastPosted)}:R>` : ''}` : 'Last search: never',
      ].filter(Boolean).join('\n'),
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
    const soft = [];
    if (!perms.has(PermissionFlagsBits.AddReactions)) soft.push('**Add Reactions**');
    if (!perms.has(PermissionFlagsBits.ReadMessageHistory)) soft.push('**Read Message History**');
    const c = cfg(gid, true);
    c.channelId = ch.id;
    c.paused = false;
    saveData(gid);
    return say(
      `✅ Videos will be posted in ${ch}.` +
      (soft.length ? `\n⚠️ Give me ${soft.join(' and ')} there so the 👍/👎 votes work.` : '') +
      (provider ? ' The first search runs within a few minutes, then videos trickle in. Use `/videos-feed status` to watch the queue.' : '\n⚠️ No API key is configured yet, so nothing will happen until you add SERPAPI_KEY or YOUTUBE_API_KEY in Railway.'),
    );
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
    const out = await withLock(gid, () => postNext(gid, c, { force: true }));
    if (out.busy) return i.editReply({ content: '⏳ The feed is busy for a moment — try again.' });
    return i.editReply({
      content: out.posted
        ? `✅ Posted a ${out.video.source} video${out.skipped ? ` (skipped ${out.skipped} unplayable Facebook link(s))` : ''}. **${c.queue.length}** left in the queue.`
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
          ? `✅ Searched ${r.term}${r.site ? ` on ${r.site.replace('site:', '')}` : ''} and added **${r.added}** new video(s) to the queue — **${c.queue.length}** waiting. They go out gradually (use \`/videos-feed next\` to post one now).${budget}`
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
      const termArg = (i.options.getString('term') || '').trim();
      const term = termArg
        ? (c.terms.find(t => t.q.toLowerCase() === termArg.toLowerCase()) || { q: termArg, kind: 'fun', w: WINDOW })
        : nextTerm(c, false);
      const g = await gather(c, fetchVideos, { site: i.options.getString('site'), term });
      charge(c);
      saveData(gid);

      const bySource = {};
      for (const v of g.kept) bySource[v.source] = (bySource[v.source] || 0) + 1;
      const lines = [
        `🧪 **Fetch test** — ${providerLabel()} · ${KIND_ICON[g.term.kind] || '🎭'} \`${g.term.q}${g.site ? ` ${g.site}` : ''}\` · ${winOf(g.term.w).label}`,
        `Raw results: **${g.rawCount}**`,
        `Usable videos: **${g.kept.length}**` +
          (g.kept.length ? ` (${Object.entries(bySource).map(([k, n]) => `${k} ${n}`).join(', ')})` : ''),
        `Already seen: ${g.alreadyPosted} · Duplicate titles skipped: ${g.dupTitles.length} · Would be queued: **${g.fresh.length}** (📰 ${g.fresh.filter(v => v.k === 'n').length} news-like)${g.blocked.length ? ` · Blocked accounts: ${g.blocked.length}` : ''}`,
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
      let checks = [];
      if (g.fresh.length) {
        lines.push('', 'Next links that would be queued:');
        checks = await Promise.all(g.fresh.slice(0, 8).map(embedOk));
        g.fresh.slice(0, 8).forEach((v, n) => {
          let shown = `<${v.url}>`;
          if (v.url.length > 110) {        // long percent-encoded Arabic links: show a readable, shortened form
            let readable = v.url;
            try { readable = decodeURIComponent(v.url); } catch { /* keep encoded */ }
            shown = clip(readable.replace(/^https?:\/\//, ''), 90);
          }
          const mark = checks[n] === true ? ' ✅ plays' : checks[n] === false ? ' ❌ no video (would be skipped)' : '';
          lines.push(`${n + 1}. ${v.source} — ${shown}${mark}`);
        });
      }

      if (i.options.getBoolean('post') && g.fresh.length) {
        const target = i.channel || await i.client.channels.fetch(i.channelId).catch(() => null);
        const batch = g.fresh.slice(0, 8).filter((v, n) => checks[n] !== false).slice(0, 3);
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
    console.log(`[videos] Provider: ${providerLabel()} · drip ${fmtDur(MIN_GAP_MS)}–${fmtDur(MAX_GAP_MS)} · active ${activeLabel()}`);
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
  _test: { heartbeat, isActiveNow, gapMs, pickNext, searchPlan, normTitle, embedOk, postNext, tiktokOk, nextTerm, voteStats, newsAllowed, isNewsTitle, acctOf, pollVotes, recordPost, cfg, isBlocked, scoreOf },
};
