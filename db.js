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
  assignees TEXT DEFAULT '',                  -- comma-separated user ids (Sprint0 shape)
  assignedToId INTEGER REFERENCES users(id),
  createdDate TEXT NOT NULL,
  modifiedDate TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  projectId INTEGER NOT NULL REFERENCES projects(id),
  seq INTEGER NOT NULL,
  number TEXT NOT NULL UNIQUE,                -- e.g. OX-12
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  module TEXT DEFAULT '',
  type TEXT NOT NULL DEFAULT 'Story',         -- Story | Issue | Bug
  priority TEXT NOT NULL DEFAULT 'Medium',
  storyPoints INTEGER,
  storyStatus TEXT NOT NULL DEFAULT 'Backlog',-- Backlog | In Progress | In Review | Done
  dueDate TEXT,
  assignedToId INTEGER REFERENCES users(id),
  reporterId INTEGER REFERENCES users(id),
  createdDate TEXT NOT NULL,
  modifiedDate TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stories_project ON stories(projectId);
CREATE INDEX IF NOT EXISTS idx_stories_assignee ON stories(assignedToId);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  storyId INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  userId INTEGER NOT NULL REFERENCES users(id),
  text TEXT NOT NULL,
  createdDate TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  storyId INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime TEXT DEFAULT 'application/octet-stream',
  size INTEGER NOT NULL,
  path TEXT NOT NULL,
  uploadedById INTEGER REFERENCES users(id),
  createdDate TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attach_story ON attachments(storyId);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  storyId INTEGER,
  read INTEGER NOT NULL DEFAULT 0,
  createdDate TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  storyId INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  userId INTEGER REFERENCES users(id),
  field TEXT NOT NULL,             -- 'created' | 'storyStatus' | 'assignedTo' | ...
  oldValue TEXT,
  newValue TEXT,
  createdDate TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_story ON history(storyId);
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

// migration: product vs client trackers + yearly target for products
try { db.exec("ALTER TABLE projects ADD COLUMN category TEXT NOT NULL DEFAULT 'client'"); } catch {}
try { db.exec("ALTER TABLE projects ADD COLUMN targetDate TEXT"); } catch {}

// migration: client info + shareable showcase links
try { db.exec("ALTER TABLE projects ADD COLUMN clientName TEXT"); } catch {}
try { db.exec("ALTER TABLE projects ADD COLUMN clientContactName TEXT"); } catch {}
try { db.exec("ALTER TABLE projects ADD COLUMN clientPhone TEXT"); } catch {}
try { db.exec("ALTER TABLE projects ADD COLUMN clientEmail TEXT"); } catch {}
try { db.exec("ALTER TABLE projects ADD COLUMN shareToken TEXT"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN shareToken TEXT"); } catch {}
try { db.exec("CREATE UNIQUE INDEX idx_projects_share ON projects(shareToken) WHERE shareToken IS NOT NULL"); } catch {}
try { db.exec("CREATE UNIQUE INDEX idx_users_share ON users(shareToken) WHERE shareToken IS NOT NULL"); } catch {}

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
  roles TEXT NOT NULL -- comma-separated: DEV,DEVLEAD,ADMIN
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
for (const row of db.prepare("SELECT page, roles FROM page_access").all()) {
  const cleaned = row.roles.split(",").filter((r) => r && r !== "USER").join(",");
  if (cleaned !== row.roles) db.prepare("UPDATE page_access SET roles=? WHERE page=?").run(cleaned, row.page);
}

// migration: lightweight version label for products
try { db.exec("ALTER TABLE projects ADD COLUMN version TEXT"); } catch {}

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

// backfill: turn each client project's free-text clientName/etc into its own
// customer record (two projects sharing a clientName become two distinct
// customers if their contact details differ — same-name collision is exactly
// what customerNumber exists to resolve)
{
  const nextNumber = () => {
    const rows = db.prepare("SELECT customerNumber FROM customers").all();
    let max = 0;
    for (const r of rows) { const n = Number(String(r.customerNumber).replace(/\D/g, "")); if (n > max) max = n; }
    return "CUST-" + String(max + 1).padStart(4, "0");
  };
  const orphans = db.prepare(
    "SELECT id, clientName, clientContactName, clientPhone, clientEmail FROM projects WHERE category='client' AND customerId IS NULL AND clientName IS NOT NULL AND clientName != ''"
  ).all();
  for (const p of orphans) {
    const num = nextNumber();
    const ts = new Date().toISOString();
    const r = db.prepare("INSERT INTO customers (customerNumber,name,contactName,phone,email,createdDate,modifiedDate) VALUES (?,?,?,?,?,?,?)")
      .run(num, p.clientName, p.clientContactName || null, p.clientPhone || null, p.clientEmail || null, ts, ts);
    db.prepare("UPDATE projects SET customerId=? WHERE id=?").run(r.lastInsertRowid, p.id);
  }
}

// migration: seed default RBAC page access (idempotent — only fills missing rows)
const DEFAULT_PAGE_ACCESS = {
  dashboard: "DEV,DEVLEAD,ADMIN",
  tasks: "DEV,DEVLEAD,ADMIN",
  command: "DEVLEAD,ADMIN",
  products: "DEV,DEVLEAD,ADMIN",
  clients: "DEV,DEVLEAD,ADMIN",
  internal: "DEV,DEVLEAD,ADMIN",
  customers: "DEVLEAD,ADMIN",
  team: "ADMIN",
};
{
  const insertPage = db.prepare("INSERT OR IGNORE INTO page_access (page, roles) VALUES (?,?)");
  for (const [page, roles] of Object.entries(DEFAULT_PAGE_ACCESS)) insertPage.run(page, roles);
}

export const now = () => new Date().toISOString();
