# One container, one volume. glibc base so better-sqlite3 uses its prebuilt binary.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npx tsc

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production ENGINE_DATA=/data ENGINE_PORT=8080
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
VOLUME /data
EXPOSE 8080
CMD ["node", "dist/index.js"]
