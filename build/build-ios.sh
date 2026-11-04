#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Playwork — iOS build script
#
# Mirrors tools/build/build-android.sh's shape and conventions (colored step
# output, idempotent injection into gitignored generated files, early sync of
# canonical plugin source). The one structural difference: the custom
# SensorPlugin is wired in via a LOCAL COCOAPOD (:path-based pod referencing
# src/plugins/sensor-sdk/ios directly), not a copy-into-project step — so
# there is no Swift-file "sync" step the way Android needs one; CocoaPods
# reads the plugin's .swift/.m/.podspec straight from their canonical
# location every `pod install`.
#
# REQUIRES macOS + Xcode + CocoaPods — this cannot run on Windows/Linux past
# the early, pure-Node steps, so the whole script is gated on that up front
# rather than half-completing in a confusing state. See docs/ios-setup.md for
# the one-time environment setup this script assumes is already done.
#
# Usage:
#   bash tools/build/build-ios.sh                    # simulator debug build (no signing needed)
#   bash tools/build/build-ios.sh --device            # device debug build (needs --team)
#   bash tools/build/build-ios.sh --device --team ABCDE12345 --release
#   bash tools/build/build-ios.sh --no-open           # skip opening Xcode at the end
#   bash tools/build/build-ios.sh --pods-only         # just sync + pod install, no xcodebuild
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# ── Colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
ok()   { printf "${GREEN}✓${NC} %s\n" "$*"; }
info() { printf "${CYAN}→${NC} %s\n" "$*"; }
warn() { printf "${YELLOW}⚠${NC}  %s\n" "$*"; }
fail() { printf "${RED}✗${NC} %s\n" "$*" >&2; exit 1; }
step() { printf "\n${CYAN}── %s ${NC}\n" "$*"; }

# ── Parse args ───────────────────────────────────────────────────────────────
BUILD_TYPE="debug"
TARGET="simulator"     # simulator | device
TEAM_ID="${IOS_TEAM_ID:-}"
NO_OPEN=false
PODS_ONLY=false
for arg in "$@"; do
  case "$arg" in
    release)        BUILD_TYPE="release" ;;
    --device)       TARGET="device" ;;
    --simulator)    TARGET="simulator" ;;
    --team=*)       TEAM_ID="${arg#--team=}" ;;
    --team)         : ;;  # value consumed on the next iteration isn't possible in this simple loop —
                          # use --team=ID form, documented above and in docs/ios-setup.md
    --no-open)      NO_OPEN=true ;;
    --pods-only)    PODS_ONLY=true ;;
  esac
done

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Playwork iOS Build  [${BUILD_TYPE} / ${TARGET}]"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ─────────────────────────────────────────────────────────────────────────────
# 0. PLATFORM GATE — everything past npm/cap-add needs a real Mac
# ─────────────────────────────────────────────────────────────────────────────
step "Platform"
if [ "$(uname -s)" != "Darwin" ]; then
  fail "iOS builds require macOS (Xcode + CocoaPods). This script must be run on a Mac — see docs/ios-setup.md for the one-time environment setup."
fi
ok "macOS $(sw_vers -productVersion 2>/dev/null || echo unknown)"

command -v xcodebuild &>/dev/null || fail "Xcode command-line tools not found. Install Xcode from the App Store, then run: xcode-select --install && sudo xcode-select -s /Applications/Xcode.app"
# `|| true` guards against SIGPIPE (exit 141) when `head -1` closes the pipe
# before `xcodebuild -version`'s multi-line output finishes writing — under
# `set -o pipefail` that would otherwise abort the whole script.
XCODE_VER=$(xcodebuild -version 2>/dev/null | head -1) || true
ok "$XCODE_VER"

command -v pod &>/dev/null || fail "CocoaPods not found. Install with: sudo gem install cocoapods  (or: brew install cocoapods)"
ok "CocoaPods $(pod --version)"

# `pod` (via `cap sync ios`'s own internal `pod install` AND this script's
# explicit one, step 11) hard-crashes with a Ruby `Encoding::CompatibilityError`
# ("Unicode Normalization not appropriate for ASCII-8BIT") whenever the calling
# shell's locale isn't a UTF-8 one — found running this script for the first
# time from an environment with no LANG/LC_ALL set at all. Since `cap sync`'s
# internal pod install runs BEFORE step 7's CapacitorFirebaseAnalytics subspec
# injection even exists in the Podfile yet, this crash (under `set -euo
# pipefail`) aborts the whole script right there, well before ever reaching
# the fix for that subspec gap — so a first-ever run in a non-UTF-8 shell
# looks like the CapacitorFirebaseAnalytics/Firebase wiring is broken when
# it's really just this locale crash pre-empting the script entirely. Forcing
# a real UTF-8 locale here, unconditionally, makes the script self-sufficient
# regardless of the caller's own shell environment.
export LANG=en_US.UTF-8
export LC_ALL=en_US.UTF-8

# ─────────────────────────────────────────────────────────────────────────────
# 1. NODE / NPM
# ─────────────────────────────────────────────────────────────────────────────
step "Node"
command -v node &>/dev/null || fail "Node.js not found. Install Node 18+ from https://nodejs.org"
command -v npm  &>/dev/null || fail "npm not found."
NODE_MAJ=$(node --version | grep -oE '[0-9]+' | head -1)
[ "$NODE_MAJ" -ge 18 ] || fail "Node 18+ required (found $(node --version))"
ok "Node $(node --version)"

# ─────────────────────────────────────────────────────────────────────────────
# 2. NPM INSTALL
# ─────────────────────────────────────────────────────────────────────────────
step "npm install"
cd "$ROOT"
npm install --silent
ok "Dependencies up to date"

# ─────────────────────────────────────────────────────────────────────────────
# 3. CAPACITOR iOS PLATFORM (first run only)
# ─────────────────────────────────────────────────────────────────────────────
if [ ! -d "$ROOT/ios" ]; then
  step "Adding iOS platform"
  # Capacitor 8's `cap add ios` defaults to Swift Package Manager, not
  # CocoaPods — but this app's whole iOS wiring (the local SensorPlugin
  # CocoaPod, S-226) requires a Podfile-based project, so request it
  # explicitly rather than relying on the CLI's own default.
  npx cap add ios --packagemanager CocoaPods
  ok "ios/ scaffolded"
else
  ok "ios/ already exists"
  if [ ! -f "$ROOT/ios/App/Podfile" ]; then
    warn "ios/ exists but has no Podfile (likely scaffolded with SPM) — regenerating with CocoaPods"
    rm -rf "$ROOT/ios"
    npx cap add ios --packagemanager CocoaPods
    ok "ios/ re-scaffolded with CocoaPods"
  fi
fi

PODFILE="$ROOT/ios/App/Podfile"
CONFIG_JSON="$ROOT/ios/App/App/capacitor.config.json"
INFO_PLIST="$ROOT/ios/App/App/Info.plist"
PLUGIN_DIR="$ROOT/src/plugins/sensor-sdk/ios"

[ -f "$PODFILE" ]     || fail "Podfile not found at $PODFILE — did 'cap add ios' succeed?"
[ -f "$INFO_PLIST" ]  || fail "Info.plist not found at $INFO_PLIST"
[ -d "$PLUGIN_DIR" ]  || fail "SensorPlugin source not found at $PLUGIN_DIR"

# ─────────────────────────────────────────────────────────────────────────────
# 4. REGISTER SensorPlugin AS A LOCAL POD (idempotent)
#    :path is relative to ios/App/ (where the Podfile lives), matching every
#    other local-path pod already in this file (Capacitor itself, etc).
# ─────────────────────────────────────────────────────────────────────────────
step "Modular headers (Firebase pod resolution)"
# Firebase's Swift pods (FirebaseCore/FirebaseAnalytics, pulled in transitively
# by @capacitor-firebase/analytics + crashlytics) depend on several
# Objective-C-only pods (GoogleUtilities, nanopb, PromisesObjC) that only
# expose a proper Clang module map to Swift consumers when CocoaPods is told
# to generate modular headers for every pod — without this, a real Xcode
# build fails with "unable to resolve module dependency: 'FirebaseCore'"
# (found doing the first-ever real compile of this project, S-231). Fixed by
# Firebase's own documented CocoaPods requirement: `use_modular_headers!`
# alongside `use_frameworks!`.
if grep -q "^use_modular_headers!" "$PODFILE"; then
  ok "use_modular_headers! already present in Podfile"
else
  info "Adding use_modular_headers! to Podfile..."
  sed -i '' "s|^use_frameworks!|use_frameworks!\\
use_modular_headers!|" "$PODFILE"
  ok "use_modular_headers! added"
fi

step "SensorPlugin pod registration"
if grep -q "pod 'SensorPlugin'" "$PODFILE"; then
  ok "SensorPlugin pod already registered in Podfile"
else
  info "Injecting SensorPlugin pod into Podfile..."
  # Insert right after the "# Add your Pods here" marker Capacitor's template
  # leaves inside `target 'App' do ... end` specifically for this purpose.
  # Delimiter is `|`, not `#` — the marker text itself contains a literal
  # `#`, which broke sed's own field parsing when `#` was also the delimiter.
  sed -i '' "s|  # Add your Pods here|  pod 'SensorPlugin', :path => '../../src/plugins/sensor-sdk/ios'\\
  # Add your Pods here|" "$PODFILE"
  ok "SensorPlugin pod injected"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 5. INFO.PLIST — Bluetooth usage description + background mode (idempotent)
#    PlistBuddy (macOS-only) edits the binary/XML plist safely — no risk of
#    the malformed-XML failure mode a blind sed/text edit could cause.
# ─────────────────────────────────────────────────────────────────────────────
step "Info.plist (Bluetooth + export compliance)"
PLIST_BUDDY=/usr/libexec/PlistBuddy

if $PLIST_BUDDY -c "Print :NSBluetoothAlwaysUsageDescription" "$INFO_PLIST" &>/dev/null; then
  ok "NSBluetoothAlwaysUsageDescription already set"
else
  info "Adding NSBluetoothAlwaysUsageDescription..."
  $PLIST_BUDDY -c "Add :NSBluetoothAlwaysUsageDescription string 'Playwork connects to your therapy ball over Bluetooth to read pressure and rotation during games and tests.'" "$INFO_PLIST"
  ok "NSBluetoothAlwaysUsageDescription added"
fi

# Older-iOS compatibility key some review guidance still checks for.
if $PLIST_BUDDY -c "Print :NSBluetoothPeripheralUsageDescription" "$INFO_PLIST" &>/dev/null; then
  ok "NSBluetoothPeripheralUsageDescription already set"
else
  info "Adding NSBluetoothPeripheralUsageDescription..."
  $PLIST_BUDDY -c "Add :NSBluetoothPeripheralUsageDescription string 'Playwork connects to your therapy ball over Bluetooth to read pressure and rotation during games and tests.'" "$INFO_PLIST"
  ok "NSBluetoothPeripheralUsageDescription added"
fi

if $PLIST_BUDDY -c "Print :UIBackgroundModes" "$INFO_PLIST" &>/dev/null; then
  if $PLIST_BUDDY -c "Print :UIBackgroundModes" "$INFO_PLIST" | grep -q "bluetooth-central"; then
    ok "UIBackgroundModes already includes bluetooth-central"
  else
    info "Appending bluetooth-central to existing UIBackgroundModes..."
    $PLIST_BUDDY -c "Add :UIBackgroundModes: string bluetooth-central" "$INFO_PLIST"
    ok "bluetooth-central appended"
  fi
else
  info "Adding UIBackgroundModes array with bluetooth-central..."
  $PLIST_BUDDY -c "Add :UIBackgroundModes array" "$INFO_PLIST"
  $PLIST_BUDDY -c "Add :UIBackgroundModes: string bluetooth-central" "$INFO_PLIST"
  ok "UIBackgroundModes added"
fi

# App only uses standard OS-provided encryption (WebCrypto AES-GCM for at-rest
# storage, HTTPS/TLS for network calls) — no proprietary algorithm, so it
# qualifies for Apple's export-compliance exemption. Declaring this in
# Info.plist skips the encryption-compliance prompt on every TestFlight/App
# Store upload.
if $PLIST_BUDDY -c "Print :ITSAppUsesNonExemptEncryption" "$INFO_PLIST" &>/dev/null; then
  ok "ITSAppUsesNonExemptEncryption already set"
else
  info "Adding ITSAppUsesNonExemptEncryption (false)..."
  $PLIST_BUDDY -c "Add :ITSAppUsesNonExemptEncryption bool false" "$INFO_PLIST"
  ok "ITSAppUsesNonExemptEncryption added"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 6. BUILD WEB ASSETS — VITE_BUILD_CHANNEL defaults to "dev": every ordinary
#    invocation of this script is the quick local dev/test cycle, never a
#    real release — see src/utils/buildChannel.ts. The one caller that needs
#    "prod" is fastlane/Fastfile's `beta` lane (the actual TestFlight release
#    path), which sets VITE_BUILD_CHANNEL=prod in its own environment before
#    calling this script with --pods-only — respected here via the shell's
#    own "inherit if already set, else default" `${VAR:-default}` form, so
#    every other caller's behavior is completely unchanged.
# ─────────────────────────────────────────────────────────────────────────────
step "Web build"
VITE_SENSOR_TARGET=auto VITE_BUILD_CHANNEL="${VITE_BUILD_CHANNEL:-dev}" npx vite build
ok "Web assets built (channel: ${VITE_BUILD_CHANNEL:-dev})"

# ─────────────────────────────────────────────────────────────────────────────
# 7. CAP SYNC
# ─────────────────────────────────────────────────────────────────────────────
step "cap sync"
npx cap sync ios
ok "Synced"

# ─────────────────────────────────────────────────────────────────────────────
# 7a. APP ICON — ios/ is gitignored, and `cap add ios` scaffolds its own
#     generic Capacitor placeholder icon into AppIcon.appiconset; nothing
#     ever replaced it with the real brand asset the way Android's own
#     generate-icons.mjs already does, so a real device install showed the
#     wrong icon (reported live: "the icon of the app doesnt match the one
#     on android"). Same script, now platform-aware — see its own doc
#     comment for the opaque/no-alpha requirement this generates for.
# ─────────────────────────────────────────────────────────────────────────────
step "App icon"
node "$ROOT/tools/build/generate-icons.mjs"

# ─────────────────────────────────────────────────────────────────────────────
# 7b. CapacitorFirebaseAnalytics POD SUBSPEC (idempotent, must run after every
#     `cap sync ios` — sync REGENERATES the Podfile's `capacitor_pods` block
#     from the installed npm plugin list, wiping any manual edit to this line)
#
#     @capacitor-firebase/analytics's own podspec defaults to a `Lite`
#     subspec with NO Firebase SDK dependency at all — but its Swift source
#     (FirebaseAnalytics.swift) unconditionally `import`s FirebaseCore and
#     FirebaseAnalytics regardless, so with the default subspec a real build
#     fails with "unable to resolve module dependency: 'FirebaseCore'" (found
#     doing the first-ever real compile of this project, S-231). The plugin's
#     own install docs require explicitly selecting a subspec that pulls in
#     the real Firebase Analytics SDK — `AnalyticsWithoutAdIdSupport` chosen
#     over plain `Analytics` since it skips IDFA/ad-id support, matching this
#     app's privacy-conscious, consent-gated analytics design (see CLAUDE.md
#     "Usage Telemetry").
# ─────────────────────────────────────────────────────────────────────────────
step "CapacitorFirebaseAnalytics pod subspec"
if grep -q "CapacitorFirebaseAnalytics'.*:subspecs" "$PODFILE"; then
  ok "Subspec already set in Podfile"
else
  info "Adding :subspecs => ['AnalyticsWithoutAdIdSupport'] to CapacitorFirebaseAnalytics..."
  sed -i '' "s|pod 'CapacitorFirebaseAnalytics', :path => '\\.\\./\\.\\./node_modules/@capacitor-firebase/analytics'|pod 'CapacitorFirebaseAnalytics', :path => '../../node_modules/@capacitor-firebase/analytics', :subspecs => ['AnalyticsWithoutAdIdSupport']|" "$PODFILE"
  grep -q "CapacitorFirebaseAnalytics'.*:subspecs" "$PODFILE" || fail "Failed to inject Firebase Analytics subspec into Podfile — check the pod line still matches the expected pattern"
  ok "Subspec added"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 8. REGISTER SensorPlugin CLASS IN capacitor.config.json (idempotent)
#    cap sync REGENERATES this file every time from the installed npm plugin
#    list — SensorPlugin is a LOCAL pod, not an npm package, so it is never
#    auto-discovered here and this injection must run after every sync, not
#    just once. Done via Node (already verified present, step 1) rather than
#    sed, since this is a JSON array and needs to stay valid JSON.
# ─────────────────────────────────────────────────────────────────────────────
step "capacitor.config.json (packageClassList)"
node -e "
  const fs = require('fs');
  const path = '$CONFIG_JSON';
  const cfg = JSON.parse(fs.readFileSync(path, 'utf8'));
  cfg.packageClassList = cfg.packageClassList || [];
  // SensorPlugin2 is the second ball (S-254): a separate plugin instance with its own link.
  let changed = false;
  for (const name of ['SensorPlugin', 'SensorPlugin2']) {
    if (!cfg.packageClassList.includes(name)) { cfg.packageClassList.push(name); changed = true; }
  }
  if (changed) {
    fs.writeFileSync(path, JSON.stringify(cfg, null, '\t') + '\n');
    console.log('injected');
  } else {
    console.log('present');
  }
" | { read -r result; if [ "$result" = "injected" ]; then ok "SensorPlugin added to packageClassList"; else ok "SensorPlugin already in packageClassList"; fi; }

# ─────────────────────────────────────────────────────────────────────────────
# 9. GOOGLE-SERVICE-INFO.PLIST (Firebase Analytics/Crashlytics) — best-effort,
#    same canonical-source pattern as Android's firebase/google-services.json.
#    Not present until an iOS app is registered in the Firebase console (see
#    docs/ios-setup.md) — Firebase stays a safe no-op on iOS until then,
#    exactly like Android's own "warn and continue" behavior.
# ─────────────────────────────────────────────────────────────────────────────
step "Firebase config"
FIREBASE_IOS_SRC="$ROOT/firebase/GoogleService-Info.plist"
FIREBASE_IOS_DST="$ROOT/ios/App/App/GoogleService-Info.plist"
if [ -f "$FIREBASE_IOS_SRC" ]; then
  cp "$FIREBASE_IOS_SRC" "$FIREBASE_IOS_DST"
  ok "GoogleService-Info.plist synced to ios/App/App/"

  # ───────────────────────────────────────────────────────────────────────
  # Unlike Android (where the Google Services Gradle plugin only applies —
  # and FirebaseApp only ever initializes — IFF google-services.json is
  # present, so a missing file is a silent no-op), @capacitor-firebase's iOS
  # plugins call `FirebaseApp.configure()` UNCONDITIONALLY from their own
  # Swift `load()`/init, every app launch, regardless of whether a plist
  # exists. With none present at all, or present on disk but not an actual
  # Xcode project member, the app hard-crashes at launch with an NSException
  # ("could not find a valid GoogleService-Info.plist") — found the hard way
  # doing the first-ever real run of this project (S-231): simply copying
  # the file into ios/App/App/ on disk, as this script always did, is NOT
  # enough — Xcode only bundles resources it knows about via the .xcodeproj
  # itself, and Capacitor's template never references this file since it
  # doesn't know about Firebase ahead of time. Adding it to the project's
  # Resources build phase (idempotently, via the `xcodeproj` Ruby gem
  # CocoaPods itself already depends on and ships) is a REQUIRED companion
  # step to the copy above, every time — not an optional nicety.
  # ───────────────────────────────────────────────────────────────────────
  step "GoogleService-Info.plist Xcode project membership"
  # Resolve a ruby that can actually `require 'xcodeproj'` — try the plain
  # `ruby` on PATH first (covers a system-/rbenv-managed xcodeproj install),
  # then fall back to the exact ruby + GEM_HOME the installed `pod` binary
  # itself uses (CocoaPods always ships `xcodeproj` as a hard dependency, so
  # this is a reliable, version-independent path to a working interpreter).
  XCODEPROJ_RUBY_OK=false
  if ruby -e "require 'xcodeproj'" &>/dev/null; then
    XCODEPROJ_RUBY_CMD=(ruby)
    XCODEPROJ_RUBY_OK=true
  else
    POD_GEM_HOME="$(grep -o 'GEM_HOME="[^"]*"' "$(command -v pod)" 2>/dev/null | head -1 | sed 's/GEM_HOME="//;s/"$//')"
    if [ -n "$POD_GEM_HOME" ] && GEM_HOME="$POD_GEM_HOME" /opt/homebrew/opt/ruby/bin/ruby -e "require 'xcodeproj'" &>/dev/null; then
      XCODEPROJ_RUBY_CMD=(env GEM_HOME="$POD_GEM_HOME" /opt/homebrew/opt/ruby/bin/ruby)
      XCODEPROJ_RUBY_OK=true
    fi
  fi
  if [ "$XCODEPROJ_RUBY_OK" = true ]; then
    "${XCODEPROJ_RUBY_CMD[@]}" -e "
      require 'xcodeproj'
      project_path = '$ROOT/ios/App/App.xcodeproj'
      project = Xcodeproj::Project.open(project_path)
      target = project.targets.find { |t| t.name == 'App' }
      already = target.resources_build_phase.files.any? { |f| f.file_ref && f.file_ref.path == 'GoogleService-Info.plist' }
      if already
        puts 'already a project member'
      else
        info_plist_ref = project.files.find { |f| f.path == 'Info.plist' }
        group = info_plist_ref ? info_plist_ref.parent : project.main_group
        file_ref = group.new_reference('GoogleService-Info.plist')
        target.resources_build_phase.add_file_reference(file_ref)
        project.save
        puts 'added to Resources build phase'
      end
    " | while read -r line; do info "$line"; done
    ok "GoogleService-Info.plist registered in App.xcodeproj"
  else
    fail "Could not find a Ruby with the 'xcodeproj' gem (CocoaPods' own dependency) to register GoogleService-Info.plist in App.xcodeproj — without this, Firebase will crash at launch even though the file exists on disk. Try: gem install xcodeproj"
  fi
else
  warn "firebase/GoogleService-Info.plist not found — Firebase's iOS plugins call FirebaseApp.configure() unconditionally at launch (no config-file guard like Android's Gradle plugin has), so the app WILL crash on launch without this file, not just silently skip telemetry. See docs/ios-setup.md for how to get a real one, or generate a placeholder (fine for local dev — telemetry silently fails rather than crashing) per the comment at the top of a previously-generated firebase/GoogleService-Info.plist."
fi

# ─────────────────────────────────────────────────────────────────────────────
# 10. POD INSTALL
# ─────────────────────────────────────────────────────────────────────────────
step "pod install"
cd "$ROOT/ios/App"
pod install --repo-update
ok "Pods installed  →  ios/App/App.xcworkspace"
cd "$ROOT"

if [ "$PODS_ONLY" = true ]; then
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  printf "  ${GREEN}✓ Pods ready${NC} (--pods-only, skipping xcodebuild)\n"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  exit 0
fi

# ─────────────────────────────────────────────────────────────────────────────
# 11. XCODEBUILD
#     Simulator builds need no signing at all (CODE_SIGNING_ALLOWED=NO).
#     Device builds need a real Apple Developer Team ID — pass --team=<ID> or
#     set IOS_TEAM_ID; xcodebuild will otherwise fail with a clear signing
#     error rather than silently producing an unusable artifact.
# ─────────────────────────────────────────────────────────────────────────────
step "xcodebuild"
WORKSPACE="$ROOT/ios/App/App.xcworkspace"
[ -d "$WORKSPACE" ] || fail "Workspace not found at $WORKSPACE — pod install may have failed."

CONFIGURATION="Debug"
[ "$BUILD_TYPE" = "release" ] && CONFIGURATION="Release"

if [ "$TARGET" = "simulator" ]; then
  info "Building for iOS Simulator (${CONFIGURATION}, unsigned)..."
  xcodebuild \
    -workspace "$WORKSPACE" \
    -scheme "App" \
    -configuration "$CONFIGURATION" \
    -destination "generic/platform=iOS Simulator" \
    -sdk iphonesimulator \
    CODE_SIGNING_ALLOWED=NO \
    build
  ok "Simulator build succeeded (${CONFIGURATION})"
else
  [ -n "$TEAM_ID" ] || fail "Device build requires a Team ID. Pass --team=YOUR_TEAM_ID or set IOS_TEAM_ID. Find it at https://developer.apple.com/account → Membership."
  info "Building for a real iOS device (${CONFIGURATION}, team=${TEAM_ID})..."
  # -allowProvisioningUpdates is required for a device build with automatic
  # signing — without it, xcodebuild refuses to contact the Apple Developer
  # portal to register the connected device's UDID and generate/renew a
  # matching provisioning profile, failing outright with "No profiles for
  # '...' were found" even though the team/identity themselves are valid
  # (found doing the first-ever real device build of this project, S-231).
  xcodebuild \
    -workspace "$WORKSPACE" \
    -scheme "App" \
    -configuration "$CONFIGURATION" \
    -destination "generic/platform=iOS" \
    -sdk iphoneos \
    -allowProvisioningUpdates \
    DEVELOPMENT_TEAM="$TEAM_ID" \
    build
  ok "Device build succeeded (${CONFIGURATION})"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 12. OPEN XCODE
# ─────────────────────────────────────────────────────────────────────────────
if [ "$NO_OPEN" = false ]; then
  step "Opening Xcode"
  open "$WORKSPACE"
  ok "Opened $WORKSPACE — run on a Simulator or a connected device from here for day-to-day iteration."
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
printf "  ${GREEN}✓ Done${NC}  [${BUILD_TYPE} / ${TARGET}]\n"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
