FROM node:20-alpine
WORKDIR /app
COPY server.js package.json ./
ENV RELAY_ONLY=1 NODE_ENV=production
# PORT'u platform verir (Render/Fly/Railway); yoksa 8000
EXPOSE 8000
USER node
CMD ["node", "server.js"]
