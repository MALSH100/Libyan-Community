// translator.js
const { translate } = require('@vitalets/google-translate-api');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const processedMessages = new Set();

function containsArabic(text) {
    const arabicRegex = /[\u0600-\u06FF]/;
    return arabicRegex.test(text);
}

module.exports = function initTranslator(client) {
    // Step 1: Detect Arabic messages and attach a Translate button
    client.on('messageCreate', async (message) => {
        if (message.author.bot) return;
        if (!message.content) return;
        if (processedMessages.has(message.id)) return;
        if (!containsArabic(message.content)) return;

        processedMessages.add(message.id);
        setTimeout(() => processedMessages.delete(message.id), 60000); // 1 minute cooldown

        const button = new ButtonBuilder()
            .setCustomId(`translate_${message.id}`)
            .setLabel('Translate 🔁')
            .setStyle(ButtonStyle.Secondary);

        const row = new ActionRowBuilder().addComponents(button);

        // Reply to the message with a button
        await message.reply({
            content: '> 🌐 This message is in Arabic. Click the button to translate.',
            components: [row],
        });
    });

    // Step 2: Handle button click – ephemeral translation
    client.on('interactionCreate', async (interaction) => {
        if (!interaction.isButton()) return;
        if (!interaction.customId.startsWith('translate_')) return;

        // Defer the reply ephemerally (only the clicker will see the result)
        await interaction.deferReply({ ephemeral: true });

        const messageId = interaction.customId.replace('translate_', '');

        try {
            // Fetch the original message from the channel
            const targetMessage = await interaction.channel.messages.fetch(messageId);
            const originalText = targetMessage.content;

            // Translate from Arabic to English
            const { text: translated } = await translate(originalText, { to: 'en' });

            // Send the ephemeral translation
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
};
