FROM node:24.18.0-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24.18.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global @openai/codex@0.160.1 \
    && mkdir -p /data /projects && chown node:node /data /projects
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY agents ./agents
COPY scripts/m2-smoke.mjs scripts/m3-smoke.mjs ./scripts/
USER node
ENV NODE_ENV=production DEVAGENTS_DATA_DIR=/data DEVAGENTS_HOST=0.0.0.0
EXPOSE 4310
CMD ["node", "dist/cli/main.js", "serve"]
