# Imagen oficial de Playwright con navegadores ya instalados
FROM mcr.microsoft.com/playwright:v1.56.1-jammy

WORKDIR /app

# Instalar deps (aprovecha caché)
COPY package*.json ./
RUN npm ci --omit=dev || npm install --production

# Copiar código
COPY server.js ./

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# Ejecutar como usuario no-root provisto por la imagen
USER pwuser

CMD ["node", "server.js"]
