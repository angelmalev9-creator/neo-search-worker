FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Install Chromium browser + ALL its system dependencies automatically
# This is the correct approach — manual apt-get lists always miss libraries
RUN npx playwright install --with-deps chromium

COPY server.js browser-search.js ./

EXPOSE 3210

CMD ["node", "server.js"]
