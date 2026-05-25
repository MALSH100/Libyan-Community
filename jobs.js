// jobs.js
const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const axios = require('axios');
const cheerio = require('cheerio');

// === CONFIGURATION ===
const CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_HISTORY = 50;

// Careerjet API key (from environment variable)
const CAREERJET_API_KEY = process.env.CAREERJET_API_KEY || '1b7358b4274242b009f62e09dd750c73';

// ----------------------------------------------------------------------
// Source 1: hiring.cafe (public API)
// ----------------------------------------------------------------------
async function fetchHiringCafeJobs() {
    try {
        const url = 'https://api.hiring.cafe/v1/jobs/search?country=Libya&limit=5&sort=date';
        const res = await axios.get(url, { timeout: 10000 });
        const jobs = res.data.jobs || [];
        return jobs.map(job => ({
            id: `hiringcafe_${job.id || job.url}`,
            title: job.title,
            company: job.company,
            location: job.location || 'Libya',
            description: (job.description || '').slice(0, 200),
            url: job.url,
            postedAt: job.postedAt ? new Date(job.postedAt) : new Date(),
            source: 'hiring.cafe'
        }));
    } catch (err) {
        console.error('[Jobs] hiring.cafe error:', err.message);
        return [];
    }
}

// ----------------------------------------------------------------------
// Source 2: careerjet (official API)
// ----------------------------------------------------------------------
async function fetchCareerjetJobs() {
    if (!CAREERJET_API_KEY) {
        console.warn('[Jobs] CAREERJET_API_KEY not set');
        return [];
    }
    try {
        const params = {
            affiliateId: CAREERJET_API_KEY,
            location: 'Libya',
            sort: 'date',
            pagesize: 5,
            user_ip: 'auto',
            user_agent: 'Mozilla/5.0 (compatible; DiscordBot/1.0)'
        };
        const url = `https://api.careerjet.com/search/jobs?${new URLSearchParams(params)}`;
        const res = await axios.get(url, { timeout: 10000 });
        const jobs = res.data.jobs || [];
        return jobs.map(job => ({
            id: `careerjet_${job.id || job.url}`,
            title: job.title,
            company: job.company,
            location: job.locations?.[0] || 'Libya',
            description: (job.description || '').slice(0, 200),
            url: job.url,
            postedAt: job.date ? new Date(job.date) : new Date(),
            source: 'careerjet'
        }));
    } catch (err) {
        console.error('[Jobs] careerjet error:', err.message);
        return [];
    }
}

// ----------------------------------------------------------------------
// Source 3: opensooq.com (scraping)
// ----------------------------------------------------------------------
async function fetchOpenSooqJobs() {
    try {
        const url = 'https://ly.opensooq.com/en/jobs/job-vacancies?search=true&sort_code=recent';
        const { data: html } = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            timeout: 15000
        });
        const $ = cheerio.load(html);
        const jobs = [];
        
        // Each job listing is inside a div with class "ListingCell"
        $('div.ListingCell').each((i, el) => {
            if (i >= 5) return false; // only first 5
            const titleEl = $(el).find('h3 a');
            const title = titleEl.text().trim();
            const urlPath = titleEl.attr('href');
            const fullUrl = urlPath ? `https://ly.opensooq.com${urlPath}` : '';
            const detailsText = $(el).find('.details').text().trim();
            // try to extract company and location from details
            let company = '', location = '';
            const parts = detailsText.split('|').map(p => p.trim());
            if (parts.length >= 2) {
                company = parts[0];
                location = parts[1];
            } else {
                location = detailsText;
            }
            const description = $(el).find('.description').text().trim().slice(0, 200);
            // date is often in a span with class "date" or similar
            let dateText = $(el).find('.date').text().trim();
            let postedAt = new Date();
            if (dateText) {
                // rough parsing – opensooq shows "Today", "Yesterday", or "DD/MM/YYYY"
                if (dateText.toLowerCase().includes('today')) postedAt = new Date();
                else if (dateText.toLowerCase().includes('yesterday')) postedAt = new Date(Date.now() - 86400000);
                else {
                    const parsed = Date.parse(dateText);
                    if (!isNaN(parsed)) postedAt = new Date(parsed);
                }
            }
            if (title && fullUrl) {
                jobs.push({
                    id: `opensooq_${fullUrl.split('/').pop() || i}`,
                    title,
                    company: company || 'Not specified',
                    location: location || 'Libya',
                    description: description || 'Click the link for more details.',
                    url: fullUrl,
                    postedAt,
                    source: 'opensooq'
                });
            }
        });
        return jobs;
    } catch (err) {
        console.error('[Jobs] opensooq error:', err.message);
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