# Playwork — App Review Reply

*Guideline 2.1 · Information Needed*

Apple asked for six things before they'll finish reviewing the new-app submission. Below is what to send, drafted from Playwork's actual spec, plus one blocker worth fixing before you resubmit.

> **Read this before you reply.** The reviewer has no physical Playwork sensor ball. The app's very first screen (`/connect`) requires a real Bluetooth device to proceed — a numeric-ID login is gated behind it. Unless the reviewer can get past that screen, they can't see anything else, and this rejection turns into a second one for "app is unusable."
>
> You need a way past this before resubmitting. See the checklist below — this is step 1, before you even touch the written answers.

## What to actually do, in order

1. Decide how the reviewer gets past the sensor-connect screen (see the note under item 3 below), and ship a review build that supports it.
2. Record a screen capture on a real iPhone, on the current iOS release, of the whole flow end to end (see item 1).
3. Upload the recording somewhere Apple can access it (Apple doesn't take video attachments directly in the reply — see note below) and get a link.
4. In App Store Connect → your app → App Review submission → open the reviewer message thread and reply with all six answers plus the video link, in one message.
5. **Also** paste the same six answers into App Review Information → **Notes** field, so future submissions don't trigger this again.
6. If your Notes field doesn't already carry demo access instructions, add them there too — see item 3.
7. Resubmit the build for review.

## 1 — Screen recording

Apple wants: real device, latest iOS, starts at launch, shows the typical flow. Good news — Playwork has none of the three trigger conditions they list (no account registration/deletion flow in the App Store Connect sense, no user-generated content, no paid content), so the recording can be short and simple.

**Suggested flow to record (2–4 minutes):**

- Launch the app from a cold start on a physical iPhone.
- Sensor connect screen → connect (or demo-mode bypass, see item 3's note).
- Login screen → enter a numeric ID or tap Continue as Guest.
- Home screen → show the Games and Tests cards.
- Pick a game → funnel (region/extremity/laterality) → calibration → play a few seconds → game over.
- Back to Home → Tests card → run a quick strength test through to the result screen.
- Open the global sensor pill → tap Trainer Mode → briefly show Settings / Game Results / Test Results tabs.

> **Note:** App Store Connect's reviewer-reply thread is text-only — you can't attach a video file directly to the message. Upload the recording to a host Apple can open without a login (a public/unlisted link works for most teams) and paste that link into both the reply and the Notes field.

## 2 — Purpose & audience

> Playwork is a physical rehabilitation app used in clinics by physiotherapists and their patients. Patients squeeze and tilt a Bluetooth-connected sensor ball, and the app translates that motion into two things: therapy games (pressure and rotation control the gameplay) and grip-strength tests (recording peak pressure over time).
>
> The problem it solves: rehab exercises are typically repetitive and hard to stay motivated for, and clinicians need an objective, repeatable way to measure a patient's grip/squeeze strength over a course of treatment. Playwork turns the exercise into a game (for engagement) and the measurement into a structured, trackable test (for the clinician's records), all without needing any cloud infrastructure — the app is fully offline and all patient data stays on the device.
>
> Target audience: physical therapy clinics — the "trainer" role (physiotherapists configuring settings and reviewing results) and the "rehab client" role (patients using the ball to play/test). It is not intended for the general consumer App Store audience browsing for a fitness app; it's a clinical tool distributed to clinics that already own the hardware.

## 3 — Setup & access instructions

**Decide this before writing your final answer:** does the review build let a reviewer proceed without a real sensor? Playwork has a mock-sensor mode (`VITE_USE_MOCK_SENSOR=true`) built for exactly this kind of situation, but it needs to actually be enabled in whatever build gets submitted. Pick one:

- **Option A (recommended):** ship a review-only build with mock sensor mode on, so the reviewer can tap through the full flow with a simulated device — no hardware needed. State this explicitly in your Notes.
- **Option B:** if you can't enable that for this build, say clearly in your reply that the app requires a specific paired Bluetooth hardware accessory (not available to the reviewer) and lean entirely on the screen recording from item 1 to demonstrate functionality — some reviewers will accept this for accessory-gated apps, but it's a weaker position and more likely to bounce back.

> Playwork requires no account credentials — login is a numeric ID with no password, or a permanent "Continue as Guest" option requiring no entry at all. There is no sign-up flow and nothing to provision in advance.
>
> The one prerequisite is the initial sensor-connect screen, since the app is built around a Bluetooth-connected hardware sensor ball. [FILL IN based on which option above you chose — e.g.: "For this review build, sensor connectivity is simulated (mock mode) so the reviewer can proceed without physical hardware — simply tap the device shown in the scan list to connect." OR: "This app pairs with a proprietary Bluetooth hardware sensor (a squeeze-and-tilt ball) that is required to use the app's core features; the attached recording demonstrates the full flow with that hardware connected."]
>
> Once past the connect screen: tap "Continue as Guest" on the login screen (no ID needed), then use the Home screen's Games or Tests cards to reach any feature. No sample files or other setup are required.

**Fill in the bracketed part before sending.**

## 4 — External services & tools

> Playwork connects to the following external services to deliver core functionality:
>
> - **Apple CoreBluetooth** — connects to the app's companion hardware sensor (a Bluetooth-enabled therapy ball). This is a direct local device connection; no data passes through Apple or a third party via this framework.
> - **Firebase (Google) — Analytics & Crashlytics** — anonymous, aggregated usage analytics and crash/stability reporting. Both are optional and consent-gated: the user is shown a clear opt-in prompt on first launch and can enable or disable each independently at any time. The app is fully functional with both declined; no core feature depends on them.
> - **AWS Lambda / API Gateway** — validates and registers the hardware sensor's license when first paired. Only a device identifier and license key are exchanged; no patient health data is transmitted.
> - **Google Sign-In (Credential Manager)** — used only to resolve an account email for associating a sensor's license to an account. This is not the app's login mechanism (login is a local numeric ID, no password) and involves no general authentication.
>
> No payment processors are used (no in-app purchases). No AI/ML services are used. No third-party advertising or tracking SDKs are used.

## 5 — Regional differences

> Playwork functions consistently across all regions. There are no region-locked features, no region-specific content, and no feature that becomes unavailable based on the user's location. The app is fully offline — all clinical data stays on the device, with no server-side region logic involved.
>
> The only region-related variation is language: the app supports English, Hebrew, Simplified Chinese, Traditional Chinese, Japanese, Spanish, French, Polish, and Latvian, selectable independently of device locale from a picker on the login screen. This is a language/localization choice, not a functional difference — every feature is available in every language.

## 6 — Regulated industry / protected material

**Confirm before sending:** the answer below assumes Playwork is positioned as a general rehabilitation/exercise-tracking tool used under clinician supervision, not a regulated medical device (no diagnosis, no treatment claims, no FDA/CE medical clearance). If Playwork is marketed or cleared as an actual medical device in any territory, that changes this answer significantly — say so before using this draft.

> Playwork operates in the physical rehabilitation / physical therapy space, but it is a general exercise and measurement tool used under the supervision of a physiotherapist in a clinical setting — it does not diagnose, treat, or make any medical claims, and it is not registered or marketed as a regulated medical device. It records grip/squeeze pressure and movement data locally for the clinician's own reference; it does not replace clinical judgment or medical advice.
>
> The app contains no third-party protected material requiring authorization documentation (no licensed media, branded content, or regulated data feeds).

---

Drafted from Playwork's own CLAUDE.md spec (sensor architecture, auth model, Firebase/AWS/Google Sign-In integrations, localization, encryption-at-rest). Verify the bracketed items in sections 3 and 6 against your actual submitted build before sending — App Review checks these against the real binary.
