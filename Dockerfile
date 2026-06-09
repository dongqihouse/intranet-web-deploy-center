FROM node:22-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY public ./public

ENV NODE_ENV=production
ENV PORT=10000
ENV DATA_DIR=/data/web-deploy-center
ENV SERVICE_PORT_START=10001
ENV SERVICE_PORT_END=19999

RUN mkdir -p /data/web-deploy-center

EXPOSE 10000

CMD ["node", "server.js"]
