// libya-news.js
const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { telegram_scraper } = require('telegram-scraper');

// === CONFIGURATION ===
// The public Telegram channel username (without @). Example: 'libyabreaking'
const TELEGRAM_CHANNEL = process.env.TELEGRAM_CHANNEL || 'libyabreaking';

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
// === Core: fetch the latest message from the Telegram channel using scraper ===
async function getLatestLibyaNews() {
    try {
        // Fetch the most recent message from the public channel
        const channelData = await telegram_scraper(TELEGRAM_CHANNEL, { limit: 1 });
        if (!channelData || !channelData.messages || channelData.messages.length === 0) {
            console.log('[News] No messages found in channel.');
            return null;
        }

        const post = channelData.messages[0];
        const title = post.text ? post.text.split('\n')[0].slice(0, 120) : '📢 New post';
        const description = post.text ? post.text.slice(0, 250) : 'Click the link to read the full post on Telegram.';
        const url = `https://t.me/${TELEGRAM_CHANNEL}/${post.id}`;
        const imageUrl = post.media && post.media.type === 'photo' ? post.media.url : null;

        return {
            title,
            description,
            url,
            imageUrl,
            scrapedAt: new Date(post.date * 1000).toISOString(),
            messageId: post.id,
            channelUsername: TELEGRAM_CHANNEL,
        };
    } catch (err) {
        console.error('[News] Telegram scraper error:', err.message);
        throw new Error('Could not fetch latest news from Telegram channel.');
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
    if (latestArticle.imageUrl) embed.setImage(latestArticle.imageUrl);

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
