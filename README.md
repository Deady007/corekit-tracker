# CoreKit Tracker

Lightweight project management for Trivyah Tech — projects, stories/issues/bugs, kanban board, role-aware dashboards, file attachments, and notifications, in a brutalist UI. **Zero npm dependencies**: one Node process, one SQLite file (built-in `node:sqlite`), no build step.

## Roles & visibility

- **ADMIN / DEVLEAD** — see all projects; dashboard shows team load + project health + personal queue.
- **DEV / USER** — see only projects they belong to (project assignee list, project owner, or having stories there); dashboard shows their own work.

## Attachments

Upload documents on any story (drawer → Attachments, max 25 MB). Files live in `data/files/`.

## Import from Sprint0

`node import-sprint0.js` pulls all users, projects, and stories your Sprint0 session can see (cookie resolved the same way as sprint0-mcp). Idempotent — story numbers are preserved and existing records are skipped. Imported users need a password reset by an admin before they can log in.

## Run

```bash
node server.js
# → http://localhost:4580
```

First run seeds an `admin` user; its generated password is saved to `data/admin-password.txt` (or set `COREKIT_ADMIN_PASSWORD` before first run). Log in as admin → **Team** → add your users. Delete the password file after noting it.

Data lives in `data/corekit.db`. Back it up by copying the file.

To share with the team on your LAN, run it on any machine and open `http://<that-machine-ip>:4580`. Change the port with `COREKIT_PORT`.

## Sprint0-compatible API

The REST API intentionally mirrors app.sprint0.dev, so existing tooling works by pointing `SPRINT0_BASE_URL` at this server:

- **sprint0-mcp** (Claude integration): set `SPRINT0_BASE_URL=http://localhost:4580` and either a cookie or `sprint0.credentials.json` — auto-relogin works here since accounts have real passwords.
- **Capacity Control dashboard**: same `SPRINT0_BASE_URL` override.

Endpoints: `POST /api/auth/login` `{username,password}` (sets `JSESSIONID` cookie), `GET /api/auth/status`, `POST /api/auth/logout`, `GET/POST/PUT /api/users`, `GET/POST/PUT/DELETE /api/pm-projects`, `GET/POST/PUT/DELETE /api/pm-stories` (`?projectId=&type=`), `GET/POST /api/pm-comments` (`?storyId=`), `GET /api/notifications/user/{id}`.

Improvements over Sprint0: `PUT` accepts partial objects, `type` may be omitted to get all types, sessions last 30 days of inactivity, and passwords mean no cookie expiry dance.

## Structure

- `server.js` — HTTP + API + static, ~350 lines
- `db.js` — schema (users, sessions, projects, stories, comments, notifications)
- `public/index.html` — the whole UI (login, projects, kanban with drag & drop, story drawer with comments, team admin, notification inbox)
