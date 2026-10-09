# ShadowPKG runs on the Node standard library alone — no npm install, no lockfile —
# with ONE deliberate, owner-approved exception: basic-ftp (package.json /
# package-lock.json at the repo root), used only by the FTP-connected-console
# feature (server.js, the "---- FTP-connected consoles" section). It's a real
# FTP protocol client (passive-mode negotiation, MLSD/LIST fallback, connection
# quirks across embedded FTP daemons) — not worth hand-rolling against
# real-world server behavior the way the rest of this app avoids dependencies.
# Nothing else in the app gets a new dependency because of this.
#
# The extras below are only for unpacking a compressed .rar in place when a release
# doesn't store its package.
#
# The base is Debian rather than Alpine because of one package: unar. Alpine has
# no RAR-capable tool at all — its 7-Zip is built without the RAR codec, and
# neither unrar nor unar is in its repositories — while bsdtar reads a single
# .rar but not a multi-volume set. unar reads both. bsdtar and 7-Zip stay as
# fallbacks and for .zip and .7z; the app tries whatever is present in turn,
# preferring unrar first (see RAR_TOOLS in server.js).
#
# unrar (RARLAB's own extractor) is also installed, owner-approved 2026-09-28,
# for the RAR5 compression variants unar/bsdtar/7-Zip can't decompress at all.
# It's free of charge but not open-source — its license lives in Debian's
# "non-free" component, not "main", so that component has to be enabled
# first. This is the one deliberate non-free-repo exception in this image.
FROM node:22-bookworm-slim

RUN sed -i -e 's/^Components: main$/Components: main contrib non-free non-free-firmware/' \
      /etc/apt/sources.list.d/debian.sources 2>/dev/null; \
    sed -i -e 's/ main$/ main contrib non-free non-free-firmware/' \
      /etc/apt/sources.list 2>/dev/null; \
    apt-get update && apt-get install -y --no-install-recommends \
      unrar unar libarchive-tools p7zip-full \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# Its own layer, cached independently of app-code edits: this only re-runs when
# package.json/package-lock.json change, not on every server.js/index.html edit.
COPY package.json package-lock.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js index.html ./

ENV ROOT=/games \
    SOURCES_DIR=/extra-libraries \
    CONFIG_DIR=/config \
    PORT=12801

EXPOSE 12801

# GET /healthz is answered from memory, so this fails only when the port is closed or
# the event loop is stuck. Docker marks the container unhealthy after three misses; it does
# not restart it for that. The image has no curl, so node itself is the client. It asks the address the app
# listens on (BIND_ADDRESS), or loopback when that is unset or means every address.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "const b=process.env.BIND_ADDRESS;require('http').get({host:!b||b==='0.0.0.0'||b==='::'?'127.0.0.1':b,port:process.env.PORT||12801,path:'/healthz',timeout:4000},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1)).on('timeout',()=>process.exit(1))"]

CMD ["node", "server.js"]
