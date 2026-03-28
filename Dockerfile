FROM node:20-slim

RUN apt-get update && apt-get install -y \
    ca-certificates \
    wget \
    gnupg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./

RUN npm install --omit=dev

RUN npx playwright install --with-deps chromium

COPY . .

ENV NODE_ENV=production
EXPOSE 3210

CMD ["npm", "start"]
