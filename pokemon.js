// ═══════════════════════════════════════════════════════════════════════════════
// POKEMON SYSTEM — Clan Bot Extension v8
// New: Item drops, Officer war start, Paginated /clan-commands,
//      /pokemon-view, /pokemon-stats, channel rename fix, stale channel fix
// ═══════════════════════════════════════════════════════════════════════════════

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
} = require('discord.js');
const { awardDinar, isAtDinarCap, dinarDailyCap } = require('./gacha');

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_POKEMON        = 30;
const SPAWN_INTERVAL_MS  = 5 * 60 * 60 * 1000;   // (legacy, no longer used for scheduling)
const SPAWN_FLEE_MS      = 3 * 60 * 60 * 1000;   // 3 hours
const DROP_INTERVAL_MS   = 7 * 60 * 60 * 1000;   // (legacy, no longer used for scheduling)
const DROP_EXPIRE_MS     = 5 * 60 * 60 * 1000;   // Item drops expire in 5 hours
const POKEBALL_PER_SPAWN = 3;

// ─── Persistent daily spawn schedule (survives bot restarts/redeploys) ───────
const LIBYA_OFFSET_MS    = 2 * 60 * 60 * 1000;   // Libya is UTC+2 year-round (no DST)
const SPAWN_WINDOW_START = 9;                    // 09:00 Libya time
const SPAWN_WINDOW_END   = 23;                   // 23:00 Libya time
const SPAWNS_PER_DAY     = 2;
const DROPS_PER_DAY      = 1;
const MIN_GAP_MS         = 90 * 60 * 1000;       // ≥90 min between scheduled times
const SCHED_TICK_MS      = 60 * 1000;            // re-check the schedule every minute
const MAX_POKEMON_ID     = 898;
const SHINY_CHANCE       = 50;
const POTION_HEAL_PCT    = 0.30;
const BATTLE_TIMEOUT_MS  = 60 * 1000;
const FIRST_HIT_XP       = 15;
const STREAK_THRESHOLD   = 3;
const STREAK_XP_BONUS    = 50;
const STREAK_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const HONEY_DURATION_MS  = 12 * 60 * 60 * 1000;  // 12 hours

// ─── Item Definitions ─────────────────────────────────────────────────────────

const ITEMS = {
  great_ball: {
    id:          'great_ball',
    name:        'Great Ball',
    emoji:       '🔵',
    description: 'A high-performance Ball with a higher catch rate than a standard Pokéball.',
    catchBonus:  1.5,   // multiplier on catch rate
    type:        'ball',
    pokeApiId:   'great-ball',
  },
  ultra_ball: {
    id:          'ultra_ball',
    name:        'Ultra Ball',
    emoji:       '⚫',
    description: 'An ultra-high performance Ball with a much higher catch rate.',
    catchBonus:  2.0,
    type:        'ball',
    pokeApiId:   'ultra-ball',
  },
  super_potion: {
    id:          'super_potion',
    name:        'Super Potion',
    emoji:       '🧪',
    description: 'Restores 50 HP to a Pokémon during battle.',
    healAmount:  50,
    type:        'potion',
    pokeApiId:   'super-potion',
  },
  hyper_potion: {
    id:          'hyper_potion',
    name:        'Hyper Potion',
    emoji:       '💊',
    description: 'Restores 120 HP to a Pokémon during battle.',
    healAmount:  120,
    type:        'potion',
    pokeApiId:   'hyper-potion',
  },
  honey: {
    id:          'honey',
    name:        'Honey',
    emoji:       '🍯',
    description: 'A sweet honey that attracts rare Pokémon. Activates automatically when claimed — rare spawns for 12 hours!',
    type:        'honey',
    pokeApiId:   'honey',
  },
};

// Weighted drop pool — honey is rarest
const DROP_POOL = [
  { item: 'great_ball',   weight: 35 },
  { item: 'ultra_ball',   weight: 20 },
  { item: 'super_potion', weight: 25 },
  { item: 'hyper_potion', weight: 15 },
  { item: 'honey',        weight: 5  },
];

function randomDrop() {
  const total  = DROP_POOL.reduce((s, e) => s + e.weight, 0);
  let   roll   = Math.random() * total;
  for (const entry of DROP_POOL) {
    roll -= entry.weight;
    if (roll <= 0) return entry.item;
  }
  return 'great_ball';
}

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

// Size-capped Maps — oldest entry is evicted when the cap is reached.
// A full PokéAPI response is 150–300 KB of JSON, so without a cap the cache
// grows without bound as new Pokémon spawn.
const MAX_POKE_CACHE   = 40;
const MAX_TYPE_CACHE   = 20; // only 18 types in Gen 1–8
const MAX_MOVE_CACHE   = 60;

const pokeCache        = new Map(); // pokemonId/name → apiData
const typeCache        = new Map(); // typeName      → typeData
const moveCache        = new Map(); // moveName      → moveData

function setCapped(map, key, value, max) {
  if (map.size >= max) map.delete(map.keys().next().value); // evict oldest
  map.set(key, value);
}

const activeSpawns     = {};  // { channelId: spawnState }
const activeBattles    = {};  // { `${guildId}_${userId}`: battleState }
const pendingChallenges= {};  // { targetUserId: { challengerUserId, guildId, expiresAt } }
const spawnTimers      = {};  // { channelId: timeoutId }

// ─── Response slimmers ────────────────────────────────────────────────────────
// PokéAPI responses are huge: a type response embeds the full list of every
// Pokémon and every move of that type; a Pokémon response carries a bulky
// version_group_details block on every move; both carry dozens of sprite
// variants. We only ever read a handful of fields, so we strip each response
// down to just those before caching or storing it. This shrinks every cache
// entry AND every live spawn object by roughly an order of magnitude, with no
// change in behaviour (all the field paths the rest of the code reads are kept).

function slimPokemon(data) {
  if (!data) return null;
  return {
    id:    data.id,
    name:  data.name,
    stats: data.stats,   // [{ stat:{name}, base_stat }] — already tiny, keep as-is
    types: data.types,   // [{ type:{name} }]            — already tiny, keep as-is
    // Drop version_group_details (the bulk of a Pokémon response) — keep names only
    moves: (data.moves || []).map(m => ({ move: { name: m.move.name } })),
    // Keep only the two sprites actually rendered, drop the ~20 other variants
    sprites: {
      front_default: data.sprites?.front_default || null,
      front_shiny:   data.sprites?.front_shiny   || null,
    },
    species: { url: data.species?.url || null },
  };
}

function slimMove(data) {
  if (!data) return null;
  return {
    name:         data.name,
    power:        data.power,
    accuracy:     data.accuracy,
    pp:           data.pp,
    type:         { name: data.type?.name },
    damage_class: { name: data.damage_class?.name },
  };
}

function slimType(data) {
  if (!data) return null;
  // The only field read is damage_relations — drop the embedded pokemon[]/moves[]
  // lists, which are what make a raw type response 50–100 KB each.
  return { damage_relations: data.damage_relations };
}

// ─── PokéAPI helpers ──────────────────────────────────────────────────────────

async function fetchPokemon(idOrName) {
  const key = String(idOrName).toLowerCase();
  if (pokeCache.has(key)) return pokeCache.get(key);
  try {
    const res  = await fetch(`https://pokeapi.co/api/v2/pokemon/${key}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const slim = slimPokemon(await res.json());
    if (!slim) return null;
    setCapped(pokeCache, key, slim, MAX_POKE_CACHE);
    // Also cache by numeric id so lookups by number hit the cache too
    setCapped(pokeCache, String(slim.id), slim, MAX_POKE_CACHE);
    return slim;
  } catch (e) {
    console.error('PokéAPI fetch failed:', e.message);
    return null;
  }
}

async function fetchMoveData(moveName) {
  const key = moveName.toLowerCase();
  if (moveCache.has(key)) return moveCache.get(key);
  try {
    const res  = await fetch(`https://pokeapi.co/api/v2/move/${key}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const slim = slimMove(await res.json());
    setCapped(moveCache, key, slim, MAX_MOVE_CACHE);
    return slim;
  } catch (e) {
    return null;
  }
}

async function fetchTypeData(typeName) {
  if (typeCache.has(typeName)) return typeCache.get(typeName);
  try {
    const res  = await fetch(`https://pokeapi.co/api/v2/type/${typeName}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const slim = slimType(await res.json());
    setCapped(typeCache, typeName, slim, MAX_TYPE_CACHE);
    return slim;
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
  // Copy before sort — sort() mutates in place, and learnset now belongs to the
  // shared cached Pokémon object, so sorting it directly would scramble the cache.
  const shuffled = [...learnset].sort(() => Math.random() - 0.5).slice(0, 20);
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
  if (!db[guildId].__pokemon[userId]) {
    db[guildId].__pokemon[userId] = {
      pokemon:    [],
      pokeballs:  5,
      battleWins: 0,
      items:      {}, // { itemId: count }
    };
  }
  // Migrate old records that don't have items yet
  if (!db[guildId].__pokemon[userId].items) {
    db[guildId].__pokemon[userId].items = {};
  }
  return db[guildId].__pokemon[userId];
}

// Add an item to a member's bag
function addItem(memberData, itemId) {
  memberData.items[itemId] = (memberData.items[itemId] || 0) + 1;
}

// Use an item from a member's bag — returns true if successful
function useItem(memberData, itemId) {
  if (!memberData.items[itemId] || memberData.items[itemId] <= 0) return false;
  memberData.items[itemId]--;
  if (memberData.items[itemId] === 0) delete memberData.items[itemId];
  return true;
}

// Count items of a type in a member's bag
function countItem(memberData, itemId) {
  return memberData.items[itemId] || 0;
}

function getClanPokemonStats(db, guildId, gc) {
  const pokemon    = db[guildId]?.__pokemon || {};
  let totalCaught  = 0;
  let totalWins    = 0;
  let highestLevel = 0;

  // Only count members currently in a clan
  const allMemberIds = [];
  for (const [__k, clan] of Object.entries(gc)) { if (__k.startsWith("__")) continue;
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
    .setFooter({ text: `Flees in ${SPAWN_FLEE_MS / 3600000} hours if ignored.` });

  if (spriteUrl) embed.setThumbnail(spriteUrl);
  return embed;
}

function faintedEmbed(pokeName, isShiny) {
  return new EmbedBuilder()
    .setColor(0x888888)
    .setTitle(`💀 ${isShiny ? '✨ ' : ''}${capitalize(pokeName)} fainted!`)
    .setDescription('It fainted before it could be caught. Better luck next time!');
}

// Build catch interaction rows — shows available balls as separate buttons
// memberData is passed so we know which balls the user has
function catchRows(regularBallsLeft, memberData) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('poke_attack').setLabel('⚔️ Attack').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('poke_heavy').setLabel('💥 Heavy Strike').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('poke_run').setLabel('🏃 Run').setStyle(ButtonStyle.Secondary),
  );

  // Build ball buttons
  const ballButtons = [];

  // Regular pokeball
  if (regularBallsLeft > 0) {
    ballButtons.push(
      new ButtonBuilder()
        .setCustomId('poke_catch_regular')
        .setLabel(`🎯 Pokéball (${regularBallsLeft})`)
        .setStyle(ButtonStyle.Success)
    );
  }

  // Great Ball
  const greatBalls = memberData ? countItem(memberData, 'great_ball') : 0;
  if (greatBalls > 0) {
    ballButtons.push(
      new ButtonBuilder()
        .setCustomId('poke_catch_great')
        .setLabel(`🔵 Great Ball (${greatBalls})`)
        .setStyle(ButtonStyle.Success)
    );
  }

  // Ultra Ball
  const ultraBalls = memberData ? countItem(memberData, 'ultra_ball') : 0;
  if (ultraBalls > 0) {
    ballButtons.push(
      new ButtonBuilder()
        .setCustomId('poke_catch_ultra')
        .setLabel(`⚫ Ultra Ball (${ultraBalls})`)
        .setStyle(ButtonStyle.Success)
    );
  }

  // If no balls at all, show disabled catch button
  if (ballButtons.length === 0) {
    ballButtons.push(
      new ButtonBuilder()
        .setCustomId('poke_catch_regular')
        .setLabel('🎯 No balls left!')
        .setStyle(ButtonStyle.Success)
        .setDisabled(true)
    );
  }

  // Discord allows max 5 buttons per row — split if needed
  const rows = [row1];
  // Chunk ball buttons into rows of up to 5
  for (let i = 0; i < ballButtons.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(...ballButtons.slice(i, i + 5)));
  }
  return rows;
}

// Legacy single-row version used for updating embed with simple state
function catchButtons(ballsLeft) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('poke_attack').setLabel('⚔️ Attack').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('poke_heavy').setLabel('💥 Heavy Strike').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('poke_catch_regular').setLabel(`🎯 Catch (${ballsLeft})`).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('poke_run').setLabel('🏃 Run').setStyle(ButtonStyle.Secondary),
  );
}

function disabledButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('poke_attack').setLabel('⚔️ Attack').setStyle(ButtonStyle.Primary).setDisabled(true),
    new ButtonBuilder().setCustomId('poke_heavy').setLabel('💥 Heavy Strike').setStyle(ButtonStyle.Danger).setDisabled(true),
    new ButtonBuilder().setCustomId('poke_catch_regular').setLabel('🎯 Catch').setStyle(ButtonStyle.Success).setDisabled(true),
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

// Find the clan that owns a given channel (used to honour a clan's opt-out of
// Pokémon/item spawns). Returns the clan object, or null.
function clanForChannel(getGuildClans, channel) {
  try {
    const gc = getGuildClans(channel.guild.id);
    for (const [name, clan] of Object.entries(gc)) {
      if (name.startsWith('__')) continue;
      if (clan.channelId === channel.id) return clan;
    }
  } catch { /* ignore */ }
  return null;
}

function scheduleNextSpawn(channel, db, saveData, getGuildClans, getUserClan, awardLP) {
  // No-op: per-channel interval timers don't survive redeploys. Spawns are now driven
  // by a persistent daily schedule (see ensureSchedule / scheduleTick in initPokemon).
}

async function triggerSpawn(channel, db, saveData, getGuildClans, getUserClan, awardLP) {
  // Respect a clan's opt-out: if this channel's clan disabled Pokémon, skip the
  // spawn but keep the timer ticking so it resumes if they re-enable.
  const ownerClan = clanForChannel(getGuildClans, channel);
  if (ownerClan && ownerClan.pokemonDisabled) {
    scheduleNextSpawn(channel, db, saveData, getGuildClans, getUserClan, awardLP);
    return;
  }
  // Don't spawn if one is already active here
  if (activeSpawns[channel.id]) {
    scheduleNextSpawn(channel, db, saveData, getGuildClans, getUserClan, awardLP);
    return;
  }

  try {
    const pokeId    = Math.floor(Math.random() * MAX_POKEMON_ID) + 1;
    const apiData   = await fetchPokemon(pokeId);
    if (!apiData) {
      scheduleNextSpawn(channel, db, saveData, getGuildClans, getUserClan, awardLP);
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

    const embed = spawnEmbed(spawn.hp, spawn.maxHp, apiData.name, types, spriteUrl, isShiny, level, spawn.speciesCatchRate);
    // Spawn message uses basic buttons — no member data available at this stage
    const initialRows = catchRows(POKEBALL_PER_SPAWN, null);

    // Check if honey is active for this channel's clan — if so boost to rare spawn
    // (honey effect already applied at spawn selection level above)

    let msg;
    try {
      msg = await channel.send({
        content: `🌿 **A wild Pokémon has appeared!** ${isShiny ? '✨ It\'s shiny!' : ''}\n-# Not into Pokémon? A clan Leader or Officer can turn spawns & item drops off here with \`/clan-pokemon off\``,
        embeds: [embed],
        components: initialRows,
      });
    } catch (err) {
      // Channel deleted or inaccessible
      if (err.code === 10003 || err.code === 50013) {
        console.warn(`⚠️ Cannot send to channel ${channel.id} — clearing stale channelId`);
        // Find and clear the clan channelId
        const gc = getGuildClans(channel.guild?.id || '');
        for (const [__k, clan] of Object.entries(gc)) { if (__k.startsWith("__")) continue;
          if (clan.channelId === channel.id) { clan.channelId = null; saveData(); break; }
        }
        delete activeSpawns[channel.id];
        return;
      }
      throw err;
    }

    spawn.messageId = msg.id;
    spawn.message   = msg;

    // Auto-flee timer
    const fleeTimer = setTimeout(async () => {
      if (!activeSpawns[channel.id] || activeSpawns[channel.id].caught || activeSpawns[channel.id].fainted) return;
      const wasInteracted = spawn.firstHitUserId !== undefined;
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
      scheduleNextSpawn(channel, db, saveData, getGuildClans, getUserClan, awardLP);
    }, SPAWN_FLEE_MS);

    spawn.fleeTimer = fleeTimer;

    // Button collector — updated filter to catch all ball types
    const CATCH_IDS = ['poke_attack','poke_heavy','poke_catch_regular','poke_catch_great','poke_catch_ultra','poke_run'];
    const collector = msg.createMessageComponentCollector({
      filter: i => CATCH_IDS.includes(i.customId),
      time: SPAWN_FLEE_MS,
    });

    collector.on('collect', async i => {
      await handleSpawnInteraction(i, spawn, channel, db, saveData, getGuildClans, getUserClan, collector, awardLP);
    });

  } catch (err) {
    console.error('Spawn error:', err);
    scheduleNextSpawn(channel, db, saveData, getGuildClans, getUserClan, awardLP);
  }
}

async function handleSpawnInteraction(i, spawn, channel, db, saveData, getGuildClans, getUserClan, collector, awardLP) {
  try {
    await i.deferUpdate();

    const guildId = channel.guild.id;
    const userId  = i.user.id;

    // Find which clan owns this channel
    const gc = getGuildClans(guildId);
    let channelClan = null;
    let channelClanName = null;
    for (const [name, clan] of Object.entries(gc)) { if (name.startsWith("__")) continue;
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

      const freshMemberData = getMemberPokemon(db, guildId, userId);
      const rows = catchRows(userBalls, freshMemberData);
      await spawn.message.edit({
        embeds: [updatedEmbed],
        components: rows,
      }).catch(() => {});

      return;
    }

    // ── CATCH (all ball types) ────────────────────────────────────────────────
    if (['poke_catch_regular','poke_catch_great','poke_catch_ultra'].includes(i.customId)) {
      // Determine which ball is being used
      let ballType    = 'regular';
      let catchBonus  = 1.0;
      let ballEmoji   = '🎯';
      let ballName    = 'Pokéball';

      if (i.customId === 'poke_catch_great') {
        ballType   = 'great_ball';
        catchBonus = ITEMS.great_ball.catchBonus;
        ballEmoji  = ITEMS.great_ball.emoji;
        ballName   = ITEMS.great_ball.name;
      } else if (i.customId === 'poke_catch_ultra') {
        ballType   = 'ultra_ball';
        catchBonus = ITEMS.ultra_ball.catchBonus;
        ballEmoji  = ITEMS.ultra_ball.emoji;
        ballName   = ITEMS.ultra_ball.name;
      }

      // Check ball availability
      if (ballType === 'regular') {
        if (spawn.userBalls[userId] === undefined) spawn.userBalls[userId] = POKEBALL_PER_SPAWN;
        if (spawn.userBalls[userId] <= 0) {
          await i.followUp({ content: '❌ You have no Pokéballs left for this encounter!', flags: 64 });
          return;
        }
        spawn.userBalls[userId]--;
      } else {
        // Special ball — check and consume from inventory
        if (!useItem(memberData, ballType)) {
          await i.followUp({ content: `❌ You don't have any ${ballName}s!`, flags: 64 });
          return;
        }
        saveData();
      }

      const ballsLeft = spawn.userBalls[userId] ?? 0;
      const catchRate = Math.min(0.95, calcCatchRate(spawn.hp, spawn.maxHp, spawn.speciesCatchRate) * catchBonus);
      const caught    = Math.random() < catchRate;

      if (caught) {
        if (memberData.pokemon.length >= MAX_POKEMON) {
          await i.followUp({
            content: `❌ You already have **${MAX_POKEMON} Pokémon**! Use \`/pokemon-release\` to release one first.`,
            flags: 64,
          });
          // Give ball back
          if (ballType === 'regular') spawn.userBalls[userId]++;
          else { addItem(memberData, ballType); saveData(); }
          return;
        }

        spawn.caught = true;
        clearTimeout(spawn.fleeTimer);
        delete activeSpawns[channel.id];
        collector.stop();
        scheduleNextSpawn(channel, db, saveData, getGuildClans, getUserClan, awardLP);

        const caughtPoke = await buildCaughtPokemon(spawn.apiData, spawn.level, spawn.isShiny, userId);
        memberData.pokemon.push(caughtPoke);
        memberData.pokeballs = (memberData.pokeballs || 0) + POKEBALL_PER_SPAWN;

        // Award LP for catching
        if (awardLP) awardLP(guildId, userId, 1, 'pokemon');
        awardDinar(db, guildId, userId, 20, saveData);

        // Catch streak tracking
        let streakMsg = '';
        if (channelClan) {
          if (!channelClan.catchStreak)      channelClan.catchStreak = 0;
          if (!channelClan.lastCatchTime)    channelClan.lastCatchTime = 0;
          if (!channelClan.streakBonusUntil) channelClan.streakBonusUntil = 0;
          channelClan.catchStreak++;
          channelClan.lastCatchTime = Date.now();
          if (channelClan.catchStreak >= STREAK_THRESHOLD) {
            channelClan.xp = (channelClan.xp || 0) + STREAK_XP_BONUS;
            channelClan.streakBonusUntil = Date.now() + STREAK_DURATION_MS;
            channelClan.catchStreak = 0;
            streakMsg = `\n\n🔥 **${STREAK_THRESHOLD} catch streak!** +${STREAK_XP_BONUS} bonus clan XP!`;
          } else {
            streakMsg = `\n\n🔥 Catch streak: **${channelClan.catchStreak}/${STREAK_THRESHOLD}**`;
          }
        }

        saveData();

        const shinyStr   = spawn.isShiny ? '✨ SHINY ' : '';
        const typeColour = TYPE_COLOURS[spawn.types[0]] || 0x57F287;

        await spawn.message.edit({
          content: `🎉 **${i.user.displayName}** caught the wild **${shinyStr}${capitalize(spawn.pokeName)}** with a **${ballName}**!`,
          embeds: [new EmbedBuilder()
            .setColor(typeColour)
            .setTitle(`🎉 Gotcha! ${shinyStr}${capitalize(spawn.pokeName)} was caught!`)
            .setDescription(
              `**Caught by:** ${i.user.displayName}\n` +
              `**Ball used:** ${ballEmoji} ${ballName}\n` +
              `**Level:** ${spawn.level}\n` +
              `**Type:** ${spawn.types.map(t => `${TYPE_EMOJI[t] || ''}${capitalize(t)}`).join(' / ')}\n\n` +
              `🪙 **+1 LP** · 💰 **+20 Dinar**\n` +
              `Use \`/pokemon-team\` to see your Pokémon!` +
              streakMsg
            )
            .setThumbnail(spawn.spriteUrl || null)],
          components: [disabledButtons()],
        }).catch(() => {});

      } else {
        // Failed catch
        const shakes = `💫 ${i.user.displayName} threw a **${ballName}**... Oh no! The Pokémon broke free!`;
        const updatedEmbed = spawnEmbed(spawn.hp, spawn.maxHp, spawn.pokeName, spawn.types, spawn.spriteUrl, spawn.isShiny, spawn.level, spawn.speciesCatchRate);
        updatedEmbed.setDescription(
          updatedEmbed.data.description + `\n\n${shakes}`
        );
        await spawn.message.edit({
          embeds: [updatedEmbed],
          components: catchRows(ballsLeft, memberData),
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

function battleMoveButtons(pokemon, potionsLeft, memberData) {
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

  // Build item/forfeit row
  const actionButtons = [];

  // Basic potion (built-in, 2 per battle)
  actionButtons.push(
    new ButtonBuilder()
      .setCustomId('battle_potion')
      .setLabel(`🧪 Potion (${potionsLeft})`)
      .setStyle(ButtonStyle.Success)
      .setDisabled(potionsLeft <= 0)
  );

  // Super Potion from inventory
  const superCount = memberData ? countItem(memberData, 'super_potion') : 0;
  if (superCount > 0) {
    actionButtons.push(
      new ButtonBuilder()
        .setCustomId('battle_super_potion')
        .setLabel(`🧪 Super Potion (${superCount})`)
        .setStyle(ButtonStyle.Success)
    );
  }

  // Hyper Potion from inventory
  const hyperCount = memberData ? countItem(memberData, 'hyper_potion') : 0;
  if (hyperCount > 0) {
    actionButtons.push(
      new ButtonBuilder()
        .setCustomId('battle_hyper_potion')
        .setLabel(`💊 Hyper Potion (${hyperCount})`)
        .setStyle(ButtonStyle.Success)
    );
  }

  actionButtons.push(
    new ButtonBuilder()
      .setCustomId('battle_forfeit')
      .setLabel('🏳️ Forfeit')
      .setStyle(ButtonStyle.Danger)
  );

  rows.push(new ActionRowBuilder().addComponents(...actionButtons.slice(0, 5)));

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

    } else if (moveNameOrAction === 'super_potion') {
      const actualUserId  = userId;  // clicker is already the real Discord user
      const userData      = getMemberPokemon(db, battle.guildId, actualUserId);
      if (!useItem(userData, 'super_potion')) return null;
      saveData();
      const heal          = ITEMS.super_potion.healAmount;
      attacker.currentHp  = Math.min(attacker.maxHp, attacker.currentHp + heal);
      logEntry = `🧪 **${atkName}** used a Super Potion! **${capitalize(attacker.name)}** restored **${heal} HP**.`;

    } else if (moveNameOrAction === 'hyper_potion') {
      const actualUserId  = userId;  // clicker is already the real Discord user
      const userData      = getMemberPokemon(db, battle.guildId, actualUserId);
      if (!useItem(userData, 'hyper_potion')) return null;
      saveData();
      const heal          = ITEMS.hyper_potion.healAmount;
      attacker.currentHp  = Math.min(attacker.maxHp, attacker.currentHp + heal);
      logEntry = `💊 **${atkName}** used a Hyper Potion! **${capitalize(attacker.name)}** restored **${heal} HP**.`;

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

module.exports = function initPokemon({ client, db, saveData, getGuildClans, getUserClan, awardLP }) {

  // ─── State variables ──────────────────────────────────────────────────────
  const activeDrops = {};   // { channelId: { itemId, messageId, expiresAt } }
  const dropTimers  = {};   // { channelId: timeoutId }

  // ─── startSpawnTimers: called by index.js after MongoDB data is loaded ────────
  // This must NOT be called from clientReady inside pokemon.js because db will
  // still be empty at that point — loadData() in index.js hasn't finished yet.

  // ─── Persistent daily spawn scheduler ───────────────────────────────────────
  // Random spawn/drop times for the day are stored in the DB, so they survive
  // restarts/redeploys. A 1-minute tick fires any times that are due and marks them
  // 'fired' — so updating the bot never resets the schedule or double-spawns.

  function libyaDayInfo(nowMs) {
    const lib = new Date(nowMs + LIBYA_OFFSET_MS);
    const y = lib.getUTCFullYear(), mo = lib.getUTCMonth(), d = lib.getUTCDate();
    const startOfDayUTC = Date.UTC(y, mo, d) - LIBYA_OFFSET_MS;   // 00:00 Libya, in UTC ms
    const dateStr = `${y}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    return { dateStr, startOfDayUTC };
  }

  // Pick `count` random times in [startMs, endMs] with at least `minGapMs` between them.
  function pickTimes(startMs, endMs, count, minGapMs) {
    const windowMs = endMs - startMs;
    if (windowMs <= 0 || count <= 0) return [];
    let gap = minGapMs;
    if (windowMs - (count - 1) * gap < 0) gap = Math.floor(windowMs / count);   // shrink gap if the window is tight
    const free = Math.max(0, windowMs - (count - 1) * gap);
    const offsets = [];
    for (let i = 0; i < count; i++) offsets.push(Math.random() * free);
    offsets.sort((a, b) => a - b);
    return offsets.map((o, i) => Math.round(startMs + o + i * gap));   // sorted, guaranteed ≥ gap apart
  }

  // Ensure today's schedule exists; (re)generate on each new Libya day.
  function ensureSchedule(guildId, nowMs) {
    const data = db[guildId];
    if (!data) return null;
    const { dateStr, startOfDayUTC } = libyaDayInfo(nowMs);
    if (!data.__pokeSched || data.__pokeSched.date !== dateStr) {
      const winStart = startOfDayUTC + SPAWN_WINDOW_START * 3600 * 1000;
      const winEnd   = startOfDayUTC + SPAWN_WINDOW_END   * 3600 * 1000;
      const effStart = Math.max(winStart, nowMs);          // if first run is mid-day, schedule only the remaining window
      let spawns = [], drops = [];
      if (winEnd - effStart > 5 * 60 * 1000) {              // at least 5 min of today's window left
        spawns = pickTimes(effStart, winEnd, SPAWNS_PER_DAY, MIN_GAP_MS).map(at => ({ at, fired: false }));
        drops  = pickTimes(effStart, winEnd, DROPS_PER_DAY,  MIN_GAP_MS).map(at => ({ at, fired: false }));
      }
      data.__pokeSched = { date: dateStr, spawns, drops };
      saveData(guildId);
      const fmt = (a) => a.length ? a.map(s => new Date(s.at).toISOString().slice(11, 16)).join(', ') : '(none today)';
      console.log(`🗓️ Pokémon schedule ${dateStr} (guild ${guildId}) — spawns ${fmt(spawns)} | drops ${fmt(drops)} UTC`);
    }
    return data.__pokeSched;
  }

  // Resolve a clan's spawn channel (cache → fetch); clear only genuinely-deleted ones.
  async function resolveClanChannel(guild, clan) {
    if (!clan.channelId) return null;
    const cached = guild.channels.cache.get(clan.channelId);
    if (cached) return cached;
    try { return await guild.channels.fetch(clan.channelId); }
    catch (e) {
      if (e && (e.code === 10003 || e.status === 404)) { clan.channelId = null; saveData(guild.id); }
      return null;   // transient errors keep the channelId so it can resume later
    }
  }

  async function runScheduledSpawn(guildId) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return;
    const gc = getGuildClans(guildId);
    for (const [k, clan] of Object.entries(gc)) {
      if (k.startsWith('__') || !clan.channelId || clan.pokemonDisabled) continue;
      const channel = await resolveClanChannel(guild, clan);
      if (channel) await triggerSpawn(channel, db, saveData, getGuildClans, getUserClan, awardLP);
    }
  }

  async function runScheduledDrop(guildId) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return;
    const gc = getGuildClans(guildId);
    for (const [k, clan] of Object.entries(gc)) {
      if (k.startsWith('__') || !clan.channelId || clan.pokemonDisabled) continue;
      const channel = await resolveClanChannel(guild, clan);
      if (channel) await triggerDrop(channel);
    }
  }

  // Every minute: fire any due spawn/drop. At most one of each per guild per tick, so
  // if the bot was down through several scheduled times they spread out instead of bunching.
  async function scheduleTick(nowOverride, executors) {
    const now = nowOverride || Date.now();
    const fireSpawn = (executors && executors.spawn) || runScheduledSpawn;
    const fireDrop  = (executors && executors.drop)  || runScheduledDrop;
    for (const guild of client.guilds.cache.values()) {
      const gc = getGuildClans(guild.id);
      const hasChannel = Object.entries(gc).some(([k, c]) => !k.startsWith('__') && c.channelId);
      if (!hasChannel) continue;
      const sched = ensureSchedule(guild.id, now);
      if (!sched) continue;

      const dueSpawn = sched.spawns.find(s => !s.fired && s.at <= now);
      if (dueSpawn) {
        dueSpawn.fired = true; saveData(guild.id);          // mark BEFORE firing so a redeploy can't double-spawn
        Promise.resolve(fireSpawn(guild.id)).catch(e => console.error('[poke spawn]', e.message));
      }
      const dueDrop = sched.drops.find(s => !s.fired && s.at <= now);
      if (dueDrop) {
        dueDrop.fired = true; saveData(guild.id);
        Promise.resolve(fireDrop(guild.id)).catch(e => console.error('[poke drop]', e.message));
      }
    }
  }

  async function startSpawnTimers() {
    setTimeout(async () => {
      for (const guild of client.guilds.cache.values()) { try { await guild.channels.fetch(); } catch {} }
      await scheduleTick();                                  // catch up anything already due
      setInterval(() => { scheduleTick().catch(e => console.error('[poke tick]', e.message)); }, SCHED_TICK_MS);
      console.log('🗓️ Pokémon scheduler started — persistent daily schedule, checked every minute.');
    }, 3000);
  }
  // ─── Interaction handler ────────────────────────────────────────────────────

  client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    if (!interaction.commandName.startsWith('pokemon') && interaction.commandName !== 'pokedex') return;
    if (!interaction.guild) {
      await interaction.reply({ content: '❌ These commands only work inside a Discord server.', flags: 64 }).catch(() => {});
      return;
    }
    const { commandName, user, guild } = interaction;
    console.log(`📩 Pokemon command: /${commandName} from ${user.tag} in ${guild.name}`);

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
            await triggerSpawn(targetChannel, db, saveData, getGuildClans, getUserClan, awardLP);
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

    // ── /pokemon-claim ─────────────────────────────────────────────────────
    if (commandName === 'pokemon-claim') {
      const channelId = interaction.channelId;
      const drop = activeDrops[channelId];

      if (!drop) {
        return safeReplyPoke(interaction, { content: '❌ There is no active item drop in this channel right now.', flags: 64 });
      }
      if (Date.now() > drop.expiresAt) {
        delete activeDrops[channelId];
        return safeReplyPoke(interaction, { content: '❌ That drop has already expired.', flags: 64 });
      }

      // Verify user is in the clan that owns this channel
      const gc = getGuildClans(guild.id);
      let channelClanForDrop = null;
      for (const [__k, clan] of Object.entries(gc)) { if (__k.startsWith("__")) continue;
        if (clan.channelId === channelId) { channelClanForDrop = clan; break; }
      }
      if (channelClanForDrop) {
        const inClan = channelClanForDrop.leader === user.id ||
          (channelClanForDrop.officers || []).includes(user.id) ||
          (channelClanForDrop.members  || []).includes(user.id);
        if (!inClan) {
          return safeReplyPoke(interaction, { content: '❌ Only members of this clan can claim drops!', flags: 64 });
        }
      }

      const itemId  = drop.itemId;
      const item    = ITEMS[itemId];
      delete activeDrops[channelId];

      // Special handling for honey — activate immediately
      if (itemId === 'honey') {
        if (channelClanForDrop) {
          channelClanForDrop.honeyActiveUntil = Date.now() + HONEY_DURATION_MS;
          saveData();
        }
        return safeReplyPoke(interaction, {
          embeds: [new EmbedBuilder()
            .setColor(0xFFD700)
            .setTitle(`🍯 Honey Claimed!`)
            .setDescription(
              `<@${user.id}> claimed the **Honey**!\n\n` +
              `🍯 Rare Pokémon are now attracted to this channel for the next **12 hours!**\n` +
              `Higher rarity spawns will appear more frequently.`
            )]
        });
      }

      // Add item to inventory
      addItem(memberData, itemId);
      saveData();

      return safeReplyPoke(interaction, {
        embeds: [new EmbedBuilder()
          .setColor(0xFFD700)
          .setTitle(`${item.emoji} Item Claimed!`)
          .setDescription(
            `<@${user.id}> claimed **${item.name}**!\n\n` +
            `*${item.description}*\n\n` +
            `${item.type === 'ball' ? 'It will appear as a button option during wild Pokémon encounters.' : 'It will appear as a button option during battles.'}\n` +
            `Use \`/pokemon-bag\` to check your items.`
          )]
      });
    }

    // ── /pokemon-bag ───────────────────────────────────────────────────────
    if (commandName === 'pokemon-bag') {
      const items = memberData.items || {};
      const keys  = Object.keys(items).filter(k => items[k] > 0);

      if (keys.length === 0) {
        return safeReplyPoke(interaction, {
          content: '🎒 Your bag is empty! Claim item drops in your clan channel.',
          flags: 64,
        });
      }

      const desc = keys.map(k => {
        const item = ITEMS[k];
        if (!item) return null;
        return `${item.emoji} **${item.name}** ×${items[k]}\n   *${item.description}*`;
      }).filter(Boolean).join('\n\n');

      return safeReplyPoke(interaction, {
        embeds: [new EmbedBuilder()
          .setColor(0xFFD700)
          .setTitle(`🎒 ${user.displayName}'s Bag`)
          .setDescription(desc)
          .setFooter({ text: 'Items are used automatically via buttons during encounters and battles.' })],
        flags: 64,
      });
    }

    // ── /pokemon-view ──────────────────────────────────────────────────────
    if (commandName === 'pokemon-view') {
      const target     = interaction.options.getUser('user');
      const targetData = getMemberPokemon(db, guild.id, target.id);
      const pokemon    = targetData.pokemon;

      if (pokemon.length === 0) {
        return safeReplyPoke(interaction, {
          content: `📭 **${target.displayName}** hasn't caught any Pokémon yet.`,
          flags: 64,
        });
      }

      let targetMember;
      try { targetMember = await guild.members.fetch(target.id); } catch {}
      const displayName = targetMember?.displayName || target.username;

      const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle(`🎒 ${displayName}'s Pokémon (${pokemon.length}/${MAX_POKEMON})`)
        .setDescription(
          pokemon.map((p, idx) => {
            const shiny = p.isShiny ? '✨' : '';
            const name  = p.nickname ? `**${p.nickname}** *(${capitalize(p.name)})*` : `**${capitalize(p.name)}**`;
            const types = p.types.map(t => `${TYPE_EMOJI[t] || ''}${capitalize(t)}`).join('/');
            return `\`${String(idx + 1).padStart(2, '0')}\` ${shiny}${name} • Lv.${p.level} • ${types} • Wins: ${p.battleWins || 0}`;
          }).join('\n')
        )
        .setFooter({ text: `Total battle wins: ${targetData.battleWins || 0}` });

      return safeReplyPoke(interaction, { embeds: [embed] });
    }

    // ── /pokemon-stats ─────────────────────────────────────────────────────
    if (commandName === 'pokemon-stats') {
      const slot    = interaction.options.getInteger('slot') - 1;
      const pokemon = memberData.pokemon;

      if (slot < 0 || slot >= pokemon.length) {
        return safeReplyPoke(interaction, { content: `❌ Invalid slot. You have ${pokemon.length} Pokémon.`, flags: 64 });
      }

      const p       = pokemon[slot];
      const name    = p.nickname ? `${p.nickname} (${capitalize(p.name)})` : capitalize(p.name);
      const shiny   = p.isShiny ? ' ✨ SHINY' : '';
      const types   = p.types.map(t => `${TYPE_EMOJI[t] || ''}${capitalize(t)}`).join(' / ');
      const xpPct   = Math.min(100, Math.floor((p.xp / p.xpToNext) * 100));
      const xpFilled = Math.round(xpPct / 10);
      const xpBar   = '🟦'.repeat(xpFilled) + '⬛'.repeat(10 - xpFilled);

      const moves = p.moves.map(m =>
        `${TYPE_EMOJI[m.type] || ''}**${capitalize(m.name)}** — Power: ${m.power} | PP: ${m.pp}/${m.maxPp} | Type: ${capitalize(m.type)}`
      ).join('\n');

      const embed = new EmbedBuilder()
        .setColor(TYPE_COLOURS[p.types[0]] || 0x5865F2)
        .setTitle(`${shiny} ${name} — Detailed Stats`)
        .addFields(
          { name: '🏷️ Info',        value: `Type: ${types}\nLevel: **${p.level}**\nShiny: ${p.isShiny ? 'Yes ✨' : 'No'}`, inline: true },
          { name: '🏆 Battle',      value: `Wins: **${p.battleWins || 0}**\nCaught by: <@${p.caughtBy}>`,                   inline: true },
          { name: '❤️ HP',          value: `${hpBar(p.currentHp, p.maxHp)} ${p.currentHp}/${p.maxHp}`,                     inline: false },
          { name: '📈 XP Progress', value: `${xpBar} ${p.xp}/${p.xpToNext} (${xpPct}%)`,                                   inline: false },
          { name: '⚔️ Attack',      value: `${p.attack}`,        inline: true },
          { name: '🛡️ Defence',     value: `${p.defense}`,       inline: true },
          { name: '✨ Sp. Atk',     value: `${p.specialAttack}`, inline: true },
          { name: '💨 Speed',       value: `${p.speed}`,         inline: true },
          { name: '🎯 Moves',       value: moves || 'None',      inline: false },
        );

      if (p.spriteUrl) embed.setThumbnail(p.spriteUrl);
      return safeReplyPoke(interaction, { embeds: [embed], flags: 64 });
    }
  } // end handlePokemonCommand

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

        const rows = battleMoveButtons(currentPoke, potionsLeft, getMemberPokemon(db, battle.guildId, battle.currentTurnUserId));

        const msg = await channel.send({
          content: `<@${battle.currentTurnUserId}> — it's your turn!`,
          embeds: [currentEmbed],
          components: rows,
        }).catch(() => null);

        if (!msg) break;

        const result = await new Promise(resolve => {
          const col = msg.createMessageComponentCollector({
            filter: i => i.user.id === battle.currentTurnUserId,
            time: BATTLE_TIMEOUT_MS,
            max: 1,
          });

          col.on('collect', async i => {
            await i.deferUpdate().catch(() => {});
            const customId = i.customId;
            if (customId === 'battle_potion')        resolve('potion');
            else if (customId === 'battle_super_potion') resolve('super_potion');
            else if (customId === 'battle_hyper_potion') resolve('hyper_potion');
            else if (customId === 'battle_forfeit')   resolve('forfeit');
            else if (customId.startsWith('battle_move_')) resolve(customId.replace('battle_move_', ''));
            else resolve(null);
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
                `🎉 **${winnerName}** wins the battle — **+15 LP** and **+75 Dinar** 💰!\n` +
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
      const winnerActual  = winnerIsP1 ? battle.p1UserId : battle.p2UserId;
      const loserActual   = winnerIsP1 ? battle.p2UserId : battle.p1UserId;
      const winnerSlot    = winnerIsP1 ? battle.p1SlotIndex    : battle.p2SlotIndex;
      const loserSlot     = winnerIsP1 ? battle.p2SlotIndex    : battle.p1SlotIndex;
      const winnerPoke    = winnerIsP1 ? battle.p1Pokemon      : battle.p2Pokemon;
      const loserPoke     = winnerIsP1 ? battle.p2Pokemon      : battle.p1Pokemon;

      const winnerData = getMemberPokemon(db, battle.guildId, winnerActual);
      const loserData  = getMemberPokemon(db, battle.guildId, loserActual);

      if (reason === 'win' || reason === 'forfeit') {
        if (winnerData.pokemon[winnerSlot]) {
          const { xpGain, levelled } = await awardBattleXp(winnerData.pokemon[winnerSlot], true);
          winnerData.battleWins = (winnerData.battleWins || 0) + 1;
          winnerData.pokemon[winnerSlot].battleWins = (winnerData.pokemon[winnerSlot].battleWins || 0) + 1;
          if (awardLP) awardLP(battle.guildId, winnerActual, 15, 'pokemon');
          const dinarGot = awardDinar(db, battle.guildId, winnerActual, 75, saveData, 'battle');
          if (isAtDinarCap(db, battle.guildId, 'battle', winnerActual)) {
            const who = guild?.members?.cache?.get(winnerActual)?.displayName
                     || winnerData?.username || `<@${winnerActual}>`;
            await channel.send(`⚠️ **${who}** has reached today's battle limit of **${dinarDailyCap('battle')} Dinar** (anti-farming). Battle wins won't earn Dinar again until tomorrow — wins and XP still count, and catching, daily, Ya Rayt and POTD still pay!`).catch(() => {});
          }
          if (levelled) {
            await channel.send(`⬆️ **${capitalize(winnerData.pokemon[winnerSlot].name)}** levelled up to **Lv.${winnerData.pokemon[winnerSlot].level}**!`).catch(() => {});
          }
          await channel.send(`⭐ **${capitalize(winnerPoke.name)}** gained **${xpGain} XP**!`).catch(() => {});
        }
        if (loserData.pokemon[loserSlot]) {
          const { xpGain } = await awardBattleXp(loserData.pokemon[loserSlot], false);
          if (awardLP) awardLP(battle.guildId, loserActual, 3, 'pokemon');
          await channel.send(`⭐ **${capitalize(loserPoke.name)}** gained **${xpGain} XP** and the trainer earns **+3 LP** for participating!`).catch(() => {});
        }
      }

      saveData();
      console.log(`✅ Battle ended — winner: ${winnerActual}, slot: ${winnerSlot}, wins now: ${winnerData.battleWins}`);

    } catch (err) {
      console.error('endBattle error:', err);
    } finally {
      delete activeBattles[`${battle.guildId}_${battle.p1UserId}`];
      delete activeBattles[`${battle.guildId}_${battle.p2UserId}`];
    }
  }

  // ─── Item Drop System ─────────────────────────────────────────────────────

  function scheduleNextDrop(channel) {
    // No-op: replaced by the persistent daily schedule (see scheduleTick).
  }

  async function triggerDrop(channel) {
    // Respect a clan's opt-out: skip item drops if this channel's clan disabled
    // Pokémon, but keep the timer ticking so it resumes if they re-enable.
    const ownerClan = clanForChannel(getGuildClans, channel);
    if (ownerClan && ownerClan.pokemonDisabled) {
      scheduleNextDrop(channel);
      return;
    }
    if (activeDrops[channel.id]) {
      scheduleNextDrop(channel);
      return;
    }
    try {
      const itemId = randomDrop();
      const item   = ITEMS[itemId];
      const expiry = Date.now() + DROP_EXPIRE_MS;

      const embed = new EmbedBuilder()
        .setColor(0xFFD700)
        .setTitle(`🎁 Item Drop!`)
        .setDescription(
          `**${item.emoji} ${item.name}** has appeared in the channel!\n\n` +
          `*${item.description}*\n\n` +
          `Use \`/pokemon-claim\` to claim it! First come, first served.\n` +
          `⏰ Expires in **30 minutes**.\n\n` +
          `-# Not into Pokémon? A clan Leader or Officer can turn spawns & item drops off here with \`/clan-pokemon off\``
        )
        .setFooter({ text: 'Only one player can claim this!' });

      let msg;
      try {
        msg = await channel.send({ embeds: [embed] });
      } catch (err) {
        if (err.code === 10003) {
          // Channel deleted
          const gc = getGuildClans(channel.guild?.id || '');
          for (const [__k, clan] of Object.entries(gc)) { if (__k.startsWith("__")) continue;
            if (clan.channelId === channel.id) { clan.channelId = null; saveData(); break; }
          }
          return;
        }
        throw err;
      }

      activeDrops[channel.id] = { itemId, messageId: msg.id, expiresAt: expiry };

      // Auto-expire
      setTimeout(async () => {
        if (!activeDrops[channel.id] || activeDrops[channel.id].messageId !== msg.id) return;
        delete activeDrops[channel.id];
        try {
          await msg.edit({
            embeds: [new EmbedBuilder()
              .setColor(0x888888)
              .setTitle('🎁 Item Drop Expired')
              .setDescription(`The **${item.emoji} ${item.name}** was not claimed in time and disappeared.`)]
          });
        } catch {}
        scheduleNextDrop(channel);
      }, DROP_EXPIRE_MS);

      scheduleNextDrop(channel);
    } catch (err) {
      console.error('Drop error:', err.message);
      scheduleNextDrop(channel);
    }
  }

  // ─── Watch for new clan channels being created ────────────────────────────

  client.on('channelCreate', channel => {
    setTimeout(() => {
      try {
        if (!channel.guild) return;
        const gc = getGuildClans(channel.guild.id);
        for (const [__k, clan] of Object.entries(gc)) { if (__k.startsWith("__")) continue;
          if (clan.channelId === channel.id) {
            console.log(`🌿 New clan channel detected — scheduling spawns for #${channel.name}`);
            scheduleNextSpawn(channel, db, saveData, getGuildClans, getUserClan, awardLP);
            scheduleNextDrop(channel);
            break;
          }
        }
      } catch {}
    }, 2000);
  });

  // Allow index.js to (re)start spawns for a specific channel — used by /clan-channel-link.
  function scheduleSpawnFor(channel) {
    if (!channel || !channel.guild) return;
    ensureSchedule(channel.guild.id, Date.now());   // make sure today's persistent schedule exists
    // give immediate feedback that the channel is live, then it follows the daily schedule
    triggerSpawn(channel, db, saveData, getGuildClans, getUserClan, awardLP).catch(() => {});
  }

  return { startSpawnTimers, scheduleSpawnFor, _sched: { ensureSchedule, scheduleTick, pickTimes, libyaDayInfo } };

};
