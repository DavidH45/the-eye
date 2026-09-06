# The Eye — bot + dashboard in one image
FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# Install deps first for layer caching. better-sqlite3 ships prebuilt
# binaries for linux/glibc, so no compiler toolchain is needed here.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

# SQLite DB (and its -wal/-shm files) live here; mount a volume on it.
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 3000

# Runs the bot and the web dashboard together (src/index.js).
CMD ["node", "src/index.js"]
