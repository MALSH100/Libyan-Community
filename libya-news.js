// libya-news.js
const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');

// === CONFIGURATION ===
// Your Telegram bot token from @BotFather
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE';

// All public Telegram channels to monitor (with or without @).
// Add or remove channels from this array at any time.
const TELEGRAM_CHANNELS = [
    process.env.TELEGRAM_CHANNEL || '@libyabreaking',
    '@almasartvlibya',
];

const CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const MAX_HISTORY = 50;

// Normalise a channel identifier — always prefix with @, lowercase
function normaliseChannel(ch) {
    ch = ch.trim();
    return (ch.startsWith('@') ? ch : `@${ch}`).toLowerCase();
}

// Build a Set of normalised channel usernames for fast lookup
const WATCHED_CHANNELS = new Set(TELEGRAM_CHANNELS.map(normaliseChannel));

// === Core: single shared getUpdates call covers ALL channels at once ===
// One poll → one API call → posts filtered per channel.
let _lastTelegramUpdateId = null;

async function fetchTelegramUpdates() {
    const params = new URLSearchParams({
        timeout: 0,
        limit: 100,
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
    return data.result;
}

// Returns a Map<channelUsername, latestArticle> — one entry per channel
// that had at least one new post. Channels with no new posts are absent.
async function getLatestNewsByChannel() {
    try {
        const updates = await fetchTelegramUpdates();

        if (updates.length > 0) {
            _lastTelegramUpdateId = updates[updates.length - 1].update_id;
        }

        // Group channel_post updates by channel username
        const postsByChannel = new Map();
        for (const u of updates) {
            if (!u.channel_post) continue;
            const chat = u.channel_post.chat;
            const username = (chat.username || '').toLowerCase();
            if (!username) continue;
            if (!WATCHED_CHANNELS.has(`@${username}`)) continue;
            if (!postsByChannel.has(username)) postsByChannel.set(username, []);
            postsByChannel.get(username).push(u.channel_post);
        }

        // For each channel, keep only the newest post and parse it
        const result = new Map();
        for (const [username, posts] of postsByChannel) {
            posts.sort((a, b) => b.date - a.date);
            result.set(username, parseTelegramPost(posts[0]));
        }

        return result; // empty Map = no new posts this cycle
    } catch (err) {
        console.error('[News] Telegram fetch error:', err.message);
        throw new Error('Could not fetch latest news from Telegram.');
    }
}

// === Parse a Telegram channel_post into a normalised article object ===
function parseTelegramPost(post) {
    const chatUsername = post.chat.username || '';
    const msgId        = post.message_id;

    const url = chatUsername
        ? `https://t.me/${chatUsername}/${msgId}`
        : null;

    const rawText = post.text || post.caption || '';
    const lines   = rawText.split('\n').map(l => l.trim()).filter(Boolean);
    const title   = lines[0]
        ? (lines[0].length > 120 ? lines[0].slice(0, 117) + '...' : lines[0])
        : '📢 New post';

    let description = lines.slice(1).join(' ').trim();
    if (description.length > 250) description = description.slice(0, 247) + '...';
    if (!description) description = 'Click the link to read the full post on Telegram.';

    let imageFileId = null;
    if (post.photo && post.photo.length > 0) {
        const largest = post.photo.reduce((best, p) =>
            (p.file_size || 0) > (best.file_size || 0) ? p : best
        , post.photo[0]);
        imageFileId = largest.file_id;
    } else if (post.document?.mime_type?.startsWith('image/')) {
        imageFileId = post.document.file_id;
    }

    return {
        title,
        description,
        url,
        imageFileId,
        scrapedAt:       new Date(post.date * 1000).toISOString(),
        messageId:       msgId,
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

// === Persistent data helpers ===
function getNewsData(db, guildId) {
    if (!db[guildId]) db[guildId] = {};
    if (!db[guildId].__news) {
        db[guildId].__news = {
            channelId: null,
            // Per-source tracking: { [channelUsername]: lastPostedUrl }
            lastPostedBySource: {},
            lastCheckedAt: null,
            history: [],
        };
    }
    // Migrate old single-key format if present
    if (db[guildId].__news.lastPostedUrl !== undefined && !db[guildId].__news.lastPostedBySource) {
        db[guildId].__news.lastPostedBySource = {};
        delete db[guildId].__news.lastPostedUrl;
    }
    return db[guildId].__news;
}

// === Post a single article embed to Discord ===
async function postNewsUpdate(client, newsState, article) {
    if (!newsState.channelId) return false;
    const channel = await client.channels.fetch(newsState.channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return false;

    let imageUrl = null;
    if (article.imageFileId) {
        imageUrl = await resolveTelegramFileUrl(article.imageFileId);
    }

    const channelName    = article.channelUsername ? `@${article.channelUsername}` : 'Telegram';
    const telegramIconUrl = 'https://telegram.org/img/t_logo.png';

    const embed = new EmbedBuilder()
        .setColor(0x229ED9)
        .setTitle(article.title)
        .setDescription(article.description)
        .setTimestamp(new Date(article.scrapedAt))
        .setFooter({ text: `Posted in ${channelName}`, iconURL: telegramIconUrl })
        .setAuthor({ name: '📢 Libya Channel Update' });

    if (article.url)  embed.setURL(article.url);
    if (imageUrl)     embed.setImage(imageUrl);

    await channel.send({ embeds: [embed] });
    return true;
}

// === Main update function ===
async function updateNews({ client, db, saveData, guildId, forcePost = false }) {
    const newsState = getNewsData(db, guildId);
    newsState.lastCheckedAt  = new Date().toISOString();
    newsState.lastPostedBySource = newsState.lastPostedBySource || {};
    newsState.history        = newsState.history || [];

    // One API call fetches updates for all channels simultaneously
    const newsByChannel = await getLatestNewsByChannel();

    let anyPosted = false;
    let anyNew    = false;

    for (const [username, article] of newsByChannel) {
        const articleKey  = article.url || String(article.messageId);
        const lastPosted  = newsState.lastPostedBySource[username] || null;
        const isNew       = articleKey !== lastPosted;

        console.log(`[News] Guild ${guildId} | @${username}: isNew=${isNew}, last=${lastPosted}, current=${articleKey}`);

        newsState.history.push(article);

        if (forcePost || isNew) {
            const posted = await postNewsUpdate(client, newsState, article);
            if (posted) {
                newsState.lastPostedBySource[username] = articleKey;
                anyPosted = true;
            }
        }

        if (isNew) anyNew = true;
    }

    newsState.history = newsState.history.slice(-MAX_HISTORY);
    saveData(guildId);

    return { posted: anyPosted, isNew: anyNew, channelCount: newsByChannel.size };
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
                    console.log(`📰 News updates active for guild ${guild.name} → channel ${newsState.channelId} | watching: ${[...WATCHED_CHANNELS].join(', ')}`);
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

                const watchList = [...WATCHED_CHANNELS].join(', ');
                await safeReply(interaction, { content: `📰 Updates from ${watchList} will post in ${channel}. Fetching latest posts...`, flags: 64 });
                await updateNews({ client, db, saveData, guildId: guild.id, forcePost: true });
                return;
            }

            if (commandName === 'news-refresh') {
                if (!isAdmin(interaction)) return safeReply(interaction, { content: '❌ Only admins can refresh news.', flags: 64 });
                await safeDefer(interaction, { flags: 64 });
                const result = await updateNews({ client, db, saveData, guildId: guild.id, forcePost: true });
                const statusText = result.posted
                    ? `✅ Posted updates from ${result.channelCount} channel(s).`
                    : 'ℹ️ No new posts found (or no Discord channel set).';
                return safeReply(interaction, { content: `📰 News refresh complete. ${statusText}` });
            }
        } catch (err) {
            console.error(`News command error (${commandName}):`, err);
            return safeReply(interaction, { content: `❌ News error: ${err.message.slice(0, 200)}`, flags: 64 });
        }
    });
};

module.exports.commands = newsCommands;
