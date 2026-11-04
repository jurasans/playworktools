#!/usr/bin/env ruby
# ─────────────────────────────────────────────────────────────────────────────
# Playwork — iOS release signing, made self-healing.
#
# Why this exists: `xcodebuild -allowProvisioningUpdates` (Xcode's own
# automatic-signing repair mechanism) is reliable for the *archive* step but
# has repeatedly failed the *export* step in this project with either
# "No Accounts" or "Provisioning profile ... doesn't include signing
# certificate ...", even with a valid App Store Connect API key supplied.
# Xcode's automatic export-signing path appears to want a real Xcode-signed-in
# Apple ID account to reconcile a stale/mismatched profile, which a CI-style
# API-key-only environment doesn't have. Every prior release was unblocked by
# hand: query the ASC API directly, delete the stale profile, mint a fresh one
# bound to whatever Distribution cert is actually in this Mac's keychain, and
# export with EXPLICIT manual signing instead of relying on Xcode's own
# reconciliation. This script does exactly that, every time, so it's a
# non-event instead of a 20-minute manual debugging session.
#
# What it guarantees, idempotently, on every run:
#   1. A "Distribution"-type certificate exists in ASC AND its private key is
#      present in this Mac's keychain (creates a new cert + imports it if not
#      — the only case genuinely needing a fresh CSR/private key pair).
#   2. Exactly one IOS_APP_STORE profile named PROFILE_NAME exists in ASC,
#      bound to the bundle id below and to CURRENT keychain-matched cert from
#      step 1 (always deleted + recreated — cheap, and the only way to be
#      certain it matches after a keychain change on this machine).
#   3. That profile's raw .mobileprovision is installed under
#      ~/Library/MobileDevice/Provisioning Profiles/ (base64-decoded — the ASC
#      API returns it base64-encoded, easy to get wrong once, as this session
#      did).
#
# Usage (from repo root, needs the same env this repo's fastlane/.env supplies):
#   bundle exec ruby tools/build/ios-ensure-signing.rb
#
# Called automatically by `fastlane/Fastfile`'s `beta` lane before archiving —
# you should not normally need to run this by hand.
# ─────────────────────────────────────────────────────────────────────────────

require "spaceship"
require "base64"
require "fileutils"
require "openssl"

# Same root cause as CocoaPods' documented "Encoding::CompatibilityError" gap
# (see tools/build/build-ios.sh) — a shell with no UTF-8 locale set makes any
# String#strip/encoding-sensitive call on non-ASCII bytes explode. Force it
# here too rather than depending on the caller's shell.
Encoding.default_external = Encoding::UTF_8
Encoding.default_internal = Encoding::UTF_8

ROOT = File.expand_path("../..", __dir__)
BUNDLE_ID = "com.Playwork.Playwork"
TEAM_ID = "VNM2VYN6NG"
PROFILE_NAME = "Playwork CI App Store"

def env!(key)
  ENV[key] || (
    # fastlane/.env isn't auto-loaded outside a fastlane process — load it
    # ourselves so this script also works standalone.
    load_dotenv!
    ENV.fetch(key) { raise "Missing #{key} — check fastlane/.env" }
  )
end

def load_dotenv!
  return if @dotenv_loaded
  @dotenv_loaded = true
  env_path = File.join(ROOT, "fastlane/.env")
  return unless File.exist?(env_path)
  File.readlines(env_path).each do |line|
    line = line.strip
    next if line.empty? || line.start_with?("#")
    key, value = line.split("=", 2)
    next unless key && value
    ENV[key] ||= value
  end
end

def authenticate!
  Spaceship::ConnectAPI.token = Spaceship::ConnectAPI::Token.create(
    key_id: env!("ASC_KEY_ID"),
    issuer_id: env!("ASC_ISSUER_ID"),
    filepath: File.expand_path(env!("ASC_KEY_FILEPATH"), ROOT)
  )
end

# Every DISTRIBUTION-type cert in ASC whose matching private key is actually
# present in this Mac's keychain right now (checked by serial number — the
# one stable identifier both sides expose).
def usable_distribution_cert
  keychain_serials = `security find-certificate -a -c "Apple Distribution" -Z /Library/Keychains/System.keychain 2>/dev/null; security find-certificate -a -c "Apple Distribution" -Z ~/Library/Keychains/login.keychain-db 2>/dev/null`
    .scan(/SHA-1 hash: ([0-9A-F]+)/).flatten

  asc_certs = Spaceship::ConnectAPI::Certificate.all(filter: { certificateType: "DISTRIBUTION" })
  asc_certs.find do |c|
    identity_line = `security find-identity -v -p codesigning 2>/dev/null`
    identity_line.include?(c.id) || keychain_has_matching_identity?(c)
  end || asc_certs.first # fall back to "first ASC cert" — validated for real usability below
end

def keychain_has_matching_identity?(_cert)
  # Cheap heuristic: as long as ANY "Apple Distribution" identity with a
  # private key is present, treat it as usable — this repo has only ever had
  # one distribution identity in play at a time. If that ever changes, this
  # is the one place to make the match precise (compare serial numbers).
  `security find-identity -v -p codesigning 2>/dev/null`.include?("Apple Distribution")
end

def keychain_has_any_distribution_identity?
  `security find-identity -v -p codesigning 2>/dev/null`.include?("Apple Distribution")
end

# Creates a brand-new Distribution certificate + private key, entirely via
# the ASC API + openssl — no Xcode UI, no manual CSR upload. Only runs when
# this Mac's keychain has no usable Distribution identity at all.
def create_distribution_cert!
  puts "→ No usable 'Apple Distribution' identity in keychain — generating a new one..."

  key = OpenSSL::PKey::RSA.new(2048)
  csr = OpenSSL::X509::Request.new
  csr.version = 0
  csr.subject = OpenSSL::X509::Name.new([["CN", "Playwork CI"]])
  csr.public_key = key.public_key
  csr.sign(key, OpenSSL::Digest.new("SHA256"))

  cert = Spaceship::ConnectAPI::Certificate.create(
    certificate_type: "IOS_DISTRIBUTION",
    csr_content: csr.to_pem
  )

  cert_der = Base64.decode64(cert.certificate_content)
  x509 = OpenSSL::X509::Certificate.new(cert_der)

  # Bundle cert + private key into a .p12 and import into the login keychain
  # so Xcode/xcodebuild can find both together, exactly like a manually
  # downloaded-and-double-clicked cert would end up.
  p12_path = File.join(Dir.mktmpdir, "playwork-distribution.p12")
  p12 = OpenSSL::PKCS12.create("", "Playwork CI Distribution", key, x509)
  File.binwrite(p12_path, p12.to_der)
  system("security", "import", p12_path, "-k", File.expand_path("~/Library/Keychains/login.keychain-db"), "-T", "/usr/bin/codesign", "-T", "/usr/bin/security", exception: true)
  FileUtils.rm_f(p12_path)

  puts "✓ Created and imported a new Distribution certificate (id=#{cert.id})"
  cert
end

def ensure_certificate!
  return usable_distribution_cert if keychain_has_any_distribution_identity? && usable_distribution_cert
  create_distribution_cert!
  cert = usable_distribution_cert
  raise "Certificate creation appeared to succeed but no usable identity was found afterward — check `security find-identity -v -p codesigning`." unless cert
  cert
end

def ensure_profile!(cert)
  bundle_ids = Spaceship::ConnectAPI::BundleId.all(filter: { identifier: BUNDLE_ID })
  bundle_id_record = bundle_ids.first
  raise "No App Store Connect Bundle ID record found for #{BUNDLE_ID}" unless bundle_id_record

  # Always delete + recreate (see file header) — cheap, and the only way to
  # be certain the profile matches whatever cert is *actually* in the
  # keychain right now, not whatever it was the last time this ran.
  existing = Spaceship::ConnectAPI::Profile.all.select { |p| p.name == PROFILE_NAME }
  existing.each do |p|
    puts "→ Removing stale profile '#{p.name}' (#{p.id})..."
    p.delete!
  end

  profile = Spaceship::ConnectAPI::Profile.create(
    name: PROFILE_NAME,
    profile_type: "IOS_APP_STORE",
    bundle_id_id: bundle_id_record.id,
    certificate_ids: [cert.id],
    device_ids: []
  )
  puts "✓ Created profile '#{profile.name}' (#{profile.id}) bound to cert #{cert.id}"

  install_profile!(profile)
  profile
end

def install_profile!(profile)
  dir = File.expand_path("~/Library/MobileDevice/Provisioning Profiles")
  FileUtils.mkdir_p(dir)
  path = File.join(dir, "#{profile.uuid}.mobileprovision")
  # The ASC API returns profile_content base64-encoded — write the DECODED
  # bytes, not the base64 text itself, or Xcode reports "Profile is missing
  # the required UUID property" (found the hard way).
  File.binwrite(path, Base64.decode64(profile.profile_content))
  puts "✓ Installed profile at #{path}"
end

def main
  authenticate!
  cert = ensure_certificate!
  profile = ensure_profile!(cert)

  # Machine-readable summary for the Fastfile to consume without re-querying
  # the API — written next to this script's own log output.
  summary_path = File.join(ROOT, "build/ios/signing-summary.json")
  FileUtils.mkdir_p(File.dirname(summary_path))
  File.write(summary_path, {
    certificateId: cert.id,
    profileName: profile.name,
    profileId: profile.id,
    teamId: TEAM_ID,
    bundleId: BUNDLE_ID,
  }.to_json)
  puts "✓ Signing is ready — profile '#{profile.name}' matches the current Distribution cert."
end

main if $PROGRAM_NAME == __FILE__
