// libya-news.js
const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const axios = require('axios');
const cheerio = require('cheerio');
// === CONFIGURATION ===
const TELEGRAM_CHANNELS = process.env.TELEGRAM_CHANNELS ? process.env.TELEGRAM_CHANNELS.split(',').map(c => c.trim()) : ['libyabreaking'];
const CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const MAX_HISTORY = 50;

// Helper: extract URL from CSS background-image
function extractBgUrl(style) {
    if (!style) return null;
    const match = style.match(/url\(["']?(.*?)["']?\)/);
    return match ? match[1] : null;
}
async function getLatestFromChannel(channelUsername) {
    try {
        const url = `https://t.me/s/${channelUsername}`;
        const { data: html } = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            timeout: 15000,
        });
        const $ = cheerio.load(html);
        const messages = $('.tgme_widget_message');
        if (!messages.length) return null;
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
        const textElem = newestMsg.find('.tgme_widget_message_text');
        let fullText = '';
        if (textElem.length) {
            fullText = textElem.html() || '';
            fullText = fullText.replace(/<br\s*\/?>/g, '\n').replace(/<[^>]*>/g, '');
            fullText = fullText.trim();
        }
        if (!fullText) fullText = '📷 Media post (no text)';
        let description = fullText;
        if (description.length > 2000) description = description.slice(0, 1997) + '...';
        const firstLine = fullText.split('\n')[0];
        let title = firstLine.length > 100 ? firstLine.slice(0, 97) + '...' : firstLine;
        if (!title || title === '📷 Media post (no text)') title = '📢 New post';
        let mediaUrl = null;
        const photoWrap = newestMsg.find('.tgme_widget_message_photo_wrap');
        if (photoWrap.length) {
            const style = photoWrap.attr('style');
            mediaUrl = extractBgUrl(style);
        }
        if (!mediaUrl) {
            const videoThumb = newestMsg.find('.tgme_widget_message_video_thumb');
            if (videoThumb.length) {
                const style = videoThumb.attr('style');
                mediaUrl = extractBgUrl(style);
            }
        }
        if (!mediaUrl) {
            const anyMedia = newestMsg.find('[style*="background-image"]');
            if (anyMedia.length) {
                const style = anyMedia.first().attr('style');
                mediaUrl = extractBgUrl(style);
            }
        }
        if (mediaUrl && mediaUrl.startsWith('//')) mediaUrl = 'https:' + mediaUrl;
        const postUrl = `https://t.me/${channelUsername}/${messageId}`;
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
            channelUsername,
        };
    } catch (err) {
        console.error(`[News] Error fetching from ${channelUsername}:`, err.message);
        return null;
    }
}
async function getLatestNewsFromAll() {
    const results = await Promise.all(TELEGRAM_CHANNELS.map(ch => getLatestFromChannel(ch)));
    return results.filter(r => r !== null);
}
// === Persistent data helpers ===
function getNewsData(db, guildId) {
    if (!db[guildId]) db[guildId] = {};
    if (!db[guildId].__news) {
        db[guildId].__news = {
            channelId: null,
            lastPostedUrls: {},
            lastCheckedAt: null,
            history: [],
        };
    }
    return db[guildId].__news;
}
// === Post to Discord ===
async function postNewsUpdate(client, newsState, article, forced = false) {
    if (!newsState.channelId) return false;
    const channel = await client.channels.fetch(newsState.channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return false;
    const embed = new EmbedBuilder()
        .setColor(0x229ED9)
        .setAuthor({ name: `📢 Telegram Update from @${article.channelUsername}` })
        .setTitle(article.title)
        .setDescription(article.description)
        .setURL(article.url)
        .setTimestamp(new Date(article.scrapedAt));
    if (article.mediaUrl) embed.setImage(article.mediaUrl);
    await channel.send({ embeds: [embed] });
    return true;
}
// === Main update function ===
async function updateNews({ client, db, saveData, guildId, forcePost = false }) {
    const newsState = getNewsData(db, guildId);
    newsState.lastCheckedAt = new Date().toISOString();
    let posted = false;
    // Initialize tracking if missing
    if (!newsState.lastPostedUrls) newsState.lastPostedUrls = {};
    for (const ch of TELEGRAM_CHANNELS) {
        if (!newsState.lastPostedUrls[ch]) newsState.lastPostedUrls[ch] = '';
    }
    const allArticles = await getLatestNewsFromAll();
    if (!allArticles.length) {
        saveData(guildId);
        return { posted: false };
    }
    let anyNew = false;
    for (const article of allArticles) {
        const lastUrl = newsState.lastPostedUrls[article.channelUsername] || '';
        const isNew = article.url !== lastUrl;
        if (isNew) {
            anyNew = true;
            if (forcePost) {
                const postedNow = await postNewsUpdate(client, newsState, article, forcePost);
                if (postedNow) {
                    newsState.lastPostedUrls[article.channelUsername] = article.url;
                    posted = true;
                }
            } else {
                // Automatic update: only post the most recent among new articles
                // This will be handled after loop
            }
        }
    }
    if (!forcePost && anyNew) {
        // Find the newest article overall (by date)
        const sorted = [...allArticles].sort((a, b) => new Date(b.scrapedAt) - new Date(a.scrapedAt));
        const newest = sorted[0];
        const lastUrl = newsState.lastPostedUrls[newest.channelUsername] || '';
        if (newest.url !== lastUrl) {
            const postedNow = await postNewsUpdate(client, newsState, newest, forcePost);
            if (postedNow) {
                newsState.lastPostedUrls[newest.channelUsername] = newest.url;
                posted = true;
            }
        }
    }
    // Save history
    newsState.history = newsState.history || [];
    newsState.history.push({ timestamp: new Date().toISOString(), articles: allArticles.map(a => ({ channel: a.channelUsername, url: a.url })) });
    newsState.history = newsState.history.slice(-MAX_HISTORY);
    saveData(guildId);
    return { posted };
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
        .setDescription('Set the Discord channel for Telegram news updates')
        .addChannelOption(o => o.setName('channel').setDescription('Channel to post updates in').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .setDMPermission(false),
    new SlashCommandBuilder()
        .setName('news-refresh')
        .setDescription('Admin: Manually check for the latest posts from all sources')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .setDMPermission(false),
    new SlashCommandBuilder()
        .setName('news-lastposts')
        .setDescription('Admin: Show the last posted URLs for each source')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .setDMPermission(false),
];
async function showLastPosts(interaction, db, guildId) {
    if (!isAdmin(interaction)) return safeReply(interaction, { content: 'Admin only.', flags: 64 });
    const newsState = getNewsData(db, guildId);
    const lastPosts = newsState.lastPostedUrls || {};
    const lines = Object.entries(lastPosts).map(([ch, url]) => `**${ch}**: ${url || 'never'}`);
    const content = lines.length ? lines.join('\n') : 'No posts tracked yet.';
    return safeReply(interaction, { content, flags: 64 });
}
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
        if (commandName === 'news-lastposts') {
            await showLastPosts(interaction, db, guild.id);
            return;
        }
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
                const statusText = result.posted ? '✅ Posted to configured channel.' : 'ℹ️ No new articles found (or no channel set).';
                return safeReply(interaction, { content: `📰 News refresh complete. ${statusText}` });
            }
        } catch (err) {
            console.error(`News command error (${commandName}):`, err);
            return safeReply(interaction, { content: `❌ News error: ${err.message.slice(0, 200)}`, flags: 64 });
        }
    });
};
module.exports.commands = newsCommands;
