// ═══════════════════════════════════════════════════════════════════════════════
// LIBYA VIDEOS — scheduled video feed (v2)
//
// Every few hours the bot searches for fresh videos about a topic (default
// "libya", past 24h) and posts new ones to a channel as plain links that Discord
// turns into playable embeds. Nothing is downloaded or re-hosted by the bot.
//
// Only four sources are kept: YouTube, TikTok, Facebook and Instagram, and only
// links that point at an actual video. Each link is rewritten so Discord can embed it:
//   YouTube    → https://www.youtube.com/watch?v=ID                (Discord's own player)
//   TikTok     → https://www.tiktok.com/@user/video/ID             (Discord's own embed)
//                or a fixer host if TIKTOK_EMBED_HOST is set (e.g. tnktok.com)
//   Facebook   → https://facebed.com/reel/ID                        (facebed embed fixer)
//   Instagram  → https://c.instagramfix.com/reel/CODE/              (instagramfix "media only")
//
// Data source (set ONE of these in Railway → Variables):
//   SERPAPI_KEY       Google Videos results via SerpApi — covers all four platforms.
//                     Free plan = 250 searches/month, so the default check interval
//                     is 240 min (~180 searches/month).
//   YOUTUBE_API_KEY   YouTube Data API v3 — free quota, YouTube videos only.
//                     Default check interval is 60 min.
// If both are set SerpApi wins; force the other with VIDEO_PROVIDER=youtube.
//
// Optional variables:
//   VIDEOS_INTERVAL_MIN    minutes between checks (minimum 10)
//   VIDEOS_MAX_PER_RUN     max posts per check, 1–10 (default 5)
//   VIDEOS_WINDOW          h = past hour, d = past 24h (default), w = past week
//   VIDEOS_SITE_FILTER     set to 0 to stop adding "site:youtube.com OR site:tiktok.com…"
//                          to the SerpApi query
//   FACEBOOK_EMBED_HOST    default facebed.com
//   INSTAGRAM_EMBED_HOST   default c.instagramfix.com  (media-only embeds). The older
//                          ddinstagram.com service is dead; if this one ever stops working,
//                          swap in another fixer host here (e.g. instagramfix.com for the
//                          full card with caption)
//   TIKTOK_EMBED_HOST      default empty = TikTok's own link. Try tnktok.com if the native
//                          embed looks cluttered or doesn't play.
//
// Per-guild settings live in db[guildId].__videos and persist through the bot's
// normal MongoDB save, including the list of already-posted videos (no repeats
// after a redeploy). Everything is controlled with ONE slash command, /videos-feed,
// so it only uses a single command slot.
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
const SCHEMA = 2;                 // v2 = plain links are the default style
const DEFAULT_QUERY = 'libya';
const WINDOW = ['h', 'd', 'w'].includes(process.env.VIDEOS_WINDOW) ? process.env.VIDEOS_WINDOW : 'd';
const WINDOW_MS = { h: 3600e3, d: 86400e3, w: 604800e3 }[WINDOW];
const WINDOW_LABEL = { h: 'past hour', d: 'past 24h', w: 'past week' }[WINDOW];
const MAX_PER_RUN = Math.min(10, Math.max(1, parseInt(process.env.VIDEOS_MAX_PER_RUN, 10) || 5));
const SEEN_CAP = 600;             // remembered video IDs per guild
const FETCH_TIMEOUT_MS = 15000;
const POST_GAP_MS = 1500;         // pause between posts so we never trip Discord rate limits
const FIRST_TICK_DELAY_MS = 90 * 1000;   // let MongoDB finish loading before the first check
const MANUAL_COOLDOWN_MS = 60 * 1000;    // /videos-feed fetch and test each spend one API search
const EMBED_COLOR = 0xe70013;
const SITE_FILTER = process.env.VIDEOS_SITE_FILTER !== '0';
const SITE_QUERY = '(site:youtube.com OR site:tiktok.com OR site:facebook.com OR site:instagram.com)';

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
// upgrade are still recognised.)
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

// ─── Link curation: keep only YouTube / TikTok / Facebook / Instagram VIDEOS ─

// Turns any result URL into:
//   source – 'YouTube' | 'TikTok' | 'Facebook' | 'Instagram'
//   key    – the clean original-platform link (de-dupe key, Watch button)
//   url    – the link we actually post, rewritten so Discord gives a playable embed
// Returns null for anything else (other sites, channel pages, profiles, photo posts…).
function curateUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;

  const host = u.hostname.toLowerCase().replace(/^(www|m|mobile|web|mbasic)\./, '');
  const path = u.pathname.replace(/\/+$/, '');

  // YouTube: videos, Shorts, youtu.be, embed and live links → the standard watch link.
  if (host === 'youtube.com' || host === 'youtu.be') {
    let id = null;
    if (host === 'youtu.be') id = path.split('/')[1];
    else if (path === '/watch') id = u.searchParams.get('v');
    else {
      const m = path.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})(?:\/|$)/);
      if (m) id = m[1];
    }
    if (!id || !/^[\w-]{11}$/.test(id)) return null;
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

  // Facebook: reels, /watch?v=, share/v + share/r links and /<page>/videos/<id>.
  if (host === 'facebook.com') {
    let tail = null;
    if (/^\/reel\/\d+$/.test(path)) tail = path;
    else if (/^\/share\/[vr]\/[\w-]+$/.test(path)) tail = path;
    else if (/^\/[^/]+\/videos\/(?:[^/]+\/)?\d+$/.test(path)) tail = path;
    else if (path === '/watch' && /^\d+$/.test(u.searchParams.get('v') || '')) tail = `/watch/?v=${u.searchParams.get('v')}`;
    if (!tail) return null;
    return {
      source: 'Facebook',
      key: `https://www.facebook.com${tail}`,
      url: `https://${FACEBOOK_HOST}${tail}`,
    };
  }

  // Instagram: reels and IGTV only (plain /p/ posts may be photos). Media-only embed.
  if (host === 'instagram.com') {
    const m = path.match(/^(?:\/[^/]+)?\/(reel|reels|tv)\/([\w-]+)$/);
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

// Filters a provider's raw results down to the four sources and rewrites their links.
function curate(rawVideos) {
  const kept = [];
  const dropped = new Map();      // host → how many were thrown away
  const keys = new Set();
  for (const v of rawVideos) {
    const c = curateUrl(v.url);
    if (!c) {
      const h = hostOf(v.url);
      dropped.set(h, (dropped.get(h) || 0) + 1);
      continue;
    }
    if (keys.has(c.key)) continue;
    keys.add(c.key);
    kept.push({ ...v, ...c, raw: v.url, id: videoId(c.key) });
  }
  return { kept, dropped };
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

function intervalMs(p) {
  const env = parseInt(process.env.VIDEOS_INTERVAL_MIN, 10);
  const mins = env > 0 ? Math.max(10, env) : (p === 'serpapi' ? 240 : 60);
  return mins * 60 * 1000;
}

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${clip(body, 200)}`);
  }
  return res.json();
}

// Google Videos via SerpApi. tbs=qdr:d is the same "past 24 hours" filter that's in
// the Google URL. The site: filter asks Google for the four platforms only, so the
// ten-or-so results per search aren't wasted on news sites that get dropped anyway.
async function fetchSerpApi(query) {
  const params = new URLSearchParams({
    engine: 'google_videos',
    q: SITE_FILTER ? `${query} ${SITE_QUERY}` : query,
    tbs: `qdr:${WINDOW}`,
    api_key: process.env.SERPAPI_KEY,
  });
  const data = await getJson(`https://serpapi.com/search.json?${params}`);
  if (data.error) throw new Error(`SerpApi: ${data.error}`);

  const rows = [
    ...(Array.isArray(data.video_results) ? data.video_results : []),
    ...(Array.isArray(data.short_videos) ? data.short_videos : []),
  ];
  if (!rows.length) {
    // Helps spot a changed response shape: shows what the API actually returned.
    console.log('[videos] SerpApi returned no video rows. Response keys:', Object.keys(data).join(', '));
  }

  return rows
    .map(r => {
      const url = r.link || r.video_link || r.url;
      if (!isHttp(url)) return null;
      return {
        url,
        title: decodeEntities(r.title) || 'Video',
        snippet: decodeEntities(r.snippet || ''),
        thumbnail: isHttp(r.thumbnail) ? r.thumbnail : null,   // data: URIs can't be used in embeds
        channel: typeof r.channel === 'string' ? r.channel : '',
        date: r.date || '',
        duration: r.duration || '',
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
      };
    });
}

function fetchVideos(query) {
  return provider === 'youtube' ? fetchYouTube(query) : fetchSerpApi(query);
}

// ─── Per-guild settings ──────────────────────────────────────────────────────

function upgrade(c) {
  if (c.ver !== SCHEMA) {
    c.mode = 'link';      // v2: embeds-only (plain links) becomes the default for everyone
    c.ver = SCHEMA;
  }
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
      lastRun: 0,
      lastPosted: 0,
    };
  }
  return upgrade(db[guildId][KEY]);
}

// ─── Posting ─────────────────────────────────────────────────────────────────

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

// Fetch, keep the four sources, and work out which of them this guild hasn't had yet.
async function gather(c, getVideos) {
  const raw = await getVideos(c.query);
  const { kept, dropped } = curate(raw);
  const seen = new Set(c.seen);
  // v.raw check = videos posted by v1 (their IDs were made from the raw search-result URL)
  const fresh = kept.filter(v => !seen.has(v.id) && !seen.has(videoId(v.raw)));
  return { rawCount: raw.length, kept, dropped, fresh };
}

const running = new Set();

// Post up to MAX_PER_RUN videos that haven't been posted in this guild before.
// getVideos is supplied by the caller so several guilds sharing a query cost ONE API call.
async function runGuild(guildId, getVideos) {
  const c = cfg(guildId);
  if (!c || !c.channelId) return { posted: 0, note: 'No channel set — use `/videos-feed channel`.' };
  if (running.has(guildId)) return { posted: 0, note: 'A check is already in progress.' };

  running.add(guildId);
  try {
    const channel = await client.channels.fetch(c.channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      return { posted: 0, note: 'I can no longer see the configured channel — set it again with `/videos-feed channel`.' };
    }

    const g = await gather(c, getVideos);

    let posted = 0;
    let permError = false;
    for (const v of g.fresh.slice(0, MAX_PER_RUN)) {
      try {
        await postVideo(channel, v, c.mode);
        c.seen.push(v.id);
        posted++;
      } catch (e) {
        console.error('[videos] post failed:', e.message);
        if (e.code === 50013 || e.code === 50001) { permError = true; break; }   // no permission: try again later
        c.seen.push(v.id);          // a video Discord rejects must not block the queue forever
      }
      await sleep(POST_GAP_MS);
    }

    if (c.seen.length > SEEN_CAP) c.seen = c.seen.slice(-SEEN_CAP);
    c.lastRun = Date.now();
    if (posted) c.lastPosted = Date.now();
    saveData(guildId);

    return {
      posted,
      found: g.rawCount,
      usable: g.kept.length,
      waiting: Math.max(0, g.fresh.length - MAX_PER_RUN),
      note: permError ? 'I\'m missing permissions in that channel (need Send Messages + Embed Links).' : '',
    };
  } finally {
    running.delete(guildId);
  }
}

// Scheduled run across every guild that has a channel configured.
async function tick() {
  const targets = Object.keys(db).filter(g => {
    const c = db[g] && db[g][KEY];
    return c && c.channelId && !c.paused;
  });
  if (!targets.length) return;

  const cache = new Map();
  const getVideos = q => {
    if (!cache.has(q)) cache.set(q, fetchVideos(q));
    return cache.get(q);
  };
  for (const g of targets) {
    try {
      const r = await runGuild(g, getVideos);
      if (r.posted) console.log(`[videos] guild ${g}: posted ${r.posted}${r.waiting ? `, ${r.waiting} waiting` : ''}`);
    } catch (e) {
      console.error(`[videos] guild ${g} check failed:`, e.message);
    }
  }
}

// ─── /videos-feed command ────────────────────────────────────────────────────

function getLibyaVideosCommands() {
  return [
    new SlashCommandBuilder()
      .setName('videos-feed')
      .setDescription('Auto-post the latest Libya videos to a channel (admin only)')
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
        .setDescription('Change the search term (default: libya)')
        .addStringOption(o => o
          .setName('text')
          .setDescription('e.g. libya, ليبيا, tripoli')
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
      .addSubcommand(s => s.setName('pause').setDescription('Stop auto-posting'))
      .addSubcommand(s => s.setName('resume').setDescription('Resume auto-posting'))
      .addSubcommand(s => s.setName('fetch').setDescription('Check for new videos and post them to the feed channel now'))
      .addSubcommand(s => s
        .setName('test')
        .setDescription('Dry run: fetch now and show what would be posted (nothing is marked as posted)')
        .addBooleanOption(o => o
          .setName('post')
          .setDescription('Also post up to 3 of them in THIS channel to preview how they embed')))
      .addSubcommand(s => s.setName('status').setDescription('Show the current settings')),
  ];
}

const manualCooldown = new Map();

function providerLabel() {
  if (provider === 'serpapi') return 'Google Videos via SerpApi';
  if (provider === 'youtube') return 'YouTube Data API';
  return '❌ none — set SERPAPI_KEY or YOUTUBE_API_KEY in Railway';
}

function cooldownLeft(gid) {
  return (manualCooldown.get(gid) || 0) + MANUAL_COOLDOWN_MS - Date.now();
}

async function handleVideosFeed(i) {
  const gid = i.guild.id;
  const sub = i.options.getSubcommand();
  const say = content => i.reply({ content, flags: 64 });

  if (!i.memberPermissions || !i.memberPermissions.has(PermissionFlagsBits.Administrator)) {
    return say('❌ Only server administrators can use this command.');
  }

  if (sub === 'status') {
    const c = cfg(gid);
    const mins = Math.round(intervalMs(provider) / 60000);
    return say([
      '📺 **Libya videos feed**',
      `Channel: ${c && c.channelId ? `<#${c.channelId}>` : 'not set'}`,
      `Search: \`${(c && c.query) || DEFAULT_QUERY}\` · ${WINDOW_LABEL}`,
      `Style: ${c && c.mode === 'embed' ? 'embed card' : 'plain link (playable embed)'}`,
      `State: ${!c || !c.channelId ? 'not configured' : c.paused ? '⏸️ paused' : '▶️ running'}`,
      `Source: ${providerLabel()}`,
      `Sources kept: YouTube · TikTok${TIKTOK_HOST ? ` (→ ${TIKTOK_HOST})` : ''} · Facebook (→ ${FACEBOOK_HOST}) · Instagram (→ ${INSTAGRAM_HOST})`,
      `Checks every ${mins} min · up to ${MAX_PER_RUN} posts per check`,
      c && c.lastRun ? `Last check: <t:${Math.floor(c.lastRun / 1000)}:R>` : 'Last check: never',
    ].join('\n'));
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
      (provider ? ' Use `/videos-feed test` to preview, or `/videos-feed fetch` to post the first batch now.' : '\n⚠️ No API key is configured yet, so nothing will post until you add SERPAPI_KEY or YOUTUBE_API_KEY in Railway.'),
    );
  }

  if (sub === 'query') {
    const c = cfg(gid, true);
    c.query = i.options.getString('text', true).trim();
    saveData(gid);
    return say(`✅ Now searching for \`${c.query}\`.`);
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
    return say(c.paused ? '⏸️ Auto-posting paused.' : '▶️ Auto-posting resumed.');
  }

  if (sub === 'fetch') {
    const c = cfg(gid);
    if (!c || !c.channelId) return say('❌ Set a channel first with `/videos-feed channel`.');
    if (!provider) return say(`❌ No video source configured: ${providerLabel()}`);
    const wait = cooldownLeft(gid);
    if (wait > 0) return say(`⏳ Try again in ${Math.ceil(wait / 1000)}s (each fetch or test uses one API search).`);
    manualCooldown.set(gid, Date.now());

    await i.deferReply({ flags: 64 });
    try {
      const r = await runGuild(gid, fetchVideos);
      const msg = r.note
        ? `⚠️ ${r.note}`
        : r.posted
          ? `✅ Posted **${r.posted}** new video(s)${r.waiting ? ` — ${r.waiting} more are waiting for the next check` : ''}.`
          : `ℹ️ Nothing new to post (${r.found} raw result(s), ${r.usable} usable, all already posted). Run \`/videos-feed test\` for details.`;
      return i.editReply({ content: msg });
    } catch (e) {
      console.error('[videos] manual fetch failed:', e.message);
      return i.editReply({ content: `❌ Fetch failed: ${clip(e.message, 300)}` });
    }
  }

  if (sub === 'test') {
    if (!provider) return say(`❌ No video source configured: ${providerLabel()}`);
    const wait = cooldownLeft(gid);
    if (wait > 0) return say(`⏳ Try again in ${Math.ceil(wait / 1000)}s (each fetch or test uses one API search).`);
    manualCooldown.set(gid, Date.now());

    await i.deferReply({ flags: 64 });
    try {
      const c = cfg(gid) || { query: DEFAULT_QUERY, seen: [], mode: 'link' };
      const g = await gather(c, fetchVideos);

      const bySource = {};
      for (const v of g.kept) bySource[v.source] = (bySource[v.source] || 0) + 1;
      const lines = [
        `🧪 **Fetch test** — ${providerLabel()} · \`${c.query}\` · ${WINDOW_LABEL}`,
        `Raw results: **${g.rawCount}**`,
        `Usable videos: **${g.kept.length}**` +
          (g.kept.length ? ` (${Object.entries(bySource).map(([k, n]) => `${k} ${n}`).join(', ')})` : ''),
        `Already posted: ${g.kept.length - g.fresh.length} · New: **${g.fresh.length}**`,
      ];
      if (g.dropped.size) {
        lines.push(`Dropped: ${clip([...g.dropped].map(([h, n]) => `${h} ×${n}`).join(', '), 300)}`);
      }
      if (!g.rawCount) lines.push('⚠️ The API returned nothing — check the Railway logs for the response details.');
      if (g.fresh.length) {
        lines.push('', 'Next links the bot would post:');
        g.fresh.slice(0, 8).forEach((v, n) => lines.push(`${n + 1}. ${v.source} — <${v.url}>`));
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
        if (sent) lines.push('', `📨 Posted ${sent} here as a preview. They are NOT marked as posted, so the feed may post them again later.`);
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
    console.log(`[videos] Provider: ${providerLabel()} · every ${Math.round(intervalMs(provider) / 60000)} min · window: ${WINDOW_LABEL}`);
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
      tick().catch(e => console.error('[videos] tick error:', e.message));
      setInterval(() => tick().catch(e => console.error('[videos] tick error:', e.message)), intervalMs(provider));
    }, FIRST_TICK_DELAY_MS);
  });
}

module.exports = { initLibyaVideos, getLibyaVideosCommands, curateUrl };
