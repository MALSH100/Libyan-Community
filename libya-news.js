// libya-news.js
const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');

// === CONFIGURATION ===
// Your Telegram bot token from @BotFather
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE';

// The public Telegram channel username (with or without @).
// Example: 'libyaakhbar' for t.me/libyaakhbar
const TELEGRAM_CHANNEL = process.env.TELEGRAM_CHANNEL || '@your_channel_username';

const CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const MAX_HISTORY = 50;

// Normalise channel identifier — always prefix with @
function channelId() {
    const ch = TELEGRAM_CHANNEL.trim();
    return ch.startsWith('@') ? ch : `@${ch}`;
}

// === Core: fetch the latest message from the Telegram channel ===
// Uses getUpdates with allowed_updates=channel_post to avoid needing
// the bot to be an admin. For a public channel, simply forward/call
// getChatHistory via getUpdates after the bot has seen at least one message.
//
// Strategy: call getUpdates with a high offset so we only get recent
// posts, then fall back to forwardMessages if the bot has never seen
// any updates yet (first run).
let _lastTelegramUpdateId = null;

async function fetchTelegramUpdates() {
    const params = new URLSearchParams({
        timeout: 0,
        limit: 10,
        allowed_updates: JSON.stringify(['channel_post']),
    });
    if (_lastTelegramUpdateId !== null) {
        params.set('offset', _lastTelegramUpdateId + 1);
    }
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?${params}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Telegram getUpdates HTTP ${res.status}`);
    const data = await res.json();
    if (!data.ok) throw new Error(`Telegram API error: ${data.description}`);
    return data.result; // array of Update objects
}

// Fetch the single most recent message posted in the channel.
// Works by calling getMessages via the Bot API forwardMessages trick:
// We send getUpdates, and separately hit getChatHistory using
// the undocumented (but stable) messages.getHistory-like approach
// via copyMessage. Instead, we use the reliable approach:
// call getUpdates to drain any backlog, then use getChatHistory
// via the `messages` method available through the Bot API's
// forwardMessages endpoint on a temporary offset scan.
//
// Simplest reliable method for a public channel without admin rights:
// hit https://api.telegram.org/bot{TOKEN}/getChat to confirm access,
// then use `forwardMessages` or just rely on `getUpdates` draining.
// For a fully reliable "get latest post regardless of bot uptime" we
// use the sendMessage → deleteMessage trick on a throwaway private chat
// is NOT needed — instead we use the public channel's message link
// by calling getChatHistory via the Bot API's `copyMessage` dry-run.
//
// CLEANEST approach that actually works without admin rights on a public channel:
// Use getUpdates (drains updates as they arrive) AND on first run,
// call `forwardMessages` from the channel to a dummy chat to get the
// message_id range, then use `getChatHistory` via the channel itself.
// In practice, the simplest approach is: on startup, send a dummy message
// to get the bot's own chat id, then forward the latest channel post.
//
// ACTUALLY — the cleanest, simplest approach with zero tricks:
// Just use getUpdates. The bot must be a member of the channel
// (add it as a subscriber — no admin needed for public channels).
// Telegram will then deliver channel_post updates to getUpdates.
async function getLatestLibyaNews() {
    try {
        const updates = await fetchTelegramUpdates();

        // Advance the offset so we don't re-process old updates next time
        if (updates.length > 0) {
            _lastTelegramUpdateId = updates[updates.length - 1].update_id;
        }

        // Filter to channel_post updates from our target channel
        const channelPosts = updates
            .filter(u => {
                if (!u.channel_post) return false;
                const chat = u.channel_post.chat;
                // Match by username or channel id
                const target = channelId().replace('@', '').toLowerCase();
                return (
                    (chat.username && chat.username.toLowerCase() === target) ||
                    String(chat.id) === target
                );
            })
            .map(u => u.channel_post)
            // Newest first
            .sort((a, b) => b.date - a.date);

        if (channelPosts.length === 0) {
            // No new posts in this poll cycle — not an error
            return null;
        }

        const post = channelPosts[0];
        return parseTelegramPost(post);
    } catch (err) {
        console.error('[News] Telegram fetch error:', err.message);
        throw new Error('Could not fetch latest news from Telegram channel.');
    }
}

// === Parse a Telegram channel_post into a normalised article object ===
function parseTelegramPost(post) {
    const chatUsername = post.chat.username || '';
    const msgId        = post.message_id;

    // Public message link
    const url = chatUsername
        ? `https://t.me/${chatUsername}/${msgId}`
        : null;

    // Raw text (may contain Markdown/HTML entities from Telegram)
    const rawText = post.text || post.caption || '';

    // Extract a title: first non-empty line, up to 120 chars
    const lines     = rawText.split('\n').map(l => l.trim()).filter(Boolean);
    const title     = lines[0]
        ? (lines[0].length > 120 ? lines[0].slice(0, 117) + '...' : lines[0])
        : '📢 New post';

    // Description: remaining lines joined, trimmed to 250 chars
    let description = lines.slice(1).join(' ').trim();
    if (description.length > 250) description = description.slice(0, 247) + '...';
    if (!description) description = 'Click the link to read the full post on Telegram.';

    // Image: if the post has a photo, pick the largest size
    let imageUrl = null;
    if (post.photo && post.photo.length > 0) {
        const largest = post.photo.reduce((best, p) =>
            (p.file_size || 0) > (best.file_size || 0) ? p : best
        , post.photo[0]);
        // We'll resolve the file URL below (async), store file_id for now
        imageUrl = `tg-file:${largest.file_id}`;
    } else if (post.document?.mime_type?.startsWith('image/')) {
        imageUrl = `tg-file:${post.document.file_id}`;
    }

    return {
        title,
        description,
        url,
        imageFileId: imageUrl?.startsWith('tg-file:') ? imageUrl.slice(8) : null,
        scrapedAt:   new Date(post.date * 1000).toISOString(),
        messageId:   msgId,
        channelUsername: chatUsername,
    };
}

// === Resolve a Telegram file_id to a public HTTPS URL ===
async function resolveTelegramFileUrl(fileId) {
    try {
        const res  = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
        const data = await res.json();
        if (!data.ok || !data.result?.file_path) return null;
        return `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${data.result.file_path}`;
    } catch {
        return null;
    }
}


// === Persistent data helpers (unchanged) ===
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

    // Resolve Telegram photo to a public URL (if present)
    let imageUrl = null;
    if (latestArticle.imageFileId) {
        imageUrl = await resolveTelegramFileUrl(latestArticle.imageFileId);
    }

    const channelName = latestArticle.channelUsername
        ? `@${latestArticle.channelUsername}`
        : 'Telegram';

    const telegramIconUrl = 'https://telegram.org/img/t_logo.png';

    const embed = new EmbedBuilder()
        .setColor(0x229ED9)  // Telegram blue
        .setTitle(latestArticle.title)
        .setDescription(latestArticle.description)
        .setTimestamp(new Date(latestArticle.scrapedAt))
        .setFooter({ text: `Posted in ${channelName}`, iconURL: telegramIconUrl })
        .setAuthor({ name: '📢 Libya Channel Update' });

    if (latestArticle.url) embed.setURL(latestArticle.url);
    if (imageUrl)          embed.setImage(imageUrl);

    await channel.send({ embeds: [embed] });
    return true;
}

// === Main update function ===
async function updateNews({ client, db, saveData, guildId, forcePost = false }) {
    const newsState = getNewsData(db, guildId);
    newsState.lastCheckedAt = new Date().toISOString();

    const latestArticle = await getLatestLibyaNews();

    // null means no new posts in this poll cycle
    if (!latestArticle) {
        saveData(guildId);
        return { latestArticle: null, posted: false, isNew: false };
    }

    // Deduplicate by message URL (or messageId as fallback)
    const articleKey = latestArticle.url || String(latestArticle.messageId);
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
