FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
RUN npm ci

COPY apps/api/src ./apps/api/src

ENV NODE_ENV=production
USER node

CMD ["node", "--import", "tsx", "apps/api/src/server.ts"]
