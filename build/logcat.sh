#!/usr/bin/env bash
# Playwork — filtered logcat for on-device debugging.
#
# WHY THIS EXISTS
# ---------------
# A raw `adb logcat` while the sensor is streaming is unusable. Measured over one
# real capture on a Pixel 8a (~25 min, ~11k lines/min):
#
#   90,657  I/AnimationController      Pixel system UI animation spam
#   47,550  V/Capacitor/SensorPlugin   Capacitor framework, one line PER EVENT
#      301  D,I,W,E/PlayworkSensor     our plugin — the part we actually want
#        9  I/Capacitor/Console        the app's own logger.ts output
#
# The Capacitor line comes from its `Plugin.notifyListeners()`, which does an
# unconditional `Logger.verbose(...)` for every emitted event — so at 20Hz across
# pressure + acceleration + rotation it alone produces ~60 lines/sec. That is the
# exact flood Key Rule 11 exists to prevent, arriving from the framework rather
# than from our code (our own SensorPlugin.kt correctly does NOT log per packet).
#
# It cannot be disabled at the source without collateral damage: Capacitor's
# `loggingBehavior` config is all-or-nothing over its whole Logger, so setting it
# to 'none' would also silence `Capacitor/Console` — which is where the app's own
# `logger.ts` output reaches logcat, and is the single most useful tag for
# debugging app logic. So the correct fix is reader-side filtering, which is the
# mechanism Android's logging design intends for noisy verbose tags anyway.
#
# USAGE
#   bash tools/build/logcat.sh                 # drop known floods, keep everything else
#   bash tools/build/logcat.sh --app           # ONLY app-relevant tags (quietest)
#   bash tools/build/logcat.sh --grep licen    # case-insensitive filter on top
#   bash tools/build/logcat.sh --clear         # wipe the buffer first
#   bash tools/build/logcat.sh --app --grep register --clear
#
# Default mode is a BLACKLIST (drop the two known floods, keep all else) so an
# unexpected-but-relevant system tag can never be silently hidden. --app is a
# whitelist for when you know you only care about this app.
set -euo pipefail

ADB="${ADB:-${LOCALAPPDATA:-}/Android/Sdk/platform-tools/adb.exe}"
[ -x "$ADB" ] || ADB="adb"   # fall back to PATH (Linux/macOS, or adb already on PATH)

MODE="all"
GREP_PATTERN=""
CLEAR=false

while [ $# -gt 0 ]; do
  case "$1" in
    --app)    MODE="app" ;;
    --clear|-c) CLEAR=true ;;
    --grep)   GREP_PATTERN="${2:-}"; shift ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1 (try --help)" >&2; exit 1 ;;
  esac
  shift
done

command -v "$ADB" >/dev/null 2>&1 || [ -x "$ADB" ] || { echo "adb not found at $ADB" >&2; exit 1; }

if [ -z "$("$ADB" devices | sed '1d' | grep -w device || true)" ]; then
  echo "No device attached. Check the USB cable and that debugging is authorised." >&2
  exit 1
fi

[ "$CLEAR" = true ] && "$ADB" logcat -c

# Tags that produce continuous high-volume noise and carry no app signal.
# `TAG:S` sets that tag's minimum priority to Silent; `*:V` keeps everything else.
# A specific tag rule always wins over the `*` default, regardless of order.
NOISE=(
  "Capacitor/SensorPlugin:S"   # framework per-event verbose (~60 lines/sec while streaming)
  "AnimationController:S"      # Pixel system UI animation spam
)

# Tags worth keeping when you want the quietest possible view.
# NOTE: logcat tag filters are EXACT matches, not prefixes — "Capacitor:V" does
# not cover "Capacitor/Console", so each is listed explicitly.
APP_TAGS=(
  "PlayworkSensor:V"           # our native plugin (renamed from the too-generic "SP")
  "Capacitor:V"
  "Capacitor/Console:V"        # the app's own logger.ts output — usually what you want
  "Capacitor/Plugin:V"
  "Capacitor/AppPlugin:V"
  "Capacitor/ScreenOrientationPlugin:V"
  "CapacitorCookies:V"
  "FirebaseCrashlytics:V"
  "AndroidRuntime:E"           # java crashes
  "DEBUG:E"                    # native tombstones
  "chromium:E"                 # WebView errors
)

if [ "$MODE" = "app" ]; then
  FILTER=("${APP_TAGS[@]}" "*:S")
else
  FILTER=("${NOISE[@]}" "*:V")
fi

if [ -n "$GREP_PATTERN" ]; then
  "$ADB" logcat -v time "${FILTER[@]}" | grep --line-buffered -iE "$GREP_PATTERN"
else
  "$ADB" logcat -v time "${FILTER[@]}"
fi
