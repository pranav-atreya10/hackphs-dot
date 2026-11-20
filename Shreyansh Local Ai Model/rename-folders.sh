#!/usr/bin/env bash
# Rename the person-named folders to names that say what is inside, and fix every path that points at them.
#
#   cd hackphs-dot && git checkout -b rename-folders && bash rename-folders.sh && git diff --stat
#
#   PRANAV/                    -> server-and-website/        (Express server, website, sign-in, AI/voice pipeline)
#   VIVAN/                     -> detection-engine/          (motion tracking, flocks, drone sound, risk)
#   ATHARV/                    -> film-and-ios-app/          (3D film, landing page source, iPhone camera app)
#   SHREYANSH/                 -> ai-voice-solana-pipeline/  (original AI, voice and Solana pipeline)
#   Shreyansh Local Ai Model/  -> local-bird-drone-model/    (bird/drone/other classifier + flight forecaster)
#
# The people's notes files keep their names (server-and-website/PRANAV.md etc.), since AI.md asks for one
# notes file per person.
#
# AFTER MERGING, ONE MANUAL STEP: DigitalOcean deploys from the folder named in the app's settings.
# App Platform -> your app -> Settings -> the "web" component -> Source Directory: change PRANAV to
# server-and-website (this script already updates server-and-website/.do/app.yaml). Until then, deploys of
# main will fail, but the site that is already running stays up.
set -euo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

declare -a OLD=("PRANAV" "VIVAN" "ATHARV" "SHREYANSH" "Shreyansh Local Ai Model")
declare -a NEW=("server-and-website" "detection-engine" "film-and-ios-app" "ai-voice-solana-pipeline" "local-bird-drone-model")

mv_dir() {
  if [ -d "$1" ]; then
    if git rev-parse --is-inside-work-tree >/dev/null 2>&1 && [ -n "$(git ls-files -- "$1" | head -1)" ]; then git mv "$1" "$2"; else mv "$1" "$2"; fi
    echo "renamed: $1 -> $2"
  fi
}
for i in "${!OLD[@]}"; do mv_dir "${OLD[$i]}" "${NEW[$i]}"; done

# Text files to update (skip git internals, node_modules, data, binary files).
mapfile -d '' FILES < <(grep -rIlZ --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=data \
  -e 'PRANAV' -e 'VIVAN/' -e 'ATHARV/' -e 'SHREYANSH/' -e 'Shreyansh Local Ai Model' . || true)
for f in "${FILES[@]}"; do
  perl -0pi -e '
    s{Shreyansh Local Ai Model}{local-bird-drone-model}g;
    s{\bPRANAV/}{server-and-website/}g;  s{\bVIVAN/}{detection-engine/}g;
    s{\bATHARV/}{film-and-ios-app/}g;    s{\bSHREYANSH/}{ai-voice-solana-pipeline/}g;
    s{(source_dir:\s*)PRANAV\b}{$1server-and-website}g;
    s{(^|\n)(\s*cd\s+)PRANAV\b}{$1$2server-and-website}g;
    s{\.\./\.\./SHREYANSH\b}{../../ai-voice-solana-pipeline}g;
    # the per-person notes files keep their names
    s{server-and-website/server-and-website\.md}{server-and-website/PRANAV.md}g;
  ' "$f"
done

# sync-web.mjs builds paths with join(repo, 'PRANAV/public') etc.; the substitutions above cover them. Check:
LEFT=$(grep -rIn --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=data -E "\b(PRANAV|VIVAN|ATHARV|SHREYANSH)/" . || true)
if [ -n "$LEFT" ]; then echo "Still pointing at old folders (please check):"; echo "$LEFT"; exit 1; fi
echo "Done. Next: run 'cd server-and-website && npm ci && npm test', commit, open a PR, then change the"
echo "DigitalOcean Source Directory to server-and-website (see the top of this script)."
