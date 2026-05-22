// ═══════════════════════════════════════════════════════════════════════════════
// YA RAYT SYSTEM
// "Ya Rayt" (يا ريت) means "I wish" in Libyan Arabic
//
// - New round every 2 days at 6:00 PM Libya time (UTC+2)
// - Round closes at 8:00 PM Libya time — results posted, LP awarded
// - Users submit /yarayt <wish> — one per round, locked in, no edits
// - 4 reactions auto-added: 🇱🇾 Relatable | 😂 Funny | ❤️ Wholesome | 🔥 Bold
// - Reactions counted at round end, LP awarded then
// - /top-yarayt and category leaderboards
// - Admin /yarayt-start to force a round immediately
// - Channel set via YARAYT_CHANNEL_ID environment variable
// ═══════════════════════════════════════════════════════════════════════════════

const { SlashCommandBuilder, EmbedBuilder, REST, Routes, PermissionFlagsBits } = require('discord.js');

// ─── Reaction definitions ─────────────────────────────────────────────────────

const REACTIONS = [
  { emoji: '🇱🇾', key: 'relatable', label: 'Relatable' },
  { emoji: '😂',  key: 'funny',     label: 'Funny'     },
  { emoji: '❤️',  key: 'wholesome', label: 'Wholesome' },
  { emoji: '🔥',  key: 'bold',      label: 'Bold'      },
];

// ─── Ya Rayt commands ─────────────────────────────────────────────────────────

const yaraytCommands = [
  new SlashCommandBuilder()
    .setName('yarayt')
    .setDescription('Submit your Ya Rayt wish for this round (one per round, locked in!)')
    .addStringOption(o => o.setName('wish').setDescription('Your wish — يا ريت...').setRequired(true))
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName('top-yarayt')
    .setDescription('Top 10 users with the most total Ya Rayt reactions of all time')
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName('top-relatable-yarayt')
    .setDescription('Top 10 users with the most 🇱🇾 Relatable reactions')
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName('top-funny-yarayt')
    .setDescription('Top 10 users with the most 😂 Funny reactions')
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName('top-wholesome-yarayt')
    .setDescription('Top 10 users with the most ❤️ Wholesome reactions')
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName('top-bold-yarayt')
    .setDescription('Top 10 users with the most 🔥 Bold reactions')
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName('yarayt-start')
    .setDescription('Force start a Ya Rayt round immediately — Admin only')
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName('yarayt-set-channel')
    .setDescription('Set the channel where Ya Rayt rounds will be played (Admin only)')
    .addChannelOption(o => o.setName('channel').setDescription('The text channel for Ya Rayt').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),
].map(c => c.toJSON());

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getYaraytData(db, guildId) {
  if (!db[guildId]) db[guildId] = {};
  if (!db[guildId].__yarayt) {
    db[guildId].__yarayt = {
      channelId:    null,  // ← new: stored channel ID
      currentRound: null,  // { startedAt, wishes: { userId: { wish, messageId, submittedAt } } }
      users:        {},    // { userId: { relatable, funny, wholesome, bold, total, rounds } }
      lastRoundAt:  0,     // timestamp of last round start
    };
  }
  return db[guildId].__yarayt;
}

function getUserYaraytStats(yrData, userId) {
  if (!yrData.users[userId]) {
    yrData.users[userId] = { relatable: 0, funny: 0, wholesome: 0, bold: 0, total: 0, rounds: 0 };
  }
  return yrData.users[userId];
}

// Libya time = UTC+2
function libyaTime() {
  return new Date(Date.now() + 2 * 60 * 60 * 1000);
}

// Get next 6PM Libya time (UTC+2) from now — skips 2 days between rounds
function getNext6PM() {
  const now = new Date();
  // Current time in Libya (UTC+2)
  const libyaNow = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  let target = new Date(libyaNow);
  target.setUTCHours(16, 0, 0, 0); // 6PM Libya = 16:00 UTC
  if (target <= libyaNow) {
    target.setUTCDate(target.getUTCDate() + 1);
  }
  // Convert back to UTC timestamp
  return target.getTime() - (2 * 60 * 60 * 1000);
}

// Get 8PM Libya time on the same day as a given timestamp
function roundEndTime(startTimestamp) {
  const d    = new Date(startTimestamp);
  // 8PM Libya = 6PM UTC
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 18, 0, 0, 0)).getTime();
}

// ─── Module export ────────────────────────────────────────────────────────────

module.exports = function initYarayt({ client, db, saveData, awardLP }) {

  let roundTimer  = null;
  let closeTimer  = null;
  let activeGuildId = null;

  // ─── Register Ya Rayt commands ─────────────────────────────────────────────

  async function registerYaraytCommands(guildId) {
    console.log(`Ya Rayt commands included in central registration for guild ${guildId}`);
  }

  // ─── Get the Ya Rayt channel ───────────────────────────────────────────────

function getYaraytChannel(guild, yrData) {
  if (!yrData.channelId) return null;
  return guild.channels.cache.get(yrData.channelId) || null;
}

  // ─── Start a round ─────────────────────────────────────────────────────────

async function startRound(guild, forced = false) {
  const yrData = getYaraytData(db, guild.id);

  // Don't start if a round is already active
  if (yrData.currentRound) {
    if (!forced) return;
    // If forced, close the existing round first
    await closeRound(guild, true);
  }

  const channel = getYaraytChannel(guild, yrData);
  if (!channel) {
    console.warn(`⚠️ Ya Rayt channel not set for guild ${guild.id}. Use /yarayt-set-channel.`);
    return;
  }

  yrData.currentRound = {
    startedAt: Date.now(),
    wishes:    {},
  };
  yrData.lastRoundAt = Date.now();
  saveData(guild.id);

  const embed = new EmbedBuilder()
    .setColor(0x00AA44)
    .setTitle('🇱🇾 يا ريت... Ya Rayt!')
    .setDescription(
      'A new round has started! What do you wish for?\n\n' +
      '**يا ريت** (Ya Rayt) means **"I wish"** in Libyan Arabic.\n\n' +
      'Use `/yarayt <your wish>` to submit your wish.\n' +
      '📌 **One wish per person per round — locked in, no edits!**\n\n' +
      'Reactions on each wish:\n' +
      '🇱🇾 Relatable · 😂 Funny · ❤️ Wholesome · 🔥 Bold\n\n' +
      '⏰ Round closes at **8:00 PM Libya time**.'
    )
    .setFooter({ text: 'Earn Libyan Points (LP) for every reaction you receive!' });

  await channel.send({ embeds: [embed] }).catch(e => console.error('Could not send Ya Rayt start message:', e.message));

  console.log(`🇱🇾 Ya Rayt round started in ${guild.name}`);

  // Schedule close at 8PM Libya time
  const closeAt = forced ? Date.now() + 2 * 60 * 60 * 1000 : roundEndTime(yrData.lastRoundAt);
  const msUntilClose = Math.max(1000, closeAt - Date.now());

  if (closeTimer) clearTimeout(closeTimer);
  closeTimer = setTimeout(() => closeRound(guild, false), msUntilClose);

  // Schedule next round (daily)
  scheduleNextRound(guild, yrData);
}

  // ─── Close a round and post results ────────────────────────────────────────

  async function closeRound(guild, silent = false) {
    const yrData = getYaraytData(db, guild.id);
    if (!yrData.currentRound) return;

    const channel  = getYaraytChannel(guild);
    const wishes   = yrData.currentRound.wishes;
    const round    = yrData.currentRound;

    // Count reactions on each wish message
    const results = [];

    for (const [userId, wishData] of Object.entries(wishes)) {
      const counts = { relatable: 0, funny: 0, wholesome: 0, bold: 0 };

      if (wishData.messageId && channel) {
        try {
          const msg = await channel.messages.fetch(wishData.messageId);
          for (const reaction of REACTIONS) {
            const r = msg.reactions.cache.get(reaction.emoji);
            if (r) {
              // Subtract 1 for the bot's own reaction
              counts[reaction.key] = Math.max(0, r.count - 1);
            }
          }
        } catch {}
      }

      const total = counts.relatable + counts.funny + counts.wholesome + counts.bold;
      results.push({ userId, wish: wishData.wish, counts, total });

      // Update all-time stats
      const userStats = getUserYaraytStats(yrData, userId);
      userStats.relatable += counts.relatable;
      userStats.funny     += counts.funny;
      userStats.wholesome += counts.wholesome;
      userStats.bold      += counts.bold;
      userStats.total     += total;
      userStats.rounds    = (userStats.rounds || 0) + 1;

      // Award LP — 1 per reaction + 10 bonus for most reactions
      if (awardLP && total > 0) awardLP(guild.id, userId, total, 'yarayt');
    }

    // Sort by total reactions
    results.sort((a, b) => b.total - a.total);

    // Award +10 LP bonus to round winner
    if (results.length > 0 && results[0].total > 0 && awardLP) {
      awardLP(guild.id, results[0].userId, 10, 'yarayt');
    }

    // Clear current round
    yrData.currentRound = null;
    saveData(guild.id);

    if (!silent && channel && results.length > 0) {
      const medals = ['🥇','🥈','🥉'];
      const top    = results.slice(0, 10);

      let memberNames = {};
      try {
        const members = await guild.members.fetch({ user: top.map(r => r.userId) });
        members.forEach((m, id) => { memberNames[id] = m.displayName; });
      } catch {}

      const desc = top.map((r, i) => {
        const name  = memberNames[r.userId] || `<@${r.userId}>`;
        const medal = medals[i] || `**${i + 1}.**`;
        const bars  = `🇱🇾${r.counts.relatable} 😂${r.counts.funny} ❤️${r.counts.wholesome} 🔥${r.counts.bold}`;
        return `${medal} **${name}** — ${r.total} reactions\n   *"${r.wish}"*\n   ${bars}`;
      }).join('\n\n');

      const embed = new EmbedBuilder()
        .setColor(0xFFD700)
        .setTitle('🇱🇾 Ya Rayt Round Results!')
        .setDescription(desc || 'No wishes were submitted this round.')
        .setFooter({ text: 'LP has been awarded! Next round in 2 days.' });

      await channel.send({ embeds: [embed] }).catch(e => console.error('Could not send Ya Rayt results:', e.message));
    }

    console.log(`🇱🇾 Ya Rayt round closed in ${guild.name} — ${results.length} wishes`);
  }

  // ─── Schedule next round ───────────────────────────────────────────────────

async function scheduleNextRound(guild, yrData) {
  if (roundTimer) clearTimeout(roundTimer);
  const nextStart = getNext6PM(); // timestamp (UTC)
  const msUntilStart = Math.max(1000, nextStart - Date.now());

  // Schedule the pre‑announcement 5 minutes before start
  const preAnnounceTime = nextStart - 5 * 60 * 1000;
  const msUntilPre = Math.max(0, preAnnounceTime - Date.now());

  if (msUntilPre > 0) {
    setTimeout(() => {
      sendPreAnnouncement(guild, yrData, nextStart);
    }, msUntilPre);
  } else {
    // If we are already inside the 5‑minute window, send immediately
    sendPreAnnouncement(guild, yrData, nextStart);
  }

  console.log(`🇱🇾 Next Ya Rayt round scheduled in ${Math.round(msUntilStart / 1000 / 60)} minutes`);
  roundTimer = setTimeout(() => startRound(guild, false), msUntilStart);
}

async function sendPreAnnouncement(guild, yrData, startTime) {
  const channel = getYaraytChannel(guild, yrData);
  if (!channel) return;

  const startDate = new Date(startTime);
  const endDate = new Date(startTime + 2 * 60 * 60 * 1000); // ends at 8PM Libya

  // Send a message
  const embed = new EmbedBuilder()
    .setColor(0xFFA500)
    .setTitle('⏰ Ya Rayt Round Starting Soon!')
    .setDescription(
      `The next Ya Rayt round begins in **5 minutes**!\n\n` +
      `**Starts:** <t:${Math.floor(startTime / 1000)}:F>\n` +
      `**Ends:** <t:${Math.floor(endDate.getTime() / 1000)}:F>\n\n` +
      `Get your wishes ready — use \`/yarayt\` once the round starts!`
    )
    .setFooter({ text: 'Daily at 6PM Libya time' });

  await channel.send({ embeds: [embed] }).catch(e => console.error('Pre‑announcement failed:', e.message));

  // Create a Discord scheduled event for the round
  try {
    await guild.scheduledEvents.create({
      name: '🇱🇾 Ya Rayt – I Wish!',
      scheduledStartTime: startDate,
      scheduledEndTime: endDate,
      privacyLevel: 2,      // GUILD_ONLY
      entityType: 3,        // EXTERNAL (with channel link)
      entityMetadata: { location: `#${channel.name}` },
      description: 'Submit your wish (يا ريت) and earn reactions! Round runs from 6PM to 8PM Libya time.',
    });
    console.log(`✅ Discord event created for Ya Rayt round`);
  } catch (err) {
    console.error('Failed to create Discord event:', err.message);
  }
}

  // ─── Leaderboard builder ───────────────────────────────────────────────────

  async function buildLeaderboard(guild, db, key, title, emoji) {
    const yrData = getYaraytData(db, guild.id);
    const users  = Object.entries(yrData.users);

    if (users.length === 0) return null;

    const sorted = users
      .map(([userId, stats]) => ({ userId, score: key === 'total' ? stats.total : stats[key] || 0 }))
      .filter(e => e.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);

    if (sorted.length === 0) return null;

    let memberNames = {};
    try {
      const members = await guild.members.fetch({ user: sorted.map(e => e.userId) });
      members.forEach((m, id) => { memberNames[id] = m.displayName; });
    } catch {}

    const medals = ['🥇','🥈','🥉'];
    const desc   = sorted.map((e, i) =>
      `${medals[i] || `**${i + 1}.**`} **${memberNames[e.userId] || `<@${e.userId}>`}** — ${e.score} ${emoji}`
    ).join('\n');

    return new EmbedBuilder()
      .setColor(0x00AA44)
      .setTitle(`🇱🇾 ${title}`)
      .setDescription(desc)
      .setFooter({ text: 'All-time Ya Rayt leaderboard' });
  }

  // ─── On ready ─────────────────────────────────────────────────────────────

  client.once('clientReady', async () => {
    setTimeout(async () => {
      for (const guild of client.guilds.cache.values()) {
        activeGuildId = guild.id;
        await registerYaraytCommands(guild.id);

        const yrData = getYaraytData(db, guild.id);

        // If a round was active when bot restarted, resume close timer
        if (yrData.currentRound) {
          const closeAt    = roundEndTime(yrData.currentRound.startedAt);
          const msUntilClose = closeAt - Date.now();
          if (msUntilClose <= 0) {
            // Already past close time — close now
            await closeRound(guild, false);
          } else {
            if (closeTimer) clearTimeout(closeTimer);
            closeTimer = setTimeout(() => closeRound(guild, false), msUntilClose);
            console.log(`🇱🇾 Ya Rayt round resumed — closes in ${Math.round(msUntilClose / 1000 / 60)} minutes`);
          }
        }

        // Schedule next round
        scheduleNextRound(guild, yrData);
      }
    }, 10000); // 10 second delay so MongoDB data is loaded first
  });

  // ─── Reaction enforcement ─────────────────────────────────────────────────
  // 1. Remove any emoji that isn't one of the 4 official ones
  // 2. If a user already reacted with one of the 4, remove their new one

  const VALID_EMOJIS = new Set(REACTIONS.map(r => r.emoji));

  client.on('messageReactionAdd', async (reaction, user) => {
    try {
      // Ignore bot reactions
      if (user.bot) return;

      // Fetch partial reaction/message if needed
      if (reaction.partial) await reaction.fetch().catch(() => null);
      if (!reaction.message) return;

      const msg   = reaction.partial ? reaction.message : reaction.message;
      const guild = msg.guild;
      if (!guild) return;

      // Only care about the Ya Rayt channel
      const channelId = process.env.YARAYT_CHANNEL_ID;
      if (!channelId || msg.channelId !== channelId) return;

      // Only care about messages that are active Ya Rayt wishes
      const yrData = getYaraytData(db, guild.id);
      if (!yrData.currentRound) return;

      const wishEntry = Object.values(yrData.currentRound.wishes)
        .find(w => w.messageId === msg.id);
      if (!wishEntry) return;

      const emojiName = reaction.emoji.name;

      // ── Rule 1: Remove invalid emojis immediately ─────────────────────────
      if (!VALID_EMOJIS.has(emojiName)) {
        await reaction.users.remove(user.id).catch(() => {});
        return;
      }

      // ── Rule 2: One reaction per user — remove previous if they picked another
      // Fetch full message to check all reactions
      let fullMsg;
      try { fullMsg = await msg.channel.messages.fetch(msg.id); } catch { return; }

      for (const [, existingReaction] of fullMsg.reactions.cache) {
        // Skip the reaction they just added
        if (existingReaction.emoji.name === emojiName) continue;
        // Skip invalid emojis (already handled above)
        if (!VALID_EMOJIS.has(existingReaction.emoji.name)) continue;
        // Check if this user already reacted with this emoji
        try {
          const users = await existingReaction.users.fetch();
          if (users.has(user.id)) {
            // Remove their old reaction
            await existingReaction.users.remove(user.id).catch(() => {});
          }
        } catch {}
      }

    } catch (err) {
      // Never crash on reaction events
      console.error('Ya Rayt reaction enforcement error:', err.message);
    }
  });

  // ─── Interaction handler ───────────────────────────────────────────────────

  client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    if (!interaction.guild) return;

    const yaraytCommands = ['yarayt','top-yarayt','top-relatable-yarayt','top-funny-yarayt','top-wholesome-yarayt','top-bold-yarayt','yarayt-start'];
    if (!yaraytCommands.includes(interaction.commandName)) return;

    const { commandName, user, guild } = interaction;
    console.log(`📩 Ya Rayt command: /${commandName} from ${user.tag}`);

    try {
      await handleYaraytCommand(interaction, commandName, user, guild);
    } catch (err) {
      console.error(`❌ Ya Rayt error in ${commandName}:`, err);
      try {
        const msg = { content: '❌ Something went wrong. Please try again.', flags: 64 };
        if (interaction.replied || interaction.deferred) await interaction.editReply(msg).catch(() => {});
        else await interaction.reply(msg).catch(() => {});
      } catch {}
    }
  });

  async function handleYaraytCommand(interaction, commandName, user, guild) {
    const yrData = getYaraytData(db, guild.id);

    // ── /yarayt ────────────────────────────────────────────────────────────
    if (commandName === 'yarayt') {
      const wish = interaction.options.getString('wish').trim();

      if (!yrData.currentRound) {
        return interaction.reply({
          content: '❌ There is no active Ya Rayt round right now. Check back when the next round starts!',
          flags: 64,
        });
      }

      if (yrData.currentRound.wishes[user.id]) {
        return interaction.reply({
          content: `❌ You already submitted a wish this round: *"${yrData.currentRound.wishes[user.id].wish}"*\n\nWishes are locked in — no edits!`,
          flags: 64,
        });
      }

      if (wish.length > 280) {
        return interaction.reply({ content: '❌ Your wish must be 280 characters or fewer.', flags: 64 });
      }

      const channel = getYaraytChannel(guild);
      if (!channel) {
        return interaction.reply({ content: '❌ Ya Rayt channel is not configured. Contact an admin.', flags: 64 });
      }

      await interaction.deferReply({ flags: 64 });

      let member;
      try { member = await guild.members.fetch(user.id); } catch {}
      const displayName = member?.displayName || user.username;
      const avatarURL   = user.displayAvatarURL();

      // Post the wish embed in the Ya Rayt channel
      const embed = new EmbedBuilder()
        .setColor(0x00AA44)
        .setAuthor({ name: `${displayName} يا ريت...`, iconURL: avatarURL })
        .setDescription(`**Ya Rayt...** *"${wish}"*`)
        .setFooter({ text: 'React below to vote! 🇱🇾 Relatable · 😂 Funny · ❤️ Wholesome · 🔥 Bold' })
        .setTimestamp();

      const msg = await channel.send({ embeds: [embed] });

      // Add reactions in order
      for (const reaction of REACTIONS) {
        await msg.react(reaction.emoji).catch(() => {});
        await new Promise(r => setTimeout(r, 300)); // small delay between reactions
      }

      // Save the wish
      yrData.currentRound.wishes[user.id] = {
        wish,
        messageId:   msg.id,
        submittedAt: Date.now(),
      };
      saveData(guild.id);

      return interaction.editReply({
        content: `✅ Your wish has been posted in ${channel}!\n\n*"${wish}"*\n\nIt's locked in — good luck! 🇱🇾`,
      });
    }

    // ── /yarayt-start (admin only) ──────────────────────────────────────────
    if (commandName === 'yarayt-start') {
      if (!interaction.memberPermissions?.has('Administrator')) {
        return interaction.reply({ content: '❌ Admin only.', flags: 64 });
      }
      await interaction.deferReply({ flags: 64 });
      await startRound(guild, true);
      return interaction.editReply({ content: '✅ Ya Rayt round started!' });
    }

    // ── Leaderboards ────────────────────────────────────────────────────────
    const leaderboardMap = {
      'top-yarayt':            { key: 'total',     title: 'Top Ya Rayt — All Reactions',       emoji: '⭐' },
      'top-relatable-yarayt':  { key: 'relatable', title: 'Top Ya Rayt — 🇱🇾 Relatable',       emoji: '🇱🇾' },
      'top-funny-yarayt':      { key: 'funny',     title: 'Top Ya Rayt — 😂 Funny',            emoji: '😂' },
      'top-wholesome-yarayt':  { key: 'wholesome', title: 'Top Ya Rayt — ❤️ Wholesome',        emoji: '❤️' },
      'top-bold-yarayt':       { key: 'bold',      title: 'Top Ya Rayt — 🔥 Bold',             emoji: '🔥' },
    };

    if (leaderboardMap[commandName]) {
      const { key, title, emoji } = leaderboardMap[commandName];
      await interaction.deferReply();
      const embed = await buildLeaderboard(guild, db, key, title, emoji);
      if (!embed) {
        return interaction.editReply({ content: '📭 No Ya Rayt data yet! Start a round and submit some wishes.' });
      }
      return interaction.editReply({ embeds: [embed] });
    }
  }

};

module.exports.commands = yaraytCommands;
