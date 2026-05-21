# Use Microsoft's official Playwright image — includes all Chromium system dependencies
# libglib, libX11, and all other required libraries are pre-installed
FROM mcr.microsoft.com/playwright:v1.52.0-jammy

WORKDIR /app

# Copy package files first for better Docker layer caching
COPY package*.json ./

# Install Node dependencies
# Playwright browsers are already installed in the base image — no need for postinstall
RUN npm install --omit=dev

# Copy all bot files
COPY . .

# Start the bot
CMD ["node", "index.js"]
