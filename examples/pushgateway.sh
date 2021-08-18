#!/bin/bash
set -e
docker rm -f sdm-pushgateway || true
docker run -d --rm --name sdm-pushgateway -p 9091:9091 prom/pushgateway:v1.4.0