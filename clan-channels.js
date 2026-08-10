'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   CLAN CHANNEL UPKEEP
   ---------------------------------------------------------------------------
   A clan channel that nobody has posted in for 28 days gets a warning; at 30
   days it is ARCHIVED rather than deleted — the clan role loses access and the
   channel is renamed with a 💤 prefix, so it vanishes from everyone's sidebar
   while every message survives. Any clan member can pay KEEP_COST Dinar to
   reset the clock, and an archived channel can be restored the same way.

   Nothing here ever deletes a channel. Archiving solves the clutter without the
   one-way door of losing a clan's history to a quiet month.
   ═══════════════════════════════════════════════════════════════════════════ */

const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  PermissionFlagsBits,
} = require('discord.js');

const DAY            = 24 * 60 * 60 * 1000;
const WARN_AFTER     = 28 * DAY;     // first nudge
const ARCHIVE_AFTER  = 30 * DAY;     // hidden (never deleted)
const GRACE          = ARCHIVE_AFTER - WARN_AFTER;   // time between the notice and archiving
const KEEP_COST      = 300;          // Dinar, payable by ANY member of the clan
const CHECK_EVERY    = 6 * 60 * 60 * 1000;
const SLEEP_PREFIX   = '💤-';

const fmt = (n) => Math.round(n).toLocaleString('en-US');
const days = (ms) => Math.floor(ms / DAY);

function clanEntries(db, gid) {
  const raw = db[gid] || {};
  return Object.entries(raw).filter(([k]) => !k.startsWith('__'));
}
// Is this user in this clan at all? Any rank counts — the whole point is that
// anybody can chip in to save the channel, not just the leader.
function inClan(clan, uid) {
  return clan.leader === uid
    || (clan.officers || []).includes(uid)
    || (clan.members || []).includes(uid);
}
function findClanByChannel(db, gid, channelId) {
  for (const [name, clan] of clanEntries(db, gid))
    if (clan.channelId === channelId) return { name, clan };
  return null;
}

/* A channel with no recorded activity yet is treated as active from the moment
   we first see it, so an existing channel is never archived the day this ships. */
function lastActive(clan) {
  if (clan.chLastActive) return clan.chLastActive;
  if (clan.chSeenAt) return clan.chSeenAt;
  return null;
}

const ARCHIVE_CATEGORY_NAME = '🗄️ Archived Clans';

/* Finds the archive category if it already exists, or creates it once. Also
   makes sure it sits at the very bottom of the category list — a channel's
   raw `position` is only meaningful within its own type (categories sort
   separately from text channels), so this walks the guild's own categories to
   find the current max rather than guessing a number. */
async function ensureArchiveCategory(guild) {
  let cat = guild.channels.cache.find(c => c.type === 4 && c.name === ARCHIVE_CATEGORY_NAME); // 4 = GuildCategory
  if (!cat) {
    try {
      cat = await guild.channels.create({ name: ARCHIVE_CATEGORY_NAME, type: 4 });
      console.log(`[clan-upkeep] created "${ARCHIVE_CATEGORY_NAME}" category`);
    } catch (e) {
      console.error('[clan-upkeep] could not create archive category:', e.message);
      return null;
    }
  }
  try {
    const categories = guild.channels.cache.filter(c => c.type === 4);
    const maxPos = Math.max(0, ...categories.map(c => c.rawPosition ?? c.position ?? 0));
    if ((cat.rawPosition ?? cat.position ?? 0) < maxPos) await cat.setPosition(maxPos).catch(() => {});
  } catch (e) { /* position is cosmetic — never let this block archiving */ }
  return cat;
}

async function archiveChannel(guild, name, clan, saveData) {
  const ch = guild.channels.cache.get(clan.channelId) || await guild.channels.fetch(clan.channelId).catch(() => null);
  if (!ch) { clan.channelId = null; saveData(guild.id); return false; }
  try {
    // hide from every clan role, but keep the channel and its history intact
    for (const rid of [clan.memberRoleId, clan.officerRoleId, clan.leaderRoleId, clan.roleId]) {
      if (rid) await ch.permissionOverwrites.edit(rid, { ViewChannel: false }).catch(() => {});
    }
    if (!ch.name.startsWith(SLEEP_PREFIX))
      await ch.setName(`${SLEEP_PREFIX}${ch.name}`.slice(0, 100)).catch(() => {});
    // remember where it came from, then tuck it away at the bottom out of sight
    clan.chOriginalParentId = ch.parentId || null;
    const cat = await ensureArchiveCategory(guild);
    if (cat) await ch.setParent(cat.id, { lockPermissions: false }).catch(e => console.error('[clan-upkeep] setParent failed:', e.message));
    clan.chArchived = true;
    saveData(guild.id);
    console.log(`[clan-upkeep] archived #${ch.name} for clan "${name}"`);
    return true;
  } catch (e) {
    console.error('[clan-upkeep] archive failed:', e.message);
    return false;
  }
}

async function restoreChannel(guild, name, clan, saveData) {
  const ch = guild.channels.cache.get(clan.channelId) || await guild.channels.fetch(clan.channelId).catch(() => null);
  if (!ch) return false;
  try {
    for (const rid of [clan.memberRoleId, clan.officerRoleId, clan.leaderRoleId, clan.roleId]) {
      if (rid) await ch.permissionOverwrites.edit(rid, { ViewChannel: true }).catch(() => {});
    }
    if (ch.name.startsWith(SLEEP_PREFIX))
      await ch.setName(ch.name.slice(SLEEP_PREFIX.length)).catch(() => {});
    // put it back where it came from — a category that's since been deleted just
    // means "no parent" rather than failing the whole restore
    if (clan.chOriginalParentId) {
      const target = guild.channels.cache.get(clan.chOriginalParentId);
      await ch.setParent(target ? target.id : null, { lockPermissions: false }).catch(() => {});
    } else {
      await ch.setParent(null, { lockPermissions: false }).catch(() => {});
    }
    clan.chOriginalParentId = null;
    clan.chArchived = false;
    clan.chLastActive = Date.now();
    clan.chWarnedAt = null;
    clan.chArchiveAt = null;
    saveData(guild.id);
    return true;
  } catch (e) {
    console.error('[clan-upkeep] restore failed:', e.message);
    return false;
  }
}

function keepRow(clanName, cost) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`clanup:keep:${clanName}`)
      .setLabel(`Keep this channel — ${cost} Dinar`)
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success));
}

/* Posts the "final notice" and starts the archive countdown. Used both by the
   automatic sweep at WARN_AFTER and by /clan-channel-warn, so an admin-triggered
   notice is identical to a natural one in every respect. */
async function sendFinalNotice(guild, name, clan, ch, saveData, idleMs) {
  clan.chWarnedAt = Date.now();
  clan.chArchiveAt = Date.now() + GRACE;
  saveData(guild.id);
  const left = Math.max(1, Math.ceil(GRACE / DAY));
  const ping = clan.memberRoleId ? `<@&${clan.memberRoleId}>` : '';
  const idleLine = idleMs != null && idleMs > 0
    ? `No one has posted here in **${days(idleMs)} days**.`
    : 'This channel has been flagged as inactive.';
  await ch.send({
    content: ping || undefined,
    embeds: [new EmbedBuilder().setColor(0xF59E0B)
      .setTitle('⚠️ Final notice — pay to keep this channel')
      .setDescription(
        `${idleLine}\n\n`
        + `In **${left} day${left === 1 ? '' : 's'}** this channel will be **archived** — hidden from your sidebar. `
        + `Nothing gets deleted, and it can always be brought back later.\n\n`
        + `⚠️ **Posting a message will no longer save it.** The only way to keep the channel now is to pay `
        + `**${fmt(KEEP_COST)} Dinar** using the button below.`)
      .setFooter({ text: `Any member of ${name} can pay — it doesn't have to be the leader.` })],
    components: [keepRow(name, KEEP_COST)],
  }).catch(() => {});
}

function initClanChannels({ client, db, saveData, getDinar, spendDinar }) {
  if (!client) return;

  /* ── activity tracking ───────────────────────────────────────────────────
     Any human message in a clan channel resets its clock — but ONLY while the
     channel is in good standing. Once the day-28 warning has fired the channel is
     locked in: posting no longer rescues it, and the fee is the only way back.
     Cheap: a map lookup per message, and we only persist a few times a day so
     this never becomes a save on every message.                                 */
  client.on('messageCreate', (message) => {
    try {
      if (!message.guild || message.author?.bot) return;
      const hit = findClanByChannel(db, message.guild.id, message.channel.id);
      if (!hit) return;
      // Already warned → the grace period is over. Only paying clears it.
      if (hit.clan.chWarnedAt) return;
      const now = Date.now();
      const prev = hit.clan.chLastActive || 0;
      if (now - prev > 6 * 60 * 60 * 1000) {   // only persist a few times a day
        hit.clan.chLastActive = now;
        saveData(message.guild.id);
      } else {
        hit.clan.chLastActive = now;           // keep it fresh in memory regardless
      }
    } catch { /* never let tracking break message handling */ }
  });

  /* ── the periodic sweep ──────────────────────────────────────────────── */
  async function sweep() {
    for (const guild of client.guilds.cache.values()) {
      for (const [name, clan] of clanEntries(db, guild.id)) {
        if (!clan.channelId) continue;
        try {
          // First time we've seen this channel — start its clock now rather than
          // treating a pre-existing channel as instantly 30 days stale.
          if (!lastActive(clan)) { clan.chSeenAt = Date.now(); saveData(guild.id); continue; }
          const idle = Date.now() - lastActive(clan);
          if (clan.chArchived) continue;               // already asleep, leave it

          const ch = guild.channels.cache.get(clan.channelId);
          if (!ch) { clan.channelId = null; saveData(guild.id); continue; }

          // The deadline is set when the notice fires (naturally or by an admin), so
          // archiving always happens GRACE after the warning regardless of how idle
          // the channel was when it was warned.
          if (clan.chArchiveAt && Date.now() >= clan.chArchiveAt) {
            await archiveChannel(guild, name, clan, saveData);
            const leader = clan.leader ? `<@${clan.leader}>` : 'The leader';
            await ch.send({
              embeds: [new EmbedBuilder().setColor(0x64748B)
                .setTitle('💤 Channel archived')
                .setDescription(
                  `This channel has been quiet for **${days(idle)} days**, so it's now hidden.\n\n`
                  + `**Nothing has been deleted** — every message is still here. `
                  + `${leader} or any member can bring it back for **${fmt(KEEP_COST)} Dinar** with \`/clan-channel-restore\`.`)],
            }).catch(() => {});
            continue;
          }

          if (idle >= WARN_AFTER && !clan.chWarnedAt) {
            await sendFinalNotice(guild, name, clan, ch, saveData, idle);
          }
        } catch (e) {
          console.error(`[clan-upkeep] ${name}:`, e.message);
        }
      }
    }
  }
  setInterval(() => sweep().catch(e => console.error('[clan-upkeep] sweep:', e.message)), CHECK_EVERY);
  setTimeout(() => sweep().catch(() => {}), 60 * 1000);   // one pass a minute after boot

  /* ── the Keep button + restore command ───────────────────────────────── */
  client.on('interactionCreate', async (interaction) => {
    try {
      if (!interaction.guildId) return;
      const gid = interaction.guildId, uid = interaction.user.id;

      const pay = async (name, reply) => {
        const clan = (db[gid] || {})[name];
        if (!clan) return reply('That clan no longer exists.');
        if (!inClan(clan, uid)) return reply(`Only members of **${name}** can pay to keep this channel.`);
        if (getDinar(db, gid, uid) < KEEP_COST)
          return reply(`💰 Keeping the channel costs **${fmt(KEEP_COST)} Dinar** — you have **${fmt(getDinar(db, gid, uid))}**.\n`
            + `Any other member of **${name}** can pay it instead.`);
        if (!spendDinar(db, gid, uid, KEEP_COST, saveData)) return reply('Payment failed — try again.');

        const wasArchived = !!clan.chArchived;
        clan.chLastActive = Date.now();
        clan.chWarnedAt = null;
        clan.chArchiveAt = null;      // countdown cancelled
        saveData(gid);
        // interaction.guild is normally present, but fall back to the cache rather
        // than throwing after we've already taken the payment.
        const g = interaction.guild || client.guilds.cache.get(gid);
        if (wasArchived && g) await restoreChannel(g, name, clan, saveData);
        console.log(`[clan-upkeep] ${uid} paid ${KEEP_COST} to keep "${name}" (${wasArchived ? 'restored' : 'renewed'})`);
        return reply(`✅ <@${uid}> paid **${fmt(KEEP_COST)} Dinar** — **${name}**'s channel is `
          + `${wasArchived ? 'back' : 'safe for another 30 days'}.`, true);
      };

      if (interaction.isButton() && interaction.customId.startsWith('clanup:keep:')) {
        const name = interaction.customId.slice('clanup:keep:'.length);
        await interaction.deferReply();          // public: the clan should see it was sorted
        return pay(name, (text, ok) => interaction.editReply({ content: text })
          .then(() => { if (ok) interaction.message.edit({ components: [] }).catch(() => {}); }));
      }

      if (interaction.isChatInputCommand() && interaction.commandName === 'clan-channel-warn') {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator))
          return interaction.reply({ content: '❌ Admins only.', flags: 64 });
        const hit = findClanByChannel(db, gid, interaction.channelId);
        if (!hit)
          return interaction.reply({ content: 'This isn\'t a clan channel. Run this **inside** the clan channel you want to flag.', flags: 64 });
        const { name, clan } = hit;
        if (clan.chArchived)
          return interaction.reply({ content: `**${name}**'s channel is already archived.`, flags: 64 });
        if (clan.chWarnedAt)
          return interaction.reply({
            content: `**${name}** has already been given notice — it archives <t:${Math.floor((clan.chArchiveAt || Date.now()) / 1000)}:R>.`,
            flags: 64,
          });
        await interaction.reply({ content: `📣 Posting the final notice for **${name}**…`, flags: 64 });
        const graceDays = interaction.options.getInteger('days');
        const idle = lastActive(clan) ? Date.now() - lastActive(clan) : null;
        await sendFinalNotice(interaction.guild, name, clan, interaction.channel, saveData, idle);
        if (graceDays) { clan.chArchiveAt = Date.now() + graceDays * DAY; saveData(gid); }
        return interaction.editReply({
          content: `✅ Notice posted for **${name}**. It archives <t:${Math.floor(clan.chArchiveAt / 1000)}:R> `
            + `unless a member pays **${fmt(KEEP_COST)} Dinar**.`,
        }).catch(() => {});
      }

      if (interaction.isChatInputCommand() && interaction.commandName === 'clan-channel-status') {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator))
          return interaction.reply({ content: '❌ Admins only.', flags: 64 });
        const rows = [];
        for (const [name, clan] of clanEntries(db, gid)) {
          if (!clan.channelId) continue;
          const la = lastActive(clan);
          const idle = la ? days(Date.now() - la) : null;
          let state;
          if (clan.chArchived) state = '💤 archived';
          else if (clan.chWarnedAt) state = `⚠️ notice given — archives <t:${Math.floor((clan.chArchiveAt || Date.now()) / 1000)}:R>`;
          else if (idle == null) state = '🆕 clock just started';
          else if (idle >= days(WARN_AFTER)) state = '⏰ due a notice';
          else state = '✅ active';
          rows.push({ name, idle, line: `<#${clan.channelId}> · **${name}** — ${idle == null ? 'no data' : `idle **${idle}d**`} · ${state}` });
        }
        rows.sort((a, b) => (b.idle ?? -1) - (a.idle ?? -1));   // stalest first
        const e = new EmbedBuilder().setColor(0x64748B).setTitle('🏰 Clan channel status')
          .setDescription(rows.length ? rows.map(r => r.line).join('\n').slice(0, 4000) : '_No clan channels yet._')
          .setFooter({ text: `Notice at ${days(WARN_AFTER)}d idle · archives ${Math.ceil(GRACE / DAY)}d later · ${KEEP_COST} Dinar to keep` });
        return interaction.reply({ embeds: [e], flags: 64 });
      }

      if (interaction.isChatInputCommand() && interaction.commandName === 'clan-channel-restore') {
        const hit = Object.entries(db[gid] || {}).find(([k, c]) => !k.startsWith('__') && inClan(c, uid));
        if (!hit) return interaction.reply({ content: 'You\'re not in a clan.', flags: 64 });
        const [name, clan] = hit;
        if (!clan.channelId) return interaction.reply({ content: 'Your clan has no channel. A Leader can make one with `/clan-channel-create`.', flags: 64 });
        if (!clan.chArchived) return interaction.reply({ content: 'Your clan channel is already active — nothing to restore.', flags: 64 });
        await interaction.deferReply();
        return pay(name, (text) => interaction.editReply({ content: text }));
      }
    } catch (e) {
      console.error('[clan-upkeep] interaction:', e.message);
      try {
        if (interaction.deferred && !interaction.replied) await interaction.editReply({ content: '⚠️ Something went wrong. Try again in a moment.' });
        else if (!interaction.replied) await interaction.reply({ content: '⚠️ Something went wrong. Try again in a moment.', flags: 64 });
      } catch { /* */ }
    }
  });

  console.log(`🏰 Clan channel upkeep active — warn at ${days(WARN_AFTER)}d, archive at ${days(ARCHIVE_AFTER)}d, ${KEEP_COST} Dinar to keep`);
  return { sweep };   // returned so the sweep can be run on demand (and tested)
}

function getClanChannelCommands() {
  return [
    new SlashCommandBuilder()
      .setName('clan-channel-restore')
      .setDescription(`Bring your clan's archived channel back (${KEEP_COST} Dinar — any member can pay)`)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('clan-channel-warn')
      .setDescription('Post the final "pay to keep" notice in this clan channel now (admin only)')
      .addIntegerOption(o => o.setName('days')
        .setDescription(`Days before it archives (default ${Math.ceil(GRACE / DAY)})`)
        .setMinValue(1).setMaxValue(30).setRequired(false))
      .setDefaultMemberPermissions(0)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('clan-channel-status')
      .setDescription('List every clan channel and how long it has been idle (admin only)')
      .setDefaultMemberPermissions(0)
      .toJSON(),
  ];
}

module.exports = {
  initClanChannels, getClanChannelCommands,
  KEEP_COST, WARN_AFTER, ARCHIVE_AFTER,
  // exported for tests
  _internals: { findClanByChannel, inClan, lastActive, archiveChannel, restoreChannel },
};
