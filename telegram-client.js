// telegram-client.js
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

const apiId = parseInt(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const sessionString = process.env.TELEGRAM_SESSION || '';

let _client = null;
let _initialized = false;

async function getTelegramClient() {
    if (_client && _initialized) return _client;
    
    if (!apiId || !apiHash) {
        throw new Error('TELEGRAM_API_ID and TELEGRAM_API_HASH must be set in environment variables.');
    }
    if (!sessionString) {
        throw new Error('TELEGRAM_SESSION not set. Please generate a session string first.');
    }
    
    const stringSession = new StringSession(sessionString);
    _client = new TelegramClient(stringSession, apiId, apiHash, {
        connectionRetries: 5,
    });
    
    await _client.start({
        phoneNumber: async () => '',
        phoneCode: async () => '',
        password: async () => '',
        onError: (err) => console.error('Telegram client error:', err),
    });
    
    _initialized = true;
    return _client;
}

async function getLatestMessage(channelUsername) {
    const client = await getTelegramClient();
    const channel = await client.getEntity(channelUsername);
    const messages = await client.getMessages(channel, { limit: 1 });
    return messages.length ? messages[0] : null;
}

async function downloadVideoBuffer(message) {
    if (!message.media || !message.video) return null;
    const client = await getTelegramClient();
    try {
        const buffer = await client.downloadMedia(message.media, { outputFile: undefined });
        return buffer;
    } catch (err) {
        console.error('[Telegram] Failed to download video:', err.message);
        return null;
    }
}

module.exports = { getTelegramClient, getLatestMessage, downloadVideoBuffer };
