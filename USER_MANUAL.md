# Trivyah Task Manager — User Manual

A lightweight project & task tracker for Trivyah Tech: projects, stories/issues/bugs, a kanban board, dashboards, file attachments, notifications, and shareable read-only links — all in one app, no login required to view a shared link.

---

## 1. Logging in

Go to the app URL (e.g. `https://corekit.me` or `http://localhost:4580`) and sign in with your username and password.

- **Forgot your password?** Click "Forgot password?" on the login screen and enter your username or email. If your account has an email on file, a reset link is sent; otherwise ask an admin for a reset link.
- New accounts get either a temporary password or a "set your password" invite link from an admin.

---

## 2. Roles

| Role | What they see |
|---|---|
| **ADMIN** | Everything — every project, Team page, Access Control page, all analytics. |
| **DEVLEAD** | Every project they're a member/owner of, plus the Command dashboard. |
| **DEV** | Only projects they belong to (assigned owner, listed member, or have a story on). |
| **USER** | Same project-level visibility as DEV. |

Project visibility is **always** enforced this way, regardless of anything set on the Access Control page (see §8) — that page only controls which top-level *sections* of the app a role can navigate to, not which individual projects/tasks they can see.

---

## 3. The sidebar

- **Dashboard** — your personal queue: everything assigned to you, most urgent first.
- **Command** *(ADMIN/DEVLEAD only by default)* — team load, project health, effort scoreboard, and critical/overdue items across all visible projects.
- **Product Lab** — CoreKit's own products (internal product line, e.g. SCM/HRMS/POS), tracked with yearly progress bars and suggestions.
- **Clients** — client project work, grouped by client name.
- **Internal Works** — non-client internal projects (hiring, ops, internal tooling, admin work).
- **Team** *(ADMIN only)* — manage user accounts.
- **Access Control** *(ADMIN only)* — role-based page permissions (§8).

Below the nav, the sidebar lists every project you can see, split into Products / Clients / Internal.

---

## 4. Projects

### Creating a project
Use the "+ New…" button on the Clients, Products, or Internal Works page. Set a name, a short key (used as the item-number prefix, e.g. `ACME-12`), priority, due date, and — for client projects — a client name.

### Project types (category)
Every project is one of three types, each shown in its own sidebar section and page:
- **client** — billable client work
- **product** — CoreKit's own product line
- **internal** — internal, non-client company work

Change a project's type any time from its ⚙ Settings.

### Project settings (⚙)
Open a project's board and click **⚙ Settings** (visible to admins, dev leads on that project, and the project owner) to edit:
- Name, description, priority, status, due date, yearly target date, owner
- **Members** — checkboxes controlling exactly who can see this project (this is the real access-control boundary, independent of the Access Control page)
- **Client info** — client name, contact person, phone, email
- **Documents, images & videos** — upload files here (25 MB max each); anyone who can see the project can view/download them; only admins or the uploader can delete
- **Showcase link** — generate a public, read-only link to this project (§7)

### Client-wise grouping
The Clients page automatically groups project cards under a heading per distinct client name (projects with no client name set land under "Unassigned client").

---

## 5. Kanban board

Open any project from the sidebar or its card to see its board: **Backlog → In Progress → In Review → Done**.

- **Drag and drop** a card between columns to change its status.
- **+ New item** creates a Story, Issue, or Bug.
- Filter by type (chips), assignee (dropdown), or free-text search.
- On mobile, the board becomes one column at a time with a tab strip.

### The item drawer
Click any card to open its full detail drawer:
- **Details** — title & description
- **Triage** — type, status, priority, points, due date, module
- **People** — assignee and reporter
- **Attachments** — upload/download files scoped to this item
- **Comments** — text or pasted/attached screenshots
- **History** — a full audit trail of every change

---

## 6. Dashboards

- **My Dashboard** — your open items, what's due this week, your overdue count, and your all-time done count.
- **Command** (leads/admins) — team load per person, project health by status, an effort scoreboard (points earned minus delay/rework penalties), and a list of critical items (badly delayed or churning).

---

## 7. Showcase links (share without a login)

Two kinds of public, read-only links — anyone with the link can open it, no account needed:

- **Project showcase** — generate it from a project's ⚙ Settings → "Showcase link". Shows the project's status, priority, due date, a **read-only kanban board** of its items, and any images/videos attached to the project. No comments, history, or internal notes are exposed.
- **Person showcase** — generate it from the Team page → "showcase link" next to any user. Shows their display name, role, the projects they've worked on, how many items they've shipped, and their effort score. Useful for a portfolio-style summary you can send externally.

Both links can be **revoked** at any time (project) or **regenerated** (person), which invalidates the old URL immediately.

---

## 8. Access Control (RBAC) — admin only

Under **Access Control**, admins set which roles (USER / DEV / DEVLEAD / ADMIN) can see each top-level section: Dashboard, Command, Product Lab, Clients, Internal Works, Team.

- Check a box to grant a role access to that section's nav link and page.
- **ADMIN is always checked and can't be unchecked** — this prevents accidentally locking every admin out of the app.
- Click **Save changes** to apply immediately — affected users will stop seeing that nav item (and get redirected to Dashboard if they try to visit the page directly) next time they load or navigate the app.

**Important:** this only controls *which sections of the app* a role can navigate to. It does **not** override per-project membership — a DEV who isn't a member of Project X still can't see Project X's board or tasks, even if their role has access to the Clients page in general.

---

## 9. Team management — admin only

From the **Team** page:
- **+ Add user** — create an account with a role; leave the password blank to send a set-password invite link (emailed if the user has an email on file, otherwise share the link manually).
- **edit** — change display name, email, role, or force a new password.
- **reset pw** — generate a one-time password reset link for that user.
- **showcase link** — generate/copy that user's person-showcase link.
- **disable / enable** — block or restore login access without deleting the account.
- **delete** — permanently remove a user (blocked if they have linked stories/comments/files — disable instead, or reassign their work first).

---

## 10. Notifications

The bell icon (top right) shows unread notifications — new assignments, comments, attachments, and being added to a project. Click a notification to jump straight to that item. Notifications also arrive by email if the recipient has an email address on file and outbound mail is configured on the server.

---

## 11. Installing as an app (PWA)

The tracker is an installable Progressive Web App — on desktop Chrome/Edge, use the install icon in the address bar; on mobile, use "Add to Home Screen." It then opens like a native app with its own icon.

---

## 12. Tips

- Only admins see every project by default; ask an admin to add you as a member on ⚙ Settings if you're missing a project.
- Use the yearly target date on Product Lab projects to track annual build plans — the progress bar and suggestions update automatically from item status.
- A project can be deleted only if it has no items (unless you're an admin, in which case it cascades and removes everything — items, comments, files).
