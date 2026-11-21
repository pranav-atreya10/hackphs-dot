# SkySentry startup and deployment

## Start or update the Mac server

Keep the repository on this Mac. Install Node.js 20.12 or newer, then install the server dependencies once with `cd PRANAV && npm ci`.

Create `PRANAV/.env` with `PORT=8095`, `AIRPORT_CODES`, and a `CAMERA_API_AIRPORT` listed in `AIRPORT_CODES`. Enter that airport and the configured `CAMERA_API_KEY` on the iPhone. `.env` is ignored by Git; do not put secrets into scripts or commit them. Do not copy placeholder database and Clerk settings unless replacing them with working values.

Double-click **Restart SkySentry.command** in the repository root. It checks the port, stops only a Node server owned by your account whose working directory is this repository's `PRANAV` folder, starts the updated code, waits for `/health` (process liveness only), and opens the tower. It never forces another app to stop. The terminal must remain open while the local server is in use.

For a check that does not restart anything, run:

```sh
bash PRANAV/scripts/restart-local.sh --check
```

Use `http://localhost:8095/tower.html` on the Mac. In the native iPhone app, enter the Mac's current Wi-Fi address, for example `http://<Mac-Wi-Fi-IP>:8095`, and the same camera key. `localhost` on the iPhone refers to the iPhone. Allow Local Network access and keep both devices on the same network. Wi-Fi addresses can change; check the Mac's Wi-Fi settings if the phone becomes unable to reach it.

Locking the display does not deploy new code. The Mac must remain awake with the server running to relay a phone feed. Test against an isolated server only; do not use the public deployment for a smoke test.

## Deploy the GitHub code

The Node web service uses repository `pranav-atreya10/hackphs-dot`, branch `main`, source directory `PRANAV`, build command `npm ci`, run command `npm start`, port `8080`, and health path `/health`. These settings are recorded in `.do/app.yaml`. Keep the app at one instance unless adding a shared Socket.IO adapter and shared camera state.

Production startup requires a camera key and its `CAMERA_API_AIRPORT`, plus either a distinct tower key with `TOWER_API_AIRPORT`, or both Clerk keys and `MONGODB_URI`. Key bindings must name configured `AIRPORT_CODES` entries. Key-based cameras must submit the matching airport. `ALLOW_UNAUTHENTICATED_TOWER=true` opts into a loopback-only local tower without Clerk or a tower key; it does not pass readiness. Optional providers need their own encrypted runtime variables.

Before pushing or updating DigitalOcean App Platform settings, run the preflight tool from `PRANAV`:

```sh
# Verify .do/app.yaml declares all required keys, SECRET flags, instance_count: 1, and /health liveness
node scripts/do-deploy-preflight.mjs --app-yaml

# Validate an environment against PRANAV/access.js production boot gates
node scripts/do-deploy-preflight.mjs --check-env

# Generate in-memory 32-byte hex keys + join code for DigitalOcean paste (never writes secrets to disk)
node scripts/do-deploy-preflight.mjs --generate KPCT

# Probe live /health liveness and /ready readiness (flags HTTP 404 on /ready when stuck on a pre-PR-#56 build)
node scripts/do-deploy-preflight.mjs --probe https://lancerhacks-rvs8r.ondigitalocean.app
```

For operator visibility without exposing credentials, `deploy-diagnostics.js` (`buildDeployDiagnostics`) builds a redacted subsystem readiness checklist (`GET /api/deploy-diagnostics`) consumed by the Admin Deployment & Subsystem Readiness controller (`/js/admin-diagnostics.mjs` and `/css/admin-diagnostics.css`).

## Liveness and readiness

Keep the App Platform health check on `/health`; it verifies liveness and shows last-observed optional provider state without probing dependencies. Use `/ready` separately. It returns `503` until the synthetic JPEG detector self-check, airport registry and access configuration, Mongo majority receipt/report write and read, detection TTL index, and restart spool checks pass. If configured, Clerk must answer a service read and the role lookup must be readable. The Mongo check uses one fixed, unscoped synthetic record per collection, not an operator incident or alert. Checks are cached briefly and return sanitized states. `/health/db` shows storage and Clerk diagnostics but is not a readiness gate.

A `200` from `/ready` is not proof of an authorized device session, continuous camera coverage, acoustic detection, field accuracy or airport qualification. A camera with missing or stale results is degraded or unavailable. Even **No detections in monitored video** is not clearance. Gemini, OpenAI and Solana outages do not block detector warnings or software readiness.

Verify changes in isolation with `npm test`. Use only synthetic frames and fake providers for camera-to-tower checks. Recorded uploads, the synthetic sky preview and the film never test live ingress, voice delivery or field performance. Do not send demo clips through a live camera route or test against the public site.

## Airport scope and account rollout

Roll out the authorized server and matching dashboard/camera clients together. Do not keep old unscoped instances serving traffic during the cutover. Dashboard and camera requests use one registered airport per connection. Keep a single app instance for immediate in-process revocation; Clerk session status and membership are also rechecked periodically, with an expiring socket lease. Review all historically deleted/reused codes before registering them again. Newly removed database airports are reserved and cannot be re-created through the app.

MongoDB adds `(airport, time)` indexes and keeps the existing detection TTL policy. History and both chat providers omit missing, null, malformed, or nonmatching airport values. Do not infer ownership from a camera ID or assign the primary airport to an old row. Only backfill records for which trusted source metadata proves ownership, and verify in a staging environment before any rollout.

An approval in `applying` suspends app access. Use **Reconcile** to finalize once Clerk returns the exact transition ID, role, and airport recorded in MongoDB. Reconcile never blindly retries an uncertain Clerk write. If Clerk never applied it, an operator must establish that no writer/request remains in flight, confirm the prior role and airport against provider audit data, then resolve that exact generation before allowing another request. Likewise, an unconfirmed `account_joins` reservation must be reconciled against Clerk's `joinId` before restoring or clearing it. Preserve an audit record of any recovery and never loosen authorization to get past a provider failure.

Before publishing changes, run `npm test` in `PRANAV` and verify dependency installation with the builder's npm version where repository policy permits. Commit `package.json` and `package-lock.json` together whenever dependencies change.

From the repository root, rebuild the landing source with `python ATHARV/skysentry/tools/build_site.py`, then run `npm --prefix PRANAV run sync-web -- --film` to update only the deployed film and landing. Use `--detector` for intentional detector updates. Sync updates managed files without deleting unrelated files; unexpected deployed detector files must be reviewed explicitly. `python ATHARV/skysentry/tools/build_site.py --check` and `npm --prefix PRANAV run check:web` report drift without writing files and run in GitHub CI, where all three folders are available.

## Account security and authenticator apps

The camera and tower pages use the existing Clerk sign-in service when its keys are configured. Signed-in users can select **Account security** to open Clerk's profile and security settings. In Clerk Dashboard → User & authentication → Multi-factor, enable **Authenticator application**, then save. Users enroll their own authenticator and recovery codes through the profile; do not store those secrets in this repository. Do not turn on required MFA without testing the session task flow first. The native iPhone camera's API key is a separate device credential and is not protected by a user's authenticator enrollment.

Clerk UI loading follows the [official JavaScript quickstart](https://clerk.com/docs/js-frontend/getting-started/quickstart). Enrollment options are described in [Clerk authentication configuration](https://clerk.com/docs/guides/configure/auth-strategies/sign-up-sign-in-options).

**Clerk keys:** use the Clerk *Development* instance keys (`pk_test_…` / `sk_test_…`) on the `ondigitalocean.app` address. Production keys only work on a domain you own with Clerk's DNS records.

**Admins and airports:** set `ADMIN_EMAILS` (comma-separated) in DigitalOcean to the email addresses that should be admins. An admin signs in with one of those emails (it must be verified in Clerk) and opens `/admin.html` to create airports. Each airport gets a generated join code, and the admin can issue a new code or delete the airport. These airports are saved in MongoDB (`skysentry.airports`) and work alongside the fixed ones in `AIRPORT_CODES`. Admins also open the tower for every airport without a join code.

## Sponsor service readiness

Gemini may answer or write advisory reports, but it does not change operational risk. The browser only sounds fresh alerts after the operator selects **Turn on alert sound**; replay and storage confirmations are silent. No ElevenLabs credential is needed.

An optional confirmed Solana devnet memo can be compared with the hash of exact report text. This does not prevent edits, prove the report accurate, or establish a chain of custody. A mocked provider result does not verify a real devnet transaction.

## Surveyed corridor setup

By default no camera has a corridor. Enable it only for a fixed, surveyed
streaming webcam with site safety approval. Set `SURVEYED_CORRIDORS_JSON` in the
server environment to a JSON array of records with `airport`, `cameraId`,
`surveyId`, `camera` (`lat`, `lon`, `heading_deg`, `hfov_deg`, `pitch_deg`), and
`polygon` (three to 64 normalized `[x,y]` vertices measured on the surveyed view).
Use the registered camera ID shown by the tower, not its editable label. The ID
is derived from the airport, authenticated principal, transport, and persistent
device ID. The airport and all pose values must also match. A drawn draft or demo
can never activate a server mask. Disable or resurvey after changing the mount, lens,
zoom, cropping, or image orientation; matching form values cannot verify the
physical installation.

Contract: `eta_basis: "image_space_corridor"` identifies a projected image-mask
entry and `corridor_survey_id` references its survey; `eta_seconds` is not runway
arrival. `eta_range` is a heuristic velocity envelope, not a confidence interval.
The approximate `bearing_deg` carries no range, target point, or geographic
track. Do not treat archived guessed points as measured locations.

## Alert recovery and incident evidence

Live warnings appear before MongoDB confirms them. The tower distinguishes an
unconfirmed retry from a failed write; only confirmed alerts can be acknowledged.
Reconnect restores unconfirmed warnings separately from stored history. Neither
replay nor storage updates speak or set the current risk. An acknowledged alert
does not reappear in the unacknowledged list. A Mongo receipt persists the report
job; reports can still be delayed or incomplete. Ambiguous Solana submissions are
reconciled by signature rather than sent again.

For **self-managed, single-instance** use, `RECEIPT_SPOOL_FILE` must be the
absolute path to a pre-created empty or existing SkySentry spool file on a
persistent local volume that implements file sync. Give the app exclusive
ownership, restrict access to its service account (mode `0600` on POSIX, a private
ACL on Windows), and keep it outside the checkout, web root and temp folders. Do
not truncate or recreate the file on restart, move it between installations,
share it between processes, or use a network mount. Each synced checkpoint
holds up to 64 incident receipts, capped to eight days of recovery; an incident
whose receipt is already stored is retried by ID without duplicating alerts.
The spool never stores images. Only a completed spool checkpoint is eligible for
restart recovery; a warning can appear before that checkpoint completes.

Without a supported file, `/ready` fails even if MongoDB is healthy. This is
the expected result for the checked-in App Platform spec; its ephemeral disk
does not survive instance replacement. Best-effort live warnings and Mongo
writes continue, but unconfirmed memory-only retries can be lost. An exhausted
or full queue does not replace existing pending receipts. Alert receipts,
unacknowledged replay and unfinished Mongo report jobs share the eight-day
detection retention window; this change does not backfill historical reports.

`DURABLE_INCIDENT_EVIDENCE=1` opts in to retaining eligible server-cropped JPEGs
in MongoDB, visible only through the authenticated airport-scoped snapshot
route. It does not authorize sending images to Google. Only
`GEMINI_CLOUD_EVIDENCE_ENABLED=true` allows Gemini image processing. Neither
switch is enabled by default, and missing or invalid evidence never blocks a
warning. A restart before Mongo accepts an opted-in snapshot may recover the
receipt and report without that snapshot. Bird and unidentified-object reports use detector readings, with any
Gemini image verdict stored separately as advisory context. The same image is
not sent to a second report prompt. A confirmation of storage is not
confirmation of a completed report.

Tower `/api/verify-bird` requests contain only `cameraId`, `streamId`, `frameId`,
and `trackId` in the JSON body. They must send `X-Bird-Review-Provider: local`
or `X-Bird-Review-Provider: gemini` matching the currently enabled server judge.
A missing or mismatched provider is rejected before cropping. Gemini review in
the tower also requires operator opt-in per connection; reconnecting reloads
server policy without carrying over the checkbox. Towers leave both review
paths off if the policy response does not advertise `providerBinding: true`.
