// battlecards.js — "Battle Cards": a hidden-information 2-player card duel for Discord.
//
// Each player gets 5 cards. Each round both secretly pick one card (via an ephemeral
// hand of buttons). The bot reveals both side-by-side; the higher card scores a point.
// First to the target (3 or 5) wins. Card art is served from deckofcardsapi.com's static
// images; the deck itself is drawn from the Deck of Cards API with a local fallback so a
// game never breaks if the API is unreachable.

const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
} = require('discord.js');
const { getDinar, spendDinar, awardDinar } = require('./gacha');

// ─── Betting ───────────────────────────────────────────────────────────────
const BET_MIN  = 1;
const BET_MAX  = 10000;       // max wager per player
const RAKE_PCT = 0.05;        // table fee skimmed from the pot to the void (Dinar sink). Set 0 for winner-takes-all.

// ─── Card helpers ────────────────────────────────────────────────────────────
const SUITS        = ['S', 'H', 'D', 'C'];
const SUIT_SYMBOL  = { S: '♠', H: '♥', D: '♦', C: '♣' };
const RANKS        = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '0', 'J', 'Q', 'K'];
const RANK_VALUE   = { A: 14, K: 13, Q: 12, J: 11, '0': 10, '9': 9, '8': 8, '7': 7, '6': 6, '5': 5, '4': 4, '3': 3, '2': 2 };
const RANK_LABEL   = { '0': '10', A: 'A', K: 'K', Q: 'Q', J: 'J', '9': '9', '8': '8', '7': '7', '6': '6', '5': '5', '4': '4', '3': '3', '2': '2' };
const cardImage    = (code) => `https://deckofcardsapi.com/static/img/${code}.png`;

function cardFromCode(code) {
  const rank = code.slice(0, -1);
  const suit = code.slice(-1);
  return {
    code, rank, suit,
    value: RANK_VALUE[rank],
    label: `${RANK_LABEL[rank]}${SUIT_SYMBOL[suit]}`,
    red:   suit === 'H' || suit === 'D',
    image: cardImage(code),
  };
}

function localShuffledDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push(r + s);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// Draw 10 cards (5 per player). Tries the Deck of Cards API; falls back to a local deck.
async function dealHands() {
  try {
    const res  = await fetch('https://deckofcardsapi.com/api/deck/new/draw/?count=10', { signal: AbortSignal.timeout(6000) });
    const data = await res.json();
    if (data && data.success && Array.isArray(data.cards) && data.cards.length === 10) {
      const cards = data.cards.map(c => {
        const card = cardFromCode(c.code);
        if (c.image) card.image = c.image;
        return card;
      });
      return [cards.slice(0, 5), cards.slice(5, 10)];
    }
  } catch { /* fall through to local */ }
  const cards = localShuffledDeck().slice(0, 10).map(cardFromCode);
  return [cards.slice(0, 5), cards.slice(5, 10)];
}

function getBattleCardsCommands() {
  return [
    new SlashCommandBuilder()
      .setName('battlecards')
      .setDescription('Challenge someone to a Battle Cards duel — secret cards, highest wins!')
      .setDMPermission(false)
      .addUserOption(o => o.setName('opponent').setDescription('Who you want to duel').setRequired(true))
      .addIntegerOption(o => o.setName('target').setDescription('Points needed to win (default 3)')
        .addChoices({ name: 'First to 3', value: 3 }, { name: 'First to 5', value: 5 }))
      .addIntegerOption(o => o.setName('bet').setDescription('Dinar to wager each — winner takes the pot (0 = friendly)')
        .setMinValue(0).setMaxValue(BET_MAX)),
  ];
}

// ─── Game engine ─────────────────────────────────────────────────────────────
function initBattleCards({ client, db, saveData }) {
  const games = new Map();                    // gameId -> game
  let seq = 0;
  const newId = () => `${Date.now().toString(36)}${(seq++ % 1000).toString(36)}`;

  const CHALLENGE_TIMEOUT_MS = 90 * 1000;     // accept within 90s
  const IDLE_TIMEOUT_MS      = 5 * 60 * 1000; // 5 min of no moves ends the game
  const COLOR = { blue: 0x3B82F6, red: 0xEF4444, gold: 0xF1C40F, grey: 0x95A5A6, green: 0x22C55E };

  const eph = (content) => ({ content, flags: 64 });

  function clearTimer(g) { if (g && g.timer) { clearTimeout(g.timer); g.timer = null; } }
  function armTimer(g, ms, fn) { clearTimer(g); g.timer = setTimeout(fn, ms); }

  async function editPublic(g, payload) {
    try {
      const ch  = await client.channels.fetch(g.channelId);
      const msg = ch.messages.cache.get(g.messageId) || await ch.messages.fetch(g.messageId);
      await msg.edit(payload);
    } catch { /* message deleted or inaccessible */ }
  }

  async function expireChallenge(gameId) {
    const g = games.get(gameId);
    if (!g || g.status !== 'pending') return;
    games.delete(gameId);
    await editPublic(g, { embeds: [new EmbedBuilder().setColor(COLOR.grey)
      .setTitle('🎴 Battle Cards — Challenge Expired')
      .setDescription(`**${g.p2Name}** didn't respond in time.`)], components: [] });
  }

  async function abandonGame(gameId) {
    const g = games.get(gameId);
    if (!g) return;
    clearTimer(g);
    let note = '';
    if (g.bet > 0 && g.escrowed) {                 // never let a glitch/timeout pocket the stakes
      g.escrowed = false;
      awardDinar(db, g.guildId, g.p1, g.bet, saveData);
      awardDinar(db, g.guildId, g.p2, g.bet, saveData);
      note = `\n\n💰 Both wagers (**${g.bet} Dinar** each) have been refunded.`;
    }
    games.delete(gameId);
    await editPublic(g, { embeds: [new EmbedBuilder().setColor(COLOR.grey)
      .setTitle('🎴 Battle Cards — Ended')
      .setDescription(`The duel was abandoned (no moves for a while).${note}`)], components: [] });
  }

  // ── Rendering ──
  function scoreboard(g) {
    const pot = g.bet > 0 ? ` · 💰 Pot ${g.bet * 2}` : '';
    return `🟦 **${g.p1Name}**  \`${g.scores[g.p1]}\` — \`${g.scores[g.p2]}\`  **${g.p2Name}** 🟥\n` +
           `*First to ${g.target} · Round ${g.round}/5${pot}*`;
  }

  function chooseButton(g, label = '🎴 Choose your card') {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`bc:${g.id}:choose`).setLabel(label).setStyle(ButtonStyle.Primary));
  }

  function handRow(g, uid) {
    const row = new ActionRowBuilder();
    for (const card of g.hands[uid]) {
      row.addComponents(new ButtonBuilder()
        .setCustomId(`bc:${g.id}:pick:${card.code}`)
        .setLabel(card.label)
        .setStyle(card.red ? ButtonStyle.Danger : ButtonStyle.Secondary));
    }
    return row;
  }

  function roundPrompt(g) {
    const lockP1 = g.choices[g.p1] ? '✅' : '⏳';
    const lockP2 = g.choices[g.p2] ? '✅' : '⏳';
    const embed = new EmbedBuilder().setColor(COLOR.gold)
      .setTitle('🎴 Battle Cards')
      .setDescription(
        `${scoreboard(g)}\n\n` +
        `${lockP1} ${g.p1Name}　•　${g.p2Name} ${lockP2}\n\n` +
        `Both players: tap **Choose your card** to secretly pick from your hand.`);
    return { embeds: [embed], components: [chooseButton(g)] };
  }

  // Reveal both cards side-by-side (two embeds sharing a URL render as a gallery),
  // then either prompt the next round or declare the winner.
  function revealMessage(g, c1, c2, resultText, over) {
    const gallery = [
      new EmbedBuilder().setColor(over ? COLOR.green : COLOR.gold)
        .setTitle('🎴 Battle Cards — Reveal')
        .setURL('https://deckofcardsapi.com')
        .setDescription(
          `**${g.p1Name}** played **${c1.label}**　vs　**${g.p2Name}** played **${c2.label}**\n\n` +
          `${resultText}\n\n${scoreboard(g)}`)
        .setImage(c1.image),
      new EmbedBuilder().setURL('https://deckofcardsapi.com').setImage(c2.image),
    ];
    let components;
    if (over) {
      let ending;
      if (g.scores[g.p1] > g.scores[g.p2])      ending = `🏆 **${g.p1Name}** wins the duel **${g.scores[g.p1]}–${g.scores[g.p2]}**!`;
      else if (g.scores[g.p2] > g.scores[g.p1]) ending = `🏆 **${g.p2Name}** wins the duel **${g.scores[g.p2]}–${g.scores[g.p1]}**!`;
      else                                      ending = `🤝 It's a draw — **${g.scores[g.p1]}–${g.scores[g.p2]}**!`;
      if (g.bet > 0) {
        if (g.scores[g.p1] === g.scores[g.p2]) {
          ending += `\n💰 Draw — both wagers (**${g.bet} Dinar** each) refunded.`;
        } else {
          const winnerName = g.scores[g.p1] > g.scores[g.p2] ? g.p1Name : g.p2Name;
          const feeNote = g.rake ? ` *(after a ${Math.round(RAKE_PCT * 100)}% table fee)*` : '';
          ending += `\n💰 **${winnerName}** takes the pot: **+${g.payout} Dinar**!${feeNote}`;
        }
      }
      gallery[0].setDescription(
        `**${g.p1Name}** played **${c1.label}**　vs　**${g.p2Name}** played **${c2.label}**\n\n` +
        `${resultText}\n\n${ending}`);
      components = [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`bc:${g.id}:rematch`).setLabel('🔁 Rematch').setStyle(ButtonStyle.Success))];
    } else {
      components = [chooseButton(g, `🎴 Round ${g.round} — Choose your card`)];
    }
    return { embeds: gallery, components };
  }

  // ── Round resolution ──
  async function resolveRound(g) {
    const c1 = g.choices[g.p1];
    const c2 = g.choices[g.p2];
    let resultText;
    if (c1.value > c2.value)      { g.scores[g.p1]++; resultText = `🏆 **${c1.label}** beats **${c2.label}** — **${g.p1Name}** scores!`; }
    else if (c2.value > c1.value) { g.scores[g.p2]++; resultText = `🏆 **${c2.label}** beats **${c1.label}** — **${g.p2Name}** scores!`; }
    else                          { resultText = `🤝 Both played **${c1.label}** value — it's a tie, no point.`; }

    const finishedRound = g.round;
    const over = g.scores[g.p1] >= g.target || g.scores[g.p2] >= g.target || g.hands[g.p1].length === 0;

    if (over) {
      clearTimer(g);
      g.status = 'done';
      // settle the wager
      if (g.bet > 0 && g.escrowed) {
        g.escrowed = false;
        if (g.scores[g.p1] === g.scores[g.p2]) {              // draw → refund both stakes
          awardDinar(db, g.guildId, g.p1, g.bet, saveData);
          awardDinar(db, g.guildId, g.p2, g.bet, saveData);
        } else {                                               // winner takes the pot minus the rake
          const winner = g.scores[g.p1] > g.scores[g.p2] ? g.p1 : g.p2;
          const pot    = g.bet * 2;
          g.rake   = Math.floor(pot * RAKE_PCT);
          g.payout = pot - g.rake;
          awardDinar(db, g.guildId, winner, g.payout, saveData);
        }
      }
      // keep the game around briefly so the Rematch button works
      armTimer(g, IDLE_TIMEOUT_MS, () => games.delete(g.id));
    } else {
      g.round = finishedRound + 1;
      g.choices = { [g.p1]: null, [g.p2]: null };
      armTimer(g, IDLE_TIMEOUT_MS, () => abandonGame(g.id));
    }
    await editPublic(g, revealMessage(g, c1, c2, resultText, over));
  }

  // ── Start / restart a match ──
  async function beginMatch(g) {
    const [h1, h2] = await dealHands();
    g.hands   = { [g.p1]: h1, [g.p2]: h2 };
    g.scores  = { [g.p1]: 0, [g.p2]: 0 };
    g.choices = { [g.p1]: null, [g.p2]: null };
    g.round   = 1;
    g.status  = 'playing';
    armTimer(g, IDLE_TIMEOUT_MS, () => abandonGame(g.id));
  }

  // ── Interaction routing ──
  client.on('interactionCreate', async (interaction) => {
    try {
      if (interaction.isChatInputCommand() && interaction.commandName === 'battlecards') {
        return onChallenge(interaction);
      }
      if (interaction.isButton() && interaction.customId.startsWith('bc:')) {
        const [, gameId, action, arg] = interaction.customId.split(':');
        return onButton(interaction, gameId, action, arg);
      }
    } catch (e) {
      console.error('[battlecards]', e);
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        interaction.reply(eph('⚠️ Something went wrong with that action.')).catch(() => {});
      }
    }
  });

  async function onChallenge(interaction) {
    const challenger = interaction.user;
    const opponent   = interaction.options.getUser('opponent');
    const target     = interaction.options.getInteger('target') || 3;
    const bet        = interaction.options.getInteger('bet') || 0;

    if (opponent.id === challenger.id) return interaction.reply(eph("🎴 You can't duel yourself!"));
    if (opponent.bot)                  return interaction.reply(eph("🎴 You can't duel a bot."));
    if (bet > 0 && getDinar(db, interaction.guild.id, challenger.id) < bet)
      return interaction.reply(eph(`💸 You don't have **${bet} Dinar** to wager — you have **${getDinar(db, interaction.guild.id, challenger.id)}**.`));

    const id = newId();
    const g = {
      id,
      guildId: interaction.guild.id,
      channelId: interaction.channelId,
      messageId: null,
      p1: challenger.id, p2: opponent.id,
      p1Name: interaction.member?.displayName || challenger.username,
      p2Name: opponent.username,
      target, bet, escrowed: false, status: 'pending', timer: null,
    };
    // resolve the opponent's nickname if available
    try { const m = await interaction.guild.members.fetch(opponent.id); if (m?.displayName) g.p2Name = m.displayName; } catch {}
    games.set(id, g);

    const wagerLine = bet > 0 ? `\n💰 **Wager: ${bet} Dinar each** — winner takes the pot!` : '';
    const embed = new EmbedBuilder().setColor(COLOR.blue)
      .setTitle('🎴 Battle Cards — Challenge!')
      .setDescription(
        `**${g.p1Name}** challenges **${g.p2Name}** to a duel!\n\n` +
        `Each player gets 5 cards, secretly play one per round, highest card scores.\n` +
        `**First to ${target} points wins.**${wagerLine}\n\n` +
        `<@${opponent.id}>, do you accept?`);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`bc:${id}:accept`).setLabel('✅ Accept').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`bc:${id}:decline`).setLabel('❌ Decline').setStyle(ButtonStyle.Danger));

    await interaction.reply({ content: `<@${opponent.id}>`, embeds: [embed], components: [row], allowedMentions: { users: [opponent.id] } });
    const msg = await interaction.fetchReply();
    g.messageId = msg.id;
    armTimer(g, CHALLENGE_TIMEOUT_MS, () => expireChallenge(id));
  }

  async function onButton(interaction, gameId, action, arg) {
    const g = games.get(gameId);
    if (!g) return interaction.reply(eph('🎴 This game has ended.')).catch(() => {});
    const uid = interaction.user.id;
    const isPlayer = uid === g.p1 || uid === g.p2;

    // ── Accept / Decline (only the challenged player) ──
    if (action === 'accept' || action === 'decline') {
      if (uid !== g.p2) return interaction.reply(eph('🎴 This challenge isn’t for you.'));
      if (g.status !== 'pending') return interaction.reply(eph('🎴 This challenge was already answered.'));
      if (action === 'decline') {
        clearTimer(g); games.delete(g.id);
        return interaction.update({ embeds: [new EmbedBuilder().setColor(COLOR.grey)
          .setTitle('🎴 Battle Cards — Declined')
          .setDescription(`**${g.p2Name}** declined the duel.`)], components: [] });
      }
      // accept: place the wager (if any) before the game starts
      if (g.bet > 0) {
        if (getDinar(db, g.guildId, g.p2) < g.bet)
          return interaction.reply(eph(`💸 You don't have **${g.bet} Dinar** to match this wager — you have **${getDinar(db, g.guildId, g.p2)}**.`));
        if (getDinar(db, g.guildId, g.p1) < g.bet) {
          clearTimer(g); games.delete(g.id);
          return interaction.update({ embeds: [new EmbedBuilder().setColor(COLOR.grey)
            .setTitle('🎴 Battle Cards — Cancelled')
            .setDescription(`**${g.p1Name}** no longer has **${g.bet} Dinar** for the wager. Duel cancelled.`)], components: [] });
        }
      }
      // dealing may call the API, so acknowledge first
      await interaction.deferUpdate();
      if (g.bet > 0) {
        const ok1 = spendDinar(db, g.guildId, g.p1, g.bet, saveData);
        const ok2 = spendDinar(db, g.guildId, g.p2, g.bet, saveData);
        if (!ok1 || !ok2) {                                   // race-safe: refund any partial charge
          if (ok1) awardDinar(db, g.guildId, g.p1, g.bet, saveData);
          if (ok2) awardDinar(db, g.guildId, g.p2, g.bet, saveData);
          clearTimer(g); games.delete(g.id);
          return interaction.editReply({ embeds: [new EmbedBuilder().setColor(COLOR.grey)
            .setTitle('🎴 Battle Cards — Cancelled')
            .setDescription('Couldn’t place the wager (insufficient Dinar). Any stake has been refunded.')], components: [] });
        }
        g.escrowed = true;
      }
      await beginMatch(g);
      return interaction.editReply(roundPrompt(g));
    }

    if (!isPlayer) return interaction.reply(eph('🎴 You’re not in this duel.'));
    if (g.status !== 'playing') return interaction.reply(eph('🎴 This duel isn’t active right now.'));

    // ── Open your hand ──
    if (action === 'choose') {
      if (g.choices[uid]) return interaction.reply(eph(`🔒 You already locked in **${g.choices[uid].label}**. Waiting for your opponent…`));
      return interaction.reply({ content: '🎴 **Your hand** — pick a card to play this round:', components: [handRow(g, uid)], flags: 64 });
    }

    // ── Pick a card ──
    if (action === 'pick') {
      if (g.choices[uid]) return interaction.update({ content: `🔒 You already locked in **${g.choices[uid].label}**.`, components: [] });
      const idx = g.hands[uid].findIndex(c => c.code === arg);
      if (idx === -1) return interaction.update({ content: '🎴 That card is no longer in your hand.', components: [] });

      const [card] = g.hands[uid].splice(idx, 1);   // remove from hand and lock it in
      g.choices[uid] = card;
      armTimer(g, IDLE_TIMEOUT_MS, () => abandonGame(g.id));

      const bothChosen = g.choices[g.p1] && g.choices[g.p2];
      await interaction.update({ content: `🔒 Locked in **${card.label}**.${bothChosen ? ' Revealing…' : ' Waiting for your opponent…'}`, components: [] });
      if (bothChosen) await resolveRound(g);
      else            await editPublic(g, roundPrompt(g));
      return;
    }

    // ── Rematch ──
    if (action === 'rematch') {
      if (g.status !== 'done') return interaction.reply(eph('🎴 The duel isn’t over yet.'));
      if (g.bet > 0 && (getDinar(db, g.guildId, g.p1) < g.bet || getDinar(db, g.guildId, g.p2) < g.bet))
        return interaction.reply(eph(`💸 Both players need **${g.bet} Dinar** for a rematch wager.`));
      await interaction.deferUpdate();
      if (g.bet > 0) {
        const ok1 = spendDinar(db, g.guildId, g.p1, g.bet, saveData);
        const ok2 = spendDinar(db, g.guildId, g.p2, g.bet, saveData);
        if (!ok1 || !ok2) {
          if (ok1) awardDinar(db, g.guildId, g.p1, g.bet, saveData);
          if (ok2) awardDinar(db, g.guildId, g.p2, g.bet, saveData);
          return interaction.editReply({ embeds: [new EmbedBuilder().setColor(COLOR.grey)
            .setTitle('🎴 Battle Cards — Rematch Cancelled')
            .setDescription('Couldn’t place the rematch wager (insufficient Dinar). Any stake refunded.')], components: [] });
        }
        g.escrowed = true;
      }
      g.status = 'pending';
      await beginMatch(g);
      return interaction.editReply(roundPrompt(g));
    }
  }
}

module.exports = { getBattleCardsCommands, initBattleCards };
