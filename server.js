import express from "express";
import Stripe from "stripe";
import cors from "cors";
import dotenv from "dotenv";
import {
  createVerificationRecord,
  updateVerificationStatus,
  getVerificationBySessionId,
  isEventProcessed,
  logAuditEvent,
  getStatistics,
  deleteUserData,
} from "./database.js";

dotenv.config();

const app = express();
app.use(cors());

// Environment configuration
const DEBUG_MODE = process.env.DEBUG_MODE === "true";

// Logging utility
const log = {
  info: (msg) => console.log(`ℹ️  ${msg}`),
  success: (msg) => console.log(`✅ ${msg}`),
  warn: (msg) => console.warn(`⚠️  ${msg}`),
  error: (msg) => console.error(`❌ ${msg}`),
  debug: (msg) => DEBUG_MODE && console.log(`🔍 ${msg}`),
};

// IMPORTANT: For webhook signature verification, we need raw body
// So we apply express.json() AFTER the webhook route
// (webhook route will use express.raw())

if (!process.env.STRIPE_SECRET_KEY) {
  log.error("STRIPE_SECRET_KEY missing in .env");
  process.exit(1);
}

if (!process.env.STRIPE_WEBHOOK_SECRET) {
  log.warn("STRIPE_WEBHOOK_SECRET missing - webhook signature verification DISABLED (INSECURE)");
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16",
});

// ==================== WEBHOOK ENDPOINT (MUST BE BEFORE express.json()) ====================
// This endpoint receives events from Stripe and MUST verify signatures

app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    log.debug(`Webhook received - Body length: ${req.body?.length}, Signature: ${!!sig}`);

    let event;

    try {
      // CRITICAL SECURITY: Verify webhook signature to prevent tampering
      if (!webhookSecret) {
        log.error("INSECURE: Webhook signature verification skipped - STRIPE_WEBHOOK_SECRET not set");
        // In POC without signature secret, parse manually (NEVER do this in production)
        event = JSON.parse(req.body.toString());
      } else {
        // SECURE: Verify the signature
        event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
        log.debug("Webhook signature verified");
      }

      // Log webhook receipt for audit trail
      logAuditEvent("webhook_received", event.data.object.id, {
        event_type: event.type,
        event_id: event.id,
      });

      // Idempotency check - don't process same event twice
      if (isEventProcessed(event.id)) {
        log.debug(`Event ${event.id} already processed - skipping`);
        return res.json({ received: true, status: "already_processed" });
      }

      // Handle the event based on type
      switch (event.type) {
        case "identity.verification_session.verified":
          await handleVerificationVerified(event.data.object);
          break;

        case "identity.verification_session.requires_input":
          await handleVerificationRequiresInput(event.data.object);
          break;

        case "identity.verification_session.processing":
          await handleVerificationProcessing(event.data.object);
          break;

        case "identity.verification_session.canceled":
          await handleVerificationCanceled(event.data.object);
          break;

        default:
          log.debug(`Unhandled event type: ${event.type}`);
      }

      // Return 200 immediately to acknowledge receipt
      res.json({ received: true });
    } catch (err) {
      log.error(`Webhook error: ${err.message}`);

      // Log detailed error information for signature verification failures
      if (err.type === 'StripeSignatureVerificationError') {
        log.error("Signature verification failed - check webhook secret configuration");
        log.debug(`Error details: ${err.stack}`);
      } else {
        log.debug(`Error stack: ${err.stack}`);
      }

      logAuditEvent("webhook_error", null, {
        error: err.message,
        error_type: err.type,
        error_code: err.code
      });
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }
  }
);

// Webhook handler functions
async function handleVerificationVerified(session) {
  log.info(`Verification verified: ${session.id}`);
  updateVerificationStatus(session.id, "verified", session.last_error?.code || null);

  // Note: We do NOT retrieve or store PII from Stripe
  // Document data, names, DOB stay in Stripe's vault
  // We only store: session_id, status, timestamps
}

async function handleVerificationRequiresInput(session) {
  log.warn(`Verification requires input: ${session.id}`);
  updateVerificationStatus(session.id, "requires_input", session.last_error?.code || null);
}

async function handleVerificationProcessing(session) {
  log.info(`Verification processing: ${session.id}`);
  updateVerificationStatus(session.id, "processing", null);
}

async function handleVerificationCanceled(session) {
  log.warn(`Verification canceled: ${session.id}`);
  updateVerificationStatus(session.id, "canceled", null);
}

// ==================== APPLY JSON PARSER (AFTER WEBHOOK) ====================
app.use(express.json());

// ==================== API ENDPOINTS ====================

// Create a verification session
app.post("/create-session", async (req, res) => {
  try {
    const frontendUrl = process.env.FRONTEND_URL;

    if (!frontendUrl) {
      return res.status(500).json({ error: "FRONTEND_URL is missing in .env" });
    }

    // Get user reference from request (in real app, this would be authenticated user ID)
    // For POC, we'll accept it from request or generate a test ID
    const userReference = req.body.userReference || `user_${Date.now()}`;

    // SECURITY: In production, userReference should be:
    // - Extracted from authenticated session (JWT, OAuth token)
    // - Hashed/pseudonymized (NOT raw email)
    // - Example: SHA256(user_email + salt) or internal user_id

    const session = await stripe.identity.verificationSessions.create({
      type: "document",
      return_url: `${frontendUrl}/complete`,
      metadata: {
        // Metadata is stored in Stripe, useful for linking
        user_reference: userReference,
      },
    });

    // Store in database (NO PII - only session_id and user reference)
    createVerificationRecord(session.id, userReference, "document");

    // Log for audit trail
    logAuditEvent("session_created", session.id, {
      user_reference: userReference,
      ip: req.ip,
    });

    log.info(`Verification session created: ${session.id}`);

    res.json({
      url: session.url,
      session_id: session.id,
    });
  } catch (err) {
    log.error(`Error creating verification session: ${err.message}`);
    logAuditEvent("session_creation_failed", null, { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Get verification status
app.get("/verification-status/:sessionId", async (req, res) => {
  try {
    const { sessionId } = req.params;

    // Get status from our database (no PII)
    const record = getVerificationBySessionId(sessionId);

    if (!record) {
      return res.status(404).json({ error: "Verification session not found" });
    }

    // Optionally fetch latest status from Stripe
    // (Useful if webhook delivery fails)
    const stripeSession = await stripe.identity.verificationSessions.retrieve(sessionId);

    // Update local status if different
    if (stripeSession.status !== record.status) {
      updateVerificationStatus(sessionId, stripeSession.status, "manual_sync");
      log.debug(`Status synced for session ${sessionId}: ${stripeSession.status}`);
    }

    res.json({
      session_id: record.session_id,
      status: stripeSession.status,
      created_at: record.created_at,
      verified_at: record.verified_at,
      // DO NOT send PII from Stripe session
      // verified_data is available in stripeSession but we don't expose it
    });
  } catch (err) {
    log.error(`Error fetching verification status: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Get statistics (for POC evaluation)
app.get("/stats", (req, res) => {
  try {
    const stats = getStatistics();
    res.json(stats);
  } catch (err) {
    log.error(`Error fetching stats: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// GDPR: Delete user data (Right to Erasure - Article 17)
app.delete("/user-data/:userReference", (req, res) => {
  try {
    const { userReference } = req.params;

    // Delete from our database
    deleteUserData(userReference);

    // Note: To be fully GDPR compliant, you should also:
    // 1. Delete data from Stripe (if possible)
    // 2. Log the deletion request
    // 3. Notify the user

    logAuditEvent("gdpr_deletion", null, {
      user_reference: userReference,
      ip: req.ip,
    });

    log.info(`User data deleted: ${userReference}`);

    res.json({ message: "User data deleted successfully" });
  } catch (err) {
    log.error(`Error deleting user data: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  log.success(`Backend running on http://localhost:${PORT}`);
  log.info("Endpoints:");
  log.info("   POST /create-session - Create verification session");
  log.info("   POST /webhook - Stripe webhook (signature verified)");
  log.info("   GET  /verification-status/:sessionId - Check status");
  log.info("   GET  /stats - Get statistics");
  log.info("   DELETE /user-data/:userReference - GDPR deletion");
  log.info("   GET  /health - Health check");

  if (DEBUG_MODE) {
    log.debug("Debug mode enabled - verbose logging active");
  }
});
