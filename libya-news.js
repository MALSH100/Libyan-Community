// libya-news.js
const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const axios = require('axios');
const cheerio = require('cheerio');

const SOURCE_URL = 'https://www.newsnow.co.uk/h/World+News/Africa/Libya?type=ln';
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const MAX_HISTORY = 50;

// --- Resolve final URL from NewsNow redirect ---
async function resolveFinalUrl(intermediateUrl) {
    try {
        const response = await axios.head(intermediateUrl, {
            maxRedirects: 0,
            validateStatus: (status) => status === 301 || status === 302,
        });
        const finalUrl = response.headers.location;
        return finalUrl || intermediateUrl;
    } catch (error) {
        console.error(`[News] Redirect resolution failed: ${error.message}`);
        return intermediateUrl;
    }
}

// --- Scrape the latest Libya news ---
async function getLatestLibyaNews() {
    try {
        const { data: html } = await axios.get(SOURCE_URL);
        const $ = cheerio.load(html);

        const firstHeadline = $('article .article-card__headline').first();
        if (!firstHeadline.length) throw new Error('No article headlines found.');

        const title = firstHeadline.find('.article-title').text().trim();
        const intermediateUrl = firstHeadline.attr('href');
        if (!title || !intermediateUrl) throw new Error('Missing title or link.');

        const finalUrl = await resolveFinalUrl(intermediateUrl);
        return {
            title,
            url: finalUrl,
            scrapedAt: new Date().toISOString(),
            sourceUrl: SOURCE_URL,
        };
    } catch (error) {
        console.error('[News] Scraping error:', error.message);
        throw new Error('Could not fetch the latest news from NewsNow.');
    }
}

// --- Persistent data helpers ---
function getNewsData(db, guildId) {
    if (!db[guildId]) db[guildId] = {};
    if (!db[guildId].__news) {
        db[guildId].__news = {
            channelId: null,
            lastPostedUrl: null,
            lastCheckedAt: null,
            history: [],
        };
    }
    return db[guildId].__news;
}

// --- Post to Discord (receives newsState directly) ---
async function postNewsUpdate(client, newsState, latestArticle, forced = false) {
    if (!newsState.channelId) return false;
    const channel = await client.channels.fetch(newsState.channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return false;

    const embed = new EmbedBuilder()
        .setColor(0x00A3E0)
        .setTitle(`📰 Latest Libya News`)
        .setDescription(`**[${latestArticle.title}](${latestArticle.url})**`)
        .setTimestamp(new Date(latestArticle.scrapedAt))
        .setFooter({ text: 'Source: NewsNow Libya' });

    await channel.send({ embeds: [embed] });
    return true;
}

// --- Main update function ---
async function updateNews({ client, db, saveData, guildId, forcePost = false }) {
    const newsState = getNewsData(db, guildId);
    newsState.lastCheckedAt = new Date().toISOString();

    const latestArticle = await getLatestLibyaNews();
    const isNew = latestArticle.url !== newsState.lastPostedUrl;

    newsState.history = newsState.history || [];
    newsState.history.push(latestArticle);
    newsState.history = newsState.history.slice(-MAX_HISTORY);

    let posted = false;
    if (forcePost || isNew) {
        posted = await postNewsUpdate(client, newsState, latestArticle, forcePost);
        if (posted) newsState.lastPostedUrl = latestArticle.url;
    }
    saveData(guildId);
    return { latestArticle, posted, isNew };
}

// --- Admin & safe reply helpers ---
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

// --- Slash command definitions ---
const newsCommands = [
    new SlashCommandBuilder()
        .setName('news-set-channel')
        .setDescription('Set the channel for hourly Libya news updates')
        .addChannelOption(o => o.setName('channel').setDescription('Channel to post news updates in').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .setDMPermission(false),

    new SlashCommandBuilder()
        .setName('news-refresh')
        .setDescription('Admin: Manually check for the latest Libya news')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .setDMPermission(false),
].map(cmd => cmd.toJSON());

// --- Module initialisation (called from index.js) ---
module.exports = function initLibyaNews({ client, db, saveData }) {
    const timers = new Map();

    function scheduleGuild(guildId) {
        if (timers.has(guildId)) clearInterval(timers.get(guildId));
        const timer = setInterval(() => {
            updateNews({ client, db, saveData, guildId }).catch(err => {
                console.error(`News update failed for guild ${guildId}:`, err.message);
            });
        }, CHECK_INTERVAL_MS);
        timers.set(guildId, timer);
    }

    client.once('clientReady', async () => {
        setTimeout(() => {
            for (const guild of client.guilds.cache.values()) {
                const newsState = getNewsData(db, guild.id);
                if (newsState.channelId) {
                    console.log(`📰 News updates active for guild ${guild.name} → channel ${newsState.channelId}`);
                    scheduleGuild(guild.id);
                }
            }
        }, 6000);
    });

    client.on('interactionCreate', async interaction => {
        if (!interaction.isChatInputCommand() || !interaction.guild) return;
        const { commandName, guild } = interaction;
        if (!commandName.startsWith('news-')) return;

        try {
            if (commandName === 'news-set-channel') {
                if (!isAdmin(interaction)) return safeReply(interaction, { content: '❌ Only admins can set the news channel.', flags: 64 });
                const channel = interaction.options.getChannel('channel');
                if (!channel || !channel.isTextBased()) return safeReply(interaction, { content: '❌ Please choose a text channel.', flags: 64 });

                const newsState = getNewsData(db, guild.id);
                newsState.channelId = channel.id;
                saveData(guild.id);
                scheduleGuild(guild.id);

                await safeReply(interaction, { content: `📰 News updates will post in ${channel} every hour. Fetching the latest news now...`, flags: 64 });
                await updateNews({ client, db, saveData, guildId: guild.id, forcePost: true });
                return;
            }

            if (commandName === 'news-refresh') {
                if (!isAdmin(interaction)) return safeReply(interaction, { content: '❌ Only admins can refresh news.', flags: 64 });
                await safeDefer(interaction, { flags: 64 });
                const result = await updateNews({ client, db, saveData, guildId: guild.id, forcePost: true });
                const statusText = result.posted ? '✅ Posted to the configured channel.' : 'ℹ️ No new article found (or no channel set).';
                return safeReply(interaction, { content: `📰 News refresh complete. ${statusText}` });
            }
        } catch (err) {
            console.error(`News command error (${commandName}):`, err);
            return safeReply(interaction, { content: `❌ News feature error: ${err.message.slice(0, 200)}`, flags: 64 });
        }
    });
};

module.exports.commands = newsCommands;