// ============================================================
//  SUBSCRIPTION & PAYMENT SETTINGS  –  edit this file only
// ============================================================

export const TRIAL_DAYS = 60;   // free trial length (also set in firestore.rules → hasAccess())

// Features shown on every plan card
export const FEATURES = [
  "Unlimited cases & clients",
  "Document upload for every case",
  "Date-wise hearing report (PDF)",
  "Auto case numbers",
  "Works on mobile, tablet & computer"
];

// Prices are in INR. Change them freely.
export const PLANS = [
  { id: "monthly", name: "Monthly", price: 199,  days: 30,  period: "month", tag: "",                      best: false },
  { id: "yearly",  name: "Yearly",  price: 1499, days: 365, period: "year",  tag: "Best value · Save 37%", best: true  }
];

// Where customers send money. Subscriptions are activated after you verify the payment.
export const PAYMENT = {
  upiId: "yourupiid@bank",          // ← put your real UPI ID here
  payeeName: "Your Name",            // ← name shown in the UPI app
  paymentLink: "",                   // optional: Razorpay / Cashfree / PhonePe payment-link URL
  supportWhatsApp: "",               // optional: e.g. "919876543210" (country code + number, no +)
  supportEmail: ""                   // optional
};
