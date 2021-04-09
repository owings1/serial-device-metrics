FROM alpine AS builder

# Download QEMU, see https://github.com/docker/hub-feedback/issues/1261
ENV QEMU_URL https://github.com/balena-io/qemu/releases/download/v3.0.0%2Bresin/qemu-3.0.0+resin-arm.tar.gz
RUN apk add curl && curl -L ${QEMU_URL} | tar zxvf - -C . --strip-components 1

FROM arm32v7/node:alpine

COPY --from=builder qemu-arm-static /usr/bin

WORKDIR /var/lib/serial-device-metrics
RUN ["chown", "node:node", "/var/lib/serial-device-metrics"]
EXPOSE 8080

ENV CONFIG_FILE="/etc/serial-device-metrics/config.yaml"

RUN apk add --no-cache make g++ gcc python3 linux-headers udev

COPY package.json .
COPY package-lock.json .

RUN npm install

COPY --chown=node:node . .

USER node

CMD ["node", "index.js"]