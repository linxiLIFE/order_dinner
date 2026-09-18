FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --include=optional

FROM dependencies AS build
WORKDIR /app
COPY tsconfig.json ./
COPY web ./web
COPY server ./server
RUN npm run build:web && npm run build:server

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist
COPY package.json ./package.json
EXPOSE 3000
CMD ["node", "server/dist/index.js"]
