FROM mcr.microsoft.com/playwright:v1.48.0-jammy
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js ./
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
