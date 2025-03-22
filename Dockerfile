FROM node:18-slim

# Встановлюємо необхідні системні пакети
RUN apt-get update && apt-get install -y \
    fontconfig \
    fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

# Створюємо робочу директорію
WORKDIR /app

# Копіюємо package.json та package-lock.json
COPY package*.json ./

# Встановлюємо залежності
RUN npm install

# Копіюємо всі файли проекту
COPY . .

# Відкриваємо порт
EXPOSE 3000

# Запускаємо сервер
CMD ["node", "server.js"] 