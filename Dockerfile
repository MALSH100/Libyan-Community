FROM mcr.microsoft.com/playwright:v1.60.0-jammy

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev

# Install axios and cheerio for the Libya news scraper
RUN npm install axios cheerio

COPY . .

CMD ["node", "index.js"]
