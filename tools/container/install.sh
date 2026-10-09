#!/bin/sh
# Guided install of the ShadowPKG builder container, for people who would rather
# answer five questions than type docker commands.
#
#   sh install.sh               ask, set up, and start the container
#   sh install.sh --update      rebuild the image and recreate the container with
#                               the answers saved last time (never during a build)
#   sh install.sh --dry-run     print what it would run, run nothing
#   sh install.sh --yes         take the saved answers or defaults without asking
#
# What it does, in order:
#   1. builds the image from this folder (needs the Dockerfile beside it)
#   2. runs the ONE-TIME setup in a throwaway container that has network access:
#      Wine, .NET, the VC++ runtime and Python are downloaded, the kit is tested,
#      and you type YES to approve exactly the files in it
#   3. starts the real container with the network switched OFF
# Nothing is approved without you typing YES, and the kit never enters the image.
#
# Answers are kept in install.env inside the builder's config folder, so
# --update needs none of them again.
set -eu

NAME="${SPKGB_NAME:-ShadowPKG-Builder}"
IMAGE="${SPKGB_IMAGE:-shadowpkg-builder}"
HERE="$(cd "$(dirname "$0")" && pwd)"
DRY=0; UPDATE=0; YES=0; FORCE=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --update) UPDATE=1 ;;
    --yes|-y) YES=1 ;;
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $a (try --help)"; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
die() { printf 'Stopped: %s\n' "$*" >&2; exit 1; }
# Everything that changes something goes through here, so --dry-run is honest.
do_run() { if [ "$DRY" = 1 ]; then printf '  would run: %s\n' "$*"; else "$@"; fi; }

command -v docker >/dev/null 2>&1 || [ "$DRY" = 1 ] || die "docker was not found on this machine."

# Where answers live: next to the Wine prefix on Unraid, else beside this script.
if [ -n "${SPKGB_ENV:-}" ]; then ENVFILE="$SPKGB_ENV"
elif [ -f /mnt/user/appdata/ShadowPKG-Builder/install.env ]; then ENVFILE=/mnt/user/appdata/ShadowPKG-Builder/install.env
elif [ -f "$HERE/install.env" ]; then ENVFILE="$HERE/install.env"
elif [ -d /mnt/user/appdata ]; then ENVFILE=/mnt/user/appdata/ShadowPKG-Builder/install.env
else ENVFILE="$HERE/install.env"; fi

KIT="${KIT:-}"; LIBRARY="${LIBRARY:-}"; SPKG_CFG="${SPKG_CFG:-}"; CONFIG="${CONFIG:-}"; WORK="${WORK:-}"; COPY_DUMP="${COPY_DUMP:-}"
if [ -f "$ENVFILE" ]; then
  # Only our own variable names are read back, never executed as shell.
  while IFS='=' read -r k v; do
    case "$k" in
      KIT|LIBRARY|SPKG_CFG|CONFIG|WORK|COPY_DUMP) eval "cur=\${$k:-}"; [ -n "$cur" ] || eval "$k=\$v" ;;
    esac
  done < "$ENVFILE"
fi
[ "$UPDATE" = 1 ] && [ -z "$KIT$LIBRARY" ] && die "no saved answers found at $ENVFILE; run without --update first."

# Questions read from the terminal even when the script itself was piped in.
ask() { # var, prompt, default
  var="$1"; prompt="$2"; def="$3"
  eval "cur=\${$var:-}"
  [ -n "$cur" ] && def="$cur"
  if [ "$YES" = 1 ] || [ "$UPDATE" = 1 ]; then
    [ -n "$def" ] || die "$prompt has no answer; run without --yes."
    eval "$var=\$def"; return
  fi
  while :; do
    if [ -r /dev/tty ]; then printf '%s [%s]: ' "$prompt" "$def" >/dev/tty; read -r ans </dev/tty || ans=""
    else printf '%s [%s]: ' "$prompt" "$def"; read -r ans || ans=""; fi
    ans="${ans:-$def}"
    [ -n "$ans" ] && break
  done
  eval "$var=\$ans"
}

say "ShadowPKG builder setup"
say ""
ask KIT       "Folder holding your extracted repack kit (build-from-folder.ps1, scripts/, toolchain/)" "/mnt/user/appdata/fpkg-sdk"
ask LIBRARY   "Your game library, the same folder ShadowPKG uses" "/mnt/user/Games"
ask SPKG_CFG  "ShadowPKG's own config folder (where its builds.json lives)" "/mnt/user/appdata/ShadowPKG"
ask CONFIG    "A folder for this builder's settings and logs" "/mnt/user/appdata/ShadowPKG-Builder"
ask WORK      "A fast folder with room for a copy of the biggest game (scratch space)" "/mnt/user/Fast"
PREFIX="$CONFIG/prefix"

problems=0
[ -f "$KIT/toolchain/prospero-pub-cmd.exe" ] || { say "  ! $KIT does not contain toolchain/prospero-pub-cmd.exe. The kit has to be extracted there, not left as an archive."; problems=1; }
[ -d "$LIBRARY" ] || { say "  ! $LIBRARY is not a folder."; problems=1; }
[ -d "$SPKG_CFG" ] || { say "  ! $SPKG_CFG is not a folder (ShadowPKG's config folder)."; problems=1; }
for p in "$KIT" "$LIBRARY" "$SPKG_CFG" "$CONFIG" "$WORK"; do
  case "$p" in *" "*) say "  ! \"$p\" has a space in it; use folders without spaces for the builder."; problems=1 ;; esac
done
if [ "$problems" = 1 ] && [ "$DRY" = 0 ]; then die "fix the paths above and run this again."; fi

do_run mkdir -p "$CONFIG" "$PREFIX" "$WORK"
if [ "$DRY" = 0 ]; then
  { printf 'KIT=%s\nLIBRARY=%s\nSPKG_CFG=%s\nCONFIG=%s\nWORK=%s\nCOPY_DUMP=%s\n' "$KIT" "$LIBRARY" "$SPKG_CFG" "$CONFIG" "$WORK" "$COPY_DUMP"; } > "$ENVFILE" 2>/dev/null \
    || say "  (could not save your answers to $ENVFILE; --update will ask again)"
fi

# A restart kills a build that is running, and so does replacing the container.
if [ "$DRY" = 0 ] && [ -f "$LIBRARY/.shadowpkg-builder.json" ] && grep -q '"busy":"' "$LIBRARY/.shadowpkg-builder.json" 2>/dev/null; then
  if [ "$FORCE" = 1 ]; then say "  A build is running and --force was given; it will be lost."
  else die "the builder is in the middle of a build. Wait for it to finish (or cancel it in ShadowPKG), or use --force."; fi
fi

MOUNTS="-v $KIT:/kit:ro -v $LIBRARY:/games -v $CONFIG:/config -v $PREFIX:/prefix -v $WORK:/work"

say ""
say "1/3  The image"
if [ -f "$HERE/Dockerfile" ]; then
  do_run docker build -t "$IMAGE" "$HERE"
else
  say "  No Dockerfile beside this script, so the existing image \"$IMAGE\" is used."
fi

say ""
say "2/3  One-time setup, in a container that is allowed to use the network"
say "     (downloads about 1 GB, takes 10 to 20 minutes the first time; nothing to do but wait,"
say "      then type YES when it lists the kit's files, if you accept them)"
# shellcheck disable=SC2086
if [ "$DRY" = 1 ]; then printf '  would run: docker run --rm -it --name %s-setup %s %s setup\n' "$NAME" "$MOUNTS" "$IMAGE"
else
  docker rm -f "$NAME-setup" >/dev/null 2>&1 || true
  # shellcheck disable=SC2086
  docker run --rm -it --name "$NAME-setup" $MOUNTS "$IMAGE" setup || die "setup did not finish. Nothing was started. Read what it said above and run this again; it picks up where it stopped."
fi

say ""
say "3/3  The builder itself, with the network off"
do_run docker rm -f "$NAME" 2>/dev/null || true
EXTRA=""; [ -n "$COPY_DUMP" ] && EXTRA="-e COPY_DUMP=$COPY_DUMP"
# shellcheck disable=SC2086
if [ "$DRY" = 1 ]; then printf '  would run: docker run -d --name %s --restart unless-stopped --network none %s -v %s:/spkg:ro %s %s\n' "$NAME" "$MOUNTS" "$SPKG_CFG" "$EXTRA" "$IMAGE"
else
  # shellcheck disable=SC2086
  docker run -d --name "$NAME" --restart unless-stopped --network none $MOUNTS -v "$SPKG_CFG:/spkg:ro" $EXTRA "$IMAGE" >/dev/null
  sleep 4
  docker exec "$NAME" node /app/runner.js status || true
fi

say ""
say "Done. In ShadowPKG, open a game dump and press Build .pkg: its card should say the builder is online."
say "Keep the builder out of any backup or auto-update job that restarts containers; a restart kills a running build."
say "To update later:  sh install.sh --update"
