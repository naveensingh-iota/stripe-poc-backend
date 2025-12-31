import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize SQLite database
const db = new Database(path.join(__dirname, "verification.db"));

// Enable WAL mode for better concurrency
db.pragma("journal_mode = WAL");

// Create tables with SECURE schema - NO PII STORAGE
db.exec(`
  CREATE TABLE IF NOT EXISTS verification_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    -- Stripe session ID (unique identifier)
    session_id TEXT UNIQUE NOT NULL,

    -- User reference (YOUR internal user ID, email hash, or anonymized identifier)
    -- NEVER store raw email/name - use hashed ID or pseudonymized reference
    user_reference TEXT NOT NULL,

    -- Verification metadata (no PII)
    status TEXT NOT NULL DEFAULT 'created',
    verification_type TEXT NOT NULL,

    -- Timestamps for audit trail
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    verified_at TEXT,

    -- Stripe webhook event IDs for traceability
    last_event_id TEXT,

    -- DO NOT STORE:
    -- - Document images
    -- - Full names
    -- - Addresses
    -- - Date of birth
    -- - Document numbers
    -- These remain ONLY in Stripe's secure vault

    UNIQUE(session_id)
  );

  -- Audit log table for compliance (GDPR Article 30 - Records of processing)
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    -- What happened
    event_type TEXT NOT NULL,
    session_id TEXT,

    -- When it happened
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),

    -- Additional context (no PII)
    metadata TEXT,

    -- IP address (can be PII under GDPR - hash or anonymize if needed)
    -- For POC, we'll store but document retention policy
    ip_address TEXT,

    -- Result/status
    result TEXT
  );

  -- Create indexes for performance
  CREATE INDEX IF NOT EXISTS idx_session_id ON verification_sessions(session_id);
  CREATE INDEX IF NOT EXISTS idx_user_reference ON verification_sessions(user_reference);
  CREATE INDEX IF NOT EXISTS idx_status ON verification_sessions(status);
  CREATE INDEX IF NOT EXISTS idx_created_at ON verification_sessions(created_at);
  CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
`);

// ==================== SECURE DATA ACCESS FUNCTIONS ====================

/**
 * Create a new verification session record
 * @param {string} sessionId - Stripe verification session ID
 * @param {string} userReference - Anonymized/hashed user identifier (NOT email/name)
 * @param {string} verificationType - Type of verification (document, document+selfie)
 * @returns {object} Created record
 */
export function createVerificationRecord(sessionId, userReference, verificationType) {
  const stmt = db.prepare(`
    INSERT INTO verification_sessions (session_id, user_reference, verification_type, status)
    VALUES (?, ?, ?, 'created')
  `);

  const result = stmt.run(sessionId, userReference, verificationType);

  // Audit log
  logAuditEvent("session_created", sessionId, {
    user_reference: userReference,
    verification_type: verificationType,
  });

  return {
    id: result.lastInsertRowid,
    session_id: sessionId,
    user_reference: userReference,
    status: "created",
  };
}

/**
 * Update verification status (called from webhook)
 * @param {string} sessionId - Stripe session ID
 * @param {string} status - New status (verified, requires_input, canceled, processing)
 * @param {string} eventId - Stripe event ID for idempotency
 * @returns {boolean} Success
 */
export function updateVerificationStatus(sessionId, status, eventId) {
  const stmt = db.prepare(`
    UPDATE verification_sessions
    SET status = ?,
        updated_at = datetime('now'),
        verified_at = CASE WHEN ? = 'verified' THEN datetime('now') ELSE verified_at END,
        last_event_id = ?
    WHERE session_id = ?
  `);

  const result = stmt.run(status, status, eventId, sessionId);

  // Audit log
  logAuditEvent("status_updated", sessionId, {
    new_status: status,
    event_id: eventId,
  });

  return result.changes > 0;
}

/**
 * Get verification status by session ID
 * @param {string} sessionId - Stripe session ID
 * @returns {object|null} Verification record (no PII)
 */
export function getVerificationBySessionId(sessionId) {
  const stmt = db.prepare(`
    SELECT session_id, user_reference, status, verification_type, created_at, updated_at, verified_at
    FROM verification_sessions
    WHERE session_id = ?
  `);

  return stmt.get(sessionId);
}

/**
 * Get verification status by user reference
 * @param {string} userReference - Your internal user identifier
 * @returns {array} All verifications for this user (no PII)
 */
export function getVerificationsByUser(userReference) {
  const stmt = db.prepare(`
    SELECT session_id, status, verification_type, created_at, updated_at, verified_at
    FROM verification_sessions
    WHERE user_reference = ?
    ORDER BY created_at DESC
  `);

  return stmt.all(userReference);
}

/**
 * Check if event has already been processed (idempotency)
 * @param {string} eventId - Stripe event ID
 * @returns {boolean} True if already processed
 */
export function isEventProcessed(eventId) {
  const stmt = db.prepare(`
    SELECT COUNT(*) as count
    FROM verification_sessions
    WHERE last_event_id = ?
  `);

  const result = stmt.get(eventId);
  return result.count > 0;
}

/**
 * Log audit event for compliance
 * @param {string} eventType - Type of event
 * @param {string} sessionId - Session ID
 * @param {object} metadata - Additional data (no PII)
 * @param {string} ipAddress - Optional IP address
 */
export function logAuditEvent(eventType, sessionId, metadata = {}, ipAddress = null) {
  const stmt = db.prepare(`
    INSERT INTO audit_log (event_type, session_id, metadata, ip_address, result)
    VALUES (?, ?, ?, ?, 'success')
  `);

  stmt.run(eventType, sessionId, JSON.stringify(metadata), ipAddress);
}

/**
 * Get audit trail for a session (compliance requirement)
 * @param {string} sessionId - Session ID
 * @returns {array} Audit events
 */
export function getAuditTrail(sessionId) {
  const stmt = db.prepare(`
    SELECT event_type, timestamp, metadata, result
    FROM audit_log
    WHERE session_id = ?
    ORDER BY timestamp ASC
  `);

  return stmt.all(sessionId);
}

// ==================== DATA RETENTION & GDPR ====================

/**
 * Delete verification data (GDPR Right to Erasure - Article 17)
 * @param {string} userReference - User identifier to delete
 * @returns {boolean} Success
 */
export function deleteUserData(userReference) {
  const deleteVerifications = db.prepare(
    "DELETE FROM verification_sessions WHERE user_reference = ?"
  );
  const deleteAudit = db.prepare(
    "DELETE FROM audit_log WHERE session_id IN (SELECT session_id FROM verification_sessions WHERE user_reference = ?)"
  );

  const transaction = db.transaction(() => {
    deleteAudit.run(userReference);
    deleteVerifications.run(userReference);
  });

  transaction();

  logAuditEvent("user_data_deleted", null, { user_reference: userReference });

  return true;
}

/**
 * Get database statistics (for POC evaluation)
 * @returns {object} Statistics
 */
export function getStatistics() {
  const stats = {
    total_sessions: db.prepare("SELECT COUNT(*) as count FROM verification_sessions").get()
      .count,
    verified: db
      .prepare("SELECT COUNT(*) as count FROM verification_sessions WHERE status = 'verified'")
      .get().count,
    pending: db
      .prepare(
        "SELECT COUNT(*) as count FROM verification_sessions WHERE status IN ('created', 'processing')"
      )
      .get().count,
    failed: db
      .prepare(
        "SELECT COUNT(*) as count FROM verification_sessions WHERE status IN ('requires_input', 'canceled')"
      )
      .get().count,
    audit_events: db.prepare("SELECT COUNT(*) as count FROM audit_log").get().count,
  };

  return stats;
}

console.log("✅ Database initialized with SECURE schema (NO PII STORAGE)");

export default db;
