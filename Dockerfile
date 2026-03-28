FROM node:20-slim

# Playwright needs these system libs for Chromium
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 \
    libpango-1.0-0 libcairo2 libasound2 libxshmfence1 \
    fonts-liberation wget ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Install only Chromium (skip Firefox/WebKit to save ~400MB)
RUN npx playwright install chromium

COPY server.js browser-search.js ./

EXPOSE 3210

CMD ["node", "server.js"]
