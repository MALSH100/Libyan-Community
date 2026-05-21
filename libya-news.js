// libya-news.js
const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const axios = require('axios');
const cheerio = require('cheerio');
const { chromium } = require('playwright'); // Add this line

const SOURCE_URL = 'https://www.newsnow.co.uk/h/World+News/Africa/Libya?type=ln';
const CHECK_INTERVAL_MS = 15 * 60 * 1000;
const MAX_HISTORY = 50;

// --- Resolve final URL using Playwright (handles modern JavaScript redirects) ---
async function resolveFinalUrl(intermediateUrl) {
    let browser;
    let page;
    try {
        browser = await chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        });
        page = await browser.newPage();

        // Navigate to the intermediate page
        await page.goto(intermediateUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });

        // Log the initial URL
        console.log(`[News] Initial URL after navigation: ${page.url()}`);

        // Strategy 1: Wait for URL to change (polling)
        let finalUrl = null;
        try {
            await page.waitForFunction(
                () => window.location.href && !window.location.href.includes('newsnow.co.uk'),
                { timeout: 20000, polling: 500 }
            );
            finalUrl = page.url();
            console.log(`[News] URL changed to: ${finalUrl}`);
        } catch (e) {
            console.log(`[News] URL did not change automatically: ${e.message}`);
        }

        // Strategy 2: Look for a 'Continue' or 'Go to article' button and click it
        if (!finalUrl || finalUrl.includes('newsnow.co.uk')) {
            try {
                const buttonSelectors = [
                    'button:has-text("Continue")',
                    'a:has-text("Continue")',
                    'button:has-text("Go to article")',
                    'a:has-text("Go to article")',
                    'button:has-text("Read full article")',
                    'a:has-text("Read full article")',
                    '.continue-button',
                    '.btn-continue',
                    'a[href*="facebook"]', // Avoid Facebook links
                ];
                let clicked = false;
                for (const selector of buttonSelectors) {
                    const button = await page.$(selector);
                    if (button) {
                        const href = await button.getAttribute('href');
                        // Skip Facebook links
                        if (href && href.includes('facebook.com')) {
                            console.log(`[News] Skipping Facebook button: ${href}`);
                            continue;
                        }
                        await button.click();
                        clicked = true;
                        console.log(`[News] Clicked button: ${selector}`);
                        break;
                    }
                }
                if (clicked) {
                    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 });
                    finalUrl = page.url();
                    console.log(`[News] After click, URL: ${finalUrl}`);
                }
            } catch (clickError) {
                console.log(`[News] Could not click continue button: ${clickError.message}`);
            }
        }

        // Strategy 3: Extract from meta refresh or find any external link (excluding Facebook)
        if (!finalUrl || finalUrl.includes('newsnow.co.uk')) {
            const metaRefresh = await page.evaluate(() => {
                const meta = document.querySelector('meta[http-equiv="refresh"]');
                if (meta) {
                    const content = meta.getAttribute('content');
                    const match = content.match(/url=(.*)$/i);
                    if (match) return match[1];
                }
                return null;
            });
            if (metaRefresh && !metaRefresh.includes('facebook.com')) {
                finalUrl = metaRefresh;
                console.log(`[News] Found meta refresh URL: ${finalUrl}`);
            } else {
                const articleLink = await page.evaluate(() => {
                    const links = Array.from(document.querySelectorAll('a[href^="http"]'));
                    // Exclude Facebook, NewsNow, and social media
                    const external = links.find(link => 
                        !link.href.includes('newsnow.co.uk') && 
                        !link.href.includes('facebook.com') &&
                        !link.href.includes('twitter.com')
                    );
                    return external ? external.href : null;
                });
                if (articleLink) {
                    finalUrl = articleLink;
                    console.log(`[News] Found external link: ${finalUrl}`);
                }
            }
        }

        // Validate and return the final URL
        if (finalUrl && !finalUrl.includes('newsnow.co.uk') && !finalUrl.includes('facebook.com')) {
            console.log(`[News] Successfully resolved redirect to: ${finalUrl}`);
            return finalUrl;
        } else {
            console.warn(`[News] Could not resolve redirect to an article, using original URL: ${intermediateUrl}`);
            return intermediateUrl;
        }

    } catch (error) {
        console.error(`[News] Playwright redirect failed: ${error.message}`);
        return intermediateUrl;
       } finally {
        if (page) await page.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
    }
}

// --- Fetch article details: image, description, etc. (stealth mode for security pages) ---
async function fetchArticleMetadata(articleUrl, retries = 2) {
    let browser;
    try {
        browser = await chromium.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-blink-features=AutomationControlled',
                '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            ],
        });
        const page = await browser.newPage();
        
        // Set a realistic viewport and locale
        await page.setViewportSize({ width: 1280, height: 800 });
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
        });

        // Navigate and wait for the page to fully load (including security checks)
        await page.goto(articleUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        
        // Wait for the security challenge to resolve (look for article content)
        console.log(`[News] Waiting for security challenge to pass...`);
        try {
            await page.waitForFunction(() => {
                // If we see an article title or main content, the security check passed
                const hasArticle = document.querySelector('article, h1, .node-title, .field--name-title');
                const hasSecurity = document.body.innerText.includes('security service') || 
                                    document.body.innerText.includes('captcha') ||
                                    document.body.innerText.includes('verify you are not a bot');
                return hasArticle && !hasSecurity;
            }, { timeout: 60000, polling: 2000 });
            console.log(`[News] Security challenge passed, content loaded.`);
        } catch (e) {
            console.log(`[News] Security challenge may still be present or page took too long: ${e.message}`);
            // Continue anyway – we'll try to extract whatever is there
        }
        
        // Wait a bit more for lazy-loaded images
        await page.waitForTimeout(4000);
        
        const metadata = await page.evaluate(() => {
            const getMeta = (name) => {
                const el = document.querySelector(`meta[property="${name}"], meta[name="${name}"]`);
                return el ? el.getAttribute('content') : null;
            };

            // Try Open Graph image first
            let image = getMeta('og:image') || getMeta('twitter:image');
            if (!image) {
                // Fallback: find the first large image that isn't a logo or icon
                const imgs = Array.from(document.querySelectorAll('img'));
                const validImg = imgs.find(img => {
                    const src = img.src || '';
                    const width = img.width || img.naturalWidth || 0;
                    return width >= 100 && 
                           !src.includes('logo') && 
                           !src.includes('icon') &&
                           !src.includes('avatar') &&
                           !src.includes('advertisement');
                });
                if (validImg) image = validImg.src;
            }

            // Description fallback
            let description = getMeta('og:description') || getMeta('description') || getMeta('twitter:description');
            if (!description) {
                // Try to get the first substantial paragraph
                const paragraphs = Array.from(document.querySelectorAll('p'));
                const goodPara = paragraphs.find(p => p.innerText.trim().length > 80);
                if (goodPara) description = goodPara.innerText.trim().slice(0, 200);
                else if (paragraphs[0]) description = paragraphs[0].innerText.trim().slice(0, 200);
            }

            // Ensure description is not the security message
            if (description && (description.includes('security service') || description.includes('verify you are not a bot'))) {
                description = null;
            }

            return {
                image,
                description,
                siteName: getMeta('og:site_name'),
            };
        });

        console.log(`[News] Metadata extracted: image=${metadata.image ? 'yes' : 'no'}, description=${metadata.description ? 'yes' : 'no'}`);
        return metadata;
    } catch (err) {
        console.error(`[News] Failed to fetch metadata (attempt ${3 - retries}): ${err.message}`);
        if (retries > 0) {
            console.log(`[News] Retrying...`);
            if (browser) await browser.close().catch(() => {});
            return fetchArticleMetadata(articleUrl, retries - 1);
        }
        return { image: null, description: null, siteName: null };
    } finally {
        if (browser) await browser.close().catch(() => {});
    }
}

// --- Scrape the latest Libya news with multiple selectors ---
async function getLatestLibyaNews() {
    try {
        const { data: html } = await axios.get(SOURCE_URL, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });
        
        const $ = cheerio.load(html);
        
        // Try multiple selectors in order of specificity
        let headlineElement = null;
        let selectors = [
            'article .article-card__headline',
            '.article-card__headline',
            'a[href*="/A/"]',
            '.article-title',
            'h2 a',
            '.list-layout a'
        ];
        
        for (const selector of selectors) {
            headlineElement = $(selector).first();
            if (headlineElement.length && headlineElement.text().trim()) {
                console.log(`[News] Found article with selector: ${selector}`);
                break;
            }
        }
        
        if (!headlineElement || !headlineElement.length) {
            throw new Error('No article headlines found with any selector.');
        }

        let title = headlineElement.text().trim();
        let intermediateUrl = headlineElement.attr('href');
        
        // If title is empty, try deeper
        if (!title) {
            title = headlineElement.find('.article-title').text().trim() || headlineElement.text().trim();
        }
        
        if (!title || !intermediateUrl) {
            throw new Error('Missing title or link.');
        }
        
        console.log(`[News] Found: "${title}" -> ${intermediateUrl}`);
        
        // Resolve the redirect to get the final article URL
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

// --- Post to Discord with rich embed (including image) ---
async function postNewsUpdate(client, newsState, latestArticle, forced = false) {
    if (!newsState.channelId) return false;
    const channel = await client.channels.fetch(newsState.channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return false;

    // Fetch the article's image and description
    const metadata = await fetchArticleMetadata(latestArticle.url);

    const embed = new EmbedBuilder()
        .setColor(0xE67E22) // Libyan gold/orange
        .setTitle(`📰 ${latestArticle.title}`)
        .setURL(latestArticle.url)
        .setDescription(metadata.description || 'Click the title to read the full article.')
        .setTimestamp(new Date(latestArticle.scrapedAt))
        .setFooter({ text: `Source: NewsNow Libya${metadata.siteName ? ` · ${metadata.siteName}` : ''}` });

    if (metadata.image) {
        embed.setImage(metadata.image);
    }

    await channel.send({ embeds: [embed] });
    return true;
}

// --- Main update function ---
async function updateNews({ client, db, saveData, guildId, forcePost = false }) {
    const newsState = getNewsData(db, guildId);
    newsState.lastCheckedAt = new Date().toISOString();

    const latestArticle = await getLatestLibyaNews();
    const isNew = latestArticle.url !== newsState.lastPostedUrl;

        // Debug: log whether this is considered new and what the URLs are
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

// --- Module initialisation ---
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
