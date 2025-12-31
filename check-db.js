// Quick script to check database contents
import Database from 'better-sqlite3';

const db = new Database('verification.db');

console.log('\n========================================');
console.log('📊 VERIFICATION SESSIONS');
console.log('========================================\n');

const sessions = db.prepare('SELECT * FROM verification_sessions').all();
if (sessions.length === 0) {
  console.log('No sessions found.');
} else {
  sessions.forEach(session => {
    console.log(`Session ID: ${session.session_id}`);
    console.log(`User: ${session.user_reference}`);
    console.log(`Type: ${session.verification_type}`);
    console.log(`Status: ${session.status}`);
    console.log(`Created: ${session.created_at}`);
    console.log(`Verified: ${session.verified_at || 'N/A'}`);
    console.log(`Error: ${session.error_reason || 'N/A'}`);
    console.log('---');
  });
}

console.log('\n========================================');
console.log('📝 AUDIT LOG (Last 20 events)');
console.log('========================================\n');

const auditLog = db.prepare('SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT 20').all();
if (auditLog.length === 0) {
  console.log('No audit events found.');
} else {
  auditLog.forEach(event => {
    console.log(`[${event.timestamp}] ${event.event_type}`);
    console.log(`  Session: ${event.session_id || 'N/A'}`);
    console.log(`  Details: ${event.event_data}`);
    console.log('---');
  });
}

console.log('\n========================================');
console.log('📈 STATISTICS');
console.log('========================================\n');

const stats = db.prepare(`
  SELECT
    COUNT(*) as total,
    SUM(CASE WHEN status = 'verified' THEN 1 ELSE 0 END) as verified,
    SUM(CASE WHEN status = 'requires_input' THEN 1 ELSE 0 END) as requires_input,
    SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) as processing,
    SUM(CASE WHEN status = 'canceled' THEN 1 ELSE 0 END) as canceled,
    SUM(CASE WHEN status = 'created' THEN 1 ELSE 0 END) as created
  FROM verification_sessions
`).get();

console.log(`Total Sessions: ${stats.total}`);
console.log(`✅ Verified: ${stats.verified}`);
console.log(`⚠️  Requires Input: ${stats.requires_input}`);
console.log(`🔄 Processing: ${stats.processing}`);
console.log(`❌ Canceled: ${stats.canceled}`);
console.log(`📝 Created: ${stats.created}`);

const auditCount = db.prepare('SELECT COUNT(*) as count FROM audit_log').get();
console.log(`\n📊 Total Audit Events: ${auditCount.count}`);

db.close();
console.log('\n========================================\n');
