# KTP Committee Discord Bot

This service reflects **approved website committee membership** in Discord roles. It never decides who is approved: the KTP API remains the source of truth.

## What it does

1. Polls the API for pending role-sync jobs.
2. Adds or removes the job's mapped Discord role.
3. Reports success or failure to the API for retry and audit handling.
4. Reconciles every managed role against the API's desired state, in both directions.

The API must only create a `grant` job after it has committed an approved `committee_members` row. It should create a `revoke` job when a member leaves or is removed.

### Reconciliation is the self-healing part

Jobs are one-shot. A job that is never enqueued, or that is marked complete without the role surviving, is repaired by nothing. Reconciliation is what closes that gap: on every poll the bot reads the complete desired membership of each managed role and makes Discord match it, granting the role to approved members who lack it as well as removing it from holders who are not approved.

Until 2026-09-23 it only removed. Drift could therefore resolve in one direction only, and a member whose Discord account was linked could be left without their role permanently. That was a reported bug, not a design choice.

Two properties are deliberate and worth preserving. A role absent from the assignments response is never inspected or changed, so unrelated server roles cannot be touched. An empty member list is meaningful: it means nobody should hold that role, not that there is no data.

The desired state is read AFTER the pending jobs are applied, never alongside them. Reading both up front lets a membership committing between the two reads hand reconciliation a picture older than the grant it then undoes, with the job already marked complete and so never retried.

## Local setup

1. Copy `.env.example` to `.env` and fill in the Discord token, server ID, API URL, and shared bot API secret.
2. Run `npm install` in this repository.
3. Run `npm start` locally, or build and run the included Dockerfile. Deploy this repository as its own continuously running Dokploy service; use exactly one instance.

Create a Discord application in the Discord Developer Portal, add a bot, then invite it to the chapter server with the `bot` scope and `Manage Roles` permission. Enable the **Server Members Intent** for the bot. Its highest role must sit above every committee role it will manage.

## Required API contract

The bot expects these machine-to-machine endpoints, authenticated by `X-Bot-Secret`:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/discord/role-sync/jobs?status=pending` | Returns pending jobs. |
| `GET` | `/discord/role-sync/assignments` | Returns the complete desired membership of every managed role. |
| `POST` | `/discord/role-sync/jobs/:id/complete` | Marks a job complete. |
| `POST` | `/discord/role-sync/jobs/:id/fail` | Records a retryable failure. |

Each returned job must have this shape:

```json
{
  "id": "uuid",
  "action": "grant",
  "discord_user_id": "123456789012345678",
  "discord_role_id": "123456789012345678"
}
```

## Hosting

Yes. A Discord bot maintains a persistent connection to Discord, so it needs a continuously running host. This repository is deployed independently from ktp-api and communicates with it over the protected role-sync endpoints.

Use one bot instance only. Do not deploy it as a serverless function.

For Dokploy, deploy this repository using `docker-compose.yml` and set
`DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, and `BOT_API_SECRET` in the service's
environment. Set `API_BASE_URL` and `SYNC_INTERVAL_MS` if the defaults in
`.env.example` need to change. The bot does not need an exposed port.
For a local Compose deployment, copy `.env.example` to `.env`, fill in the
values, and run `docker compose up --build -d`.
