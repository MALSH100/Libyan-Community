// jobs.js
const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');

// === CONFIGURATION ===
const CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const MAX_HISTORY = 50;

// Colour per source for embed visuals
const SOURCE_COLORS = {
    opensooq:  0x2B5B84,
    careerjet: 0xE8612C,
    hiringcafe: 0x1DB954,
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
// Source 2 — Careerjet (Playwright with stealth headers)
//
// Careerjet blocks plain HTTP clients.  We use Playwright with realistic
// headers to get past the bot-detection page and scrape the listing cards.
// ─────────────────────────────────────────────────────────────────────────────
async function fetchCareerjetJobs() {
    try {
        return await withBrowser(async (browser) => {
            const context = await browser.newContext({
                userAgent:
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
                    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
                    'Chrome/124.0.0.0 Safari/537.36',
                locale: 'en-GB',
                extraHTTPHeaders: {
                    'Accept-Language': 'en-GB,en;q=0.9',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                },
            });

            const page = await context.newPage();

            // Block heavy assets
            await page.route('**/*', (route) => {
                const type = route.request().resourceType();
                if (['image', 'media', 'font', 'stylesheet'].includes(type)) return route.abort();
                return route.continue();
            });

            await page.goto('https://www.careerjet.ly/jobs?s=&l=Libya&sort=date', {
                waitUntil: 'domcontentloaded',
                timeout: 30000,
            });

            // If we hit the bot-detection page, bail out gracefully
            const bodyText = await page.innerText('body').catch(() => '');
            if (bodyText.includes('unusual traffic') || bodyText.includes('robot')) {
                console.warn('[Jobs] Careerjet: bot-detection page hit, skipping this cycle.');
                return [];
            }

            const jobs = await page.evaluate(() => {
                // Careerjet job cards: <article class="job clicky"> or <li> containing <header>
                const articles = Array.from(
                    document.querySelectorAll('article.job, ul.jobs li')
                );

                const results = [];

                for (const art of articles) {
                    // Title & URL
                    const titleEl = art.querySelector('h2 a, header h2 a, .title a');
                    if (!titleEl) continue;
                    const title = titleEl.innerText.trim();
                    const url   = titleEl.href;
                    if (!url || !title) continue;

                    // Company
                    const companyEl = art.querySelector('.company, p.company');
                    const company = companyEl ? companyEl.innerText.trim() : '';

                    // Location
                    const locEl = art.querySelector('.location, p.location');
                    const location = locEl ? locEl.innerText.trim() : 'Libya';

                    // Posted date — Careerjet shows "X days ago" or an absolute date
                    let postedAt = Date.now();
                    const dateEl = art.querySelector('.date, p.date, time');
                    if (dateEl) {
                        const raw = dateEl.innerText.trim();
                        // "X days ago" / "X hours ago"
                        const relMatch = raw.match(/(\d+)\s+(hour|day|week)s?\s+ago/i);
                        if (relMatch) {
                            const v = parseInt(relMatch[1]);
                            const u = relMatch[2].toLowerCase();
                            if (u === 'hour')   postedAt = Date.now() - v * 3_600_000;
                            else if (u === 'day')  postedAt = Date.now() - v * 86_400_000;
                            else if (u === 'week') postedAt = Date.now() - v * 604_800_000;
                        } else {
                            // Try parsing absolute date strings like "29 May 2026"
                            const parsed = Date.parse(raw);
                            if (!isNaN(parsed)) postedAt = parsed;
                        }
                    }

                    // Unique ID from URL slug
                    const idSlug = url.split('/').filter(Boolean).pop() || String(Date.now());

                    results.push({ title, url, location, company, postedAt, id: `careerjet_${idSlug}` });
                }

                return results;
            });

            if (!jobs.length) return [];

            jobs.sort((a, b) => b.postedAt - a.postedAt);
            const top = jobs[0];

            return [{
                id: top.id,
                title: top.title,
                location: top.location,
                company: top.company || '',
                url: top.url,
                postedAt: new Date(top.postedAt),
                source: 'careerjet',
            }];
        });
    } catch (err) {
        console.error('[Jobs] Careerjet error:', err.message);
        return [];
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Source 3 — Hiring.cafe (Playwright)
//
// Hiring.cafe is a fully client-side React SPA.  The Libya search state is
// encoded in a large URL query param.  We navigate to that URL, wait for the
// job cards to render, then extract the most recent listing.
//
// NOTE: hiring.cafe has noindex/nofollow and loads via JS — there is no usable
// public API or RSS.  Playwright is the only reliable approach.
// ─────────────────────────────────────────────────────────────────────────────
async function fetchHiringCafeJobs() {
    // Libya search, sorted by date
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

            // Intercept hiring.cafe's internal API calls so we can also log
            // what the network returns — useful for future debugging.
            await page.goto(URL, { waitUntil: 'networkidle', timeout: 45000 });

            // Wait until job cards are visible.  Each card contains a
            // "Job Posting" link whose href starts with /job/.
            await page.waitForSelector('a[href^="/job/"]', { timeout: 20000 }).catch(() => {});

            // Give React one extra beat to finish rendering text nodes
            await page.waitForTimeout(1500);

            // Dump the full card HTML so we can parse it precisely.
            // Strategy:
            //   1. Find every <a href="/job/..."> (the "Job Posting" CTA link).
            //   2. Walk UP the DOM until we hit a container that also holds a
            //      <time datetime="..."> element — that is the card root.
            //   3. Inside that card root, extract:
            //        • title  — the largest / first heading-like text node,
            //                   NOT the "Job Posting" link text itself
            //        • time   — prefer <time datetime="ISO"> for exact ms;
            //                   fall back to the visible "Xh / Xd" badge text
            //        • location — the text node that contains the city/country,
            //                   which typically follows the work-type badge
            //        • company — text from <a href="/org/...">
            const jobs = await page.evaluate(() => {
                // ── helpers ──────────────────────────────────────────────────
                function parseRelative(text) {
                    // Matches "4h", "2d", "30m", "3 hours ago", "1 day ago" etc.
                    const m = text.match(/(\d+)\s*(m(?:in(?:ute)?s?)?|h(?:(?:ou)?rs?)?|d(?:(?:ay)?s?)?)/i);
                    if (!m) return null;
                    const v = parseInt(m[1]);
                    const u = m[2][0].toLowerCase();
                    if (u === 'm') return Date.now() - v * 60_000;
                    if (u === 'h') return Date.now() - v * 3_600_000;
                    if (u === 'd') return Date.now() - v * 86_400_000;
                    return null;
                }

                function cardRoot(el) {
                    // Walk up until we find an element that has a <time> child
                    // OR until we've gone 10 levels — whichever comes first.
                    let node = el;
                    for (let i = 0; i < 10; i++) {
                        if (!node.parentElement) break;
                        node = node.parentElement;
                        if (node.querySelector('time[datetime]')) return node;
                    }
                    // Fallback: return 5 levels up
                    node = el;
                    for (let i = 0; i < 5; i++) {
                        if (!node.parentElement) break;
                        node = node.parentElement;
                    }
                    return node;
                }

                // ── collect cards ─────────────────────────────────────────────
                // hiring.cafe renders each job as a block that contains:
                //   • A <time datetime="..."> with the ISO post date
                //   • An <a href="/job/ID">Job Posting</a> CTA
                //   • An <a href="/org/domain">Company name</a> CTA
                //   • Visible text lines: title, location, work-type, etc.

                const jobLinks = Array.from(document.querySelectorAll('a[href^="/job/"]'));
                const seen = new Set();
                const results = [];

                for (const jobLink of jobLinks) {
                    const href = jobLink.href;
                    if (!href || seen.has(href)) continue;
                    seen.add(href);

                    const card = cardRoot(jobLink);

                    // ── 1. Timestamp ──────────────────────────────────────────
                    let postedAt = Date.now();
                    const timeEl = card.querySelector('time[datetime]');
                    if (timeEl) {
                        const iso = timeEl.getAttribute('datetime');
                        const parsed = Date.parse(iso);
                        if (!isNaN(parsed)) {
                            postedAt = parsed;
                        } else {
                            // datetime attr may be relative text too
                            const rel = parseRelative(iso || timeEl.innerText);
                            if (rel !== null) postedAt = rel;
                        }
                    } else {
                        // Fall back to badge text like "4h" or "2d"
                        const rel = parseRelative(card.innerText);
                        if (rel !== null) postedAt = rel;
                    }

                    // ── 2. Title ──────────────────────────────────────────────
                    // The title is NOT inside the /job/ link — it's a heading
                    // element or a prominent text node in the card.
                    // hiring.cafe typically uses: h2, h3, or a div with role heading,
                    // or the first substantial text child of the card.
                    let title = '';
                    const headingEl = card.querySelector('h1, h2, h3, h4, [role="heading"]');
                    if (headingEl) {
                        title = headingEl.innerText.trim();
                    }
                    if (!title) {
                        // Split card text into lines, discard tiny tokens and
                        // known UI labels, pick the first real sentence.
                        const skipPatterns = /^(\d+[hmd]|save|hide|mark applied|job posting|view all|full time|part time|contract|remote|onsite|hybrid|\d+\+\s*yoe|\$[\d,k/yr]+)$/i;
                        const lines = card.innerText.split('\n').map(l => l.trim()).filter(Boolean);
                        for (const line of lines) {
                            if (line.length >= 8 && !skipPatterns.test(line)) {
                                title = line;
                                break;
                            }
                        }
                    }
                    if (!title || title.length < 3) continue;

                    // ── 3. Location ───────────────────────────────────────────
                    // Location in hiring.cafe looks like:
                    //   "Tripoli, Libya" or "Libya" or "Remote, Libya"
                    // It is a plain text node — NOT a link.
                    // We scan all text lines and pick the one that contains
                    // "Libya" (case-insensitive).  We want the FULL line, not
                    // just the word "Libya", so we get city info too.
                    let location = 'Libya';
                    const cardLines = card.innerText.split('\n').map(l => l.trim()).filter(Boolean);
                    for (const line of cardLines) {
                        if (/libya/i.test(line) && line.length <= 80) {
                            // Make sure it's not a UI label like "Save Search"
                            if (!/save|search|apply|hide|posted|company/i.test(line)) {
                                location = line;
                                break;
                            }
                        }
                    }

                    // ── 4. Company ────────────────────────────────────────────
                    let company = '';
                    const orgLink = card.querySelector('a[href^="/org/"]');
                    if (orgLink) {
                        // The org link text is "Company name: short description"
                        // We only want the name before the colon.
                        company = orgLink.innerText.split(':')[0].trim();
                    }

                    // ── 5. Job ID ─────────────────────────────────────────────
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

            if (!jobs.length) return [];

            jobs.sort((a, b) => b.postedAt - a.postedAt);

            // Deduplicate by ID
            const seen = new Set();
            const unique = [];
            for (const j of jobs) {
                if (!seen.has(j.id)) { seen.add(j.id); unique.push(j); }
            }

            const top = unique[0];
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
// Combine all sources → return the single most recent job across all of them.
// Each source runs in parallel; failures are isolated.
// ─────────────────────────────────────────────────────────────────────────────
async function getLatestJob() {
    const results = await Promise.allSettled([
        fetchOpenSooqJobs(),
        fetchCareerjetJobs(),
        fetchHiringCafeJobs(),
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
            lastPostedId: null,
            lastCheckedAt: null,
            history: [],
        };
    }
    return db[guildId].__jobs;
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
        opensooq:  '🔵 OpenSooq',
        careerjet: '🟠 Careerjet',
        hiringcafe:'🟢 Hiring.cafe',
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

    const isNew = latest.id !== jobsState.lastPostedId;

    jobsState.history = jobsState.history || [];
    jobsState.history.push(latest);
    jobsState.history = jobsState.history.slice(-MAX_HISTORY);

    let posted = false;
    if (forcePost || isNew) {
        posted = await postJobsUpdate(client, jobsState, latest);
        if (posted) jobsState.lastPostedId = latest.id;
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
