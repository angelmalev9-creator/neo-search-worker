FROM node:20-slim

# Инсталираме нужните системни библиотеки за Playwright
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Първо копираме само package файловете за по-бърз кеш
COPY package.json package-lock.json* ./
RUN npm install --production

# Инсталираме само Chromium и неговите зависимости
RUN npx playwright install --with-deps chromium

# Копираме останалите файлове
COPY . .

EXPOSE 3210

# Използваме dumb-init или директен node за по-добър сигнал хендлинг
CMD ["node", "server.js"]
