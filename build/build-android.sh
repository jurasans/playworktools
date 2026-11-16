#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# RehabBall — Android build + install script
#
# Usage:
#   bash tools/build/build-android.sh              # debug APK, auto-install if device connected
#   bash tools/build/build-android.sh release      # release APK
#   bash tools/build/build-android.sh --no-install # skip adb install step
#   bash tools/build/build-android.sh --install-only # skip build, just (re)install last APK
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# ── Parse args ────────────────────────────────────────────────────────────────
BUILD_TYPE="debug"
NO_INSTALL=false
INSTALL_ONLY=false
for arg in "$@"; do
  case "$arg" in
    release)       BUILD_TYPE="release" ;;
    --no-install)  NO_INSTALL=true ;;
    --install-only) INSTALL_ONLY=true ;;
  esac
done

# ── Colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
# Use printf to avoid echo -e mangling Windows backslash paths (\E, \U, etc.)
ok()   { printf "${GREEN}✓${NC} %s\n" "$*"; }
info() { printf "${CYAN}→${NC} %s\n" "$*"; }
warn() { printf "${YELLOW}⚠${NC}  %s\n" "$*"; }
fail() { printf "${RED}✗${NC} %s\n" "$*" >&2; exit 1; }
# "[progress] N% label" lines (tools/build/progress.mjs): N is mapped into PROGRESS_LO..PROGRESS_HI when a parent script gave us a slice.
PR_LO="${PROGRESS_LO:-0}"; PR_HI="${PROGRESS_HI:-100}"
progress() { printf "[progress] %d%% %s\n" $(( PR_LO + $1 * (PR_HI - PR_LO) / 100 )) "$2"; }
step() {
  printf "\n${CYAN}── %s ${NC}\n" "$*"
  case "$1" in
    "Java") progress 2 "checking Java" ;;
    "Android SDK") progress 4 "checking Android SDK" ;;
    "Node") progress 5 "checking Node" ;;
    "SensorPlugin (early sync)") progress 6 "syncing SensorPlugin" ;;
    "npm install") progress 8 "npm install" ;;
    "Adding Android platform") progress 14 "adding Android platform" ;;
    "Web build") progress 20 "web build" ;;
    "cap sync") progress 45 "capacitor sync" ;;
    "Launcher icons") progress 48 "launcher icons" ;;
    "Gradle") progress 52 "gradle starting" ;;
    "Install") progress 99 "installing on device" ;;
  esac
}

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  RehabBall Android Build  [${BUILD_TYPE}]"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ─────────────────────────────────────────────────────────────────────────────
# 1. JAVA — find a JDK ≥ 17 (Capacitor 7 compiles at Java 21 source level)
# ─────────────────────────────────────────────────────────────────────────────
step "Java"

java_major() {
  # Echoes the major version number of the java binary at $1/bin/java, or 0 on failure.
  # Always echoes a number so callers can safely use -lt/-ge comparisons.
  local dir="$1"
  local bin="$dir/bin/java"
  # Accept both Unix and .exe forms
  if [ ! -x "$bin" ] && [ ! -x "${bin}.exe" ]; then
    echo "0"; return
  fi
  local ver; ver=$("$bin" -version 2>&1 | head -1 | grep -oE '"[0-9.]+' | head -1 | tr -d '"')
  # "1.8.0" style → major 8; "17.0.6" style → major 17
  [[ "$ver" == 1.* ]] && ver="${ver#1.}"
  ver="${ver%%.*}"   # keep only major number
  echo "${ver:-0}"
}

find_java() {
  # Ordered preference: newer first so we pick the best available.
  local candidates=(
    "$HOME/tools/jdk-21.0.5+11"
    "$HOME/.jdks/openjdk-21"
    "$HOME/tools/jdk-17.0.10+7"
    "$HOME/.jdks/corretto-17.0.6"
    "$HOME/.jdks/openjdk-17"
    "$HOME/.jdks/openjdk-19.0.2"
    "/c/Program Files/Eclipse Adoptium/jdk-21"
    "/c/Program Files/Eclipse Adoptium/jdk-17"
    "/c/Program Files/Microsoft/jdk-21"
    "/c/Program Files/Microsoft/jdk-17"
    "/c/Program Files/Java/jdk-21"
    "/c/Program Files/Java/jdk-17"
    "/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home"
    "/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home"
  )
  for d in "${candidates[@]}"; do
    local maj; maj=$(java_major "$d")
    if [ "$maj" -ge 17 ] 2>/dev/null; then
      echo "$d"; return 0
    fi
  done
  # Android Studio bundles its own JDK (JBR) under a per-install directory whose
  # exact name varies ("Android Studio", "Android Studio1", a version suffix,
  # etc.) — this machine's real install is genuinely at "Android Studio1\jbr"
  # (confirmed: java 21.0.10), which none of the fixed candidates above ever
  # matched. That gap is exactly why an unattended run (nightly-run.mjs, no
  # JAVA_HOME pre-set in its own shell) failed this step outright while every
  # manual invocation this session succeeded — those always set JAVA_HOME
  # explicitly by hand first. Glob for it instead of hardcoding one name.
  local g
  for g in "/c/Program Files/Android/"*"/jbr" "$HOME/AppData/Local/Programs/Android Studio"*"/jbr" "/Applications/Android Studio.app/Contents/jbr/Contents/Home"; do
    [ -e "$g" ] || continue
    local maj; maj=$(java_major "$g")
    if [ "$maj" -ge 17 ] 2>/dev/null; then
      echo "$g"; return 0
    fi
  done
  return 1
}

# Check if current JAVA_HOME is valid and ≥ 17
CURRENT_JAVA_HOME="${JAVA_HOME:-}"
CURRENT_MAJ=0
if [ -n "$CURRENT_JAVA_HOME" ]; then
  CURRENT_MAJ=$(java_major "$CURRENT_JAVA_HOME")
fi

if [ "${CURRENT_MAJ:-0}" -lt 17 ]; then
  if FOUND_JAVA=$(find_java); then
    export JAVA_HOME="$FOUND_JAVA"
    export PATH="$JAVA_HOME/bin:$PATH"
    ok "Java $(java_major "$JAVA_HOME")  →  $JAVA_HOME"
  else
    fail "No JDK 17+ found. Install Temurin 21 from https://adoptium.net or set JAVA_HOME."
  fi
else
  ok "Java $CURRENT_MAJ  →  $CURRENT_JAVA_HOME"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 2. ANDROID SDK — locate it and write local.properties if needed
# ─────────────────────────────────────────────────────────────────────────────
step "Android SDK"

find_android_sdk() {
  local candidates=(
    "${ANDROID_HOME:-}"
    "${ANDROID_SDK_ROOT:-}"
    "$HOME/AppData/Local/Android/Sdk"
    "$HOME/Library/Android/sdk"
    "$HOME/Android/Sdk"
    "/c/Users/${USER:-}/AppData/Local/Android/Sdk"
  )
  for d in "${candidates[@]}"; do
    [ -z "$d" ] && continue
    [ -d "$d/platform-tools" ] && { echo "$d"; return 0; }
  done
  return 1
}

# Factored into a function (not just an inline block) because it needs to
# run TWICE on a genuine from-scratch checkout: once here at its normal
# position, and again right after step 5's `cap add android` below — that
# command wipes and fully recreates `android/`, including any
# local.properties this first call already wrote, so a fresh scaffold would
# otherwise be left without one for the rest of this run.
write_local_properties() {
  LOCAL_PROPS="$ROOT/android/local.properties"
  if [ ! -f "$LOCAL_PROPS" ] || ! grep -q "^sdk.dir=" "$LOCAL_PROPS"; then
    if SDK_DIR=$(find_android_sdk); then
      # `android/` may not exist yet on a genuine first run (before step 5's
      # `cap add android` below) — mkdir -p first so this write never fails.
      mkdir -p "$(dirname "$LOCAL_PROPS")"
      # $SDK_DIR can be a Git-Bash POSIX-style path (e.g. /c/Users/...) when
      # it came from $HOME — Gradle/the JVM run as a native Windows process
      # and cannot resolve that form at all ("Directory does not exist" even
      # though the real directory is right there). cygpath -m converts to a
      # real Windows path with forward slashes (C:/Users/...), which Gradle
      # accepts natively — this is what "local.properties uses forward-slash
      # paths on all platforms" below actually requires, on Windows too.
      if command -v cygpath &>/dev/null; then
        SDK_DIR_WIN=$(cygpath -m "$SDK_DIR")
      else
        SDK_DIR_WIN="$SDK_DIR"
      fi
      # local.properties uses forward-slash paths on all platforms (Gradle handles it)
      printf 'sdk.dir=%s\n' "$SDK_DIR_WIN" > "$LOCAL_PROPS"
      ok "Created local.properties  →  $SDK_DIR_WIN"
    else
      fail "Android SDK not found. Install via Android Studio or set ANDROID_HOME."
    fi
  else
    ok "local.properties exists  ($(grep '^sdk.dir=' "$LOCAL_PROPS"))"
  fi
}
write_local_properties

# ─────────────────────────────────────────────────────────────────────────────
# 3. NODE / NPM
# ─────────────────────────────────────────────────────────────────────────────
step "Node"
command -v node &>/dev/null || fail "Node.js not found. Install Node 18+ from https://nodejs.org"
command -v npm  &>/dev/null || fail "npm not found."
NODE_MAJ=$(node --version | grep -oE '[0-9]+' | head -1)
[ "$NODE_MAJ" -ge 18 ] || fail "Node 18+ required (found $(node --version))"
ok "Node $(node --version)"

# ─────────────────────────────────────────────────────────────────────────────
# EARLY SYNC: Always sync sensor plugin before any build steps, even on --install-only
# This ensures the Android source tree always matches src/plugins/
# ─────────────────────────────────────────────────────────────────────────────
# Also factored into a function for the same reason as write_local_properties
# above — `cap add android` (step 5) wipes and recreates `android/`, which
# would erase this copy too on a genuine from-scratch run if it were only
# ever applied once, here, before that step runs.
step "SensorPlugin (early sync)"
sync_sensor_plugin() {
  PLUGIN_SRC="$ROOT/src/plugins/sensor-sdk/android/SensorPlugin.kt"
  PLUGIN_DST="$ROOT/android/app/src/main/java/com/rehabball/sensor/SensorPlugin.kt"
  if [ -f "$PLUGIN_SRC" ]; then
    mkdir -p "$(dirname "$PLUGIN_DST")"
    cp "$PLUGIN_SRC" "$PLUGIN_DST"
    ok "SensorPlugin.kt synced to android source tree"
  else
    warn "SensorPlugin.kt not found at $PLUGIN_SRC — skipping"
  fi
}
sync_sensor_plugin

# ─────────────────────────────────────────────────────────────────────────────
# Short-circuit: --install-only skips everything below except install
# ─────────────────────────────────────────────────────────────────────────────
if [ "$INSTALL_ONLY" = true ]; then
  APK_PATH="$ROOT/android/app/build/outputs/apk/${BUILD_TYPE}/app-${BUILD_TYPE}.apk"
  [ -f "$APK_PATH" ] || fail "No APK found at $APK_PATH — run without --install-only first."
else

# ─────────────────────────────────────────────────────────────────────────────
# 4. NPM INSTALL
# ─────────────────────────────────────────────────────────────────────────────
step "npm install"
cd "$ROOT"
npm install --silent
ok "Dependencies up to date"

# ─────────────────────────────────────────────────────────────────────────────
# 5. CAPACITOR ANDROID PLATFORM (first run only)
# ─────────────────────────────────────────────────────────────────────────────
# Gated on settings.gradle, not bare directory existence: both the SDK step
# above (mkdir -p for local.properties) and the SensorPlugin early-sync step
# below (mkdir -p for the java source tree) can create `android/` before this
# point ever runs, on a genuine from-scratch checkout — a bare `-d` check
# would then wrongly see the folder as "already scaffolded" and skip
# `cap add android` entirely. settings.gradle only exists once Capacitor's
# own template has actually been laid down.
if [ ! -f "$ROOT/android/settings.gradle" ]; then
  step "Adding Android platform"
  # `cap add android` refuses outright if its target directory has ANY
  # content, not just a conflicting scaffold — and by this point the SDK
  # step's local.properties write and the SensorPlugin early-sync step above
  # have both already populated `android/` with exactly that kind of partial,
  # pre-scaffold content on a genuine from-scratch run. Since we've already
  # established (via the settings.gradle check) that no real platform is
  # scaffolded here, it's always safe to clear whatever's there first.
  if [ -d "$ROOT/android" ]; then
    rm -rf "$ROOT/android"
  fi
  npx cap add android
  # Re-apply both — `cap add android` just wiped whatever the two functions
  # above wrote before this fresh scaffold existed.
  write_local_properties
  sync_sensor_plugin
fi

# ─────────────────────────────────────────────────────────────────────────────
# 6. REGISTER PLUGIN IN MAINACTIVITY (idempotent)
#    Capacitor's own template has shipped MainActivity as BOTH .kt and .java
#    across different versions (confirmed: the Capacitor 8.x template now
#    generates MainActivity.java, where earlier templates generated .kt) — a
#    `find -name MainActivity.kt` search silently finds nothing against a
#    .java template, `$MAIN_ACTIVITY` resolves empty, the whole `[ -n ... ]`
#    guard below no-ops with no error, and SensorPlugin never gets
#    registered. That produced a real, confirmed-on-device runtime symptom
#    ("PlayworkSensor plugin is not implemented on android") with a clean
#    Gradle build — exactly the same "silent no-op, not a loud failure"
#    shape as the Crashlytics classpath bug above. Search for either
#    extension and branch the patch syntax accordingly.
# ─────────────────────────────────────────────────────────────────────────────
# `|| true` guards against SIGPIPE (exit 141) when `head -1` closes the pipe
# before `find` finishes writing further matches — under `set -o pipefail`
# that would otherwise abort the whole script.
MAIN_ACTIVITY=$(find "$ROOT/android" -name "MainActivity.kt" -o -name "MainActivity.java" 2>/dev/null | head -1) || true
if [ -n "$MAIN_ACTIVITY" ]; then
  if grep -q "SensorPlugin" "$MAIN_ACTIVITY"; then
    ok "SensorPlugin already registered in MainActivity"
  elif [[ "$MAIN_ACTIVITY" == *.java ]]; then
    info "Registering SensorPlugin in MainActivity (Java template)..."
    sed -i 's/^import com\.getcapacitor\.BridgeActivity;$/import com.getcapacitor.BridgeActivity;\nimport com.rehabball.sensor.SensorPlugin;\nimport android.os.Bundle;/' "$MAIN_ACTIVITY"
    if grep -qE 'public class MainActivity extends BridgeActivity \{\}' "$MAIN_ACTIVITY"; then
      sed -i 's/public class MainActivity extends BridgeActivity {}/public class MainActivity extends BridgeActivity {\n    @Override\n    public void onCreate(Bundle savedInstanceState) {\n        registerPlugin(SensorPlugin.class);\n        super.onCreate(savedInstanceState);\n    }\n}/' "$MAIN_ACTIVITY"
    fi
    ok "SensorPlugin registered"
  else
    info "Registering SensorPlugin in MainActivity (Kotlin template)..."
    sed -i 's/^import com\.getcapacitor\.BridgeActivity$/import com.getcapacitor.BridgeActivity\nimport com.rehabball.sensor.SensorPlugin/' "$MAIN_ACTIVITY"
    if grep -q "class MainActivity : BridgeActivity()\s*$" "$MAIN_ACTIVITY" || \
       grep -q "class MainActivity : BridgeActivity() {}" "$MAIN_ACTIVITY"; then
      sed -i '/class MainActivity : BridgeActivity()/c\class MainActivity : BridgeActivity() {\n    override fun onCreate(savedInstanceState: android.os.Bundle?) {\n        registerPlugin(SensorPlugin::class.java)\n        super.onCreate(savedInstanceState)\n    }\n}' "$MAIN_ACTIVITY"
    fi
    ok "SensorPlugin registered"
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# 6b. KOTLIN PLUGIN FOR APP MODULE (idempotent)
#     SensorPlugin.kt lives directly in the app module's own source tree, not
#     a separate library module — for AGP to compile a .kt file there at all,
#     the Kotlin Gradle plugin must be applied to `app` itself. It never was:
#     the other Kotlin-based Capacitor plugins (e.g. capacitor-community/
#     bluetooth-le) each self-apply 'kotlin-android' inside their OWN
#     build.gradle, which only compiles THEIR sources — it does nothing for
#     app's. Confirmed live: `./gradlew tasks --all` shows no
#     compileDebugKotlin task at all for :app, meaning SensorPlugin.kt was
#     silently never part of the build — no compile error (Gradle just never
#     looks at .kt files in app/src without this plugin), no missing-class
#     warning, just an absent class at runtime. This was invisible for years
#     because nothing referenced the class from Java/Kotlin code (only from
#     JS via registerPlugin's string name) until the MainActivity.java fix
#     above added a real compile-time reference to it.
# ─────────────────────────────────────────────────────────────────────────────
KOTLIN_VERSION="2.2.20"
PROJECT_GRADLE="$ROOT/android/build.gradle"
APP_GRADLE="$ROOT/android/app/build.gradle"
if [ -f "$PROJECT_GRADLE" ]; then
  if grep -q "kotlin-gradle-plugin" "$PROJECT_GRADLE"; then
    ok "Kotlin Gradle plugin classpath already present in build.gradle"
  else
    info "Injecting Kotlin Gradle plugin classpath into build.gradle..."
    sed -i "s#\(classpath 'com.android.tools.build:gradle:[^']*'\)#\1\n        classpath 'org.jetbrains.kotlin:kotlin-gradle-plugin:$KOTLIN_VERSION'#" "$PROJECT_GRADLE"
    ok "Kotlin Gradle plugin classpath injected"
  fi
fi
if [ -f "$APP_GRADLE" ]; then
  if grep -q "kotlin-android" "$APP_GRADLE"; then
    ok "kotlin-android plugin already applied in app/build.gradle"
  else
    info "Applying kotlin-android plugin + stdlib dep to app/build.gradle..."
    sed -i "s#^apply plugin: 'com.android.application'\$#apply plugin: 'com.android.application'\napply plugin: 'kotlin-android'#" "$APP_GRADLE"
    sed -i "s#\(implementation fileTree(include: \['\*.jar'\], dir: 'libs')\)#\1\n    implementation \"org.jetbrains.kotlin:kotlin-stdlib:$KOTLIN_VERSION\"#" "$APP_GRADLE"
    # Explicit Java/Kotlin JVM target — AGP's app module has no compileOptions
    # of its own today (falls back to AGP's default), so pin both to 21 (what Capacitor 8's own plugins compile with; 17 here made Kotlin and Java disagree on a fresh scaffold) to
    # avoid a Kotlin/Java jvmTarget mismatch.
    sed -i "s#^android {\$#android {\n    compileOptions {\n        sourceCompatibility JavaVersion.VERSION_21\n        targetCompatibility JavaVersion.VERSION_21\n    }\n    kotlinOptions {\n        jvmTarget = \"21\"\n    }#" "$APP_GRADLE"
    ok "kotlin-android plugin applied"
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# 7. GOOGLE SIGN-IN DEPENDENCIES (idempotent)
#    SensorPlugin.getGoogleEmail() uses Credential Manager + Google ID. The android/
#    tree is gitignored, so inject the deps here so a regenerated project still builds.
# ─────────────────────────────────────────────────────────────────────────────
APP_GRADLE="$ROOT/android/app/build.gradle"
if [ -f "$APP_GRADLE" ]; then
  if grep -q "androidx.credentials:credentials" "$APP_GRADLE"; then
    ok "Google Sign-In deps already present in app/build.gradle"
  else
    info "Injecting Credential Manager + Google ID deps into app/build.gradle..."
    # Anchored to the fileTree(...) line — present in every Capacitor Android
    # template version seen so far (7.x and 8.x alike), unlike the previous
    # anchor (a kotlinx-coroutines-android dependency line) which the 7.x
    # template shipped but the 8.x template dropped entirely, silently
    # no-op'ing this whole injection (confirmed live: zero credentials/
    # googleid lines present after a fresh 8.x `cap add android`, with no
    # error at any point — same failure shape as the other stale-anchor bugs
    # this pass found and fixed). Same anchor line the kotlin-stdlib
    # injection above already uses successfully.
    sed -i "s#\(implementation fileTree(include: \['\*.jar'\], dir: 'libs')\)#\1\n    implementation \"androidx.credentials:credentials:1.3.0\"\n    implementation \"androidx.credentials:credentials-play-services-auth:1.3.0\"\n    implementation \"com.google.android.libraries.identity.googleid:googleid:1.1.1\"#" "$APP_GRADLE"
    ok "Google Sign-In deps injected"
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# 7b. FIREBASE CONFIG (idempotent) — android/app/build.gradle already has the
#     Capacitor-default conditional `apply plugin: 'com.google.gms.google-services'
#     if google-services.json exists` wiring, and the project-level classpath is
#     already in android/build.gradle. The only missing piece on a regenerated
#     android/ tree is the config file itself, so copy it from the checked-in
#     canonical source (see CLAUDE.md "Usage Telemetry") if present.
# ─────────────────────────────────────────────────────────────────────────────
FIREBASE_SRC="$ROOT/firebase/google-services.json"
FIREBASE_DST="$ROOT/android/app/google-services.json"
if [ -f "$FIREBASE_SRC" ]; then
  cp "$FIREBASE_SRC" "$FIREBASE_DST"
  ok "google-services.json synced to android/app/"
else
  warn "firebase/google-services.json not found — Firebase Analytics will stay a no-op on Android"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 7c. CRASHLYTICS GRADLE WIRING (idempotent) — unlike Analytics, Capacitor's
#     default template does NOT ship conditional Crashlytics wiring, so inject
#     both the project-level classpath and the app-level plugin apply.
# ─────────────────────────────────────────────────────────────────────────────
PROJECT_GRADLE="$ROOT/android/build.gradle"
if [ -f "$PROJECT_GRADLE" ]; then
  if grep -q "firebase-crashlytics-gradle" "$PROJECT_GRADLE"; then
    ok "Crashlytics Gradle plugin classpath already present in build.gradle"
  else
    info "Injecting Crashlytics Gradle plugin classpath into build.gradle..."
    # Version-agnostic anchor — a literal-version match here (e.g. ':4.4.2')
    # silently no-ops the instant Capacitor's own template bumps that version
    # (it did, to 4.4.4, in the Capacitor 8.x template), since a non-matching
    # sed is not an error. Confirmed live: this exact staleness let the
    # Crashlytics classpath injection fail silently, Capacitor's own
    # try/catch(Exception) around `apply plugin` swallowed the resulting
    # UnknownPluginException at Gradle-configure time, and the app only
    # crashed at runtime on a physical device (FirebaseInitProvider ->
    # "Crashlytics build ID is missing") — invisible to `assembleDebug`
    # succeeding. Matches the wildcard-version style already used for the
    # kotlinx-coroutines anchor a few lines above.
    sed -i "s#\(classpath 'com.google.gms:google-services:[^']*'\)#\1\n        classpath 'com.google.firebase:firebase-crashlytics-gradle:2.9.9'#" "$PROJECT_GRADLE"
    ok "Crashlytics classpath injected"
  fi
fi
if [ -f "$APP_GRADLE" ]; then
  if grep -q "com.google.firebase.crashlytics" "$APP_GRADLE"; then
    ok "Crashlytics plugin already applied in app/build.gradle"
  else
    info "Injecting Crashlytics plugin apply into app/build.gradle..."
    sed -i "s#\(apply plugin: 'com.google.gms.google-services'\)#\1\n        apply plugin: 'com.google.firebase.crashlytics'#" "$APP_GRADLE"
    ok "Crashlytics plugin apply injected"
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# 7d. CSV EXPORT — LEGACY EXTERNAL STORAGE (idempotent, S-114)
#     @capacitor/filesystem's Directory.Documents write only lands in the real
#     public Documents/Downloads tree on Android 10 with this flag set (11+
#     ignores it and enforces scoped storage regardless — see CLAUDE.md's
#     S-114 resolution note for the exact caveat and the app-private fallback
#     src/utils/exportSessionsCsv.ts uses when the write is rejected).
# ─────────────────────────────────────────────────────────────────────────────
MANIFEST="$ROOT/android/app/src/main/AndroidManifest.xml"
if [ -f "$MANIFEST" ]; then
  if grep -q "requestLegacyExternalStorage" "$MANIFEST"; then
    ok "requestLegacyExternalStorage already set in AndroidManifest.xml"
  else
    info "Injecting android:requestLegacyExternalStorage into AndroidManifest.xml..."
    sed -i 's#\(android:allowBackup="true"\)#\1\n        android:requestLegacyExternalStorage="true"#' "$MANIFEST"
    ok "requestLegacyExternalStorage injected"
  fi
  if grep -q "WRITE_EXTERNAL_STORAGE" "$MANIFEST"; then
    ok "WRITE_EXTERNAL_STORAGE permission already present in AndroidManifest.xml"
  else
    info "Injecting WRITE_EXTERNAL_STORAGE permission into AndroidManifest.xml..."
    sed -i 's#\(<uses-permission android:name="android.permission.INTERNET" />\)#\1\n\n    <!-- CSV export (S-114) — only meaningful up to API 28/29; ignored/unneeded on Android 11+ scoped storage -->\n    <uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="29" />#' "$MANIFEST"
    ok "WRITE_EXTERNAL_STORAGE permission injected"
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# 7e. OPT OUT OF ANDROID 16's LARGE-SCREEN ORIENTATION-IGNORE (idempotent, S-171-c)
#     Apps targeting API 36 (this project's targetSdkVersion since S-195) have
#     setRequestedOrientation()/android:screenOrientation silently IGNORED by
#     the OS on large screens (smallest width >= 600dp — tablets, unfolded
#     foldables) — the window just fills the display in whatever physical
#     orientation the device is in, regardless of any lock this app requests.
#     This app's landscape-only lock (Trainer Panel, games — see
#     src/utils/orientationLock.ts) is a deliberate, load-bearing UX decision,
#     not incidental, so PROPERTY_COMPAT_ALLOW_RESTRICTED_RESIZABILITY opts
#     the whole app back into the pre-API-36 behavior (orientation requests
#     honoured on large screens again). Confirmed via
#     https://developer.android.com/about/versions/16/behavior-changes-16 —
#     NOTE this opt-out is Android 16-only: Android 17 removes it entirely,
#     with no manifest escape hatch, so this is a reprieve, not a permanent
#     fix — a genuinely adaptive (non-orientation-locked) large-screen layout
#     is the durable answer Google is steering toward, out of scope here.
# ─────────────────────────────────────────────────────────────────────────────
if [ -f "$MANIFEST" ]; then
  if grep -q "PROPERTY_COMPAT_ALLOW_RESTRICTED_RESIZABILITY" "$MANIFEST"; then
    ok "PROPERTY_COMPAT_ALLOW_RESTRICTED_RESIZABILITY already set in AndroidManifest.xml"
  else
    info "Injecting PROPERTY_COMPAT_ALLOW_RESTRICTED_RESIZABILITY into AndroidManifest.xml..."
    sed -i 's#\(android:theme="@style/AppTheme">\)#\1\n\n        <!-- S-171-c: Android 16 (API 36) ignores orientation-lock requests on\n             large screens (greater than or equal to 600dp) by default; this\n             app'"'"'s landscape-only UX genuinely needs it, so opt back into\n             the pre-API-36 behaviour. Android 16-only: Android 17 removes\n             this opt-out entirely, with no manifest escape hatch. -->\n        <property\n            android:name="android.window.PROPERTY_COMPAT_ALLOW_RESTRICTED_RESIZABILITY"\n            android:value="true" />#' "$MANIFEST"
    ok "PROPERTY_COMPAT_ALLOW_RESTRICTED_RESIZABILITY injected"
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# 7f. OPT OUT OF MULTI-WINDOW / SPLIT-SCREEN / DEX DESKTOP MODE (idempotent, S-171-c)
#     setRequestedOrientation() has been silently ignored whenever an activity
#     runs in multi-window mode (split-screen, freeform, Samsung DeX desktop
#     mode) since Android 7.0 -- this is unrelated to, and predates, the
#     Android 16 large-screen behaviour the property above addresses. Any app
#     targeting API 24+ is multi-window-capable BY DEFAULT unless it opts out
#     explicitly, and this app never had (MainActivity had no
#     android:resizeableActivity attribute at all until this step). Since the
#     landscape-only lock is load-bearing everywhere in this app (Trainer
#     Panel, every game -- see src/utils/orientationLock.ts), declaring the
#     activity non-resizable is the correct fix: it keeps the OS from ever
#     placing it into a windowing mode where orientation lock silently stops
#     working, across every supported Android version, not just one.
# ─────────────────────────────────────────────────────────────────────────────
if [ -f "$MANIFEST" ]; then
  if grep -q "resizeableActivity" "$MANIFEST"; then
    ok "android:resizeableActivity already set in AndroidManifest.xml"
  else
    info "Injecting android:resizeableActivity=\"false\" into AndroidManifest.xml..."
    sed -i 's#\(android:name="\.MainActivity"\)#\1\n            android:resizeableActivity="false"#' "$MANIFEST"
    ok "android:resizeableActivity=\"false\" injected"
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# 7g. RELEASE SIGNING CONFIG (idempotent) — a genuinely regenerated android/
#     tree (`cap add android`, from Capacitor's own template) ships a
#     `release { minifyEnabled false; proguardFiles ... }` block with NO
#     signingConfig at all. Gradle only auto-signs the `debug` build type —
#     `assembleRelease`/`bundleRelease` with no signingConfig applied produces
#     genuinely UNSIGNED output, which Google Play rejects outright
#     ("All uploaded bundles must be signed"). This went unnoticed for a long
#     time because tools/build/playwork-build.js's own checkKeystore() only
#     verifies android/keystore.properties exists with real (non-placeholder)
#     credentials — it never confirmed those credentials are actually wired
#     into build.gradle, and this build-android.sh script itself only ever
#     ran `assembleDebug`/`assembleRelease` (APK), never `bundleRelease`
#     (AAB) — the release *signing* gap only surfaces on the AAB path
#     `playwork-build.js` drives directly against `gradlew`, bypassing every
#     other injection step in this script entirely. Reads the same
#     android/keystore.properties file (storeFile/storePassword/keyAlias/
#     keyPassword) checkKeystore() already validates, and the actual keystore
#     lives at android/app/user.keystore (per storeFile=user.keystore,
#     resolved relative to app/build.gradle's own directory).
# ─────────────────────────────────────────────────────────────────────────────
if [ -f "$APP_GRADLE" ]; then
  if grep -q "keystorePropertiesFile" "$APP_GRADLE"; then
    ok "Release signingConfig already wired in app/build.gradle"
  else
    info "Injecting release signingConfig (keystore.properties-backed) into app/build.gradle..."
    # Step 1: the Properties-loading preamble, outside the android{} block —
    # anchored to the file's very first line, present in every template.
    sed -i "1s#\(apply plugin: 'com.android.application'\)#\1\n\ndef keystorePropertiesFile = rootProject.file('keystore.properties')\ndef keystoreProperties = new Properties()\nif (keystorePropertiesFile.exists()) {\n    keystoreProperties.load(new FileInputStream(keystorePropertiesFile))\n}#" "$APP_GRADLE"
    # Step 2: the signingConfigs block, anchored to the literal `buildTypes {`
    # line (present in every template, appears exactly once).
    sed -i "s#\(    buildTypes {\)#    signingConfigs {\n        playwork {\n            if (keystorePropertiesFile.exists()) {\n                storeFile file(keystoreProperties['storeFile'])\n                storePassword keystoreProperties['storePassword']\n                keyAlias keystoreProperties['keyAlias']\n                keyPassword keystoreProperties['keyPassword']\n            }\n        }\n    }\n\1#" "$APP_GRADLE"
    # Step 3: apply it to the release build type — anchored to the literal
    # proguardFiles line every template's release block ships with.
    sed -i "s#\(proguardFiles getDefaultProguardFile('proguard-android.txt'), 'proguard-rules.pro'\)#\1\n            if (keystorePropertiesFile.exists()) {\n                signingConfig signingConfigs.playwork\n            }#" "$APP_GRADLE"
    ok "Release signingConfig injected"
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# 7h. RELEASE R8 SHRINKING/OBFUSCATION (idempotent) — a genuinely regenerated
#     android/ tree ships `release { minifyEnabled false; ... }`, so a
#     release APK/AAB is fully unshrunk and unobfuscated. Google Play
#     Console's own "App optimization" report flags this directly (an
#     Obfuscation percentage under 25% needs attention) — R8 was never
#     actually enabled despite step 7g's release signing already being
#     wired up. Flips minifyEnabled/shrinkResources true for release only
#     (debug is untouched — obfuscated stack traces make local debugging
#     miserable and there's no Play Console requirement for it) and appends
#     this repo's canonical keep-rules (android-proguard/playwork-rules.pro
#     — edit THERE, never under android/) into the scaffold's own
#     proguard-rules.pro, since Capacitor's default template file only ever
#     has commented-out placeholder rules. Without real keep rules, R8 would
#     silently strip/rename Capacitor's reflection-resolved plugin classes
#     (see CLAUDE.md Key Rule 6/7) and break plugin registration at runtime
#     with no build-time signal — the exact "compiles fine, breaks on a real
#     device" failure class this file's own Capacitor 8.x migration notes
#     already warn about.
# ─────────────────────────────────────────────────────────────────────────────
PROGUARD_SRC="$ROOT/android-proguard/playwork-rules.pro"
PROGUARD_DST="$ROOT/android/app/proguard-rules.pro"
if [ -f "$APP_GRADLE" ]; then
  if grep -q "minifyEnabled true" "$APP_GRADLE"; then
    ok "Release R8 shrinking already enabled in app/build.gradle"
  else
    info "Enabling R8 shrinking/obfuscation for release in app/build.gradle..."
    # Anchored to the literal `minifyEnabled false` line every template's
    # release block ships with — scoped to just that line, so debug (which
    # has no minifyEnabled line at all by default) is unaffected.
    sed -i "s#\(            \)minifyEnabled false#\1minifyEnabled true\n\1shrinkResources true#" "$APP_GRADLE"
    ok "minifyEnabled/shrinkResources enabled for release"
  fi
fi
if [ -f "$PROGUARD_SRC" ] && [ -f "$PROGUARD_DST" ]; then
  if grep -q "Playwork release-build ProGuard/R8 rules" "$PROGUARD_DST"; then
    ok "Playwork proguard-rules.pro keep rules already synced"
  else
    info "Appending Playwork keep rules into android/app/proguard-rules.pro..."
    printf '\n' >> "$PROGUARD_DST"
    cat "$PROGUARD_SRC" >> "$PROGUARD_DST"
    ok "Playwork keep rules appended"
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# 8. BUILD WEB ASSETS
# ─────────────────────────────────────────────────────────────────────────────
step "Web build"
# Skip tsc type-check (use vite directly) so TS warnings don't block native builds.
# 'auto' = device router (auto.ts): genuine MetaWear -> native PlayworkSensor plugin
# (MetaWear SDK); Playwork custom-firmware ball -> bluetooth-le raw GATT.
# VITE_BUILD_CHANNEL=dev (explicit, not just left unset) — this script is the quick
# local dev/test cycle, never the interactive production build (that's
# tools/build/playwork-build.js only), so Firebase reporting must stay off here even for
# a `release`-flavored BUILD_TYPE. See src/utils/buildChannel.ts.
VITE_SENSOR_TARGET=auto VITE_BUILD_CHANNEL=dev npx vite build
ok "Web assets built"

# ─────────────────────────────────────────────────────────────────────────────
# 9. CAP SYNC
# ─────────────────────────────────────────────────────────────────────────────
step "cap sync"
npx cap sync android
ok "Synced"

# ─────────────────────────────────────────────────────────────────────────────
# 9b. LAUNCHER ICONS — android/ is gitignored, so both the generated PNGs and
#     the adaptive-icon background color must be reapplied after every cap sync.
# ─────────────────────────────────────────────────────────────────────────────
step "Launcher icons"
node "$ROOT/tools/build/generate-icons.mjs"
BG_COLOR_XML="$ROOT/android/app/src/main/res/values/ic_launcher_background.xml"
if [ -f "$BG_COLOR_XML" ]; then
  sed -i -E 's@(<color name="ic_launcher_background">)[^<]*(</color>)@\1#000000\2@' "$BG_COLOR_XML"
  ok "ic_launcher_background set to #000000"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 10. GRADLE BUILD
# ─────────────────────────────────────────────────────────────────────────────
step "Gradle"
cd "$ROOT/android"

if [ "$BUILD_TYPE" = "release" ]; then
  ./gradlew assembleRelease 2>&1 | node "$ROOT/tools/build/gradle-progress.mjs" release 52 98
  # signingConfigs.playwork (android/app/build.gradle) is applied to the release
  # build type too, so Gradle names the output "app-release.apk", not "-unsigned".
  APK_PATH="$ROOT/android/app/build/outputs/apk/release/app-release.apk"
else
  ./gradlew assembleDebug 2>&1 | node "$ROOT/tools/build/gradle-progress.mjs" debug 52 98
  APK_PATH="$ROOT/android/app/build/outputs/apk/debug/app-debug.apk"
fi

ok "APK built  →  android/app/build/outputs/apk/${BUILD_TYPE}/"

fi  # end of skip block for --install-only

# ─────────────────────────────────────────────────────────────────────────────
# 11. ADB INSTALL
# ─────────────────────────────────────────────────────────────────────────────
if [ "$NO_INSTALL" = false ] && command -v adb &>/dev/null; then
  step "Install"
  # Build device list; guard every grep/wc against pipefail on zero results
  DEVICES=()
  while IFS= read -r serial; do
    [ -n "$serial" ] && DEVICES+=("$serial")
  done < <(adb devices 2>/dev/null | tail -n +2 | grep -w "device" | awk '{print $1}' || true)
  DEVICE_COUNT="${#DEVICES[@]}"

  if [ "$DEVICE_COUNT" -eq 0 ]; then
    warn "No device connected — skipping install.  Run manually:"
    printf "      adb install -r %s\n" "$APK_PATH"
  elif [ "$DEVICE_COUNT" -eq 1 ]; then
    adb install -r "$APK_PATH"
    ok "Installed on ${DEVICES[0]}"
  else
    warn "Multiple devices connected — install manually with -s <serial>:"
    for serial in "${DEVICES[@]}"; do
      printf "      adb -s %s install -r %s\n" "$serial" "$APK_PATH"
    done
  fi
elif [ "$NO_INSTALL" = false ]; then
  warn "adb not found — skipping install"
fi

# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "  ${GREEN}✓ Done${NC}  [${BUILD_TYPE}]"
progress 100 "done"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
