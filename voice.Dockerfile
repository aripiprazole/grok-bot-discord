FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY cloudflare/container/package.json cloudflare/container/package-lock.json ./
RUN npm ci --omit=dev

COPY cloudflare/container/server.mjs ./server.mjs
COPY server/settings.mjs ./server/settings.mjs
COPY server/cloud/auth.mjs server/cloud/discord-voice-call.mjs server/cloud/voice-controller.mjs server/cloud/voice-host.mjs ./server/cloud/
COPY server/live ./server/live

EXPOSE 8080
CMD ["node", "server.mjs"]
