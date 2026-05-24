# Full local self-host (no Supabase Cloud)

This path stands up the entire Supabase stack — Postgres, GoTrue (auth), PostgREST, Kong, Studio, Realtime, Storage — on your machine. The agent-crm web app then talks to `http://localhost:8000` instead of Supabase Cloud.

If you don't need this — most users won't — keep using the `docker-compose.yml` at the repo root, which expects you to point at a Supabase Cloud project. That's two env vars and a free-tier signup vs. ~1–2 GB of containers.

## Prereqs

- Docker Desktop (or Podman) running
- `git`
- Node 22 + pnpm 11 (same as the rest of the repo)
- 2 GB free RAM for the Supabase stack

## One-time bootstrap

```sh
pnpm self-host:bootstrap
```

This:

1. Clones `supabase/supabase` at a pinned commit into `self-host/supabase/local/` (gitignored).
2. Copies `.env.example` → `.env` and runs Supabase's `utils/generate-keys.sh` to mint a `JWT_SECRET`, `ANON_KEY`, and `SERVICE_ROLE_KEY`.
3. Prints the env block to drop into `.env.local at the repo root (apps/web/.env.local is a symlink to it)`.

To re-pull the upstream stack later, run `pnpm self-host:bootstrap -- --reset`. The pinned commit is set inside `bootstrap.sh` — bump it intentionally, don't auto-track master.

## Bring it up

```sh
pnpm self-host:supabase:up
```

Waits for Docker to bring up all 12 containers. First start takes a few minutes to pull images.

Verify it's healthy:

- Studio (Supabase's admin UI): http://localhost:8000 — log in with `DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD` from `self-host/supabase/local/.env` (default `supabase` / `this_password_is_insecure_and_should_be_updated` — change it).
- Auth (GoTrue): `curl http://localhost:8000/auth/v1/health` → `{"version":"…"}`
- Postgres: `psql postgresql://postgres:<POSTGRES_PASSWORD>@localhost:5432/postgres -c '\dn'`

## Apply agent-crm migrations

```sh
pnpm self-host:migrate
```

Runs every `supabase/migrations/*.sql` in order against `SUPABASE_DB_URL`. Skips files already recorded in `meta._migrations` — safe to re-run.

The script refuses to run against any non-localhost URL unless you set `ALLOW_REMOTE_MIGRATE=1` — keeps you from clobbering a hosted project by accident.

`.env.local` (repo root — `apps/web/.env.local` is a symlink to it) must have `SUPABASE_DB_URL` pointing at the local stack. Use the env block from the next step.

## Point the web app at the local stack

Add to `.env.local` (repo root):

```
NEXT_PUBLIC_SUPABASE_URL=http://localhost:8000
NEXT_PUBLIC_SUPABASE_ANON_KEY=<ANON_KEY from self-host/supabase/local/.env>
SUPABASE_SERVICE_ROLE_KEY=<SERVICE_ROLE_KEY from self-host/supabase/local/.env>
SUPABASE_DB_URL=postgresql://postgres:<POSTGRES_PASSWORD>@localhost:5432/postgres
```

Then run the app as usual:

```sh
pnpm --filter web dev
```

Visit http://localhost:3000 → magic-link login. Since SMTP isn't wired by default, grab the sign-in link from Inbucket at http://localhost:54324.

## Tear it down

```sh
pnpm self-host:supabase:down
```

Stops the stack. Data persists in Docker volumes. To wipe everything:

```sh
cd self-host/supabase/local && docker compose down -v
```

## Caveats

- **No OAuth out of the box.** Magic links work without setup; Google/GitHub require OAuth client setup per provider — see `self-host/supabase/local/.env` for the variables, and Supabase's [self-host OAuth docs](https://supabase.com/docs/guides/self-hosting/self-hosted-oauth).
- **Email send.** Approval emails / outreach send via Resend (per workspace policy) work the same as in cloud mode. Only the sign-in magic link uses the local Inbucket catcher.
- **No Inngest cloud.** Background functions still need an Inngest dev server — the root `docker-compose.yml` runs one. You can bring both stacks up in parallel; they don't share networks but the web app reaches Inngest at `http://localhost:8288`.
- **RAM.** ~1.5–2 GB once Studio + Realtime + Storage + Analytics warm up. Drop the Edge Functions / Storage / Studio containers if you don't need them — edit `self-host/supabase/local/docker-compose.yml` and comment out the services. The agent-crm app only needs `db`, `auth`, `rest`, and `kong`.
