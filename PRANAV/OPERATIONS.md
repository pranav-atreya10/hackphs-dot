# SkySentry startup and deployment

## Start or update the Mac server

Keep the repository on this Mac. Install Node.js 20.12 or newer, then install the server dependencies once with `cd PRANAV && npm ci`.

Create `PRANAV/.env` with `PORT=8095` and `CAMERA_API_KEY` set to the same key entered in the iPhone app. `.env` is ignored by Git. Add any optional provider keys there; do not put secrets into scripts or commit them. Do not copy the placeholder database and Clerk values from `.env.example` unless replacing them with working values.

Double-click **Restart SkySentry.command** in the repository root. It checks the port, stops only a Node server owned by your account whose working directory is this repository's `PRANAV` folder, starts the updated code, waits for `/health`, and opens the tower. It never forces another app to stop. The terminal must remain open while the local server is in use.

For a check that does not restart anything, run:

```sh
bash PRANAV/scripts/restart-local.sh --check
```

Use `http://localhost:8095/tower.html` on the Mac. In the native iPhone app, enter the Mac's current Wi-Fi address, for example `http://<Mac-Wi-Fi-IP>:8095`, and the same camera key. `localhost` on the iPhone refers to the iPhone. Allow Local Network access and keep both devices on the same network. Wi-Fi addresses can change; check the Mac's Wi-Fi settings if the phone becomes unable to reach it.

Locking the display does not deploy new code. The Mac must remain awake with the server running to relay a phone feed. For use without this Mac, point the phone at the deployed HTTPS server and use that server's camera key.

## Deploy the GitHub code

The Node web service uses repository `pranav-atreya10/hackphs-dot`, branch `main`, source directory `PRANAV`, build command `npm ci`, run command `npm start`, port `8080`, and health path `/health`. These settings are recorded in `.do/app.yaml`. Keep the app at one instance unless adding a shared Socket.IO adapter and shared camera state.

Set `CAMERA_API_KEY` in DigitalOcean as an encrypted runtime variable. Production intentionally refuses to start without it. Optional providers need their own encrypted runtime keys. Empty optional keys use clearly labeled fallback modes; a healthy server alone does not prove an external provider has been configured.

After a deploy, check `/health` for server and bot status, `/health/db` for configured database status, open `/tower.html`, and send a real camera or demo clip through `/camera.html`. Confirm frames and bot state arrive, then test an alert. A build success or green health check does not verify camera authentication, tracking, speech, or ledger publication by itself.

Before publishing changes, run `npm test` in `PRANAV` and ensure `npm ci` works with the builder's npm version. Commit `package.json` and `package-lock.json` together whenever dependencies change.

`npm run sync-web` copies the upstream film and detector sources into the deployed public folder. It replaces `public/detection` and the landing page. If modifying the deployed detector directly, apply the corresponding change to `VIVAN/detection` before using that copy command.
