// jobs.js
const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');

// === CONFIGURATION ===
const CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const MAX_HISTORY = 50;

// Colour per source for embed visuals
const SOURCE_COLORS = {
    opensooq:    0x2B5B84,
    hiringcafe:  0x1DB954,
    libyanjobs:  0xE63946,
};

// ─────────────────────────────────────────────────────────────────────────────
// Shared Playwright helper — launches a browser, runs your async callback,
// then closes the browser even if the callback throws.
// ─────────────────────────────────────────────────────────────────────────────
async function withBrowser(fn) {
    const { chromium } = require('playwright');
    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    try {
        return await fn(browser);
    } finally {
        await browser.close().catch(() => {});
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Source 1 — OpenSooq (Playwright)
//
// IMPROVEMENTS over original:
//   • Scans ALL job cards on the page, not just the first one.
//   • Picks the card whose timestamp is most recent.
//   • Strips noise (employment-type suffixes, time strings, "Now") more robustly.
//   • Falls back gracefully when the location element is missing.
// ─────────────────────────────────────────────────────────────────────────────
async function fetchOpenSooqJobs() {
    try {
        return await withBrowser(async (browser) => {
            const page = await browser.newPage();

            // Block images/fonts/media to speed things up
            await page.route('**/*', (route) => {
                const type = route.request().resourceType();
                if (['image', 'media', 'font'].includes(type)) return route.abort();
                return route.continue();
            });

            await page.goto(
                'https://ly.opensooq.com/en/jobs/job-vacancies?search=true&sort_code=recent',
                { waitUntil: 'domcontentloaded', timeout: 30000 }
            );

            // Wait until at least one relative-time string appears
            await page.waitForFunction(
                () => /\d+\s+(minute|hour|day|week)s?\s+ago/i.test(document.body.innerText),
                { timeout: 15000 }
            );

            const jobs = await page.evaluate(() => {
                // ── helpers ──────────────────────────────────────────────────
                function relativeToMs(value, unit) {
                    const now = Date.now();
                    const u = unit.toLowerCase();
                    if (u === 'minute') return now - value * 60_000;
                    if (u === 'hour')   return now - value * 3_600_000;
                    if (u === 'day')    return now - value * 86_400_000;
                    if (u === 'week')   return now - value * 604_800_000;
                    return now;
                }

                function cleanTitle(raw) {
                    let t = raw.trim();
                    // Remove leading "Now" or relative-time prefixes
                    t = t.replace(/^Now\s*/i, '');
                    t = t.replace(/^\d+\s+(minute|hour|day|week)s?\s+ago\s*/i, '');
                    // Keep only the first segment before " - "
                    t = t.split(' - ')[0].trim();
                    // Strip trailing employment-type tokens
                    t = t.replace(/\s+(Full\s*Time|Part\s*Time|Freelance|Contract)$/i, '').trim();
                    return t;
                }

                // ── collect every card that has both a job link and a timestamp ──
                const cards = Array.from(document.querySelectorAll('div, li, article')).filter(el => {
                    const hasLink = el.querySelector('a[href*="/job-posters/"]');
                    const hasTime = /\d+\s+(minute|hour|day|week)s?\s+ago/i.test(el.innerText);
                    return hasLink && hasTime;
                });

                const results = [];

                for (const card of cards) {
                    const link = card.querySelector('a[href*="/job-posters/"]');
                    if (!link) continue;

                    const timeMatch = card.innerText.match(/\b(\d+)\s+(minute|hour|day|week)s?\s+ago\b/i);
                    if (!timeMatch) continue;

                    const postedAt = relativeToMs(parseInt(timeMatch[1]), timeMatch[2]);

                    // Location: try the specific element first, then fall back
                    let location = 'Libya';
                    const locDiv = card.querySelector('div.flex.alignItems.bold.font-14');
                    if (locDiv) {
                        const span = locDiv.querySelector('span');
                        if (span && span.innerText.trim()) location = span.innerText.trim();
                    }

                    results.push({
                        title: cleanTitle(link.innerText),
                        url: link.href,
                        location,
                        postedAt,
                    });
                }

                return results;
            });

            if (!jobs.length) return [];

            // Sort by most recent and deduplicate by URL
            jobs.sort((a, b) => b.postedAt - a.postedAt);
            const seen = new Set();
            const unique = [];
            for (const j of jobs) {
                if (!seen.has(j.url)) {
                    seen.add(j.url);
                    unique.push(j);
                }
            }

            // Return the single most recent job
            const top = unique[0];
            return [{
                id: `opensooq_${top.url.split('/').pop() || Date.now()}`,
                title: top.title,
                location: top.location,
                url: top.url,
                postedAt: new Date(top.postedAt),
                source: 'opensooq',
            }];
        });
    } catch (err) {
        console.error('[Jobs] OpenSooq error:', err.message);
        return [];
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Source 2 — Hiring.cafe (Playwright)
//
// Hiring.cafe is a fully client-side React SPA.  The Libya search state is
// encoded in a large URL query param.  We navigate to that URL, wait for the
// job cards to render, then extract the most recent listing.
//
// NOTE: hiring.cafe has noindex/nofollow and loads via JS — there is no usable
// public API or RSS.  Playwright is the only reliable approach.
// ─────────────────────────────────────────────────────────────────────────────
async function fetchHiringCafeJobs() {
    const SEARCH_STATE = encodeURIComponent(JSON.stringify({
        locations: [{
            id: 'thY1yZQBoEtHp_8UEq3V',
            types: ['country'],
            address_components: [{ long_name: 'Libya', short_name: 'LY', types: ['country'] }],
            formatted_address: 'Libya',
            population: 6678567,
            workplace_types: [],
            options: { flexible_regions: [] },
        }],
        sortBy: 'date',
    }));
    const URL = `https://hiring.cafe/?searchState=${SEARCH_STATE}`;

    try {
        return await withBrowser(async (browser) => {
            const context = await browser.newContext({
                userAgent:
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
                    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
                    'Chrome/124.0.0.0 Safari/537.36',
            });
            const page = await context.newPage();

            await page.goto(URL, { waitUntil: 'networkidle', timeout: 45000 });

            // Wait for job cards to render — card roots are div.rounded-xl.shadow
            await page.waitForSelector('div.rounded-xl.border.border-gray-200.shadow', {
                timeout: 20000,
            }).catch(() => {});
            await page.waitForTimeout(1500);

            const jobs = await page.evaluate(() => {
                // ── EXACT SELECTORS FROM REAL HTML (devtools-verified) ────────
                //
                // Card root:
                //   div.rounded-xl.border.border-gray-200.shadow
                //
                // Time badge (desktop, always rendered even if visually hidden):
                //   div.absolute.top-2.right-2 > span
                //   → plain text like "23h", "4h", "1d", "3mo"
                //
                // Title:
                //   span.font-bold.line-clamp-3   (or span[class*="line-clamp-3"])
                //   → "Liaison Officer for Libya (Remote (Remote), KR)"
                //
                // Location:
                //   The span.line-clamp-2 that sits inside the div containing
                //   the location-pin SVG (path starting with "M15 10.5a3 3")
                //   → "Tripoli, /, Libyan Arab Jamahiriya"
                //
                // Company:
                //   img[alt]  inside the card  — alt IS the company name
                //   → alt="Green Climate Fund"
                //
                // Job URL:
                //   a[href^="/job/"]  inside the card
                // ─────────────────────────────────────────────────────────────

                function parseBadge(badge) {
                    // Handles: "23h", "4h", "1d", "30m", "3mo", "2w"
                    badge = badge.trim();
                    const m = badge.match(/^(\d+)\s*(m(?:o)?|h|d|w)$/i);
                    if (!m) return null;
                    const v = parseInt(m[1]);
                    const u = m[2].toLowerCase();
                    const now = Date.now();
                    // "mo" = months (approx 30d), "w" = weeks
                    if (u === 'm')  return now - v * 60_000;           // minutes
                    if (u === 'mo') return now - v * 30 * 86_400_000;  // months
                    if (u === 'h')  return now - v * 3_600_000;        // hours
                    if (u === 'd')  return now - v * 86_400_000;       // days
                    if (u === 'w')  return now - v * 7 * 86_400_000;   // weeks
                    return null;
                }

                // Location-pin SVG path signature (from the real HTML)
                const LOC_PIN_PATH = 'M15 10.5a3 3';

                const cards = Array.from(
                    document.querySelectorAll('div.rounded-xl.border.border-gray-200.shadow')
                );

                const results = [];

                for (const card of cards) {
                    // ── Job URL ───────────────────────────────────────────────
                    const jobAnchor = card.querySelector('a[href^="/job/"]');
                    if (!jobAnchor) continue;
                    const href = jobAnchor.href;
                    if (!href) continue;

                    // ── Time badge ────────────────────────────────────────────
                    // The desktop badge is in:
                    //   div.absolute.top-2.right-2 ... > span
                    // It is always present in the DOM (just hidden on mobile via CSS).
                    let postedAt = null;
                    const timeDivDesktop = card.querySelector(
                        'div.absolute.top-2.right-2 span, div[class*="top-2"][class*="right-2"] span'
                    );
                    if (timeDivDesktop) {
                        postedAt = parseBadge(timeDivDesktop.textContent);
                    }
                    // Mobile badge fallback: first <span> inside the mobile time div
                    if (postedAt === null) {
                        const mobileSpans = card.querySelectorAll('div.md\\:hidden span');
                        for (const sp of mobileSpans) {
                            const t = parseBadge(sp.textContent);
                            if (t !== null) { postedAt = t; break; }
                        }
                    }
                    if (postedAt === null) postedAt = Date.now();

                    // ── Title ─────────────────────────────────────────────────
                    // span with both font-bold and line-clamp-3 classes
                    const titleEl = card.querySelector(
                        'span.font-bold.line-clamp-3, span[class*="line-clamp-3"][class*="font-bold"]'
                    );
                    if (!titleEl) continue;
                    const title = titleEl.textContent.trim();
                    if (!title) continue;

                    // ── Location ──────────────────────────────────────────────
                    // span.line-clamp-2 that is a sibling of the location-pin SVG
                    // The pin SVG path starts with "M15 10.5a3 3"
                    let location = 'Libya';
                    const allSpansLineclamp2 = card.querySelectorAll('span.line-clamp-2');
                    for (const sp of allSpansLineclamp2) {
                        // Check that the parent div contains a location-pin SVG
                        const parentDiv = sp.parentElement;
                        if (!parentDiv) continue;
                        const svgPaths = parentDiv.querySelectorAll('path');
                        let hasLocPin = false;
                        for (const path of svgPaths) {
                            if ((path.getAttribute('d') || '').startsWith(LOC_PIN_PATH)) {
                                hasLocPin = true;
                                break;
                            }
                        }
                        if (hasLocPin) {
                            location = sp.textContent.trim();
                            break;
                        }
                    }

                    // ── Company ───────────────────────────────────────────────
                    // img[alt] inside the card — alt attribute is the company name
                    let company = '';
                    const logoImg = card.querySelector('img[alt]');
                    if (logoImg) {
                        company = logoImg.getAttribute('alt').trim();
                    }

                    // ── Job ID ────────────────────────────────────────────────
                    const jobId = href.split('/job/')[1]?.split(/[/?#]/)[0] || String(Date.now());

                    results.push({
                        id: `hiringcafe_${jobId}`,
                        title,
                        url: href,
                        location,
                        company,
                        postedAt,
                    });
                }

                return results;
            });

            if (!jobs.length) {
                console.warn('[Jobs] HiringCafe: no cards found');
                return [];
            }

            // Sort by most recent first
            jobs.sort((a, b) => b.postedAt - a.postedAt);

            // Log all found jobs for debugging
            console.log(`[Jobs] HiringCafe found ${jobs.length} cards:`);
            for (const j of jobs.slice(0, 5)) {
                const ago = Math.round((Date.now() - j.postedAt) / 3_600_000 * 10) / 10;
                console.log(`  [${ago}h ago] ${j.title} | ${j.location} | ${j.company}`);
            }

            const top = jobs[0];
            return [{
                id: top.id,
                title: top.title,
                location: top.location,
                company: top.company || '',
                url: top.url,
                postedAt: new Date(top.postedAt),
                source: 'hiringcafe',
            }];
        });
    } catch (err) {
        console.error('[Jobs] HiringCafe error:', err.message);
        return [];
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Source 3 — LibyanJobs.ly (axios — no JS rendering needed)
//
// libyanjobs.ly is a standard WordPress/PHP site that renders job cards in
// plain HTML, so we can use a simple axios GET instead of Playwright.
// The listing page: https://libyanjobs.ly/jobs/?display=list
//
// EXACT SELECTORS (from real devtools HTML):
//   Card root:  article[data-url]  (class includes "loadmore-item")
//   URL:        article[data-url]          → full absolute URL
//   Title:      h3.loop-item-title a       → job title (may be Arabic)
//   Company:    span.job-company a span    → company name
//   Location:   span.job-location a em     → "Tripoli / طرابلس"
//   Timestamp:  time.entry-date[datetime]  → ISO 8601, e.g. "2026-05-29T17:36:33+02:00"
//   Ago text:   span.job-date-ago          → "6 hours ago" (fallback only)
//   Job ID:     last path segment of data-url, e.g. "business-development-551925"
// ─────────────────────────────────────────────────────────────────────────────
async function fetchLibyanJobsJobs() {
    const LIST_URL = 'https://libyanjobs.ly/jobs/?display=list';

    try {
        const axios    = require('axios');
        const cheerio  = require('cheerio');

        const response = await axios.get(LIST_URL, {
            timeout: 20000,
            headers: {
                'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-GB,en;q=0.9',
            },
        });

        const $ = cheerio.load(response.data);

        function parseRelative(text) {
            const m = (text || '').match(/(\d+)\s+(minute|hour|day|week)s?/i);
            if (!m) return null;
            const v = parseInt(m[1]);
            const u = m[2].toLowerCase();
            if (u === 'minute') return Date.now() - v * 60_000;
            if (u === 'hour')   return Date.now() - v * 3_600_000;
            if (u === 'day')    return Date.now() - v * 86_400_000;
            if (u === 'week')   return Date.now() - v * 604_800_000;
            return null;
        }

        const jobs = [];

        $('article[data-url]').each((_, el) => {
            const art = $(el);

            // ── URL ───────────────────────────────────────────────────────────
            const url = art.attr('data-url');
            if (!url) return;

            // ── Title ─────────────────────────────────────────────────────────
            const title = art.find('h3.loop-item-title a').text().trim();
            if (!title) return;

            // ── Company ───────────────────────────────────────────────────────
            const company = art.find('span.job-company a span').first().text().trim();

            // ── Location ──────────────────────────────────────────────────────
            // "Tripoli / طرابلس" — keep the full string, it's informative
            const location = art.find('span.job-location a em').text().trim() || 'Libya';

            // ── Timestamp ─────────────────────────────────────────────────────
            // Prefer the ISO datetime attribute on <time> — exact to the second.
            // Fall back to the "X hours ago" badge text if datetime is missing.
            let postedAt = null;
            const datetimeAttr = art.find('time.entry-date').attr('datetime');
            if (datetimeAttr) {
                const parsed = Date.parse(datetimeAttr);
                if (!isNaN(parsed)) postedAt = parsed;
            }
            if (postedAt === null) {
                const agoText = art.find('span.job-date-ago').text().trim();
                postedAt = parseRelative(agoText) ?? Date.now();
            }

            // ── Job ID ────────────────────────────────────────────────────────
            // Last non-empty path segment of the URL, e.g. "business-development-551925"
            const idSlug = url.split('/').filter(Boolean).pop() || String(Date.now());

            jobs.push({
                id:       `libyanjobs_${idSlug}`,
                title,
                url,
                location,
                company,
                postedAt,
                source:   'libyanjobs',
            });
        });

        if (!jobs.length) {
            console.warn('[Jobs] LibyanJobs: no cards found');
            return [];
        }

        jobs.sort((a, b) => b.postedAt - a.postedAt);

        console.log(`[Jobs] LibyanJobs: found ${jobs.length} jobs, latest: "${jobs[0].title}" @ ${jobs[0].location}`);

        const top = jobs[0];
        return [{
            ...top,
            postedAt: new Date(top.postedAt),
        }];

    } catch (err) {
        console.error('[Jobs] LibyanJobs error:', err.message);
        return [];
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Combine all sources → return the single most recent job across all of them.
// Each source runs in parallel; failures are isolated.
// ─────────────────────────────────────────────────────────────────────────────
async function getLatestJob() {
    const results = await Promise.allSettled([
        fetchOpenSooqJobs(),
        fetchHiringCafeJobs(),
        fetchLibyanJobsJobs(),
    ]);

    const allJobs = [];
    for (const res of results) {
        if (res.status === 'fulfilled') allJobs.push(...res.value);
    }

    if (!allJobs.length) return null;
    allJobs.sort((a, b) => b.postedAt - a.postedAt);
    return allJobs[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// Persistent data helpers
// ─────────────────────────────────────────────────────────────────────────────
function getJobsData(db, guildId) {
    if (!db[guildId]) db[guildId] = {};
    if (!db[guildId].__jobs) {
        db[guildId].__jobs = {
            channelId: null,
            postedIds:     [],  // source-specific IDs
            postedUrls:    [],  // stable job page URLs — most reliable dedup key
            postedTitles:  [],  // normalised title fingerprints for cross-source dedup
            lastCheckedAt: null,
            history: [],
        };
    }
    // Ensure all array fields exist — must come BEFORE any .length/.includes calls
    // so that saved data from older versions without these fields doesn't crash.
    const s = db[guildId].__jobs;
    if (!s.postedIds)    s.postedIds    = [];
    if (!s.postedUrls)   s.postedUrls   = [];
    if (!s.postedTitles) s.postedTitles = [];
    // Migrate lastPostedId from the original single-ID version
    if (s.lastPostedId) {
        if (!s.postedIds.includes(s.lastPostedId)) s.postedIds.push(s.lastPostedId);
        delete s.lastPostedId;
    }
    return s;
}

// Normalise a job title into a fingerprint for cross-source duplicate detection.
// Strips punctuation, extra spaces, and lowercases so that minor formatting
// differences between sources don't prevent a match.
function titleFingerprint(title) {
    return title.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Build and post the Discord embed
// ─────────────────────────────────────────────────────────────────────────────
async function postJobsUpdate(client, jobsState, job) {
    if (!jobsState.channelId) return false;
    const channel = await client.channels.fetch(jobsState.channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return false;

    // Friendly source label
    const sourceLabels = {
        opensooq:   '🔵 OpenSooq',
        hiringcafe: '🟢 Hiring.cafe',
        libyanjobs: '🔴 LibyanJobs',
    };
    const sourceLabel = sourceLabels[job.source] || job.source;

    const embed = new EmbedBuilder()
        .setColor(SOURCE_COLORS[job.source] ?? 0x2B5B84)
        .setTitle(`💼 ${job.title}`)
        .setURL(job.url)
        .addFields(
            { name: '📍 Location', value: job.location || 'Libya', inline: true },
            { name: '⏱️ Posted',   value: `<t:${Math.floor(job.postedAt.getTime() / 1000)}:R>`, inline: true },
        );

    if (job.company) {
        embed.addFields({ name: '🏢 Company', value: job.company, inline: true });
    }

    embed
        .setFooter({ text: `${sourceLabel} • Checked every 15 minutes` })
        .setTimestamp();

    await channel.send({ embeds: [embed] });
    return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main update cycle
// ─────────────────────────────────────────────────────────────────────────────
async function updateJobs({ client, db, saveData, guildId, forcePost = false }) {
    const jobsState = getJobsData(db, guildId);
    jobsState.lastCheckedAt = new Date().toISOString();

    const latest = await getLatestJob();
    if (!latest) {
        console.warn(`[Jobs] No job found for guild ${guildId}`);
        return { posted: false, isNew: false };
    }

    // A job is considered already-posted if ANY of these match:
    //   (a) its exact source ID is in postedIds
    //   (b) its URL is in postedUrls  ← most reliable for hiring.cafe repeat posts
    //   (c) its title fingerprint matches a recently posted title
    //       (catches the same listing appearing on multiple sources)
    const fp = titleFingerprint(latest.title);
    const alreadyPosted =
        jobsState.postedIds.includes(latest.id) ||
        jobsState.postedUrls.includes(latest.url) ||
        jobsState.postedTitles.includes(fp);

    const isNew = !alreadyPosted;

    jobsState.history = jobsState.history || [];
    jobsState.history.push({ ...latest, postedAt: latest.postedAt.toISOString() });
    jobsState.history = jobsState.history.slice(-MAX_HISTORY);

    let posted = false;
    if (forcePost || isNew) {
        posted = await postJobsUpdate(client, jobsState, latest);
        if (posted) {
            // Record the ID, URL, and title fingerprint
            jobsState.postedIds.push(latest.id);
            jobsState.postedUrls.push(latest.url);
            jobsState.postedTitles.push(fp);
            // Keep only the last 200 entries so the arrays don't grow forever
            jobsState.postedIds    = jobsState.postedIds.slice(-200);
            jobsState.postedUrls   = jobsState.postedUrls.slice(-200);
            jobsState.postedTitles = jobsState.postedTitles.slice(-200);
        }
    }

    saveData(guildId);
    return { posted, isNew };
}

// ─────────────────────────────────────────────────────────────────────────────
// Interaction helpers
// ─────────────────────────────────────────────────────────────────────────────
function isAdmin(interaction) {
    return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
}

async function safeReply(interaction, payload) {
    try {
        if (interaction.replied)  return interaction.followUp(payload).catch(() => {});
        if (interaction.deferred) return interaction.editReply(payload).catch(() => {});
        return interaction.reply(payload);
    } catch (err) {
        console.error('safeReply failed:', err.message);
    }
}

async function safeDefer(interaction, opts = {}) {
    try {
        if (!interaction.replied && !interaction.deferred) await interaction.deferReply(opts);
    } catch (err) {
        console.error('safeDefer failed:', err.message);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Slash-command definitions
// ─────────────────────────────────────────────────────────────────────────────
const jobsCommands = [
    new SlashCommandBuilder()
        .setName('jobs-set-channel')
        .setDescription('Set the channel for automatic job postings (Admin only)')
        .addChannelOption(o =>
            o.setName('channel').setDescription('Text channel').setRequired(true)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .setDMPermission(false),

    new SlashCommandBuilder()
        .setName('jobs-refresh')
        .setDescription('Manually check for new jobs across all sources (Admin only)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .setDMPermission(false),
].map(cmd => cmd.toJSON());

// ─────────────────────────────────────────────────────────────────────────────
// Module initialisation
// ─────────────────────────────────────────────────────────────────────────────
module.exports = function initJobs({ client, db, saveData }) {
    const timers = new Map();

    function scheduleGuild(guildId) {
        if (timers.has(guildId)) clearInterval(timers.get(guildId));
        const timer = setInterval(() => {
            updateJobs({ client, db, saveData, guildId }).catch(err => {
                console.error(`[Jobs] Update failed for guild ${guildId}:`, err.message);
            });
        }, CHECK_INTERVAL_MS);
        timers.set(guildId, timer);
    }

    client.once('clientReady', async () => {
        // Small delay to let the rest of the bot finish booting
        setTimeout(() => {
            for (const guild of client.guilds.cache.values()) {
                const jobsState = getJobsData(db, guild.id);
                if (jobsState.channelId) {
                    console.log(`💼 Jobs updates active → guild "${guild.name}" channel ${jobsState.channelId}`);
                    scheduleGuild(guild.id);
                }
            }
        }, 6000);
    });

    client.on('interactionCreate', async (interaction) => {
        if (!interaction.isChatInputCommand() || !interaction.guild) return;
        const { commandName, guild } = interaction;
        if (!commandName.startsWith('jobs-')) return;

        try {
            // ── /jobs-set-channel ────────────────────────────────────────────
            if (commandName === 'jobs-set-channel') {
                if (!isAdmin(interaction)) {
                    return safeReply(interaction, { content: '❌ Admin only.', flags: 64 });
                }
                const channel = interaction.options.getChannel('channel');
                if (!channel || !channel.isTextBased()) {
                    return safeReply(interaction, { content: '❌ Please choose a text channel.', flags: 64 });
                }

                const jobsState = getJobsData(db, guild.id);
                jobsState.channelId = channel.id;
                saveData(guild.id);
                scheduleGuild(guild.id);

                await safeReply(interaction, {
                    content: `💼 Jobs will now be posted in ${channel}. Fetching from all sources now…`,
                    flags: 64,
                });
                await updateJobs({ client, db, saveData, guildId: guild.id, forcePost: true });
                return;
            }

            // ── /jobs-refresh ────────────────────────────────────────────────
            if (commandName === 'jobs-refresh') {
                if (!isAdmin(interaction)) {
                    return safeReply(interaction, { content: '❌ Admin only.', flags: 64 });
                }
                await safeDefer(interaction, { flags: 64 });
                const result = await updateJobs({ client, db, saveData, guildId: guild.id, forcePost: true });
                const status = result.posted
                    ? '✅ Posted the latest job.'
                    : 'ℹ️ No new job found (or no channel set).';
                return safeReply(interaction, { content: `💼 Refresh complete. ${status}` });
            }

        } catch (err) {
            console.error(`[Jobs] Command error (${commandName}):`, err);
            return safeReply(interaction, {
                content: `❌ Jobs error: ${err.message.slice(0, 200)}`,
                flags: 64,
            });
        }
    });
};

module.exports.commands = jobsCommands;
