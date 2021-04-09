FROM node:alpine

COPY qemu-arm-static /usr/bin

WORKDIR /var/lib/serial-device-metrics
RUN ["chown", "node:node", "/var/lib/serial-device-metrics"]
EXPOSE 8181

ENV CONFIG_DIR="/etc/serial-device-metrics"

RUN apk add --no-cache make g++ gcc python3 linux-headers udev

COPY package.json .
COPY package-lock.json .

RUN npm install

COPY --chown=node:node . .

USER node

CMD ["node", "index.js"]