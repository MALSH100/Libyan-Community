// libya-news.js
const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const axios = require('axios');
const cheerio = require('cheerio');

// === CONFIGURATION ===
const TELEGRAM_CHANNEL = process.env.TELEGRAM_CHANNEL || 'libyabreaking';
const CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const MAX_HISTORY = 50;

// === Core: fetch the latest message from the Telegram channel using public preview ===
async function getLatestLibyaNews() {
    try {
        const url = `https://t.me/s/${TELEGRAM_CHANNEL}`;
        const { data: html } = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            timeout: 15000
        });
        const $ = cheerio.load(html);

        // Find all message widgets
        const messages = $('.tgme_widget_message');
        if (!messages.length) {
            console.log('[News] No messages found on the page');
            return null;
        }

        // Find the newest non-pinned message by comparing datetime
        let newestMsg = null;
        let newestDate = null;
        messages.each((i, elem) => {
            const $msg = $(elem);
            if ($msg.hasClass('tgme_widget_message_pinned')) return;
            const timeElem = $msg.find('.tgme_widget_message_date time');
            const dateTime = timeElem.attr('datetime');
            if (dateTime) {
                const msgDate = new Date(dateTime);
                if (!newestDate || msgDate > newestDate) {
                    newestDate = msgDate;
                    newestMsg = $msg;
                }
            } else if (!newestMsg) {
                newestMsg = $msg;
            }
        });
        if (!newestMsg) newestMsg = messages.first();

        const dataPost = newestMsg.attr('data-post');
        const messageId = dataPost ? dataPost.split('/').pop() : '';

        // Extract full text (preserve line breaks)
        const textElem = newestMsg.find('.tgme_widget_message_text');
        let fullText = '';
        if (textElem.length) {
            // Get HTML content
            fullText = textElem.html() || '';
            // Convert <br> to newline, then strip remaining HTML
            fullText = fullText.replace(/<br\s*\/?>/g, '\n').replace(/<[^>]*>/g, '');
            fullText = fullText.trim();
        }
        if (!fullText) fullText = '📷 Media post (no text)';

        // Discord description limit: 4096, but we'll keep under 2000 to be safe
        let description = fullText;
        if (description.length > 2000) description = description.slice(0, 1997) + '...';

        // Title: first line of the post
        const firstLine = fullText.split('\n')[0];
        let title = firstLine.length > 100 ? firstLine.slice(0, 97) + '...' : firstLine;
        if (!title || title === '📷 Media post (no text)') title = '📢 New post';

// Extract media URL (photo or video thumbnail)
let mediaUrl = null;

// 1. Check for photos
const photoImg = newestMsg.find('.tgme_widget_message_photo img');
if (photoImg.length) {
    mediaUrl = photoImg.attr('src');
} 
// 2. Check for videos
else {
    const videoElem = newestMsg.find('.tgme_widget_message_video');
    if (videoElem.length) {
        // Try to get the poster image (from video tag)
        const videoTag = videoElem.find('video');
        if (videoTag.length) {
            const poster = videoTag.attr('poster');
            if (poster) mediaUrl = poster;
        }
        // If no poster, look for an img inside the video wrapper
        if (!mediaUrl) {
            const videoImg = videoElem.find('img');
            if (videoImg.length) mediaUrl = videoImg.attr('src');
        }
        // If still no mediaUrl, log it
        if (!mediaUrl) console.log('[News] Video post without thumbnail');
    }
}

console.log(`[News] Media URL extracted: ${mediaUrl || 'none'}`);

        const postUrl = `https://t.me/${TELEGRAM_CHANNEL}/${messageId}`;
        const timeElem = newestMsg.find('.tgme_widget_message_date time');
        const dateTime = timeElem.attr('datetime');
        const scrapedAt = dateTime ? new Date(dateTime).toISOString() : new Date().toISOString();

        return {
            title,
            description,
            url: postUrl,
            mediaUrl,
            scrapedAt,
            messageId,
            channelUsername: TELEGRAM_CHANNEL,
        };
    } catch (err) {
        console.error('[News] Scrape error:', err.message);
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
