# syntax=docker/dockerfile:1
# opencodex_base is the named image context from deploy/compose.build.yaml.
FROM opencodex_base AS core-download
ARG TARGETARCH
USER bun
COPY --chown=bun:bun docker/custom/mihomo-release.json docker/custom/install-mihomo.ts /tmp/core-build/
RUN bun /tmp/core-build/install-mihomo.ts "$TARGETARCH" /tmp/mihomo

FROM opencodex_base AS runtime
COPY --from=core-download --chown=root:root --chmod=0755 /tmp/mihomo /usr/local/bin/mihomo
COPY --chown=root:root docker/custom/MIHOMO-LICENSE docker/custom/THIRD-PARTY-NOTICES /usr/share/licenses/mihomo/
COPY --chown=bun:bun docker/custom/init.ts /home/bun/app/docker/custom/init.ts
COPY --chown=bun:bun --chmod=0600 docker/custom/config.json /home/bun/.opencodex/config.json
ENV OPENCODEX_PROXY_CORE=/usr/local/bin/mihomo OCX_DISABLE_UPDATE_CHECK=1
USER bun
RUN ["/usr/local/bin/mihomo", "-v"]
# Inherit upstream CMD, healthcheck, state volumes and non-root runtime.
