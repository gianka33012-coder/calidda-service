FROM mcr.microsoft.com/playwright:v1.48.0-jammy

WORKDIR /app

# Copiamos package.json (no usamos npm ci porque no hay package-lock.json)
COPY package*.json ./
RUN npm install --omit=dev

# Copiamos el servidor
COPY server.js ./

# Puerto en Render
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
