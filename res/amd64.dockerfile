FROM node:alpine

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