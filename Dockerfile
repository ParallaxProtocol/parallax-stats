# Build and run the dashboard: one Node process serving the Next.js app
# and the stats websockets on port 3000.
FROM node:24-alpine AS build
RUN npm install -g pnpm@11.28.4
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build && pnpm prune --prod

FROM node:24-alpine
RUN apk add --no-cache dumb-init
WORKDIR /app
ENV NODE_ENV=production PORT=3000 NEXT_TELEMETRY_DISABLED=1
COPY --from=build --chown=node:node /app/package.json /app/server.ts /app/next.config.ts ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/assets ./assets
COPY --from=build --chown=node:node /app/src ./src
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:3000/api/v1/stats > /dev/null || exit 1
CMD ["dumb-init", "node", "server.ts"]
