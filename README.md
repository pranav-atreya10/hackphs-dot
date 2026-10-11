# SkySentry

SkySentry connects an iPhone camera to a live tower dashboard, detects moving birds and drones near a runway corridor, double-checks birds with a strict Gemini bird judge, and turns alerts into incident reports stored in MongoDB and Tiger Data. It is software only: the tower beacon is on screen, no Arduino needed. The Node server and deployed website are in `PRANAV`; the native iPhone app is in `ATHARV/ios`.

For the Mac server, double-click **Restart SkySentry.command** after configuring `PRANAV/.env` and installing dependencies. Keep its terminal open while streaming. Open `/tower.html` to see the phone feed; `/camera.html` publishes a separate browser camera or demo.

See [startup and deployment instructions](PRANAV/OPERATIONS.md) and the [iPhone app instructions](ATHARV/ios/README.md).
