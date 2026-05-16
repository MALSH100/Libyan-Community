// ═══════════════════════════════════════════════════════════════════════════════
// POKEMON SYSTEM — Clan Bot Extension
// - Wild spawns every 4 hours in clan private channels
// - Real Pokemon data from PokéAPI (Gen 1–8, #1–898)
// - Attack, Heavy Strike, Catch, Run buttons
// - HP-based catch rate — faint = no catch
// - Personal Pokemon per member (follow member when leaving clan)
// - 30 Pokemon cap per member
// - 1v1 battles — any member can challenge
// - Shiny Pokemon (1/50 chance)
// - Simple items: Pokeballs (3 per spawn) + Potions (2 per battle)
// ═══════════════════════════════════════════════════════════════════════════════

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
} = require('discord.js');

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_POKEMON        = 30;
const SPAWN_INTERVAL_MS  = 2 * 60 * 60 * 1000;  // 2 hours
const SPAWN_FLEE_MS      = 60 * 60 * 1000;       // 1 hour
const POKEBALL_PER_SPAWN = 3;
const MAX_POKEMON_ID     = 898; // Gen 1–8
const SHINY_CHANCE       = 50;  // 1 in 50
const POTION_HEAL_PCT    = 0.30; // 30% max HP
const BATTLE_TIMEOUT_MS  = 60 * 1000; // 60s per turn
const FIRST_HIT_XP       = 15;  // Bonus clan XP for landing the first hit
const STREAK_THRESHOLD   = 3;   // Catches in a row to trigger streak bonus
const STREAK_XP_BONUS    = 50;  // Bonus XP for hitting the streak
const STREAK_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 1 week multiplier window

// Type colour map for embed colours
const TYPE_COLOURS = {
  normal: 0xA8A878, fire: 0xF08030, water: 0x6890F0, electric: 0xF8D030,
  grass: 0x78C850, ice: 0x98D8D8, fighting: 0xC03028, poison: 0xA040A0,
  ground: 0xE0C068, flying: 0xA890F0, psychic: 0xF85888, bug: 0xA8B820,
  rock: 0xB8A038, ghost: 0x705898, dragon: 0x7038F8, dark: 0x705848,
  steel: 0xB8B8D0, fairy: 0xEE99AC,
};

const TYPE_EMOJI = {
  normal: '⬜', fire: '🔥', water: '💧', electric: '⚡', grass: '🌿',
  ice: '❄️', fighting: '🥊', poison: '☠️', ground: '🌍', flying: '🌪️',
  psychic: '🔮', bug: '🐛', rock: '🪨', ghost: '👻', dragon: '🐉',
  dark: '🌑', steel: '⚙️', fairy: '✨',
};

// ─── In-memory state ──────────────────────────────────────────────────────────

const pokeCache        = {};  // { pokemonId: apiData }
const typeCache        = {};  // { typeName: typeData }
const activeSpawns     = {};  // { channelId: spawnState }
const activeBattles    = {};  // { `${guildId}_${userId}`: battleState }
const pendingChallenges= {};  // { targetUserId: { challengerUserId, guildId, expiresAt } }
const spawnTimers      = {};  // { channelId: timeoutId }

// ─── PokéAPI helpers ──────────────────────────────────────────────────────────

async function fetchPokemon(idOrName) {
  const key = String(idOrName).toLowerCase();
  if (pokeCache[key]) return pokeCache[key];
  try {
    const res  = await fetch(`https://pokeapi.co/api/v2/pokemon/${key}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json();
    pokeCache[key] = data;
    // Also cache by id
    pokeCache[String(data.id)] = data;
    return data;
  } catch (e) {
    console.error('PokéAPI fetch failed:', e.message);
    return null;
  }
}

async function fetchMoveData(moveName) {
  const key = moveName.toLowerCase();
  if (pokeCache[`move_${key}`]) return pokeCache[`move_${key}`];
  try {
    const res  = await fetch(`https://pokeapi.co/api/v2/move/${key}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json();
    pokeCache[`move_${key}`] = data;
    return data;
  } catch (e) {
    return null;
  }
}

async function fetchTypeData(typeName) {
  if (typeCache[typeName]) return typeCache[typeName];
  try {
    const res  = await fetch(`https://pokeapi.co/api/v2/type/${typeName}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json();
    typeCache[typeName] = data;
    return data;
  } catch (e) {
    return null;
  }
}

// Get type effectiveness multiplier for attacking type vs defending types
async function getTypeEffectiveness(attackType, defenderTypes) {
  try {
    const typeData = await fetchTypeData(attackType);
    if (!typeData) return 1;

    const relations = typeData.damage_relations;
    let multiplier  = 1;

    for (const defType of defenderTypes) {
      if (relations.double_damage_to.some(t => t.name === defType))   multiplier *= 2;
      if (relations.half_damage_to.some(t => t.name === defType))     multiplier *= 0.5;
      if (relations.no_damage_to.some(t => t.name === defType))       multiplier *= 0;
    }
    return multiplier;
  } catch {
    return 1;
  }
}

// Pick up to 4 moves from a Pokemon's learnset that have power > 0
async function selectMoves(pokemonData) {
  const learnset = pokemonData.moves || [];
  const shuffled = learnset.sort(() => Math.random() - 0.5).slice(0, 20);
  const selected = [];

  for (const entry of shuffled) {
    if (selected.length >= 4) break;
    const moveData = await fetchMoveData(entry.move.name);
    if (!moveData) continue;
    if (!moveData.power || moveData.power < 40) continue;
    selected.push({
      name:     moveData.name.replace(/-/g, ' '),
      power:    moveData.power,
      accuracy: moveData.accuracy || 100,
      type:     moveData.type.name,
      pp:       moveData.pp || 10,
      maxPp:    moveData.pp || 10,
      damageClass: moveData.damage_class?.name || 'physical',
    });
  }

  // Fallback move if none found
  if (selected.length === 0) {
    selected.push({ name: 'tackle', power: 40, accuracy: 100, type: 'normal', pp: 35, maxPp: 35, damageClass: 'physical' });
  }

  return selected;
}

// Build a caught Pokemon object from API data
async function buildCaughtPokemon(apiData, level, isShiny, caughtByUserId) {
  const stats     = {};
  for (const s of apiData.stats) stats[s.stat.name] = s.base_stat;

  const hp     = Math.floor(((2 * stats.hp * level) / 100) + level + 10);
  const attack = Math.floor(((2 * (stats.attack || 50) * level) / 100) + 5);
  const defense= Math.floor(((2 * (stats.defense || 50) * level) / 100) + 5);
  const spAtk  = Math.floor(((2 * (stats['special-attack'] || 50) * level) / 100) + 5);
  const speed  = Math.floor(((2 * (stats.speed || 50) * level) / 100) + 5);

  const types   = apiData.types.map(t => t.type.name);
  const moves   = await selectMoves(apiData);
  const spriteUrl = isShiny
    ? apiData.sprites?.front_shiny
    : apiData.sprites?.front_default;

  return {
    id:         apiData.id,
    name:       apiData.name,
    nickname:   null,
    level,
    xp:         0,
    xpToNext:   level * 50,
    currentHp:  hp,
    maxHp:      hp,
    attack,
    defense,
    specialAttack: spAtk,
    speed,
    types,
    moves,
    isShiny,
    spriteUrl:  spriteUrl || null,
    caughtBy:   caughtByUserId,
    caughtAt:   new Date().toISOString(),
    pokeballs:  POKEBALL_PER_SPAWN,
    battleWins: 0,
  };
}

// ─── Storage helpers ──────────────────────────────────────────────────────────

function getMemberPokemon(db, guildId, userId) {
  if (!db[guildId]) db[guildId] = {};
  if (!db[guildId].__pokemon) db[guildId].__pokemon = {};
  if (!db[guildId].__pokemon[userId]) db[guildId].__pokemon[userId] = { pokemon: [], pokeballs: 5, battleWins: 0 };
  return db[guildId].__pokemon[userId];
}

function getClanPokemonStats(db, guildId, gc) {
  const pokemon    = db[guildId]?.__pokemon || {};
  let totalCaught  = 0;
  let totalWins    = 0;
  let highestLevel = 0;

  // Only count members currently in a clan
  const allMemberIds = [];
  for (const clan of Object.values(gc)) {
    if (clan.leader)   allMemberIds.push(clan.leader);
    if (clan.officers) allMemberIds.push(...clan.officers);
    if (clan.members)  allMemberIds.push(...clan.members);
  }

  for (const [uid, data] of Object.entries(pokemon)) {
    if (!allMemberIds.includes(uid)) continue;
    totalCaught += data.pokemon.length;
    totalWins   += data.battleWins || 0;
    for (const p of data.pokemon) {
      if (p.level > highestLevel) highestLevel = p.level;
    }
  }

  return { totalCaught, totalWins, highestLevel };
}

// ─── UI helpers ──────────────────────────────────────────────────────────────

function hpBar(current, max, length = 10) {
  const pct   = Math.max(0, Math.min(1, current / max));
  const filled = Math.round(pct * length);
  const color  = pct > 0.5 ? '🟩' : pct > 0.25 ? '🟨' : '🟥';
  return color.repeat(filled) + '⬛'.repeat(length - filled);
}

function capitalize(str) {
  return str ? str.charAt(0).toUpperCase() + str.slice(1) : '';
}

function pokemonDisplay(p) {
  const name     = p.nickname ? `${p.nickname} (${capitalize(p.name)})` : capitalize(p.name);
  const shiny    = p.isShiny ? ' ✨' : '';
  const types    = p.types.map(t => `${TYPE_EMOJI[t] || ''}${capitalize(t)}`).join(' / ');
  return `${shiny}**${name}** • Lv.${p.level} • ${types}`;
}

function spawnEmbed(spawnHp, spawnMaxHp, pokeName, types, spriteUrl, isShiny, level, speciesCatchRate = 128) {
  const safeTypes  = Array.isArray(types) ? types : [types];
  const typeColour = TYPE_COLOURS[safeTypes[0]] || 0x5865F2;
  const typeStr    = safeTypes.map(t => `${TYPE_EMOJI[t] || ''}${capitalize(t)}`).join(' / ');
  const shinyStr   = isShiny ? '✨ **SHINY** ' : '';

  // Catch difficulty label based on species catch rate
  let catchDiff;
  if (speciesCatchRate >= 200)      catchDiff = '🟢 Easy';
  else if (speciesCatchRate >= 100) catchDiff = '🟡 Medium';
  else if (speciesCatchRate >= 45)  catchDiff = '🟠 Hard';
  else                              catchDiff = '🔴 Very Hard';

  const embed = new EmbedBuilder()
    .setColor(typeColour)
    .setTitle(`🌿 A wild ${shinyStr}${capitalize(pokeName)} appeared!`)
    .setDescription(
      `**Type:** ${typeStr}\n` +
      `**Level:** ${level}\n` +
      `**Catch Difficulty:** ${catchDiff}\n\n` +
      `**HP:** ${hpBar(spawnHp, spawnMaxHp)} ${spawnHp}/${spawnMaxHp}\n\n` +
      `Use the buttons below to interact!\n` +
      `⚠️ Lower HP = easier to catch. Don't let it faint!`
    )
    .setFooter({ text: 'Flees in 1 hour if ignored.' });

  if (spriteUrl) embed.setThumbnail(spriteUrl);
  return embed;
}

function faintedEmbed(pokeName, isShiny) {
  return new EmbedBuilder()
    .setColor(0x888888)
    .setTitle(`💀 ${isShiny ? '✨ ' : ''}${capitalize(pokeName)} fainted!`)
    .setDescription('It fainted before it could be caught. Better luck next time!');
}

function catchButtons(ballsLeft) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('poke_attack').setLabel('⚔️ Attack').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('poke_heavy').setLabel('💥 Heavy Strike').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('poke_catch').setLabel(`🎯 Catch (${ballsLeft} ball${ballsLeft !== 1 ? 's' : ''})`).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('poke_run').setLabel('🏃 Run').setStyle(ButtonStyle.Secondary),
  );
}

function disabledButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('poke_attack').setLabel('⚔️ Attack').setStyle(ButtonStyle.Primary).setDisabled(true),
    new ButtonBuilder().setCustomId('poke_heavy').setLabel('💥 Heavy Strike').setStyle(ButtonStyle.Danger).setDisabled(true),
    new ButtonBuilder().setCustomId('poke_catch').setLabel('🎯 Catch').setStyle(ButtonStyle.Success).setDisabled(true),
    new ButtonBuilder().setCustomId('poke_run').setLabel('🏃 Run').setStyle(ButtonStyle.Secondary).setDisabled(true),
  );
}

// ─── Catch rate formula ───────────────────────────────────────────────────────
// Uses the species catch rate from PokéAPI (1–255).
// Legendary Pokemon have low catch rates (3–45), commons are high (190–255).
// Lower HP = better chance. Mirrors the Gen 6+ catch formula (simplified).

function calcCatchRate(currentHp, maxHp, speciesCatchRate = 128) {
  // speciesCatchRate: 1 (nearly impossible) to 255 (very easy)
  // Normalise to 0–1
  const speciesFactor = speciesCatchRate / 255;
  // HP factor: at full HP you get 15% of species rate, at 1 HP you get 100%
  const hpFactor = 1 - (currentHp / maxHp) * 0.85;
  // Combined — always at least 2%, never more than 95%
  return Math.min(0.95, Math.max(0.02, speciesFactor * hpFactor));
}

// ─── Damage calculation ───────────────────────────────────────────────────────
// Properly factors in the wild Pokémon's defence so they don't one-shot faint.
// Wild Pokémon defence stat is passed in and applied to reduce damage.
// Also caps damage to at most 40% of wild Pokémon max HP per hit (normal)
// and 55% for heavy strike, so it always takes multiple hits to faint.

async function calcDamage(attackerLevel, attackStat, movePower, moveType, defenderTypes, isHeavy = false, defenceStat = 40, wildMaxHp = 100) {
  const base          = Math.floor(((2 * attackerLevel / 5 + 2) * movePower * attackStat) / (50 * defenceStat) + 2);
  const effectiveness = await getTypeEffectiveness(moveType, defenderTypes);
  const random        = (Math.random() * 0.15) + 0.85; // 85–100% roll
  const heavy         = isHeavy ? 1.4 : 1;
  const raw           = Math.max(1, Math.floor(base * effectiveness * random * heavy));
  // Cap per-hit damage so wild Pokémon survive long enough to interact with
  const cap           = Math.floor(wildMaxHp * (isHeavy ? 0.50 : 0.35));
  return Math.min(raw, cap);
}

// ─── XP and levelling ────────────────────────────────────────────────────────

async function awardBattleXp(pokemon, won) {
  const xpGain    = won ? 100 + pokemon.level * 5 : 30 + pokemon.level * 2;
  pokemon.xp     += xpGain;
  let levelled    = false;

  while (pokemon.xp >= pokemon.xpToNext && pokemon.level < 100) {
    pokemon.level++;
    pokemon.xp       -= pokemon.xpToNext;
    pokemon.xpToNext  = pokemon.level * 50;

    // Recalculate stats on level up
    const apiData = await fetchPokemon(pokemon.id);
    if (apiData) {
      const stats   = {};
      for (const s of apiData.stats) stats[s.stat.name] = s.base_stat;
      const newMaxHp = Math.floor(((2 * stats.hp * pokemon.level) / 100) + pokemon.level + 10);
      pokemon.maxHp     = newMaxHp;
      pokemon.currentHp = Math.min(pokemon.currentHp, newMaxHp);
      pokemon.attack    = Math.floor(((2 * (stats.attack || 50) * pokemon.level) / 100) + 5);
      pokemon.defense   = Math.floor(((2 * (stats.defense || 50) * pokemon.level) / 100) + 5);
      pokemon.specialAttack = Math.floor(((2 * (stats['special-attack'] || 50) * pokemon.level) / 100) + 5);
      pokemon.speed     = Math.floor(((2 * (stats.speed || 50) * pokemon.level) / 100) + 5);
    }
    levelled = true;
  }

  return { xpGain, levelled };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SPAWN SYSTEM
// ═══════════════════════════════════════════════════════════════════════════════

function scheduleNextSpawn(channel, db, saveData, getGuildClans, getUserClan) {
  if (spawnTimers[channel.id]) clearTimeout(spawnTimers[channel.id]);
  spawnTimers[channel.id] = setTimeout(
    () => triggerSpawn(channel, db, saveData, getGuildClans, getUserClan),
    SPAWN_INTERVAL_MS
  );
}

async function triggerSpawn(channel, db, saveData, getGuildClans, getUserClan) {
  // Don't spawn if one is already active here
  if (activeSpawns[channel.id]) {
    scheduleNextSpawn(channel, db, saveData, getGuildClans, getUserClan);
    return;
  }

  try {
    const pokeId    = Math.floor(Math.random() * MAX_POKEMON_ID) + 1;
    const apiData   = await fetchPokemon(pokeId);
    if (!apiData) {
      scheduleNextSpawn(channel, db, saveData, getGuildClans, getUserClan);
      return;
    }

    const isShiny   = Math.floor(Math.random() * SHINY_CHANCE) === 0;
    const gc        = getGuildClans(channel.guild.id);

    // Level scales with clan's total caught Pokemon
    const clanStats = getClanPokemonStats(db, channel.guild.id, gc);
    const baseLevel = Math.max(5, Math.min(60, 5 + Math.floor(clanStats.totalCaught / 3)));
    const level     = baseLevel + Math.floor(Math.random() * 5);

    const stats     = {};
    for (const s of apiData.stats) stats[s.stat.name] = s.base_stat;
    const maxHp     = Math.floor(((2 * stats.hp * level) / 100) + level + 10);
    const defence   = Math.floor(((2 * (stats.defense || 40) * level) / 100) + 5);
    const types     = apiData.types.map(t => t.type.name);
    const spriteUrl = isShiny ? apiData.sprites?.front_shiny : apiData.sprites?.front_default;

    // Species catch rate from API (1–255). Fetch from species endpoint.
    let speciesCatchRate = 128; // sensible default
    try {
      const speciesUrl  = apiData.species?.url;
      if (speciesUrl) {
        const speciesRes  = await fetch(speciesUrl, { signal: AbortSignal.timeout(6000) });
        const speciesData = await speciesRes.json();
        speciesCatchRate  = speciesData.capture_rate ?? 128;
      }
    } catch { /* use default */ }

    const spawn = {
      pokeId,
      pokeName:  apiData.name,
      apiData,
      level,
      isShiny,
      types,
      spriteUrl: spriteUrl || null,
      hp:        maxHp,
      maxHp,
      defence,
      speciesCatchRate,
      fainted:   false,
      caught:    false,
      userBalls: {},
    };

    activeSpawns[channel.id] = spawn;

    const typeColour = TYPE_COLOURS[types[0]] || 0x5865F2;
    const embed      = spawnEmbed(spawn.hp, spawn.maxHp, apiData.name, types, spriteUrl, isShiny, level, spawn.speciesCatchRate);
    const row        = catchButtons(POKEBALL_PER_SPAWN);

    const msg = await channel.send({
      content: `🌿 **A wild Pokémon has appeared!** ${isShiny ? '✨ It\'s shiny!' : ''}`,
      embeds: [embed],
      components: [row],
    });

    spawn.messageId = msg.id;
    spawn.message   = msg;

    // Auto-flee timer
    const fleeTimer = setTimeout(async () => {
      if (!activeSpawns[channel.id] || activeSpawns[channel.id].caught || activeSpawns[channel.id].fainted) return;
      const wasInteracted = spawn.firstHitUserId !== undefined; // someone attacked but didn't catch
      delete activeSpawns[channel.id];
      try {
        await msg.edit({
          content: `🌿 The wild ${capitalize(apiData.name)} fled!`,
          embeds: [new EmbedBuilder()
            .setColor(0x888888)
            .setTitle(`🌿 ${capitalize(apiData.name)} fled!`)
            .setDescription(
              wasInteracted
                ? `The wild **${capitalize(apiData.name)}** escaped after being weakened. So close!`
                : `😢 **Nobody came to help!** The wild **${capitalize(apiData.name)}** got away without a fight. What a shame...`
            )],
          components: [disabledButtons()],
        });
      } catch {}
      scheduleNextSpawn(channel, db, saveData, getGuildClans, getUserClan);
    }, SPAWN_FLEE_MS);

    spawn.fleeTimer = fleeTimer;

    // Set up button collector
    const collector = msg.createMessageComponentCollector({
      filter: i => ['poke_attack','poke_heavy','poke_catch','poke_run'].includes(i.customId),
      time: SPAWN_FLEE_MS,
    });

    collector.on('collect', async i => {
      await handleSpawnInteraction(i, spawn, channel, db, saveData, getGuildClans, getUserClan, collector);
    });

    collector.on('end', () => {
      scheduleNextSpawn(channel, db, saveData, getGuildClans, getUserClan);
    });

  } catch (err) {
    console.error('Spawn error:', err);
    scheduleNextSpawn(channel, db, saveData, getGuildClans, getUserClan);
  }
}

async function handleSpawnInteraction(i, spawn, channel, db, saveData, getGuildClans, getUserClan, collector) {
  try {
    await i.deferUpdate();

    const guildId = channel.guild.id;
    const userId  = i.user.id;

    // Find which clan owns this channel
    const gc = getGuildClans(guildId);
    let channelClan = null;
    let channelClanName = null;
    for (const [name, clan] of Object.entries(gc)) {
      if (clan.channelId === channel.id) {
        channelClan     = clan;
        channelClanName = name;
        break;
      }
    }

    // If no clan owns this channel, allow anyone in any clan (fallback for admin spawns)
    if (channelClan) {
      // Check the user is actually a member of the clan that owns this channel
      const isInClan =
        channelClan.leader === userId ||
        (channelClan.officers || []).includes(userId) ||
        (channelClan.members  || []).includes(userId);

      if (!isInClan) {
        await i.followUp({ content: `❌ Only members of **${channelClanName}** can interact with their wild Pokémon!`, flags: 64 });
        return;
      }
    } else {
      // No clan owns this channel — user must at least be in some clan
      const userClan = getUserClan(guildId, userId);
      if (!userClan) {
        await i.followUp({ content: '❌ You must be in a clan to interact with wild Pokémon!', flags: 64 });
        return;
      }
    }

    if (spawn.fainted || spawn.caught) return;

    const memberData = getMemberPokemon(db, guildId, userId);

    // ── RUN ──────────────────────────────────────────────────────────────────
    if (i.customId === 'poke_run') {
      clearTimeout(spawn.fleeTimer);
      delete activeSpawns[channel.id];
      collector.stop();
      await spawn.message.edit({
        content: `🏃 ${i.user.displayName} ran away from ${capitalize(spawn.pokeName)}!`,
        embeds: [new EmbedBuilder().setColor(0x888888).setTitle(`🏃 Ran away!`).setDescription(`The wild ${capitalize(spawn.pokeName)} was left behind.`)],
        components: [disabledButtons()],
      }).catch(() => {});
      return;
    }

    // ── ATTACK ───────────────────────────────────────────────────────────────
    if (i.customId === 'poke_attack' || i.customId === 'poke_heavy') {
      const isHeavy = i.customId === 'poke_heavy';

      // Get attacker's best Pokemon for damage, or use base damage
      let attackStat    = 30;
      let moveType      = 'normal';
      let movePower     = isHeavy ? 80 : 40;
      let attackerLevel = 10;

      if (memberData.pokemon.length > 0) {
        const best = memberData.pokemon.reduce((a, b) => a.attack > b.attack ? a : b);
        attackStat    = best.attack;
        attackerLevel = best.level;
        if (best.moves.length > 0) {
          const move = best.moves[Math.floor(Math.random() * best.moves.length)];
          moveType   = move.type;
          movePower  = isHeavy ? Math.floor(move.power * 1.5) : move.power;
        }
      }

      const damage = await calcDamage(attackerLevel, attackStat, movePower, moveType, spawn.types, isHeavy, spawn.defence, spawn.maxHp);
      spawn.hp     = Math.max(0, spawn.hp - damage);

      // ── First-hit XP bonus ──────────────────────────────────────────────
      let firstHitMsg = '';
      if (!spawn.firstHitUserId) {
        spawn.firstHitUserId = userId;
        // Award bonus XP to the clan
        const gc = getGuildClans(guildId);
        if (channelClan) {
          channelClan.xp = (channelClan.xp || 0) + FIRST_HIT_XP;
          saveData();
          firstHitMsg = `\n⚡ **First hit!** +${FIRST_HIT_XP} clan XP for ${i.user.displayName}!`;
        }
      }

      const effectiveness = await getTypeEffectiveness(moveType, spawn.types);
      let effectStr = '';
      if (effectiveness >= 2)   effectStr = '\n⚡ **Super effective!**';
      if (effectiveness <= 0.5) effectStr = '\n💨 Not very effective...';
      if (effectiveness === 0)  effectStr = '\n🚫 It had no effect!';

      if (spawn.hp === 0) {
        spawn.fainted = true;
        clearTimeout(spawn.fleeTimer);
        delete activeSpawns[channel.id];
        collector.stop();

        await spawn.message.edit({
          content: `💀 **${capitalize(spawn.pokeName)} fainted!** It can't be caught anymore.`,
          embeds: [faintedEmbed(spawn.pokeName, spawn.isShiny)],
          components: [disabledButtons()],
        }).catch(() => {});

        await channel.send(`💨 The wild ${capitalize(spawn.pokeName)} was defeated but couldn't be caught. Better luck next time!`).catch(() => {});
        return;
      }

      // Update embed
      const updatedEmbed = spawnEmbed(spawn.hp, spawn.maxHp, spawn.pokeName, spawn.types, spawn.spriteUrl, spawn.isShiny, spawn.level, spawn.speciesCatchRate);
      const userBalls    = spawn.userBalls[userId] ?? POKEBALL_PER_SPAWN;
      updatedEmbed.setDescription(
        updatedEmbed.data.description +
        `\n\n${i.user.displayName} used **${isHeavy ? '💥 Heavy Strike' : '⚔️ Attack'}**! Dealt **${damage}** damage!${effectStr}${firstHitMsg}`
      );

      await spawn.message.edit({
        embeds: [updatedEmbed],
        components: [catchButtons(userBalls)],
      }).catch(() => {});

      return;
    }

    // ── CATCH ────────────────────────────────────────────────────────────────
    if (i.customId === 'poke_catch') {
      // Check user's personal ball count for this spawn
      if (spawn.userBalls[userId] === undefined) spawn.userBalls[userId] = POKEBALL_PER_SPAWN;

      if (spawn.userBalls[userId] <= 0) {
        await i.followUp({ content: '❌ You have no Pokéballs left for this encounter!', flags: 64 });
        return;
      }

      spawn.userBalls[userId]--;
      const ballsLeft  = spawn.userBalls[userId];
      const catchRate  = calcCatchRate(spawn.hp, spawn.maxHp, spawn.speciesCatchRate);
      const caught     = Math.random() < catchRate;

      if (caught) {
        // Check 30 Pokemon cap
        if (memberData.pokemon.length >= MAX_POKEMON) {
          await i.followUp({
            content: `❌ You already have **${MAX_POKEMON} Pokémon**! Use \`/pokemon-release\` to release one first, then try catching again.`,
            flags: 64,
          });
          // Give the ball back since they can't catch
          spawn.userBalls[userId]++;
          return;
        }

        spawn.caught = true;
        clearTimeout(spawn.fleeTimer);
        delete activeSpawns[channel.id];
        collector.stop();

        const caughtPoke = await buildCaughtPokemon(spawn.apiData, spawn.level, spawn.isShiny, userId);
        memberData.pokemon.push(caughtPoke);
        memberData.pokeballs = (memberData.pokeballs || 0) + POKEBALL_PER_SPAWN;

        // ── Catch streak tracking ───────────────────────────────────────────
        let streakMsg = '';
        if (channelClan) {
          // Initialise streak data if not present
          if (!channelClan.catchStreak)       channelClan.catchStreak = 0;
          if (!channelClan.lastCatchTime)     channelClan.lastCatchTime = 0;
          if (!channelClan.streakBonusUntil)  channelClan.streakBonusUntil = 0;

          channelClan.catchStreak++;
          channelClan.lastCatchTime = Date.now();

          if (channelClan.catchStreak >= STREAK_THRESHOLD) {
            // Award streak XP bonus
            channelClan.xp = (channelClan.xp || 0) + STREAK_XP_BONUS;
            channelClan.streakBonusUntil = Date.now() + STREAK_DURATION_MS;
            channelClan.catchStreak = 0; // reset streak counter after reward
            streakMsg = `\n\n🔥 **${STREAK_THRESHOLD} catch streak!** +${STREAK_XP_BONUS} bonus clan XP! XP multiplier active for 1 week!`;
          } else {
            streakMsg = `\n\n🔥 Catch streak: **${channelClan.catchStreak}/${STREAK_THRESHOLD}** — keep it up for bonus XP!`;
          }
        }

        saveData();

        const shinyStr   = spawn.isShiny ? '✨ SHINY ' : '';
        const typeColour = TYPE_COLOURS[spawn.types[0]] || 0x57F287;

        await spawn.message.edit({
          content: `🎉 **${i.user.displayName}** caught the wild **${shinyStr}${capitalize(spawn.pokeName)}**!`,
          embeds: [new EmbedBuilder()
            .setColor(typeColour)
            .setTitle(`🎉 Gotcha! ${shinyStr}${capitalize(spawn.pokeName)} was caught!`)
            .setDescription(
              `**Caught by:** ${i.user.displayName}\n` +
              `**Level:** ${spawn.level}\n` +
              `**Type:** ${spawn.types.map(t => `${TYPE_EMOJI[t] || ''}${capitalize(t)}`).join(' / ')}\n\n` +
              `Use \`/pokemon-team\` to see your Pokémon!` +
              streakMsg
            )
            .setThumbnail(spawn.spriteUrl || null)],
          components: [disabledButtons()],
        }).catch(() => {});

      } else {
        // Failed catch
        const shakes = ballsLeft > 0 ? '💫 Oh no! The Pokémon broke free!' : '💨 The Pokéball missed completely!';

        const updatedEmbed = spawnEmbed(spawn.hp, spawn.maxHp, spawn.pokeName, spawn.types, spawn.spriteUrl, spawn.isShiny, spawn.level, spawn.speciesCatchRate);
        updatedEmbed.setDescription(
          updatedEmbed.data.description +
          `\n\n${i.user.displayName} threw a Pokéball... ${shakes}\n` +
          (ballsLeft > 0 ? `You have **${ballsLeft}** ball${ballsLeft !== 1 ? 's' : ''} left.` : '❌ **You\'re out of Pokéballs!**')
        );

        await spawn.message.edit({
          embeds: [updatedEmbed],
          components: [catchButtons(ballsLeft)],
        }).catch(() => {});
      }
    }

  } catch (err) {
    console.error('Spawn interaction error:', err);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// BATTLE SYSTEM
// ═══════════════════════════════════════════════════════════════════════════════

function buildBattleEmbed(battle, turn) {
  const p1     = battle.p1Pokemon;
  const p2     = battle.p2Pokemon;
  const colour = TYPE_COLOURS[p1.types[0]] || 0x5865F2;

  return new EmbedBuilder()
    .setColor(colour)
    .setTitle(`⚔️ Pokémon Battle — Turn ${turn}`)
    .addFields(
      {
        name: `${battle.p1Name}'s ${pokemonDisplay(p1)}`,
        value: `HP: ${hpBar(p1.currentHp, p1.maxHp)} ${p1.currentHp}/${p1.maxHp}`,
        inline: false,
      },
      {
        name: `${battle.p2Name}'s ${pokemonDisplay(p2)}`,
        value: `HP: ${hpBar(p2.currentHp, p2.maxHp)} ${p2.currentHp}/${p2.maxHp}`,
        inline: false,
      },
    )
    .setFooter({ text: `${battle.currentTurnUserId === battle.p1UserId ? battle.p1Name : battle.p2Name}'s turn — 60 seconds` });
}

function battleMoveButtons(pokemon, potionsLeft) {
  const rows = [];

  // Move buttons (up to 4)
  const moveButtons = pokemon.moves.slice(0, 4).map(m =>
    new ButtonBuilder()
      .setCustomId(`battle_move_${m.name.replace(/ /g, '_')}`)
      .setLabel(`${TYPE_EMOJI[m.type] || ''}${capitalize(m.name)} (${m.pp}/${m.maxPp})`)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(m.pp <= 0)
  );

  if (moveButtons.length > 0) {
    rows.push(new ActionRowBuilder().addComponents(...moveButtons.slice(0, 4)));
  }

  // Item / Forfeit row
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('battle_potion')
      .setLabel(`🧪 Potion (${potionsLeft} left)`)
      .setStyle(ButtonStyle.Success)
      .setDisabled(potionsLeft <= 0),
    new ButtonBuilder()
      .setCustomId('battle_forfeit')
      .setLabel('🏳️ Forfeit')
      .setStyle(ButtonStyle.Danger),
  ));

  return rows;
}

async function runBattleTurn(battle, channel, db, saveData, moveNameOrAction, userId) {
  try {
    const isP1       = userId === battle.p1UserId;
    const attacker   = isP1 ? battle.p1Pokemon : battle.p2Pokemon;
    const defender   = isP1 ? battle.p2Pokemon : battle.p1Pokemon;
    const atkName    = isP1 ? battle.p1Name    : battle.p2Name;
    const defName    = isP1 ? battle.p2Name    : battle.p1Name;
    let   logEntry   = '';

    if (moveNameOrAction === 'potion') {
      const potionKey = isP1 ? 'p1Potions' : 'p2Potions';
      if (battle[potionKey] <= 0) return null;
      battle[potionKey]--;
      const heal         = Math.floor(attacker.maxHp * POTION_HEAL_PCT);
      attacker.currentHp = Math.min(attacker.maxHp, attacker.currentHp + heal);
      logEntry = `🧪 **${atkName}** used a Potion! **${capitalize(attacker.name)}** restored **${heal} HP**.`;

    } else if (moveNameOrAction === 'forfeit') {
      return 'forfeit';

    } else {
      // Find the move
      const move = attacker.moves.find(m => m.name.replace(/ /g, '_') === moveNameOrAction.replace(/ /g, '_'));
      if (!move || move.pp <= 0) return null;

      move.pp--;

      // Accuracy check
      if (Math.random() * 100 > move.accuracy) {
        logEntry = `💨 **${atkName}**'s **${capitalize(move.name)}** missed!`;
      } else {
        const damage = await calcDamage(attacker.level, attacker.attack, move.power, move.type, defender.types);
        const effectiveness = await getTypeEffectiveness(move.type, defender.types);

        defender.currentHp = Math.max(0, defender.currentHp - damage);

        let effectStr = '';
        if (effectiveness >= 2)   effectStr = ' ⚡ **Super effective!**';
        if (effectiveness <= 0.5) effectStr = ' 💨 Not very effective...';
        if (effectiveness === 0)  effectStr = ' 🚫 No effect!';

        logEntry = `${TYPE_EMOJI[move.type] || ''}**${atkName}** used **${capitalize(move.name)}**! Dealt **${damage} damage**.${effectStr}`;
      }
    }

    battle.log.push(logEntry);
    if (battle.log.length > 5) battle.log.shift(); // keep last 5 entries

    // Check faint
    if (defender.currentHp <= 0) {
      return 'end';
    }

    // Switch turn
    battle.currentTurnUserId = isP1 ? battle.p2UserId : battle.p1UserId;
    battle.turn++;

    return 'continue';

  } catch (err) {
    console.error('Battle turn error:', err);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MODULE EXPORT
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = function initPokemon({ client, db, saveData, getGuildClans, getUserClan }) {

  // ─── On ready: start spawn timers for all clan channels ────────────────────

  client.once('clientReady', async () => {
    // index.js handles all command registration.
    // We just need to start spawn timers for existing clan channels.
    setTimeout(async () => {
      for (const guild of client.guilds.cache.values()) {
        try { await guild.channels.fetch(); } catch {}

        const gc = getGuildClans(guild.id);
        for (const clan of Object.values(gc)) {
          if (!clan.channelId) continue;

          let channel = guild.channels.cache.get(clan.channelId);
          if (!channel) {
            try { channel = await guild.channels.fetch(clan.channelId); } catch {}
          }

          if (channel) {
            console.log(`🌿 Scheduling spawns for #${channel.name}`);
            scheduleNextSpawn(channel, db, saveData, getGuildClans, getUserClan);
          } else {
            console.warn(`⚠️ Could not find channel ${clan.channelId} — clearing stale channelId`);
            clan.channelId = null;
            saveData();
          }
        }
      }
    }, 8000);
  });

  // ─── Interaction handler ────────────────────────────────────────────────────

  client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    if (!interaction.commandName.startsWith('pokemon') && interaction.commandName !== 'pokedex') return;

    const { commandName, user, guild } = interaction;

    try {
      await handlePokemonCommand(interaction, commandName, user, guild);
    } catch (err) {
      console.error(`❌ Pokemon command error in ${commandName}:`, err);
      try {
        const msg = { content: '❌ Something went wrong. Please try again.', flags: 64 };
        if (interaction.replied || interaction.deferred) await interaction.editReply(msg).catch(() => {});
        else await interaction.reply(msg).catch(() => {});
      } catch {}
    }
  });

  async function safeReplyPoke(interaction, payload) {
    try {
      if (interaction.replied) return await interaction.followUp(payload).catch(() => {});
      if (interaction.deferred) return await interaction.editReply(payload).catch(() => {});
      return await interaction.reply(payload);
    } catch {}
  }

  // ─── Command handler ────────────────────────────────────────────────────────

  async function handlePokemonCommand(interaction, commandName, user, guild) {
    const gc         = getGuildClans(guild.id);
    const userClan   = getUserClan(guild.id, user.id);
    const memberData = getMemberPokemon(db, guild.id, user.id);

    // ── /pokemon-team ──────────────────────────────────────────────────────
    if (commandName === 'pokemon-team') {
      const pokemon = memberData.pokemon;

      if (pokemon.length === 0) {
        return safeReplyPoke(interaction, {
          content: '📭 You haven\'t caught any Pokémon yet! Wait for a wild Pokémon to spawn in your clan channel.',
          flags: 64,
        });
      }

      const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle(`🎒 ${user.displayName}'s Pokémon (${pokemon.length}/${MAX_POKEMON})`)
        .setDescription(
          pokemon.map((p, idx) => {
            const shiny   = p.isShiny ? '✨' : '';
            const name    = p.nickname ? `**${p.nickname}** *(${capitalize(p.name)})*` : `**${capitalize(p.name)}**`;
            const types   = p.types.map(t => `${TYPE_EMOJI[t] || ''}${capitalize(t)}`).join('/');
            const hpStr   = `${hpBar(p.currentHp, p.maxHp, 8)} ${p.currentHp}/${p.maxHp}`;
            const wins    = p.battleWins || 0;
            return `\`${String(idx + 1).padStart(2, '0')}\` ${shiny}${name} • Lv.${p.level} • ${types}\n     HP: ${hpStr} • Wins: ${wins}`;
          }).join('\n\n')
        )
        .setFooter({ text: `Battle wins: ${memberData.battleWins || 0} total | Use /pokemon-release to free a slot` });

      return safeReplyPoke(interaction, { embeds: [embed], flags: 64 });
    }

    // ── /pokemon-release ───────────────────────────────────────────────────
    if (commandName === 'pokemon-release') {
      const slot  = interaction.options.getInteger('slot') - 1;
      const pokemon = memberData.pokemon;

      if (slot < 0 || slot >= pokemon.length) {
        return safeReplyPoke(interaction, { content: `❌ Invalid slot. You have ${pokemon.length} Pokémon.`, flags: 64 });
      }

      const released = pokemon[slot];
      memberData.pokemon.splice(slot, 1);
      saveData();

      return safeReplyPoke(interaction, {
        embeds: [new EmbedBuilder()
          .setColor(0x888888)
          .setTitle('👋 Pokémon Released')
          .setDescription(`You released **${released.nickname || capitalize(released.name)}**. Goodbye!`)],
        flags: 64,
      });
    }

    // ── /pokemon-nickname ──────────────────────────────────────────────────
    if (commandName === 'pokemon-nickname') {
      const slot     = interaction.options.getInteger('slot') - 1;
      const newName  = interaction.options.getString('name').trim().slice(0, 20);
      const pokemon  = memberData.pokemon;

      if (slot < 0 || slot >= pokemon.length) {
        return safeReplyPoke(interaction, { content: `❌ Invalid slot. You have ${pokemon.length} Pokémon.`, flags: 64 });
      }

      pokemon[slot].nickname = newName;
      saveData();

      return safeReplyPoke(interaction, {
        content: `✅ Your **${capitalize(pokemon[slot].name)}** is now nicknamed **${newName}**!`,
        flags: 64,
      });
    }

    // ── /pokemon-info ──────────────────────────────────────────────────────
    if (commandName === 'pokemon-info') {
      const query   = interaction.options.getString('pokemon').toLowerCase().trim().replace(/ /g, '-');

      await interaction.deferReply().catch(() => {});

      const apiData = await fetchPokemon(query);
      if (!apiData) {
        return safeReplyPoke(interaction, { content: `❌ Could not find a Pokémon called **${query}**. Check the spelling!`, flags: 64 });
      }

      const stats   = {};
      for (const s of apiData.stats) stats[s.stat.name] = s.base_stat;
      const types   = apiData.types.map(t => t.type.name);
      const colour  = TYPE_COLOURS[types[0]] || 0x5865F2;
      const sprite  = apiData.sprites?.front_default;

      const embed = new EmbedBuilder()
        .setColor(colour)
        .setTitle(`#${apiData.id} — ${capitalize(apiData.name)}`)
        .setDescription(`**Type:** ${types.map(t => `${TYPE_EMOJI[t] || ''}${capitalize(t)}`).join(' / ')}`)
        .addFields(
          { name: '❤️ HP',           value: String(stats.hp || '?'),                  inline: true },
          { name: '⚔️ Attack',       value: String(stats.attack || '?'),              inline: true },
          { name: '🛡️ Defence',      value: String(stats.defense || '?'),             inline: true },
          { name: '✨ Sp. Atk',      value: String(stats['special-attack'] || '?'),   inline: true },
          { name: '🌟 Sp. Def',      value: String(stats['special-defense'] || '?'),  inline: true },
          { name: '💨 Speed',        value: String(stats.speed || '?'),               inline: true },
        )
        .setFooter({ text: `Data from PokéAPI • Gen 1–8` });

      if (sprite) embed.setThumbnail(sprite);

      return safeReplyPoke(interaction, { embeds: [embed] });
    }

    // ── /pokemon-challenge ─────────────────────────────────────────────────
    if (commandName === 'pokemon-challenge') {
      const target   = interaction.options.getUser('user');
      const slot     = interaction.options.getInteger('slot') - 1;

      if (!userClan) return safeReplyPoke(interaction, { content: '❌ You must be in a clan to battle.', flags: 64 });
      if (target.id === user.id) return safeReplyPoke(interaction, { content: '❌ You cannot challenge yourself.', flags: 64 });
      if (target.bot) return safeReplyPoke(interaction, { content: '❌ You cannot challenge a bot.', flags: 64 });

      const targetClan = getUserClan(guild.id, target.id);
      if (!targetClan) return safeReplyPoke(interaction, { content: '❌ That user is not in a clan.', flags: 64 });
      if (targetClan.name === userClan.name) return safeReplyPoke(interaction, { content: '❌ You cannot challenge a member of your own clan.', flags: 64 });

      const myPokemon = memberData.pokemon;
      if (myPokemon.length === 0) return safeReplyPoke(interaction, { content: '❌ You have no Pokémon! Catch one first.', flags: 64 });
      if (slot < 0 || slot >= myPokemon.length) return safeReplyPoke(interaction, { content: `❌ Invalid slot. You have ${myPokemon.length} Pokémon.`, flags: 64 });

      if (pendingChallenges[target.id]) return safeReplyPoke(interaction, { content: `❌ **${target.username}** already has a pending challenge.`, flags: 64 });
      if (activeBattles[`${guild.id}_${user.id}`]) return safeReplyPoke(interaction, { content: '❌ You are already in a battle.', flags: 64 });

      pendingChallenges[target.id] = {
        challengerUserId: user.id,
        challengerSlot:   slot,
        guildId:          guild.id,
        channelId:        interaction.channelId,
        expiresAt:        Date.now() + 5 * 60_000,
      };

      setTimeout(() => {
        if (pendingChallenges[target.id]?.challengerUserId === user.id) {
          delete pendingChallenges[target.id];
        }
      }, 5 * 60_000);

      const myPoke = myPokemon[slot];

      return safeReplyPoke(interaction, {
        embeds: [new EmbedBuilder()
          .setColor(0xFF0000)
          .setTitle('⚔️ Pokémon Battle Challenge!')
          .setDescription(
            `<@${user.id}> (**${userClan.name}**) challenges <@${target.id}> (**${targetClan.name}**) to a Pokémon battle!\n\n` +
            `**${user.displayName}** will use: ${pokemonDisplay(myPoke)}\n\n` +
            `<@${target.id}> — use \`/pokemon-accept <slot>\` to accept or \`/pokemon-decline\` to decline.\n` +
            `⏰ Expires in **5 minutes**.`
          )]
      });
    }

    // ── /pokemon-accept ────────────────────────────────────────────────────
    if (commandName === 'pokemon-accept') {
      const challenge = pendingChallenges[user.id];
      if (!challenge) return safeReplyPoke(interaction, { content: '❌ You have no pending battle challenge.', flags: 64 });
      if (Date.now() > challenge.expiresAt) {
        delete pendingChallenges[user.id];
        return safeReplyPoke(interaction, { content: '❌ The challenge has expired.', flags: 64 });
      }

      const slot          = interaction.options.getInteger('slot') - 1;
      const defenderData  = getMemberPokemon(db, guild.id, user.id);
      const defPokemon    = defenderData.pokemon;

      if (defPokemon.length === 0) return safeReplyPoke(interaction, { content: '❌ You have no Pokémon! You can\'t accept.', flags: 64 });
      if (slot < 0 || slot >= defPokemon.length) return safeReplyPoke(interaction, { content: `❌ Invalid slot. You have ${defPokemon.length} Pokémon.`, flags: 64 });

      const challengerData = getMemberPokemon(db, guild.id, challenge.challengerUserId);
      const atkPoke        = JSON.parse(JSON.stringify(challengerData.pokemon[challenge.challengerSlot])); // deep copy for battle
      const defPoke        = JSON.parse(JSON.stringify(defPokemon[slot]));

      if (!atkPoke) return safeReplyPoke(interaction, { content: '❌ Challenger\'s Pokémon is no longer available.', flags: 64 });

      delete pendingChallenges[user.id];

      const battleChannel = guild.channels.cache.get(challenge.channelId) || interaction.channel;

      // Speed determines who goes first
      const p1GoesFirst = atkPoke.speed >= defPoke.speed;

      const challengerUser = await guild.members.fetch(challenge.challengerUserId).catch(() => null);
      const challengerName = challengerUser?.displayName || 'Challenger';
      const defenderName   = interaction.member?.displayName || user.displayName;

      const battle = {
        p1UserId:         p1GoesFirst ? challenge.challengerUserId : user.id,
        p2UserId:         p1GoesFirst ? user.id : challenge.challengerUserId,
        p1Name:           p1GoesFirst ? challengerName : defenderName,
        p2Name:           p1GoesFirst ? defenderName   : challengerName,
        p1Pokemon:        p1GoesFirst ? atkPoke : defPoke,
        p2Pokemon:        p1GoesFirst ? defPoke : atkPoke,
        p1Potions:        2,
        p2Potions:        2,
        currentTurnUserId: p1GoesFirst ? challenge.challengerUserId : user.id,
        turn:             1,
        log:              [],
        guildId:          guild.id,
        channelId:        battleChannel.id,
        p1SlotIndex:      p1GoesFirst ? challenge.challengerSlot : slot,
        p2SlotIndex:      p1GoesFirst ? slot : challenge.challengerSlot,
        p1ActualUserId:   challenge.challengerUserId,
        p2ActualUserId:   user.id,
      };

      activeBattles[`${guild.id}_${challenge.challengerUserId}`] = battle;
      activeBattles[`${guild.id}_${user.id}`] = battle;

      await safeReplyPoke(interaction, {
        embeds: [new EmbedBuilder().setColor(0xFF0000).setTitle('⚔️ Battle Accepted!').setDescription(`**${challengerName}** vs **${defenderName}** — The battle begins!\n\n${p1GoesFirst ? challengerName : defenderName} goes first (higher Speed)!`)]
      });

      // Start battle loop
      await runBattleLoop(battle, battleChannel, guild, db, saveData, getMemberPokemon, getUserClan);
    }

    // ── /pokemon-decline ───────────────────────────────────────────────────
    if (commandName === 'pokemon-decline') {
      const challenge = pendingChallenges[user.id];
      if (!challenge) return safeReplyPoke(interaction, { content: '❌ You have no pending battle challenge.', flags: 64 });
      delete pendingChallenges[user.id];
      return safeReplyPoke(interaction, {
        embeds: [new EmbedBuilder().setColor(0xED4245).setTitle('❌ Challenge Declined').setDescription(`<@${user.id}> declined the battle challenge.`)]
      });
    }

    // ── /pokemon-leaderboard ───────────────────────────────────────────────
    if (commandName === 'pokemon-leaderboard') {
      if (!userClan) return safeReplyPoke(interaction, { content: '❌ You must be in a clan to view the leaderboard.', flags: 64 });

      const clanMemberIds = [
        userClan.clan.leader,
        ...(userClan.clan.officers || []),
        ...(userClan.clan.members  || []),
      ];

      const pokemonData = db[guild.id]?.__pokemon || {};
      const entries = [];

      for (const uid of clanMemberIds) {
        const data = pokemonData[uid];
        if (!data) continue;
        const member = await guild.members.fetch(uid).catch(() => null);
        const name   = member?.displayName || uid;
        entries.push({
          name,
          count:  data.pokemon.length,
          wins:   data.battleWins || 0,
          highest: data.pokemon.reduce((max, p) => p.level > max ? p.level : max, 0),
        });
      }

      entries.sort((a, b) => b.count - a.count || b.wins - a.wins);

      if (entries.length === 0) {
        return safeReplyPoke(interaction, { content: '📭 No Pokémon caught in your clan yet!', flags: 64 });
      }

      const medals = ['🥇','🥈','🥉'];
      const desc = entries.map((e, i) =>
        `${medals[i] || `**${i+1}.**`} **${e.name}** — ${e.count} Pokémon | ${e.wins} battle win${e.wins !== 1 ? 's' : ''} | Highest Lv.${e.highest}`
      ).join('\n');

      const clanStats = getClanPokemonStats(db, guild.id, gc);

      return safeReplyPoke(interaction, {
        embeds: [new EmbedBuilder()
          .setColor(0xFFD700)
          .setTitle(`🏆 ${userClan.name} — Pokémon Leaderboard`)
          .setDescription(desc)
          .addFields(
            { name: '📊 Clan Totals', value:
              `Total caught: **${clanStats.totalCaught}**\n` +
              `Total battle wins: **${clanStats.totalWins}**\n` +
              `Highest level: **${clanStats.highestLevel}**`
            }
          )]
      });
    }

    // ── /pokemon-spawn (admin only, not documented) ────────────────────────
    if (commandName === 'pokemon-spawn') {
      // Must have Administrator permission
      if (!interaction.memberPermissions?.has('Administrator')) {
        return safeReplyPoke(interaction, { content: '❌ You do not have permission to use this command.', flags: 64 });
      }

      // Use specified channel or try to find the user's clan channel
      let targetChannel = interaction.options.getChannel('channel');

      if (!targetChannel) {
        const userClanResult = getUserClan(guild.id, user.id);
        if (userClanResult?.clan?.channelId) {
          targetChannel = guild.channels.cache.get(userClanResult.clan.channelId);
        }
      }

      if (!targetChannel) {
        return safeReplyPoke(interaction, {
          content: '❌ No clan channel found. Either specify a channel or make sure your clan has a private channel created.',
          flags: 64,
        });
      }

      // Check if there's already an active spawn
      if (activeSpawns[targetChannel.id]) {
        return safeReplyPoke(interaction, {
          content: `❌ There is already an active spawn in ${targetChannel}. Wait for it to be caught or flee first.`,
          flags: 64,
        });
      }

      await safeReplyPoke(interaction, { content: `✅ Forcing a Pokémon spawn in ${targetChannel}...`, flags: 64 });

      // Clear any existing timer and spawn immediately
      if (spawnTimers[targetChannel.id]) clearTimeout(spawnTimers[targetChannel.id]);
      await triggerSpawn(targetChannel, db, saveData, getGuildClans, getUserClan);
      return;
    }
    if (commandName === 'pokemon-server') {
      await interaction.deferReply().catch(() => {});
      const pokemonData = db[guild.id]?.__pokemon || {};
      const entries = [];

      for (const [uid, data] of Object.entries(pokemonData)) {
        if (!data.pokemon || data.pokemon.length === 0) continue;
        const uClan    = getUserClan(guild.id, uid);
        const clanName = uClan ? uClan.name : 'No Clan';
        let displayName = uid;
        try { const m = await guild.members.fetch(uid); displayName = m.displayName; } catch {}
        for (const p of data.pokemon) {
          if ((p.battleWins || 0) > 0) {
            entries.push({
              displayName, clanName,
              pokeName: p.nickname ? `${p.nickname} (${capitalize(p.name)})` : capitalize(p.name),
              level: p.level, wins: p.battleWins || 0, isShiny: p.isShiny, types: p.types,
            });
          }
        }
      }

      if (entries.length === 0) {
        return safeReplyPoke(interaction, { content: '📭 No Pokémon on this server have any battle wins yet!' });
      }

      entries.sort((a, b) => b.wins - a.wins);
      const top    = entries.slice(0, 15);
      const medals = ['🥇','🥈','🥉'];
      const desc   = top.map((e, i) => {
        const shiny = e.isShiny ? '✨' : '';
        const types = (e.types || []).map(t => TYPE_EMOJI[t] || '').join('');
        return `${medals[i] || `**${i+1}.**`} ${shiny}**${e.pokeName}** ${types} Lv.${e.level} — **${e.wins} win${e.wins !== 1 ? 's' : ''}**\n     Owner: ${e.displayName} · Clan: **${e.clanName}**`;
      }).join('\n\n');

      return safeReplyPoke(interaction, {
        embeds: [new EmbedBuilder()
          .setColor(0xFFD700)
          .setTitle('🏆 Server Pokémon Leaderboard — Top Battle Wins')
          .setDescription(desc)
          .setFooter({ text: `Top ${top.length} of ${entries.length} Pokémon with wins` })]
      });
    }

    if (commandName === 'pokedex') {
      if (!userClan) return safeReplyPoke(interaction, { content: '❌ You must be in a clan to view your Pokédex.', flags: 64 });

      const clanMemberIds = [
        userClan.clan.leader,
        ...(userClan.clan.officers || []),
        ...(userClan.clan.members  || []),
      ];

      const pokemonData = db[guild.id]?.__pokemon || {};
      const caughtSpecies = new Set();

      for (const uid of clanMemberIds) {
        const data = pokemonData[uid];
        if (!data) continue;
        for (const p of data.pokemon) caughtSpecies.add(p.id);
      }

      const total   = caughtSpecies.size;
      const pct     = ((total / MAX_POKEMON_ID) * 100).toFixed(1);
      const preview = [...caughtSpecies].slice(0, 20).map(id => `#${id}`).join(', ');

      return safeReplyPoke(interaction, {
        embeds: [new EmbedBuilder()
          .setColor(0xFF0000)
          .setTitle(`📕 ${userClan.name}'s Pokédex`)
          .setDescription(
            `**${total} / ${MAX_POKEMON_ID}** species caught (${pct}%)\n\n` +
            (total > 0 ? `Recent: ${preview}${total > 20 ? ` ...and ${total - 20} more` : ''}` : 'No Pokémon caught yet!')
          )
          .setFooter({ text: 'Catch more Pokémon when they spawn in your clan channel!' })]
      });
    }
  }

  // ─── Battle loop ──────────────────────────────────────────────────────────

  async function runBattleLoop(battle, channel, guild, db, saveData, getMemberPokemon, getUserClan) {
    let ongoing = true;

    while (ongoing) {
      try {
        const currentEmbed = buildBattleEmbed(battle, battle.turn);
        const isP1Turn     = battle.currentTurnUserId === battle.p1UserId;
        const currentPoke  = isP1Turn ? battle.p1Pokemon : battle.p2Pokemon;
        const potionsLeft  = isP1Turn ? battle.p1Potions : battle.p2Potions;

        // Add battle log to embed
        if (battle.log.length > 0) {
          currentEmbed.addFields({ name: '📋 Battle Log', value: battle.log.join('\n') });
        }

        const rows = battleMoveButtons(currentPoke, potionsLeft);

        const msg = await channel.send({
          content: `<@${battle.currentTurnUserId}> — it's your turn!`,
          embeds: [currentEmbed],
          components: rows,
        }).catch(() => null);

        if (!msg) break;

        // Wait for the current player's action
        const result = await new Promise(resolve => {
          const col = msg.createMessageComponentCollector({
            filter: i => i.user.id === battle.currentTurnUserId,
            time: BATTLE_TIMEOUT_MS,
            max: 1,
          });

          col.on('collect', async i => {
            await i.deferUpdate().catch(() => {});
            const customId = i.customId;

            if (customId === 'battle_potion') {
              resolve('potion');
            } else if (customId === 'battle_forfeit') {
              resolve('forfeit');
            } else if (customId.startsWith('battle_move_')) {
              resolve(customId.replace('battle_move_', ''));
            } else {
              resolve(null);
            }
          });

          col.on('end', (collected) => {
            if (collected.size === 0) resolve('timeout');
          });
        });

        // Disable buttons after action
        const disabledRows = rows.map(row => {
          const newRow = new ActionRowBuilder();
          newRow.addComponents(row.components.map(b => ButtonBuilder.from(b.toJSON()).setDisabled(true)));
          return newRow;
        });
        await msg.edit({ components: disabledRows }).catch(() => {});

        if (result === 'timeout') {
          // Auto-forfeit on timeout
          await channel.send(`⏰ <@${battle.currentTurnUserId}> took too long! They forfeit the battle.`).catch(() => {});
          await endBattle(battle, battle.currentTurnUserId === battle.p1UserId ? battle.p2UserId : battle.p1UserId, channel, guild, db, saveData, getMemberPokemon, 'timeout');
          ongoing = false;
          break;
        }

        if (result === null) continue;

        const turnResult = await runBattleTurn(battle, channel, db, saveData, result, battle.currentTurnUserId);

        if (turnResult === 'end') {
          const loserPoke  = battle.currentTurnUserId === battle.p1UserId ? battle.p2Pokemon : battle.p1Pokemon;
          const winnerUser = battle.currentTurnUserId === battle.p1UserId ? battle.p1UserId  : battle.p2UserId;
          const winnerName = battle.currentTurnUserId === battle.p1UserId ? battle.p1Name    : battle.p2Name;
          const loserName  = battle.currentTurnUserId === battle.p1UserId ? battle.p2Name    : battle.p1Name;

          await channel.send({
            embeds: [new EmbedBuilder()
              .setColor(0x57F287)
              .setTitle('🏆 Battle Over!')
              .setDescription(
                `💀 **${capitalize(loserPoke.name)}** fainted!\n\n` +
                `🎉 **${winnerName}** wins the battle!\n` +
                `😔 **${loserName}** fought well!`
              )]
          }).catch(() => {});

          await endBattle(battle, winnerUser, channel, guild, db, saveData, getMemberPokemon, 'win');
          ongoing = false;

        } else if (turnResult === 'forfeit') {
          const winnerUser = battle.currentTurnUserId === battle.p1UserId ? battle.p2UserId : battle.p1UserId;
          const forfeiterName = battle.currentTurnUserId === battle.p1UserId ? battle.p1Name : battle.p2Name;
          await channel.send(`🏳️ **${forfeiterName}** forfeited the battle!`).catch(() => {});
          await endBattle(battle, winnerUser, channel, guild, db, saveData, getMemberPokemon, 'forfeit');
          ongoing = false;
        }

      } catch (err) {
        console.error('Battle loop error:', err);
        ongoing = false;
        delete activeBattles[`${battle.guildId}_${battle.p1UserId}`];
        delete activeBattles[`${battle.guildId}_${battle.p2UserId}`];
      }
    }
  }

  async function endBattle(battle, winnerUserId, channel, guild, db, saveData, getMemberPokemon, reason) {
    try {
      // winnerUserId is the speed-ordered p1/p2 userId
      // We need to map back to the actual user IDs and their correct slot indices
      const winnerIsP1    = winnerUserId === battle.p1UserId;
      const winnerActual  = winnerIsP1 ? battle.p1ActualUserId : battle.p2ActualUserId;
      const loserActual   = winnerIsP1 ? battle.p2ActualUserId : battle.p1ActualUserId;
      const winnerSlot    = winnerIsP1 ? battle.p1SlotIndex    : battle.p2SlotIndex;
      const loserSlot     = winnerIsP1 ? battle.p2SlotIndex    : battle.p1SlotIndex;
      const winnerPoke    = winnerIsP1 ? battle.p1Pokemon      : battle.p2Pokemon;
      const loserPoke     = winnerIsP1 ? battle.p2Pokemon      : battle.p1Pokemon;

      const winnerData = getMemberPokemon(db, battle.guildId, winnerActual);
      const loserData  = getMemberPokemon(db, battle.guildId, loserActual);

      if (reason === 'win' || reason === 'forfeit') {
        // Update winner's stored Pokemon
        if (winnerData.pokemon[winnerSlot]) {
          const { xpGain, levelled } = await awardBattleXp(winnerData.pokemon[winnerSlot], true);
          // Increment wins on both the member record and the individual Pokemon
          winnerData.battleWins = (winnerData.battleWins || 0) + 1;
          winnerData.pokemon[winnerSlot].battleWins = (winnerData.pokemon[winnerSlot].battleWins || 0) + 1;
          if (levelled) {
            await channel.send(`⬆️ **${capitalize(winnerData.pokemon[winnerSlot].name)}** levelled up to **Lv.${winnerData.pokemon[winnerSlot].level}**!`).catch(() => {});
          }
          await channel.send(`⭐ **${capitalize(winnerPoke.name)}** gained **${xpGain} XP**!`).catch(() => {});
        }

        // Update loser's stored Pokemon
        if (loserData.pokemon[loserSlot]) {
          const { xpGain } = await awardBattleXp(loserData.pokemon[loserSlot], false);
          await channel.send(`⭐ **${capitalize(loserPoke.name)}** gained **${xpGain} XP** for participating!`).catch(() => {});
        }
      }

      saveData();
      console.log(`✅ Battle ended — winner: ${winnerActual}, slot: ${winnerSlot}, wins now: ${winnerData.battleWins}`);

    } catch (err) {
      console.error('endBattle error:', err);
    } finally {
      delete activeBattles[`${battle.guildId}_${battle.p1ActualUserId}`];
      delete activeBattles[`${battle.guildId}_${battle.p2ActualUserId}`];
    }
  }

  // ─── Watch for new clan channels being created ────────────────────────────
  // Small delay ensures index.js has saved channelId to clans.json before we check

  client.on('channelCreate', channel => {
    setTimeout(() => {
      try {
        if (!channel.guild) return;
        const gc = getGuildClans(channel.guild.id);
        for (const clan of Object.values(gc)) {
          if (clan.channelId === channel.id) {
            console.log(`🌿 New clan channel detected — scheduling spawns for #${channel.name}`);
            scheduleNextSpawn(channel, db, saveData, getGuildClans, getUserClan);
            break;
          }
        }
      } catch {}
    }, 2000);
  });

};
