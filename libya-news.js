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
        // Extract description – try multiple fields
        let description = latest.contentSnippet || latest.summary || latest.description || '';
        // Remove HTML tags
        description = description.replace(/<[^>]*>/g, '');
        // Trim and limit length
        if (description.length > 250) description = description.slice(0, 247) + '...';
        // If description is empty or same as title, use fallback
        if (!description || description === latest.title) {
            description = 'Click the title to read the full article on the source website.';
        }
        // Extract source domain from the article URL
        let sourceDomain = '';
        try {
            const urlObj = new URL(latest.link);
            sourceDomain = urlObj.hostname.replace(/^www\./, '');
        } catch (e) {}
               return {
            title: latest.title,
            url: latest.link,          // renamed from rssUrl
            scrapedAt: new Date().toISOString(),
            sourceUrl: RSS_FEED_URL,
        };
    } catch (err) {
        console.error('[News] RSS fetch error:', err.message);
        throw new Error('Could not fetch latest news from RSS feed.');
    }
}

// === Fetch article image (og:image) from the article page ===
// Resolve Google News redirect to actual article URL
async function resolveNewsUrl(articleUrl) {
    if (!articleUrl.includes('news.google.com')) return articleUrl;
    let browser;
    try {
        browser = await chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        });
        const page = await browser.newPage();
        await page.goto(articleUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        // Wait for any redirect to complete
        await page.waitForTimeout(2000);
        const finalUrl = page.url();
        return finalUrl;
    } catch (err) {
        console.error('[News] Failed to resolve URL:', err.message);
        return articleUrl;
    } finally {
        if (browser) await browser.close().catch(() => {});
    }
}

// Fetch image AND description from the article page
async function fetchArticleMetadata(articleUrl) {
    let browser;
    let resolvedUrl = await resolveNewsUrl(articleUrl);
    try {
        browser = await chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        });
        const page = await browser.newPage();
        await page.goto(resolvedUrl, { waitUntil: 'networkidle', timeout: 30000 });
        
        // Wait longer for lazy-loaded images and meta tags
        await page.waitForTimeout(5000);
        
        const metadata = await page.evaluate(() => {
            // Get description
            let description = document.querySelector('meta[property="og:description"]')?.getAttribute('content');
            if (!description) description = document.querySelector('meta[name="description"]')?.getAttribute('content');
            if (!description) {
                const paras = Array.from(document.querySelectorAll('p'));
                const goodPara = paras.find(p => p.innerText.trim().length > 100);
                if (goodPara) description = goodPara.innerText.trim();
            }
            if (description && description.length > 250) description = description.slice(0, 247) + '...';
            
            // Get image – try multiple methods
            let image = document.querySelector('meta[property="og:image"]')?.getAttribute('content');
            if (!image) image = document.querySelector('meta[name="twitter:image"]')?.getAttribute('content');
            if (!image) {
                // Look for the largest image on the page (excluding tiny icons)
                const images = Array.from(document.querySelectorAll('img'));
                const sorted = images.sort((a, b) => (b.width || b.naturalWidth || 0) - (a.width || a.naturalWidth || 0));
                const mainImg = sorted.find(img => {
                    const src = img.src || '';
                    const width = img.width || img.naturalWidth || 0;
                    return width >= 200 && !src.includes('logo') && !src.includes('icon') && !src.includes('avatar');
                });
                if (mainImg) {
                    if (mainImg.src.startsWith('/')) {
                        image = new URL(mainImg.src, window.location.origin).href;
                    } else {
                        image = mainImg.src;
                    }
                }
            }
            
            return { description, image };
        });
        
        console.log(`[News] Metadata: description=${metadata.description ? 'yes' : 'no'}, image=${metadata.image ? 'yes' : 'no'}`);
        return { description: metadata.description, image: metadata.image, resolvedUrl };
    } catch (err) {
        console.error('[News] Failed to fetch metadata:', err.message);
        return { description: null, image: null, resolvedUrl };
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

    // Fetch metadata (description, image, final URL) from the article page
        const metadata = await fetchArticleMetadata(latestArticle.url);
    
    const finalUrl = metadata.resolvedUrl || latestArticle.rssUrl;
    const description = metadata.description || 'Click the title to read the full article.';
    const imageUrl = metadata.image;
    
    // Extract source domain from final URL
    let sourceDomain = '';
    try {
        const urlObj = new URL(finalUrl);
        sourceDomain = urlObj.hostname.replace(/^www\./, '');
    } catch (e) {}
    
    const sourceText = sourceDomain ? `Source: ${sourceDomain}` : 'Source: Google News';
    const faviconUrl = sourceDomain 
        ? `https://www.google.com/s2/favicons?domain=${sourceDomain}&sz=32` 
        : 'https://www.google.com/favicon.ico';
    
    const embed = new EmbedBuilder()
        .setColor(0x4285F4)
        .setTitle(latestArticle.title)
        .setURL(finalUrl)
        .setDescription(description)
        .setTimestamp(new Date(latestArticle.scrapedAt))
        .setFooter({ text: sourceText, iconURL: faviconUrl })
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
