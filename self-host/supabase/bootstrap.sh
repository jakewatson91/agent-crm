#!/usr/bin/env bash
# Bootstrap a local Supabase stack for full agent-crm self-host.
#
# Pulls the official self-host bundle from supabase/supabase at a pinned
# commit, drops it into ./local (gitignored), runs their key generator, and
# prints the env vars the agent-crm web app needs to point at the local
# instance.
#
# Idempotent. Re-runs do not regenerate keys (they live in ./local/.env)
# unless --reset is passed.
set -euo pipefail

# Pinned commit. Bump intentionally; do not auto-track master.
SUPABASE_REF="2c651ddabc306dd0785118126d57dd3176864fe9"

HERE="$(cd "$(dirname "$0")" && pwd)"
LOCAL_DIR="$HERE/local"

if [[ "${1:-}" == "--reset" ]]; then
  echo "[bootstrap] --reset: removing $LOCAL_DIR"
  rm -rf "$LOCAL_DIR"
fi

if [[ -d "$LOCAL_DIR/.git" || -f "$LOCAL_DIR/docker-compose.yml" ]]; then
  echo "[bootstrap] $LOCAL_DIR already populated; skipping clone. Use --reset to re-pull."
else
  echo "[bootstrap] cloning supabase/supabase @ ${SUPABASE_REF:0:7} into $LOCAL_DIR …"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  git -C "$TMP" init -q
  git -C "$TMP" remote add origin https://github.com/supabase/supabase.git
  git -C "$TMP" fetch -q --depth 1 origin "$SUPABASE_REF"
  git -C "$TMP" checkout -q FETCH_HEAD
  mkdir -p "$LOCAL_DIR"
  cp -R "$TMP/docker/." "$LOCAL_DIR/"
  trap - EXIT
  rm -rf "$TMP"
  echo "[bootstrap] cloned."
fi

cd "$LOCAL_DIR"

if [[ ! -f .env ]]; then
  echo "[bootstrap] no .env yet; copying .env.example and generating keys…"
  cp .env.example .env
  # generate-keys.sh rewrites JWT_SECRET / ANON_KEY / SERVICE_ROLE_KEY in
  # place. Not all clone targets carry the exec bit, so invoke via `bash`.
  if [[ -f utils/generate-keys.sh ]]; then
    bash utils/generate-keys.sh --update-env
  else
    echo "[bootstrap] WARN: utils/generate-keys.sh not found; .env will keep its DEMO keys (insecure)."
    echo "[bootstrap]       Regenerate manually before exposing this stack to anything outside localhost."
  fi
else
  echo "[bootstrap] .env already exists; leaving it alone."
fi

ANON_KEY="$(grep -E '^ANON_KEY=' .env | head -1 | cut -d= -f2-)"
SERVICE_KEY="$(grep -E '^SERVICE_ROLE_KEY=' .env | head -1 | cut -d= -f2-)"
DB_PASSWORD="$(grep -E '^POSTGRES_PASSWORD=' .env | head -1 | cut -d= -f2-)"

cat <<EOF

[bootstrap] DONE. Next steps:

1. Start the Supabase stack (12 containers, ~1–2 GB RAM):
     cd self-host/supabase/local && docker compose up -d

2. Wait for the DB to come up (≈30 s), then apply agent-crm migrations:
     pnpm self-host:migrate

3. Point apps/web at the local stack. Add these to apps/web/.env.local
   (or wherever you load env from):

     NEXT_PUBLIC_SUPABASE_URL=http://localhost:8000
     NEXT_PUBLIC_SUPABASE_ANON_KEY=${ANON_KEY:-<see self-host/supabase/local/.env>}
     SUPABASE_SERVICE_ROLE_KEY=${SERVICE_KEY:-<see self-host/supabase/local/.env>}
     SUPABASE_DB_URL=postgresql://postgres:${DB_PASSWORD:-<see .env>}@localhost:5432/postgres

4. Start agent-crm:
     pnpm --filter web dev

5. Visit http://localhost:3000, sign in via magic link. Inbucket (Supabase's
   built-in mail catcher) is at http://localhost:54324 — open it to grab the
   sign-in link without configuring real SMTP.

EOF
