# skill-diag runtime image.
# Stage 1 installs dependencies and builds; stage 2 copies only the runtime
# pieces (dist/, package.json, production node_modules) onto a fresh base.
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
# npm install (not npm ci): package-lock.json is gitignored, so a fresh
# checkout has no lockfile for npm ci to consume.
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --production

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
# package.json sits one level above dist/cli.js: the CLI reads its version
# from there via createRequire.
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
ENTRYPOINT ["node", "dist/cli.js"]
