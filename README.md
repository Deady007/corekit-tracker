# Trivyah Task Manager

Lightweight task tracking for any kind of work — projects, tasks, a board, role-aware dashboards, a file manager, and notifications, in a clean Notion-style UI. **Zero npm dependencies**: one Node process, one SQLite file (built-in `node:sqlite`), no build step.

## Roles & visibility

A four-rung ladder, each rung inheriting everything below it:

- **TEAMMATE** — works the board: view, update and comment on tasks in projects they belong to.
- **LEAD** — also creates tasks, assigns them, and creates projects and customers.
- **ADMIN** — also manages users, sees every project, and deletes work items.
- **SUPERADMIN** — also sets/resets passwords and deletes users.

TEAMMATE and LEAD see only projects they belong to (project owner, listed member, or having a task there). ADMIN and above see everything.

## Roles

Four built-in rungs — TEAMMATE, LEAD, ADMIN, SUPERADMIN — each inheriting everything below it. Admins can also define **custom roles** on the Roles page: a custom role picks one of the four rungs and inherits its permissions exactly, so it needs no new permission checks. You can only create, edit or delete a role you outrank, which means an admin can never mint a superadmin-equivalent, and an admin editing Page Permission cannot add or remove access for superadmin-rank roles — their existing access is preserved untouched.

Role names are immutable once created (the name is what is stored on the account); the display label can be changed. A role cannot be deleted while anyone still holds it.

## Projects, customers & files

Projects are either **client** (must be attached to a customer record) or **internal**. Every project and every customer gets a file area — nested folders, upload/rename/move/copy, 25 MB per file. Files live in `data/files/`; tasks also take direct attachments and pasted screenshots on comments.

## Run

```bash
node server.js
# → http://localhost:4580
```

First run seeds an `admin` user; its generated password is saved to `data/admin-password.txt` (or set `COREKIT_ADMIN_PASSWORD` before first run). Log in as admin → **Team** → add your users. Delete the password file after noting it.

Data lives in `data/corekit.db`. Back it up by copying the file.

To share with the team on your LAN, run it on any machine and open `http://<that-machine-ip>:4580`. Change the port with `COREKIT_PORT`.

## API

`POST /api/auth/login` `{username,password}` (sets `JSESSIONID` cookie), `GET /api/auth/status`, `POST /api/auth/logout`, `POST /api/auth/forgot`, `POST /api/auth/reset`, `GET/POST/PUT/DELETE /api/users`, `GET/POST/PUT/DELETE /api/customers`, `GET/POST/PUT/DELETE /api/projects`, `GET/POST/PUT/DELETE /api/tasks` (`?projectId=`), `GET/POST /api/comments` (`?taskId=`), `GET /api/history` (`?taskId=`), `GET/POST/DELETE /api/files` (`?taskId=`), `GET/POST/PUT/DELETE /api/fs` (file manager), `GET /api/analytics`, `GET/PUT /api/rbac`, `GET/POST/PUT/DELETE /api/roles`, `GET /api/notifications/user/{id}`.

`PUT` accepts partial objects. Sessions last 30 days of inactivity.

> **Renamed in this version.** The `stories` table is now `tasks`, `storyStatus` is now `status`, `module` is now `tag`, and every `storyId` is now `taskId`; the `/api/pm-*` routes lost their prefix (`/api/pm-stories` → `/api/tasks`). `db.js` migrates an existing database automatically on first boot. Any external client calling the old paths or field names must be updated.

## Email

Optional. Set `COREKIT_SMTP_HOST/PORT/USER/PASS/FROM` for invites, password resets and notification mail. Without it, invite and reset links are returned in the API response for an admin to share manually. Per-project, per-type notification toggles live under a project's ⚙ Settings.

## Structure

- `server.js` — HTTP + API + static
- `db.js` — schema and migrations (users, sessions, projects, customers, tasks, comments, files, notifications, history)
- `public/index.html` — the whole UI (login, projects, board with drag & drop, task drawer, file manager, team admin, notification inbox)
