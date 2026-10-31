# Hub de blogs de clientes (blog.bunkerank.com) — imagen para Coolify.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:22-alpine AS build
WORKDIR /app
ARG BUNKER_ASSET_PREFIX=https://blog.bunkerank.com
ENV NEXT_OUTPUT=standalone NEXT_TELEMETRY_DISABLED=1 BUNKER_ASSET_PREFIX=$BUNKER_ASSET_PREFIX
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx next build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
