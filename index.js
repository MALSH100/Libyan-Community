// ═══════════════════════════════════════════════════════════════════════════════
// CLAN BOT v7
// Role system: 3 Discord roles per clan
//   Power — Leader   (leader only)
//   Power — Officer  (officers)
//   Power — Member   (regular members)
// Roles swap automatically on promote/demote/transfer/leave/kick
// /clan-ranks renames all 3 Discord roles at once
// /clan-rename updates the clan name prefix on all 3 roles
// ═══════════════════════════════════════════════════════════════════════════════

const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes,
  EmbedBuilder,
  PermissionFlagsBits,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
} = require('discord.js');

const fs   = require('fs');
const path = require('path');

// ─── Safe reply helpers ───────────────────────────────────────────────────────

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
    if (!interaction.replied && !interaction.deferred) {
      await interaction.deferReply(opts);
    }
  } catch (err) {
    console.error('safeDefer failed:', err.message);
  }
}

// ─── Persistent Storage ───────────────────────────────────────────────────────

const DATA_FILE = path.join(__dirname, 'clans.json');

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    console.error('⚠️  Could not load clans.json, starting fresh:', e.message);
  }
  return {};
}

function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), 'utf8');
  } catch (e) {
    console.error('⚠️  Could not save clans.json:', e.message);
  }
}

let db = loadData();

function getGuildClans(guildId) {
  if (!db[guildId]) db[guildId] = {};
  // Return a proxy view that excludes internal keys like __pokemon
  const raw = db[guildId];
  return new Proxy(raw, {
    ownKeys(target) {
      return Object.keys(target).filter(k => !k.startsWith('__'));
    },
    getOwnPropertyDescriptor(target, key) {
      if (key.startsWith('__')) return undefined;
      return Object.getOwnPropertyDescriptor(target, key);
    },
  });
}

function getUserClan(guildId, userId) {
  try {
    const gc = getGuildClans(guildId);
    for (const [name, clan] of Object.entries(gc)) {
      if (
        clan.leader === userId ||
        (clan.officers || []).includes(userId) ||
        (clan.members  || []).includes(userId)
      ) return { name, clan };
    }
  } catch (e) { console.error('getUserClan error:', e.message); }
  return null;
}

function getUserRank(clan, userId) {
  if (!clan) return null;
  if (clan.leader === userId)                 return 'Leader';
  if ((clan.officers || []).includes(userId)) return 'Officer';
  if ((clan.members  || []).includes(userId)) return 'Member';
  return null;
}

function rankLabel(clan, rank) {
  const n = (clan && clan.rankNames) || {};
  if (rank === 'Leader')  return n.leader  || 'Leader';
  if (rank === 'Officer') return n.officer || 'Officer';
  if (rank === 'Member')  return n.member  || 'Member';
  return rank;
}

function normaliseClan(clan) {
  if (!clan) return clan;
  clan.officers     = clan.officers     || [];
  clan.members      = clan.members      || [];
  clan.description  = clan.description  || 'No description set.';
  clan.motto        = clan.motto        || '';
  clan.xp           = clan.xp           || 0;
  clan.wins         = clan.wins         || 0;
  clan.losses       = clan.losses       || 0;
  clan.channelId    = clan.channelId    || null;
  clan.emoji        = clan.emoji        || '⚔️';
  clan.rankNames    = clan.rankNames    || { leader: 'Leader', officer: 'Officer', member: 'Member' };
  clan.leaderRoleId = clan.leaderRoleId || clan.roleId || null; // backwards compat
  clan.officerRoleId= clan.officerRoleId|| null;
  clan.memberRoleId = clan.memberRoleId || clan.roleId || null; // backwards compat
  return clan;
}

// Helper: build a role name from clan name and rank label
// Format: Power — Leader / Power — Officer / Power — Member
function buildRoleName(clanName, rankTitle) {
  return `${clanName} — ${rankTitle}`;
}

// Helper: assign the correct rank role to a member, removing any old rank roles
async function assignRankRole(guild, clan, userId, newRank) {
  try {
    const member     = await guild.members.fetch(userId);
    const leaderRole = guild.roles.cache.get(clan.leaderRoleId);
    const offRole    = guild.roles.cache.get(clan.officerRoleId);
    const memRole    = guild.roles.cache.get(clan.memberRoleId);

    // Remove all three rank roles first
    const toRemove = [leaderRole, offRole, memRole].filter(Boolean);
    for (const role of toRemove) await member.roles.remove(role).catch(() => {});

    // Assign the correct one
    if (newRank === 'Leader'  && leaderRole) await member.roles.add(leaderRole).catch(() => {});
    if (newRank === 'Officer' && offRole)    await member.roles.add(offRole).catch(() => {});
    if (newRank === 'Member'  && memRole)    await member.roles.add(memRole).catch(() => {});
  } catch (e) {
    console.error(`assignRankRole failed for ${userId}:`, e.message);
  }
}

// ─── State ────────────────────────────────────────────────────────────────────

const activeWars     = {};
const pendingInvites = {};
const xpCooldowns    = {};
const XP_PER_MSG     = 2;
const XP_COOLDOWN    = 60_000;

// ─── Word Lists ───────────────────────────────────────────────────────────────

const WORD_LIST = [
  'dragon','castle','knight','shield','battle','quest','legend','throne',
  'armour','conquest','warrior','empire','victory','honour','glory',
  'elephant','giraffe','penguin','dolphin','cheetah','leopard','panther',
  'gorilla','hamster','lobster','octopus','parrot','rabbit','salmon','turtle',
  'banana','orange','cherry','mango','pizza','burger','noodle','waffle',
  'biscuit','brownie','pancake','pretzel','sandwich','yogurt','cookie',
  'blanket','candle','compass','helmet','jacket','lantern','mirror',
  'pillow','puzzle','rocket','saddle','sponge','trophy','umbrella','wallet',
  'airport','bridge','canyon','desert','forest','harbour','island',
  'jungle','market','museum','palace','stadium','temple','tunnel','valley',
  'balance','capture','collect','destroy','explore','journey','kingdom',
  'mystery','phantom','silence','survive','thunder','vintage','whisper','zigzag',
  'battery','browser','channel','digital','gateway','monitor','network',
  'podcast','scanner','storage','upgrade','website','android','keypad','router',
];

const TYPE_WORDS = [
  'fire','wind','star','moon','gold','iron','wolf','hawk','bear','fox',
  'lion','eagle','storm','blaze','swift','brave','sharp','proud','steel','flame',
  'frost','stone','river','ocean','cloud','light','force','power','speed','blade',
  'arena','clash','crown','quest','realm','reign','siege','vault','forge','titan',
  'spark','crest','valor','lance','flare','ridge','surge','pulse','orbit','nexus',
];

// ─── Utility ─────────────────────────────────────────────────────────────────

function scramble(word) {
  const arr = word.split('');
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  const out = arr.join('');
  return out === word ? scramble(word) : out;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function makeMissingLetters(word) {
  // Reveal ~2/3 of letters — easier than before
  const indices = shuffle([...Array(word.length).keys()]);
  const reveal  = Math.max(Math.floor((word.length * 2) / 3), word.length - 2);
  const shown   = new Set(indices.slice(0, reveal));
  return word.split('').map((ch, i) => shown.has(i) ? ch : '_').join(' ');
}

function rollDie() {
  return Math.floor(Math.random() * 6) + 1;
}

// ─── Maths question generator ─────────────────────────────────────────────────
// Returns 8 questions that progress from easy to hard
// Numbers are randomised each call so games are never identical

function generateMathsQuestions() {
  const q = [];

  // R1: Easy addition (2-digit + 2-digit, no carry)
  const a1 = Math.floor(Math.random() * 30) + 10;
  const b1 = Math.floor(Math.random() * 30) + 10;
  q.push({ q: `${a1} + ${b1} = ?`, a: String(a1 + b1) });

  // R2: Harder addition (3-digit + 3-digit)
  const a2 = Math.floor(Math.random() * 400) + 100;
  const b2 = Math.floor(Math.random() * 400) + 100;
  q.push({ q: `${a2} + ${b2} = ?`, a: String(a2 + b2) });

  // R3: Easy subtraction (2-digit from 2-digit, positive result)
  const a3 = Math.floor(Math.random() * 40) + 50;
  const b3 = Math.floor(Math.random() * 30) + 10;
  q.push({ q: `${a3} - ${b3} = ?`, a: String(a3 - b3) });

  // R4: Harder subtraction (3-digit from 3-digit)
  const a4 = Math.floor(Math.random() * 300) + 400;
  const b4 = Math.floor(Math.random() * 200) + 100;
  q.push({ q: `${a4} - ${b4} = ?`, a: String(a4 - b4) });

  // R5: Multiplication (teens × teens)
  const a5 = Math.floor(Math.random() * 7) + 11; // 11–17
  const b5 = Math.floor(Math.random() * 7) + 11;
  q.push({ q: `${a5} × ${b5} = ?`, a: String(a5 * b5) });

  // R6: Harder multiplication (2-digit × 2-digit, larger numbers)
  const a6 = Math.floor(Math.random() * 15) + 18; // 18–32
  const b6 = Math.floor(Math.random() * 15) + 18;
  q.push({ q: `${a6} × ${b6} = ?`, a: String(a6 * b6) });

  // R7: Division — generate cleanly divisible pairs
  const divisors7 = [12, 15, 16, 18, 20, 24, 25];
  const d7 = divisors7[Math.floor(Math.random() * divisors7.length)];
  const mult7 = Math.floor(Math.random() * 8) + 12; // result 12–19
  const a7 = d7 * mult7;
  q.push({ q: `${a7} ÷ ${d7} = ?`, a: String(mult7) });

  // R8: Hard division — larger numbers, clean result
  const divisors8 = [16, 18, 24, 32, 36, 48];
  const d8 = divisors8[Math.floor(Math.random() * divisors8.length)];
  const mult8 = Math.floor(Math.random() * 20) + 20; // result 20–39
  const a8 = d8 * mult8;
  q.push({ q: `${a8} ÷ ${d8} = ?`, a: String(mult8) });

  return q;
}

// ─── opentdb Trivia fetch ─────────────────────────────────────────────────────

async function fetchTriviaQuestions(amount = 8, difficulty = 'easy') {
  try {
    const url  = `https://opentdb.com/api.php?amount=${amount}&difficulty=${difficulty}&type=multiple&encode=url3986`;
    const res  = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const data = await res.json();
    if (data.response_code !== 0 || !data.results?.length) return null;
    return data.results.map(item => {
      const question   = decodeURIComponent(item.question);
      const correct    = decodeURIComponent(item.correct_answer);
      const incorrects = item.incorrect_answers.map(a => decodeURIComponent(a));
      const options    = shuffle([correct, ...incorrects]);
      return { q: question, options, correct, a: correct.toLowerCase() };
    });
  } catch (e) {
    console.error('opentdb fetch failed:', e.message);
    return null;
  }
}

// ─── Game Menu ────────────────────────────────────────────────────────────────

const GAME_MENU = [
  { num: 1, name: '🧠 Trivia',           desc: '8 multiple-choice questions from the internet. Type A/B/C/D to answer.' },
  { num: 2, name: '🔤 Anagrams',         desc: '8 scrambled words. Unscramble and type the word first to win.' },
  { num: 3, name: '🎲 Dice Battle',      desc: '3 dice per clan. Each player keeps or rerolls once. Highest total wins. Best of 5 rounds.' },
  { num: 4, name: '💬 Type the Word',    desc: 'Bot shows a word — type it first to score. 8 rounds.' },
  { num: 5, name: '🔢 Guess the Number', desc: 'Bot picks 1–100. One guess per player, locked in. Closest clan average wins.' },
  { num: 6, name: '🔡 Missing Letters',  desc: 'Fill in the blanks: _ p p _ e. Type the full word first. 8 rounds.' },
  { num: 7, name: '💣 Hidden Bomb',      desc: 'Clan leader picks 1–10 per round. One number is the bomb. Best of 5 rounds.' },
  { num: 8, name: '➕ Maths Quiz',       desc: '8 maths questions, easy to hard (addition → subtraction → × → ÷). Lock in your answer.' },
];

// ─── Discord Client ───────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
});

// ─── Command Definitions ──────────────────────────────────────────────────────

const commands = [
  new SlashCommandBuilder().setName('clan-commands').setDescription('View all clan bot commands'),
  new SlashCommandBuilder().setName('clan-info').setDescription('View details about a clan')
    .addStringOption(o => o.setName('name').setDescription('Clan name — leave blank for your own').setRequired(false)),
  new SlashCommandBuilder().setName('clan-list').setDescription('List all clans on this server'),
  new SlashCommandBuilder().setName('clan-xp').setDescription('View the clan XP leaderboard'),

  new SlashCommandBuilder().setName('clan-create').setDescription('Create a new clan — you become the Leader')
    .addStringOption(o => o.setName('name').setDescription('Clan name (max 30 chars)').setRequired(true))
    .addStringOption(o => o.setName('description').setDescription('Short description').setRequired(false)),

  new SlashCommandBuilder().setName('clan-disband').setDescription('Disband your clan (Leader only)'),

  new SlashCommandBuilder().setName('clan-rename').setDescription('Rename your clan and/or change its emoji (Leader only)')
    .addStringOption(o => o.setName('name').setDescription('New clan name (max 30 chars)').setRequired(true))
    .addStringOption(o => o.setName('emoji').setDescription('New clan emoji e.g. 🔥 (leave blank to keep current)').setRequired(false)),

  new SlashCommandBuilder().setName('clan-description').setDescription('Update your clan description (Leader/Officer only)')
    .addStringOption(o => o.setName('description').setDescription('New description (max 200 chars)').setRequired(true)),
  new SlashCommandBuilder().setName('clan-motto').setDescription('Set your clan motto (Leader/Officer only)')
    .addStringOption(o => o.setName('motto').setDescription('Your motto (max 100 chars)').setRequired(true)),

  new SlashCommandBuilder().setName('clan-ranks').setDescription('Rename rank titles AND update Discord role names (Leader only)')
    .addStringOption(o => o.setName('member').setDescription('New name for Member rank').setRequired(true))
    .addStringOption(o => o.setName('officer').setDescription('New name for Officer rank').setRequired(true))
    .addStringOption(o => o.setName('leader').setDescription('New name for Leader rank').setRequired(true)),

  new SlashCommandBuilder().setName('clan-invite').setDescription('Send a join invite to a user (Leader/Officer only)')
    .addUserOption(o => o.setName('user').setDescription('The user to invite').setRequired(true)),
  new SlashCommandBuilder().setName('clan-invite-accept').setDescription('Accept your pending clan invite'),
  new SlashCommandBuilder().setName('clan-invite-decline').setDescription('Decline your pending clan invite'),
  new SlashCommandBuilder().setName('clan-kick').setDescription('Kick a member from your clan (Leader/Officer only)')
    .addUserOption(o => o.setName('user').setDescription('The user to kick').setRequired(true)),
  new SlashCommandBuilder().setName('clan-leave').setDescription('Leave your current clan'),
  new SlashCommandBuilder().setName('clan-promote').setDescription('Promote a Member to Officer (Leader only)')
    .addUserOption(o => o.setName('user').setDescription('Member to promote').setRequired(true)),
  new SlashCommandBuilder().setName('clan-demote').setDescription('Demote an Officer to Member (Leader only)')
    .addUserOption(o => o.setName('user').setDescription('Officer to demote').setRequired(true)),
  new SlashCommandBuilder().setName('clan-transfer').setDescription('Transfer leadership to another member (Leader only)')
    .addUserOption(o => o.setName('user').setDescription('Member to transfer to').setRequired(true)),
  new SlashCommandBuilder().setName('clan-channel-create').setDescription('Create a private clan channel (Leader only)'),
  new SlashCommandBuilder().setName('clan-channel-delete').setDescription('Delete the private clan channel (Leader only)'),
  new SlashCommandBuilder().setName('clan-war').setDescription('Challenge another clan to a war (Leader only)')
    .addStringOption(o => o.setName('clan').setDescription('Name of the clan to challenge').setRequired(true)),
  new SlashCommandBuilder().setName('clan-war-accept').setDescription('Accept a pending clan war challenge (Leader only)'),
  new SlashCommandBuilder().setName('clan-war-decline').setDescription('Decline a pending clan war challenge (Leader only)'),
].map(c => c.toJSON());

// ─── Register Commands ────────────────────────────────────────────────────────
// Registers ALL commands (clan + pokemon) in one single PUT call.
// This avoids any risk of commands being partially registered or overwriting each other.

let _allCommands = null; // cached after first build

function getAllCommands() {
  if (_allCommands) return _allCommands;
  // Dynamically require pokemon command definitions
  let pokeCommands = [];
  try {
    pokeCommands = require('./pokemon-commands')();
  } catch {
    // pokemon-commands.js not present — skip
  }
  _allCommands = [...commands, ...pokeCommands];
  return _allCommands;
}

async function registerCommands(attempt = 1) {
  if (!process.env.CLIENT_ID) {
    console.error('❌ CLIENT_ID environment variable is not set!');
    return;
  }
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    const body = getAllCommands();
    console.log(`📋 Registering ${body.length} global commands (attempt ${attempt})...`);

    await Promise.race([
      rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out after 20s')), 20000)),
    ]);

    console.log(`✅ ${body.length} global commands registered successfully!`);
  } catch (err) {
    console.error(`❌ Command registration failed (attempt ${attempt}): ${err.message}`);
    if (err.rawError) console.error('Discord error:', JSON.stringify(err.rawError));
    if (attempt < 3) {
      const delay = attempt * 8000;
      console.log(`⏳ Retrying in ${delay / 1000}s...`);
      setTimeout(() => registerCommands(attempt + 1), delay);
    } else {
      console.error('❌ Giving up after 3 attempts. Commands may not be available.');
    }
  }
}

client.once('clientReady', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  // Small delay to let Railway network fully initialise
  setTimeout(() => registerCommands(), 2000);
});

// No need for guildCreate registration with global commands

// ─── XP on message ───────────────────────────────────────────────────────────

client.on('messageCreate', message => {
  try {
    if (message.author.bot || !message.guild) return;
    const key = `${message.guild.id}_${message.author.id}`;
    const now = Date.now();
    if (xpCooldowns[key] && now - xpCooldowns[key] < XP_COOLDOWN) return;
    const result = getUserClan(message.guild.id, message.author.id);
    if (!result) return;
    result.clan.xp = (result.clan.xp || 0) + XP_PER_MSG;
    xpCooldowns[key] = now;
    saveData();
  } catch {}
});

// ═══════════════════════════════════════════════════════════════════════════════
// WAR ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

// Race: first correct message from either clan wins the point
async function raceMessage(channel, allMembers, validator, timeMs) {
  return new Promise(resolve => {
    const col = channel.createMessageCollector({ filter: m => !m.author.bot, time: timeMs });
    col.on('collect', m => {
      const answer = m.content.trim().toLowerCase();
      if (!validator(answer)) return;
      for (const [clan, members] of Object.entries(allMembers)) {
        if (members.includes(m.author.id)) {
          col.stop('done');
          resolve({ clan, userId: m.author.id });
          return;
        }
      }
    });
    col.on('end', (_, reason) => { if (reason !== 'done') resolve(null); });
  });
}

// Lock-in: each player from a set gets one answer, locked on first message
// Returns { userId: answer } map when time expires or all have answered
async function lockInAnswers(channel, playerIds, validator, timeMs) {
  const locked = {}; // { userId: answer }
  return new Promise(resolve => {
    const col = channel.createMessageCollector({
      filter: m => !m.author.bot && playerIds.includes(m.author.id),
      time: timeMs,
    });
    col.on('collect', m => {
      if (locked[m.author.id] !== undefined) return;
      const val = m.content.trim().toLowerCase();
      if (!validator(val)) return;
      locked[m.author.id] = val;
      m.react('🔒').catch(() => {});
      if (Object.keys(locked).length === playerIds.length) col.stop('done');
    });
    col.on('end', () => resolve(locked));
  });
}

// ── GAME 1: Trivia ───────────────────────────────────────────────────────────
async function gameTrivia(channel, challengerName, defenderName, allMembers) {
  await channel.send({
    embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('🧠 Trivia Challenge!')
      .setDescription('Fetching questions...\n\nType the **letter (A/B/C/D)** for each question.\nFirst correct answer from either clan wins the point! 8 questions.')]
  }).catch(() => {});
  await new Promise(r => setTimeout(r, 3000));

  let questions = await fetchTriviaQuestions(8, 'easy');
  if (!questions) {
    await channel.send('⚠️ API unavailable — using built-in questions!').catch(() => {});
    questions = [
      { q: 'Capital of France?',         options: ['Berlin','Paris','Rome','Madrid'],        correct: 'Paris',       a: 'paris' },
      { q: 'How many sides on a hexagon?',options: ['5','6','7','8'],                         correct: '6',           a: '6' },
      { q: 'The Red Planet?',             options: ['Venus','Jupiter','Mars','Saturn'],       correct: 'Mars',        a: 'mars' },
      { q: '12 × 12 = ?',                options: ['124','144','132','148'],                  correct: '144',         a: '144' },
      { q: 'Who wrote Romeo and Juliet?', options: ['Dickens','Austen','Shakespeare','Keats'],correct: 'Shakespeare', a: 'shakespeare' },
      { q: 'Fastest land animal?',        options: ['Lion','Leopard','Cheetah','Tiger'],      correct: 'Cheetah',     a: 'cheetah' },
      { q: 'How many continents?',        options: ['5','6','7','8'],                         correct: '7',           a: '7' },
      { q: 'Largest ocean?',              options: ['Atlantic','Indian','Arctic','Pacific'],  correct: 'Pacific',     a: 'pacific' },
    ];
  }

  const letters = ['A','B','C','D'];
  const scores  = { [challengerName]: 0, [defenderName]: 0 };
  const everyone = [...allMembers[challengerName], ...allMembers[defenderName]];

  for (let i = 0; i < questions.length; i++) {
    const q             = questions[i];
    const correctLetter = letters[q.options.findIndex(o => o.toLowerCase() === q.a)] ?? 'A';
    const optText       = q.options.map((o, idx) => `**${letters[idx]}.** ${o}`).join('\n');

    await channel.send({
      embeds: [new EmbedBuilder().setColor(0x5865F2)
        .setTitle(`🧠 Question ${i + 1} / ${questions.length}`)
        .setDescription(`**${q.q}**\n\n${optText}\n\nType the letter — **first message per player is locked in 🔒**! **15 seconds.**`)]
    }).catch(() => {});

    // Lock one answer per player — first correct answer from either clan wins the point
    const lockedAnswers = {};
    const winner = await new Promise(resolve => {
      const col = channel.createMessageCollector({
        filter: m => !m.author.bot && everyone.includes(m.author.id),
        time: 15_000,
      });
      col.on('collect', m => {
        if (lockedAnswers[m.author.id] !== undefined) return; // already locked
        const val = m.content.trim().toLowerCase();
        if (!['a','b','c','d'].includes(val)) return; // ignore non-letter messages
        lockedAnswers[m.author.id] = val;
        m.react('🔒').catch(() => {});
        if (val === correctLetter.toLowerCase()) {
          for (const [clan, members] of Object.entries(allMembers)) {
            if (members.includes(m.author.id)) {
              col.stop('done');
              resolve({ clan, userId: m.author.id });
              return;
            }
          }
        }
      });
      col.on('end', (_, reason) => { if (reason !== 'done') resolve(null); });
    });

    if (winner) {
      scores[winner.clan]++;
      await channel.send(`✅ **${correctLetter}. ${q.correct}** — <@${winner.userId}> scores for **${winner.clan}**! (${scores[challengerName]} — ${scores[defenderName]})`).catch(() => {});
    } else {
      await channel.send(`⏰ Time's up! Answer: **${correctLetter}. ${q.correct}** (${scores[challengerName]} — ${scores[defenderName]})`).catch(() => {});
    }
    await new Promise(r => setTimeout(r, 2500));
  }

  return scores[challengerName] >= scores[defenderName] ? challengerName : defenderName;
}

// ── GAME 2: Anagrams ─────────────────────────────────────────────────────────
async function gameAnagrams(channel, challengerName, defenderName, allMembers) {
  await channel.send({
    embeds: [new EmbedBuilder().setColor(0xEB459E).setTitle('🔤 Anagrams!')
      .setDescription('Unscramble the word and type it first to win the point! 8 rounds.')]
  }).catch(() => {});
  await new Promise(r => setTimeout(r, 3000));

  const words  = shuffle(WORD_LIST).slice(0, 8);
  const scores = { [challengerName]: 0, [defenderName]: 0 };

  for (let i = 0; i < words.length; i++) {
    const word = words[i].toLowerCase();
    const sc   = scramble(word);
    await channel.send({
      embeds: [new EmbedBuilder().setColor(0xEB459E)
        .setTitle(`🔤 Anagram ${i + 1} / ${words.length}`)
        .setDescription(`Unscramble: **\`${sc.toUpperCase()}\`**\n\nType the full word! **20 seconds.**`)]
    }).catch(() => {});

    const correct = await raceMessage(channel, allMembers, ans => ans === word, 20_000);
    if (correct) {
      scores[correct.clan]++;
      await channel.send(`✅ **${word.toUpperCase()}** — <@${correct.userId}> scores for **${correct.clan}**! (${scores[challengerName]} — ${scores[defenderName]})`).catch(() => {});
    } else {
      await channel.send(`⏰ Time's up! The word was **${word.toUpperCase()}** (${scores[challengerName]} — ${scores[defenderName]})`).catch(() => {});
    }
    await new Promise(r => setTimeout(r, 2500));
  }

  return scores[challengerName] >= scores[defenderName] ? challengerName : defenderName;
}

// ── GAME 3: Dice Battle ──────────────────────────────────────────────────────
// Always 3 dice per clan regardless of size.
// Automatically picks first 3 from roster: leader, then officers, then members.
// If clan has < 3 members, remaining dice are assigned back to leader.
async function gameDiceBattle(channel, challengerName, defenderName, gc, guild) {
  const cClan = gc[challengerName];
  const dClan = gc[defenderName];

  // Pick 3 players per clan from roster order
  function pickPlayers(clan) {
    const roster = [clan.leader, ...(clan.officers || []), ...(clan.members || [])];
    const unique  = [...new Set(roster)]; // deduplicate
    const picked  = [];
    // Fill 3 slots — loop roster, repeat leader if needed
    for (let i = 0; i < 3; i++) {
      picked.push(unique[i] ?? unique[0]);
    }
    return picked; // array of 3 userIds (may have duplicates if clan is small)
  }

  const cPlayers = pickPlayers(cClan);
  const dPlayers = pickPlayers(dClan);

  const cRole = guild.roles.cache.get(cClan.memberRoleId || cClan.roleId);
  const dRole = guild.roles.cache.get(dClan.memberRoleId || dClan.roleId);

  await channel.send({
    embeds: [new EmbedBuilder().setColor(0xFF8C00).setTitle('🎲 Dice Battle!')
      .setDescription(
        `Each clan rolls **3 dice**. Each player can **Keep** or **Reroll once**.\n` +
        `Highest total wins the round. **Best of 5 rounds wins the war!**\n\n` +
        `**${challengerName} players:** ${[...new Set(cPlayers)].map(id => `<@${id}>`).join(', ')}\n` +
        `**${defenderName} players:** ${[...new Set(dPlayers)].map(id => `<@${id}>`).join(', ')}\n\n` +
        `Starting in 5 seconds...`
      )]
  }).catch(() => {});
  await new Promise(r => setTimeout(r, 5000));

  const roundWins = { [challengerName]: 0, [defenderName]: 0 };

  for (let round = 1; round <= 5; round++) {
    // Each player gets their own die
    const cRolls = cPlayers.map(() => rollDie());
    const dRolls = dPlayers.map(() => rollDie());

    // Reveal hidden rolls per player
    const buildRollMsg = (players, rolls) => {
      const seen = {};
      return players.map((id, idx) => {
        // If player appears more than once (small clan), label their dice
        seen[id] = (seen[id] || 0) + 1;
        const label = seen[id] > 1 ? ` (die ${seen[id]})` : '';
        return `<@${id}>${label}: rolled **${rolls[idx]}** 🎲`;
      }).join('\n');
    };

    await channel.send({
      embeds: [new EmbedBuilder().setColor(0xFF8C00)
        .setTitle(`🎲 Round ${round} / 5 — Dice Rolled!`)
        .setDescription(
          `**${challengerName}:**\n${buildRollMsg(cPlayers, cRolls)}\n\n` +
          `**${defenderName}:**\n${buildRollMsg(dPlayers, dRolls)}\n\n` +
          `Reply **keep** to keep your roll, or **reroll** to roll again.\n` +
          `Your first message is your choice — locked in! **20 seconds.**`
        )]
    }).catch(() => {});

    // Collect keep/reroll decisions from all 6 players (3 per clan)
    // One decision per unique player
    const allUniquePlayers = [...new Set([...cPlayers, ...dPlayers])];
    const decisions = await lockInAnswers(
      channel,
      allUniquePlayers,
      ans => ans === 'keep' || ans === 'reroll',
      20_000
    );

    // Apply decisions and calculate finals
    const cFinals = cPlayers.map((id, idx) => {
      const dec = decisions[id] ?? 'keep';
      return dec === 'reroll' ? rollDie() : cRolls[idx];
    });
    const dFinals = dPlayers.map((id, idx) => {
      const dec = decisions[id] ?? 'keep';
      return dec === 'reroll' ? rollDie() : dRolls[idx];
    });

    const cTotal = cFinals.reduce((s, v) => s + v, 0);
    const dTotal = dFinals.reduce((s, v) => s + v, 0);

    const buildFinalMsg = (players, origRolls, finalRolls) => {
      const seen = {};
      return players.map((id, idx) => {
        seen[id] = (seen[id] || 0) + 1;
        const label   = seen[id] > 1 ? ` (die ${seen[id]})` : '';
        const rerolled = finalRolls[idx] !== origRolls[idx];
        return `<@${id}>${label}: ${rerolled ? `~~${origRolls[idx]}~~ → **${finalRolls[idx]}**` : `**${finalRolls[idx]}**`} 🎲`;
      }).join('\n');
    };

    let roundWinner = '';
    if (cTotal > dTotal)      { roundWins[challengerName]++; roundWinner = `🏆 **${challengerName}** wins the round! (${cTotal} vs ${dTotal})`; }
    else if (dTotal > cTotal) { roundWins[defenderName]++;   roundWinner = `🏆 **${defenderName}** wins the round! (${dTotal} vs ${cTotal})`; }
    else                      { roundWinner = `🤝 It's a draw! (${cTotal} vs ${dTotal}) — No point awarded.`; }

    await channel.send({
      embeds: [new EmbedBuilder().setColor(cTotal >= dTotal ? 0x57F287 : 0xED4245)
        .setTitle(`🎲 Round ${round} Results`)
        .addFields(
          { name: `${challengerName} (Total: ${cTotal})`, value: buildFinalMsg(cPlayers, cRolls, cFinals), inline: true },
          { name: `${defenderName} (Total: ${dTotal})`,   value: buildFinalMsg(dPlayers, dRolls, dFinals), inline: true },
          { name: 'Result', value: `${roundWinner}\n\nScore: **${challengerName} ${roundWins[challengerName]}** — **${roundWins[defenderName]} ${defenderName}**` },
        )]
    }).catch(() => {});

    // Early finish if someone has 3 wins
    if (roundWins[challengerName] >= 3 || roundWins[defenderName] >= 3) break;
    await new Promise(r => setTimeout(r, 4000));
  }

  return roundWins[challengerName] >= roundWins[defenderName] ? challengerName : defenderName;
}

// ── GAME 4: Type the Word ────────────────────────────────────────────────────
async function gameTypeTheWord(channel, challengerName, defenderName, allMembers) {
  await channel.send({
    embeds: [new EmbedBuilder().setColor(0x57F287).setTitle('💬 Type the Word!')
      .setDescription('A word appears — **type it exactly** as shown as fast as you can! First correct type wins. 8 rounds.')]
  }).catch(() => {});
  await new Promise(r => setTimeout(r, 3000));

  const words  = shuffle(TYPE_WORDS).slice(0, 8);
  const scores = { [challengerName]: 0, [defenderName]: 0 };

  for (let i = 0; i < words.length; i++) {
    const word = words[i].toLowerCase();
    await channel.send({
      embeds: [new EmbedBuilder().setColor(0x57F287)
        .setTitle(`💬 Round ${i + 1} / ${words.length}`)
        .setDescription(`Type this word first:\n\n# ${word.toUpperCase()}\n\n**15 seconds.**`)]
    }).catch(() => {});

    const correct = await raceMessage(channel, allMembers, ans => ans === word, 15_000);
    if (correct) {
      scores[correct.clan]++;
      await channel.send(`✅ <@${correct.userId}> typed it first! Point to **${correct.clan}**! (${scores[challengerName]} — ${scores[defenderName]})`).catch(() => {});
    } else {
      await channel.send(`⏰ Nobody typed it in time! (${scores[challengerName]} — ${scores[defenderName]})`).catch(() => {});
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  return scores[challengerName] >= scores[defenderName] ? challengerName : defenderName;
}

// ── GAME 5: Guess the Number ─────────────────────────────────────────────────
async function gameGuessTheNumber(channel, challengerName, defenderName, allMembers) {
  const secret   = Math.floor(Math.random() * 100) + 1;
  const cMembers = allMembers[challengerName];
  const dMembers = allMembers[defenderName];
  const everyone = [...cMembers, ...dMembers];

  await channel.send({
    embeds: [new EmbedBuilder().setColor(0xFF8C00).setTitle('🔢 Guess the Number!')
      .setDescription(
        `I've picked a secret number **1–100**.\n\n` +
        `One guess per player — your first number is **locked in** (🔒)!\n\n` +
        `**${challengerName}:** ${cMembers.map(id => `<@${id}>`).join(', ')}\n` +
        `**${defenderName}:** ${dMembers.map(id => `<@${id}>`).join(', ')}\n\n` +
        `Everyone type your number now! **45 seconds.**`
      )]
  }).catch(() => {});

  const locked = await lockInAnswers(
    channel,
    everyone,
    val => !isNaN(parseInt(val, 10)) && parseInt(val, 10) >= 1 && parseInt(val, 10) <= 100,
    45_000
  );

  const guesses = {}; // { userId: number }
  for (const [id, val] of Object.entries(locked)) guesses[id] = parseInt(val, 10);

  const calcAvgDist = members => {
    const valid = members.filter(id => guesses[id] !== undefined);
    if (!valid.length) return Infinity;
    return valid.reduce((s, id) => s + Math.abs(guesses[id] - secret), 0) / valid.length;
  };

  const cDist = calcAvgDist(cMembers);
  const dDist = calcAvgDist(dMembers);
  const winner = cDist <= dDist ? challengerName : defenderName;

  const display = members => members.map(id =>
    guesses[id] !== undefined
      ? `<@${id}>: **${guesses[id]}** (off by ${Math.abs(guesses[id] - secret)})`
      : `<@${id}>: *no guess*`
  ).join('\n');

  await channel.send({
    embeds: [new EmbedBuilder().setColor(0xFF8C00).setTitle('🔢 Guesses Revealed!')
      .setDescription(`The secret number was **${secret}**!`)
      .addFields(
        { name: `${challengerName}`, value: display(cMembers) || 'No guesses', inline: true },
        { name: `${defenderName}`,   value: display(dMembers) || 'No guesses', inline: true },
        { name: '🏆 Winner', value: `**${winner}** had the closest average guess!` },
      )]
  }).catch(() => {});

  return winner;
}

// ── GAME 6: Missing Letters ──────────────────────────────────────────────────
async function gameMissingLetters(channel, challengerName, defenderName, allMembers) {
  await channel.send({
    embeds: [new EmbedBuilder().setColor(0x9B59B6).setTitle('🔡 Missing Letters!')
      .setDescription('Fill in the blanks — type the full word first to win. 8 rounds.')]
  }).catch(() => {});
  await new Promise(r => setTimeout(r, 3000));

  const words  = shuffle(WORD_LIST).slice(0, 8);
  const scores = { [challengerName]: 0, [defenderName]: 0 };

  for (let i = 0; i < words.length; i++) {
    const word    = words[i].toLowerCase();
    const display = makeMissingLetters(word);

    await channel.send({
      embeds: [new EmbedBuilder().setColor(0x9B59B6)
        .setTitle(`🔡 Round ${i + 1} / ${words.length}`)
        .setDescription(`Fill in the blanks:\n\n# \`${display}\`\n\nType the full word! **20 seconds.**`)]
    }).catch(() => {});

    const correct = await raceMessage(channel, allMembers, ans => ans === word, 20_000);
    if (correct) {
      scores[correct.clan]++;
      await channel.send(`✅ **${word.toUpperCase()}** — <@${correct.userId}> scores for **${correct.clan}**! (${scores[challengerName]} — ${scores[defenderName]})`).catch(() => {});
    } else {
      await channel.send(`⏰ Time's up! The word was **${word.toUpperCase()}** (${scores[challengerName]} — ${scores[defenderName]})`).catch(() => {});
    }
    await new Promise(r => setTimeout(r, 2500));
  }

  return scores[challengerName] >= scores[defenderName] ? challengerName : defenderName;
}

// ── GAME 7: Hidden Bomb ──────────────────────────────────────────────────────
async function gameHiddenBomb(channel, challengerName, defenderName, gc) {
  const cLeader = gc[challengerName].leader;
  const dLeader = gc[defenderName].leader;

  await channel.send({
    embeds: [new EmbedBuilder().setColor(0xFF4500).setTitle('💣 Hidden Bomb!')
      .setDescription(
        `Each round, **clan leaders** pick a number **1–10**.\n` +
        `One number is secretly the **💣 BOMB** — pick it and lose the round!\n\n` +
        `**First to win 3 rounds wins the war!** Starting in 5 seconds...`
      )]
  }).catch(() => {});
  await new Promise(r => setTimeout(r, 5000));

  const wins = { [challengerName]: 0, [defenderName]: 0 };

  for (let round = 1; round <= 5; round++) {
    const bomb = Math.floor(Math.random() * 10) + 1;

    await channel.send({
      embeds: [new EmbedBuilder().setColor(0xFF4500)
        .setTitle(`💣 Round ${round} / 5`)
        .setDescription(
          `<@${cLeader}> — pick for **${challengerName}**\n` +
          `<@${dLeader}> — pick for **${defenderName}**\n\n` +
          `Pick a number **1–10**. First pick per leader is locked in 🔒. **20 seconds.**`
        )]
    }).catch(() => {});

    const locked = await lockInAnswers(
      channel,
      [cLeader, dLeader],
      val => { const n = parseInt(val, 10); return !isNaN(n) && n >= 1 && n <= 10; },
      20_000
    );

    const cPick = locked[cLeader] !== undefined ? parseInt(locked[cLeader], 10) : Math.floor(Math.random() * 10) + 1;
    const dPick = locked[dLeader] !== undefined ? parseInt(locked[dLeader], 10) : Math.floor(Math.random() * 10) + 1;

    const cBombed = cPick === bomb;
    const dBombed = dPick === bomb;

    let result = '';
    if (cBombed && dBombed) { result = `💥 Both hit the bomb! Draw — no point.`; }
    else if (cBombed)       { wins[defenderName]++;   result = `💥 **${challengerName}** hit the bomb! Point to **${defenderName}**!`; }
    else if (dBombed)       { wins[challengerName]++; result = `💥 **${defenderName}** hit the bomb! Point to **${challengerName}**!`; }
    else                    { result = `✅ Nobody hit the bomb! No point awarded.`; }

    await channel.send({
      embeds: [new EmbedBuilder().setColor(cBombed || dBombed ? 0xFF0000 : 0x57F287)
        .setTitle(`💣 Round ${round} Result`)
        .setDescription(
          `**${challengerName}** picked: **${cPick}** ${cBombed ? '💥' : '✅'}\n` +
          `**${defenderName}** picked: **${dPick}** ${dBombed ? '💥' : '✅'}\n` +
          `The bomb was: **${bomb}** 💣\n\n${result}\n\n` +
          `Score — **${challengerName}: ${wins[challengerName]}** | **${defenderName}: ${wins[defenderName]}**`
        )]
    }).catch(() => {});

    if (wins[challengerName] >= 3 || wins[defenderName] >= 3) break;
    await new Promise(r => setTimeout(r, 3000));
  }

  return wins[challengerName] >= wins[defenderName] ? challengerName : defenderName;
}

// ── GAME 8: Maths Quiz ───────────────────────────────────────────────────────
async function gameMathsQuiz(channel, challengerName, defenderName, allMembers) {
  await channel.send({
    embeds: [new EmbedBuilder().setColor(0x2ECC71).setTitle('➕ Maths Quiz!')
      .setDescription(
        '8 maths questions — easy to hard!\n\n' +
        '**Your first answer is locked in 🔒** — no changing it!\n' +
        'First correct answer from either clan wins each point.\n\n' +
        'Starting in 3 seconds...'
      )]
  }).catch(() => {});
  await new Promise(r => setTimeout(r, 3000));

  const questions = generateMathsQuestions();
  const scores    = { [challengerName]: 0, [defenderName]: 0 };
  const everyone  = [...allMembers[challengerName], ...allMembers[defenderName]];

  const typeLabels = ['Addition', 'Addition', 'Subtraction', 'Subtraction', 'Multiplication', 'Multiplication', 'Division', 'Division'];

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];

    await channel.send({
      embeds: [new EmbedBuilder().setColor(0x2ECC71)
        .setTitle(`➕ Question ${i + 1} / ${questions.length} — ${typeLabels[i]}`)
        .setDescription(`**${q.q}**\n\nType your answer — first message is **locked in 🔒**!\n**20 seconds.**`)]
    }).catch(() => {});

    // Lock one answer per player, but first CORRECT answer from EITHER clan wins the point
    // We use a hybrid: lock per player AND race for correct answer
    const lockedAnswers = {};
    const winner = await new Promise(resolve => {
      const col = channel.createMessageCollector({
        filter: m => !m.author.bot && everyone.includes(m.author.id),
        time: 20_000,
      });

      col.on('collect', m => {
        if (lockedAnswers[m.author.id] !== undefined) return; // already locked
        const val = m.content.trim().toLowerCase();
        lockedAnswers[m.author.id] = val;
        m.react('🔒').catch(() => {});

        // Check if this is correct
        if (val === q.a) {
          for (const [clan, members] of Object.entries(allMembers)) {
            if (members.includes(m.author.id)) {
              col.stop('done');
              resolve({ clan, userId: m.author.id });
              return;
            }
          }
        }
      });

      col.on('end', (_, reason) => { if (reason !== 'done') resolve(null); });
    });

    if (winner) {
      scores[winner.clan]++;
      await channel.send(`✅ **${q.a}** — correct! <@${winner.userId}> scores for **${winner.clan}**! (${scores[challengerName]} — ${scores[defenderName]})`).catch(() => {});
    } else {
      await channel.send(`⏰ Time's up! Answer: **${q.a}** (${scores[challengerName]} — ${scores[defenderName]})`).catch(() => {});
    }
    await new Promise(r => setTimeout(r, 2500));
  }

  return scores[challengerName] >= scores[defenderName] ? challengerName : defenderName;
}

// ─── Main War Runner ──────────────────────────────────────────────────────────

async function runWar(guild, channel, challengerName, defenderName, gameChoice) {
  try {
    const gc         = getGuildClans(guild.id);
    const challenger = gc[challengerName];
    const defender   = gc[defenderName];

    if (!challenger || !defender) {
      await channel.send('❌ One of the clans no longer exists — war cancelled.').catch(() => {});
      delete activeWars[guild.id];
      return;
    }

    normaliseClan(challenger);
    normaliseClan(defender);

    const cRole = guild.roles.cache.get(challenger.memberRoleId || challenger.roleId);
    const dRole = guild.roles.cache.get(defender.memberRoleId   || defender.roleId);
    const game  = GAME_MENU.find(g => g.num === gameChoice) || GAME_MENU[0];

    await channel.send({
      embeds: [new EmbedBuilder().setColor(0xFF0000).setTitle('⚔️ CLAN WAR BEGINS!')
        .setDescription(
          `${cRole ?? `**${challengerName}**`} vs ${dRole ?? `**${defenderName}**`}\n\n` +
          `**Game: ${game.name}**\n${game.desc}\n\n` +
          `Starting in **5 seconds!**`
        )]
    }).catch(() => {});
    await new Promise(r => setTimeout(r, 5000));

    const allMembers = {
      [challengerName]: [challenger.leader, ...(challenger.officers || []), ...(challenger.members || [])],
      [defenderName]:   [defender.leader,   ...(defender.officers   || []), ...(defender.members   || [])],
    };

    let winnerId;
    if      (gameChoice === 1) winnerId = await gameTrivia(channel, challengerName, defenderName, allMembers);
    else if (gameChoice === 2) winnerId = await gameAnagrams(channel, challengerName, defenderName, allMembers);
    else if (gameChoice === 3) winnerId = await gameDiceBattle(channel, challengerName, defenderName, gc, guild);
    else if (gameChoice === 4) winnerId = await gameTypeTheWord(channel, challengerName, defenderName, allMembers);
    else if (gameChoice === 5) winnerId = await gameGuessTheNumber(channel, challengerName, defenderName, allMembers);
    else if (gameChoice === 6) winnerId = await gameMissingLetters(channel, challengerName, defenderName, allMembers);
    else if (gameChoice === 7) winnerId = await gameHiddenBomb(channel, challengerName, defenderName, gc);
    else if (gameChoice === 8) winnerId = await gameMathsQuiz(channel, challengerName, defenderName, allMembers);
    else winnerId = challengerName;

    const loserId    = winnerId === challengerName ? defenderName : challengerName;
    const winnerClan = gc[winnerId];
    const loserClan  = gc[loserId];
    if (winnerClan) { winnerClan.wins    = (winnerClan.wins    || 0) + 1; winnerClan.xp = (winnerClan.xp || 0) + 100; }
    if (loserClan)  { loserClan.losses   = (loserClan.losses   || 0) + 1; loserClan.xp  = (loserClan.xp  || 0) + 20; }
    delete activeWars[guild.id];
    saveData();

    const wR = guild.roles.cache.get(winnerClan?.memberRoleId || winnerClan?.roleId);
    const lR = guild.roles.cache.get(loserClan?.memberRoleId  || loserClan?.roleId);
    await channel.send({
      embeds: [new EmbedBuilder().setColor(0x57F287).setTitle('🏆 WAR OVER!')
        .setDescription(
          `🎉 **Winner: ${wR ?? `**${winnerId}**`}** — +100 XP\n` +
          `😔 **Loser: ${lR ?? `**${loserId}**`}** — +20 XP for participating\n\nGG to both clans! 🤝`
        )]
    }).catch(() => {});

  } catch (err) {
    console.error('War engine error:', err);
    await channel.send('❌ Something went wrong during the war. It has been cancelled.').catch(() => {});
    delete activeWars[guild.id];
  }
}

// ─── Game Selection Prompt ────────────────────────────────────────────────────

async function promptGameSelection(guild, channel, challengerClanName) {
  const gc   = getGuildClans(guild.id);
  const clan = gc[challengerClanName];
  if (!clan) return 1;

  const menuText = GAME_MENU.map(g => `**${g.num}.** ${g.name}\n   *${g.desc}*`).join('\n\n');

  await channel.send({
    embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('🎮 Choose Your War Game!')
      .setDescription(
        `<@${clan.leader}> — you challenged this war, so you pick the game!\n\n${menuText}\n\n` +
        `**Type a number (1–8). You have 30 seconds.**`
      )]
  }).catch(() => {});

  return new Promise(resolve => {
    const col = channel.createMessageCollector({
      filter: m => m.author.id === clan.leader && !m.author.bot,
      time: 30_000,
    });
    col.on('collect', m => {
      const num = parseInt(m.content.trim(), 10);
      if (num >= 1 && num <= 8) { col.stop('done'); resolve(num); }
    });
    col.on('end', (_, reason) => {
      if (reason !== 'done') {
        channel.send('⏰ No game selected — defaulting to **🧠 Trivia**!').catch(() => {});
        resolve(1);
      }
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// INTERACTION HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName, user, guild } = interaction;
  console.log(`📩 Command received: /${commandName} from ${user.tag}`);
  try {
    await handleCommand(interaction, commandName, user, guild);
  } catch (err) {
    console.error(`❌ Unhandled error in ${commandName}:`, err);
    await safeReply(interaction, { content: '❌ Something went wrong. Please try again.', flags: 64 });
  }
});

async function handleCommand(interaction, commandName, user, guild) {
  const gc = getGuildClans(guild.id);

  // ── /clan-commands ──────────────────────────────────────────────────────────
  if (commandName === 'clan-commands') {
    const pages = [
      new EmbedBuilder().setColor(0x5865F2).setTitle('⚔️ Clan Commands — Page 1/3: Clan Management')
        .addFields(
          { name: '📋 Info', value: ['`/clan-commands` — This menu', '`/clan-info [name]` — View clan details', '`/clan-list` — All clans ranked by XP', '`/clan-xp` — XP leaderboard'].join('\n') },
          { name: '🏰 Management', value: ['`/clan-create <name>` — Create a clan', '`/clan-disband` — Delete your clan *(Leader)*', '`/clan-rename <name> [emoji]` — Rename clan + roles + channel *(Leader)*', '`/clan-description <text>` — Update description *(Leader/Officer)*', '`/clan-motto <text>` — Set motto *(Leader/Officer)*', '`/clan-ranks <member> <officer> <leader>` — Rename rank titles *(Leader)*'].join('\n') },
          { name: '👥 Membership', value: ['`/clan-invite @user` — Send join invite *(Leader/Officer)*', '`/clan-invite-accept` — Accept invite', '`/clan-invite-decline` — Decline invite', '`/clan-kick @user` — Remove a member *(Leader/Officer)*', '`/clan-leave` — Leave your clan'].join('\n') },
          { name: '🛡️ Ranks', value: ['`/clan-promote @user` — Member → Officer *(Leader)*', '`/clan-demote @user` — Officer → Member *(Leader)*', '`/clan-transfer @user` — Hand over leadership *(Leader)*'].join('\n') },
          { name: '📢 Channel', value: ['`/clan-channel-create` — Create private channel *(Leader)*', '`/clan-channel-delete` — Delete private channel *(Leader)*'].join('\n') },
          { name: '⚔️ Wars', value: ['`/clan-war <clan>` — Challenge a clan *(Leader/Officer)*', '`/clan-war-accept` — Accept a challenge *(Leader)*', '`/clan-war-decline` — Decline a challenge *(Leader)*'].join('\n') },
        ).setFooter({ text: 'Page 1 of 3 — use buttons to navigate' }),

      new EmbedBuilder().setColor(0xFF0000).setTitle('🎮 Clan Commands — Page 2/3: Pokémon')
        .addFields(
          { name: '🌿 Catching', value: ['`/pokemon-team` — View your Pokémon', '`/pokemon-stats <slot>` — Detailed stats + XP bar', '`/pokemon-view @user` — View someone else\'s Pokémon', '`/pokemon-release <slot>` — Release a Pokémon', '`/pokemon-nickname <slot> <name>` — Nickname a Pokémon', '`/pokemon-info <name>` — Look up any Pokémon'].join('\n') },
          { name: '⚔️ Battles', value: ['`/pokemon-challenge @user <slot>` — Challenge a member to 1v1', '`/pokemon-accept <slot>` — Accept a battle challenge', '`/pokemon-decline` — Decline a battle challenge'].join('\n') },
          { name: '🎒 Items', value: ['`/pokemon-bag` — View your item bag', '`/pokemon-claim` — Claim an active item drop in your channel'].join('\n') },
          { name: '📊 Stats', value: ['`/pokemon-leaderboard` — Your clan\'s Pokémon rankings', '`/pokemon-server` — Server-wide top Pokémon by wins', '`/pokedex` — Your clan\'s Pokédex completion'].join('\n') },
          { name: '🎁 Item Drops', value: 'Items drop in clan channels every **1 hour** and expire in **30 minutes**.\nFirst person to use `/pokemon-claim` gets it!\n\n🔵 Great Ball · ⚫ Ultra Ball · 🧪 Super Potion · 💊 Hyper Potion · 🍯 Honey' },
        ).setFooter({ text: 'Page 2 of 3 — use buttons to navigate' }),

      new EmbedBuilder().setColor(0xFFD700).setTitle('🏅 Clan Commands — Page 3/3: Rank Permissions')
        .setDescription('What each rank can do in the clan system.')
        .addFields(
          { name: '👑 Leader — Full access', value: ['✅ Create / disband / rename the clan', '✅ Invite, kick, promote, demote members', '✅ Transfer leadership', '✅ Set description, motto, rank names', '✅ Create / delete private channel', '✅ Declare & accept clan wars', '✅ All Officer and Member permissions'].join('\n') },
          { name: '🛡️ Officer — Management access', value: ['✅ Invite members', '✅ Kick regular members', '✅ Set clan description and motto', '✅ Declare clan wars', '✅ All Member permissions', '❌ Cannot disband, rename, or transfer leadership', '❌ Cannot kick other Officers'].join('\n') },
          { name: '⚔️ Member — Basic access', value: ['✅ View clan info and leaderboards', '✅ Participate in Pokémon encounters', '✅ Battle other clan members', '✅ Claim item drops', '✅ Leave the clan', '❌ Cannot invite or kick', '❌ Cannot start wars'].join('\n') },
        ).setFooter({ text: 'Page 3 of 3 — use buttons to navigate' }),
    ];

    const prevBtn = new ButtonBuilder().setCustomId('cmd_prev').setLabel('◀ Previous').setStyle(ButtonStyle.Secondary);
    const nextBtn = new ButtonBuilder().setCustomId('cmd_next').setLabel('Next ▶').setStyle(ButtonStyle.Primary);

    let page = 0;

    const buildRow = (currentPage) => new ActionRowBuilder().addComponents(
      ButtonBuilder.from(prevBtn.toJSON()).setDisabled(currentPage === 0),
      ButtonBuilder.from(nextBtn.toJSON()).setDisabled(currentPage === pages.length - 1),
    );

    await safeReply(interaction, { embeds: [pages[0]], components: [buildRow(0)], flags: 64 });

    const msg = await interaction.fetchReply().catch(() => null);
    if (!msg) return;

    const col = msg.createMessageComponentCollector({
      filter: i => i.user.id === user.id && ['cmd_prev','cmd_next'].includes(i.customId),
      time: 120_000,
    });

    col.on('collect', async i => {
      if (i.customId === 'cmd_next' && page < pages.length - 1) page++;
      if (i.customId === 'cmd_prev' && page > 0) page--;
      await i.update({ embeds: [pages[page]], components: [buildRow(page)] }).catch(() => {});
    });

    col.on('end', () => {
      interaction.editReply({ components: [] }).catch(() => {});
    });

    return;
  }

  // ── /clan-info ──────────────────────────────────────────────────────────────
  if (commandName === 'clan-info') {
    const nameArg = interaction.options.getString('name');
    let clanName, clan;
    if (nameArg && nameArg.trim().length > 0) {
      clanName = nameArg.trim(); clan = gc[clanName];
      if (!clan) return safeReply(interaction, { content: `❌ No clan named **${clanName}** found.`, flags: 64 });
    } else {
      const r = getUserClan(guild.id, user.id);
      if (!r) return safeReply(interaction, { content: '❌ You are not in a clan. Join one or type a clan name.', flags: 64 });
      clanName = r.name; clan = r.clan;
    }
    normaliseClan(clan);
    const lRole   = guild.roles.cache.get(clan.leaderRoleId);
    const oRole   = guild.roles.cache.get(clan.officerRoleId);
    const mRole   = guild.roles.cache.get(clan.memberRoleId);
    const total   = 1 + clan.officers.length + clan.members.length;
    const offList = clan.officers.length ? clan.officers.map(id => `<@${id}>`).join(', ') : 'None';
    const memList = clan.members.length  ? clan.members.map(id => `<@${id}>`).join(', ')  : 'None';
    const created = clan.createdAt ? `<t:${Math.floor(new Date(clan.createdAt).getTime() / 1000)}:D>` : 'Unknown';
    const rn = clan.rankNames;
    // Gather Pokemon stats for this clan
    const clanMemberIds = [clan.leader, ...(clan.officers || []), ...(clan.members || [])];
    let clanPokeTotal = 0, clanPokeWins = 0, clanPokeHighest = 0;
    const pokeData = db[guild.id]?.__pokemon || {};
    for (const uid of clanMemberIds) {
      const md = pokeData[uid];
      if (!md) continue;
      clanPokeTotal += md.pokemon.length;
      clanPokeWins  += md.battleWins || 0;
      for (const p of md.pokemon) { if (p.level > clanPokeHighest) clanPokeHighest = p.level; }
    }

    return safeReply(interaction, {
      embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle(`${clan.emoji || '⚔️'} ${clanName}`)
        .setDescription(`${clan.description}${clan.motto ? `\n\n*"${clan.motto}"*` : ''}`)
        .addFields(
          { name: `👑 ${rn.leader}`,   value: `<@${clan.leader}>`, inline: true },
          { name: '👥 Members',         value: `${total}`,          inline: true },
          { name: '📅 Founded',         value: created,             inline: true },
          { name: '⭐ XP',              value: `${clan.xp}`,        inline: true },
          { name: '🏆 War Wins',        value: `${clan.wins}`,       inline: true },
          { name: '💀 War Losses',      value: `${clan.losses}`,     inline: true },
          { name: '🎮 Pokémon Caught',  value: `${clanPokeTotal}`,   inline: true },
          { name: '⚔️ Pokémon Wins',   value: `${clanPokeWins}`,    inline: true },
          { name: '📈 Highest Level',   value: clanPokeHighest > 0 ? `Lv.${clanPokeHighest}` : 'N/A', inline: true },
          { name: '🎭 Roles',           value: `${lRole ?? 'N/A'} · ${oRole ?? 'N/A'} · ${mRole ?? 'N/A'}` },
          { name: `🛡️ ${rn.officer}s`, value: offList },
          { name: `⚔️ ${rn.member}s`,  value: memList },
        )]
    });
  }

  // ── /clan-list ──────────────────────────────────────────────────────────────
  if (commandName === 'clan-list') {
    const names = Object.keys(gc);
    if (names.length === 0) return safeReply(interaction, { content: '📋 No clans yet!', flags: 64 });
    const sorted = names.map(n => ({ n, c: gc[n] })).sort((a, b) => (b.c.xp || 0) - (a.c.xp || 0));
    return safeReply(interaction, {
      embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('⚔️ All Clans')
        .setDescription(sorted.map(({ n, c }) => {
          const total = 1 + (c.officers || []).length + (c.members || []).length;
          const role  = guild.roles.cache.get(c.leaderRoleId || c.roleId);
          return `${c.emoji || '⚔️'} ${role ?? `**${n}**`} — ${total} member(s) | ${c.xp || 0} XP | Leader: <@${c.leader}>`;
        }).join('\n'))]
    });
  }

  // ── /clan-xp ────────────────────────────────────────────────────────────────
  if (commandName === 'clan-xp') {
    const names = Object.keys(gc);
    if (names.length === 0) return safeReply(interaction, { content: '📋 No clans yet!', flags: 64 });
    const sorted = names.map(n => ({ n, c: gc[n] })).sort((a, b) => (b.c.xp || 0) - (a.c.xp || 0));
    const medals = ['🥇','🥈','🥉'];
    return safeReply(interaction, {
      embeds: [new EmbedBuilder().setColor(0xFEE75C).setTitle('🏆 Clan XP Leaderboard')
        .setDescription(sorted.map(({ n, c }, i) => {
          const role = guild.roles.cache.get(c.leaderRoleId || c.roleId);
          return `${medals[i] || `**${i + 1}.**`} ${c.emoji || '⚔️'} ${role ?? `**${n}**`} — **${c.xp || 0} XP** | W: ${c.wins || 0}  L: ${c.losses || 0}`;
        }).join('\n'))
        .setFooter({ text: 'XP earned by chatting and winning wars.' })]
    });
  }

  // ── /clan-create ────────────────────────────────────────────────────────────
  if (commandName === 'clan-create') {
    const name        = interaction.options.getString('name').trim();
    const description = interaction.options.getString('description') || 'No description set.';
    if (getUserClan(guild.id, user.id)) return safeReply(interaction, { content: '❌ You are already in a clan.', flags: 64 });
    if (gc[name]) return safeReply(interaction, { content: `❌ A clan named **${name}** already exists.`, flags: 64 });
    if (name.length > 30) return safeReply(interaction, { content: '❌ Clan name must be 30 characters or fewer.', flags: 64 });

    await safeDefer(interaction);

    const rn = { leader: 'Leader', officer: 'Officer', member: 'Member' };

    let leaderRole, officerRole, memberRole;
    try {
      leaderRole  = await guild.roles.create({ name: buildRoleName(name, rn.leader),  colors: 0xFFD700, reason: `Clan created by ${user.tag}` });
      officerRole = await guild.roles.create({ name: buildRoleName(name, rn.officer), colors: 0x5865F2, reason: `Officer role for ${name}` });
      memberRole  = await guild.roles.create({ name: buildRoleName(name, rn.member),  colors: 0x99AAB5, reason: `Member role for ${name}` });
    } catch (e) {
      if (leaderRole)  await leaderRole.delete().catch(() => {});
      if (officerRole) await officerRole.delete().catch(() => {});
      return safeReply(interaction, { content: '❌ Failed to create clan roles. Check bot permissions and role position.', flags: 64 });
    }

    // Give leader the Leader role
    try {
      const lm = await guild.members.fetch(user.id);
      await lm.roles.add(leaderRole);
    } catch (e) { console.error('Could not assign leader role:', e.message); }

    gc[name] = normaliseClan({
      leader: user.id, officers: [], members: [], description, motto: '', emoji: '⚔️',
      leaderRoleId: leaderRole.id, officerRoleId: officerRole.id, memberRoleId: memberRole.id,
      roleId: memberRole.id, // kept for backwards compat with channel permissions
      channelId: null, xp: 0, wins: 0, losses: 0,
      createdAt: new Date().toISOString(), rankNames: rn,
    });
    saveData();

    return safeReply(interaction, {
      embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle(`⚔️ Clan Created: ${name}`).setDescription(description)
        .addFields(
          { name: '👑 Leader', value: `<@${user.id}>` },
          { name: '🎭 Roles Created', value: `${leaderRole} · ${officerRole} · ${memberRole}` },
        )
        .setFooter({ text: 'Use /clan-invite to add members!' })]
    });
  }

  // ── /clan-rename ────────────────────────────────────────────────────────────
  if (commandName === 'clan-rename') {
    const result = getUserClan(guild.id, user.id);
    if (!result) return safeReply(interaction, { content: '❌ You are not in a clan.', flags: 64 });
    if (result.clan.leader !== user.id) return safeReply(interaction, { content: '❌ Only the Leader can rename the clan.', flags: 64 });

    const newName  = interaction.options.getString('name').trim();
    const newEmoji = interaction.options.getString('emoji')?.trim() || result.clan.emoji || '⚔️';
    const oldName  = result.name;

    if (newName.length > 30) return safeReply(interaction, { content: '❌ Clan name must be 30 characters or fewer.', flags: 64 });
    if (newName !== oldName && gc[newName]) return safeReply(interaction, { content: `❌ A clan named **${newName}** already exists.`, flags: 64 });

    await safeDefer(interaction);

    const rn = result.clan.rankNames || { leader: 'Leader', officer: 'Officer', member: 'Member' };

    // Rename all 3 Discord roles with new clan name prefix
    const lRole = guild.roles.cache.get(result.clan.leaderRoleId);
    const oRole = guild.roles.cache.get(result.clan.officerRoleId);
    const mRole = guild.roles.cache.get(result.clan.memberRoleId);
    try { if (lRole) await lRole.setName(buildRoleName(newName, rn.leader));  } catch (e) { console.error('Could not rename leader role:',  e.message); }
    try { if (oRole) await oRole.setName(buildRoleName(newName, rn.officer)); } catch (e) { console.error('Could not rename officer role:', e.message); }
    try { if (mRole) await mRole.setName(buildRoleName(newName, rn.member));  } catch (e) { console.error('Could not rename member role:',  e.message); }

    // Update internal data — re-key if name changed
    result.clan.emoji = newEmoji;
    if (newName !== oldName) {
      gc[newName] = result.clan;
      delete gc[oldName];
    }

    // Rename the private clan channel if one exists
    let channelRenamed = false;
    if (result.clan.channelId) {
      const clanChannel = guild.channels.cache.get(result.clan.channelId);
      if (clanChannel) {
        const newChannelName = `${newEmoji}-${newName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 90)}`;
        try {
          await clanChannel.setName(newChannelName);
          channelRenamed = true;
        } catch (e) {
          console.error('Could not rename clan channel:', e.message);
        }
      } else {
        // Channel no longer exists — clear stale ID
        result.clan.channelId = null;
      }
    }

    saveData();

    return safeReply(interaction, {
      embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('✅ Clan Renamed!')
        .addFields(
          { name: 'Old name',       value: `${oldName}`,                                        inline: true },
          { name: 'New name',       value: `${newEmoji} ${newName}`,                            inline: true },
          { name: 'Roles updated',  value: `${lRole ?? 'N/A'} · ${oRole ?? 'N/A'} · ${mRole ?? 'N/A'}` },
          { name: 'Channel',        value: channelRenamed ? '✅ Renamed to match' : result.clan.channelId ? '⚠️ Could not rename' : 'No channel' },
        )]
    });
  }

  // ── /clan-disband ───────────────────────────────────────────────────────────
  if (commandName === 'clan-disband') {
    const result = getUserClan(guild.id, user.id);
    if (!result) return safeReply(interaction, { content: '❌ You are not in a clan.', flags: 64 });
    if (result.clan.leader !== user.id) return safeReply(interaction, { content: '❌ Only the Leader can disband the clan.', flags: 64 });

    const yes = new ButtonBuilder().setCustomId('disband_yes').setLabel('Yes, disband').setStyle(ButtonStyle.Danger);
    const no  = new ButtonBuilder().setCustomId('disband_no').setLabel('Cancel').setStyle(ButtonStyle.Secondary);
    await safeReply(interaction, {
      content: `⚠️ Are you sure you want to disband **${result.name}**? This permanently deletes all roles and the channel.`,
      components: [new ActionRowBuilder().addComponents(yes, no)],
      flags: 64,
    });

    const col = interaction.channel.createMessageComponentCollector({
      filter: i => i.user.id === user.id && ['disband_yes','disband_no'].includes(i.customId),
      time: 15_000, max: 1,
    });
    col.on('collect', async i => {
      try {
        if (i.customId === 'disband_no') return i.update({ content: '✅ Disband cancelled.', components: [] });
        await i.update({ content: '💀 Disbanding...', components: [] });
        const lr = guild.roles.cache.get(result.clan.leaderRoleId);
        const or = guild.roles.cache.get(result.clan.officerRoleId);
        const mr = guild.roles.cache.get(result.clan.memberRoleId);
        if (lr) await lr.delete().catch(() => {});
        if (or) await or.delete().catch(() => {});
        if (mr) await mr.delete().catch(() => {});
        if (result.clan.channelId) { const ch = guild.channels.cache.get(result.clan.channelId); if (ch) await ch.delete().catch(() => {}); }
        delete gc[result.name];
        saveData();
        await interaction.editReply({ content: `💀 **${result.name}** has been disbanded.`, components: [] }).catch(() => {});
      } catch (e) { console.error('Disband error:', e.message); }
    });
    col.on('end', collected => { if (collected.size === 0) interaction.editReply({ content: '⏰ Timed out — cancelled.', components: [] }).catch(() => {}); });
    return;
  }

  // ── /clan-ranks ─────────────────────────────────────────────────────────────
  if (commandName === 'clan-ranks') {
    const result = getUserClan(guild.id, user.id);
    if (!result) return safeReply(interaction, { content: '❌ You are not in a clan.', flags: 64 });
    if (result.clan.leader !== user.id) return safeReply(interaction, { content: '❌ Only the Leader can rename ranks.', flags: 64 });

    const m = interaction.options.getString('member').trim().slice(0, 30);
    const o = interaction.options.getString('officer').trim().slice(0, 30);
    const l = interaction.options.getString('leader').trim().slice(0, 30);

    await safeDefer(interaction);

    const lRole = guild.roles.cache.get(result.clan.leaderRoleId);
    const oRole = guild.roles.cache.get(result.clan.officerRoleId);
    const mRole = guild.roles.cache.get(result.clan.memberRoleId);

    // Rename all 3 Discord roles
    try { if (lRole) await lRole.setName(buildRoleName(result.name, l)); } catch (e) { console.error('Could not rename leader role:',  e.message); }
    try { if (oRole) await oRole.setName(buildRoleName(result.name, o)); } catch (e) { console.error('Could not rename officer role:', e.message); }
    try { if (mRole) await mRole.setName(buildRoleName(result.name, m)); } catch (e) { console.error('Could not rename member role:',  e.message); }

    result.clan.rankNames = { member: m, officer: o, leader: l };
    saveData();

    return safeReply(interaction, {
      embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('🏷️ Rank Names Updated')
        .setDescription('All 3 Discord roles have been renamed.')
        .addFields(
          { name: 'Leader role',  value: `${lRole ?? 'N/A'} → **${buildRoleName(result.name, l)}**` },
          { name: 'Officer role', value: `${oRole ?? 'N/A'} → **${buildRoleName(result.name, o)}**` },
          { name: 'Member role',  value: `${mRole ?? 'N/A'} → **${buildRoleName(result.name, m)}**` },
        )]
    });
  }

  // ── /clan-motto ─────────────────────────────────────────────────────────────
  if (commandName === 'clan-motto') {
    const motto  = interaction.options.getString('motto').trim();
    const result = getUserClan(guild.id, user.id);
    if (!result) return safeReply(interaction, { content: '❌ You are not in a clan.', flags: 64 });
    if (getUserRank(result.clan, user.id) === 'Member') return safeReply(interaction, { content: '❌ Only Leaders and Officers can set the motto.', flags: 64 });
    if (motto.length > 100) return safeReply(interaction, { content: '❌ Motto must be 100 characters or fewer.', flags: 64 });
    result.clan.motto = motto; saveData();
    return safeReply(interaction, { embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('📜 Motto Updated').setDescription(`**${result.name}**'s motto:\n*"${motto}"*`)] });
  }

  // ── /clan-description ───────────────────────────────────────────────────────
  if (commandName === 'clan-description') {
    const description = interaction.options.getString('description').trim();
    const result      = getUserClan(guild.id, user.id);
    if (!result) return safeReply(interaction, { content: '❌ You are not in a clan.', flags: 64 });
    if (getUserRank(result.clan, user.id) === 'Member') return safeReply(interaction, { content: '❌ Only Leaders and Officers can update the description.', flags: 64 });
    if (description.length > 200) return safeReply(interaction, { content: '❌ Description must be 200 characters or fewer.', flags: 64 });
    result.clan.description = description; saveData();
    return safeReply(interaction, { embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('📝 Description Updated').setDescription(`**${result.name}**'s description has been updated.`)] });
  }

  // ── /clan-invite ────────────────────────────────────────────────────────────
  if (commandName === 'clan-invite') {
    const target = interaction.options.getUser('user');
    const result = getUserClan(guild.id, user.id);
    if (!result) return safeReply(interaction, { content: '❌ You are not in a clan.', flags: 64 });
    if (getUserRank(result.clan, user.id) === 'Member') return safeReply(interaction, { content: '❌ Only Leaders and Officers can invite members.', flags: 64 });
    if (target.bot) return safeReply(interaction, { content: '❌ You cannot invite bots.', flags: 64 });
    if (target.id === user.id) return safeReply(interaction, { content: '❌ You cannot invite yourself.', flags: 64 });
    if (getUserClan(guild.id, target.id)) return safeReply(interaction, { content: `❌ **${target.username}** is already in a clan.`, flags: 64 });
    const key = `${guild.id}_${target.id}`;
    if (pendingInvites[key]) return safeReply(interaction, { content: `❌ **${target.username}** already has a pending invite.`, flags: 64 });
    pendingInvites[key] = { clanName: result.name, guildId: guild.id, inviterId: user.id, expiresAt: Date.now() + 5 * 60_000 };
    setTimeout(() => { if (pendingInvites[key]?.clanName === result.name) delete pendingInvites[key]; }, 5 * 60_000);
    return safeReply(interaction, {
      embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('📨 Clan Invite!')
        .setDescription(`<@${target.id}> — you've been invited to join **${result.name}** by <@${user.id}>!\n\nUse \`/clan-invite-accept\` to join, or \`/clan-invite-decline\` to decline.\n⏰ Expires in **5 minutes**.`)]
    });
  }

  // ── /clan-invite-accept ─────────────────────────────────────────────────────
  if (commandName === 'clan-invite-accept') {
    const key = `${guild.id}_${user.id}`; const invite = pendingInvites[key];
    if (!invite) return safeReply(interaction, { content: '❌ You have no pending clan invite.', flags: 64 });
    if (Date.now() > invite.expiresAt) { delete pendingInvites[key]; return safeReply(interaction, { content: '❌ Your invite has expired.', flags: 64 }); }
    if (getUserClan(guild.id, user.id)) { delete pendingInvites[key]; return safeReply(interaction, { content: '❌ You are already in a clan.', flags: 64 }); }
    const clan = gc[invite.clanName];
    if (!clan) { delete pendingInvites[key]; return safeReply(interaction, { content: '❌ That clan no longer exists.', flags: 64 }); }
    await safeDefer(interaction);
    normaliseClan(clan);
    await assignRankRole(guild, clan, user.id, 'Member');
    clan.members.push(user.id); delete pendingInvites[key]; saveData();
    return safeReply(interaction, { embeds: [new EmbedBuilder().setColor(0x57F287).setTitle('✅ Invite Accepted!').setDescription(`<@${user.id}> has joined **${invite.clanName}**! Welcome! 🎉`)] });
  }

  // ── /clan-invite-decline ────────────────────────────────────────────────────
  if (commandName === 'clan-invite-decline') {
    const key = `${guild.id}_${user.id}`; const invite = pendingInvites[key];
    if (!invite) return safeReply(interaction, { content: '❌ You have no pending clan invite.', flags: 64 });
    const clanName = invite.clanName; delete pendingInvites[key];
    return safeReply(interaction, { embeds: [new EmbedBuilder().setColor(0xED4245).setTitle('❌ Invite Declined').setDescription(`<@${user.id}> declined the invite to **${clanName}**.`)] });
  }

  // ── /clan-kick ──────────────────────────────────────────────────────────────
  if (commandName === 'clan-kick') {
    const target = interaction.options.getUser('user');
    const result = getUserClan(guild.id, user.id);
    if (!result) return safeReply(interaction, { content: '❌ You are not in a clan.', flags: 64 });
    const rank = getUserRank(result.clan, user.id);
    if (rank === 'Member') return safeReply(interaction, { content: '❌ Only Leaders and Officers can kick members.', flags: 64 });
    if (target.id === user.id) return safeReply(interaction, { content: '❌ You cannot kick yourself.', flags: 64 });
    if (result.clan.leader === target.id) return safeReply(interaction, { content: '❌ You cannot kick the Leader.', flags: 64 });
    const targetRank = getUserRank(result.clan, target.id);
    if (!targetRank) return safeReply(interaction, { content: `❌ **${target.username}** is not in your clan.`, flags: 64 });
    if (rank === 'Officer' && targetRank === 'Officer') return safeReply(interaction, { content: '❌ Officers cannot kick other Officers.', flags: 64 });
    await safeDefer(interaction);
    try {
      const m  = await guild.members.fetch(target.id);
      const lr = guild.roles.cache.get(result.clan.leaderRoleId);
      const or = guild.roles.cache.get(result.clan.officerRoleId);
      const mr = guild.roles.cache.get(result.clan.memberRoleId);
      if (lr) await m.roles.remove(lr).catch(() => {});
      if (or) await m.roles.remove(or).catch(() => {});
      if (mr) await m.roles.remove(mr).catch(() => {});
    } catch {}
    result.clan.officers = result.clan.officers.filter(id => id !== target.id);
    result.clan.members  = result.clan.members.filter(id => id !== target.id);
    saveData();
    return safeReply(interaction, { embeds: [new EmbedBuilder().setColor(0xED4245).setTitle('🥾 Member Kicked').setDescription(`<@${target.id}> has been removed from **${result.name}**.`)] });
  }

  // ── /clan-leave ─────────────────────────────────────────────────────────────
  if (commandName === 'clan-leave') {
    const result = getUserClan(guild.id, user.id);
    if (!result) return safeReply(interaction, { content: '❌ You are not in a clan.', flags: 64 });
    if (result.clan.leader === user.id) return safeReply(interaction, { content: '❌ Leaders cannot leave. Use `/clan-transfer` or `/clan-disband`.', flags: 64 });
    await safeDefer(interaction, { flags: 64 });
    try {
      const m  = await guild.members.fetch(user.id);
      const lr = guild.roles.cache.get(result.clan.leaderRoleId);
      const or = guild.roles.cache.get(result.clan.officerRoleId);
      const mr = guild.roles.cache.get(result.clan.memberRoleId);
      if (lr) await m.roles.remove(lr).catch(() => {});
      if (or) await m.roles.remove(or).catch(() => {});
      if (mr) await m.roles.remove(mr).catch(() => {});
    } catch {}
    result.clan.officers = result.clan.officers.filter(id => id !== user.id);
    result.clan.members  = result.clan.members.filter(id => id !== user.id);
    saveData();
    return safeReply(interaction, { content: `👋 You have left **${result.name}**.` });
  }

  // ── /clan-promote ───────────────────────────────────────────────────────────
  if (commandName === 'clan-promote') {
    const target = interaction.options.getUser('user');
    const result = getUserClan(guild.id, user.id);
    if (!result) return safeReply(interaction, { content: '❌ You are not in a clan.', flags: 64 });
    if (result.clan.leader !== user.id) return safeReply(interaction, { content: '❌ Only the Leader can promote members.', flags: 64 });
    if (!result.clan.members.includes(target.id)) return safeReply(interaction, { content: `❌ **${target.username}** is not a Member in your clan.`, flags: 64 });
    await safeDefer(interaction);
    await assignRankRole(guild, result.clan, target.id, 'Officer');
    result.clan.members  = result.clan.members.filter(id => id !== target.id);
    result.clan.officers.push(target.id); saveData();
    return safeReply(interaction, { embeds: [new EmbedBuilder().setColor(0xFEE75C).setTitle('⬆️ Member Promoted').setDescription(`<@${target.id}> is now a **${rankLabel(result.clan, 'Officer')}** of **${result.name}**!`)] });
  }

  // ── /clan-demote ────────────────────────────────────────────────────────────
  if (commandName === 'clan-demote') {
    const target = interaction.options.getUser('user');
    const result = getUserClan(guild.id, user.id);
    if (!result) return safeReply(interaction, { content: '❌ You are not in a clan.', flags: 64 });
    if (result.clan.leader !== user.id) return safeReply(interaction, { content: '❌ Only the Leader can demote officers.', flags: 64 });
    if (!result.clan.officers.includes(target.id)) return safeReply(interaction, { content: `❌ **${target.username}** is not an Officer.`, flags: 64 });
    await safeDefer(interaction);
    await assignRankRole(guild, result.clan, target.id, 'Member');
    result.clan.officers = result.clan.officers.filter(id => id !== target.id);
    result.clan.members.push(target.id); saveData();
    return safeReply(interaction, { embeds: [new EmbedBuilder().setColor(0xEB459E).setTitle('⬇️ Officer Demoted').setDescription(`<@${target.id}> has been demoted to **${rankLabel(result.clan, 'Member')}** in **${result.name}**.`)] });
  }

  // ── /clan-transfer ──────────────────────────────────────────────────────────
  if (commandName === 'clan-transfer') {
    const target = interaction.options.getUser('user');
    const result = getUserClan(guild.id, user.id);
    if (!result) return safeReply(interaction, { content: '❌ You are not in a clan.', flags: 64 });
    if (result.clan.leader !== user.id) return safeReply(interaction, { content: '❌ Only the Leader can transfer leadership.', flags: 64 });
    if (target.id === user.id) return safeReply(interaction, { content: '❌ You are already the Leader.', flags: 64 });
    if (!getUserRank(result.clan, target.id)) return safeReply(interaction, { content: `❌ **${target.username}** is not in your clan.`, flags: 64 });
    await safeDefer(interaction);
    result.clan.officers = result.clan.officers.filter(id => id !== target.id);
    result.clan.members  = result.clan.members.filter(id => id !== target.id);
    result.clan.members.push(user.id);
    result.clan.leader = target.id;
    await assignRankRole(guild, result.clan, target.id, 'Leader');
    await assignRankRole(guild, result.clan, user.id,   'Member');
    saveData();
    return safeReply(interaction, { embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('👑 Leadership Transferred').setDescription(`<@${target.id}> is now the **Leader** of **${result.name}**!\n<@${user.id}> has stepped down to Member.`)] });
  }

  // ── /clan-channel-create ────────────────────────────────────────────────────
  if (commandName === 'clan-channel-create') {
    const result = getUserClan(guild.id, user.id);
    if (!result) return safeReply(interaction, { content: '❌ You are not in a clan.', flags: 64 });
    if (result.clan.leader !== user.id) return safeReply(interaction, { content: '❌ Only the Leader can create the clan channel.', flags: 64 });
    if (result.clan.channelId) {
      const existing = guild.channels.cache.get(result.clan.channelId);
      if (existing) return safeReply(interaction, { content: `❌ Your clan already has a channel: ${existing}`, flags: 64 });
      result.clan.channelId = null; saveData();
    }
    await safeDefer(interaction);
    const memberRole = guild.roles.cache.get(result.clan.memberRoleId || result.clan.roleId);
    const leaderRole = guild.roles.cache.get(result.clan.leaderRoleId);
    const offRole    = guild.roles.cache.get(result.clan.officerRoleId);
    if (!memberRole) return safeReply(interaction, { content: '❌ Clan roles not found.', flags: 64 });
    let channel;
    try {
      channel = await guild.channels.create({
        name: `${result.clan.emoji || '⚔️'}-${result.name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 90)}`,
        topic: `Private channel for the ${result.name} clan.`,
        permissionOverwrites: [
          { id: guild.roles.everyone.id, deny:  [PermissionFlagsBits.ViewChannel] },
          { id: memberRole.id,           allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
          ...(leaderRole && leaderRole.id !== memberRole.id ? [{ id: leaderRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }] : []),
          ...(offRole    && offRole.id    !== memberRole.id ? [{ id: offRole.id,    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }] : []),
          { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
        ],
      });
    } catch { return safeReply(interaction, { content: '❌ Failed to create channel. Check Manage Channels permission.', flags: 64 }); }
    result.clan.channelId = channel.id; saveData();
    await channel.send({ embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle(`${result.clan.emoji || '⚔️'} Welcome to ${result.name}'s channel!`).setDescription('Only clan members can see this!')] }).catch(() => {});
    return safeReply(interaction, { embeds: [new EmbedBuilder().setColor(0x57F287).setTitle('✅ Clan Channel Created').setDescription(`Your private channel ${channel} is ready!`)] });
  }

  // ── /clan-channel-delete ────────────────────────────────────────────────────
  if (commandName === 'clan-channel-delete') {
    const result = getUserClan(guild.id, user.id);
    if (!result) return safeReply(interaction, { content: '❌ You are not in a clan.', flags: 64 });
    if (result.clan.leader !== user.id) return safeReply(interaction, { content: '❌ Only the Leader can delete the clan channel.', flags: 64 });
    if (!result.clan.channelId) return safeReply(interaction, { content: '❌ Your clan does not have a private channel.', flags: 64 });
    await safeDefer(interaction, { flags: 64 });
    const ch = guild.channels.cache.get(result.clan.channelId);
    if (ch) await ch.delete().catch(() => {});
    result.clan.channelId = null; saveData();
    return safeReply(interaction, { content: '✅ Clan channel deleted.' });
  }

  // ── /clan-war ───────────────────────────────────────────────────────────────
  if (commandName === 'clan-war') {
    const defenderName = interaction.options.getString('clan').trim();
    const result       = getUserClan(guild.id, user.id);
    if (!result) return safeReply(interaction, { content: '❌ You are not in a clan.', flags: 64 });
    const warRank = getUserRank(result.clan, user.id);
    if (warRank === 'Member') return safeReply(interaction, { content: '❌ Only the Leader or Officers can declare war.', flags: 64 });
    if (defenderName === result.name) return safeReply(interaction, { content: '❌ You cannot war your own clan.', flags: 64 });
    if (activeWars[guild.id]) return safeReply(interaction, { content: '❌ A war is already in progress on this server.', flags: 64 });
    if (!gc[defenderName]) {
      const available = Object.keys(gc).filter(n => n !== result.name);
      const list = available.length ? available.map(n => `• **${n}**`).join('\n') : 'No other clans exist yet.';
      return safeReply(interaction, { content: `❌ No clan named **${defenderName}** found. Names are case-sensitive!\n\n**Clans you can challenge:**\n${list}`, flags: 64 });
    }
    const defender = gc[defenderName];
    activeWars[guild.id] = { challengerClan: result.name, defenderClan: defenderName, channelId: interaction.channelId, pending: true };
    let defMention = `the Leader of **${defenderName}**`;
    try { await guild.members.fetch(defender.leader); defMention = `<@${defender.leader}>`; } catch {}
    await safeReply(interaction, {
      embeds: [new EmbedBuilder().setColor(0xFF0000).setTitle('⚔️ Clan War Challenge!')
        .setDescription(`**${result.name}** challenged **${defenderName}** to a clan war!\n\n${defMention} — use \`/clan-war-accept\` or \`/clan-war-decline\`.\n\n⏰ Expires in **2 minutes**.`)]
    });
    setTimeout(() => {
      if (activeWars[guild.id]?.pending && activeWars[guild.id]?.challengerClan === result.name) {
        const expiredWar = activeWars[guild.id];
        delete activeWars[guild.id];
        // Delete the Discord event if it was created
        if (expiredWar.eventId) {
          guild.scheduledEvents.delete(expiredWar.eventId).catch(() => {});
        }
        interaction.channel.send(`⏰ War challenge from **${result.name}** to **${defenderName}** has expired.`).catch(() => {});
      }
    }, 120_000);
    try {
      const start = new Date(Date.now() + 5 * 60_000);
      const end   = new Date(Date.now() + 35 * 60_000);
      const event = await guild.scheduledEvents.create({
        name: `⚔️ Clan War: ${result.name} vs ${defenderName}`,
        scheduledStartTime: start, scheduledEndTime: end, privacyLevel: 2, entityType: 3,
        entityMetadata: { location: `#${interaction.channel.name}` },
        description: `Clan war between ${result.name} and ${defenderName}!`,
      });
      activeWars[guild.id].eventId = event.id;
      await interaction.channel.send('📅 A Discord Event has been created — check the Events tab!').catch(() => {});
    } catch {}
    return;
  }

  // ── /clan-war-accept ────────────────────────────────────────────────────────
  if (commandName === 'clan-war-accept') {
    const result = getUserClan(guild.id, user.id);
    if (!result) return safeReply(interaction, { content: '❌ You are not in a clan.', flags: 64 });
    if (result.clan.leader !== user.id) return safeReply(interaction, { content: '❌ Only the Leader can accept a war.', flags: 64 });
    const war = activeWars[guild.id];
    if (!war || !war.pending) return safeReply(interaction, { content: '❌ No pending war challenge found.', flags: 64 });
    if (war.defenderClan !== result.name) return safeReply(interaction, { content: `❌ This challenge is for **${war.defenderClan}**, not your clan.`, flags: 64 });
    war.pending = false;
    const warChannel = guild.channels.cache.get(war.channelId) || interaction.channel;
    await safeReply(interaction, { embeds: [new EmbedBuilder().setColor(0xFF0000).setTitle('⚔️ War Accepted!').setDescription(`**${result.name}** accepted! The challenger now picks the game...`)] });
    const gameChoice = await promptGameSelection(guild, warChannel, war.challengerClan);
    // Delete the event now that the war is actually starting — no longer "upcoming"
    if (war.eventId) guild.scheduledEvents.delete(war.eventId).catch(() => {});
    await runWar(guild, warChannel, war.challengerClan, war.defenderClan, gameChoice);
    return;
  }

  // ── /clan-war-decline ───────────────────────────────────────────────────────
  if (commandName === 'clan-war-decline') {
    const result = getUserClan(guild.id, user.id);
    if (!result) return safeReply(interaction, { content: '❌ You are not in a clan.', flags: 64 });
    if (result.clan.leader !== user.id) return safeReply(interaction, { content: '❌ Only the Leader can decline a war.', flags: 64 });
    const war = activeWars[guild.id];
    if (!war || !war.pending) return safeReply(interaction, { content: '❌ No pending war challenge found.', flags: 64 });
    if (war.defenderClan !== result.name) return safeReply(interaction, { content: `❌ This challenge is for **${war.defenderClan}**, not your clan.`, flags: 64 });
    if (war.eventId) guild.scheduledEvents.delete(war.eventId).catch(() => {});
    const challengerName = war.challengerClan;
    delete activeWars[guild.id];
    return safeReply(interaction, { content: `🏳️ **${result.name}** declined the war challenge from **${challengerName}**.` });
  }
}

// ─── Pokemon System ───────────────────────────────────────────────────────────
// Loaded after client is defined so it can attach its own listeners and commands

require('./pokemon')({ client, db, saveData, getGuildClans, getUserClan });

// ─── Login ────────────────────────────────────────────────────────────────────

client.login(process.env.DISCORD_TOKEN);
