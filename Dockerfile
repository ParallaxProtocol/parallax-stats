FROM node:lts-alpine AS builder
ARG GRUNT_TASK=default
WORKDIR /parallax-stats
COPY ["package.json", "package-lock.json*", "./"]
RUN npm ci --only=production && npm install -g grunt-cli
COPY --chown=node:node . .
RUN grunt $GRUNT_TASK

FROM node:lts-alpine
RUN apk add dumb-init
WORKDIR /parallax-stats
COPY --chown=node:node --from=builder /parallax-stats .
USER node
EXPOSE  3000
CMD ["dumb-init", "node", "./bin/www"]
