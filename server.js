import express from "express";
import Stripe from "stripe";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16",
});

// Create a verification session
app.post("/create-session", async (req, res) => {
  try {
    const session = await stripe.identity.verificationSessions.create({
      type: "document",
      return_url: "http://localhost:5173/complete",
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Error creating verification session:", err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(5000, () => console.log("Backend running on http://localhost:5000"));
