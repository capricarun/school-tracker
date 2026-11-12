# No native modules: SQLite comes built into Node (node:sqlite), so a single slim stage is enough.
FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    TZ=Asia/Kolkata \
    PORT=3000 \
    DATA_DIR=/data
RUN apt-get update && apt-get install -y --no-install-recommends tzdata tini \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data && chown node:node /data
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
COPY deploy/entrypoint.sh /usr/local/bin/entrypoint.sh
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["node", "src/server.js"]
