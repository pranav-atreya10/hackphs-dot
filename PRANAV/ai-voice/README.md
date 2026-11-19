These production adapters integrate [Shreyansh's pipeline (PR #12)](https://github.com/pranav-atreya10/hackphs-dot/pull/12).
The original package remains under `SHREYANSH/`. `describe.js` and Gemini prompts come from that package;
native Node fetch replaces SDK transports so DigitalOcean deploys `source_dir: PRANAV` with one clean install.

Red warnings can appear before storage confirms them. With sound enabled, the browser can read a fresh warning aloud. Replay, acknowledgment and report updates are silent. No provider audio is sent to the tower.
Reports and optional devnet hashes update the same incident separately. Delivery and reports can be delayed or incomplete. Cooldowns are scoped by airport, camera and type;
escalation always passes. Unknown objects remain visible without being relabeled as birds.

Variables: `GEMINI_API_KEY`, `GEMINI_MODEL` (default `gemini-3.5-flash`), `GEMINI_BACKUP_MODEL`
(`gemini-3.5-flash-lite`), `SOLANA_SECRET_KEY` (64 byte JSON array), `SOLANA_RPC_URL` (devnet).
Local keys can be in `PRANAV/.env` or `SHREYANSH/.env`; existing environment variables take priority.
Production uses injected environment variables only. Never put secrets in browser code or GitHub.

Solana checks devnet before signing. The memo is SHA-256 of the exact report text, matching
Shreyansh's `verifyReport`; it does not prevent edits or establish accuracy. Wallet validation, request timeouts, insufficient funds and failed or pending
confirmation are reported explicitly. No wallet is generated or automatic airdrop requested.
The wallet must hold devnet SOL for fees. Setup and last errors are available from `ai.health()`;
configured providers are not labeled live until a successful call has completed.

`npm test` runs offline provider tests, which do not prove a live Gemini call or devnet stamp succeeded.

## Gemini image privacy and operator runbook

The backend sends no camera crops or incident snapshots to Google Gemini by
default. Set `GEMINI_CLOUD_EVIDENCE_ENABLED=true` only after the deployment
operator approves the airport's evidence-sharing policy and discloses the image
processing to users. Remove the setting to disable it again. The policy does
not disable detector alerts, text-based summaries, or separately configured
SkySentry incident storage in MongoDB Atlas.

`GET /health` reports the last Gemini outcome observed by the running app.
It does not call Gemini, and a healthy web process does not prove that the
Gemini credential works.

| Gemini diagnostic | Authorized operator action |
| --- | --- |
| `not_configured` | Confirm the active backend component has a runtime secret named `GEMINI_API_KEY`, not just a build-time variable. |
| `auth` (401/403 or rejected key) | Check the key status and Gemini API restrictions in the owning Google project. If needed, replace the runtime secret using the approved secret store and check that the updated release is serving. A model change does not repair authentication. |
| `quota` (429) | Check the project's quota, billing and rate-limit windows. Reduce load or wait for the applicable quota to reset rather than resubmitting evidence. |
| `timeout`, `network`, `service` | Check provider status and deployment connectivity. The app attempts at most one backup model within the same request budget. |
| `model` (404) | Check that `GEMINI_MODEL` and `GEMINI_BACKUP_MODEL` are available to the Google project and supported by the endpoint. |

Verify credential recovery with a text-only Gemini check through approved
secret-injected tooling. That confirms the credential used for the probe, not
that the app loaded it. To verify the running app in staging, exercise the
Gemini text fallback for Ask SkySentry with synthetic detection statistics and
confirm a fresh `gemini.lastSuccess` and `"available"` state in `/health`.
An OpenAI, template, or no-data reply alone does not establish Gemini recovery.
Never paste credentials into chat, tickets, browser requests, or logs. Do not
send real footage to diagnose credential failures.
