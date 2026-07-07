#!/usr/bin/env node
/**
 * One-time import: Sprint0 → CoreKit Tracker.
 *
 * Pulls users, projects, and all stories/issues/bugs visible to your Sprint0
 * session (cookie/credentials resolved the same way as sprint0-mcp) and
 * inserts them into the local CoreKit Tracker database.
 *
 * - Idempotent: existing usernames / project keys / story numbers are skipped,
 *   so re-running only adds what's new.
 * - Imported users get random passwords (they log in via CoreKit Tracker admin reset).
 * - Story numbers are preserved (SPPL-50 stays SPPL-50).
 *
 *   node import-sprint0.js
 */
import { randomBytes, scryptSync } from "node:crypto";
import { db, now } from "./db.js";
import { createAuth } from "../sprint0-mcp/src/auth.js";

const auth = createAuth({ cookieEnvVars: ["SPRINT0_COOKIE"], log: console.log });
const api = async (p) => {
  const res = await auth.authFetch(p);
  if (!res.ok) throw new Error(`${res.status} on ${p}`);
  return res.json();
};

const status = await api("/api/auth/status");
if (status.authenticated === false) {
  console.error("Sprint0 session expired — refresh SPRINT0_COOKIE and retry.");
  process.exit(1);
}
console.log(`Importing as ${status.displayName || status.username}`);

// --- users -------------------------------------------------------------
const userMap = new Map(); // sprint0 id -> corekit id
const s0users = await api("/api/users");
let uNew = 0;
for (const u of s0users) {
  const uname = String(u.username).toLowerCase();
  let row = db.prepare("SELECT id FROM users WHERE username=?").get(uname);
  if (!row) {
    const salt = randomBytes(16).toString("hex");
    const pw = randomBytes(9).toString("base64url"); // unknown to anyone; admin resets it
    db.prepare("INSERT INTO users (username,displayName,role,passwordHash,salt,createdDate) VALUES (?,?,?,?,?,?)")
      .run(uname, u.displayName || u.name || uname, u.role || "USER", scryptSync(pw, salt, 64).toString("hex"), salt, now());
    row = db.prepare("SELECT id FROM users WHERE username=?").get(uname);
    uNew++;
  }
  userMap.set(u.id, row.id);
}
console.log(`users: ${s0users.length} seen, ${uNew} created`);

// --- projects ----------------------------------------------------------
const projMap = new Map();
const s0projects = await api("/api/pm-projects");
let pNew = 0;
for (const p of s0projects) {
  let row = db.prepare("SELECT id FROM projects WHERE key=?").get(p.key);
  if (!row) {
    const assignees = String(p.assignees || "").split(",").map((x) => userMap.get(Number(x))).filter(Boolean).join(",");
    db.prepare(`INSERT INTO projects (key,name,description,priority,projectStatus,dueDate,assignees,assignedToId,createdDate,modifiedDate)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(p.key, p.name, p.description || "", p.priority || "Medium", p.projectStatus || "Active",
        p.dueDate ?? null, assignees, userMap.get(p.assignedTo?.id) ?? null,
        p.createdDate || now(), p.modifiedDate || now());
    row = db.prepare("SELECT id FROM projects WHERE key=?").get(p.key);
    pNew++;
  }
  projMap.set(p.id, row.id);
}
console.log(`projects: ${s0projects.length} seen, ${pNew} created`);

// --- stories -----------------------------------------------------------
let sNew = 0, sSeen = 0;
for (const p of s0projects) {
  const lists = await Promise.all(["Story", "Issue", "Bug"].map((t) =>
    api(`/api/pm-stories?projectId=${p.id}&type=${t}`).catch(() => [])));
  for (const s of lists.flat()) {
    sSeen++;
    const oxProjectId = projMap.get(p.id);
    let number = s.number || null;
    if (!number) { // rare: story saved without a number — mint the next one
      const nextSeq = db.prepare("SELECT COALESCE(MAX(seq),0)+1 n FROM stories WHERE projectId=?").get(oxProjectId).n;
      number = `${p.key}-${nextSeq}`;
    }
    if (db.prepare("SELECT 1 FROM stories WHERE number=?").get(number)) continue;
    const seq = Number(String(number).split("-")[1]) || null;
    db.prepare(`INSERT INTO stories (projectId,seq,number,name,description,module,type,priority,storyPoints,storyStatus,dueDate,assignedToId,reporterId,createdDate,modifiedDate)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(oxProjectId, seq ?? 0, number, s.name, s.description || "", s.module || "",
        s.type || "Story", s.priority || "Medium", s.storyPoints ?? null, s.storyStatus || "Backlog",
        s.dueDate ?? null, userMap.get(s.assignedTo?.id) ?? null, userMap.get(s.reporter?.id) ?? null,
        s.createdDate || now(), s.modifiedDate || now());
    sNew++;
  }
  console.log(`  ${p.key}: done`);
}
console.log(`stories: ${sSeen} seen, ${sNew} created`);
console.log("Import complete. Note: imported users need a password reset by an CoreKit Tracker admin before they can log in.");
