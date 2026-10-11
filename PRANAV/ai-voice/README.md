These production adapters integrate [Shreyansh's pipeline (PR #12)](https://github.com/pranav-atreya10/hackphs-dot/pull/12).
The original package remains under `SHREYANSH/`. `describe.js` and Gemini prompts come from that package;
native Node fetch replaces SDK transports so DigitalOcean deploys `source_dir: PRANAV` with one clean install.

Red alerts reach the tower immediately. Gemini reports and cached ElevenLabs audio run in parallel.
The tower waits up to five seconds for audio, then speaks locally, and never plays a late duplicate.
Reports and Solana stamps update the same incident. Cooldowns are scoped by airport, camera and type;
escalation always passes. Unknown objects remain visible without being relabeled as birds.

Variables: `GEMINI_API_KEY`, `GEMINI_MODEL` (default `gemini-3.5-flash`), `GEMINI_BACKUP_MODEL`
(`gemini-3.5-flash-lite`), `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL`
(`eleven_flash_v2_5`), `SOLANA_SECRET_KEY` (64 byte JSON array), `SOLANA_RPC_URL` (devnet).
Local keys can be in `PRANAV/.env` or `SHREYANSH/.env`; existing environment variables take priority.
Production uses injected environment variables only. Never put secrets in browser code or GitHub.

Solana checks devnet before signing. The memo is SHA-256 of the exact report text, matching
Shreyansh's `verifyReport`. Wallet validation, request timeouts, insufficient funds and failed or pending
confirmation are reported explicitly. No wallet is generated or automatic airdrop requested.
The wallet must hold devnet SOL for fees. Setup and last errors are available from `ai.health()`;
configured providers are not labeled live until a successful call has completed.

`npm test` runs offline provider tests, which do not prove a live ElevenLabs call or devnet stamp succeeded.
