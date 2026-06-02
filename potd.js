// potd.js — Post of the Day
// Scans configured channels daily at 21:00 Libya time (19:00 UTC),
// finds the message with the most total reactions (minimum 3),
// announces the winner, awards Libyan Points, and manages a 24h role.
//
// Wired into index.js with:
//   const { initPOTD } = require('./potd');
//   initPOTD({ client, db, saveData, awardLP });
//
// Slash commands registered via:
//   module.exports.commands  (array of toJSON() command definitions)

const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');

// ─── Constants ────────────────────────────────────────────────────────────────

const ANNOUNCE_HOUR_UTC  = 19;   // 21:00 Libya (UTC+2)
const ANNOUNCE_MINUTE    = 0;
const MIN_REACTIONS      = 3;    // message needs at least this many total reactions
const LP_WIN             = 50;   // points awarded to daily winner
const LP_STREAK_BONUS    = 25;   // extra points per day when on a streak (days 2+)
const POTD_ROLE_NAME     = '⭐ Poster of the Day';
const LOOK_BACK_HOURS    = 24;   // how many hours back to scan for messages

// ─── Data helper ─────────────────────────────────────────────────────────────

function getPOTDData(db, guildId) {
    if (!db[guildId])        db[guildId]        = {};
    if (!db[guildId].__potd) db[guildId].__potd = {
        announceChannelId: null,   // channel where winner is announced
        watchChannelIds:   [],     // channels scanned for posts
        lastRunDate:       null,   // ISO date string of last run (YYYY-MM-DD)
        winnerRole:        null,   // ID of the "Poster of the Day" role
        hallOfFame:        {},     // userId → { wins, streak, bestStreak, lastWinDate }
    };
    const s = db[guildId].__potd;
    // Field guards for older saved data
    if (!s.watchChannelIds) s.watchChannelIds = [];
    if (!s.hallOfFame)      s.hallOfFame      = {};
    return s;
}

function getHOFEntry(potd, userId) {
    if (!potd.hallOfFame[userId]) {
        potd.hallOfFame[userId] = {
            wins:        0,
            streak:      0,
            bestStreak:  0,
            lastWinDate: null,
        };
    }
    return potd.hallOfFame[userId];
}

// ─── Reaction counting ────────────────────────────────────────────────────────
// Counts the number of UNIQUE non-bot users who reacted to a message,
// regardless of how many different emoji they used. One person adding
// 10 different emoji still only contributes 1 to the score.
// Paginates reaction.users.fetch() in batches of 100 to handle busy posts.

async function getTotalReactions(message) {
    const uniqueUsers = new Set();

    for (const reaction of message.reactions.cache.values()) {
        try {
            let lastId = undefined;
            while (true) {
                const options = { limit: 100 };
                if (lastId) options.after = lastId;
                const users = await reaction.users.fetch(options);
                if (!users.size) break;
                for (const [userId, user] of users) {
                    if (!user.bot) uniqueUsers.add(userId);
                }
                if (users.size < 100) break;  // no more pages
                lastId = users.last().id;
            }
        } catch (err) {
            console.error('[POTD] Failed to fetch reaction users:', err.message);
        }
    }

    return uniqueUsers.size;
}

// ─── Role management ─────────────────────────────────────────────────────────

async function ensurePOTDRole(guild, potd, saveData) {
    // Return existing role if still valid
    if (potd.winnerRole) {
        const existing = guild.roles.cache.get(potd.winnerRole);
        if (existing) return existing;
    }

    // Create it if missing
    try {
        const role = await guild.roles.create({
            name:        POTD_ROLE_NAME,
            color:       0xFFD700,  // gold
            hoist:       true,      // shows separately in member list
            mentionable: false,
            reason:      'Post of the Day winner role',
        });
        potd.winnerRole = role.id;
        saveData(guild.id);
        console.log(`[POTD] Created role "${POTD_ROLE_NAME}" in ${guild.name}`);
        return role;
    } catch (err) {
        console.error('[POTD] Could not create winner role:', err.message);
        return null;
    }
}

async function stripPOTDRole(guild, potd) {
    if (!potd.winnerRole) return;
    const role = guild.roles.cache.get(potd.winnerRole);
    if (!role) return;
    // Remove from every member who currently has it
    for (const [, member] of guild.members.cache) {
        if (member.roles.cache.has(role.id)) {
            await member.roles.remove(role).catch(err =>
                console.error(`[POTD] Failed to remove role from ${member.user.username}:`, err.message)
            );
        }
    }
}

// ─── Core: find winner and announce ──────────────────────────────────────────

async function runPOTD(client, db, saveData, awardLP, guildId, forced = false) {
    const potd  = getPOTDData(db, guildId);
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return;

    // Guard: don't run twice on the same calendar day (UTC) unless forced
    const todayStr = new Date().toISOString().slice(0, 10);
    if (!forced && potd.lastRunDate === todayStr) {
        console.log(`[POTD] Already ran today (${todayStr}) for guild ${guild.name}`);
        return;
    }

    if (!potd.announceChannelId) {
        console.warn(`[POTD] No announce channel set for guild ${guild.name}`);
        return;
    }

    if (!potd.watchChannelIds.length) {
        console.warn(`[POTD] No watch channels set for guild ${guild.name}`);
        return;
    }

    const announceChannel = await client.channels.fetch(potd.announceChannelId).catch(err => {
        console.error('[POTD] Failed to fetch announce channel:', err.message);
        return null;
    });
    if (!announceChannel) {
        console.warn('[POTD] Announce channel not found (ID:', potd.announceChannelId, ')');
        return;
    }
    if (!announceChannel.isTextBased()) {
        console.warn('[POTD] Announce channel is not a text-based channel');
        return;
    }

    // ── Scan all watched channels for messages in the past LOOK_BACK_HOURS ──
    const cutoff = Date.now() - LOOK_BACK_HOURS * 3_600_000;
    let   best   = null;   // { message, count, channelId }

    for (const channelId of potd.watchChannelIds) {
        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel || !channel.isTextBased()) continue;

        // Fetch up to 100 messages — paginate if the channel is very busy
        let lastId    = null;
        let keepGoing = true;

        while (keepGoing) {
            const options = { limit: 100 };
            if (lastId) options.before = lastId;

            let batch;
            try {
                batch = await channel.messages.fetch(options);
            } catch {
                break;
            }

            if (!batch.size) break;

            for (const msg of batch.values()) {
                // Stop paginating once we go past the look-back window
                if (msg.createdTimestamp < cutoff) {
                    keepGoing = false;
                    break;
                }
                // Skip bot messages and messages with too few reactions
                if (msg.author.bot) continue;
                if (!msg.reactions.cache.size) continue;

                const count = await getTotalReactions(msg);
                if (count < MIN_REACTIONS) continue;

                if (!best || count > best.count) {
                    best = { message: msg, count, channelId };
                }
            }

            // If the oldest message in the batch is still within our window,
            // there might be more — but 100 msgs per channel is usually enough.
            // Only paginate if we still haven't hit the cutoff.
            if (keepGoing && batch.size === 100) {
                lastId = batch.last().id;
            } else {
                keepGoing = false;
            }
        }
    }

    // ── No qualifying post ────────────────────────────────────────────────────
    if (!best) {
        await announceChannel.send({
            embeds: [
                new EmbedBuilder()
                    .setColor(0x808080)
                    .setTitle('📭 No Post of the Day Today')
                    .setDescription(
                        `No post reached the minimum of **${MIN_REACTIONS} reactions** in the past 24 hours.\n` +
                        `Get posting and reacting for tomorrow! 🔥`
                    )
                    .setTimestamp(),
            ],
        }).catch(err => console.error('[POTD] Failed to send no-winner message:', err.message));

        potd.lastRunDate = todayStr;
        saveData(guildId);
        return;
    }

    const winner    = best.message;
    const winnerId  = winner.author.id;
    const hof       = getHOFEntry(potd, winnerId);

    // ── Streak calculation ────────────────────────────────────────────────────
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const onStreak  = hof.lastWinDate === yesterday;

    if (onStreak) {
        hof.streak++;
    } else {
        hof.streak = 1;
    }
    if (hof.streak > hof.bestStreak) hof.bestStreak = hof.streak;
    hof.wins++;
    hof.lastWinDate = todayStr;

    // ── Award LP ──────────────────────────────────────────────────────────────
    let lpAwarded  = LP_WIN;
    let streakText = '';

    if (hof.streak >= 2) {
        const bonus = LP_STREAK_BONUS * (hof.streak - 1);
        lpAwarded  += bonus;
        streakText  = `🔥 **${hof.streak}-day streak!** +${bonus} bonus LP`;
    }

    awardLP(guildId, winnerId, lpAwarded, 'potd');

    // ── Give role, strip from previous holder ─────────────────────────────────
    await guild.members.fetch().catch(err =>
        console.warn('[POTD] guild.members.fetch() failed (GuildMembers intent may be missing):', err.message)
    ); // populate cache
    await stripPOTDRole(guild, potd);

    const winnerRole = await ensurePOTDRole(guild, potd, saveData);
    if (winnerRole) {
        const winnerMember = await guild.members.fetch(winnerId).catch(() => null);
        if (winnerMember) {
            await winnerMember.roles.add(winnerRole).catch(err =>
                console.error('[POTD] Failed to assign winner role:', err.message)
            );
        }
    }

    // ── Build the announcement embed ──────────────────────────────────────────

    // Detect image to show in the embed, checking three sources in priority order:
    //   1. File attachment uploaded directly to Discord
    //   2. Image/GIF URL in message text — unwrapping Discord proxy URLs if needed
    //   3. Image from an embed already on the original message
    //
    // Discord's setImage() only supports: png, jpg, gif, webp
    // It does NOT support: mp4, webm, mov — those are filtered out.
    // Discord often wraps external media in a proxy:
    //   https://images-ext-1.discordapp.net/external/HASH/https/real.domain/file.gif
    // We unwrap these to get the real URL so Discord can render them.

    function unwrapDiscordProxy(url) {
        // Matches: https://images-ext-N.discordapp.net/external/HASH/https/domain/path
        const proxyMatch = url.match(/images-ext-\d+\.discordapp\.net\/external\/[^/]+\/(https?)\/(.*)/i);
        if (proxyMatch) return `${proxyMatch[1]}://${proxyMatch[2]}`;
        return url;
    }

    function isRenderableImage(url) {
        // Only allow formats Discord can actually display in an embed image
        const clean = url.split('?')[0].toLowerCase();
        return /\.(png|jpe?g|gif|webp)$/.test(clean);
    }

    // Regex for direct image URLs anywhere in text
    const IMAGE_URL_RE = /https?:\/\/\S+\.(?:png|jpe?g|gif|webp)(\?[^\s]*)?/gi;
    // Regex for known media domains (may or may not end in image extension)
    const MEDIA_DOMAIN_RE = /https?:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net|images-ext-\d+\.discordapp\.net|i\.imgur\.com|c\.tenor\.com|media\.tenor\.com|media\.giphy\.com)\S+/gi;

    let embedImage = null;

    // 1. Uploaded file attachment (png/jpg/gif/webp only)
    const imageAttachment = [...winner.attachments.values()].find(a =>
        (a.contentType?.startsWith('image/') && !a.contentType?.includes('video')) ||
        /\.(png|jpe?g|gif|webp)$/i.test(a.name || '')
    );
    if (imageAttachment) {
        embedImage = imageAttachment.url;
    }

    // 2. Image URL in message text — unwrap proxy, skip videos
    if (!embedImage && winner.content) {
        const candidates = [
            ...(winner.content.match(MEDIA_DOMAIN_RE) || []),
            ...(winner.content.match(IMAGE_URL_RE)    || []),
        ];
        for (const raw of candidates) {
            const real = unwrapDiscordProxy(raw);
            if (isRenderableImage(real)) {
                embedImage = real;
                break;
            }
        }
    }

    // 3. Image from an existing embed on the original message
    if (!embedImage && winner.embeds.length) {
        for (const e of winner.embeds) {
            // prefer thumbnail over image — thumbnails are usually the GIF/image preview
            const candidates = [e.thumbnail?.url, e.image?.url].filter(Boolean);
            for (const raw of candidates) {
                const real = unwrapDiscordProxy(raw);
                if (isRenderableImage(real)) {
                    embedImage = real;
                    break;
                }
            }
            if (embedImage) break;
        }
    }

    // Build the text preview — strip raw image URLs from content so they
    // don't appear as ugly links in the quoted block when we're already
    // showing them as the embed image.
    let postContent = winner.content || '';
    if (embedImage && postContent) {
        postContent = postContent.replace(embedImage, '').trim();
    }

    let postPreview = '';
    if (postContent) {
        postPreview = postContent.length > 300
            ? postContent.slice(0, 297) + '...'
            : postContent;
    } else if (!embedImage && winner.attachments.size) {
        postPreview = `📎 *${winner.attachments.size} attachment(s)*`;
    } else if (!embedImage && winner.embeds.length) {
        postPreview = `🔗 *Embedded content*`;
    }

    const embed = new EmbedBuilder()
        .setColor(0xFFD700)
        .setTitle('⭐ Post of the Day')
        .setDescription(
            `Congratulations <@${winnerId}>! Your post won today's **Post of the Day**!\n\n` +
            (postPreview ? `> ${postPreview.replace(/\n/g, '\n> ')}\n\n` : '') +
            `[Jump to post](${winner.url})`
        )
        .addFields(
            { name: '🏆 Reactions',       value: `${best.count}`,            inline: true },
            { name: '🪙 LP Awarded',      value: `+${lpAwarded} LP`,         inline: true },
            { name: '🏅 Total POTD Wins', value: `${hof.wins}`,              inline: true },
        )
        .setThumbnail(winner.author.displayAvatarURL())
        .setFooter({ text: `Post of the Day • Minimum ${MIN_REACTIONS} reactions required` })
        .setTimestamp();

    if (streakText) embed.addFields({ name: '\u200b', value: streakText });

    // Apply the detected image to the embed
    if (embedImage) embed.setImage(embedImage);

    await announceChannel.send({ content: `<@${winnerId}>`, embeds: [embed] }).catch(err =>
        console.error('[POTD] Failed to send winner announcement:', err.message)
    );

    // ── Persist ───────────────────────────────────────────────────────────────
    potd.lastRunDate = todayStr;
    saveData(guildId);

    console.log(`[POTD] Winner for ${guild.name}: ${winner.author.username} with ${best.count} reactions (+${lpAwarded} LP, streak: ${hof.streak})`);
}

// ─── Scheduler ────────────────────────────────────────────────────────────────
// Schedules POTD to run at exactly ANNOUNCE_HOUR_UTC:ANNOUNCE_MINUTE UTC each day.
// Uses setTimeout chained to the next target time instead of a fixed interval,
// so it never drifts and can never miss the window due to boot-time misalignment.

function startScheduler(client, db, saveData, awardLP) {
    function getNextRunMs() {
        const now = new Date();
        const next = new Date(Date.UTC(
            now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
            ANNOUNCE_HOUR_UTC, ANNOUNCE_MINUTE, 0, 0
        ));
        // If today's time has already passed, aim for tomorrow
        if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
        return next.getTime() - now.getTime();
    }

    function scheduleNext() {
        const ms = getNextRunMs();
        console.log(`[POTD] Next run scheduled in ${Math.round(ms / 60_000)} minutes`);
        setTimeout(async () => {
            for (const guild of client.guilds.cache.values()) {
                runPOTD(client, db, saveData, awardLP, guild.id).catch(err => {
                    console.error(`[POTD] Error for guild ${guild.name}:`, err.message);
                });
            }
            // Schedule the next day's run immediately after firing
            scheduleNext();
        }, ms);
    }

    scheduleNext();
}

// ─── Slash commands ───────────────────────────────────────────────────────────

const potdCommands = [
    // Set the channel where POTD announcements are posted
    new SlashCommandBuilder()
        .setName('potd-set-announce')
        .setDescription('Set the channel where Post of the Day is announced (Admin only)')
        .addChannelOption(o =>
            o.setName('channel').setDescription('Announcement channel').setRequired(true)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .setDMPermission(false),

    // Add a channel to be scanned for winning posts
    new SlashCommandBuilder()
        .setName('potd-add-channel')
        .setDescription('Add a channel to be scanned for Post of the Day (Admin only)')
        .addChannelOption(o =>
            o.setName('channel').setDescription('Channel to watch').setRequired(true)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .setDMPermission(false),

    // Remove a channel from the watch list
    new SlashCommandBuilder()
        .setName('potd-remove-channel')
        .setDescription('Remove a channel from Post of the Day scanning (Admin only)')
        .addChannelOption(o =>
            o.setName('channel').setDescription('Channel to remove').setRequired(true)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .setDMPermission(false),

    // Show current config
    new SlashCommandBuilder()
        .setName('potd-config')
        .setDescription('Show current Post of the Day configuration (Admin only)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .setDMPermission(false),

    // Manually trigger the POTD run (for testing)
    new SlashCommandBuilder()
        .setName('potd-run')
        .setDescription('Manually trigger Post of the Day right now (Admin only)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .setDMPermission(false),

    // Hall of Fame leaderboard
    new SlashCommandBuilder()
        .setName('potd-hall-of-fame')
        .setDescription('Show the Post of the Day Hall of Fame'),
].map(cmd => cmd.toJSON());

// ─── Admin/reply helpers ──────────────────────────────────────────────────────

function isAdmin(interaction) {
    return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
}

async function safeReply(interaction, payload) {
    try {
        if (interaction.replied)  return interaction.followUp(payload).catch(() => {});
        if (interaction.deferred) return interaction.editReply(payload).catch(() => {});
        return interaction.reply(payload);
    } catch (err) {
        console.error('[POTD] safeReply failed:', err.message);
    }
}

async function safeDefer(interaction, opts = {}) {
    try {
        if (!interaction.replied && !interaction.deferred) await interaction.deferReply(opts);
    } catch (err) {
        console.error('[POTD] safeDefer failed:', err.message);
    }
}

// ─── Module init ──────────────────────────────────────────────────────────────

function initPOTD({ client, db, saveData, awardLP }) {

    // Start the daily scheduler
    client.once('clientReady', () => {
        startScheduler(client, db, saveData, awardLP);
        console.log(`⭐ Post of the Day scheduler started — announces at ${ANNOUNCE_HOUR_UTC}:00 UTC (21:00 Libya)`);
    });

    // Handle slash commands
    client.on('interactionCreate', async (interaction) => {
        if (!interaction.isChatInputCommand() || !interaction.guild) return;
        const { commandName, guild } = interaction;
        if (!commandName.startsWith('potd-')) return;

        try {
            // ── /potd-set-announce ────────────────────────────────────────────
            if (commandName === 'potd-set-announce') {
                if (!isAdmin(interaction)) return safeReply(interaction, { content: '❌ Admin only.', flags: 64 });
                const channel = interaction.options.getChannel('channel');
                if (!channel.isTextBased()) return safeReply(interaction, { content: '❌ Must be a text channel.', flags: 64 });

                const potd = getPOTDData(db, guild.id);
                potd.announceChannelId = channel.id;
                saveData(guild.id);

                return safeReply(interaction, {
                    embeds: [new EmbedBuilder()
                        .setColor(0xFFD700)
                        .setTitle('⭐ POTD Announce Channel Set')
                        .setDescription(`Post of the Day winners will be announced in ${channel}.`)],
                    flags: 64,
                });
            }

            // ── /potd-add-channel ─────────────────────────────────────────────
            if (commandName === 'potd-add-channel') {
                if (!isAdmin(interaction)) return safeReply(interaction, { content: '❌ Admin only.', flags: 64 });
                const channel = interaction.options.getChannel('channel');
                if (!channel.isTextBased()) return safeReply(interaction, { content: '❌ Must be a text channel.', flags: 64 });

                const potd = getPOTDData(db, guild.id);
                if (potd.watchChannelIds.includes(channel.id)) {
                    return safeReply(interaction, { content: `❌ ${channel} is already being watched.`, flags: 64 });
                }
                potd.watchChannelIds.push(channel.id);
                saveData(guild.id);

                return safeReply(interaction, {
                    embeds: [new EmbedBuilder()
                        .setColor(0xFFD700)
                        .setTitle('⭐ Watch Channel Added')
                        .setDescription(`${channel} will now be scanned for Post of the Day.`)],
                    flags: 64,
                });
            }

            // ── /potd-remove-channel ──────────────────────────────────────────
            if (commandName === 'potd-remove-channel') {
                if (!isAdmin(interaction)) return safeReply(interaction, { content: '❌ Admin only.', flags: 64 });
                const channel = interaction.options.getChannel('channel');

                const potd  = getPOTDData(db, guild.id);
                const idx   = potd.watchChannelIds.indexOf(channel.id);
                if (idx === -1) {
                    return safeReply(interaction, { content: `❌ ${channel} is not in the watch list.`, flags: 64 });
                }
                potd.watchChannelIds.splice(idx, 1);
                saveData(guild.id);

                return safeReply(interaction, {
                    embeds: [new EmbedBuilder()
                        .setColor(0xFFD700)
                        .setTitle('⭐ Watch Channel Removed')
                        .setDescription(`${channel} has been removed from Post of the Day scanning.`)],
                    flags: 64,
                });
            }

            // ── /potd-config ──────────────────────────────────────────────────
            if (commandName === 'potd-config') {
                if (!isAdmin(interaction)) return safeReply(interaction, { content: '❌ Admin only.', flags: 64 });
                const potd = getPOTDData(db, guild.id);

                const announceStr = potd.announceChannelId
                    ? `<#${potd.announceChannelId}>`
                    : '*Not set*';

                const watchStr = potd.watchChannelIds.length
                    ? potd.watchChannelIds.map(id => `<#${id}>`).join('\n')
                    : '*None set*';

                return safeReply(interaction, {
                    embeds: [new EmbedBuilder()
                        .setColor(0xFFD700)
                        .setTitle('⭐ Post of the Day — Config')
                        .addFields(
                            { name: '📢 Announce Channel',   value: announceStr,           inline: false },
                            { name: '👀 Watched Channels',   value: watchStr,              inline: false },
                            { name: '⏰ Announce Time',      value: '21:00 Libya (19:00 UTC)', inline: true },
                            { name: '🔥 Min Reactions',      value: `${MIN_REACTIONS}`,    inline: true },
                            { name: '🪙 LP Reward',          value: `${LP_WIN} LP`,        inline: true },
                            { name: '📅 Last Run',           value: potd.lastRunDate || '*Never*', inline: true },
                        )],
                    flags: 64,
                });
            }

            // ── /potd-run ─────────────────────────────────────────────────────
            if (commandName === 'potd-run') {
                if (!isAdmin(interaction)) return safeReply(interaction, { content: '❌ Admin only.', flags: 64 });
                await safeDefer(interaction, { ephemeral: true });
                await runPOTD(client, db, saveData, awardLP, guild.id, true); // forced = true bypasses date guard
                return safeReply(interaction, { content: '⭐ Post of the Day has been run manually.' });
            }

            // ── /potd-hall-of-fame ────────────────────────────────────────────
            if (commandName === 'potd-hall-of-fame') {
                const potd    = getPOTDData(db, guild.id);
                const entries = Object.entries(potd.hallOfFame);

                if (!entries.length) {
                    return safeReply(interaction, {
                        embeds: [new EmbedBuilder()
                            .setColor(0xFFD700)
                            .setTitle('⭐ Hall of Fame')
                            .setDescription('No winners yet! Start posting and reacting.')],
                    });
                }

                // Sort by total wins descending
                entries.sort((a, b) => b[1].wins - a[1].wins);
                const top10 = entries.slice(0, 10);

                const medals = ['🥇', '🥈', '🥉'];
                const lines  = top10.map(([userId, data], i) => {
                    const medal     = medals[i] || `**${i + 1}.**`;
                    const streakTxt = data.streak >= 2 ? ` 🔥 ${data.streak}-day streak` : '';
                    const bestTxt   = data.bestStreak >= 3 ? ` *(best: ${data.bestStreak})*` : '';
                    return `${medal} <@${userId}> — **${data.wins}** win${data.wins !== 1 ? 's' : ''}${streakTxt}${bestTxt}`;
                });

                return safeReply(interaction, {
                    embeds: [new EmbedBuilder()
                        .setColor(0xFFD700)
                        .setTitle('⭐ Post of the Day — Hall of Fame')
                        .setDescription(lines.join('\n'))
                        .setFooter({ text: 'Sorted by total wins' })
                        .setTimestamp()],
                });
            }

        } catch (err) {
            console.error(`[POTD] Command error (${commandName}):`, err);
            return safeReply(interaction, {
                content: `❌ POTD error: ${err.message.slice(0, 200)}`,
                flags: 64,
            });
        }
    });
}

module.exports = { initPOTD };
module.exports.commands = potdCommands;
