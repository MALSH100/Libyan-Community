// ─── Qa'ima (قائمة) — Server Collection Game with Dinar Economy ───────────────
// A Mudae-inspired collection game, customised for the Libyan server.
//
//  • Members OPT IN to become claimable cards (their Discord name + avatar).
//  • /gacha-roll drops a random opted-in member as a card after a 5-second
//    warning. Anyone can Claim it (free-snipe) within 60 seconds — race to click.
//  • If the rolled member is ALREADY owned, a 💵 Claim Dinar button appears
//    instead — first to click pockets some Dinar.
//  • /gacha-wish pings a member that someone wants them (and nudges them to opt
//    in). When a wishlisted member is rolled, their wishers get pinged.
//  • Rarity (Common→Mythic) is LIVE — ranked from each member's activity score
//    (LP, Pokémon, Ya Rayt, POTD) against the rest of the pool, so it shifts as
//    the server grows. Rarer cards are worth more Dinar and appear less often.
//  • Earn Dinar: /gacha-daily, releasing members, Dinar drops, and (via the
//    exported awardDinar) clan wars, Ya Rayt, POTD, and Pokémon.
//
// COOLDOWNS: roll is PER-USER, once every 2 hours; claim is once per day per
// person; a dropped card expires after 60 seconds.
//
// Every command is prefixed `gacha-` so typing "gacha" in Discord lists them all.
//
// Wiring in index.js:
//   1. const { getGachaCommands, initGacha, awardDinar } = require('./gacha');
//   2. add ...getGachaCommands() to the command-registration array
//   3. call initGacha({ client, db, saveData }); near your other init functions
//   4. award Dinar from other systems: awardDinar(db, guildId, userId, amount, saveData)

const {
  SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
} = require('discord.js');

// ─── Tuning ──────────────────────────────────────────────────────────────────
const TIERS       = ['Common', 'Rare', 'Epic', 'Legendary', 'Mythic'];
const TIER_EMOJI  = { Common: '⚪', Rare: '🔵', Epic: '🟣', Legendary: '🟡', Mythic: '🔴' };
const TIER_VALUE  = { Common: 100, Rare: 500, Epic: 1500, Legendary: 5000, Mythic: 15000 };
const TIER_WEIGHT = { Common: 100, Rare: 40, Epic: 15, Legendary: 5, Mythic: 1 };   // roll odds
const TIER_COLOR  = { Common: 0x95A5A6, Rare: 0x3498DB, Epic: 0x9B59B6, Legendary: 0xF1C40F, Mythic: 0xE74C3C };

const ROLL_COOLDOWN_MS   = 3 * 60 * 60 * 1000;   // PER-USER: one roll every 3 hours
const CLAIM_COOLDOWN_MS  = 3 * 60 * 60 * 1000;   // per-user: one claim every 3 hours
const ROLL_DROP_DELAY_MS = 5 * 1000;             // warning before the card reveals
const ROLL_EXPIRY_MS     = 60 * 1000;            // claim window
const RARITY_RECALC_MS   = 6 * 60 * 60 * 1000;
const TRADE_TTL_MS       = 5 * 60 * 1000;
const DAILY_BASE         = 50;
const DINAR_DROP_MIN     = 25;
const DINAR_DROP_MAX     = 125;
const RELEASE_REFUND     = 0.5;

function defaults() {
  return {
    enabled:        true,
    channels:       [],     // allowed channel IDs; [] = anywhere
    rollChannels:   [],     // channels where /gacha-roll may be used; [] = no extra restriction
    tradingEnabled: true,
    lastRarityCalc: 0,
    pool:        {},   // userId -> { rarity, score, value, rarityOverride, valueOverride }
    owners:      {},   // claimedUserId -> ownerId
    wishlists:   {},   // userId -> [wishedUserId, ...]
    dinar:       {},   // userId -> balance
    cooldowns:   {},   // userId -> { roll, claim, daily }
    stats:       {},   // userId -> { rolls, claims }
    trades:      {},   // tradeId -> { from, to, give, receive, ts }
  };
}

// ─── State helpers ───────────────────────────────────────────────────────────
function getState(db, guildId) {
  if (!db[guildId]) db[guildId] = {};
  if (!db[guildId].__gacha) db[guildId].__gacha = defaults();
  const s = db[guildId].__gacha;
  const d = defaults();
  for (const k of Object.keys(d)) if (s[k] === undefined) s[k] = d[k];
  return s;
}
const dinarOf = (s, uid) => s.dinar[uid] || 0;
function addDinar(s, uid, n) { s.dinar[uid] = Math.max(0, (s.dinar[uid] || 0) + n); }
const collectionOf = (s, ownerId) => Object.keys(s.owners).filter(cid => s.owners[cid] === ownerId);
const eph = (content) => ({ content, flags: 64 });
const fmt = (n) => n.toLocaleString('en-US');

// Exported so other systems (clan wars, Ya Rayt, POTD, Pokémon) can pay out Dinar.
function awardDinar(db, guildId, userId, amount, saveData) {
  if (!guildId || !userId || !amount) return;
  const s = getState(db, guildId);
  addDinar(s, userId, amount);
  if (typeof saveData === 'function') saveData(guildId);
}

// ─── Rarity from existing stats ──────────────────────────────────────────────
function activityScore(db, guildId, uid) {
  const g = db[guildId] || {};
  const lpTotal     = g.__lp?.[uid]?.total || 0;            // already aggregates war/pokemon/yarayt LP
  const poke        = g.__pokemon?.[uid] || {};
  const pokeCaught  = poke.pokemon?.length || 0;
  const battleWins  = poke.battleWins || 0;
  const yr          = g.__yarayt?.users?.[uid] || {};
  const yrReactions = (yr.relatable || 0) + (yr.funny || 0) + (yr.wholesome || 0) + (yr.bold || 0);
  const potdWins    = g.__potd?.hallOfFame?.[uid]?.wins || 0;
  return lpTotal + pokeCaught * 3 + battleWins * 5 + yrReactions * 2 + potdWins * 25;
}

function recomputeRarities(db, guildId) {
  const s = getState(db, guildId);
  const ids = Object.keys(s.pool);
  const scored = ids.map(id => ({ id, score: activityScore(db, guildId, id) }))
                    .sort((a, b) => a.score - b.score);   // ascending
  const n = scored.length;
  scored.forEach((e, i) => {
    const entry = s.pool[e.id];
    entry.score = e.score;
    const pct = n <= 1 ? 1 : i / (n - 1);                 // 0 (lowest) .. 1 (highest)
    let tier;
    if (entry.rarityOverride && TIERS.includes(entry.rarityOverride)) tier = entry.rarityOverride;
    else if (pct >= 0.99) tier = 'Mythic';
    else if (pct >= 0.95) tier = 'Legendary';
    else if (pct >= 0.80) tier = 'Epic';
    else if (pct >= 0.50) tier = 'Rare';
    else                  tier = 'Common';
    entry.rarity = tier;
    entry.value  = entry.valueOverride != null ? entry.valueOverride : TIER_VALUE[tier];
  });
  s.lastRarityCalc = Date.now();
}

function ensureFreshRarities(db, guildId, force = false) {
  const s = getState(db, guildId);
  if (force || !s.lastRarityCalc || Date.now() - s.lastRarityCalc > RARITY_RECALC_MS) recomputeRarities(db, guildId);
}

// Weighted roll — rarer members appear less often
function weightedRoll(s) {
  const ids = Object.keys(s.pool);
  if (!ids.length) return null;
  const weights = ids.map(id => TIER_WEIGHT[s.pool[id].rarity] || 50);
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < ids.length; i++) { r -= weights[i]; if (r <= 0) return ids[i]; }
  return ids[ids.length - 1];
}

// Remove a member as a CHARACTER everywhere (opt-out / force-remove)
function dissolveMember(s, uid) {
  delete s.pool[uid];
  for (const cid of Object.keys(s.owners)) if (cid === uid) delete s.owners[cid];
  for (const wid of Object.keys(s.wishlists)) s.wishlists[wid] = (s.wishlists[wid] || []).filter(x => x !== uid);
}

const channelAllowed = (s, channelId) => !s.channels.length || s.channels.includes(channelId);
const rollChannelAllowed = (s, channelId) => !s.rollChannels?.length || s.rollChannels.includes(channelId);

function cardEmbed(member, entry, ownerId) {
  const name = member?.displayName || 'User';
  const roles = member?.roles?.cache
    ? [...member.roles.cache.values()].filter(r => r.name !== '@everyone').sort((a, b) => b.position - a.position).slice(0, 4).map(r => r.name)
    : [];
  const embed = new EmbedBuilder()
    .setColor(TIER_COLOR[entry.rarity])
    .setTitle(`${TIER_EMOJI[entry.rarity]} ${name}`)
    .setDescription(`**${entry.rarity}** — 💰 **${fmt(entry.value)} Dinar**`)
    .addFields({ name: 'Roles', value: roles.length ? roles.join(', ') : '—' });
  if (member?.displayAvatarURL) embed.setImage(member.displayAvatarURL({ extension: 'png', size: 512 }));
  embed.setFooter({ text: ownerId ? '💵 Already owned — grab the Dinar Drop!' : '🎴 First to Claim wins them!' });
  return embed;
}

// ─── Command definitions (all prefixed gacha-) ───────────────────────────────
function getGachaCommands() {
  return [
    new SlashCommandBuilder().setName('gacha-roll').setDescription('Roll a random opted-in member as a card').setDMPermission(false),
    new SlashCommandBuilder().setName('gacha-optin').setDescription('Become a claimable card in the collection game').setDMPermission(false),
    new SlashCommandBuilder().setName('gacha-optout').setDescription('Leave the game — removes you and dissolves all claims/wishlists of you').setDMPermission(false),
    new SlashCommandBuilder().setName('gacha-wish').setDescription('Add a member to your wishlist (pings them)').setDMPermission(false)
      .addUserOption(o => o.setName('user').setDescription('The member you want').setRequired(true)),
    new SlashCommandBuilder().setName('gacha-wishlist').setDescription('View or clear your wishlist').setDMPermission(false)
      .addStringOption(o => o.setName('action').setDescription('view or remove').setRequired(false)
        .addChoices({ name: 'view', value: 'view' }, { name: 'remove', value: 'remove' }))
      .addUserOption(o => o.setName('user').setDescription('Member to remove').setRequired(false)),
    new SlashCommandBuilder().setName('gacha-daily').setDescription('Claim your daily Dinar').setDMPermission(false),
    new SlashCommandBuilder().setName('dinar').setDescription('Check a Dinar balance').setDMPermission(false)
      .addUserOption(o => o.setName('user').setDescription('Whose balance (default: you)').setRequired(false)),
    new SlashCommandBuilder().setName('dinar-set').setDescription('Set a member\'s Dinar balance exactly (admin only)')
      .setDMPermission(false).setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addUserOption(o => o.setName('user').setDescription('The member').setRequired(true))
      .addIntegerOption(o => o.setName('amount').setDescription('New balance (e.g. 0 to reset)').setRequired(true).setMinValue(0)),
    new SlashCommandBuilder().setName('gacha-collection').setDescription('View a collection').setDMPermission(false)
      .addUserOption(o => o.setName('user').setDescription('Whose collection (default: you)').setRequired(false)),
    new SlashCommandBuilder().setName('gacha-rarest').setDescription('Show the top 15 rarest cards in the server').setDMPermission(false),
    new SlashCommandBuilder().setName('gacha-release').setDescription('Release a member you own for Dinar').setDMPermission(false)
      .addUserOption(o => o.setName('user').setDescription('The member to release').setRequired(true)),
    new SlashCommandBuilder().setName('gacha-trade').setDescription('Propose a trade with another collector').setDMPermission(false)
      .addUserOption(o => o.setName('with').setDescription('The collector to trade with').setRequired(true))
      .addUserOption(o => o.setName('give').setDescription('A member YOU own to give').setRequired(true))
      .addUserOption(o => o.setName('receive').setDescription('A member THEY own to receive').setRequired(true)),
    new SlashCommandBuilder().setName('gacha-leaderboard').setDescription('Top collectors in the server').setDMPermission(false),
    new SlashCommandBuilder().setName('gacha-list').setDescription('See who is opted in to the collection game (private)').setDMPermission(false),

    // ── Admin ──────────────────────────────────────────────────────────────
    new SlashCommandBuilder().setName('gacha-admin').setDescription('Gacha admin controls (admin only)')
      .setDMPermission(false).setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addSubcommand(sc => sc.setName('toggle').setDescription('Enable or disable the whole game')
        .addStringOption(o => o.setName('state').setDescription('on/off').setRequired(true).addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' })))
      .addSubcommand(sc => sc.setName('trading').setDescription('Enable or disable trading')
        .addStringOption(o => o.setName('state').setDescription('on/off').setRequired(true).addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' })))
      .addSubcommand(sc => sc.setName('channel').setDescription('Restrict which channels the game works in')
        .addStringOption(o => o.setName('action').setDescription('add/remove/clear').setRequired(true).addChoices({ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' }, { name: 'clear (allow all)', value: 'clear' }))
        .addChannelOption(o => o.setName('channel').setDescription('Channel (for add/remove)').setRequired(false)))
      .addSubcommand(sc => sc.setName('rollchannel').setDescription('Restrict which channels /gacha-roll works in (keeps rolls public)')
        .addStringOption(o => o.setName('action').setDescription('add/remove/clear').setRequired(true).addChoices({ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' }, { name: 'clear (allow all)', value: 'clear' }))
        .addChannelOption(o => o.setName('channel').setDescription('Channel (for add/remove)').setRequired(false)))
      .addSubcommand(sc => sc.setName('optin').setDescription('Force a member into the game (make them claimable)')
        .addUserOption(o => o.setName('user').setDescription('The member').setRequired(true)))
      .addSubcommand(sc => sc.setName('resetroll').setDescription('Reset roll & claim cooldowns for a member, or everyone if none given')
        .addUserOption(o => o.setName('user').setDescription('The member (leave empty for everyone)').setRequired(false)))
      .addSubcommand(sc => sc.setName('override').setDescription('Override a member\'s rarity and/or Dinar value')
        .addUserOption(o => o.setName('user').setDescription('The member').setRequired(true))
        .addStringOption(o => o.setName('rarity').setDescription('Force a rarity (or clear)').setRequired(false).addChoices(...TIERS.map(t => ({ name: t, value: t })), { name: 'clear override', value: 'clear' }))
        .addIntegerOption(o => o.setName('value').setDescription('Force a Dinar value (-1 to clear)').setRequired(false)))
      .addSubcommand(sc => sc.setName('release').setDescription('Force-release a member from whoever owns them')
        .addUserOption(o => o.setName('user').setDescription('The claimed member').setRequired(true)))
      .addSubcommand(sc => sc.setName('forceremove').setDescription('Remove a member from the game entirely')
        .addUserOption(o => o.setName('user').setDescription('The member').setRequired(true)))
      .addSubcommand(sc => sc.setName('recompute').setDescription('Recalculate all rarities now')),
  ].map(c => c.toJSON());
}

// ─── Init ────────────────────────────────────────────────────────────────────
function initGacha({ client, db, saveData }) {
  const CMDS = new Set([
    'gacha-roll', 'gacha-optin', 'gacha-optout', 'gacha-wish', 'gacha-wishlist', 'gacha-daily',
    'dinar', 'dinar-set', 'gacha-collection', 'gacha-rarest', 'gacha-release', 'gacha-trade', 'gacha-leaderboard', 'gacha-list', 'gacha-admin',
  ]);
  // Currency commands are exempt from the kill-switch and channel gate, since
  // Dinar is shared across the other games.
  const EXEMPT = new Set(['gacha-admin', 'dinar', 'dinar-set']);

  // Transient live-roll state, keyed by message ID (kept in memory, NOT in db,
  // so it never bloats Mongo). Multiple cards can be live at once now that rolls
  // are per-user. { guildId, memberId, type, claimed, dinarClaimed, expiresAt }
  const liveRolls = {};

  // Periodic rarity recompute + cleanup of abandoned trade offers across guilds
  setInterval(() => {
    const now = Date.now();
    for (const gid of Object.keys(db)) {
      const g = db[gid]?.__gacha;
      if (!g) continue;
      // Sweep abandoned trades (nobody accepted/declined) so they don't pile up
      // in the saved DB forever.
      if (g.trades) for (const tid of Object.keys(g.trades)) {
        if (now - (g.trades[tid].ts || 0) > TRADE_TTL_MS) delete g.trades[tid];
      }
      if (Object.keys(g.pool || {}).length) {
        try { recomputeRarities(db, gid); } catch (e) { console.error('[gacha] recompute:', e.message); }
      }
    }
    saveData();
  }, RARITY_RECALC_MS).unref();

  client.on('interactionCreate', async (interaction) => {
    try {
      if (interaction.isButton() && interaction.customId.startsWith('gacha_')) return handleButton(interaction);
      if (!interaction.isChatInputCommand() || !CMDS.has(interaction.commandName)) return;
      if (!interaction.guild) return interaction.reply(eph('This game only works in a server.')).catch(() => {});

      const s = getState(db, interaction.guild.id);
      if (!s.enabled && !EXEMPT.has(interaction.commandName)) return interaction.reply(eph('🚫 The collection game is currently disabled.')).catch(() => {});
      if (!EXEMPT.has(interaction.commandName) && !channelAllowed(s, interaction.channelId)) {
        return interaction.reply(eph(`🚫 The game can only be used in: ${s.channels.map(c => `<#${c}>`).join(', ')}`)).catch(() => {});
      }

      switch (interaction.commandName) {
        case 'gacha-roll':        return cmdRoll(interaction, s);
        case 'gacha-optin':       return cmdOptIn(interaction, s);
        case 'gacha-optout':      return cmdOptOut(interaction, s);
        case 'gacha-wish':        return cmdWish(interaction, s);
        case 'gacha-wishlist':    return cmdWishlist(interaction, s);
        case 'gacha-daily':       return cmdDaily(interaction, s);
        case 'dinar':             return cmdDinar(interaction, s);
        case 'dinar-set':         return cmdDinarSet(interaction, s);
        case 'gacha-collection':  return cmdCollection(interaction, s);
        case 'gacha-rarest':      return cmdRarest(interaction, s);
        case 'gacha-release':     return cmdRelease(interaction, s);
        case 'gacha-trade':       return cmdTrade(interaction, s);
        case 'gacha-leaderboard': return cmdLeaderboard(interaction, s);
        case 'gacha-list':        return cmdList(interaction, s);
        case 'gacha-admin':       return cmdAdmin(interaction, s);
      }
    } catch (err) {
      console.error('[gacha] handler error:', err.message);
      if (interaction.isRepliable?.() && !interaction.replied && !interaction.deferred) {
        interaction.reply(eph(`⚠️ Something went wrong: ${err.message}`)).catch(() => {});
      }
    }
  });

  // ── /gacha-roll ────────────────────────────────────────────────────────────
  async function cmdRoll(interaction, s) {
    const uid = interaction.user.id;
    ensureFreshRarities(db, interaction.guild.id);
    if (!Object.keys(s.pool).length) return interaction.reply(eph('Nobody has opted in yet. Be the first with `/gacha-optin`!'));

    // Roll-only channel restriction: keeps rolls public so they can't be sniped
    // uncontested in private clan channels.
    if (!rollChannelAllowed(s, interaction.channelId)) {
      return interaction.reply(eph(`🎲 Rolling is only allowed in: ${s.rollChannels.map(c => `<#${c}>`).join(', ')}`));
    }

    // PER-USER cooldown: one roll every 2 hours
    const cd = (s.cooldowns[uid] ||= {});
    const wait = (cd.roll || 0) + ROLL_COOLDOWN_MS - Date.now();
    if (wait > 0) {
      const h = Math.floor(wait / 3600000), m = Math.ceil((wait % 3600000) / 60000);
      return interaction.reply(eph(`⏳ You can roll again in **${h}h ${m}m**.`));
    }
    cd.roll = Date.now();
    (s.stats[uid] ||= { rolls: 0, claims: 0 }).rolls++;

    const rolledId = weightedRoll(s);
    const entry = s.pool[rolledId];
    const ownerId = s.owners[rolledId];
    let member; try { member = await interaction.guild.members.fetch(rolledId); } catch {}

    await interaction.reply('🎴 **A card is dropping in 5 seconds…**');
    if (!s.pool[uid]) interaction.followUp(eph('💡 You\'re not opted in, so others can\'t roll *you*. Join with `/gacha-optin`!')).catch(() => {});
    saveData(interaction.guild.id);

    setTimeout(async () => {
      try {
        const embed = cardEmbed(member, entry, ownerId);
        const wishers = Object.keys(s.wishlists).filter(w => (s.wishlists[w] || []).includes(rolledId) && w !== rolledId && w !== uid);
        const name = member?.displayName || 'this member';
        let row, content;
        if (ownerId) {
          row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('gacha_dinardrop').setLabel('Claim Dinar').setStyle(ButtonStyle.Success).setEmoji('💵'));
          content = wishers.length ? `🔔 ${wishers.map(w => `<@${w}>`).join(' ')} — **${name}** appeared (already owned)!` : undefined;
        } else {
          row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`gacha_claim:${rolledId}`).setLabel('Claim').setStyle(ButtonStyle.Success).setEmoji('🎴'));
          content = wishers.length ? `🔔 ${wishers.map(w => `<@${w}>`).join(' ')} — one of your wished members appeared: **${name}**!` : undefined;
        }
        const msg = await interaction.editReply({ content, embeds: [embed], components: [row], allowedMentions: { users: wishers } });
        liveRolls[msg.id] = { guildId: interaction.guild.id, memberId: rolledId, type: ownerId ? 'dinardrop' : 'claim', claimed: false, dinarClaimed: false, expiresAt: Date.now() + ROLL_EXPIRY_MS };

        setTimeout(() => {
          const lr = liveRolls[msg.id];
          if (lr && !lr.claimed && !lr.dinarClaimed) {
            delete liveRolls[msg.id];
            embed.setFooter({ text: ownerId
              ? '⌛ Time ran out — nobody grabbed the Dinar Drop.'
              : '⌛ Time ran out — nobody claimed this card. They stay unclaimed.' });
            interaction.editReply({ embeds: [embed], components: [] }).catch(() => {});
          }
        }, ROLL_EXPIRY_MS).unref?.();
      } catch (e) { console.error('[gacha] reveal:', e.message); }
    }, ROLL_DROP_DELAY_MS);
  }

  // ── opt-in / opt-out ───────────────────────────────────────────────────────
  function cmdOptIn(interaction, s) {
    const uid = interaction.user.id;
    if (s.pool[uid]) return interaction.reply(eph('✅ You\'re already opted in and claimable.'));
    s.pool[uid] = { rarity: 'Common', score: 0, value: TIER_VALUE.Common, rarityOverride: null, valueOverride: null };
    recomputeRarities(db, interaction.guild.id);
    saveData(interaction.guild.id);
    return interaction.reply({ content: `🎴 **${interaction.user.username}** joined the collection game — now a **${s.pool[uid].rarity}** card worth 💰 ${fmt(s.pool[uid].value)} Dinar! Opt out anytime with \`/gacha-optout\`.` });
  }
  function cmdOptOut(interaction, s) {
    const uid = interaction.user.id;
    if (!s.pool[uid]) return interaction.reply(eph('You\'re not opted in.'));
    dissolveMember(s, uid);
    recomputeRarities(db, interaction.guild.id);
    saveData(interaction.guild.id);
    return interaction.reply({ content: `👋 **${interaction.user.username}** opted out of the collection game. They've been removed from the pool, and every claim and wishlist of them has been dissolved.` });
  }

  // ── /gacha-wish + /gacha-wishlist ──────────────────────────────────────────
  async function cmdWish(interaction, s) {
    const uid = interaction.user.id;
    const target = interaction.options.getUser('user');
    if (target.id === uid) return interaction.reply(eph('You can\'t wishlist yourself.'));
    if (target.bot)        return interaction.reply(eph('You can\'t wishlist a bot.'));
    const wl = (s.wishlists[uid] ||= []);
    if (wl.includes(target.id)) return interaction.reply(eph('They\'re already on your wishlist.'));
    if (wl.length >= 20)        return interaction.reply(eph('Your wishlist is full (20 max).'));
    wl.push(target.id);
    saveData(interaction.guild.id);
    const optedIn = !!s.pool[target.id];
    const msg = optedIn
      ? `⭐ <@${target.id}> — **${interaction.user.username}** added you to their wishlist! They'll race to claim you when you're rolled.`
      : `⭐ <@${target.id}> — **${interaction.user.username}** wants to collect you, but you're not in the game yet! Use \`/gacha-optin\` to become a claimable card.`;
    await interaction.reply({ content: msg, allowedMentions: { users: [target.id] } });
  }
  function cmdWishlist(interaction, s) {
    const uid = interaction.user.id;
    const action = interaction.options.getString('action') || 'view';
    const wl = (s.wishlists[uid] ||= []);
    if (action === 'view') return interaction.reply(eph(wl.length ? `⭐ Your wishlist: ${wl.map(w => `<@${w}>`).join(', ')}` : 'Your wishlist is empty. Add someone with `/gacha-wish`.'));
    const target = interaction.options.getUser('user');
    if (!target) return interaction.reply(eph('Pick a member to remove.'));
    s.wishlists[uid] = wl.filter(x => x !== target.id);
    saveData(interaction.guild.id);
    return interaction.reply(eph(`Removed <@${target.id}> from your wishlist.`));
  }

  // ── /gacha-daily + /gacha-dinar ────────────────────────────────────────────
  function cmdDaily(interaction, s) {
    const uid = interaction.user.id;
    const cd = (s.cooldowns[uid] ||= {});
    const since = Date.now() - (cd.daily || 0);
    if (since < 22 * 60 * 60 * 1000) {
      const left = 22 * 60 * 60 * 1000 - since;
      return interaction.reply(eph(`⏳ You've already claimed today. Come back in ${Math.floor(left / 3600000)}h ${Math.ceil((left % 3600000) / 60000)}m.`));
    }
    ensureFreshRarities(db, interaction.guild.id);
    const bonus = Math.floor(collectionOf(s, uid).reduce((sum, cid) => sum + (s.pool[cid]?.value || 0), 0) / 50);
    const total = DAILY_BASE + bonus;
    addDinar(s, uid, total);
    cd.daily = Date.now();
    saveData(interaction.guild.id);
    return interaction.reply(eph(`💰 Daily claimed: **+${fmt(total)} Dinar** (${fmt(DAILY_BASE)} base${bonus ? ` + ${fmt(bonus)} collection bonus` : ''}). Balance: **${fmt(dinarOf(s, uid))}**.`));
  }
  function cmdDinar(interaction, s) {
    const target = interaction.options.getUser('user') || interaction.user;
    return interaction.reply({ content: `💰 **${target.username}** has **${fmt(dinarOf(s, target.id))} Dinar**.` });
  }
  function cmdDinarSet(interaction, s) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return interaction.reply(eph('🚫 Admins only.'));
    const u = interaction.options.getUser('user');
    const amount = Math.max(0, interaction.options.getInteger('amount'));
    s.dinar[u.id] = amount;
    saveData(interaction.guild.id);
    return interaction.reply(eph(`✅ Set <@${u.id}>'s balance to **${fmt(amount)} Dinar**.`));
  }

  // ── /gacha-collection ──────────────────────────────────────────────────────
  function cmdCollection(interaction, s) {
    const target = interaction.options.getUser('user') || interaction.user;
    ensureFreshRarities(db, interaction.guild.id);
    const owned = collectionOf(s, target.id);
    const totalValue = owned.reduce((sum, cid) => sum + (s.pool[cid]?.value || 0), 0);
    const byTier = {};
    for (const cid of owned) { const t = s.pool[cid]?.rarity || 'Common'; (byTier[t] ||= []).push(cid); }
    const lines = [];
    for (const t of [...TIERS].reverse()) if (byTier[t]?.length) lines.push(`${TIER_EMOJI[t]} **${t}** (${byTier[t].length}): ${byTier[t].map(c => `<@${c}>`).join(', ')}`);
    const embed = new EmbedBuilder().setColor(0x9B59B6)
      .setTitle(`🎴 ${target.username}'s Collection`).setThumbnail(target.displayAvatarURL())
      .setDescription(owned.length ? lines.join('\n') : '_Empty — roll with `/gacha-roll` and claim someone!_')
      .addFields({ name: 'Members owned', value: `${owned.length}`, inline: true }, { name: 'Total value', value: `💰 ${fmt(totalValue)} Dinar`, inline: true });
    return interaction.reply({ embeds: [embed] });
  }

  // ── /gacha-rarest (top 15) ─────────────────────────────────────────────────
  function cmdRarest(interaction, s) {
    ensureFreshRarities(db, interaction.guild.id);
    const ids = Object.keys(s.pool);
    if (!ids.length) return interaction.reply(eph('Nobody has opted in yet.'));
    const ranked = ids.map(id => ({ id, ...s.pool[id] }))
      .sort((a, b) => (b.value - a.value) || (b.score - a.score))
      .slice(0, 15);
    const lines = ranked.map((e, i) => {
      const owner = s.owners[e.id] ? `owned by <@${s.owners[e.id]}>` : '_unclaimed_';
      return `**${i + 1}.** ${TIER_EMOJI[e.rarity]} <@${e.id}> · ${e.rarity} · 💰 ${fmt(e.value)} · ${owner}`;
    });
    const embed = new EmbedBuilder().setColor(0xE74C3C).setTitle('💎 Top 15 Rarest Cards').setDescription(lines.join('\n'));
    return interaction.reply({ embeds: [embed] });
  }

  // ── /gacha-release (divorce) ───────────────────────────────────────────────
  function cmdRelease(interaction, s) {
    const uid = interaction.user.id;
    const target = interaction.options.getUser('user');
    if (s.owners[target.id] !== uid) return interaction.reply(eph(`You don't own <@${target.id}>.`));
    ensureFreshRarities(db, interaction.guild.id);
    const refund = Math.floor((s.pool[target.id]?.value || 0) * RELEASE_REFUND);
    delete s.owners[target.id];
    addDinar(s, uid, refund);
    saveData(interaction.guild.id);
    return interaction.reply(eph(`💔 Released <@${target.id}> and received **+${fmt(refund)} Dinar**. They're claimable again. Balance: **${fmt(dinarOf(s, uid))}**.`));
  }

  // ── /gacha-trade ───────────────────────────────────────────────────────────
  async function cmdTrade(interaction, s) {
    const uid = interaction.user.id;
    if (!s.tradingEnabled) return interaction.reply(eph('🚫 Trading is currently disabled.'));
    const other = interaction.options.getUser('with');
    const give  = interaction.options.getUser('give');
    const recv  = interaction.options.getUser('receive');
    if (other.id === uid) return interaction.reply(eph('You can\'t trade with yourself.'));
    if (other.bot)        return interaction.reply(eph('You can\'t trade with a bot.'));
    if (s.owners[give.id] !== uid)     return interaction.reply(eph(`You don't own <@${give.id}>.`));
    if (s.owners[recv.id] !== other.id) return interaction.reply(eph(`<@${other.id}> doesn't own <@${recv.id}>.`));
    const tradeId = `${uid}-${Date.now()}`;
    s.trades[tradeId] = { from: uid, to: other.id, give: give.id, receive: recv.id, ts: Date.now() };
    saveData(interaction.guild.id);
    const embed = new EmbedBuilder().setColor(0x3498DB).setTitle('🔁 Trade Offer')
      .setDescription(`<@${uid}> offers <@${give.id}> for your <@${recv.id}>.\n<@${other.id}>, do you accept?`);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`gacha_trade_ok:${tradeId}`).setLabel('Accept').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`gacha_trade_no:${tradeId}`).setLabel('Decline').setStyle(ButtonStyle.Danger));
    return interaction.reply({ content: `<@${other.id}>`, embeds: [embed], components: [row], allowedMentions: { users: [other.id] } });
  }

  // ── /gacha-leaderboard ─────────────────────────────────────────────────────
  function cmdLeaderboard(interaction, s) {
    ensureFreshRarities(db, interaction.guild.id);
    const owners = {};
    for (const cid of Object.keys(s.owners)) {
      const o = s.owners[cid];
      (owners[o] ||= { count: 0, value: 0 });
      owners[o].count++; owners[o].value += s.pool[cid]?.value || 0;
    }
    const ranked = Object.entries(owners).sort((a, b) => b[1].value - a[1].value).slice(0, 10);
    const embed = new EmbedBuilder().setColor(0xF1C40F).setTitle('🏆 Collection Leaderboard')
      .setDescription(ranked.length ? ranked.map(([id, d], i) => `**${i + 1}.** <@${id}> — ${d.count} members · 💰 ${fmt(d.value)} Dinar`).join('\n') : '_No collections yet._');
    return interaction.reply({ embeds: [embed] });
  }

  // ── /gacha-list (private — may be a long list) ─────────────────────────────
  function cmdList(interaction, s) {
    ensureFreshRarities(db, interaction.guild.id);
    const ids = Object.keys(s.pool);
    if (!ids.length) return interaction.reply(eph('Nobody is opted in yet. Be the first with `/gacha-optin`!'));
    const ranked = ids.map(id => ({ id, ...s.pool[id] })).sort((a, b) => (b.value - a.value) || (b.score - a.score));
    const lines = ranked.map(e => `${TIER_EMOJI[e.rarity]} <@${e.id}>${s.owners[e.id] ? ' 🔒' : ''}`);
    let desc = '', shown = 0;
    for (const line of lines) {
      if (desc.length + line.length + 1 > 3800) break;
      desc += (desc ? '\n' : '') + line; shown++;
    }
    if (shown < lines.length) desc += `\n…and ${lines.length - shown} more`;
    const embed = new EmbedBuilder().setColor(0x2ECC71)
      .setTitle(`🎴 Opted-in Members (${ids.length})`).setDescription(desc)
      .setFooter({ text: '🔒 = already owned' });
    return interaction.reply({ embeds: [embed], flags: 64 });
  }

  // ── Buttons ────────────────────────────────────────────────────────────────
  async function handleButton(interaction) {
    const s = getState(db, interaction.guild.id);
    const [action, arg] = interaction.customId.split(':');
    if (!s.enabled) return interaction.reply(eph('🚫 The collection game is disabled.')).catch(() => {});

    if (action === 'gacha_claim') {
      const memberId = arg;
      const uid = interaction.user.id;
      const lr = liveRolls[interaction.message.id];
      if (!lr || lr.memberId !== memberId || lr.type !== 'claim' || lr.claimed || Date.now() > lr.expiresAt) {
        return interaction.reply(eph('⌛ Too late — this card is no longer claimable.'));
      }
      if (!s.pool[uid]) return interaction.reply(eph('🎴 You need to join the game before you can collect cards! Use `/gacha-optin` to opt in, then come back and claim.'));
      if (s.owners[memberId]) return interaction.reply(eph(`Already owned by <@${s.owners[memberId]}>.`));
      if (memberId === uid)   return interaction.reply(eph('You can\'t own yourself!'));
      const cd = (s.cooldowns[uid] ||= {});
      const csince = Date.now() - (cd.claim || 0);
      if (csince < CLAIM_COOLDOWN_MS) {
        const left = CLAIM_COOLDOWN_MS - csince;
        return interaction.reply(eph(`⏳ You've claimed recently. Next claim in ${Math.floor(left / 3600000)}h ${Math.ceil((left % 3600000) / 60000)}m.`));
      }
      const cost = s.pool[memberId]?.value || 0;
      if (dinarOf(s, uid) < cost) {
        return interaction.reply(eph(`💰 You need **${fmt(cost)} Dinar** to claim this ${s.pool[memberId]?.rarity || ''} card, but you only have **${fmt(dinarOf(s, uid))}**. Earn more with \`/gacha-daily\` and the other games.`));
      }
      addDinar(s, uid, -cost);
      lr.claimed = true;
      s.owners[memberId] = uid;
      cd.claim = Date.now();
      (s.stats[uid] ||= { rolls: 0, claims: 0 }).claims++;
      delete liveRolls[interaction.message.id];
      saveData(interaction.guild.id);
      await interaction.update({ components: [] }).catch(() => {});
      return interaction.followUp({ content: `🎴 <@${uid}> claimed <@${memberId}> for 💰 ${fmt(cost)} Dinar!` }).catch(() => {});
    }

    if (action === 'gacha_dinardrop') {
      const uid = interaction.user.id;
      const lr = liveRolls[interaction.message.id];
      if (!lr || lr.type !== 'dinardrop' || lr.dinarClaimed || Date.now() > lr.expiresAt) {
        return interaction.reply(eph('⌛ Too late — the Dinar has already been grabbed.'));
      }
      if (!s.pool[uid]) return interaction.reply(eph('💵 You need to join the game before you can collect Dinar! Use `/gacha-optin` to opt in.'));
      lr.dinarClaimed = true;
      const amount = DINAR_DROP_MIN + Math.floor(Math.random() * (DINAR_DROP_MAX - DINAR_DROP_MIN + 1));
      addDinar(s, uid, amount);
      delete liveRolls[interaction.message.id];
      saveData(interaction.guild.id);
      await interaction.update({ components: [] }).catch(() => {});
      return interaction.followUp({ content: `💵 <@${uid}> grabbed **${fmt(amount)} Dinar**!` }).catch(() => {});
    }

    if (action === 'gacha_trade_ok' || action === 'gacha_trade_no') {
      const trade = s.trades[arg];
      if (!trade) return interaction.reply(eph('This trade offer has expired or was already handled.'));
      if (interaction.user.id !== trade.to) return interaction.reply(eph('Only the person being offered can respond.'));
      if (Date.now() - trade.ts > TRADE_TTL_MS) { delete s.trades[arg]; saveData(interaction.guild.id); return interaction.reply(eph('This trade offer has expired.')); }
      if (action === 'gacha_trade_no') {
        delete s.trades[arg]; saveData(interaction.guild.id);
        await interaction.update({ components: [] }).catch(() => {});
        return interaction.followUp(eph('Trade declined.')).catch(() => {});
      }
      if (s.owners[trade.give] !== trade.from || s.owners[trade.receive] !== trade.to) {
        delete s.trades[arg]; saveData(interaction.guild.id);
        return interaction.reply(eph('Trade failed — ownership changed.'));
      }
      s.owners[trade.give] = trade.to;
      s.owners[trade.receive] = trade.from;
      delete s.trades[arg];
      saveData(interaction.guild.id);
      await interaction.update({ components: [] }).catch(() => {});
      return interaction.followUp({ content: `✅ Trade complete! <@${trade.from}> ⇄ <@${trade.to}>.` }).catch(() => {});
    }
  }

  // ── Admin ──────────────────────────────────────────────────────────────────
  async function cmdAdmin(interaction, s) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return interaction.reply(eph('🚫 Admins only.'));
    const sub = interaction.options.getSubcommand();
    const gid = interaction.guild.id;
    if (sub === 'toggle')  { s.enabled = interaction.options.getString('state') === 'on'; saveData(gid); return interaction.reply(eph(`Game is now **${s.enabled ? 'enabled' : 'disabled'}**.`)); }
    if (sub === 'trading') { s.tradingEnabled = interaction.options.getString('state') === 'on'; saveData(gid); return interaction.reply(eph(`Trading is now **${s.tradingEnabled ? 'enabled' : 'disabled'}**.`)); }
    if (sub === 'channel') {
      const act = interaction.options.getString('action');
      if (act === 'clear') { s.channels = []; saveData(gid); return interaction.reply(eph('✅ Cleared — the game now works everywhere.')); }
      const ch = interaction.options.getChannel('channel');
      if (!ch) return interaction.reply(eph('Pick a channel for add/remove.'));
      if (act === 'add') { if (!s.channels.includes(ch.id)) s.channels.push(ch.id); } else s.channels = s.channels.filter(c => c !== ch.id);
      saveData(gid);
      return interaction.reply(eph(`✅ Allowed channels: ${s.channels.length ? s.channels.map(c => `<#${c}>`).join(', ') : 'everywhere'}.`));
    }
    if (sub === 'rollchannel') {
      const act = interaction.options.getString('action');
      if (!s.rollChannels) s.rollChannels = [];
      if (act === 'clear') { s.rollChannels = []; saveData(gid); return interaction.reply(eph('✅ Cleared — `/gacha-roll` now works in any channel the game allows.')); }
      const ch = interaction.options.getChannel('channel');
      if (!ch) return interaction.reply(eph('Pick a channel for add/remove.'));
      if (act === 'add') { if (!s.rollChannels.includes(ch.id)) s.rollChannels.push(ch.id); } else s.rollChannels = s.rollChannels.filter(c => c !== ch.id);
      saveData(gid);
      return interaction.reply(eph(`✅ \`/gacha-roll\` is now allowed in: ${s.rollChannels.length ? s.rollChannels.map(c => `<#${c}>`).join(', ') : 'any channel (no roll restriction)'}.`));
    }
    if (sub === 'optin') {
      const u = interaction.options.getUser('user');
      if (s.pool[u.id]) return interaction.reply(eph(`<@${u.id}> is already opted in.`));
      s.pool[u.id] = { rarity: 'Common', score: 0, value: TIER_VALUE.Common, rarityOverride: null, valueOverride: null };
      recomputeRarities(db, gid); saveData(gid);
      return interaction.reply(eph(`✅ Forced <@${u.id}> into the game as ${TIER_EMOJI[s.pool[u.id].rarity]} ${s.pool[u.id].rarity}.`));
    }
    if (sub === 'resetroll') {
      const u = interaction.options.getUser('user');
      if (u) {
        if (s.cooldowns[u.id]) { delete s.cooldowns[u.id].roll; delete s.cooldowns[u.id].claim; }
        saveData(gid);
        return interaction.reply(eph(`✅ Roll & claim cooldowns reset for <@${u.id}>.`));
      }
      for (const k of Object.keys(s.cooldowns)) { delete s.cooldowns[k].roll; delete s.cooldowns[k].claim; }
      saveData(gid);
      return interaction.reply(eph('✅ Roll & claim cooldowns reset for **everyone**.'));
    }
    if (sub === 'override') {
      const u = interaction.options.getUser('user');
      if (!s.pool[u.id]) return interaction.reply(eph('That member isn\'t opted in.'));
      const rarity = interaction.options.getString('rarity');
      const value  = interaction.options.getInteger('value');
      if (rarity != null) s.pool[u.id].rarityOverride = rarity === 'clear' ? null : rarity;
      if (value  != null) s.pool[u.id].valueOverride  = value < 0 ? null : value;
      recomputeRarities(db, gid); saveData(gid);
      return interaction.reply(eph(`✅ <@${u.id}> → ${TIER_EMOJI[s.pool[u.id].rarity]} ${s.pool[u.id].rarity} · 💰 ${fmt(s.pool[u.id].value)} Dinar.`));
    }
    if (sub === 'release') {
      const u = interaction.options.getUser('user');
      if (!s.owners[u.id]) return interaction.reply(eph('That member isn\'t currently owned.'));
      const prev = s.owners[u.id]; delete s.owners[u.id]; saveData(gid);
      return interaction.reply(eph(`✅ Released <@${u.id}> from <@${prev}>.`));
    }
    if (sub === 'forceremove') {
      const u = interaction.options.getUser('user');
      dissolveMember(s, u.id); recomputeRarities(db, gid); saveData(gid);
      return interaction.reply(eph(`✅ Removed <@${u.id}> from the game and dissolved all claims/wishlists of them.`));
    }
    if (sub === 'recompute') { recomputeRarities(db, gid); saveData(gid); return interaction.reply(eph('✅ Rarities recomputed from current stats.')); }
  }
}

module.exports = { getGachaCommands, initGacha, awardDinar };
