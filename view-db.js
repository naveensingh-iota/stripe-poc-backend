import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const db = new Database(path.join(__dirname, "verification.db"));

console.log("\n📊 VERIFICATION SESSIONS");
console.log("=".repeat(80));

const sessions = db.prepare(`
  SELECT
    session_id,
    user_reference,
    status,
    verification_type,
    created_at,
    verified_at
  FROM verification_sessions
  ORDER BY created_at DESC
  LIMIT 20
`).all();

if (sessions.length === 0) {
  console.log("No verification sessions found.");
} else {
  console.table(sessions);
}

console.log("\n📋 STATISTICS");
console.log("=".repeat(80));

const stats = {
  total: db.prepare("SELECT COUNT(*) as count FROM verification_sessions").get().count,
  verified: db.prepare("SELECT COUNT(*) as count FROM verification_sessions WHERE status = 'verified'").get().count,
  processing: db.prepare("SELECT COUNT(*) as count FROM verification_sessions WHERE status = 'processing'").get().count,
  requires_input: db.prepare("SELECT COUNT(*) as count FROM verification_sessions WHERE status = 'requires_input'").get().count,
  canceled: db.prepare("SELECT COUNT(*) as count FROM verification_sessions WHERE status = 'canceled'").get().count,
};

console.log(`Total Sessions:    ${stats.total}`);
console.log(`✅ Verified:       ${stats.verified}`);
console.log(`⏳ Processing:     ${stats.processing}`);
console.log(`⚠️  Requires Input: ${stats.requires_input}`);
console.log(`❌ Canceled:       ${stats.canceled}`);

console.log("\n📝 RECENT AUDIT LOG");
console.log("=".repeat(80));

const auditLog = db.prepare(`
  SELECT
    event_type,
    session_id,
    timestamp,
    result
  FROM audit_log
  ORDER BY timestamp DESC
  LIMIT 10
`).all();

if (auditLog.length === 0) {
  console.log("No audit log entries found.");
} else {
  console.table(auditLog);
}

db.close();
console.log("\n");
