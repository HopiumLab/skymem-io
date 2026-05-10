# skyMem — slim cognition-stack image.
# Brings up sky/, scripts/, prisma schema, MCP server. No WhatsApp / Whisper /
# Puppeteer / personal-PA dependencies — those are in the private repo.
FROM node:20-slim

WORKDIR /app

# System deps for Prisma + node native modules
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY prisma ./prisma
RUN npx prisma generate

COPY sky ./sky
COPY scripts ./scripts
COPY docs ./docs

EXPOSE 3003

# Default: run the MCP server. Override with -e SKY_MODE=cli / bench / etc.
CMD ["node", "sky/mcp-server.js"]
