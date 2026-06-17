// ─── Libya Chat / Announce ───────────────────────────────────────────────────
// Two owner-only commands that post a message AS THE BOT so it appears to come
// from the bot, not from you:
//   /libya-chat     — plain text, no embed
//   /libya-announce — a flexible embed (title and/or message, optional colour)
//
// Both are locked to a single Discord user ID below. Anyone else who somehow
// runs them gets a private "not authorised" reply and nothing is posted.
//
// Wiring (in index.js):
//   1. const { getLibyaChatCommands, initLibyaChat } = require('./libya-chat');
//   2. add ...getLibyaChatCommands() to the command-registration array
//   3. call initLibyaChat(client); once, near your other init functions

const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');

// Only this user may use the commands.
const AUTHORIZED_USER_ID = '253230665586180096';

// Named colours offered in the /libya-announce dropdown. Add or change freely.
const COLORS = {
  green:  0x239E46,   // Libya green (default)
  red:    0xED4245,
  orange: 0xE67E22,
  gold:   0xF1C40F,
  blue:   0x3498DB,
  purple: 0x9B59B6,
  pink:   0xE91E63,
  grey:   0x95A5A6,
  black:  0x2C2F33,
  white:  0xECF0F1,
};
const DEFAULT_COLOR = COLORS.green;   // used when no colour is chosen (fast in emergencies)

function getLibyaChatCommands() {
  return [
    // ── Plain text, posted as the bot ──────────────────────────────────────
    new SlashCommandBuilder()
      .setName('libya-chat')
      .setDescription('Post a plain message as the bot (owner only)')
      .setDMPermission(false)
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addStringOption(o =>
        o.setName('message').setDescription('The text to post as the bot').setRequired(true)),

    // ── Flexible embed ─────────────────────────────────────────────────────
    new SlashCommandBuilder()
      .setName('libya-announce')
      .setDescription('Post an embed announcement as the bot — title and/or message, optional colour (owner only)')
      .setDMPermission(false)
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addStringOption(o =>
        o.setName('title').setDescription('Embed title / header (optional)').setRequired(false))
      .addStringOption(o =>
        o.setName('message').setDescription('Embed body text (optional — leave empty for a title-only header)').setRequired(false))
      .addStringOption(o =>
        o.setName('color').setDescription('Embed colour (optional — defaults to green)').setRequired(false)
          .addChoices(
            { name: '🟢 Green (default)', value: 'green'  },
            { name: '🔴 Red',            value: 'red'    },
            { name: '🟠 Orange',         value: 'orange' },
            { name: '🟡 Gold',           value: 'gold'   },
            { name: '🔵 Blue',           value: 'blue'   },
            { name: '🟣 Purple',         value: 'purple' },
            { name: '🌸 Pink',           value: 'pink'   },
            { name: '⚪ Grey',           value: 'grey'   },
            { name: '⚫ Black',          value: 'black'  },
            { name: '⬜ White',          value: 'white'  },
          )),
  ].map(c => c.toJSON());
}

function initLibyaChat(client) {
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const { commandName } = interaction;
    if (commandName !== 'libya-chat' && commandName !== 'libya-announce') return;

    // ── Hard owner gate — the definitive check, regardless of roles ──────────
    if (interaction.user.id !== AUTHORIZED_USER_ID) {
      return interaction.reply({ content: '🚫 You are not authorised to use this command.', flags: 64 }).catch(() => {});
    }

    if (!interaction.channel) {
      return interaction.reply({ content: '⚠️ I can\'t find a channel to post in here.', flags: 64 }).catch(() => {});
    }

    try {
      if (commandName === 'libya-chat') {
        const text = interaction.options.getString('message');
        await interaction.channel.send({
          content: text,
          // Owner-only tool, so allow it to ping people in announcements.
          allowedMentions: { parse: ['users', 'roles', 'everyone'] },
        });
        return interaction.reply({ content: '✅ Posted.', flags: 64 });
      }

      // commandName === 'libya-announce'
      const title   = interaction.options.getString('title');
      const message = interaction.options.getString('message');
      const colorKey = interaction.options.getString('color');

      if (!title && !message) {
        return interaction.reply({ content: '⚠️ Give me at least a **title** or a **message** to post.', flags: 64 });
      }

      const embed = new EmbedBuilder().setColor(COLORS[colorKey] || DEFAULT_COLOR);
      if (title)   embed.setTitle(title);
      if (message) embed.setDescription(message);

      await interaction.channel.send({
        embeds: [embed],
        allowedMentions: { parse: ['users', 'roles', 'everyone'] },
      });
      return interaction.reply({ content: '✅ Announcement posted.', flags: 64 });

    } catch (err) {
      console.error('libya-chat failed:', err.message);
      const msg = { content: `⚠️ Couldn't post that: ${err.message}`, flags: 64 };
      return interaction.replied ? interaction.followUp(msg).catch(() => {}) : interaction.reply(msg).catch(() => {});
    }
  });
}

module.exports = { getLibyaChatCommands, initLibyaChat };
