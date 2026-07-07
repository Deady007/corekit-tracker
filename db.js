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
  role TEXT NOT NULL DEFAULT 'USER',          -- USER | DEV | DEVLEAD | ADMIN
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

export const now = () => new Date().toISOString();
