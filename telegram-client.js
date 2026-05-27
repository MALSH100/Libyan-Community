// telegram-client.js
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const input = require('input'); // for interactive login on first run

const apiId = parseInt(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const sessionString = process.env.TELEGRAM_SESSION || '';

let client = null;

async function getClient() {
    if (client) return client;
    
    const stringSession = new StringSession(sessionString);
    client = new TelegramClient(stringSession, apiId, apiHash, {
        connectionRetries: 5,
    });
    
    await client.start({
        phoneNumber: async () => await input.text('Enter your phone number: '),
        password: async () => await input.text('Enter your password (if any): '),
        phoneCode: async () => await input.text('Enter the code you received: '),
        onError: (err) => console.error(err),
    });
    
    // Save session string to environment variable for future runs
    const newSession = client.session.save();
    if (newSession !== sessionString) {
        console.log('New session string:', newSession);
        // You'll need to manually set this in Railway env vars
    }
    
    return client;
}

async function getLatestMessage(channelUsername) {
    const client = await getClient();
    const channel = await client.getEntity(channelUsername);
    const messages = await client.getMessages(channel, { limit: 1 });
    return messages[0];
}

module.exports = { getLatestMessage };