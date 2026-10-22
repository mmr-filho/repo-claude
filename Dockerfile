# Servidor Sigilo. Build a partir da raiz do repositório:  docker build -t sigilo .
# syntax=docker/dockerfile:1

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY apps/mobile/package.json apps/mobile/
RUN npm ci -w @sigilo/server --ignore-scripts
COPY tsconfig.base.json ./
COPY packages/core packages/core
COPY packages/server packages/server
RUN npm run build -w @sigilo/server

FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DB_PATH=/data/sigilo.db \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY apps/mobile/package.json apps/mobile/
RUN npm ci -w @sigilo/server --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/packages/server/dist packages/server/dist
RUN mkdir /data && chown node:node /data
USER node
WORKDIR /app/packages/server
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
