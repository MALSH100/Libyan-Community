// jobs.js
const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const axios = require('axios');

// === CONFIGURATION ===
const CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_HISTORY = 50;

// ----------------------------------------------------------------------
// Source 1: OpenSooq (Playwright)
// ----------------------------------------------------------------------
async function fetchOpenSooqJobs() {
    const { chromium } = require('playwright');
    let browser;
    try {
        browser = await chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        });
        const page = await browser.newPage();
        await page.goto('https://ly.opensooq.com/en/jobs/job-vacancies?search=true&sort_code=recent', {
            waitUntil: 'domcontentloaded',
            timeout: 30000
        });
        
        await page.waitForFunction(() => {
            return document.body.innerText.match(/\d+\s+(minute|hour|day|week)s?\s+ago/i);
        }, { timeout: 15000 });
        
        const jobData = await page.evaluate(() => {
            // Find the first card with a job link and a time indicator
            const cards = Array.from(document.querySelectorAll('div, li, article')).filter(el => {
                const hasLink = el.querySelector('a[href*="/job-posters/"]');
                const hasTime = /\d+\s+(minute|hour|day|week)s?\s+ago/i.test(el.innerText);
                return hasLink && hasTime;
            });
            if (cards.length === 0) return null;
            const card = cards[0];
            const link = card.querySelector('a[href*="/job-posters/"]');
            if (!link) return null;
            
            // Clean title (remove time prefix, split at " - ", remove contract suffix)
            let title = link.innerText.trim();
            title = title.replace(/^\d+\s+(minute|hour|day|week)s?\s+ago\s*/i, '');
            title = title.split(' - ')[0].trim();
            title = title.replace(/\s+(Full Time|Part Time|Freelance|Contract)$/i, '').trim();
            
            // Extract time
            const timeMatch = card.innerText.match(/\b(\d+)\s+(minute|hour|day|week)s?\s+ago\b/i);
            if (!timeMatch) return null;
            const value = parseInt(timeMatch[1]);
            const unit = timeMatch[2].toLowerCase();
            const now = new Date();
            let date;
            if (unit === 'minute') date = new Date(now - value * 60000);
            else if (unit === 'hour') date = new Date(now - value * 3600000);
            else if (unit === 'day') date = new Date(now - value * 86400000);
            else if (unit === 'week') date = new Date(now - value * 604800000);
            else date = now;
            
            // Extract location – skip lines that contain the title or job details
            const lines = card.innerText.split('\n').map(l => l.trim()).filter(l => l);
            let location = 'Libya';
            const titleLower = title.toLowerCase();
            for (const line of lines) {
                const lineLower = line.toLowerCase();
                if (lineLower.includes(titleLower)) continue;
                if (lineLower.includes('contract') || lineLower.includes('working') || 
                    lineLower.includes('salary') || lineLower.includes('benefits')) continue;
                if (line.match(/Tripoli|Benghazi|Misrata|Arada|Tajoura|Zawiya|Sabha|Bayda|Derna|Sirte/i) || 
                    (line.includes(',') && line.length < 50)) {
                    location = line;
                    break;
                }
            }
            
            return {
                title,
                url: link.href,
                location,
                postedAt: date.getTime()
            };
        });
        
        await browser.close();
        if (!jobData) return [];
        return [{
            id: `opensooq_${jobData.url.split('/').pop() || Date.now()}`,
            title: jobData.title,
            location: jobData.location,
            url: jobData.url,
            postedAt: new Date(jobData.postedAt),
            source: 'opensooq'
        }];
    } catch (err) {
        console.error('[Jobs] OpenSooq error:', err.message);
        if (browser) await browser.close().catch(() => {});
        return [];
    }
}

// ----------------------------------------------------------------------
// Careerjet and hiring.cafe are disabled (return empty)
// ----------------------------------------------------------------------
async function fetchCareerjetJobs() { return []; }
async function fetchHiringCafeJobs() { return []; }

// ----------------------------------------------------------------------
// Combine sources
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
    allJobs.sort((a, b) => b.postedAt - a.postedAt);
    return allJobs[0];
}

// ----------------------------------------------------------------------
// Persistent data helpers
// ----------------------------------------------------------------------
function getJobsData(db, guildId) {
    if (!db[guildId]) db[guildId] = {};
    if (!db[guildId].__jobs) {
        db[guildId].__jobs = {
            channelId: null,
            lastPostedId: null,
            lastCheckedAt: null,
            history: []
        };
    }
    return db[guildId].__jobs;
}

// ----------------------------------------------------------------------
// Post embed
// ----------------------------------------------------------------------
async function postJobsUpdate(client, jobsState, job, forced = false) {
    if (!jobsState.channelId) return false;
    const channel = await client.channels.fetch(jobsState.channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return false;

    const embed = new EmbedBuilder()
        .setColor(0x2B5B84)
        .setTitle(`💼 ${job.title}`)
        .setURL(job.url)
        .addFields(
            { name: '📍 Location', value: job.location || 'Libya', inline: true },
            { name: '⏱️ Posted', value: `<t:${Math.floor(job.postedAt.getTime() / 1000)}:R>`, inline: true }
        )
        .setFooter({ text: `${job.source} • Jobs updated every 30 minutes` })
        .setTimestamp();

    await channel.send({ embeds: [embed] });
    return true;
}
// ----------------------------------------------------------------------
// Main update
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
// Slash commands
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
// Module initialisation
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
