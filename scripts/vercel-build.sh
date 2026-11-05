#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
export PATH="$PWD/node_modules/.bin:$PATH"

export DOMAIN="${DOMAIN:-${VERCEL_PROJECT_PRODUCTION_URL:-localhost}}"
export GAME_ENV="${GAME_ENV:-prod}"
export TURNSTILE_SITE_KEY="${TURNSTILE_SITE_KEY:-1x00000000000000000000AA}"
export GIT_COMMIT="${GIT_COMMIT:-${VERCEL_GIT_COMMIT_SHA:-dev}}"

npm run build-vercel
tsx src/server/RenderStaticIndex.ts --environment-only > static/index.render.html
mv static/index.render.html static/index.html
