// translator.js
const { translate } = require('@vitalets/google-translate-api');

// Cooldown map to avoid reacting to the same message multiple times
const processedMessages = new Set();

// Detect if text contains Arabic characters
function containsArabic(text) {
    const arabicRegex = /[\u0600-\u06FF]/;
    return arabicRegex.test(text);
}

module.exports = function initTranslator(client) {
    client.on('messageCreate', async (message) => {
        if (message.author.bot) return;
        if (!message.content) return;
        if (processedMessages.has(message.id)) return;

        if (!containsArabic(message.content)) return;

        // Mark as processed to avoid duplicate reactions
        processedMessages.add(message.id);
        setTimeout(() => processedMessages.delete(message.id), 60000); // 1 minute

        const emoji = '🔁'; // repeat emoji

        try {
            await message.react(emoji);
        } catch (err) {
            console.error('Translator: Could not add reaction', err.message);
            return;
        }

        // Collector: only when someone clicks this specific reaction (not the bot)
        const filter = (reaction, user) => reaction.emoji.name === emoji && !user.bot;
        const collector = message.createReactionCollector({ filter, max: 1, time: 60000 });

        collector.on('collect', async (reaction, user) => {
            try {
                // Remove the reaction immediately so it's clean for next time
                await reaction.users.remove(user.id).catch(() => {});

                const originalText = message.content;
                if (!originalText) {
                    await user.send('❌ No text to translate.').catch(() => {});
                    return;
                }

                const { text: translated } = await translate(originalText, { to: 'en' });

                // Ephemeral reply (only visible to the user who clicked)
                await message.reply({
                    content: `**🔹 Original (Arabic):**\n${originalText}\n\n**🔸 Translation (English):**\n${translated}`,
                    flags: 64,
                });
            } catch (err) {
                console.error('Translator error:', err.message);
                await user.send('❌ Could not translate this message. The language might not be supported or the service is unavailable.')
                    .catch(() => {});
            }
        });
    });
};
