# Slim Node base (~150 MB) instead of the Playwright image (~2 GB with 3 browsers).
# Nothing in the bot launches a browser anymore — chart PNGs are rendered by
# @resvg/resvg-js, a small native library, so the browser image is dead weight.
FROM node:20-slim

WORKDIR /app

# resvg draws the chart's text labels; install one small font so they aren't
# blank. fonts-dejavu-core is ~1 MB and is the renderer's configured fallback.
RUN apt-get update \
 && apt-get install -y --no-install-recommends fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
# --omit=dev skips devDependencies but keeps optionalDependencies, which is how
# @resvg/resvg-js ships its prebuilt native binary — so don't use --no-optional.
RUN npm install --omit=dev

COPY . .

# Uses the start script, which applies the --max-old-space-size heap cap.
CMD ["npm", "start"]
