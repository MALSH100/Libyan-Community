# Slim Node base (~150 MB) instead of the old Playwright image (~2 GB with 3
# browsers). Nothing launches a browser anymore — chart PNGs are rendered by
# @resvg/resvg-js, a small native library.
FROM node:20-slim

WORKDIR /app

# No font package needed: the chart font ships in the repo at ./fonts and resvg
# loads it directly, so text renders even if the host has no system fonts. (This
# also means it works the same whether Railway builds from this Dockerfile or
# from Nixpacks.)

COPY package*.json ./
# --omit=dev skips devDependencies but keeps optionalDependencies, which is how
# @resvg/resvg-js ships its prebuilt native binary — so don't use --no-optional.
RUN npm install --omit=dev

COPY . .

# Uses the start script, which applies the --max-old-space-size heap cap.
CMD ["npm", "start"]
