// translator.js
const { translate } = require('@vitalets/google-translate-api');

// Cooldown map to avoid reacting to the same message multiple times
const processedMessages = new Set();

// Detect if text contains Arabic characters
function containsArabic(text) {
    const arabicRegex = /[\u0600-\u06FF]/;
    return arabicRegex.test(text);
}

// Remove any existing translation reactions (optional, keeps clean)
async function removeExistingTranslationReaction(message, emoji) {
    const reactions = message.reactions.cache.get(emoji);
    if (reactions) {
        const users = await reactions.users.fetch();
        if (users.has(message.client.user.id)) {
            await message.reactions.resolve(emoji).remove();
        }
    }
}

module.exports = function initTranslator(client) {
    client.on('messageCreate', async (message) => {
        // Ignore bots, empty messages, and already processed messages
        if (message.author.bot) return;
        if (!message.content) return;
        if (processedMessages.has(message.id)) return;

        // Only react if message contains Arabic
        if (!containsArabic(message.content)) return;

        // Add to cooldown to avoid duplicate reactions
        processedMessages.add(message.id);
        setTimeout(() => processedMessages.delete(message.id), 60_000); // expire after 1 minute

        const emoji = '🇬🇧'; // or any custom emoji you prefer

        try {
            // Remove any existing bot reaction with the same emoji (optional)
            await removeExistingTranslationReaction(message, emoji);
            // Add the reaction
            await message.react(emoji);
        } catch (err) {
            console.error('Translator: Could not add reaction', err.message);
            return;
        }

        // Create a reaction collector (only for this emoji, from any user)
        const filter = (reaction, user) => reaction.emoji.name === emoji && !user.bot;
        const collector = message.createReactionCollector({ filter, max: 1, time: 60000 });

        collector.on('collect', async (reaction, user) => {
            try {
                // Fetch the original message again (in case it's partial)
                const fullMessage = await message.fetch();
                const originalText = fullMessage.content;
                if (!originalText) {
                    await user.send('❌ No text to translate.').catch(() => {});
                    return;
                }

                // Translate to English
                const { text: translated } = await translate(originalText, { to: 'en' });

                // Send an ephemeral reply to the user who clicked
                await reaction.message.reply({
                    content: `**🔹 Original (Arabic):**\n${originalText}\n\n**🔸 Translation (English):**\n${translated}`,
                    flags: 64, // ephemeral – only visible to the clicking user
                });
            } catch (err) {
                console.error('Translator error:', err.message);
                await reaction.message.reply({
                    content: '❌ Could not translate this message. The language might not be supported or the service is unavailable.',
                    flags: 64,
                }).catch(() => {});
            }
        });
    });
};