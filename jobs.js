// jobs.js
const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const axios = require('axios');
const cheerio = require('cheerio');

// === CONFIGURATION ===
const CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_HISTORY = 50;

// Careerjet API key (from environment variable)
const CAREERJET_API_KEY = process.env.CAREERJET_API_KEY || '73f7f75049a63e4dbbeaad53d1b5f11d';

// ----------------------------------------------------------------------
// Source 1: hiring.cafe (public API)
// ----------------------------------------------------------------------
async function fetchHiringCafeJobs() {
    // hiring.cafe does not provide a public API – disabling this source.
    return [];
}

// ----------------------------------------------------------------------
// Source 2: careerjet (official API)
// ----------------------------------------------------------------------

// --- Job Fetcher: Careerjet (official API) ---
async function fetchCareerjetJobs() {
    // TODO: whitelist the IP in Careerjet dashboard
    console.log('[Jobs] Careerjet disabled – waiting for IP whitelist');
    return [];
}



// ----------------------------------------------------------------------
// Source 3: opensooq.com (scraping)
// ----------------------------------------------------------------------
async function fetchOpenSooqJobs() {
    let browser;
    try {
        const { chromium } = require('playwright');
        browser = await chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        });
        const page = await browser.newPage();
        await page.goto('https://ly.opensooq.com/en/jobs/job-vacancies?search=true&sort_code=recent', {
            waitUntil: 'domcontentloaded',
            timeout: 30000
        });
        
        // Wait for job links to be present
        await page.waitForSelector('a[href*="/job-vacancies/"]', { timeout: 15000, state: 'attached' });
        
        const jobs = await page.evaluate(() => {
            const links = Array.from(document.querySelectorAll('a[href*="/job-vacancies/"]'));
            const unique = new Map();
            for (const link of links) {
                const href = link.href;
                if (!unique.has(href)) unique.set(href, link);
            }
            const jobList = [];
            for (const link of unique.values()) {
                const title = link.innerText.trim();
                const url = link.href;
                // Try to find date – look for a nearby element containing time
                let date = null;
                let parent = link.closest('div, li, article');
                if (parent) {
                    const timeElement = parent.querySelector('time, [datetime], .date, .time, .posted-date');
                    if (timeElement) {
                        const dateStr = timeElement.innerText.trim() || timeElement.getAttribute('datetime');
                        if (dateStr) date = new Date(dateStr);
                    }
                    if (!date) {
                        // fallback: look for text like "Today", "Yesterday", "2 days ago"
                        const text = parent.innerText;
                        const match = text.match(/(\d+)\s+(minute|hour|day|week)s?\s+ago/i);
                        if (match) {
                            const value = parseInt(match[1]);
                            const unit = match[2].toLowerCase();
                            const now = new Date();
                            if (unit === 'minute') date = new Date(now - value * 60000);
                            else if (unit === 'hour') date = new Date(now - value * 3600000);
                            else if (unit === 'day') date = new Date(now - value * 86400000);
                            else if (unit === 'week') date = new Date(now - value * 604800000);
                        }
                    }
                }
                // Company and location extraction
                let company = 'Not specified';
                let location = 'Libya';
                if (parent) {
                    const lines = parent.innerText.split('\n');
                    for (const line of lines) {
                        const lower = line.toLowerCase();
                        if (lower.includes('company') || lower.includes('by ')) {
                            company = line.replace(/company|by/gi, '').trim();
                        }
                        if (lower.includes('tripoli') || lower.includes('benghazi') || lower.includes('misrata')) {
                            location = line.trim();
                        }
                    }
                }
                jobList.push({ title, url, company, location, date });
            }
            return jobList.filter(job => job.title && job.url);
        });
        
        // Sort by date (newest first) – if no date, put at end
        jobs.sort((a, b) => {
            if (!a.date && !b.date) return 0;
            if (!a.date) return 1;
            if (!b.date) return -1;
            return b.date - a.date;
        });
        
        console.log(`[Jobs] OpenSooq found ${jobs.length} jobs, newest date: ${jobs[0]?.date || 'unknown'}`);
        await browser.close();
        
        return jobs.slice(0, 5).map(job => ({
            id: `opensooq_${job.url.split('/').pop() || Date.now()}`,
            title: job.title,
            company: job.company,
            location: job.location,
            description: 'Click the link to view the full job description.',
            url: job.url,
            postedAt: job.date || new Date(),
            source: 'opensooq'
        }));
    } catch (err) {
        console.error('[Jobs] opensooq error:', err.message);
        if (browser) await browser.close().catch(() => {});
        return [];
    }
}
// ----------------------------------------------------------------------
// Combine all sources and get the single most recent job
// ----------------------------------------------------------------------
async function getLatestJob() {
    const results = await Promise.allSettled([
        fetchHiringCafeJobs(),
        fetchCareerjetJobs(),
        fetchOpenSooqJobs()
    ]);
    let allJobs = [];
    for (const res of results) {
        if (res.status === 'fulfilled') allJobs.push(...res.value);
    }
    if (allJobs.length === 0) return null;
    // sort by postedAt descending
    allJobs.sort((a, b) => b.postedAt - a.postedAt);
    return allJobs[0];
}

// ----------------------------------------------------------------------
// Persistent data helpers (same as news/exchange bots)
// ----------------------------------------------------------------------
function getJobsData(db, guildId) {
    if (!db[guildId]) db[guildId] = {};
    if (!db[guildId].__jobs) {
        db[guildId].__jobs = {
            channelId: null,
            lastPostedId: null,     // stores composite id of the most recent posted job
            lastCheckedAt: null,
            history: []
        };
    }
    return db[guildId].__jobs;
}

// ----------------------------------------------------------------------
// Post a job embed to Discord
// ----------------------------------------------------------------------
async function postJobsUpdate(client, jobsState, job, forced = false) {
    if (!jobsState.channelId) return false;
    const channel = await client.channels.fetch(jobsState.channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return false;

    const embed = new EmbedBuilder()
        .setColor(0x2B5B84)    // professional blue
        .setTitle(`💼 ${job.title}`)
        .setURL(job.url)
        .addFields(
            { name: '🏢 Company', value: job.company || 'Not specified', inline: true },
            { name: '📍 Location', value: job.location || 'Libya', inline: true },
            { name: '📅 Posted', value: `<t:${Math.floor(job.postedAt.getTime() / 1000)}:R>`, inline: true },
            { name: '📝 Description', value: job.description || 'Click the link to view the full job posting.' }
        )
        .setFooter({ text: `Source: ${job.source} • Jobs updated every 30 minutes` })
        .setTimestamp();

    await channel.send({ embeds: [embed] });
    return true;
}

// ----------------------------------------------------------------------
// Main update function (called by timer or /jobs-refresh)
// ----------------------------------------------------------------------
async function updateJobs({ client, db, saveData, guildId, forcePost = false }) {
    const jobsState = getJobsData(db, guildId);
    jobsState.lastCheckedAt = new Date().toISOString();

    const latest = await getLatestJob();
    if (!latest) {
        console.warn(`[Jobs] No job found for guild ${guildId}`);
        return { posted: false, isNew: false };
    }
    const isNew = latest.id !== jobsState.lastPostedId;

    // store in history (optional)
    jobsState.history = jobsState.history || [];
    jobsState.history.push(latest);
    jobsState.history = jobsState.history.slice(-MAX_HISTORY);

    let posted = false;
    if (forcePost || isNew) {
        posted = await postJobsUpdate(client, jobsState, latest, forcePost);
        if (posted) jobsState.lastPostedId = latest.id;
    }
    saveData(guildId);
    return { posted, isNew };
}

// ----------------------------------------------------------------------
// Admin & safe reply helpers
// ----------------------------------------------------------------------
function isAdmin(interaction) {
    return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
}

async function safeReply(interaction, payload) {
    try {
        if (interaction.replied) return await interaction.followUp(payload).catch(() => {});
        if (interaction.deferred) return await interaction.editReply(payload).catch(() => {});
        return await interaction.reply(payload);
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

// ----------------------------------------------------------------------
// Slash command definitions
// ----------------------------------------------------------------------
const jobsCommands = [
    new SlashCommandBuilder()
        .setName('jobs-set-channel')
        .setDescription('Set the channel for automatic job postings (Admin only)')
        .addChannelOption(o => o.setName('channel').setDescription('Text channel').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .setDMPermission(false),

    new SlashCommandBuilder()
        .setName('jobs-refresh')
        .setDescription('Manually check for new jobs (Admin only)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .setDMPermission(false),
].map(cmd => cmd.toJSON());

// ----------------------------------------------------------------------
// Module initialisation (called from index.js)
// ----------------------------------------------------------------------
module.exports = function initJobs({ client, db, saveData }) {
    const timers = new Map();

    function scheduleGuild(guildId) {
        if (timers.has(guildId)) clearInterval(timers.get(guildId));
        const timer = setInterval(() => {
            updateJobs({ client, db, saveData, guildId }).catch(err => {
                console.error(`Jobs update failed for guild ${guildId}:`, err.message);
            });
        }, CHECK_INTERVAL_MS);
        timers.set(guildId, timer);
    }

    client.once('clientReady', async () => {
        setTimeout(() => {
            for (const guild of client.guilds.cache.values()) {
                const jobsState = getJobsData(db, guild.id);
                if (jobsState.channelId) {
                    console.log(`💼 Jobs updates active for guild ${guild.name} → channel ${jobsState.channelId}`);
                    scheduleGuild(guild.id);
                }
            }
        }, 6000);
    });

    client.on('interactionCreate', async interaction => {
        if (!interaction.isChatInputCommand() || !interaction.guild) return;
        const { commandName, guild } = interaction;
        if (!commandName.startsWith('jobs-')) return;

        try {
            if (commandName === 'jobs-set-channel') {
                if (!isAdmin(interaction)) return safeReply(interaction, { content: '❌ Admin only.', flags: 64 });
                const channel = interaction.options.getChannel('channel');
                if (!channel || !channel.isTextBased()) return safeReply(interaction, { content: '❌ Please choose a text channel.', flags: 64 });

                const jobsState = getJobsData(db, guild.id);
                jobsState.channelId = channel.id;
                saveData(guild.id);
                scheduleGuild(guild.id);

                await safeReply(interaction, { content: `💼 Jobs will be posted in ${channel}. Fetching latest job now...`, flags: 64 });
                await updateJobs({ client, db, saveData, guildId: guild.id, forcePost: true });
                return;
            }

            if (commandName === 'jobs-refresh') {
                if (!isAdmin(interaction)) return safeReply(interaction, { content: '❌ Admin only.', flags: 64 });
                await safeDefer(interaction, { flags: 64 });
                const result = await updateJobs({ client, db, saveData, guildId: guild.id, forcePost: true });
                const statusText = result.posted ? '✅ Posted new job.' : 'ℹ️ No new job found (or no channel set).';
                return safeReply(interaction, { content: `💼 Jobs refresh complete. ${statusText}` });
            }
        } catch (err) {
            console.error(`Jobs command error (${commandName}):`, err);
            return safeReply(interaction, { content: `❌ Jobs error: ${err.message.slice(0, 200)}`, flags: 64 });
        }
    });
};

module.exports.commands = jobsCommands;
