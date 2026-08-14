#!/usr/bin/env node
/**
 * CoreKit Tracker — lightweight project management (projects, issues, kanban).
 * Zero dependencies: node:http + node:sqlite + node:crypto.
 *
 * API is Sprint0-compatible on purpose, so the sprint0-mcp server and the
 * Capacity Control dashboard work against it by pointing SPRINT0_BASE_URL here:
 *   POST /api/auth/login {username,password} → Set-Cookie: JSESSIONID
 *   GET  /api/auth/status
 *   GET  /api/users            POST /api/users (admin)   PUT /api/users/:id (admin)
 *   GET  /api/pm-projects      POST/PUT/DELETE /api/pm-projects[/:id]
 *   GET  /api/pm-stories?projectId=&type=   GET/POST/PUT/DELETE /api/pm-stories[/:id]
 *   GET  /api/pm-comments?storyId=          POST /api/pm-comments
 *   GET  /api/notifications/user/:id
 *
 *   node server.js    → http://localhost:4580
 */
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { db, now } from "./db.js";

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
// auth helpers
const hash = (pw, salt) => scryptSync(pw, salt, 64).toString("hex");

function verifyPassword(user, pw) {
  const h = Buffer.from(hash(pw, user.salt), "hex");
  const stored = Buffer.from(user.passwordHash, "hex");
  return h.length === stored.length && timingSafeEqual(h, stored);
}

function createUser({ username, displayName, role = "USER", password, email }) {
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
  createUser({ username: "admin", displayName: "Administrator", role: "ADMIN", password: pw });
  const f = join(ROOT, "data", "admin-password.txt");
  if (!process.env.COREKIT_ADMIN_PASSWORD) writeFileSync(f, pw);
  console.log(`Seeded admin user 'admin' — password ${process.env.COREKIT_ADMIN_PASSWORD ? "from COREKIT_ADMIN_PASSWORD" : "saved to " + f}`);
}

function sessionUser(req) {
  const m = /(?:^|;\s*)JSESSIONID=([\w-]+)/.exec(req.headers.cookie || "");
  if (!m) return null;
  const s = db.prepare("SELECT * FROM sessions WHERE token=?").get(m[1]);
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
// shapes (Sprint0-compatible)
const userShape = (u) => u && {
  id: u.id, username: u.username, displayName: u.displayName, name: u.displayName,
  email: u.email || null, role: u.role, enabled: !!u.enabled, lastLoginAt: u.lastLoginAt,
};
const getUser = (id) => id == null ? null : db.prepare("SELECT * FROM users WHERE id=?").get(id);

const projectShape = (p) => p && {
  id: p.id, createdDate: p.createdDate, modifiedDate: p.modifiedDate,
  name: p.name, description: p.description, key: p.key, dueDate: p.dueDate,
  priority: p.priority, assignees: p.assignees, projectStatus: p.projectStatus,
  category: p.category || "client", targetDate: p.targetDate ?? null,
  assignedTo: userShape(getUser(p.assignedToId)),
};
const getProject = (id) => db.prepare("SELECT * FROM projects WHERE id=?").get(id);

const storyShape = (s) => s && {
  id: s.id, createdDate: s.createdDate, modifiedDate: s.modifiedDate,
  name: s.name, number: s.number, type: s.type, module: s.module,
  description: s.description, dueDate: s.dueDate, priority: s.priority,
  storyPoints: s.storyPoints, storyStatus: s.storyStatus,
  assignedTo: userShape(getUser(s.assignedToId)),
  reporter: userShape(getUser(s.reporterId)),
  project: projectShape(getProject(s.projectId)),
};

function notify(userId, actorId, text, storyId) {
  if (!userId || userId === actorId) return;
  db.prepare("INSERT INTO notifications (userId, text, storyId, createdDate) VALUES (?,?,?,?)")
    .run(userId, text, storyId ?? null, now());
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
        `--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${plain}\r\n\r\n` +
        `--${boundary}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}\r\n\r\n--${boundary}--`
      : `Content-Type: text/plain; charset=utf-8\r\n\r\n${plain}`;
    const steps = [
      `EHLO ${fromDomain}`,
      `AUTH LOGIN`,
      Buffer.from(SMTP.user).toString("base64"),
      Buffer.from(SMTP.pass).toString("base64"),
      `MAIL FROM:<${SMTP.from}>`,
      `RCPT TO:<${to}>`,
      `DATA`,
      (`From: CoreKit Tracker <${SMTP.from}>\r\nTo: <${to}>\r\nSubject: ${subject}\r\nDate: ${date}\r\nMessage-ID: ${msgId}\r\nMIME-Version: 1.0\r\n${body}`)
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

// --- branded HTML email template (brutalist, table-based, inline styles) ----
const escHtml = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function emailHtml({ heading, intro, rows = [], cta }) {
  const rowsHtml = rows.filter((r) => r && r[1] != null && r[1] !== "").map(([k, v]) => `
    <tr>
      <td style="font-family:'Courier New',monospace;font-size:10px;letter-spacing:2px;color:#8a857c;text-transform:uppercase;padding:7px 14px 7px 0;white-space:nowrap;vertical-align:top">${escHtml(k)}</td>
      <td style="font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:bold;color:#141414;padding:7px 0">${escHtml(v)}</td>
    </tr>`).join("");
  return `<!doctype html><html><body style="margin:0;padding:0;background-color:#F2EFE8">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#F2EFE8"><tr><td align="center" style="padding:32px 14px">
<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;max-width:540px">
  <tr><td style="background-color:#141414;padding:20px 26px">
    <span style="font-family:'Arial Black',Arial,sans-serif;font-size:24px;font-weight:900;color:#F2EFE8;letter-spacing:1px">CORE<span style="color:#FFD900">KIT</span></span>
    <div style="font-family:'Courier New',monospace;font-size:10px;color:#8f8a80;letter-spacing:4px;margin-top:5px">TRIVYAH TECH &middot; TRACKER</div>
  </td></tr>
  <tr><td style="background-color:#FFD900;height:7px;font-size:0;line-height:0">&nbsp;</td></tr>
  <tr><td style="background-color:#ffffff;border:3px solid #141414;border-top:none;padding:28px 26px">
    <div style="font-family:'Arial Black',Arial,sans-serif;font-size:18px;font-weight:900;color:#141414;text-transform:uppercase;letter-spacing:.5px">${escHtml(heading)}</div>
    <p style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#3a3a3a;line-height:1.6;margin:14px 0 6px">${intro}</p>
    ${rowsHtml ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:14px 0 6px;border-top:2px solid #E9E5DB">${rowsHtml}</table>` : ""}
    ${cta ? `<div style="margin-top:22px"><a href="${escHtml(cta.url)}" style="display:inline-block;background-color:#FFD900;color:#141414;border:3px solid #141414;padding:13px 26px;font-family:'Courier New',monospace;font-size:13px;font-weight:bold;letter-spacing:1px;text-decoration:none;text-transform:uppercase">${escHtml(cta.label)} &rarr;</a></div>` : ""}
  </td></tr>
  <tr><td style="padding:16px 6px;font-family:'Courier New',monospace;font-size:10px;color:#8f8a80;letter-spacing:1px">
    SENT BY COREKIT TRACKER &middot; <a href="${PUBLIC_URL}" style="color:#8f8a80">corekit.me</a> &middot; YOU'RE GETTING THIS BECAUSE YOU'RE ON THE TEAM
  </td></tr>
</table></td></tr></table></body></html>`;
}

// fire-and-forget notification mail — never blocks the API response
function mailNotify(userId, { subject, heading, intro, rows, cta }) {
  if (!smtpConfigured()) return;
  const u = getUser(userId);
  if (!u || !u.email || !u.enabled) return;
  sendMail(u.email, subject, intro.replace(/<[^>]+>/g, ""), emailHtml({ heading, intro, rows, cta }))
    .catch((e) => console.error("[mail]", e.message));
}

function recordHistory(storyId, userId, field, oldValue, newValue) {
  db.prepare("INSERT INTO history (storyId,userId,field,oldValue,newValue,createdDate) VALUES (?,?,?,?,?,?)")
    .run(storyId, userId, field, oldValue == null ? null : String(oldValue), newValue == null ? null : String(newValue), now());
}

// --- effort analytics ---------------------------------------------------------
// All signals derive from the history table (status transitions with timestamps).
const FIB = [1, 2, 3, 5, 8, 13, 21];
const fib = (n) => FIB.reduce((best, f) => Math.abs(f - n) < Math.abs(best - n) ? f : best, 1);
const EFFORT_RULES = {
  basePoints: { Story: 3, Bug: 2, Issue: 2 },
  priorityBoost: { High: 2, Medium: 1, Low: 0 },
  daysPerPoint: 2,          // +1 effort point per 2 days of active cycle time
  criticalReworks: 2,       // re-entered In Progress this many times → critical
  criticalDelayDays: 7,     // late by more than this → critical
  penaltyPerWeekLate: 1,    // dev loses 1 point per week beyond the grace week
  maxDelayPenalty: 5,
  maxReworkPenalty: 3,
  onTimeBonus: 1,
};

function analyzeStory(s, historyRows) {
  const transitions = historyRows.filter((h) => h.field === "storyStatus");
  const inProgTimes = transitions.filter((h) => h.newValue === "In Progress").map((h) => new Date(h.createdDate));
  const doneRow = [...transitions].reverse().find((h) => h.newValue === "Done");
  const isDone = s.storyStatus === "Done";
  const doneAt = isDone ? new Date(doneRow ? doneRow.createdDate : s.modifiedDate) : null;
  const firstInProg = inProgTimes.length ? inProgTimes[0] : new Date(s.createdDate);
  const endRef = doneAt || new Date();
  const cycleDays = Math.max(0, Math.round((endRef - firstInProg) / 86400e3));
  const reworkCount = Math.max(0, inProgTimes.length - 1);
  const delayDays = s.dueDate ? Math.max(0, Math.floor((endRef - new Date(s.dueDate + "T23:59:59")) / 86400e3)) : 0;

  const effortPoints = fib(
    (EFFORT_RULES.basePoints[s.type] ?? 3) +
    (EFFORT_RULES.priorityBoost[s.priority] ?? 0) +
    Math.min(8, Math.floor(cycleDays / EFFORT_RULES.daysPerPoint)) +
    reworkCount
  );

  const criticalReasons = [];
  if (reworkCount >= EFFORT_RULES.criticalReworks) criticalReasons.push(`bounced back to In Progress ${reworkCount}×`);
  if (delayDays > EFFORT_RULES.criticalDelayDays) criticalReasons.push(`${isDone ? "finished" : "running"} ${delayDays} days late`);

  return { id: s.id, number: s.number, name: s.name, projectId: s.projectId,
    assignedToId: s.assignedToId, storyStatus: s.storyStatus, dueDate: s.dueDate,
    storyPoints: s.storyPoints, effortPoints, cycleDays, reworkCount, delayDays,
    critical: criticalReasons.length > 0, criticalReasons };
}

function computeAnalytics(user, projectId) {
  const vis = visibleProjectIds(user);
  let stories = db.prepare(projectId ? "SELECT * FROM stories WHERE projectId=?" : "SELECT * FROM stories").all(...(projectId ? [Number(projectId)] : []));
  if (vis) stories = stories.filter((s) => vis.has(s.projectId));
  const hist = db.prepare("SELECT storyId, field, newValue, createdDate FROM history WHERE field='storyStatus'").all();
  const byStory = new Map();
  for (const h of hist) { if (!byStory.has(h.storyId)) byStory.set(h.storyId, []); byStory.get(h.storyId).push(h); }

  const analyzed = stories.map((s) => analyzeStory(s, byStory.get(s.id) || []));

  const devs = new Map();
  for (const a of analyzed) {
    if (!a.assignedToId) continue;
    if (!devs.has(a.assignedToId)) {
      const u = getUser(a.assignedToId);
      devs.set(a.assignedToId, { userId: a.assignedToId, displayName: u?.displayName ?? "?",
        done: 0, onTime: 0, late: 0, reworked: 0, earned: 0, penalties: 0, score: 0 });
    }
    const d = devs.get(a.assignedToId);
    if (a.storyStatus === "Done") {
      d.done++;
      d.earned += a.storyPoints ?? a.effortPoints;
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
  return { generatedAt: now(), rules: EFFORT_RULES, stories: analyzed,
    devs: [...devs.values()].sort((a, b) => b.score - a.score) };
}

// Role scoping: only ADMIN sees everything; everyone else (including DEVLEAD)
// sees only projects they belong to (project assignee list / project owner)
// or where they have stories. Returns null for "all", else a Set of project ids.
function visibleProjectIds(user) {
  if (user.role === "ADMIN") return null;
  const ids = new Set();
  for (const p of db.prepare("SELECT id, assignees, assignedToId FROM projects").all()) {
    const members = String(p.assignees || "").split(",").map(Number);
    if (p.assignedToId === user.id || members.includes(user.id)) ids.add(p.id);
  }
  for (const r of db.prepare("SELECT DISTINCT projectId pid FROM stories WHERE assignedToId=? OR reporterId=?").all(user.id, user.id))
    ids.add(r.pid);
  return ids;
}

const isProjectMember = (p, user) =>
  p.assignedToId === user.id || String(p.assignees || "").split(",").map(Number).includes(user.id);

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
  const m = /(?:^|;\s*)JSESSIONID=([\w-]+)/.exec(req.headers.cookie || "");
  if (m) db.prepare("DELETE FROM sessions WHERE token=?").run(m[1]);
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
    await sendMail(u.email, "CoreKit Tracker password reset",
      `Reset your CoreKit Tracker password (valid 1 hour): ${link}`,
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
  if (req.user.role !== "ADMIN") return { status: 403, json: { error: "Admin only" } };
  const u = getUser(id);
  if (!u) return { status: 404, json: { error: "not found" } };
  const link = `${PUBLIC_URL}/#/reset/${createResetToken(u.id)}`;
  let mailed = false;
  if (smtpConfigured() && u.email) {
    mailed = await sendMail(u.email, "CoreKit Tracker password reset",
      `Set your CoreKit Tracker password (valid 1 hour): ${link}`,
      emailHtml({
        heading: "Password reset",
        intro: `An admin generated a password reset for your account <b>${escHtml(u.username)}</b>. The link below is valid for 1 hour and works once.`,
        cta: { label: "Set new password", url: link },
      }));
  }
  return { json: { link, mailed, expiresInMinutes: 60 } };
});

// --- users
route("GET", "/api/users", () =>
  ({ json: db.prepare("SELECT * FROM users ORDER BY displayName").all().map(userShape) }));

route("POST", "/api/users", async (req) => {
  if (req.user.role !== "ADMIN") return { status: 403, json: { error: "Admin only" } };
  const { username, displayName, role, password, email } = req.body || {};
  if (!username || !displayName) return { status: 400, json: { error: "username and displayName required" } };
  if (db.prepare("SELECT 1 FROM users WHERE username=?").get(String(username).toLowerCase()))
    return { status: 409, json: { error: "username already exists" } };
  // no password given → invite flow: unknown random password + a 72h set-password link
  const u = createUser({ username, displayName, role, email, password: password || randomBytes(18).toString("base64url") });
  let inviteLink = null, mailed = false;
  if (!password) {
    inviteLink = `${PUBLIC_URL}/#/reset/${createResetToken(u.id, 72)}`;
    if (smtpConfigured() && u.email) {
      mailed = await sendMail(u.email, "You've been added to CoreKit Tracker",
        `${req.user.displayName} added you to CoreKit Tracker. Set your password: ${inviteLink}`,
        emailHtml({
          heading: "Welcome to the team",
          intro: `<b>${escHtml(req.user.displayName)}</b> added you to CoreKit Tracker — projects, issues and kanban for Trivyah Tech. Set your password to get started (the link is valid for 72 hours).`,
          rows: [["Your username", u.username], ["Role", u.role]],
          cta: { label: "Set your password", url: inviteLink },
        }));
    }
  }
  return { json: { ...userShape(u), inviteLink, mailed } };
});

route("PUT", "/api/users/(\\d+)", (req, [id]) => {
  if (req.user.role !== "ADMIN" && req.user.id !== Number(id)) return { status: 403, json: { error: "Admin only" } };
  const u = getUser(id);
  if (!u) return { status: 404, json: { error: "not found" } };
  const b = req.body || {};
  if (b.password) {
    const salt = randomBytes(16).toString("hex");
    db.prepare("UPDATE users SET passwordHash=?, salt=? WHERE id=?").run(hash(String(b.password), salt), salt, u.id);
  }
  if (req.user.role === "ADMIN") {
    db.prepare("UPDATE users SET displayName=?, role=?, enabled=?, email=? WHERE id=?")
      .run(b.displayName ?? u.displayName, b.role ?? u.role, b.enabled != null ? (b.enabled ? 1 : 0) : u.enabled,
        b.email !== undefined ? (b.email ? String(b.email).trim().toLowerCase() : null) : u.email, u.id);
  }
  return { json: userShape(getUser(u.id)) };
});

route("DELETE", "/api/users/(\\d+)", (req, [id]) => {
  if (req.user.role !== "ADMIN") return { status: 403, json: { error: "Admin only" } };
  const u = getUser(id);
  if (!u) return { status: 404, json: { error: "not found" } };
  if (u.id === req.user.id) return { status: 400, json: { error: "You can't delete your own account" } };
  const activity =
    db.prepare("SELECT COUNT(*) c FROM stories WHERE assignedToId=? OR reporterId=?").get(u.id, u.id).c +
    db.prepare("SELECT COUNT(*) c FROM comments WHERE userId=?").get(u.id).c +
    db.prepare("SELECT COUNT(*) c FROM attachments WHERE uploadedById=?").get(u.id).c;
  if (activity) return { status: 409, json: { error: `User has ${activity} linked records (stories/comments/files) — disable the account instead, or reassign their work first` } };
  db.prepare("UPDATE history SET userId=NULL WHERE userId=?").run(u.id);
  db.prepare("DELETE FROM users WHERE id=?").run(u.id); // sessions/notifications/resets cascade
  return { json: { deleted: true, id: u.id } };
});

// --- projects
route("GET", "/api/pm-projects", (req) => {
  const vis = visibleProjectIds(req.user);
  const all = db.prepare("SELECT * FROM projects ORDER BY modifiedDate DESC").all();
  return { json: (vis ? all.filter((p) => vis.has(p.id)) : all).map(projectShape) };
});

route("POST", "/api/pm-projects", (req) => {
  const b = req.body || {};
  if (!b.name || !b.key) return { status: 400, json: { error: "name and key required" } };
  const key = String(b.key).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
  if (db.prepare("SELECT 1 FROM projects WHERE key=?").get(key)) return { status: 409, json: { error: "key already exists" } };
  const r = db.prepare(`INSERT INTO projects (key,name,description,priority,projectStatus,dueDate,assignees,assignedToId,createdDate,modifiedDate,category,targetDate)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(key, b.name, b.description || "", b.priority || "Medium", b.projectStatus || "Active",
      b.dueDate ?? null, b.assignees || String(req.user.id), b.assignedTo?.id ?? req.user.id, now(), now(),
      b.category === "product" ? "product" : "client", b.targetDate ?? null);
  return { json: projectShape(getProject(r.lastInsertRowid)) };
});

route("PUT", "/api/pm-projects/(\\d+)", (req, [id]) => {
  const p = getProject(id);
  if (!p) return { status: 404, json: { error: "not found" } };
  const canEdit = req.user.role === "ADMIN" || p.assignedToId === req.user.id ||
    (req.user.role === "DEVLEAD" && isProjectMember(p, req.user));
  if (!canEdit) return { status: 403, json: { error: "Only admins, the project owner, or a dev lead on this project can edit it" } };
  const b = req.body || {};
  db.prepare(`UPDATE projects SET name=?, description=?, priority=?, projectStatus=?, dueDate=?, assignees=?, assignedToId=?, modifiedDate=?, category=?, targetDate=? WHERE id=?`)
    .run(b.name ?? p.name, b.description ?? p.description, b.priority ?? p.priority,
      b.projectStatus ?? p.projectStatus, b.dueDate !== undefined ? b.dueDate : p.dueDate,
      b.assignees ?? p.assignees, b.assignedTo?.id ?? p.assignedToId, now(),
      b.category !== undefined ? (b.category === "product" ? "product" : "client") : (p.category || "client"),
      b.targetDate !== undefined ? b.targetDate : p.targetDate, p.id);
  // notify people newly added to the project
  if (b.assignees !== undefined) {
    const before = new Set(String(p.assignees || "").split(",").map(Number).filter(Boolean));
    for (const uid of String(b.assignees || "").split(",").map(Number).filter(Boolean)) {
      if (before.has(uid)) continue;
      notify(uid, req.user.id, `You were added to project ${p.key} — ${p.name}`, null);
      if (uid !== req.user.id) mailNotify(uid, {
        subject: `You were added to ${p.key} — ${b.name ?? p.name}`,
        heading: "Added to project",
        intro: `<b>${escHtml(req.user.displayName)}</b> added you to <b>${escHtml(b.name ?? p.name)}</b>. You can now see its board and stories.`,
        rows: [["Project", `${p.key} — ${b.name ?? p.name}`], ["Priority", b.priority ?? p.priority], ["Due", b.dueDate !== undefined ? b.dueDate : p.dueDate]],
        cta: { label: "Open board", url: `${PUBLIC_URL}/#/board/${p.id}` },
      });
    }
  }
  return { json: projectShape(getProject(p.id)) };
});

route("DELETE", "/api/pm-projects/(\\d+)", (req, [id]) => {
  const p = getProject(id);
  if (!p) return { status: 404, json: { error: "not found" } };
  if (req.user.role !== "ADMIN" && p.assignedToId !== req.user.id)
    return { status: 403, json: { error: "Only admins or the project owner can delete a project" } };
  const hasStories = db.prepare("SELECT COUNT(*) c FROM stories WHERE projectId=?").get(id).c;
  if (hasStories && req.user.role !== "ADMIN")
    return { status: 409, json: { error: "project has stories — only an admin can delete it (cascades)" } };
  // admin cascade: remove attachment files from disk, then stories (comments/
  // history/attachments cascade via FK), then the project
  for (const a of db.prepare("SELECT a.path FROM attachments a JOIN stories s ON s.id=a.storyId WHERE s.projectId=?").all(id)) {
    try { unlinkSync(join(FILES_DIR, a.path)); } catch {}
  }
  db.prepare("DELETE FROM stories WHERE projectId=?").run(id);
  db.prepare("DELETE FROM projects WHERE id=?").run(id);
  return { json: { deleted: true, storiesDeleted: hasStories } };
});

// --- stories
route("GET", "/api/pm-stories", (req) => {
  const q = req.query;
  const vis = visibleProjectIds(req.user);
  let sql = "SELECT * FROM stories WHERE 1=1"; const args = [];
  if (q.projectId) {
    if (vis && !vis.has(Number(q.projectId))) return { json: [] };
    sql += " AND projectId=?"; args.push(Number(q.projectId));
  }
  if (q.type && q.type !== "all") { sql += " AND type=?"; args.push(q.type); }
  sql += " ORDER BY seq DESC";
  let rows = db.prepare(sql).all(...args);
  if (!q.projectId && vis) rows = rows.filter((s) => vis.has(s.projectId));
  return { json: rows.map(storyShape) };
});

route("GET", "/api/pm-stories/(\\d+)", (req, [id]) => {
  const s = db.prepare("SELECT * FROM stories WHERE id=?").get(id);
  if (!s || !canSeeProject(req.user, s.projectId)) return { status: 404, json: { error: "not found" } };
  return { json: storyShape(s) };
});

route("POST", "/api/pm-stories", (req) => {
  if (req.user.role === "DEV") return { status: 403, json: { error: "Developers can't create items — ask your dev lead or a reporter" } };
  const b = req.body || {};
  const p = b.project?.id && getProject(b.project.id);
  if (!b.name || !p) return { status: 400, json: { error: "name and project.id required" } };
  if (!canSeeProject(req.user, p.id)) return { status: 403, json: { error: "You're not on this project" } };
  const seq = (db.prepare("SELECT COALESCE(MAX(seq),0) m FROM stories WHERE projectId=?").get(p.id).m) + 1;
  const assignee = b.assignedTo?.id ?? req.user.id;
  const r = db.prepare(`INSERT INTO stories (projectId,seq,number,name,description,module,type,priority,storyPoints,storyStatus,dueDate,assignedToId,reporterId,createdDate,modifiedDate)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(p.id, seq, `${p.key}-${seq}`, b.name, b.description || "", b.module || "",
      b.type || "Story", b.priority || "Medium", b.storyPoints ?? null, b.storyStatus || "Backlog",
      b.dueDate ?? null, assignee, req.user.id, now(), now()); // reporter is always the creator
  const s = db.prepare("SELECT * FROM stories WHERE id=?").get(r.lastInsertRowid);
  notify(assignee, req.user.id, `${s.number} "${s.name}" assigned to you`, s.id);
  if (assignee !== req.user.id) mailNotify(assignee, {
    subject: `[${s.number}] assigned to you — ${s.name}`,
    heading: "New assignment",
    intro: `<b>${escHtml(req.user.displayName)}</b> assigned you a ${escHtml(s.type.toLowerCase())} in <b>${escHtml(p.name)}</b>.`,
    rows: [["Item", `${s.number} — ${s.name}`], ["Priority", s.priority], ["Points", s.storyPoints], ["Due", s.dueDate], ["Module", s.module]],
    cta: { label: "Open board", url: `${PUBLIC_URL}/#/board/${p.id}` },
  });
  recordHistory(s.id, req.user.id, "created", null, s.number);
  return { json: storyShape(s) };
});

route("PUT", "/api/pm-stories/(\\d+)", (req, [id]) => {
  const s = db.prepare("SELECT * FROM stories WHERE id=?").get(id);
  if (!s || !canSeeProject(req.user, s.projectId)) return { status: 404, json: { error: "not found" } };
  const b = req.body || {};
  const newAssignee = b.assignedTo?.id !== undefined ? b.assignedTo.id : s.assignedToId;
  const newStatus = b.storyStatus ?? s.storyStatus;
  // reporterId is immutable — always whoever created the story
  db.prepare(`UPDATE stories SET name=?, description=?, module=?, type=?, priority=?, storyPoints=?, storyStatus=?, dueDate=?, assignedToId=?, modifiedDate=? WHERE id=?`)
    .run(b.name ?? s.name, b.description ?? s.description, b.module ?? s.module, b.type ?? s.type,
      b.priority ?? s.priority, b.storyPoints !== undefined ? b.storyPoints : s.storyPoints,
      newStatus, b.dueDate !== undefined ? b.dueDate : s.dueDate,
      newAssignee, now(), s.id);
  const storyCta = { label: "Open board", url: `${PUBLIC_URL}/#/board/${s.projectId}` };
  if (newAssignee !== s.assignedToId) {
    notify(newAssignee, req.user.id, `${s.number} "${s.name}" assigned to you`, s.id);
    if (newAssignee !== req.user.id) mailNotify(newAssignee, {
      subject: `[${s.number}] assigned to you — ${s.name}`,
      heading: "New assignment",
      intro: `<b>${escHtml(req.user.displayName)}</b> reassigned this item to you.`,
      rows: [["Item", `${s.number} — ${b.name ?? s.name}`], ["Status", newStatus], ["Priority", b.priority ?? s.priority], ["Due", b.dueDate !== undefined ? b.dueDate : s.dueDate]],
      cta: storyCta,
    });
  }
  if (newStatus !== s.storyStatus) {
    const moveMail = (uid) => uid !== req.user.id && mailNotify(uid, {
      subject: `[${s.number}] moved to ${newStatus}`,
      heading: "Status change",
      intro: `<b>${escHtml(req.user.displayName)}</b> moved <b>${escHtml(s.number)} — ${escHtml(s.name)}</b>.`,
      rows: [["From", s.storyStatus], ["To", newStatus]],
      cta: storyCta,
    });
    notify(s.reporterId, req.user.id, `${s.number} moved to ${newStatus}`, s.id);
    moveMail(s.reporterId);
    if (s.assignedToId !== s.reporterId) {
      notify(s.assignedToId, req.user.id, `${s.number} moved to ${newStatus}`, s.id);
      moveMail(s.assignedToId);
    }
  }
  // effort mechanism: story finished without points → auto-assign from
  // difficulty (type/priority) + completion time + rework, on the fib scale
  if (newStatus === "Done" && s.storyStatus !== "Done" && b.storyPoints === undefined && s.storyPoints == null) {
    const hist = db.prepare("SELECT storyId, field, newValue, createdDate FROM history WHERE storyId=? AND field='storyStatus'").all(s.id);
    const eff = analyzeStory({ ...s, storyStatus: "Done", modifiedDate: now(), priority: b.priority ?? s.priority }, hist).effortPoints;
    db.prepare("UPDATE stories SET storyPoints=? WHERE id=?").run(eff, s.id);
    recordHistory(s.id, req.user.id, "storyPoints", null, `${eff} (auto: effort-based)`);
    s.storyPoints = eff; // keep the generic audit loop below from double-logging
  }

  // audit trail: one row per changed field
  const uname = (id) => getUser(id)?.displayName ?? "—";
  const after = db.prepare("SELECT * FROM stories WHERE id=?").get(s.id);
  for (const f of ["name", "module", "type", "priority", "storyPoints", "storyStatus", "dueDate"]) {
    if (String(s[f] ?? "") !== String(after[f] ?? "")) recordHistory(s.id, req.user.id, f, s[f], after[f]);
  }
  if (String(s.description ?? "") !== String(after.description ?? "")) recordHistory(s.id, req.user.id, "description", null, "updated");
  if (s.assignedToId !== after.assignedToId) recordHistory(s.id, req.user.id, "assignedTo", uname(s.assignedToId), uname(after.assignedToId));
  return { json: storyShape(db.prepare("SELECT * FROM stories WHERE id=?").get(s.id)) };
});

route("DELETE", "/api/pm-stories/(\\d+)", (req, [id]) => {
  const s = db.prepare("SELECT * FROM stories WHERE id=?").get(Number(id));
  if (!s || !canSeeProject(req.user, s.projectId)) return { status: 404, json: { error: "not found" } };
  // ADMIN deletes anything; DEVLEAD only items they reported or in projects they own
  const p = getProject(s.projectId);
  const leadOwns = req.user.role === "DEVLEAD" && (s.reporterId === req.user.id || p?.assignedToId === req.user.id);
  if (req.user.role !== "ADMIN" && !leadOwns)
    return { status: 403, json: { error: "Only admins can delete this — dev leads can only delete items they reported or in projects they own" } };
  for (const a of db.prepare("SELECT path FROM attachments WHERE storyId=?").all(Number(id))) {
    try { unlinkSync(join(FILES_DIR, a.path)); } catch {}
  }
  db.prepare("DELETE FROM stories WHERE id=?").run(id);
  return { json: { deleted: true, id: Number(id) } };
});

// --- comments (text + optional image, e.g. pasted screenshots)
const commentShape = (c) => ({
  id: c.id, storyId: c.storyId, text: c.text, createdDate: c.createdDate,
  user: userShape(getUser(c.userId)),
  imageUrl: c.imagePath ? `/api/pm-comments/${c.id}/image` : null,
});

route("GET", "/api/pm-comments", (req) => {
  const s = db.prepare("SELECT projectId FROM stories WHERE id=?").get(Number(req.query.storyId || 0));
  if (!s || !canSeeProject(req.user, s.projectId)) return { json: [] };
  return { json: db.prepare("SELECT * FROM comments WHERE storyId=? ORDER BY createdDate").all(Number(req.query.storyId)).map(commentShape) };
});

route("POST", "/api/pm-comments", (req) => {
  const { storyId, text, imageBase64, imageMime } = req.body || {};
  if (!storyId || (!text && !imageBase64)) return { status: 400, json: { error: "storyId and text or image required" } };
  const s = db.prepare("SELECT * FROM stories WHERE id=?").get(Number(storyId));
  if (!s || !canSeeProject(req.user, s.projectId)) return { status: 404, json: { error: "story not found" } };
  let imagePath = null;
  if (imageBase64) {
    const buf = Buffer.from(imageBase64, "base64");
    if (buf.length > 10 * 1024 * 1024) return { status: 413, json: { error: "image max 10 MB" } };
    if (!existsSync(FILES_DIR)) mkdirSync(FILES_DIR, { recursive: true });
    imagePath = `c${Date.now()}_${randomBytes(4).toString("hex")}.img`;
    writeFileSync(join(FILES_DIR, imagePath), buf);
  }
  const r = db.prepare("INSERT INTO comments (storyId,userId,text,createdDate,imagePath,imageMime) VALUES (?,?,?,?,?,?)")
    .run(s.id, req.user.id, String(text || ""), now(), imagePath, imageMime || "image/png");
  const commentMail = (uid) => uid !== req.user.id && mailNotify(uid, {
    subject: `[${s.number}] new comment from ${req.user.displayName}`,
    heading: "New comment",
    intro: `<b>${escHtml(req.user.displayName)}</b> commented on <b>${escHtml(s.number)} — ${escHtml(s.name)}</b>:<br><br><i>&ldquo;${escHtml(String(text || "").slice(0, 300))}${String(text || "").length > 300 ? "…" : ""}&rdquo;</i>${imagePath ? "<br><br>📎 includes an image" : ""}`,
    cta: { label: "Open board", url: `${PUBLIC_URL}/#/board/${s.projectId}` },
  });
  notify(s.assignedToId, req.user.id, `${req.user.displayName} commented on ${s.number}`, s.id);
  commentMail(s.assignedToId);
  if (s.reporterId !== s.assignedToId) {
    notify(s.reporterId, req.user.id, `${req.user.displayName} commented on ${s.number}`, s.id);
    commentMail(s.reporterId);
  }
  return { json: commentShape(db.prepare("SELECT * FROM comments WHERE id=?").get(r.lastInsertRowid)) };
});

route("GET", "/api/pm-comments/(\\d+)/image", (req, [id]) => {
  const c = db.prepare("SELECT * FROM comments WHERE id=?").get(Number(id));
  if (!c || !c.imagePath) return { status: 404, json: { error: "not found" } };
  return { raw: readFileSync(join(FILES_DIR, c.imagePath)), headers: { "Content-Type": c.imageMime || "image/png" } };
});

// --- story history (audit trail)
route("GET", "/api/pm-history", (req) => {
  const s = db.prepare("SELECT projectId FROM stories WHERE id=?").get(Number(req.query.storyId || 0));
  if (!s || !canSeeProject(req.user, s.projectId)) return { json: [] };
  return { json: db.prepare("SELECT * FROM history WHERE storyId=? ORDER BY createdDate DESC, id DESC").all(Number(req.query.storyId))
    .map((h) => ({ id: h.id, field: h.field, oldValue: h.oldValue, newValue: h.newValue,
      createdDate: h.createdDate, user: userShape(getUser(h.userId)) })) };
});

// --- attachments (JSON+base64 upload keeps the server dependency-free)
const FILES_DIR = join(ROOT, "data", "files");
const attachShape = (a) => ({
  id: a.id, storyId: a.storyId, filename: a.filename, mime: a.mime, size: a.size,
  createdDate: a.createdDate, uploadedBy: userShape(getUser(a.uploadedById)),
  url: `/api/files/${a.id}/download`,
});

route("GET", "/api/files", (req) => {
  const s = db.prepare("SELECT projectId FROM stories WHERE id=?").get(Number(req.query.storyId || 0));
  if (!s || !canSeeProject(req.user, s.projectId)) return { json: [] };
  return { json: db.prepare("SELECT * FROM attachments WHERE storyId=? ORDER BY createdDate").all(Number(req.query.storyId)).map(attachShape) };
});

route("POST", "/api/files", (req) => {
  const { storyId, filename, dataBase64, mime } = req.body || {};
  if (!storyId || !filename || !dataBase64) return { status: 400, json: { error: "storyId, filename, dataBase64 required" } };
  const s = db.prepare("SELECT * FROM stories WHERE id=?").get(Number(storyId));
  if (!s || !canSeeProject(req.user, s.projectId)) return { status: 404, json: { error: "story not found" } };
  const buf = Buffer.from(dataBase64, "base64");
  if (buf.length > 25 * 1024 * 1024) return { status: 413, json: { error: "max 25 MB" } };
  const safe = String(filename).replace(/[^\w.() -]/g, "_").slice(-120);
  if (!existsSync(FILES_DIR)) mkdirSync(FILES_DIR, { recursive: true });
  const rel = `${Date.now()}_${safe}`;
  writeFileSync(join(FILES_DIR, rel), buf);
  const r = db.prepare("INSERT INTO attachments (storyId,filename,mime,size,path,uploadedById,createdDate) VALUES (?,?,?,?,?,?,?)")
    .run(s.id, safe, mime || "application/octet-stream", buf.length, rel, req.user.id, now());
  notify(s.assignedToId, req.user.id, `${req.user.displayName} attached "${safe}" to ${s.number}`, s.id);
  if (s.assignedToId !== req.user.id) mailNotify(s.assignedToId, {
    subject: `[${s.number}] file attached — ${safe}`,
    heading: "New attachment",
    intro: `<b>${escHtml(req.user.displayName)}</b> attached a file to <b>${escHtml(s.number)} — ${escHtml(s.name)}</b>.`,
    rows: [["File", safe], ["Size", `${Math.max(1, Math.round(buf.length / 1024))} KB`]],
    cta: { label: "Open board", url: `${PUBLIC_URL}/#/board/${s.projectId}` },
  });
  return { json: attachShape(db.prepare("SELECT * FROM attachments WHERE id=?").get(r.lastInsertRowid)) };
});

route("GET", "/api/files/(\\d+)/download", (req, [id], res) => {
  const a = db.prepare("SELECT * FROM attachments WHERE id=?").get(Number(id));
  if (!a) return { status: 404, json: { error: "not found" } };
  return { raw: readFileSync(join(FILES_DIR, a.path)), headers: {
    "Content-Type": a.mime, "Content-Disposition": `attachment; filename="${a.filename}"` } };
});

route("DELETE", "/api/files/(\\d+)", (req, [id]) => {
  const a = db.prepare("SELECT * FROM attachments WHERE id=?").get(Number(id));
  if (!a) return { status: 404, json: { error: "not found" } };
  if (req.user.role !== "ADMIN" && a.uploadedById !== req.user.id)
    return { status: 403, json: { error: "Only admins or the uploader can delete a file" } };
  try { unlinkSync(join(FILES_DIR, a.path)); } catch {}
  db.prepare("DELETE FROM attachments WHERE id=?").run(Number(id));
  return { json: { deleted: true } };
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

server.listen(PORT, HOST, () => console.log(`CoreKit Tracker → http://${HOST}:${PORT}`));
