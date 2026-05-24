// libya-news.js
const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const Parser = require('rss-parser');
const parser = new Parser();
const { chromium } = require('playwright'); // Add this line

// === CONFIGURATION ===
// Replace this URL with your Telegram RSS feed URL
// You can get it by running tg2rss (or use a public RSS service like rss.app)
const RSS_FEED_URL = 'https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en&q=Libya&tbs=sbd:1';
const CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const MAX_HISTORY = 50;

// === Core: fetch latest news from RSS feed ===
async function getLatestLibyaNews() {
    try {
        const feed = await parser.parseURL(RSS_FEED_URL);
        if (!feed.items || feed.items.length === 0) {
            throw new Error('No items in RSS feed.');
        }
        // Sort items by publication date (newest first)
        feed.items.sort((a, b) => {
            return new Date(b.pubDate) - new Date(a.pubDate);
        });
        const latest = feed.items[0];
        // Extract a clean description (remove HTML if any)
        let description = latest.contentSnippet || latest.description || '';
        // Trim and limit length (max 200 chars)
        if (description.length > 200) description = description.slice(0, 197) + '...';
        return {
            title: latest.title,
            url: latest.link,
            description: description,
            scrapedAt: new Date().toISOString(),
            sourceUrl: RSS_FEED_URL,
        };
    } catch (err) {
        console.error('[News] RSS fetch error:', err.message);
        throw new Error('Could not fetch latest news from RSS feed.');
    }
}

// === Fetch article image (og:image) from the article page ===
async function fetchArticleImage(articleUrl) {
    let browser;
    try {
        browser = await chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        });
        const page = await browser.newPage();
        await page.goto(articleUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        
        // Wait a bit for lazy-loaded images
        await page.waitForTimeout(3000);
        
        const image = await page.evaluate(() => {
            // Try multiple methods
            // 1. Open Graph image
            let img = document.querySelector('meta[property="og:image"]')?.getAttribute('content');
            if (img) return img;
            // 2. Twitter card image
            img = document.querySelector('meta[name="twitter:image"]')?.getAttribute('content');
            if (img) return img;
            // 3. First large image in the article (not logo/icon)
            const images = Array.from(document.querySelectorAll('img'));
            const mainImg = images.find(img => {
                const src = img.src || '';
                const width = img.width || img.naturalWidth || 0;
                const alt = (img.alt || '').toLowerCase();
                return width >= 200 && 
                       !src.includes('logo') && 
                       !src.includes('icon') &&
                       !src.includes('avatar') &&
                       !alt.includes('logo') &&
                       !alt.includes('icon');
            });
            if (mainImg) {
                // Resolve relative URLs
                if (mainImg.src.startsWith('/')) {
                    return new URL(mainImg.src, window.location.origin).href;
                }
                return mainImg.src;
            }
            return null;
        });
        
        console.log(`[News] Extracted image: ${image ? 'yes' : 'no'}`);
        return image;
    } catch (err) {
        console.error('[News] Failed to fetch article image:', err.message);
        return null;
    } finally {
        if (browser) await browser.close().catch(() => {});
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

    const description = latestArticle.description || 'Click the title to read the full article.';
    
    // Fetch the article image (og:image)
    const imageUrl = await fetchArticleImage(latestArticle.url);
    
    const embed = new EmbedBuilder()
        .setColor(0x4285F4)
        .setTitle(latestArticle.title)
        .setURL(latestArticle.url)
        .setDescription(description)
        .setTimestamp(new Date(latestArticle.scrapedAt))
        .setFooter({ text: 'Source: Google News', iconURL: 'https://www.google.com/favicon.ico' })
        .setAuthor({ name: '📰 Latest Libya News' });

    if (imageUrl) {
        embed.setImage(imageUrl);
    }

    await channel.send({ embeds: [embed] });
    return true;
}

// === Main update function ===
async function updateNews({ client, db, saveData, guildId, forcePost = false }) {
    const newsState = getNewsData(db, guildId);
    newsState.lastCheckedAt = new Date().toISOString();

    const latestArticle = await getLatestLibyaNews();
    const isNew = latestArticle.url !== newsState.lastPostedUrl;

    console.log(`[News] Auto check for guild ${guildId}: isNew=${isNew}, lastUrl=${newsState.lastPostedUrl}, currentUrl=${latestArticle.url}`);

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
