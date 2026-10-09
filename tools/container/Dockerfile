# A runner for ShadowPKG build jobs, with Wine to run a Windows repack kit that
# you supply. EXPERIMENTAL: whether the kit's main library loads under Wine
# (it is mixed-mode .NET) is exactly what "runner.js smoke" is for.
#
# Nothing of the kit is in this image. It is mounted at /kit read-only and only
# ever run after `runner.js trust` has recorded the sha256 of every file in it.
# Wine, the VC++ runtime, .NET and Windows Python are all fetched by
# `runner.js init` into the /prefix volume, not into the image.
#
#   docker build -t shadowpkg-builder .
FROM node:22-bookworm-slim

# Wine and winetricks are in Debian; winetricks is in "contrib". wine32 is here
# because the .NET installers set up 32-bit pieces too, even for a 64-bit tool.
RUN sed -i 's/^Components: main$/Components: main contrib/' /etc/apt/sources.list.d/debian.sources \
 && grep -q contrib /etc/apt/sources.list.d/debian.sources \
 && dpkg --add-architecture i386 \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      wine wine64 wine32 libwine winetricks xvfb xauth cabextract curl ca-certificates unzip procps \
 && rm -rf /var/lib/apt/lists/*

ENV WINEPREFIX=/prefix \
    WINEARCH=win64 \
    WINEDEBUG=-all \
    WINEDLLOVERRIDES="winemenubuilder.exe=d" \
    KIT_DIR=/kit \
    CONFIG_DIR=/config \
    WORK_DIR=/work \
    SPKG_CONFIG=/spkg

COPY runner.js /app/runner.js
WORKDIR /work
ENTRYPOINT ["node", "/app/runner.js"]
CMD ["watch"]
