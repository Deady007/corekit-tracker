/**
 * CoreKit Tracker database — built-in node:sqlite, one file, no dependencies.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(ROOT, "data"), { recursive: true });

export const db = new DatabaseSync(join(ROOT, "data", "corekit.db"));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
`);

// ---------------------------------------------------------------------------
// rename migration: 'stories' became 'tasks' when this stopped being a
// dev-only tracker. This MUST run before the CREATE TABLE IF NOT EXISTS block
// below — otherwise an empty `tasks` table gets created first and the rename
// then fails, stranding every row in the old table.
{
  const hasTable = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
  const hasColumn = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some((r) => r.name === c);

  if (hasTable("stories") && !hasTable("tasks")) db.exec("ALTER TABLE stories RENAME TO tasks");
  if (hasTable("tasks") && hasColumn("tasks", "storyStatus"))
    db.exec("ALTER TABLE tasks RENAME COLUMN storyStatus TO status");
  if (hasTable("tasks") && hasColumn("tasks", "module"))
    db.exec("ALTER TABLE tasks RENAME COLUMN module TO tag");
  for (const t of ["comments", "attachments", "history", "notifications"])
    if (hasTable(t) && hasColumn(t, "storyId")) db.exec(`ALTER TABLE ${t} RENAME COLUMN storyId TO taskId`);
  // the audit trail stores the field name it recorded — rewrite it to match
  if (hasTable("history")) {
    db.exec("UPDATE history SET field='status' WHERE field='storyStatus'");
    db.exec("UPDATE history SET field='tag' WHERE field='module'");
  }
  // drop indexes that outlived what they indexed: the pre-rename names (which
  // survive a table rename, so the CREATE INDEX statements below would leave a
  // duplicate set behind) and the two from the retired showcase-link feature
  for (const i of ["idx_stories_project", "idx_stories_assignee", "idx_attach_story",
                   "idx_history_story", "idx_projects_share", "idx_users_share"])
    db.exec(`DROP INDEX IF EXISTS ${i}`);
}

db.exec(`

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  displayName TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'DEV',           -- DEV | DEVLEAD | ADMIN
  passwordHash TEXT NOT NULL,
  salt TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  lastLoginAt TEXT,
  createdDate TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  createdAt TEXT NOT NULL,
  lastSeenAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'Medium',    -- Low | Medium | High
  projectStatus TEXT NOT NULL DEFAULT 'Active', -- Active | On Hold | Completed
  dueDate TEXT,
  assignees TEXT DEFAULT '',                  -- comma-separated user ids
  assignedToId INTEGER REFERENCES users(id),
  createdDate TEXT NOT NULL,
  modifiedDate TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  projectId INTEGER NOT NULL REFERENCES projects(id),
  seq INTEGER NOT NULL,
  number TEXT NOT NULL UNIQUE,                -- e.g. OX-12
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  tag TEXT DEFAULT '',
  type TEXT NOT NULL DEFAULT 'Task',        -- retired: every work item is a Task
  priority TEXT NOT NULL DEFAULT 'Medium',
  status TEXT NOT NULL DEFAULT 'To Do',  -- To Do | In Progress | In Review | Done
  dueDate TEXT,
  assignedToId INTEGER REFERENCES users(id),
  reporterId INTEGER REFERENCES users(id),
  createdDate TEXT NOT NULL,
  modifiedDate TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(projectId);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignedToId);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  taskId INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  userId INTEGER NOT NULL REFERENCES users(id),
  text TEXT NOT NULL,
  createdDate TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  taskId INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime TEXT DEFAULT 'application/octet-stream',
  size INTEGER NOT NULL,
  path TEXT NOT NULL,
  uploadedById INTEGER REFERENCES users(id),
  createdDate TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attach_task ON attachments(taskId);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  taskId INTEGER,
  read INTEGER NOT NULL DEFAULT 0,
  createdDate TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  taskId INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  userId INTEGER REFERENCES users(id),
  field TEXT NOT NULL,             -- 'created' | 'status' | 'assignedTo' | ...
  oldValue TEXT,
  newValue TEXT,
  createdDate TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_task ON history(taskId);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS password_resets (
  token TEXT PRIMARY KEY,
  userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expiresAt TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  createdDate TEXT NOT NULL
);
`);

// migration: image support on comments (idempotent)
try { db.exec("ALTER TABLE comments ADD COLUMN imagePath TEXT"); } catch {}
try { db.exec("ALTER TABLE comments ADD COLUMN imageMime TEXT"); } catch {}

// migration: separate email from username; backfill from email-style usernames
try {
  db.exec("ALTER TABLE users ADD COLUMN email TEXT");
  db.exec("UPDATE users SET email = username WHERE username LIKE '%@%'");
} catch {}

// migration: product vs client trackers
try { db.exec("ALTER TABLE projects ADD COLUMN category TEXT NOT NULL DEFAULT 'client'"); } catch {}

db.exec(`
CREATE TABLE IF NOT EXISTS project_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  projectId INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime TEXT DEFAULT 'application/octet-stream',
  size INTEGER NOT NULL,
  path TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'document', -- document | image | video
  uploadedById INTEGER REFERENCES users(id),
  createdDate TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_files_project ON project_files(projectId);

CREATE TABLE IF NOT EXISTS page_access (
  page TEXT PRIMARY KEY,
  roles TEXT NOT NULL -- comma-separated role names
);

-- custom roles. Each pins itself to one of the four built-in rungs and
-- inherits its rank, so every atLeast() check in the server keeps working
-- without needing to know custom roles exist.
CREATE TABLE IF NOT EXISTS custom_roles (
  name TEXT PRIMARY KEY,          -- what lands in users.role
  label TEXT NOT NULL,
  baseRole TEXT NOT NULL,         -- TEAMMATE | LEAD | ADMIN | SUPERADMIN
  createdDate TEXT NOT NULL
);

-- per-project notification preferences. No row for a (projectId,type) pair
-- means "enabled" — this table only ever stores overrides/opt-outs.
CREATE TABLE IF NOT EXISTS project_notification_settings (
  projectId INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL, -- added | assigned | status | comment | file
  inApp INTEGER NOT NULL DEFAULT 1,
  email INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (projectId, type)
);
`);

// migration: roles simplified to DEV/DEVLEAD/ADMIN (USER retired)
try { db.exec("UPDATE users SET role='DEV' WHERE role='USER'"); } catch {}

// migration: four-rung role ladder — TEAMMATE < LEAD < ADMIN < SUPERADMIN.
// The old ADMIN was the all-powerful role, so it maps to SUPERADMIN; the new
// ADMIN rung sits below it and only manages users.
const ROLE_RENAMES = { DEV: "TEAMMATE", DEVLEAD: "LEAD", ADMIN: "SUPERADMIN" };
for (const [from, to] of Object.entries(ROLE_RENAMES)) {
  try { db.prepare("UPDATE users SET role=? WHERE role=?").run(to, from); } catch {}
}
for (const row of db.prepare("SELECT page, roles FROM page_access").all()) {
  const cleaned = [...new Set(row.roles.split(",")
    .filter((r) => r && r !== "USER")
    .map((r) => ROLE_RENAMES[r] || r))];
  // whatever the old ADMIN could reach, the new ADMIN rung reaches too
  if (cleaned.includes("SUPERADMIN") && !cleaned.includes("ADMIN")) cleaned.push("ADMIN");
  const joined = cleaned.join(",");
  if (joined !== row.roles) db.prepare("UPDATE page_access SET roles=? WHERE page=?").run(joined, row.page);
}

// migration: customers — a client project must attach one, identified by a
// unique customer number so two customers sharing a display name never conflict
db.exec(`
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customerNumber TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  contactName TEXT,
  phone TEXT,
  email TEXT,
  createdDate TEXT NOT NULL,
  modifiedDate TEXT NOT NULL
);
`);
try { db.exec("ALTER TABLE projects ADD COLUMN customerId INTEGER REFERENCES customers(id)"); } catch {}

// migration: postal address + free-form notes on the customer record
try { db.exec("ALTER TABLE customers ADD COLUMN address TEXT"); } catch {}
try { db.exec("ALTER TABLE customers ADD COLUMN notes TEXT"); } catch {}

export const nextCustomerNumber = () => {
  let max = 0;
  for (const r of db.prepare("SELECT customerNumber FROM customers").all()) {
    const n = Number(String(r.customerNumber).replace(/\D/g, "")); if (n > max) max = n;
  }
  return "CUST-" + String(max + 1).padStart(4, "0");
};

// backfill: turn each client project's free-text clientName/etc into its own
// customer record (two projects sharing a clientName become two distinct
// customers if their contact details differ — same-name collision is exactly
// what customerNumber exists to resolve). The client* columns are retired, so
// on a database created after that the SELECT throws and there is nothing to do.
try {
  const orphans = db.prepare(
    "SELECT id, clientName, clientContactName, clientPhone, clientEmail FROM projects WHERE category='client' AND customerId IS NULL AND clientName IS NOT NULL AND clientName != ''"
  ).all();
  for (const p of orphans) {
    const ts = new Date().toISOString();
    const r = db.prepare("INSERT INTO customers (customerNumber,name,contactName,phone,email,createdDate,modifiedDate) VALUES (?,?,?,?,?,?,?)")
      .run(nextCustomerNumber(), p.clientName, p.clientContactName || null, p.clientPhone || null, p.clientEmail || null, ts, ts);
    db.prepare("UPDATE projects SET customerId=? WHERE id=?").run(r.lastInsertRowid, p.id);
  }
} catch {}

// migration: two services only — the product category is retired, and every
// project that used it becomes an internal project (nothing is deleted)
try { db.exec("UPDATE projects SET category='internal' WHERE category='product'"); } catch {}

// migration: one work item type — 'Task'. Story/Issue/Bug are retired.
try { db.exec("UPDATE tasks SET type='Task' WHERE type!='Task'"); } catch {}

// migration: plain-language status — 'Backlog' is agile jargon, this tracker is
// for any kind of work. The history trail is rewritten too so old status
// changes don't read as moves to a column that no longer exists.
try {
  db.exec("UPDATE tasks SET status='To Do' WHERE status='Backlog'");
  db.exec("UPDATE history SET oldValue='To Do' WHERE field='status' AND oldValue='Backlog'");
  db.exec("UPDATE history SET newValue='To Do' WHERE field='status' AND newValue='Backlog'");
} catch {}

// migration: file manager — folders + files hung off a customer or a project.
// parentId NULL is that scope's root, so every customer/project starts with an
// empty root folder without needing a seed row.
db.exec(`
CREATE TABLE IF NOT EXISTS fs_nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scopeType TEXT NOT NULL,                    -- customer | project
  scopeId INTEGER NOT NULL,
  parentId INTEGER REFERENCES fs_nodes(id) ON DELETE CASCADE,
  type TEXT NOT NULL,                         -- folder | file
  name TEXT NOT NULL,
  mime TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  path TEXT,                                  -- on-disk name, files only
  createdById INTEGER REFERENCES users(id),
  createdDate TEXT NOT NULL,
  modifiedDate TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fs_scope ON fs_nodes(scopeType, scopeId, parentId);
`);

// backfill: fold the old flat project_files list into each project's file root,
// so nothing uploaded before the file manager existed disappears
{
  const seen = new Set(db.prepare("SELECT path FROM fs_nodes WHERE path IS NOT NULL").all().map((r) => r.path));
  const ins = db.prepare(`INSERT INTO fs_nodes (scopeType,scopeId,parentId,type,name,mime,size,path,createdById,createdDate,modifiedDate)
    VALUES ('project',?,NULL,'file',?,?,?,?,?,?,?)`);
  for (const f of db.prepare("SELECT * FROM project_files").all()) {
    if (seen.has(f.path)) continue;
    ins.run(f.projectId, f.filename, f.mime, f.size, f.path, f.uploadedById, f.createdDate, f.createdDate);
  }
}

// migration: seed default RBAC page access (idempotent — only fills missing rows)
const DEFAULT_PAGE_ACCESS = {
  dashboard: "TEAMMATE,LEAD,ADMIN,SUPERADMIN",
  tasks: "TEAMMATE,LEAD,ADMIN,SUPERADMIN",
  command: "LEAD,ADMIN,SUPERADMIN",
  clients: "TEAMMATE,LEAD,ADMIN,SUPERADMIN",
  internal: "TEAMMATE,LEAD,ADMIN,SUPERADMIN",
  customers: "LEAD,ADMIN,SUPERADMIN",
  team: "ADMIN,SUPERADMIN",
};
{
  const insertPage = db.prepare("INSERT OR IGNORE INTO page_access (page, roles) VALUES (?,?)");
  for (const [page, roles] of Object.entries(DEFAULT_PAGE_ACCESS)) insertPage.run(page, roles);
  db.prepare("DELETE FROM page_access WHERE page='products'").run(); // page retired
}

export const now = () => new Date().toISOString();
