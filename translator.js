// translator.js
const { SlashCommandBuilder } = require('discord.js');
const { translate } = require('@vitalets/google-translate-api');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const processedMessages = new Set();

function containsArabic(text) {
    const arabicRegex = /[\u0600-\u06FF]/;
    return arabicRegex.test(text);
}

// ─── Helper to get/set user translation preference ─────────────────
function getUserTranslatorPref(db, guildId, userId) {
    if (!db[guildId]) db[guildId] = {};
    if (!db[guildId].__translator) db[guildId].__translator = {};
    if (db[guildId].__translator[userId] === undefined) {
        db[guildId].__translator[userId] = true; // enabled by default
    }
    return db[guildId].__translator[userId];
}

function setUserTranslatorPref(db, guildId, userId, enabled) {
    if (!db[guildId]) db[guildId] = {};
    if (!db[guildId].__translator) db[guildId].__translator = {};
    db[guildId].__translator[userId] = enabled;
}

// ─── Slash command definition (to be exported) ─────────────────────
const translatorCommands = [
    new SlashCommandBuilder()
        .setName('libyan-translation')
        .setDescription('Enable or disable automatic translation buttons for your messages')
        .addStringOption(option =>
            option.setName('status')
                .setDescription('on or off')
                .setRequired(true)
                .addChoices(
                    { name: 'On (show translate button)', value: 'on' },
                    { name: 'Off (hide translate button)', value: 'off' }
                ))
        .setDMPermission(false),
];

// ─── Module initialisation ─────────────────────────────────────────
module.exports = function initTranslator(client, db, saveData) {
    // Step 1: Detect Arabic messages and attach a Translate button (if user has it enabled)
    client.on('messageCreate', async (message) => {
        if (message.author.bot) return;
        if (!message.content) return;
        if (processedMessages.has(message.id)) return;
        if (!containsArabic(message.content)) return;

        // Check user preference
        const pref = getUserTranslatorPref(db, message.guild.id, message.author.id);
        if (!pref) return; // user disabled translations

        processedMessages.add(message.id);
        setTimeout(() => processedMessages.delete(message.id), 60000);

        const button = new ButtonBuilder()
            .setCustomId(`translate_${message.id}`)
            .setLabel('Translate 🔁')
            .setStyle(ButtonStyle.Secondary);

        const row = new ActionRowBuilder().addComponents(button);

        await message.reply({
            content: '> 🌐 This message is in Arabic. Click the button to translate, or use `/libyan-translation off` to disable this feature.',
            components: [row],
        });
    });

    // Step 2: Handle button click – ephemeral translation
    client.on('interactionCreate', async (interaction) => {
        if (!interaction.isButton()) return;
        if (!interaction.customId.startsWith('translate_')) return;

        await interaction.deferReply({ ephemeral: true });

        const messageId = interaction.customId.replace('translate_', '');

        try {
            const targetMessage = await interaction.channel.messages.fetch(messageId);
            const originalText = targetMessage.content;
            const { text: translated } = await translate(originalText, { to: 'en' });

            await interaction.editReply({
                content: `**🔹 Original (Arabic):**\n${originalText}\n\n**🔸 Translation (English):**\n${translated}`,
            });
        } catch (err) {
            console.error('Translator error:', err.message);
            await interaction.editReply({
                content: '❌ Could not translate this message. The language might not be supported or the service is unavailable.',
            });
        }
    });

    // Step 3: Handle the /libyan-translation slash command
    client.on('interactionCreate', async (interaction) => {
        if (!interaction.isCommand()) return;
        if (interaction.commandName !== 'libyan-translation') return;
        if (!interaction.guild) return;

        const status = interaction.options.getString('status');
        const enabled = status === 'on';
        const userId = interaction.user.id;
        const guildId = interaction.guild.id;

        setUserTranslatorPref(db, guildId, userId, enabled);
        saveData(guildId);

        await interaction.reply({
            content: `✅ Translation buttons are now **${enabled ? 'enabled' : 'disabled'}** for your messages.`,
            flags: 64,
        });
    });
};

// Export commands so index.js can register them
module.exports.commands = translatorCommands;
