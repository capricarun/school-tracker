# ---- deps: install production modules (better-sqlite3 needs a toolchain if no prebuilt binary) ----
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime ----
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    TZ=Asia/Kolkata \
    PORT=3000 \
    DATA_DIR=/data
RUN apt-get update && apt-get install -y --no-install-recommends tzdata tini \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data && chown node:node /data
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.js"]
