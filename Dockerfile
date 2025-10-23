# Imagen oficial de Playwright con los navegadores ya instalados
# (versión alineada con tu package.json)
FROM mcr.microsoft.com/playwright:v1.56.1-jammy

# Carpeta de trabajo
WORKDIR /app

# Copiamos manifiestos primero para aprovechar la cache de Docker
COPY package*.json ./

# Instalar dependencias en modo producción
# (npm ci cuando hay package-lock.json; fallback a npm install)
RUN npm ci --omit=dev || npm install --production

# Copiamos el código de la app
# (si tienes más archivos JS/TS, agrégalos aquí)
COPY server.js ./

# Variables por defecto
ENV NODE_ENV=production
ENV PORT=8080

# Exponer el puerto que usa el servidor
EXPOSE 8080

# Ejecutar como el usuario no root que trae la imagen de Playwright
USER pwuser

# Comando de arranque
CMD ["node", "server.js"]
