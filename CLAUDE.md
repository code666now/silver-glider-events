# Silver Glider Events — Claude Code

This repo is shared with Codex. Codex edits the main working tree at
`~/Documents/New project/silver-glider-events-app`; Claude Code works in its own
clone at `~/sge-claude` on `claude/*` branches and lands changes through GitHub
pull requests. The rules below keep either agent from overwriting the other.

## Read first

1. `CODEX.md` — short operational guide (local setup, architecture, invariants).
2. `HANDOFF.md` — master reference. Read "Two agents share this repository" and
   "Sign-in, sessions, and returning guests — rules to keep" before touching auth.
3. `CHANGELOG.md` — what each release changed.

Where `CODEX.md` and `HANDOFF.md` disagree, trust `HANDOFF.md` and the code.

## Working alongside Codex

- Start every task with `git fetch` and `git status --short`, and branch from
  the latest `origin/main`.
- Never edit files in Codex's working tree while it has uncommitted changes
  there (check `git status` and recent mtimes).
- Open a PR per task; say in the description which files it touches. Ask for
  **Create a merge commit** so Codex's local `main` fast-forwards on `git pull`.
- One deployer at a time. Releases bump `package.json`, `package-lock.json`,
  `CHANGELOG.md` and a matching tag — two agents releasing at once will claim
  the same version.
- Don't commit to `main` while a deploy is in flight (`.git-sha` ahead of
  production `/health`). The deployer verifies production against `HEAD`.
- Put anything the other agent needs to know in `HANDOFF.md`, not here.

## Running locally

Preview configs live in `~/uht-app/.claude/launch.json`:

- `sge-claude` runs this clone on port 3101 against its own database
  `sge_claude_dev`, so branch migrations never touch Codex's `sge_dev`.
- `sg-events` runs Codex's working tree on port 3100 against `sge_dev`.

Both use the local-only env file at `~/silver-glider-events/.env`
(`NODE_ENV=development`, `REMINDERS_ENABLED=false`, no Resend key). Emails are
printed to the console and kept in `mailer.devOutbox`; sign-in codes appear in
the server log. Startup runs migrations before listening, so the first
`/health` can take a few seconds. Cookies are shared across localhost ports.

`~/silver-glider-events` is an older mirror clone — do not edit code there.

## Non-negotiables (details in CODEX.md)

- Never point dev, tests or scripts at Railway Postgres.
- `npm run check` and `git diff --check` before any release.
- Deploy exactly: `git rev-parse --short HEAD > .git-sha && railway up . --path-as-root --service silver-glider-events`
- Tell the user what a release touches on live events, RSVPs and emails before deploying.
