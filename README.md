# ⚖️ Lawyer Case Diary

Case register, hearing diary and document vault for advocates.
Plain HTML/CSS/JS (no build step) + Firebase Authentication and Cloud Firestore.

## Features
- Advocate sign-up / login, password reset
- Cases: client, appellant, respondent, case type, section, court, division, district, tehsil, village, khasra, next hearing, status/disposal date, notes
- Auto case number per advocate (`CD/2026/0001`), edit and delete
- **Documents stored inside Firestore** (PDF/image/Word, max 5 MB each) – no Firebase Storage / Blaze plan needed
- Dashboard, upcoming-hearings panel, "date passed" warnings, search and filters
- Hearings report: browser Print → Save as PDF (date-wise, Hindi/Urdu safe)
- **60-day free trial**, then a plans → cart → checkout screen (UPI payment, activated by you)
- Installable app (PWA manifest + service worker) – ready to convert to APK

## Files
```
index.html, manifest.json, sw.js
css/style.css
js/app.js, js/config.js, js/firebase-config.js
icons/icon-192.png, icons/icon-512.png
firestore.rules, firebase.json
```

## Firebase setup (Storage is NOT needed)
1. Authentication → Sign-in method → enable **Email/Password**.
2. Firestore Database → Create database (production mode).
3. Firestore → **Rules** tab → paste `firestore.rules` → **Publish**.
4. Authentication → Settings → Authorized domains → add your hosting domain.

## Your settings: `js/config.js`
Set your **UPI ID**, payee name, plan prices, and optionally a payment-link URL / WhatsApp number.

## Activating a paid subscription (manual, after you verify payment)
Customers submit a payment request (Firestore → collection `orders`). After the money reaches your account:
1. Firestore → `advocates` → open the customer's document (match the `email`).
2. Add field **`subscribedUntil`**, type **timestamp**, set to the end date (today + 30 or + 365 days).
3. Optional: in the `orders` document set `status` to `approved`.
The customer's app unlocks by itself. Customers cannot edit these fields, and the rules stop saving
new data once the trial/subscription has ended.

## Convert to APK
1. Host the app on HTTPS (GitHub Pages / Firebase Hosting / Vercel) and add the domain to Firebase Authorized domains.
2. Go to https://www.pwabuilder.com → enter your URL → Package for Android → download the APK/AAB.
Play Store note: Google requires Play Billing for in-app subscriptions of digital services. Manual UPI is fine
for direct APK distribution, but a Play Store listing must follow Google's payment policy.

## Run locally
```bash
python3 -m http.server 8080   # open http://localhost:8080
```
