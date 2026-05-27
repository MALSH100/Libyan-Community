// libya-news.js
const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const axios = require('axios');
const cheerio = require('cheerio');

// === CONFIGURATION ===
const TELEGRAM_CHANNEL = process.env.TELEGRAM_CHANNEL || 'libyabreaking';
const CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const MAX_HISTORY = 50;

// === Core: fetch the latest message from the Telegram channel using public preview ===
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

// You'll need to add these environment variables:
// TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_SESSION (optional, will be created)
const apiId = parseInt(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const sessionString = process.env.TELEGRAM_SESSION || '';

// One global client instance
let _client = null;

async function getTelegramClient() {
    if (_client) return _client;
    const stringSession = new StringSession(sessionString);
    _client = new TelegramClient(stringSession, apiId, apiHash, {
        connectionRetries: 5,
    });
    await _client.start({
        phoneNumber: async () => {
            // On first run you'll need to provide your number interactively.
            // After that, the session will be saved.
            // For Railway, you may need to use a pre‑created session string.
            throw new Error('Session not initialised. Please run locally to generate session string.');
        },
        phoneCode: async () => '',
        password: async () => '',
        onError: (err) => console.error(err),
    });
    const newSession = _client.session.save();
    if (newSession !== sessionString) {
        console.log('[News] New Telegram session string (add to env):', newSession);
    }
    return _client;
}

async function getLatestLibyaNews() {
    try {
        const client = await getTelegramClient();
        const channel = await client.getEntity(TELEGRAM_CHANNEL); // e.g., 'libyabreaking'
        const messages = await client.getMessages(channel, { limit: 1 });
        if (!messages.length) return null;

        const msg = messages[0];
        const text = msg.message || '';
        const lines = text.split('\n');
        const title = lines[0] ? lines[0].slice(0, 100) : '📢 New post';
        let description = text.slice(0, 2000);
        if (description.length > 2000) description = description.slice(0, 1997) + '...';

        let mediaUrl = null;
        // Photo
        if (msg.photo) {
            // Get the largest photo size
            const sizes = msg.photo.sizes;
            if (sizes && sizes.length) {
                const largest = sizes.reduce((max, sz) => (sz.size > max.size ? sz : max), sizes[0]);
                // The library gives a file reference; we need to build a download URL
                // For simplicity, you can use client.downloadMedia to get a buffer and upload to Discord
                // But for an embed image, we can try to fetch the file reference URL
                // For now, skip; you can download and re‑upload if needed.
            }
        }
        // Video thumbnail
        if (msg.video && msg.video.thumb) {
            mediaUrl = msg.video.thumb.url;
        } else if (msg.document && msg.document.thumb) {
            mediaUrl = msg.document.thumb.url;
        }

        const postUrl = `https://t.me/${TELEGRAM_CHANNEL}/${msg.id}`;
        const scrapedAt = new Date(msg.date * 1000).toISOString();

        return {
            title,
            description,
            url: postUrl,
            mediaUrl,
            scrapedAt,
            messageId: msg.id,
            channelUsername: TELEGRAM_CHANNEL,
        };
    } catch (err) {
        console.error('[News] GramJS error:', err.message);
        throw new Error(`Could not fetch latest news from Telegram: ${err.message}`);
    }
}

// === Persistent data helpers ===
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

// === Post to Discord ===
async function postNewsUpdate(client, newsState, latestArticle, forced = false) {
    if (!newsState.channelId) return false;
    const channel = await client.channels.fetch(newsState.channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return false;

    const channelName = latestArticle.channelUsername ? `@${latestArticle.channelUsername}` : 'Telegram';
    const telegramIconUrl = 'https://telegram.org/img/t_logo.png';

    const embed = new EmbedBuilder()
        .setColor(0x229ED9)
        .setAuthor({ name: '📢 Telegram Update', iconURL: telegramIconUrl })
        .setTitle(latestArticle.title)
        .setDescription(latestArticle.description)
        .setURL(latestArticle.url)
        .setTimestamp(new Date(latestArticle.scrapedAt))
        .setFooter({ text: `Posted in ${channelName}`, iconURL: telegramIconUrl });

    if (latestArticle.mediaUrl) {
        embed.setImage(latestArticle.mediaUrl);
    }

    await channel.send({ embeds: [embed] });
    return true;
}

// === Main update function ===
async function updateNews({ client, db, saveData, guildId, forcePost = false }) {
    const newsState = getNewsData(db, guildId);
    newsState.lastCheckedAt = new Date().toISOString();

    const latestArticle = await getLatestLibyaNews();
    if (!latestArticle) {
        saveData(guildId);
        return { latestArticle: null, posted: false, isNew: false };
    }

    const articleKey = latestArticle.url;
    const isNew = articleKey !== newsState.lastPostedUrl;

    console.log(`[News] Auto check for guild ${guildId}: isNew=${isNew}, lastUrl=${newsState.lastPostedUrl}, currentUrl=${articleKey}`);

    newsState.history = newsState.history || [];
    newsState.history.push(latestArticle);
    newsState.history = newsState.history.slice(-MAX_HISTORY);

    let posted = false;
    if (forcePost || isNew) {
        posted = await postNewsUpdate(client, newsState, latestArticle, forcePost);
        if (posted) newsState.lastPostedUrl = articleKey;
    }
    saveData(guildId);
    return { latestArticle, posted, isNew };
}

// === Admin helpers ===
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

// === Slash commands ===
const newsCommands = [
    new SlashCommandBuilder()
        .setName('news-set-channel')
        .setDescription('Set the Discord channel for Telegram Libya updates')
        .addChannelOption(o => o.setName('channel').setDescription('Channel to post updates in').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .setDMPermission(false),

    new SlashCommandBuilder()
        .setName('news-refresh')
        .setDescription('Admin: Manually check for the latest Telegram posts')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .setDMPermission(false),
].map(cmd => cmd.toJSON());

// === Module initialisation ===
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

                await safeReply(interaction, { content: `📰 News updates will post in ${channel}. Fetching latest news...`, flags: 64 });
                await updateNews({ client, db, saveData, guildId: guild.id, forcePost: true });
                return;
            }

            if (commandName === 'news-refresh') {
                if (!isAdmin(interaction)) return safeReply(interaction, { content: '❌ Only admins can refresh news.', flags: 64 });
                await safeDefer(interaction, { flags: 64 });
                const result = await updateNews({ client, db, saveData, guildId: guild.id, forcePost: true });
                const statusText = result.posted ? '✅ Posted to configured channel.' : 'ℹ️ No new article found (or no channel set).';
                return safeReply(interaction, { content: `📰 News refresh complete. ${statusText}` });
            }
        } catch (err) {
            console.error(`News command error (${commandName}):`, err);
            return safeReply(interaction, { content: `❌ News error: ${err.message.slice(0, 200)}`, flags: 64 });
        }
    });
};

module.exports.commands = newsCommands;
