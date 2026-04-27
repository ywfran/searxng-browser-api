# ─── Stage 1: build ───────────────────────────────────────────────────────────
FROM node:22-slim AS builder

WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm ci

COPY src ./src
RUN npm run build

# Prune devDependencies so only production deps are copied to the runtime image.
RUN npm ci --omit=dev

# ─── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM node:22-slim AS runtime

# Chromium and all shared libraries it needs in a headless environment.
# libasound2t64 is the Debian Bookworm (Node 22 base) name for libasound2.
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    fonts-liberation \
    fonts-noto \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libasound2t64 \
    libx11-xcb1 \
    libxcb-dri3-0 \
    libxfixes3 \
    libxext6 \
    && rm -rf /var/lib/apt/lists/*

# Non-root user for the application process.
RUN useradd -m -u 1001 apiuser

WORKDIR /app

# Production build and dependencies.
COPY --from=builder --chown=apiuser:apiuser /app/dist         ./dist
COPY --from=builder --chown=apiuser:apiuser /app/node_modules ./node_modules
COPY --from=builder --chown=apiuser:apiuser /app/package.json ./

# Static data files (blocklist and instances blocklist).
# instances.json is generated at runtime and written to this directory.
COPY --chown=apiuser:apiuser data/blocklist.json           ./data/blocklist.json
COPY --chown=apiuser:apiuser data/instances_blocklist.json ./data/instances_blocklist.json

# Ensure the data directory is writable by apiuser so instances.json can be persisted.
RUN mkdir -p ./data && chown apiuser:apiuser ./data

USER apiuser

# ─── Environment defaults ─────────────────────────────────────────────────────
# All values can be overridden at runtime via -e / --env-file.

# Tell Playwright to use the system Chromium installed above.
ENV CHROME_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Server
ENV NODE_ENV=production
ENV PORT=3030
ENV LOG_LEVEL=info

# Browser pool
ENV MAX_CONTEXTS=8

# Search orchestration
ENV SEARCH_TIMEOUT_MS=12000
ENV SEARCH_STAGGER_MS=5000
ENV SEARCH_DECISION_WINDOW_MS=500

# Instance list management
ENV INSTANCE_REFRESH_INTERVAL_HOURS=6
ENV INSTANCE_MIN_UPTIME=80

EXPOSE 3030

HEALTHCHECK --interval=30s --timeout=8s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://localhost:3030/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
