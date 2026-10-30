# syntax=docker/dockerfile:1.7
# Imagens multi-stage em Debian-slim (glibc): evita falhas de compilação nativa comuns no Alpine.
# Nenhuma dependência compila C++: senhas com scrypt nativo do Node, parser SQL em WASM, Prisma sem engine binária.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/database/package.json packages/database/
COPY packages/ai-engine/package.json packages/ai-engine/
COPY packages/messaging/package.json packages/messaging/
COPY packages/fhir/package.json packages/fhir/
COPY packages/accessibility/package.json packages/accessibility/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/mobile/package.json apps/mobile/
COPY infra/mocks/package.json infra/mocks/
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY . .
RUN npm run build:libs && npx tsc -b apps/api infra/mocks

# Dependências de produção só dos pacotes do back-end (sem Next, React, Capacitor, ferramentas de build).
FROM deps AS prod-deps
RUN npm ci --omit=dev --no-audit --no-fund \
  -w @omnisaude/api -w @omnisaude/database -w @omnisaude/shared -w @omnisaude/ai-engine \
  -w @omnisaude/messaging -w @omnisaude/fhir -w @omnisaude/accessibility -w @omnisaude/mocks

# ── API e worker (mesma imagem; o worker muda só o comando) ──
FROM node:22-bookworm-slim AS api
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/package.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
USER node
EXPOSE 3001
CMD ["node", "apps/api/dist/main.js"]

# ── Servidores simulados (RNDS/CADSUS, SEFAZ, WhatsApp) para desenvolvimento ──
FROM node:22-bookworm-slim AS mocks
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/infra/mocks ./infra/mocks
USER node
EXPOSE 4010
CMD ["node", "infra/mocks/dist/index.js"]

# ── Front-end web (Next.js) ──
FROM build AS web-build
ARG NEXT_PUBLIC_API_URL=http://localhost:3001/api
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN npm run build -w @omnisaude/web

FROM node:22-bookworm-slim AS web
ENV NODE_ENV=production
WORKDIR /app
COPY --from=web-build /app/package.json ./
COPY --from=web-build /app/node_modules ./node_modules
COPY --from=web-build /app/packages ./packages
COPY --from=web-build /app/apps/web ./apps/web
USER node
EXPOSE 3000
CMD ["npm", "run", "start", "-w", "@omnisaude/web"]
