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

// IMPORTANT: For webhook signature verification, we need raw body
// So we apply express.json() AFTER the webhook route
// (webhook route will use express.raw())

if (!process.env.STRIPE_SECRET_KEY) {
  console.error("❌ STRIPE_SECRET_KEY missing in .env");
  process.exit(1);
}

if (!process.env.STRIPE_WEBHOOK_SECRET) {
  console.warn("⚠️  STRIPE_WEBHOOK_SECRET missing - webhook signature verification DISABLED (INSECURE)");
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

    let event;

    try {
      // CRITICAL SECURITY: Verify webhook signature to prevent tampering
      if (!webhookSecret) {
        console.error("⚠️  INSECURE: Webhook signature verification skipped - STRIPE_WEBHOOK_SECRET not set");
        // In POC without signature secret, parse manually (NEVER do this in production)
        event = JSON.parse(req.body.toString());
      } else {
        // SECURE: Verify the signature
        event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
        console.log("✅ Webhook signature verified");
      }

      // Log webhook receipt for audit trail
      logAuditEvent("webhook_received", event.data.object.id, {
        event_type: event.type,
        event_id: event.id,
      });

      // Idempotency check - don't process same event twice
      if (isEventProcessed(event.id)) {
        console.log(`ℹ️  Event ${event.id} already processed - skipping`);
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
          console.log(`ℹ️  Unhandled event type: ${event.type}`);
      }

      // Return 200 immediately to acknowledge receipt
      res.json({ received: true });
    } catch (err) {
      console.error("❌ Webhook error:", err.message);
      logAuditEvent("webhook_error", null, { error: err.message });
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }
  }
);

// Webhook handler functions
async function handleVerificationVerified(session) {
  console.log(`✅ Verification VERIFIED: ${session.id}`);
  updateVerificationStatus(session.id, "verified", session.last_error?.code || null);

  // Note: We do NOT retrieve or store PII from Stripe
  // Document data, names, DOB stay in Stripe's vault
  // We only store: session_id, status, timestamps
}

async function handleVerificationRequiresInput(session) {
  console.log(`⚠️  Verification REQUIRES INPUT: ${session.id}`);
  updateVerificationStatus(session.id, "requires_input", session.last_error?.code || null);
}

async function handleVerificationProcessing(session) {
  console.log(`⏳ Verification PROCESSING: ${session.id}`);
  updateVerificationStatus(session.id, "processing", null);
}

async function handleVerificationCanceled(session) {
  console.log(`❌ Verification CANCELED: ${session.id}`);
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

    res.json({
      url: session.url,
      session_id: session.id,
    });
  } catch (err) {
    console.error("❌ Error creating verification session:", err);
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
    console.error("❌ Error fetching verification status:", err);
    res.status(500).json({ error: err.message });
  }
});

// Get statistics (for POC evaluation)
app.get("/stats", (req, res) => {
  try {
    const stats = getStatistics();
    res.json(stats);
  } catch (err) {
    console.error("❌ Error fetching stats:", err);
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

    res.json({ message: "User data deleted successfully" });
  } catch (err) {
    console.error("❌ Error deleting user data:", err);
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.listen(5000, () => {
  console.log("✅ Backend running on http://localhost:5000");
  console.log("📊 Endpoints:");
  console.log("   POST /create-session - Create verification session");
  console.log("   POST /webhook - Stripe webhook (signature verified)");
  console.log("   GET  /verification-status/:sessionId - Check status");
  console.log("   GET  /stats - Get statistics");
  console.log("   DELETE /user-data/:userReference - GDPR deletion");
});
