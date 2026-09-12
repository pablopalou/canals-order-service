# syntax=docker/dockerfile:1

FROM node:24.5-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24.5-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
# Production dependencies only: the compiler, test runner and dev logger have
# no business in a runtime image.
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
COPY drizzle ./drizzle
# Never run as root.
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
