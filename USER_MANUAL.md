# Trivyah Task Manager — User Manual

A lightweight project & task tracker for any kind of work: projects, tasks, a board, dashboards, a file manager, customers, and notifications — all in one app.

---

## 1. Logging in

Go to the app URL (e.g. `https://corekit.me` or `http://localhost:4580`) and sign in with your username and password.

- **Forgot your password?** Click "Forgot password?" on the login screen and enter your username or email. If your account has an email on file, a reset link is sent; otherwise ask an admin for a reset link.
- New accounts get either a temporary password or a "set your password" invite link from an admin.

---

## 2. Roles

A four-rung ladder — each rung can do everything the rungs below it can. Admins can also define custom roles based on any of these rungs (§8).

| Role | What it adds |
|---|---|
| **TEAMMATE** | View and update tasks on their projects, move them across the board, comment, use the file manager. |
| **LEAD** | Create tasks, assign tasks to people, create projects and customers, edit projects they're a member of. |
| **ADMIN** | Create and edit users, see and edit **every** project, delete projects/tasks/files, manage custom roles and page permissions. |
| **SUPERADMIN** | Set or reset passwords, send reset links, delete users, grant any role. |

TEAMMATE and LEAD see only the projects they belong to (project owner, listed member, or having a task there). Project visibility is **always** enforced this way, regardless of anything set on Page Permission (§8) — that page only controls which top-level *sections* a role can navigate to, not which individual projects or tasks they can see.

---

## 3. The sidebar

- **My Dashboard** — your personal queue: everything assigned to you, most urgent first.
- **All Tasks** — every task you can see, with search and filters.
- **Admin Dashboard** *(LEAD and above by default)* — team load, project health, effort scoreboard, and critical/overdue items.
- **Client Projects** — billable work, each attached to a customer.
- **Internal Projects** — non-client work (hiring, ops, admin, personal workstreams).
- **Customers** *(LEAD and above by default)* — the customer directory and their files.
- **User Management** *(ADMIN and above)* — manage user accounts.
- **Roles** *(ADMIN and above)* — the role ladder and any custom roles (§8).
- **Page Permission** *(ADMIN and above)* — which roles can open which section (§8).

Below the nav, the sidebar lists every project you can see, split into Clients / Internal.

---

## 4. Projects

### Creating a project
Use **+ New service** or the "+ New client project" / "+ New internal project" buttons. Set a name, a short key (used as the task-number prefix, e.g. `ACME-12`), priority, and due date.

### Project types
- **Client** — work for a customer. **A client project must have a customer attached** (create one on the Customers page first, or from the new-project form).
- **Internal** — anything not tied to a customer.

Change a project's type any time from its ⚙ Settings.

### Project settings (⚙)
Open a project's board and click **⚙ Settings** — visible to admins, leads on that project, and the project owner:
- Name, description, priority, status, due date, owner
- **Members** — checkboxes controlling exactly who can see this project (this is the real access-control boundary, independent of Page Permission)
- **Customer** — which customer a client project belongs to
- **Notifications** — per-type toggles for in-app and email alerts (added to project, assigned, status change, comment, file)
- **Files** — a full folder tree for this project (§6)

---

## 5. The board

Open any project to see its board: **To Do → In Progress → In Review → Done**.

- **Drag and drop** a card between columns to change its status.
- **+ New task** creates a task *(LEAD and above — teammates work tasks, leads hand them out)*.
- Filter by assignee or free-text search.
- On mobile, the board becomes one column at a time with a tab strip.
- The **🗂 Files** tab on the right edge slides the project's file manager out over the board (§6). It covers 70% of the screen; close it with ✕, Esc, or by clicking outside it.

### The task drawer
Click any card to open its full detail drawer:
- **Details** — title & description
- **Properties** — status, priority, due date, and a free-text **Tag** for grouping (e.g. Finance, Onboarding)
- **People** — assignee *(leads only)* and who created it
- **Attachments** — upload/download files scoped to this task (25 MB each)
- **Comments** — text or pasted/attached screenshots
- **History** — a full audit trail of every change

---

## 6. Files

Every **project** and every **customer** has its own file area with nested folders. On a project board, open it from the **🗂 Files** tab on the right edge; for a customer it is on the customer's detail page.

- Create folders, upload files (25 MB each), rename, move, copy/paste, and multi-select.
- Drag items onto a folder to move them.
- Anyone who can see the project can view and download; only admins or whoever created an item can delete it.
- Writing to a **customer's** files requires LEAD or above.

---

## 7. Dashboards

- **My Dashboard** — your open tasks, what's due this week, your overdue count, and your all-time done count.
- **Admin Dashboard** — team load per person, project health by status, an **effort scoreboard** (tasks finished minus delay and reopen penalties), and a list of critical tasks.

A task is flagged **critical** when it has been reopened twice or more, or is running/finished more than 7 days late.

---

## 8. Roles & Page Permission — admin only

### Roles
There are four built-in roles — Teammate, Lead, Admin, Superadmin — and each inherits everything the ones below it can do. They cannot be renamed or deleted.

On the **Roles** page you can add a **custom role**: give it a display name, a name (stored on the account, letters/numbers/underscore), and pick which built-in rung it is **based on**. It then has exactly that rung's permissions — an "Accountant" based on Lead can do everything a lead can. A new role also starts with its rung's page access, which you can then adjust.

Rules worth knowing:
- You can only create, edit or delete a role you outrank. An admin therefore cannot create a role based on Superadmin, nor edit one.
- A role's name is fixed once created; only its display name can change.
- A role cannot be deleted while anyone still holds it — move those people first.
- Superadmin-rank roles are never offered when creating a user.

### Page Permission
Sets which roles can reach each top-level section: Dashboard, All Tasks, Admin Dashboard, Client Projects, Internal Projects, Customers, User Management.

- Check a box to grant a role that section's nav link and page, then **Save page access**.
- Columns for roles you don't outrank are locked (🔒) — an admin can see that superadmins have access but cannot change it. Saving never disturbs those roles' access.
- **Superadmin always keeps full access**, so nobody can lock every superadmin out.
- Changes apply immediately — affected users stop seeing that nav item, and get redirected to Dashboard if they visit the page directly.

**Important:** this only controls *which sections* a role can navigate to. It does **not** override per-project membership — a teammate who isn't a member of Project X still can't see Project X's board or tasks, even if their role has access to the Client Projects page in general.

---

## 9. User management — admin only

From **User Management**:
- **+ Add user** — create an account with a role; leave the password blank to send a set-password invite link (emailed if the user has an email on file, otherwise share the link manually).
- **edit** — change display name, email, or role.
- **reset pw** — generate a one-time password reset link *(superadmin only)*.
- **disable / enable** — block or restore login access without deleting the account.
- **delete** *(superadmin only)* — permanently remove a user. Blocked if they have linked tasks, comments or files — disable instead, or reassign their work first.

Nobody can edit an account that outranks them, or grant a role above their own.

---

## 10. Notifications

The bell icon (top right) shows unread notifications — new assignments, comments, attachments, status changes, and being added to a project. Click one to jump straight to that task. Notifications also arrive by email if the recipient has an email address on file and outbound mail is configured. Turn any type off per project under ⚙ Settings → Notifications.

---

## 11. Installing as an app (PWA)

The tracker is an installable Progressive Web App — on desktop Chrome/Edge, use the install icon in the address bar; on mobile, use "Add to Home Screen." It then opens like a native app with its own icon.

---

## 12. Tips

- Only admins see every project by default; ask an admin to add you as a member under ⚙ Settings if a project is missing.
- Use the **Tag** field to slice tasks across a project (department, workstream, client area) — it's free text and shows up in search.
- A project can only be deleted by an admin, and deleting one cascades: its tasks, comments and files all go with it.
