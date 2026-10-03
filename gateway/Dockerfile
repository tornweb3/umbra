# Build stage: compile TypeScript with the dev dependencies present.
FROM node:22-alpine AS build
WORKDIR /app
# Tolerate slow or flaky registry connections during the build.
RUN npm config set fetch-retries 5 && npm config set fetch-retry-maxtimeout 120000 && npm config set fetch-timeout 600000
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Runtime stage: production dependencies and compiled output only.
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
RUN npm config set fetch-retries 5 && npm config set fetch-retry-maxtimeout 120000 && npm config set fetch-timeout 600000
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY public ./public
USER node
EXPOSE 3000
# The worker runs the same image with a different command (see compose.yaml).
CMD ["node", "dist/server.js"]
