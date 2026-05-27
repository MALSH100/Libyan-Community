// libya-news.js
const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { getLatestMessage, downloadVideoBuffer } = require('./telegram-client');

// === CONFIGURATION ===
const TELEGRAM_CHANNEL = process.env.TELEGRAM_CHANNEL || 'libyabreaking';
const CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const MAX_HISTORY = 50;

// === Core: fetch the latest message using GramJS ===
async function getLatestLibyaNews() {
    try {
        const message = await getLatestMessage(TELEGRAM_CHANNEL);
        if (!message) {
            console.log('[News] No messages found');
            return null;
        }
        
        const text = message.message || '';
        const lines = text.split('\n');
        let title = lines[0] ? lines[0].slice(0, 100) : '📢 New post';
        if (!title || title === '📢 New post') title = '📢 New post';
        
        let description = text.slice(0, 2000);
        if (description.length > 2000) description = description.slice(0, 1997) + '...';
        
        // Media handling
        let mediaBuffer = null;
        let isVideo = false;
        
        // Check for video
        if (message.video) {
            mediaBuffer = await downloadVideoBuffer(message);
            isVideo = true;
        }
        // Check for photo (optional, we'll keep as URL for efficiency)
        let photoUrl = null;
        if (message.photo && !mediaBuffer) {
            const sizes = message.photo.sizes;
            if (sizes && sizes.length) {
                const largest = sizes.reduce((max, sz) => (sz.size > max.size ? sz : max), sizes[0]);
                photoUrl = largest.url;
            }
        }
        
        const postUrl = `https://t.me/${TELEGRAM_CHANNEL}/${message.id}`;
        const scrapedAt = new Date(message.date * 1000).toISOString();
        
        return {
            title,
            description,
            url: postUrl,
            mediaBuffer,
            photoUrl,
            isVideo,
            scrapedAt,
            messageId: message.id,
            channelUsername: TELEGRAM_CHANNEL,
        };
    } catch (err) {
        console.error('[News] Telegram fetch error:', err.message);
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

// === Post to Discord with full video embed ===
async function postNewsUpdate(client, newsState, latestArticle, forced = false) {
    if (!newsState.channelId) return false;
    const channel = await client.channels.fetch(newsState.channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return false;

    // Simple embed without any Telegram branding
    const embed = new EmbedBuilder()
        .setColor(0x229ED9)   // keep the same blue (optional)
        .setTitle(latestArticle.title)
        .setDescription(latestArticle.description)
        .setTimestamp(new Date(latestArticle.scrapedAt));

    // No author, no footer, no URL.

    const messageOptions = { embeds: [embed] };
    
    // Attach video buffer if present
    if (latestArticle.isVideo && latestArticle.mediaBuffer) {
        const timestamp = Date.now();
        const attachment = {
            attachment: latestArticle.mediaBuffer,
            name: `video_${timestamp}.mp4`,
        };
        messageOptions.files = [attachment];
    } 
    // Else attach photo URL directly in embed
    else if (latestArticle.photoUrl) {
        embed.setImage(latestArticle.photoUrl);
    }

    await channel.send(messageOptions);
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
