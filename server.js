#!/usr/bin/env node
/**
 * Trivyah Task Manager — lightweight task tracking (projects, tasks, board).
 * Zero dependencies: node:http + node:sqlite + node:crypto.
 *
 *   POST /api/auth/login {username,password} → Set-Cookie: JSESSIONID
 *   GET  /api/auth/status
 *   GET  /api/users            POST /api/users (admin)   PUT /api/users/:id (admin)
 *   GET  /api/projects         POST/PUT/DELETE /api/projects[/:id]
 *   GET  /api/tasks?projectId= GET/POST/PUT/DELETE /api/tasks[/:id]
 *   GET  /api/comments?taskId= POST /api/comments
 *   GET  /api/history?taskId=
 *   GET  /api/notifications/user/:id
 *
 *   node server.js    → http://localhost:4580
 */
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { db, now, nextCustomerNumber } from "./db.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.COREKIT_PORT || 4580);
const HOST = process.env.COREKIT_HOST || "0.0.0.0";       // set 127.0.0.1 behind a reverse proxy
const SECURE_COOKIES = !!process.env.COREKIT_SECURE_COOKIES; // set when serving over HTTPS
const TRUST_PROXY = !!process.env.COREKIT_TRUST_PROXY;    // read client IP from X-Forwarded-For (Caddy/nginx)
const SESSION_IDLE_DAYS = 30;

// --- login rate limiting: 10 failures per 15 min per IP+username ------------
const LOGIN_WINDOW_MS = 15 * 60_000, LOGIN_MAX_FAILURES = 10;
const loginFailures = new Map();
function clientIp(req) {
  if (TRUST_PROXY) {
    const xf = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (xf) return xf;
  }
  return req.socket.remoteAddress || "?";
}
function loginBlocked(key) {
  const e = loginFailures.get(key);
  if (!e) return false;
  if (Date.now() > e.resetAt) { loginFailures.delete(key); return false; }
  return e.count >= LOGIN_MAX_FAILURES;
}
function loginFailed(key) {
  const e = loginFailures.get(key);
  if (!e || Date.now() > e.resetAt) loginFailures.set(key, { count: 1, resetAt: Date.now() + LOGIN_WINDOW_MS });
  else e.count++;
}

// ---------------------------------------------------------------------------
// roles — a four-rung ladder, each rung inheriting everything below it:
//   TEAMMATE   view/update tasks, comment
//   LEAD       + create & assign tasks, create projects and customers
//   ADMIN      + create and edit users, see every project, delete work items
//   SUPERADMIN + set/reset passwords and delete users
const BUILTIN_ROLES = ["TEAMMATE", "LEAD", "ADMIN", "SUPERADMIN"];
const BUILTIN_LABELS = { TEAMMATE: "Teammate", LEAD: "Lead", ADMIN: "Admin", SUPERADMIN: "Superadmin" };

// A custom role pins itself to one of the four rungs and inherits its rank, so
// every atLeast() check below keeps working without knowing custom roles exist.
// Cached because rankOf() runs on nearly every request; CRUD clears it.
let ROLE_CACHE = null;
function roleDefs() {
  if (!ROLE_CACHE) {
    ROLE_CACHE = [
      ...BUILTIN_ROLES.map((r, i) => ({ role: r, label: BUILTIN_LABELS[r], baseRole: r, rank: i + 1, builtin: true })),
      ...db.prepare("SELECT name, label, baseRole FROM custom_roles ORDER BY name").all()
        .filter((c) => BUILTIN_ROLES.includes(c.baseRole))
        .map((c) => ({ role: c.name, label: c.label, baseRole: c.baseRole,
          rank: BUILTIN_ROLES.indexOf(c.baseRole) + 1, builtin: false })),
    ];
  }
  return ROLE_CACHE;
}
const invalidateRoles = () => { ROLE_CACHE = null; };
const roleNames = () => roleDefs().map((r) => r.role);
const rankOf = (role) => roleDefs().find((r) => r.role === role)?.rank || 0;
const atLeast = (user, role) => rankOf(user?.role) >= rankOf(role);
const denied = (role) => ({ status: 403, json: { error: `Requires the ${role.toLowerCase()} role or higher` } });

// ---------------------------------------------------------------------------
// auth helpers
const hash = (pw, salt) => scryptSync(pw, salt, 64).toString("hex");

function verifyPassword(user, pw) {
  const h = Buffer.from(hash(pw, user.salt), "hex");
  const stored = Buffer.from(user.passwordHash, "hex");
  return h.length === stored.length && timingSafeEqual(h, stored);
}

function createUser({ username, displayName, role = "TEAMMATE", password, email }) {
  const salt = randomBytes(16).toString("hex");
  db.prepare(`INSERT INTO users (username, displayName, role, passwordHash, salt, createdDate, email)
              VALUES (?,?,?,?,?,?,?)`)
    .run(username.trim().toLowerCase(), displayName.trim(), role, hash(password, salt), salt, now(),
      email ? String(email).trim().toLowerCase() : null);
  return db.prepare("SELECT * FROM users WHERE username=?").get(username.trim().toLowerCase());
}

// first run: seed an admin and save its generated password locally
if (!db.prepare("SELECT COUNT(*) c FROM users").get().c) {
  const pw = process.env.COREKIT_ADMIN_PASSWORD || randomBytes(6).toString("base64url");
  createUser({ username: "admin", displayName: "Administrator", role: "SUPERADMIN", password: pw });
  const f = join(ROOT, "data", "admin-password.txt");
  if (!process.env.COREKIT_ADMIN_PASSWORD) writeFileSync(f, pw);
  console.log(`Seeded admin user 'admin' — password ${process.env.COREKIT_ADMIN_PASSWORD ? "from COREKIT_ADMIN_PASSWORD" : "saved to " + f}`);
}

const sessionToken = (req) => /(?:^|;\s*)JSESSIONID=([\w-]+)/.exec(req.headers.cookie || "")?.[1];

function sessionUser(req) {
  const token = sessionToken(req);
  if (!token) return null;
  const s = db.prepare("SELECT * FROM sessions WHERE token=?").get(token);
  if (!s) return null;
  if (Date.now() - new Date(s.lastSeenAt) > SESSION_IDLE_DAYS * 86400e3) {
    db.prepare("DELETE FROM sessions WHERE token=?").run(s.token);
    return null;
  }
  db.prepare("UPDATE sessions SET lastSeenAt=? WHERE token=?").run(now(), s.token);
  const u = db.prepare("SELECT * FROM users WHERE id=? AND enabled=1").get(s.userId);
  return u || null;
}

// ---------------------------------------------------------------------------
// JSON shapes returned by the API
const userShape = (u) => u && {
  id: u.id, username: u.username, displayName: u.displayName, name: u.displayName,
  email: u.email || null, role: u.role, enabled: !!u.enabled, lastLoginAt: u.lastLoginAt,
};
const getUser = (id) => id == null ? null : db.prepare("SELECT * FROM users WHERE id=?").get(id);

// two services only: client projects and internal projects
const CATEGORIES = new Set(["client", "internal"]);
const normCategory = (c) => (CATEGORIES.has(c) ? c : "client");

const customerShape = (c) => c && {
  id: c.id, customerNumber: c.customerNumber, name: c.name,
  contactName: c.contactName || null, phone: c.phone || null, email: c.email || null,
  address: c.address || null, notes: c.notes || null,
  createdDate: c.createdDate, modifiedDate: c.modifiedDate,
};
const getCustomer = (id) => id == null ? null : db.prepare("SELECT * FROM customers WHERE id=?").get(id);

const projectShape = (p) => p && {
  id: p.id, createdDate: p.createdDate, modifiedDate: p.modifiedDate,
  name: p.name, description: p.description, key: p.key, dueDate: p.dueDate,
  priority: p.priority, assignees: p.assignees, projectStatus: p.projectStatus,
  category: p.category || "client",
  assignedTo: userShape(getUser(p.assignedToId)),
  customerId: p.customerId ?? null, customer: customerShape(getCustomer(p.customerId)),
};
const getProject = (id) => db.prepare("SELECT * FROM projects WHERE id=?").get(id);

// every work item is a Task — Task/Issue/Bug and task points are retired
const taskShape = (s) => s && {
  id: s.id, createdDate: s.createdDate, modifiedDate: s.modifiedDate,
  name: s.name, number: s.number, tag: s.tag,
  description: s.description, dueDate: s.dueDate, priority: s.priority,
  status: s.status,
  assignedTo: userShape(getUser(s.assignedToId)),
  reporter: userShape(getUser(s.reporterId)),
  project: projectShape(getProject(s.projectId)),
};

const NOTIF_TYPES = ["added", "assigned", "status", "comment", "file"];
function canNotify(projectId, type, channel) {
  if (!projectId || !type) return true; // no context to check against — don't block
  const row = db.prepare("SELECT inApp, email FROM project_notification_settings WHERE projectId=? AND type=?").get(projectId, type);
  if (!row) return true; // no override row — default is enabled
  return channel === "email" ? !!row.email : !!row.inApp;
}
function notify(userId, actorId, text, taskId, ctx) {
  if (!userId || userId === actorId) return;
  if (ctx && !canNotify(ctx.projectId, ctx.type, "inApp")) return;
  db.prepare("INSERT INTO notifications (userId, text, taskId, createdDate) VALUES (?,?,?,?)")
    .run(userId, text, taskId ?? null, now());
}

// --- optional SMTP mailer (implicit TLS, port 465) --------------------------
// Configure via COREKIT_SMTP_HOST/PORT/USER/PASS/FROM. Without config,
// password-reset links are returned to the admin to share manually.
import { connect as tlsConnect } from "node:tls";

const SMTP = {
  host: process.env.COREKIT_SMTP_HOST,
  port: Number(process.env.COREKIT_SMTP_PORT || 465),
  user: process.env.COREKIT_SMTP_USER,
  pass: process.env.COREKIT_SMTP_PASS,
  from: process.env.COREKIT_SMTP_FROM || process.env.COREKIT_SMTP_USER,
};
const smtpConfigured = () => !!(SMTP.host && SMTP.user && SMTP.pass);

function sendMail(to, subject, text, html) {
  return new Promise((resolve) => {
    if (!smtpConfigured()) return resolve(false);
    const sock = tlsConnect({ host: SMTP.host, port: SMTP.port, servername: SMTP.host });
    // full RFC 5322 headers + multipart/alternative (plain + HTML) — missing
    // Date/Message-ID and HTML-only bodies are strong spam signals
    const fromDomain = String(SMTP.from).split("@")[1] || "corekit.me";
    const msgId = `<${Date.now()}.${randomBytes(9).toString("base64url")}@${fromDomain}>`;
    const date = new Date().toUTCString().replace(/GMT$/, "+0000");
    const plain = text || String(html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const boundary = `ck_${randomBytes(12).toString("hex")}`;
    const body = html
      ? `Content-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n` +
        `--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${plain}\r\n\r\n` +
        `--${boundary}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${html}\r\n\r\n--${boundary}--`
      : `Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${plain}`;
    const steps = [
      `EHLO ${fromDomain}`,
      `AUTH LOGIN`,
      Buffer.from(SMTP.user).toString("base64"),
      Buffer.from(SMTP.pass).toString("base64"),
      `MAIL FROM:<${SMTP.from}>`,
      `RCPT TO:<${to}>`,
      `DATA`,
      (`From: Trivyah Task Manager <${SMTP.from}>\r\nTo: <${to}>\r\nReply-To: ${SMTP.from}\r\nSubject: ${subject}\r\nDate: ${date}\r\nMessage-ID: ${msgId}\r\nMIME-Version: 1.0\r\n${body}`)
        .replace(/\r\n\./g, "\r\n..") + `\r\n.`,
    ];
    let i = 0, ok = false, buf = "";
    const done = () => { try { sock.destroy(); } catch {} resolve(ok); };
    sock.setTimeout(20_000, done);
    sock.on("error", done);
    sock.on("data", (d) => {
      buf += String(d);
      // a reply is complete when its final line is "NNN " (code + space)
      const m = /(^|\r\n)(\d{3})([ ])[^\r\n]*\r\n$/.exec(buf);
      if (!m) return;
      const code = Number(m[2]);
      buf = "";
      if (code >= 400) { console.error(`[smtp] step ${i} got ${code}`); return done(); }
      if (i === steps.length) { ok = true; sock.write("QUIT\r\n"); return done(); } // 250 after message body
      sock.write(steps[i++] + "\r\n");
    });
  });
}

function createResetToken(userId, hours = 1) {
  const token = randomBytes(24).toString("base64url");
  db.prepare("INSERT INTO password_resets (token,userId,expiresAt,createdDate) VALUES (?,?,?,?)")
    .run(token, userId, new Date(Date.now() + hours * 60 * 60_000).toISOString(), now());
  return token;
}
const PUBLIC_URL = process.env.COREKIT_PUBLIC_URL || "https://corekit.me";

// --- branded HTML email template (calm, table-based, inline styles — kept
// deliberately plain: heavy styling/caps/color blocks read as spammy to filters)
const escHtml = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function emailHtml({ heading, intro, rows = [], cta }) {
  const rowsHtml = rows.filter((r) => r && r[1] != null && r[1] !== "").map(([k, v]) => `
    <tr>
      <td style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#6e7075;padding:6px 14px 6px 0;white-space:nowrap;vertical-align:top">${escHtml(k)}</td>
      <td style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1a1a1a;padding:6px 0">${escHtml(v)}</td>
    </tr>`).join("");
  return `<!doctype html><html><body style="margin:0;padding:0;background-color:#ECEDF0">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#ECEDF0"><tr><td align="center" style="padding:32px 14px">
<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;max-width:520px">
  <tr><td style="padding:0 4px 18px">
    <span style="font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:bold;color:#1a1a1a">Trivyah <span style="color:#FF7A00">Task Manager</span></span>
  </td></tr>
  <tr><td style="background-color:#ffffff;border-radius:12px;padding:32px">
    <p style="font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:bold;color:#1a1a1a;margin:0 0 12px">${escHtml(heading)}</p>
    <p style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#3a3a3a;line-height:1.6;margin:0 0 4px">${intro}</p>
    ${rowsHtml ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:16px 0 4px;border-top:1px solid #eceef1">${rowsHtml}</table>` : ""}
    ${cta ? `<div style="margin-top:24px"><a href="${escHtml(cta.url)}" style="display:inline-block;background-color:#FF7A00;color:#ffffff;border-radius:8px;padding:12px 24px;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:bold;text-decoration:none">${escHtml(cta.label)}</a></div>` : ""}
  </td></tr>
  <tr><td style="padding:18px 6px 0;font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#8a8d93;line-height:1.5">
    Sent by Trivyah Task Manager (<a href="${PUBLIC_URL}" style="color:#8a8d93">${PUBLIC_URL.replace(/^https?:\/\//, "")}</a>) because you have an account on the team. If this wasn't expected, you can ignore this email.
  </td></tr>
</table></td></tr></table></body></html>`;
}

// fire-and-forget notification mail — never blocks the API response
function mailNotify(userId, { subject, heading, intro, rows, cta }, ctx) {
  if (!smtpConfigured()) return;
  if (ctx && !canNotify(ctx.projectId, ctx.type, "email")) return;
  const u = getUser(userId);
  if (!u || !u.email || !u.enabled) return;
  sendMail(u.email, subject, intro.replace(/<[^>]+>/g, ""), emailHtml({ heading, intro, rows, cta }))
    .catch((e) => console.error("[mail]", e.message));
}

function recordHistory(taskId, userId, field, oldValue, newValue) {
  db.prepare("INSERT INTO history (taskId,userId,field,oldValue,newValue,createdDate) VALUES (?,?,?,?,?,?)")
    .run(taskId, userId, field, oldValue == null ? null : String(oldValue), newValue == null ? null : String(newValue), now());
}

// --- effort analytics ---------------------------------------------------------
// All signals derive from the history table (status transitions with timestamps).
// Scoring is task-count based — task points are retired.
const EFFORT_RULES = {
  criticalReworks: 2,       // re-entered In Progress this many times → critical
  criticalDelayDays: 7,     // late by more than this → critical
  pointsPerDone: 1,         // one credit per finished task
  penaltyPerWeekLate: 1,    // dev loses 1 credit per week beyond the grace week
  maxDelayPenalty: 5,
  maxReworkPenalty: 3,
  onTimeBonus: 1,
};

function analyzeTask(s, historyRows) {
  const transitions = historyRows.filter((h) => h.field === "status");
  const inProgTimes = transitions.filter((h) => h.newValue === "In Progress").map((h) => new Date(h.createdDate));
  const doneRow = [...transitions].reverse().find((h) => h.newValue === "Done");
  const isDone = s.status === "Done";
  const doneAt = isDone ? new Date(doneRow ? doneRow.createdDate : s.modifiedDate) : null;
  const firstInProg = inProgTimes.length ? inProgTimes[0] : new Date(s.createdDate);
  const endRef = doneAt || new Date();
  const cycleDays = Math.max(0, Math.round((endRef - firstInProg) / 86400e3));
  const reworkCount = Math.max(0, inProgTimes.length - 1);
  const delayDays = s.dueDate ? Math.max(0, Math.floor((endRef - new Date(s.dueDate + "T23:59:59")) / 86400e3)) : 0;

  const criticalReasons = [];
  if (reworkCount >= EFFORT_RULES.criticalReworks) criticalReasons.push(`reopened ${reworkCount}×`);
  if (delayDays > EFFORT_RULES.criticalDelayDays) criticalReasons.push(`${isDone ? "finished" : "running"} ${delayDays} days late`);

  return { id: s.id, number: s.number, name: s.name, projectId: s.projectId,
    assignedToId: s.assignedToId, status: s.status, dueDate: s.dueDate,
    cycleDays, reworkCount, delayDays,
    critical: criticalReasons.length > 0, criticalReasons };
}

function computeAnalytics(user, projectId) {
  const vis = visibleProjectIds(user);
  let tasks = db.prepare(projectId ? "SELECT * FROM tasks WHERE projectId=?" : "SELECT * FROM tasks").all(...(projectId ? [Number(projectId)] : []));
  if (vis) tasks = tasks.filter((s) => vis.has(s.projectId));
  const hist = db.prepare("SELECT taskId, field, newValue, createdDate FROM history WHERE field='status'").all();
  const byTask = new Map();
  for (const h of hist) { if (!byTask.has(h.taskId)) byTask.set(h.taskId, []); byTask.get(h.taskId).push(h); }

  const analyzed = tasks.map((s) => analyzeTask(s, byTask.get(s.id) || []));

  const devs = new Map();
  for (const a of analyzed) {
    if (!a.assignedToId) continue;
    if (!devs.has(a.assignedToId)) {
      const u = getUser(a.assignedToId);
      devs.set(a.assignedToId, { userId: a.assignedToId, displayName: u?.displayName ?? "?",
        done: 0, onTime: 0, late: 0, reworked: 0, earned: 0, penalties: 0, score: 0 });
    }
    const d = devs.get(a.assignedToId);
    if (a.status === "Done") {
      d.done++;
      d.earned += EFFORT_RULES.pointsPerDone;
      if (a.delayDays === 0) { d.onTime++; d.earned += EFFORT_RULES.onTimeBonus; }
    }
    if (a.delayDays > EFFORT_RULES.criticalDelayDays) {
      d.late++;
      d.penalties += Math.min(EFFORT_RULES.maxDelayPenalty,
        Math.floor(a.delayDays / 7) * EFFORT_RULES.penaltyPerWeekLate);
    }
    if (a.reworkCount > 0) {
      d.reworked++;
      d.penalties += Math.min(EFFORT_RULES.maxReworkPenalty, a.reworkCount);
    }
    d.score = d.earned - d.penalties;
  }
  return { generatedAt: now(), tasks: analyzed,
    devs: [...devs.values()].sort((a, b) => b.score - a.score) };
}

// Role scoping: ADMIN and above see everything; teammates and leads see only
// projects they belong to (project assignee list / project owner) or where they
// have tasks. Returns null for "all", else a Set of project ids.
function visibleProjectIds(user) {
  if (atLeast(user, "ADMIN")) return null;
  const ids = new Set();
  for (const p of db.prepare("SELECT id, assignees, assignedToId FROM projects").all()) {
    const members = String(p.assignees || "").split(",").map(Number);
    if (p.assignedToId === user.id || members.includes(user.id)) ids.add(p.id);
  }
  for (const r of db.prepare("SELECT DISTINCT projectId pid FROM tasks WHERE assignedToId=? OR reporterId=?").all(user.id, user.id))
    ids.add(r.pid);
  return ids;
}

const isProjectMember = (p, user) =>
  p.assignedToId === user.id || String(p.assignees || "").split(",").map(Number).includes(user.id);

const canEditProject = (user, p) => atLeast(user, "ADMIN") || p.assignedToId === user.id ||
  (atLeast(user, "LEAD") && isProjectMember(p, user));
const PROJECT_EDIT_DENIED = "Only admins, the project owner, or a lead on this project can edit it";

function canSeeProject(user, projectId) {
  const vis = visibleProjectIds(user);
  return !vis || vis.has(Number(projectId));
}

// ---------------------------------------------------------------------------
// routes
const routes = [];
const route = (method, pattern, handler, opts = {}) =>
  routes.push({ method, re: new RegExp(`^${pattern}$`), handler, ...opts });

route("POST", "/api/auth/login", (req) => {
  const { username, password } = req.body || {};
  const key = `${clientIp(req)}|${String(username || "").toLowerCase()}`;
  if (loginBlocked(key)) return { status: 429, json: { error: "Too many attempts — try again in 15 minutes" } };
  const u = db.prepare("SELECT * FROM users WHERE username=? AND enabled=1").get(String(username || "").toLowerCase());
  if (!u || !verifyPassword(u, String(password || ""))) {
    loginFailed(key);
    return { status: 401, json: { error: "Bad credentials" } };
  }
  loginFailures.delete(key);
  const token = randomBytes(24).toString("base64url");
  db.prepare("INSERT INTO sessions (token, userId, createdAt, lastSeenAt) VALUES (?,?,?,?)").run(token, u.id, now(), now());
  db.prepare("UPDATE users SET lastLoginAt=? WHERE id=?").run(now(), u.id);
  return {
    json: { authenticated: true, ...userShape(u) },
    headers: { "Set-Cookie": `JSESSIONID=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_IDLE_DAYS * 86400}${SECURE_COOKIES ? "; Secure" : ""}` },
  };
}, { public: true });

route("GET", "/api/auth/status", (req) => ({
  json: req.user
    ? { authenticated: true, username: req.user.username, displayName: req.user.displayName, role: req.user.role }
    : { authenticated: false },
}), { public: true });

route("POST", "/api/auth/logout", (req) => {
  const token = sessionToken(req);
  if (token) db.prepare("DELETE FROM sessions WHERE token=?").run(token);
  return { json: { ok: true }, headers: { "Set-Cookie": `JSESSIONID=; Path=/; Max-Age=0${SECURE_COOKIES ? "; Secure" : ""}` } };
}, { public: true });

// --- password reset flow
route("POST", "/api/auth/forgot", async (req) => {
  const key = `forgot|${clientIp(req)}`;
  if (loginBlocked(key)) return { status: 429, json: { error: "Too many requests" } };
  loginFailed(key); // counts every request; 10 per 15 min per IP
  const q = String(req.body?.username || "").toLowerCase();
  const u = db.prepare("SELECT * FROM users WHERE (username=? OR email=?) AND enabled=1").get(q, q);
  if (u && smtpConfigured() && u.email) {
    const link = `${PUBLIC_URL}/#/reset/${createResetToken(u.id)}`;
    await sendMail(u.email, "Trivyah Task Manager password reset",
      `Reset your Trivyah Task Manager password (valid 1 hour): ${link}`,
      emailHtml({
        heading: "Password reset",
        intro: `Someone (hopefully you) asked to reset the password for <b>${escHtml(u.username)}</b>. The link below is valid for 1 hour and works once. If this wasn't you, just ignore this mail — nothing changes.`,
        cta: { label: "Reset password", url: link },
      }));
  }
  return { json: { ok: true } }; // same response either way — no account enumeration
}, { public: true });

route("POST", "/api/auth/reset", (req) => {
  const { token, password } = req.body || {};
  if (!token || !password || String(password).length < 1) return { status: 400, json: { error: "token and password required" } };
  const t = db.prepare("SELECT * FROM password_resets WHERE token=?").get(String(token));
  if (!t || t.used || new Date(t.expiresAt) < new Date()) return { status: 400, json: { error: "Link is invalid or expired — request a new one" } };
  const salt = randomBytes(16).toString("hex");
  db.prepare("UPDATE users SET passwordHash=?, salt=? WHERE id=?").run(hash(String(password), salt), salt, t.userId);
  db.prepare("UPDATE password_resets SET used=1 WHERE token=?").run(t.token);
  db.prepare("DELETE FROM sessions WHERE userId=?").run(t.userId); // log out everywhere
  return { json: { ok: true } };
}, { public: true });

route("POST", "/api/users/(\\d+)/reset-link", async (req, [id]) => {
  if (!atLeast(req.user, "SUPERADMIN")) return denied("SUPERADMIN");
  const u = getUser(id);
  if (!u) return { status: 404, json: { error: "not found" } };
  const link = `${PUBLIC_URL}/#/reset/${createResetToken(u.id)}`;
  let mailed = false;
  if (smtpConfigured() && u.email) {
    mailed = await sendMail(u.email, "Trivyah Task Manager password reset",
      `Set your Trivyah Task Manager password (valid 1 hour): ${link}`,
      emailHtml({
        heading: "Password reset",
        intro: `An admin generated a password reset for your account <b>${escHtml(u.username)}</b>. The link below is valid for 1 hour and works once.`,
        cta: { label: "Set new password", url: link },
      }));
  }
  return { json: { link, mailed, expiresInMinutes: 60 } };
});

// --- RBAC: which roles can see which top-level nav pages/sections.
// This is a UI-organization layer, not a data security boundary — project data
// access is still governed entirely by visibleProjectIds()/canSeeProject().
const RBAC_PAGES = ["dashboard", "tasks", "command", "clients", "internal", "customers", "team"];
const accessMap = () => Object.fromEntries(db.prepare("SELECT * FROM page_access").all()
  .map((r) => [r.page, r.roles.split(",").filter(Boolean)]));
route("GET", "/api/rbac", () => ({ json: accessMap() }));
route("PUT", "/api/rbac", (req) => {
  if (!atLeast(req.user, "ADMIN")) return denied("ADMIN");
  const body = req.body || {};
  // you may only grant or revoke access for roles you outrank — an admin can
  // neither add nor remove a superadmin (or any superadmin-based role), so
  // whatever those roles already had is carried over untouched.
  const mine = (r) => rankOf(r) <= rankOf(req.user.role);
  const current = accessMap();
  const upsert = db.prepare("INSERT INTO page_access (page, roles) VALUES (?,?) ON CONFLICT(page) DO UPDATE SET roles=excluded.roles");
  for (const page of RBAC_PAGES) {
    if (!(page in body)) continue;
    const roles = new Set((Array.isArray(body[page]) ? body[page] : [])
      .filter((r) => roleNames().includes(r) && mine(r)));
    for (const r of current[page] || []) if (!mine(r)) roles.add(r);
    roles.add("SUPERADMIN"); // superadmins can never be locked out of a page
    upsert.run(page, [...roles].join(","));
  }
  return { json: accessMap() };
});

// --- roles: the four built-in rungs plus any custom role, which inherits the
// rank of the rung it is based on. You can only create or edit a role you
// outrank, so an admin can never mint a superadmin-equivalent.
const ROLE_NAME_RE = /^[A-Z][A-Z0-9_]{1,23}$/;
route("GET", "/api/roles", () => {
  const counts = new Map();
  for (const u of db.prepare("SELECT role, enabled FROM users").all()) {
    const c = counts.get(u.role) || { total: 0, active: 0 };
    c.total++; if (u.enabled) c.active++;
    counts.set(u.role, c);
  }
  const access = accessMap();
  return { json: roleDefs().map((r) => ({
    ...r,
    userCount: counts.get(r.role)?.total || 0,
    activeCount: counts.get(r.role)?.active || 0,
    pages: r.role === "SUPERADMIN" ? RBAC_PAGES : RBAC_PAGES.filter((p) => (access[p] || []).includes(r.role)),
  })) };
});

route("POST", "/api/roles", (req) => {
  if (!atLeast(req.user, "ADMIN")) return denied("ADMIN");
  const b = req.body || {};
  const name = String(b.name || "").trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  const label = String(b.label || "").trim();
  const baseRole = String(b.baseRole || "");
  if (!ROLE_NAME_RE.test(name)) return { status: 400, json: { error: "Name must be 2–24 characters, letters/numbers/underscore, starting with a letter" } };
  if (!label) return { status: 400, json: { error: "label required" } };
  if (!BUILTIN_ROLES.includes(baseRole)) return { status: 400, json: { error: "baseRole must be one of the built-in roles" } };
  if (rankOf(baseRole) > rankOf(req.user.role)) return { status: 403, json: { error: `You can't base a role on ${baseRole.toLowerCase()} — it outranks you` } };
  if (roleNames().includes(name)) return { status: 409, json: { error: "a role with that name already exists" } };
  db.prepare("INSERT INTO custom_roles (name,label,baseRole,createdDate) VALUES (?,?,?,?)").run(name, label, baseRole, now());
  invalidateRoles();
  // start it with the same page access as the rung it's based on, so a new role
  // isn't born unable to open anything
  const access = accessMap();
  const upsert = db.prepare("INSERT INTO page_access (page, roles) VALUES (?,?) ON CONFLICT(page) DO UPDATE SET roles=excluded.roles");
  for (const page of RBAC_PAGES) {
    const roles = new Set(access[page] || []);
    if (baseRole === "SUPERADMIN" || roles.has(baseRole)) { roles.add(name); upsert.run(page, [...roles].join(",")); }
  }
  return { json: roleDefs().find((r) => r.role === name) };
});

route("PUT", "/api/roles/([A-Z0-9_]+)", (req, [name]) => {
  if (!atLeast(req.user, "ADMIN")) return denied("ADMIN");
  const def = roleDefs().find((r) => r.role === name);
  if (!def) return { status: 404, json: { error: "not found" } };
  if (def.builtin) return { status: 400, json: { error: "The built-in roles can't be edited — create a custom role instead" } };
  if (rankOf(def.role) > rankOf(req.user.role)) return { status: 403, json: { error: "That role outranks you" } };
  const b = req.body || {};
  const label = b.label !== undefined ? String(b.label).trim() : def.label;
  const baseRole = b.baseRole !== undefined ? String(b.baseRole) : def.baseRole;
  if (!label) return { status: 400, json: { error: "label required" } };
  if (!BUILTIN_ROLES.includes(baseRole)) return { status: 400, json: { error: "baseRole must be one of the built-in roles" } };
  if (rankOf(baseRole) > rankOf(req.user.role)) return { status: 403, json: { error: `You can't base a role on ${baseRole.toLowerCase()} — it outranks you` } };
  db.prepare("UPDATE custom_roles SET label=?, baseRole=? WHERE name=?").run(label, baseRole, name);
  invalidateRoles();
  return { json: roleDefs().find((r) => r.role === name) };
});

route("DELETE", "/api/roles/([A-Z0-9_]+)", (req, [name]) => {
  if (!atLeast(req.user, "ADMIN")) return denied("ADMIN");
  const def = roleDefs().find((r) => r.role === name);
  if (!def) return { status: 404, json: { error: "not found" } };
  if (def.builtin) return { status: 400, json: { error: "The built-in roles can't be deleted" } };
  if (rankOf(def.role) > rankOf(req.user.role)) return { status: 403, json: { error: "That role outranks you" } };
  const held = db.prepare("SELECT COUNT(*) c FROM users WHERE role=?").get(name).c;
  if (held) return { status: 409, json: { error: `${held} user(s) still have this role — move them to another role first` } };
  db.prepare("DELETE FROM custom_roles WHERE name=?").run(name);
  invalidateRoles();
  // drop it out of every page's access list
  const upsert = db.prepare("UPDATE page_access SET roles=? WHERE page=?");
  for (const [page, roles] of Object.entries(accessMap())) {
    const kept = roles.filter((r) => r !== name);
    if (kept.length !== roles.length) upsert.run(kept.join(","), page);
  }
  return { json: { deleted: true, role: name } };
});

// --- users
route("GET", "/api/users", () =>
  ({ json: db.prepare("SELECT * FROM users ORDER BY displayName").all().map(userShape) }));

route("POST", "/api/users", async (req) => {
  if (!atLeast(req.user, "ADMIN")) return denied("ADMIN");
  const { username, displayName, role, password, email } = req.body || {};
  if (!username || !displayName) return { status: 400, json: { error: "username and displayName required" } };
  if (role && !roleNames().includes(role)) return { status: 400, json: { error: "unknown role" } };
  if (role && rankOf(role) > rankOf(req.user.role)) return { status: 403, json: { error: `You can't grant the ${role.toLowerCase()} role` } };
  if (password && !atLeast(req.user, "SUPERADMIN")) return { status: 403, json: { error: "Only a superadmin can set a password directly — leave it blank to send an invite" } };
  if (db.prepare("SELECT 1 FROM users WHERE username=?").get(String(username).toLowerCase()))
    return { status: 409, json: { error: "username already exists" } };
  // no password given → invite flow: unknown random password + a 72h set-password link
  const u = createUser({ username, displayName, role, email, password: password || randomBytes(18).toString("base64url") });
  let inviteLink = null, mailed = false;
  if (!password) {
    inviteLink = `${PUBLIC_URL}/#/reset/${createResetToken(u.id, 72)}`;
    if (smtpConfigured() && u.email) {
      mailed = await sendMail(u.email, "You've been added to Trivyah Task Manager",
        `${req.user.displayName} added you to Trivyah Task Manager. Set your password: ${inviteLink}`,
        emailHtml({
          heading: "Welcome to the team",
          intro: `<b>${escHtml(req.user.displayName)}</b> added you to Trivyah Task Manager — projects, tasks and boards for Trivyah Tech. Set your password to get started (the link is valid for 72 hours).`,
          rows: [["Your username", u.username], ["Role", u.role]],
          cta: { label: "Set your password", url: inviteLink },
        }));
    }
  }
  return { json: { ...userShape(u), inviteLink, mailed } };
});

route("PUT", "/api/users/(\\d+)", (req, [id]) => {
  const self = req.user.id === Number(id);
  if (!self && !atLeast(req.user, "ADMIN")) return denied("ADMIN");
  const u = getUser(id);
  if (!u) return { status: 404, json: { error: "not found" } };
  // nobody edits an account that outranks them
  if (!self && rankOf(u.role) > rankOf(req.user.role))
    return { status: 403, json: { error: `You can't edit a ${u.role.toLowerCase()} account` } };
  const b = req.body || {};
  if (b.password) {
    // setting someone else's password is a superadmin power; your own is yours
    if (!self && !atLeast(req.user, "SUPERADMIN")) return denied("SUPERADMIN");
    const salt = randomBytes(16).toString("hex");
    db.prepare("UPDATE users SET passwordHash=?, salt=? WHERE id=?").run(hash(String(b.password), salt), salt, u.id);
  }
  if (atLeast(req.user, "ADMIN")) {
    // and nobody hands out a role above their own
    let role = b.role ?? u.role;
    if (!roleNames().includes(role)) role = u.role;
    if (rankOf(role) > rankOf(req.user.role)) return { status: 403, json: { error: `You can't grant the ${role.toLowerCase()} role` } };
    db.prepare("UPDATE users SET displayName=?, role=?, enabled=?, email=? WHERE id=?")
      .run(b.displayName ?? u.displayName, role, b.enabled != null ? (b.enabled ? 1 : 0) : u.enabled,
        b.email !== undefined ? (b.email ? String(b.email).trim().toLowerCase() : null) : u.email, u.id);
  }
  return { json: userShape(getUser(u.id)) };
});

route("DELETE", "/api/users/(\\d+)", (req, [id]) => {
  if (!atLeast(req.user, "SUPERADMIN")) return denied("SUPERADMIN");
  const u = getUser(id);
  if (!u) return { status: 404, json: { error: "not found" } };
  if (u.id === req.user.id) return { status: 400, json: { error: "You can't delete your own account" } };
  const activity =
    db.prepare("SELECT COUNT(*) c FROM tasks WHERE assignedToId=? OR reporterId=?").get(u.id, u.id).c +
    db.prepare("SELECT COUNT(*) c FROM comments WHERE userId=?").get(u.id).c +
    db.prepare("SELECT COUNT(*) c FROM attachments WHERE uploadedById=?").get(u.id).c;
  if (activity) return { status: 409, json: { error: `User has ${activity} linked records (tasks/comments/files) — disable the account instead, or reassign their work first` } };
  db.prepare("UPDATE history SET userId=NULL WHERE userId=?").run(u.id);
  db.prepare("DELETE FROM users WHERE id=?").run(u.id); // sessions/notifications/resets cascade
  return { json: { deleted: true, id: u.id } };
});

// --- customers (one per client — client projects must attach one; the
// customerNumber is what disambiguates two customers sharing a display name)
route("GET", "/api/customers", () => {
  const rows = db.prepare("SELECT * FROM customers ORDER BY name").all();
  const counts = new Map();
  for (const p of db.prepare("SELECT customerId FROM projects WHERE customerId IS NOT NULL").all())
    counts.set(p.customerId, (counts.get(p.customerId) || 0) + 1);
  return { json: rows.map((c) => ({ ...customerShape(c), projectCount: counts.get(c.id) || 0 })) };
});

route("POST", "/api/customers", (req) => {
  if (!atLeast(req.user, "LEAD")) return denied("LEAD");
  const b = req.body || {};
  if (!b.name) return { status: 400, json: { error: "name required" } };
  const num = nextCustomerNumber();
  const r = db.prepare("INSERT INTO customers (customerNumber,name,contactName,phone,email,address,notes,createdDate,modifiedDate) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(num, b.name, b.contactName || null, b.phone || null, b.email || null, b.address || null, b.notes || null, now(), now());
  return { json: customerShape(getCustomer(r.lastInsertRowid)) };
});

route("PUT", "/api/customers/(\\d+)", (req, [id]) => {
  if (!atLeast(req.user, "LEAD")) return denied("LEAD");
  const c = getCustomer(id);
  if (!c) return { status: 404, json: { error: "not found" } };
  const b = req.body || {};
  db.prepare("UPDATE customers SET name=?, contactName=?, phone=?, email=?, address=?, notes=?, modifiedDate=? WHERE id=?")
    .run(b.name ?? c.name, b.contactName !== undefined ? b.contactName : c.contactName,
      b.phone !== undefined ? b.phone : c.phone, b.email !== undefined ? b.email : c.email,
      b.address !== undefined ? b.address : c.address, b.notes !== undefined ? b.notes : c.notes, now(), c.id);
  return { json: customerShape(getCustomer(c.id)) };
});

route("DELETE", "/api/customers/(\\d+)", (req, [id]) => {
  if (!atLeast(req.user, "ADMIN")) return denied("ADMIN");
  const c = getCustomer(id);
  if (!c) return { status: 404, json: { error: "not found" } };
  const linked = db.prepare("SELECT COUNT(*) n FROM projects WHERE customerId=?").get(c.id).n;
  if (linked) return { status: 409, json: { error: `${linked} project(s) still use this customer — reassign them first` } };
  const filesDeleted = deleteScopeFiles("customer", c.id);
  db.prepare("DELETE FROM customers WHERE id=?").run(c.id);
  return { json: { deleted: true, filesDeleted } };
});

// --- projects
route("GET", "/api/projects", (req) => {
  const vis = visibleProjectIds(req.user);
  const all = db.prepare("SELECT * FROM projects ORDER BY modifiedDate DESC").all();
  return { json: (vis ? all.filter((p) => vis.has(p.id)) : all).map(projectShape) };
});

route("POST", "/api/projects", (req) => {
  if (!atLeast(req.user, "LEAD")) return denied("LEAD");
  const b = req.body || {};
  if (!b.name || !b.key) return { status: 400, json: { error: "name and key required" } };
  const category = normCategory(b.category);
  if (category === "client" && !b.customerId) return { status: 400, json: { error: "A client project must have a customer attached" } };
  if (b.customerId && !getCustomer(Number(b.customerId))) return { status: 400, json: { error: "customer not found" } };
  const key = String(b.key).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
  if (db.prepare("SELECT 1 FROM projects WHERE key=?").get(key)) return { status: 409, json: { error: "key already exists" } };
  const r = db.prepare(`INSERT INTO projects (key,name,description,priority,projectStatus,dueDate,assignees,assignedToId,createdDate,modifiedDate,category,customerId)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(key, b.name, b.description || "", b.priority || "Medium", b.projectStatus || "Active",
      b.dueDate ?? null, b.assignees || String(req.user.id), b.assignedTo?.id ?? req.user.id, now(), now(),
      category, b.customerId ? Number(b.customerId) : null);
  return { json: projectShape(getProject(r.lastInsertRowid)) };
});

route("PUT", "/api/projects/(\\d+)", (req, [id]) => {
  const p = getProject(id);
  if (!p) return { status: 404, json: { error: "not found" } };
  if (!canEditProject(req.user, p)) return { status: 403, json: { error: PROJECT_EDIT_DENIED } };
  const b = req.body || {};
  const category = b.category !== undefined ? normCategory(b.category) : (p.category || "client");
  const customerId = b.customerId !== undefined ? (b.customerId ? Number(b.customerId) : null) : p.customerId;
  if (category === "client" && !customerId) return { status: 400, json: { error: "A client project must have a customer attached" } };
  if (customerId && !getCustomer(customerId)) return { status: 400, json: { error: "customer not found" } };
  db.prepare(`UPDATE projects SET name=?, description=?, priority=?, projectStatus=?, dueDate=?, assignees=?, assignedToId=?, modifiedDate=?, category=?, customerId=? WHERE id=?`)
    .run(b.name ?? p.name, b.description ?? p.description, b.priority ?? p.priority,
      b.projectStatus ?? p.projectStatus, b.dueDate !== undefined ? b.dueDate : p.dueDate,
      b.assignees ?? p.assignees, b.assignedTo?.id ?? p.assignedToId, now(),
      category, customerId, p.id);
  // notify people newly added to the project
  if (b.assignees !== undefined) {
    const before = new Set(String(p.assignees || "").split(",").map(Number).filter(Boolean));
    for (const uid of String(b.assignees || "").split(",").map(Number).filter(Boolean)) {
      if (before.has(uid)) continue;
      notify(uid, req.user.id, `You were added to project ${p.key} — ${p.name}`, null, { projectId: p.id, type: "added" });
      if (uid !== req.user.id) mailNotify(uid, {
        subject: `You were added to ${p.key} — ${b.name ?? p.name}`,
        heading: "Added to project",
        intro: `<b>${escHtml(req.user.displayName)}</b> added you to <b>${escHtml(b.name ?? p.name)}</b>. You can now see its board and tasks.`,
        rows: [["Project", `${p.key} — ${b.name ?? p.name}`], ["Priority", b.priority ?? p.priority], ["Due", b.dueDate !== undefined ? b.dueDate : p.dueDate]],
        cta: { label: "Open board", url: `${PUBLIC_URL}/#/board/${p.id}` },
      }, { projectId: p.id, type: "added" });
    }
  }
  return { json: projectShape(getProject(p.id)) };
});

// --- per-project notification settings (in-app + email, per notification type)
const notifSettings = (projectId) => {
  const byType = new Map(db.prepare("SELECT type,inApp,email FROM project_notification_settings WHERE projectId=?")
    .all(projectId).map((r) => [r.type, r]));
  return NOTIF_TYPES.map((type) => ({
    type, inApp: byType.has(type) ? !!byType.get(type).inApp : true, email: byType.has(type) ? !!byType.get(type).email : true,
  }));
};

route("GET", "/api/projects/(\\d+)/notifications", (req, [id]) => {
  const p = getProject(id);
  if (!p || !canSeeProject(req.user, p.id)) return { status: 404, json: { error: "not found" } };
  return { json: notifSettings(p.id) };
});

route("PUT", "/api/projects/(\\d+)/notifications", (req, [id]) => {
  const p = getProject(id);
  if (!p) return { status: 404, json: { error: "not found" } };
  if (!canEditProject(req.user, p)) return { status: 403, json: { error: PROJECT_EDIT_DENIED } };
  const b = req.body || {};
  const upsert = db.prepare(`INSERT INTO project_notification_settings (projectId,type,inApp,email) VALUES (?,?,?,?)
    ON CONFLICT(projectId,type) DO UPDATE SET inApp=excluded.inApp, email=excluded.email`);
  for (const type of NOTIF_TYPES) {
    if (!(type in b)) continue;
    upsert.run(p.id, type, b[type].inApp !== false ? 1 : 0, b[type].email !== false ? 1 : 0);
  }
  return { json: notifSettings(p.id) };
});

route("DELETE", "/api/projects/(\\d+)", (req, [id]) => {
  const p = getProject(id);
  if (!p) return { status: 404, json: { error: "not found" } };
  if (!atLeast(req.user, "ADMIN"))
    return { status: 403, json: { error: "Only admins can delete a project" } };
  const hasTasks = db.prepare("SELECT COUNT(*) c FROM tasks WHERE projectId=?").get(id).c;
  // admin cascade: remove attachment files from disk, then tasks (comments/
  // history/attachments cascade via FK), then the project
  for (const a of db.prepare("SELECT a.path FROM attachments a JOIN tasks s ON s.id=a.taskId WHERE s.projectId=?").all(id)) {
    try { unlinkSync(join(FILES_DIR, a.path)); } catch {}
  }
  const filesDeleted = deleteScopeFiles("project", id);
  db.prepare("DELETE FROM tasks WHERE projectId=?").run(id);
  db.prepare("DELETE FROM projects WHERE id=?").run(id);
  return { json: { deleted: true, tasksDeleted: hasTasks, filesDeleted } };
});

// --- tasks
route("GET", "/api/tasks", (req) => {
  const q = req.query;
  const vis = visibleProjectIds(req.user);
  let sql = "SELECT * FROM tasks WHERE 1=1"; const args = [];
  if (q.projectId) {
    if (vis && !vis.has(Number(q.projectId))) return { json: [] };
    sql += " AND projectId=?"; args.push(Number(q.projectId));
  }
  sql += " ORDER BY seq DESC";
  let rows = db.prepare(sql).all(...args);
  if (!q.projectId && vis) rows = rows.filter((s) => vis.has(s.projectId));
  return { json: rows.map(taskShape) };
});

route("GET", "/api/tasks/(\\d+)", (req, [id]) => {
  const s = db.prepare("SELECT * FROM tasks WHERE id=?").get(id);
  if (!s || !canSeeProject(req.user, s.projectId)) return { status: 404, json: { error: "not found" } };
  return { json: taskShape(s) };
});

route("POST", "/api/tasks", (req) => {
  if (!atLeast(req.user, "LEAD")) return { status: 403, json: { error: "Teammates can't create tasks — ask your lead" } };
  const b = req.body || {};
  const p = b.project?.id && getProject(b.project.id);
  if (!b.name || !p) return { status: 400, json: { error: "name and project.id required" } };
  if (!canSeeProject(req.user, p.id)) return { status: 403, json: { error: "You're not on this project" } };
  const seq = (db.prepare("SELECT COALESCE(MAX(seq),0) m FROM tasks WHERE projectId=?").get(p.id).m) + 1;
  const assignee = b.assignedTo?.id ?? req.user.id;
  const r = db.prepare(`INSERT INTO tasks (projectId,seq,number,name,description,tag,type,priority,status,dueDate,assignedToId,reporterId,createdDate,modifiedDate)
    VALUES (?,?,?,?,?,?,'Task',?,?,?,?,?,?,?)`)
    .run(p.id, seq, `${p.key}-${seq}`, b.name, b.description || "", b.tag || "",
      b.priority || "Medium", b.status || "To Do",
      b.dueDate ?? null, assignee, req.user.id, now(), now()); // reporter is always the creator
  const s = db.prepare("SELECT * FROM tasks WHERE id=?").get(r.lastInsertRowid);
  notify(assignee, req.user.id, `${s.number} "${s.name}" assigned to you`, s.id, { projectId: p.id, type: "assigned" });
  if (assignee !== req.user.id) mailNotify(assignee, {
    subject: `[${s.number}] assigned to you — ${s.name}`,
    heading: "New assignment",
    intro: `<b>${escHtml(req.user.displayName)}</b> assigned you a task in <b>${escHtml(p.name)}</b>.`,
    rows: [["Task", `${s.number} — ${s.name}`], ["Priority", s.priority], ["Due", s.dueDate], ["Tag", s.tag]],
    cta: { label: "Open board", url: `${PUBLIC_URL}/#/board/${p.id}` },
  }, { projectId: p.id, type: "assigned" });
  recordHistory(s.id, req.user.id, "created", null, s.number);
  return { json: taskShape(s) };
});

route("PUT", "/api/tasks/(\\d+)", (req, [id]) => {
  const s = db.prepare("SELECT * FROM tasks WHERE id=?").get(id);
  if (!s || !canSeeProject(req.user, s.projectId)) return { status: 404, json: { error: "not found" } };
  const b = req.body || {};
  const newAssignee = b.assignedTo?.id !== undefined ? b.assignedTo.id : s.assignedToId;
  const newStatus = b.status ?? s.status;
  // teammates work their tasks but don't hand them out — assigning is a lead job
  if (newAssignee !== s.assignedToId && !atLeast(req.user, "LEAD"))
    return { status: 403, json: { error: "Teammates can't reassign a task — ask your lead" } };
  // reporterId is immutable — always whoever created the task
  db.prepare(`UPDATE tasks SET name=?, description=?, tag=?, priority=?, status=?, dueDate=?, assignedToId=?, modifiedDate=? WHERE id=?`)
    .run(b.name ?? s.name, b.description ?? s.description, b.tag ?? s.tag,
      b.priority ?? s.priority,
      newStatus, b.dueDate !== undefined ? b.dueDate : s.dueDate,
      newAssignee, now(), s.id);
  const taskCta = { label: "Open board", url: `${PUBLIC_URL}/#/board/${s.projectId}` };
  if (newAssignee !== s.assignedToId) {
    notify(newAssignee, req.user.id, `${s.number} "${s.name}" assigned to you`, s.id, { projectId: s.projectId, type: "assigned" });
    if (newAssignee !== req.user.id) mailNotify(newAssignee, {
      subject: `[${s.number}] assigned to you — ${s.name}`,
      heading: "New assignment",
      intro: `<b>${escHtml(req.user.displayName)}</b> reassigned this item to you.`,
      rows: [["Task", `${s.number} — ${b.name ?? s.name}`], ["Status", newStatus], ["Priority", b.priority ?? s.priority], ["Due", b.dueDate !== undefined ? b.dueDate : s.dueDate]],
      cta: taskCta,
    }, { projectId: s.projectId, type: "assigned" });
  }
  if (newStatus !== s.status) {
    const moveMail = (uid) => uid !== req.user.id && mailNotify(uid, {
      subject: `[${s.number}] moved to ${newStatus}`,
      heading: "Status change",
      intro: `<b>${escHtml(req.user.displayName)}</b> moved <b>${escHtml(s.number)} — ${escHtml(s.name)}</b>.`,
      rows: [["From", s.status], ["To", newStatus]],
      cta: taskCta,
    }, { projectId: s.projectId, type: "status" });
    notify(s.reporterId, req.user.id, `${s.number} moved to ${newStatus}`, s.id, { projectId: s.projectId, type: "status" });
    moveMail(s.reporterId);
    if (s.assignedToId !== s.reporterId) {
      notify(s.assignedToId, req.user.id, `${s.number} moved to ${newStatus}`, s.id, { projectId: s.projectId, type: "status" });
      moveMail(s.assignedToId);
    }
  }
  // audit trail: one row per changed field
  const uname = (id) => getUser(id)?.displayName ?? "—";
  const after = db.prepare("SELECT * FROM tasks WHERE id=?").get(s.id);
  for (const f of ["name", "tag", "priority", "status", "dueDate"]) {
    if (String(s[f] ?? "") !== String(after[f] ?? "")) recordHistory(s.id, req.user.id, f, s[f], after[f]);
  }
  if (String(s.description ?? "") !== String(after.description ?? "")) recordHistory(s.id, req.user.id, "description", null, "updated");
  if (s.assignedToId !== after.assignedToId) recordHistory(s.id, req.user.id, "assignedTo", uname(s.assignedToId), uname(after.assignedToId));
  return { json: taskShape(db.prepare("SELECT * FROM tasks WHERE id=?").get(s.id)) };
});

route("DELETE", "/api/tasks/(\\d+)", (req, [id]) => {
  const s = db.prepare("SELECT * FROM tasks WHERE id=?").get(Number(id));
  if (!s || !canSeeProject(req.user, s.projectId)) return { status: 404, json: { error: "not found" } };
  if (!atLeast(req.user, "ADMIN"))
    return { status: 403, json: { error: "Only admins can delete a task" } };
  for (const a of db.prepare("SELECT path FROM attachments WHERE taskId=?").all(Number(id))) {
    try { unlinkSync(join(FILES_DIR, a.path)); } catch {}
  }
  db.prepare("DELETE FROM tasks WHERE id=?").run(id);
  return { json: { deleted: true, id: Number(id) } };
});

// --- comments (text + optional image, e.g. pasted screenshots)
const commentShape = (c) => ({
  id: c.id, taskId: c.taskId, text: c.text, createdDate: c.createdDate,
  user: userShape(getUser(c.userId)),
  imageUrl: c.imagePath ? `/api/comments/${c.id}/image` : null,
});

route("GET", "/api/comments", (req) => {
  const s = db.prepare("SELECT projectId FROM tasks WHERE id=?").get(Number(req.query.taskId || 0));
  if (!s || !canSeeProject(req.user, s.projectId)) return { json: [] };
  return { json: db.prepare("SELECT * FROM comments WHERE taskId=? ORDER BY createdDate").all(Number(req.query.taskId)).map(commentShape) };
});

route("POST", "/api/comments", (req) => {
  const { taskId, text, imageBase64, imageMime } = req.body || {};
  if (!taskId || (!text && !imageBase64)) return { status: 400, json: { error: "taskId and text or image required" } };
  const s = db.prepare("SELECT * FROM tasks WHERE id=?").get(Number(taskId));
  if (!s || !canSeeProject(req.user, s.projectId)) return { status: 404, json: { error: "task not found" } };
  let imagePath = null;
  if (imageBase64) {
    const buf = Buffer.from(imageBase64, "base64");
    if (buf.length > 10 * 1024 * 1024) return { status: 413, json: { error: "image max 10 MB" } };
    if (!existsSync(FILES_DIR)) mkdirSync(FILES_DIR, { recursive: true });
    imagePath = `c${Date.now()}_${randomBytes(4).toString("hex")}.img`;
    writeFileSync(join(FILES_DIR, imagePath), buf);
  }
  const r = db.prepare("INSERT INTO comments (taskId,userId,text,createdDate,imagePath,imageMime) VALUES (?,?,?,?,?,?)")
    .run(s.id, req.user.id, String(text || ""), now(), imagePath, imageMime || "image/png");
  const commentMail = (uid) => uid !== req.user.id && mailNotify(uid, {
    subject: `[${s.number}] new comment from ${req.user.displayName}`,
    heading: "New comment",
    intro: `<b>${escHtml(req.user.displayName)}</b> commented on <b>${escHtml(s.number)} — ${escHtml(s.name)}</b>:<br><br><i>&ldquo;${escHtml(String(text || "").slice(0, 300))}${String(text || "").length > 300 ? "…" : ""}&rdquo;</i>${imagePath ? "<br><br>📎 includes an image" : ""}`,
    cta: { label: "Open board", url: `${PUBLIC_URL}/#/board/${s.projectId}` },
  }, { projectId: s.projectId, type: "comment" });
  notify(s.assignedToId, req.user.id, `${req.user.displayName} commented on ${s.number}`, s.id, { projectId: s.projectId, type: "comment" });
  commentMail(s.assignedToId);
  if (s.reporterId !== s.assignedToId) {
    notify(s.reporterId, req.user.id, `${req.user.displayName} commented on ${s.number}`, s.id, { projectId: s.projectId, type: "comment" });
    commentMail(s.reporterId);
  }
  return { json: commentShape(db.prepare("SELECT * FROM comments WHERE id=?").get(r.lastInsertRowid)) };
});

route("GET", "/api/comments/(\\d+)/image", (req, [id]) => {
  const c = db.prepare("SELECT * FROM comments WHERE id=?").get(Number(id));
  if (!c || !c.imagePath) return { status: 404, json: { error: "not found" } };
  const s = db.prepare("SELECT projectId FROM tasks WHERE id=?").get(c.taskId);
  if (!s || !canSeeProject(req.user, s.projectId)) return { status: 404, json: { error: "not found" } };
  return { raw: readFileSync(join(FILES_DIR, c.imagePath)), headers: { "Content-Type": c.imageMime || "image/png" } };
});

// --- task history (audit trail)
route("GET", "/api/history", (req) => {
  const s = db.prepare("SELECT projectId FROM tasks WHERE id=?").get(Number(req.query.taskId || 0));
  if (!s || !canSeeProject(req.user, s.projectId)) return { json: [] };
  return { json: db.prepare("SELECT * FROM history WHERE taskId=? ORDER BY createdDate DESC, id DESC").all(Number(req.query.taskId))
    .map((h) => ({ id: h.id, field: h.field, oldValue: h.oldValue, newValue: h.newValue,
      createdDate: h.createdDate, user: userShape(getUser(h.userId)) })) };
});

// --- attachments (JSON+base64 upload keeps the server dependency-free)
const FILES_DIR = join(ROOT, "data", "files");
const attachShape = (a) => ({
  id: a.id, taskId: a.taskId, filename: a.filename, mime: a.mime, size: a.size,
  createdDate: a.createdDate, uploadedBy: userShape(getUser(a.uploadedById)),
  url: `/api/files/${a.id}/download`,
});

route("GET", "/api/files", (req) => {
  const s = db.prepare("SELECT projectId FROM tasks WHERE id=?").get(Number(req.query.taskId || 0));
  if (!s || !canSeeProject(req.user, s.projectId)) return { json: [] };
  return { json: db.prepare("SELECT * FROM attachments WHERE taskId=? ORDER BY createdDate").all(Number(req.query.taskId)).map(attachShape) };
});

route("POST", "/api/files", (req) => {
  const { taskId, filename, dataBase64, mime } = req.body || {};
  if (!taskId || !filename || !dataBase64) return { status: 400, json: { error: "taskId, filename, dataBase64 required" } };
  const s = db.prepare("SELECT * FROM tasks WHERE id=?").get(Number(taskId));
  if (!s || !canSeeProject(req.user, s.projectId)) return { status: 404, json: { error: "task not found" } };
  const buf = Buffer.from(dataBase64, "base64");
  if (buf.length > 25 * 1024 * 1024) return { status: 413, json: { error: "max 25 MB" } };
  const safe = String(filename).replace(/[^\w.() -]/g, "_").slice(-120);
  if (!existsSync(FILES_DIR)) mkdirSync(FILES_DIR, { recursive: true });
  const rel = `${Date.now()}_${safe}`;
  writeFileSync(join(FILES_DIR, rel), buf);
  const r = db.prepare("INSERT INTO attachments (taskId,filename,mime,size,path,uploadedById,createdDate) VALUES (?,?,?,?,?,?,?)")
    .run(s.id, safe, mime || "application/octet-stream", buf.length, rel, req.user.id, now());
  notify(s.assignedToId, req.user.id, `${req.user.displayName} attached "${safe}" to ${s.number}`, s.id, { projectId: s.projectId, type: "file" });
  if (s.assignedToId !== req.user.id) mailNotify(s.assignedToId, {
    subject: `[${s.number}] file attached — ${safe}`,
    heading: "New attachment",
    intro: `<b>${escHtml(req.user.displayName)}</b> attached a file to <b>${escHtml(s.number)} — ${escHtml(s.name)}</b>.`,
    rows: [["File", safe], ["Size", `${Math.max(1, Math.round(buf.length / 1024))} KB`]],
    cta: { label: "Open board", url: `${PUBLIC_URL}/#/board/${s.projectId}` },
  }, { projectId: s.projectId, type: "file" });
  return { json: attachShape(db.prepare("SELECT * FROM attachments WHERE id=?").get(r.lastInsertRowid)) };
});

route("GET", "/api/files/(\\d+)/download", (req, [id], res) => {
  const a = db.prepare("SELECT * FROM attachments WHERE id=?").get(Number(id));
  if (!a) return { status: 404, json: { error: "not found" } };
  const s = db.prepare("SELECT projectId FROM tasks WHERE id=?").get(a.taskId);
  if (!s || !canSeeProject(req.user, s.projectId)) return { status: 404, json: { error: "not found" } };
  return { raw: readFileSync(join(FILES_DIR, a.path)), headers: {
    "Content-Type": a.mime, "Content-Disposition": `attachment; filename="${a.filename}"` } };
});

route("DELETE", "/api/files/(\\d+)", (req, [id]) => {
  const a = db.prepare("SELECT * FROM attachments WHERE id=?").get(Number(id));
  if (!a) return { status: 404, json: { error: "not found" } };
  if (!atLeast(req.user, "ADMIN") && a.uploadedById !== req.user.id)
    return { status: 403, json: { error: "Only admins or the uploader can delete a file" } };
  try { unlinkSync(join(FILES_DIR, a.path)); } catch {}
  db.prepare("DELETE FROM attachments WHERE id=?").run(Number(id));
  return { json: { deleted: true } };
});

// --- file manager: a folder tree per customer and per project ---------------
// parentId NULL is the scope's root, so every customer/project has a file area
// from the moment it exists. Folders nest freely; files live in a folder.
const fsNode = (n) => n && ({
  id: n.id, scopeType: n.scopeType, scopeId: n.scopeId, parentId: n.parentId,
  type: n.type, name: n.name, mime: n.mime || null, size: n.size || 0,
  createdDate: n.createdDate, modifiedDate: n.modifiedDate,
  createdBy: userShape(getUser(n.createdById)),
  url: n.type === "file" ? `/api/fs/${n.id}/download` : null,
});
const getNode = (id) => db.prepare("SELECT * FROM fs_nodes WHERE id=?").get(Number(id));

// used when a project or customer is deleted — take its whole file tree with it,
// bytes included, so nothing is orphaned on disk
function deleteScopeFiles(scopeType, scopeId) {
  const rows = db.prepare("SELECT id, type, path FROM fs_nodes WHERE scopeType=? AND scopeId=?").all(scopeType, Number(scopeId));
  for (const r of rows) if (r.type === "file" && r.path) { try { unlinkSync(join(FILES_DIR, r.path)); } catch {} }
  db.prepare("DELETE FROM fs_nodes WHERE scopeType=? AND scopeId=?").run(scopeType, Number(scopeId));
  return rows.length;
}

// read access follows the scope's own rules; writing to a customer's files is
// closed to DEV for the same reason editing the customer record is.
function scopeAccess(user, scopeType, scopeId, write) {
  const id = Number(scopeId);
  if (scopeType === "project") return !!getProject(id) && canSeeProject(user, id);
  if (scopeType === "customer") return !!getCustomer(id) && (!write || atLeast(user, "LEAD"));
  return false;
}
const nodeAccess = (user, n, write) => !!n && scopeAccess(user, n.scopeType, n.scopeId, write);
// a parent must be a folder that actually lives in the scope being written to
const validParent = (scopeType, scopeId, pid) => {
  if (!pid) return true;
  const p = getNode(pid);
  return !!p && p.type === "folder" && p.scopeType === scopeType && p.scopeId === Number(scopeId);
};

// a folder can hold one entry per name — collisions get " (2)", " (3)", …
function uniqueName(scopeType, scopeId, parentId, name, ignoreId = null) {
  const siblings = db.prepare(
    `SELECT id, name FROM fs_nodes WHERE scopeType=? AND scopeId=? AND parentId IS ?`
  ).all(scopeType, scopeId, parentId ?? null)
    .filter((r) => r.id !== ignoreId).map((r) => r.name.toLowerCase());
  if (!siblings.includes(name.toLowerCase())) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 2; ; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!siblings.includes(candidate.toLowerCase())) return candidate;
  }
}
const cleanName = (s) => String(s ?? "").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").trim().slice(0, 120);

function breadcrumb(node) {
  const trail = [];
  let cur = node;
  while (cur) { trail.unshift({ id: cur.id, name: cur.name }); cur = cur.parentId ? getNode(cur.parentId) : null; }
  return trail;
}
// true when `maybeAncestor` is at or above `nodeId` — blocks moving a folder into itself
function isAncestor(maybeAncestorId, nodeId) {
  let cur = getNode(nodeId);
  while (cur) { if (cur.id === maybeAncestorId) return true; cur = cur.parentId ? getNode(cur.parentId) : null; }
  return false;
}

route("GET", "/api/fs", (req) => {
  const { scopeType, scopeId } = req.query;
  if (!scopeAccess(req.user, scopeType, scopeId, false)) return { status: 404, json: { error: "not found" } };
  const parentId = req.query.parentId ? Number(req.query.parentId) : null;
  const parent = parentId ? getNode(parentId) : null;
  if (parentId && (!parent || parent.scopeType !== scopeType || parent.scopeId !== Number(scopeId)))
    return { status: 404, json: { error: "folder not found" } };
  const nodes = db.prepare(
    `SELECT * FROM fs_nodes WHERE scopeType=? AND scopeId=? AND parentId IS ?
     ORDER BY type='file', name COLLATE NOCASE`
  ).all(scopeType, Number(scopeId), parentId);
  return { json: { breadcrumb: parent ? breadcrumb(parent) : [], nodes: nodes.map(fsNode) } };
});

route("POST", "/api/fs/folder", (req) => {
  const { scopeType, scopeId, parentId } = req.body || {};
  if (!scopeAccess(req.user, scopeType, scopeId, true)) return { status: 403, json: { error: "Not allowed" } };
  const name = cleanName(req.body?.name) || "New folder";
  const pid = parentId ? Number(parentId) : null;
  if (!validParent(scopeType, scopeId, pid)) return { status: 404, json: { error: "folder not found" } };
  const r = db.prepare(`INSERT INTO fs_nodes (scopeType,scopeId,parentId,type,name,createdById,createdDate,modifiedDate)
    VALUES (?,?,?,'folder',?,?,?,?)`)
    .run(scopeType, Number(scopeId), pid, uniqueName(scopeType, Number(scopeId), pid, name), req.user.id, now(), now());
  return { json: fsNode(getNode(r.lastInsertRowid)) };
});

route("POST", "/api/fs/upload", (req) => {
  const { scopeType, scopeId, parentId, filename, dataBase64, mime } = req.body || {};
  if (!scopeAccess(req.user, scopeType, scopeId, true)) return { status: 403, json: { error: "Not allowed" } };
  if (!filename || !dataBase64) return { status: 400, json: { error: "filename and dataBase64 required" } };
  const buf = Buffer.from(dataBase64, "base64");
  if (buf.length > 25 * 1024 * 1024) return { status: 413, json: { error: "max 25 MB" } };
  const pid = parentId ? Number(parentId) : null;
  if (!validParent(scopeType, scopeId, pid)) return { status: 404, json: { error: "folder not found" } };
  if (!existsSync(FILES_DIR)) mkdirSync(FILES_DIR, { recursive: true });
  const rel = `fs${Date.now()}_${randomBytes(5).toString("hex")}`;
  writeFileSync(join(FILES_DIR, rel), buf);
  const name = uniqueName(scopeType, Number(scopeId), pid, cleanName(filename) || "file");
  const r = db.prepare(`INSERT INTO fs_nodes (scopeType,scopeId,parentId,type,name,mime,size,path,createdById,createdDate,modifiedDate)
    VALUES (?,?,?,'file',?,?,?,?,?,?,?)`)
    .run(scopeType, Number(scopeId), pid, name, mime || "application/octet-stream", buf.length, rel, req.user.id, now(), now());
  if (scopeType === "project") {
    const p = getProject(Number(scopeId));
    notify(p?.assignedToId, req.user.id, `${req.user.displayName} added "${name}" to ${p?.key} files`, null, { projectId: p?.id, type: "file" });
  }
  return { json: fsNode(getNode(r.lastInsertRowid)) };
});

route("GET", "/api/fs/(\\d+)/download", (req, [id]) => {
  const n = getNode(id);
  if (!n || n.type !== "file" || !nodeAccess(req.user, n, false)) return { status: 404, json: { error: "not found" } };
  return { raw: readFileSync(join(FILES_DIR, n.path)), headers: {
    "Content-Type": n.mime || "application/octet-stream",
    "Content-Disposition": `attachment; filename="${n.name.replace(/"/g, "")}"` } };
});

// rename (name) and move / paste-after-cut (parentId) share one route
route("PUT", "/api/fs/(\\d+)", (req, [id]) => {
  const n = getNode(id);
  if (!nodeAccess(req.user, n, true)) return { status: 404, json: { error: "not found" } };
  const b = req.body || {};
  let parentId = n.parentId;
  if (b.parentId !== undefined) {
    parentId = b.parentId ? Number(b.parentId) : null;
    if (parentId) {
      const target = getNode(parentId);
      if (!target || target.type !== "folder" || target.scopeType !== n.scopeType || target.scopeId !== n.scopeId)
        return { status: 400, json: { error: "target folder not found" } };
      if (n.type === "folder" && isAncestor(n.id, parentId))
        return { status: 400, json: { error: "A folder can't be moved inside itself" } };
    }
  }
  const name = b.name !== undefined ? (cleanName(b.name) || n.name) : n.name;
  db.prepare("UPDATE fs_nodes SET name=?, parentId=?, modifiedDate=? WHERE id=?")
    .run(uniqueName(n.scopeType, n.scopeId, parentId, name, n.id), parentId, now(), n.id);
  return { json: fsNode(getNode(n.id)) };
});

// copy/paste — folders are duplicated with everything underneath them
route("POST", "/api/fs/(\\d+)/copy", (req, [id]) => {
  const n = getNode(id);
  if (!nodeAccess(req.user, n, true)) return { status: 404, json: { error: "not found" } };
  const parentId = req.body?.parentId ? Number(req.body.parentId) : null;
  if (parentId) {
    const target = getNode(parentId);
    if (!target || target.type !== "folder" || target.scopeType !== n.scopeType || target.scopeId !== n.scopeId)
      return { status: 400, json: { error: "target folder not found" } };
    if (n.type === "folder" && isAncestor(n.id, parentId))
      return { status: 400, json: { error: "A folder can't be copied inside itself" } };
  }
  const ins = db.prepare(`INSERT INTO fs_nodes (scopeType,scopeId,parentId,type,name,mime,size,path,createdById,createdDate,modifiedDate)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const copyInto = (src, destParentId, forceName) => {
    let path = null;
    if (src.type === "file") { // duplicate the bytes so deleting one copy can't gut the other
      path = `fs${Date.now()}_${randomBytes(5).toString("hex")}`;
      try { writeFileSync(join(FILES_DIR, path), readFileSync(join(FILES_DIR, src.path))); } catch { path = src.path; }
    }
    const name = uniqueName(src.scopeType, src.scopeId, destParentId, forceName ?? src.name);
    const r = ins.run(src.scopeType, src.scopeId, destParentId, src.type, name,
      src.mime, src.size, path, req.user.id, now(), now());
    const newId = r.lastInsertRowid;
    if (src.type === "folder")
      for (const child of db.prepare("SELECT * FROM fs_nodes WHERE parentId=?").all(src.id)) copyInto(child, newId, null);
    return newId;
  };
  return { json: fsNode(getNode(copyInto(n, parentId, null))) };
});

route("DELETE", "/api/fs/(\\d+)", (req, [id]) => {
  const n = getNode(id);
  if (!nodeAccess(req.user, n, true)) return { status: 404, json: { error: "not found" } };
  if (!atLeast(req.user, "ADMIN") && n.createdById !== req.user.id)
    return { status: 403, json: { error: "Only admins or whoever created it can delete this" } };
  // collect the whole subtree first so the files come off disk as well
  const doomed = [];
  const walk = (nodeId) => {
    const cur = getNode(nodeId); if (!cur) return;
    doomed.push(cur);
    for (const c of db.prepare("SELECT id FROM fs_nodes WHERE parentId=?").all(nodeId)) walk(c.id);
  };
  walk(n.id);
  for (const d of doomed) if (d.type === "file" && d.path) { try { unlinkSync(join(FILES_DIR, d.path)); } catch {} }
  db.prepare("DELETE FROM fs_nodes WHERE id=?").run(n.id); // children cascade
  return { json: { deleted: true, count: doomed.length } };
});

// --- effort analytics & scoreboard
route("GET", "/api/analytics", (req) => ({ json: computeAnalytics(req.user, req.query.projectId) }));

// --- notifications
route("GET", "/api/notifications/user/(\\d+)", (req, [id]) => ({
  json: db.prepare("SELECT * FROM notifications WHERE userId=? ORDER BY createdDate DESC LIMIT 50").all(Number(id)),
}));

route("PUT", "/api/notifications/(\\d+)/read", (req, [id]) => {
  db.prepare("UPDATE notifications SET read=1 WHERE id=? AND userId=?").run(Number(id), req.user.id);
  return { json: { ok: true } };
});

// ---------------------------------------------------------------------------
// http plumbing
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString("utf8");
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const send = (status, body, headers = {}) => {
    res.writeHead(status, { "Content-Type": "application/json;charset=UTF-8", "Cache-Control": "no-store", ...headers });
    res.end(JSON.stringify(body));
  };

  try {
    if (url.pathname.startsWith("/api/")) {
      req.user = sessionUser(req);
      req.query = Object.fromEntries(url.searchParams);
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        if (!r.public && !req.user) return send(401, { error: "Unauthorized" });
        if (["POST", "PUT", "DELETE"].includes(req.method)) req.body = await readBody(req);
        const out = (await r.handler(req, m.slice(1))) || {};
        if (out.raw) {
          res.writeHead(out.status || 200, { "Cache-Control": "no-store", ...out.headers });
          return res.end(out.raw);
        }
        return send(out.status || 200, out.json ?? {}, out.headers);
      }
      return send(404, { error: "not found" });
    }
    // static assets (PWA), then SPA fallback
    const STATIC = {
      "/manifest.webmanifest": "application/manifest+json",
      "/sw.js": "text/javascript; charset=utf-8",
      "/icon-192.png": "image/png",
      "/icon-512.png": "image/png",
      "/apple-touch-icon.png": "image/png",
      "/logo.svg": "image/svg+xml",
      "/bimi-logo.svg": "image/svg+xml",
    };
    if (STATIC[url.pathname]) {
      res.writeHead(200, { "Content-Type": STATIC[url.pathname], "Cache-Control": "public, max-age=3600" });
      return res.end(readFileSync(join(ROOT, "public", url.pathname.slice(1))));
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(readFileSync(join(ROOT, "public", "index.html")));
  } catch (err) {
    console.error(err);
    return send(500, { error: err.message });
  }
});

server.listen(PORT, HOST, () => console.log(`Trivyah Task Manager → http://${HOST}:${PORT}`));
