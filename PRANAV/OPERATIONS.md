# SkySentry startup and deployment

## Start or update the Mac server

Keep the repository on this Mac. Install Node.js 20.12 or newer, then install the server dependencies once with `cd PRANAV && npm ci`.

Create `PRANAV/.env` with `PORT=8095`, `AIRPORT_CODES`, and a `CAMERA_API_AIRPORT` listed in `AIRPORT_CODES`. Enter that airport and the configured `CAMERA_API_KEY` on the iPhone. `.env` is ignored by Git; do not put secrets into scripts or commit them. Do not copy placeholder database and Clerk settings unless replacing them with working values.

Double-click **Restart SkySentry.command** in the repository root. It checks the port, stops only a Node server owned by your account whose working directory is this repository's `PRANAV` folder, starts the updated code, waits for `/health`, and opens the tower. It never forces another app to stop. The terminal must remain open while the local server is in use.

For a check that does not restart anything, run:

```sh
bash PRANAV/scripts/restart-local.sh --check
```

Use `http://localhost:8095/tower.html` on the Mac. In the native iPhone app, enter the Mac's current Wi-Fi address, for example `http://<Mac-Wi-Fi-IP>:8095`, and the same camera key. `localhost` on the iPhone refers to the iPhone. Allow Local Network access and keep both devices on the same network. Wi-Fi addresses can change; check the Mac's Wi-Fi settings if the phone becomes unable to reach it.

Locking the display does not deploy new code. The Mac must remain awake with the server running to relay a phone feed. For use without this Mac, point the phone at the deployed HTTPS server and use that server's camera key.

## Deploy the GitHub code

The Node web service uses repository `pranav-atreya10/hackphs-dot`, branch `main`, source directory `PRANAV`, build command `npm ci`, run command `npm start`, port `8080`, and health path `/health`. These settings are recorded in `.do/app.yaml`. Keep the app at one instance unless adding a shared Socket.IO adapter and shared camera state.

Production requires a camera key and its `CAMERA_API_AIRPORT`, plus either a distinct tower key with `TOWER_API_AIRPORT`, or both Clerk keys and `MONGODB_URI`. Key bindings must name configured `AIRPORT_CODES` entries. Key-based cameras must submit the matching airport. `ALLOW_UNAUTHENTICATED_TOWER=true` opts into a loopback-only local tower without Clerk or a tower key; never enable it in production. Optional providers need their own encrypted runtime variables.

## Airport scope and account rollout

Roll out the authorized server and matching dashboard/camera clients together. Do not keep old unscoped instances serving traffic during the cutover. Dashboard and camera requests use one registered airport per connection. Keep a single app instance for immediate in-process revocation; Clerk session status and membership are also rechecked periodically, with an expiring socket lease. Review all historically deleted/reused codes before registering them again. Newly removed database airports are reserved and cannot be re-created through the app.

MongoDB adds `(airport, time)` indexes and keeps the existing detection TTL policy. History and both chat providers omit missing, null, malformed, or nonmatching airport values. Do not infer ownership from a camera ID or assign the primary airport to an old row. Only backfill records for which trusted source metadata proves ownership, and verify in a staging environment before any rollout.

An approval in `applying` suspends app access. Use **Reconcile** to finalize once Clerk returns the exact transition ID, role, and airport recorded in MongoDB. Reconcile never blindly retries an uncertain Clerk write. If Clerk never applied it, an operator must establish that no writer/request remains in flight, confirm the prior role and airport against provider audit data, then resolve that exact generation before allowing another request. Likewise, an unconfirmed `account_joins` reservation must be reconciled against Clerk's `joinId` before restoring or clearing it. Preserve an audit record of any recovery and never loosen authorization to get past a provider failure.

After a deploy, check `/health` for server and bot status, `/health/db` for configured database status, open `/tower.html`, and send a real camera or demo clip through `/camera.html`. Confirm frames and bot state arrive, then test an alert. A build success or green health check does not verify camera authentication, tracking, speech, or ledger publication by itself.

Before publishing changes, run `npm test` in `PRANAV` and ensure `npm ci` works with the builder's npm version. Commit `package.json` and `package-lock.json` together whenever dependencies change.

From the repository root, rebuild the landing source with `python ATHARV/skysentry/tools/build_site.py`, then run `npm --prefix PRANAV run sync-web -- --film` to update only the deployed film and landing. Use `--detector` for intentional detector updates. Sync updates managed files without deleting unrelated files; unexpected deployed detector files must be reviewed explicitly. `python ATHARV/skysentry/tools/build_site.py --check` and `npm --prefix PRANAV run check:web` report drift without writing files and run in GitHub CI, where all three folders are available.

## Account security and authenticator apps

The camera and tower pages use the existing Clerk sign-in service when its keys are configured. Signed-in users can select **Account security** to open Clerk's profile and security settings. In Clerk Dashboard → User & authentication → Multi-factor, enable **Authenticator application**, then save. Users enroll their own authenticator and recovery codes through the profile; do not store those secrets in this repository. Do not turn on required MFA without testing the session task flow first. The native iPhone camera's API key is a separate device credential and is not protected by a user's authenticator enrollment.

Clerk UI loading follows the [official JavaScript quickstart](https://clerk.com/docs/js-frontend/getting-started/quickstart). Enrollment options are described in [Clerk authentication configuration](https://clerk.com/docs/guides/configure/auth-strategies/sign-up-sign-in-options).

**Clerk keys:** use the Clerk *Development* instance keys (`pk_test_…` / `sk_test_…`) on the `ondigitalocean.app` address. Production keys only work on a domain you own with Clerk's DNS records.

**Admins and airports:** set `ADMIN_EMAILS` (comma-separated) in DigitalOcean to the email addresses that should be admins. An admin signs in with one of those emails (it must be verified in Clerk) and opens `/admin.html` to create airports. Each airport gets a generated join code, and the admin can issue a new code or delete the airport. These airports are saved in MongoDB (`skysentry.airports`) and work alongside the fixed ones in `AIRPORT_CODES`. Admins also open the tower for every airport without a join code.

## Sponsor service readiness

In DigitalOcean App Platform → Settings → web → Environment Variables, add an encrypted `GEMINI_API_KEY` value. Save and wait for redeployment. Never commit keys. `/health` reports template mode until it is present. Spoken alerts use the tower browser's own voice (no key needed): in Tower, select **Turn on alert sound** and send a demo threat to hear it. ElevenLabs was removed; any `ELEVENLABS_*` variables left in DigitalOcean are ignored and can be deleted.

For Solana, confirm one devnet memo transaction and compare its report hash before claiming an on-chain stamp works. Database health checks confirm connectivity; show a stored camera event, hourly chart and retrieved incident to demonstrate the complete MongoDB workflows. The DEV writing challenge requires a separately published project story.

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

Live warnings appear before MongoDB confirms them. Acknowledgment and replay use
the selected airport's stored alerts; replay is silent. If storage is unavailable,
the tower marks the alert unconfirmed. Retries before the first receipt are
bounded and held in memory; they cannot survive a server restart. A receipt
confirmed by MongoDB persists the report job for recovery. Ambiguous Solana
submissions are reconciled by signature, not submitted a second time.
Only stored incident updates carry a committed revision; a memory-only alert
does not.
Detection receipts, unacknowledged alert replay, and unfinished jobs share the
eight-day detection retention window. This does not backfill historical reports.

`DURABLE_INCIDENT_EVIDENCE=1` opts in to retaining eligible server-cropped JPEGs
in MongoDB, visible only through the authenticated airport-scoped snapshot
route. It does not authorize sending images to Google. Only
`GEMINI_CLOUD_EVIDENCE_ENABLED=true` allows Gemini image processing. Neither
switch is enabled by default, and missing or invalid evidence never blocks a
warning. A confirmation of storage is not confirmation of a completed report.
