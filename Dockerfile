FROM node:22-bookworm AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libcairo2-dev \
    libjpeg-dev \
    libpango1.0-dev \
    libgif-dev \
    librsvg2-dev \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    libcairo2 \
    libjpeg62-turbo \
    libpango1.0-0 \
    libgif7 \
    librsvg2-2 \
    ffmpeg \
    fonts-liberation \
    fontconfig \
    && rm -rf /var/lib/apt/lists/*

# Verify FFmpeg works and print version for build logs
RUN ffmpeg -version | head -n 1

# Verify fonts exist and build font cache
RUN fc-list | grep -i liberation | head -n 5 || echo "Warning: no liberation fonts found"
RUN fc-cache -fv

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

RUN mkdir -p /app/tmp && chmod -R 777 /app/tmp

# Create a 1 GB swapfile to survive memory spikes on hobby plans.
# Railway hobby containers have ~512 MB RAM; swap gives FFmpeg headroom
# before the OOM killer fires.
RUN fallocate -l 1G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=1024 && \
    chmod 600 /swapfile && \
    mkswap /swapfile && \
    swapon /swapfile || echo "Swap setup failed (expected in some environments)"

# Do NOT switch to USER node — Railway ephemeral volumes and some native
# modules behave more reliably as root in containerized environments.

EXPOSE 3001

ENV PORT=3001
ENV TEMP_DIR=/app/tmp
ENV FONT_DIR=/usr/share/fonts/truetype/liberation

CMD ["node", "dist/index.js"]