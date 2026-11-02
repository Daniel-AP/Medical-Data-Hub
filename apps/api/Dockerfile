FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
RUN npm ci

COPY apps/api/src ./apps/api/src
COPY apps/api/prisma ./apps/api/prisma
COPY apps/api/prisma7.config.ts ./apps/api/prisma7.config.ts
COPY infra/keycloak/development/medical-data-hub-realm.json ./infra/keycloak/development/medical-data-hub-realm.json

RUN npx prisma generate --config apps/api/prisma7.config.ts

ENV NODE_ENV=production
USER node

CMD ["node", "--import", "tsx", "apps/api/src/server.ts"]
