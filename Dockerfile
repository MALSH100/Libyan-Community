FROM mcr.microsoft.com/playwright:v1.60.0-jammy

WORKDIR /app

COPY package*.json ./

# Install all dependencies (including rss-parser)
RUN npm install

# Install additional packages (keep for compatibility)
RUN npm install axios cheerio

COPY . .

CMD ["node", "index.js"]
