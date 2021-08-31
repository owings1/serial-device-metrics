# syntax=docker/dockerfile:1.2
ARG PARENT=node:alpine
FROM ${PARENT}

WORKDIR /app
RUN chown node:node /app && addgroup node dialout
EXPOSE 8080

ENV CONFIG_FILE=/etc/app/config.yaml

RUN apk add --no-cache make g++ gcc python3 linux-headers udev

COPY package.json .
COPY package-lock.json .

RUN --mount=type=secret,id=npmrc,dst=/app/.npmrc npm install --omit dev

COPY --chown=node:node . .

USER node

CMD ["node", "index.js"]