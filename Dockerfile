# Unofficial overlay image for the Token Monitor headless agent.
# Not published or endorsed by Javis603/token-monitor.
# Build shallow-clones the locked stable Release; this repo does not vendor that source.
FROM node:22-bookworm-slim

ARG DEBIAN_FRONTEND=noninteractive

COPY upstream.lock.json /tmp/upstream.lock.json

WORKDIR /app

ENV NODE_ENV=production \
    npm_config_update_notifier=false \
    npm_config_fund=linux \
    npm_config_cpu=x64 \
    npm_config_libc=glibc \
    GIT_TERMINAL_PROMPT=0 \
    TOKEN_MONITOR_CLIENTS=hermes \
    TOKEN_MONITOR_LIMITS_ENABLED=0 \
    TOKEN_MONITOR_WATCH=0 \
    TOKEN_MONITOR_INTERVAL_MS=300000 \
    TOKEN_MONITOR_SHARED_DIR=/var/lib/token-monitor-agent \
    HERMES_HOME=/opt/data

RUN set -eu; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates git; \
    tag="$(node -p "require('/tmp/upstream.lock.json').tag")"; \
    commit="$(node -p "require('/tmp/upstream.lock.json').commit")"; \
    source="$(node -p "require('/tmp/upstream.lock.json').source")"; \
    git clone --depth 1 --branch "$tag" "https://github.com/${source}.git" /app; \
    head="$(git -C /app rev-parse HEAD)"; \
    if [ "$head" != "$commit" ]; then \
      echo "upstream commit mismatch: got $head want $commit" >&2; \
      exit 1; \
    fi; \
    rm -rf /app/.git; \
    npm ci --omit=dev; \
    node scripts/ensure-vendored-tokscale.js --platform=linux-x64; \
    npm cache clean --force; \
    apt-get purge -y git; \
    apt-get autoremove -y --purge; \
    rm -rf /var/lib/apt/lists/* /root/.npm /tmp/npm-* ; \
    mkdir -p /var/lib/token-monitor-agent /opt/data; \
    chown -R 1000:1000 /app /var/lib/token-monitor-agent /opt/data

USER 1000:1000

CMD ["node", "src/agent/agent.js"]
