import Stripe from "stripe";
import dotenv from "dotenv";

dotenv.config();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

console.log("🧪 Webhook Configuration Test\n");

// 1. Check if webhook secret is configured
console.log("1️⃣ Checking webhook secret:");
if (process.env.STRIPE_WEBHOOK_SECRET) {
  console.log("   ✅ STRIPE_WEBHOOK_SECRET is set");
  console.log(`   📝 Secret starts with: ${process.env.STRIPE_WEBHOOK_SECRET.substring(0, 10)}...`);
} else {
  console.log("   ❌ STRIPE_WEBHOOK_SECRET is NOT set");
}

// 2. List all webhook endpoints configured in Stripe
console.log("\n2️⃣ Fetching webhook endpoints from Stripe:");
try {
  const webhookEndpoints = await stripe.webhookEndpoints.list({ limit: 10 });

  if (webhookEndpoints.data.length === 0) {
    console.log("   ⚠️  No webhook endpoints configured in Stripe");
    console.log("   👉 Go to: https://dashboard.stripe.com/test/webhooks");
  } else {
    console.log(`   Found ${webhookEndpoints.data.length} webhook endpoint(s):\n`);

    webhookEndpoints.data.forEach((endpoint, index) => {
      console.log(`   Endpoint ${index + 1}:`);
      console.log(`   - URL: ${endpoint.url}`);
      console.log(`   - Status: ${endpoint.status}`);
      console.log(`   - Secret: whsec_${endpoint.secret.substring(7, 17)}...`);
      console.log(`   - Events: ${endpoint.enabled_events.join(", ")}`);
      console.log(`   - API Version: ${endpoint.api_version}`);

      // Check if secret matches
      if (process.env.STRIPE_WEBHOOK_SECRET === endpoint.secret) {
        console.log(`   ✅ SECRET MATCHES your .env file!`);
      } else {
        console.log(`   ⚠️  Secret DOES NOT match your .env file`);
      }
      console.log("");
    });
  }
} catch (error) {
  console.error("   ❌ Error fetching webhook endpoints:", error.message);
}

// 3. Check what your ngrok URL should be
console.log("\n3️⃣ Expected webhook configuration:");
console.log("   Your ngrok URL should be something like:");
console.log("   https://xxxx-xxx-xxx-xxx.ngrok-free.app/webhook");
console.log("");
console.log("   Make sure this matches EXACTLY in Stripe Dashboard!");

// 4. Test webhook events to listen for
console.log("\n4️⃣ Events you should enable in Stripe Dashboard:");
const requiredEvents = [
  "identity.verification_session.verified",
  "identity.verification_session.requires_input",
  "identity.verification_session.processing",
  "identity.verification_session.canceled"
];
console.log("   " + requiredEvents.join("\n   "));

console.log("\n\n🎯 Next Steps:");
console.log("1. Make sure your server is running: npm start");
console.log("2. Make sure ngrok is running: ngrok http 5000");
console.log("3. Copy your ngrok URL and add '/webhook' to it");
console.log("4. Go to Stripe Dashboard > Webhooks > Add endpoint");
console.log("5. Paste the URL and select the events above");
console.log("6. Copy the signing secret and update .env file");
console.log("7. Restart your server");
