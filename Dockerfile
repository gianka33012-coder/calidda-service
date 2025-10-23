# Imagen oficial de Playwright que YA trae Chromium y dependencias del sistema
FROM mcr.microsoft.com/playwright:v1.56.1-jammy

# Carpeta de trabajo
WORKDIR /app

# Instalar dependencias de Node (sin dev)
COPY package*.json ./
RUN npm install --omit=dev

# Copiar el servidor
COPY server.js ./

# Variables y puerto expuesto
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# Comando de arranque
CMD ["node", "server.js"]
