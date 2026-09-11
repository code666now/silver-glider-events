# Silver Glider Events — Claude Code

This repo is shared with Codex. Both agents edit the same working tree, so the
rules below exist to keep either one from overwriting the other.

## Read first

1. `CODEX.md` — short operational guide (local setup, architecture, invariants).
2. `HANDOFF.md` — master reference, including the "New Session Handoff" section.
3. `CHANGELOG.md` — what each release changed.

Where `CODEX.md` and `HANDOFF.md` disagree, trust `HANDOFF.md` and the code.
Known stale lines in `CODEX.md` as of v1.0.84: it says GitHub auth is broken
(it works), that there is no native checkout (the feature-gated Silver Glider
Commerce handoff exists), and quotes an older test count.

## Taking turns with Codex

- Start every task with `git status --short`. Anything modified besides
  `.git-sha` means the other agent may be mid-change — stop and ask.
- Check recent mtimes too; uncommitted edits from a few minutes ago mean
  someone is actively working.
- Commit before handing back. A commit is the handoff.
- One deployer at a time. Releases bump `package.json`, `package-lock.json`,
  `CHANGELOG.md` and a matching tag — two agents releasing at once will claim
  the same version.
- Don't commit while a deploy is in flight (`.git-sha` ahead of production
  `/health`). The deployer verifies production against `HEAD`.
- Put anything the other agent needs to know in `HANDOFF.md`, not here.

## Running locally

The Claude preview config `sg-events` (in `~/uht-app/.claude/launch.json`)
runs this repo with the local-only env file at `~/silver-glider-events/.env`
(`sge_dev`, `NODE_ENV=development`, `REMINDERS_ENABLED=false`, no Resend key,
so magic links print to the console). This repo has no `.env` of its own.
Startup runs migrations before listening, so the first `/health` can take a
few seconds.

`~/silver-glider-events` is an older mirror clone — do not edit code there.

## Non-negotiables (details in CODEX.md)

- Never point dev, tests or scripts at Railway Postgres.
- `npm run check` and `git diff --check` before any release.
- Deploy exactly: `git rev-parse --short HEAD > .git-sha && railway up . --path-as-root --service silver-glider-events`
- Tell the user what a release touches on live events, RSVPs and emails before deploying.
