# ⚖️ Lawyer Case Diary

A web app for advocates to record case details for their clients, upload documents,
and download a date-wise PDF of upcoming hearings.

**Stack:** plain HTML/CSS/JavaScript (no build step) + Firebase Authentication, Cloud Firestore and Cloud Storage.

## Features

- Advocate sign-up / login (email + password, password reset)
- Add, edit and delete cases with: client name, appellant, respondent, case type, legal section,
  court name, division, district, tehsil, village, khasra number, next hearing date,
  status (Pending / Disposed + disposal date) and notes
- **Auto-generated unique case number** per advocate, e.g. `CD/2026/0001` (safe counter using a Firestore transaction)
- Upload / remove documents (PDF, images, Word, text – max 10 MB each) stored in Firebase Storage
- Search and status filter, dashboard counters
- **PDF report of upcoming hearings, grouped by date** for the logged-in advocate (supports Hindi/Urdu text)
- Every advocate sees only their own data (enforced by security rules)

## Project structure

```
lawyer-case-diary/
├── index.html
├── css/style.css
├── js/
│   ├── firebase-config.js   ← your Firebase keys
│   └── app.js               ← all application logic
├── firestore.rules
├── storage.rules
├── firebase.json
├── .gitignore
└── README.md
```

## One-time Firebase setup (Firebase Console → project `lawyercasediarypro-f13ecd27`)

1. **Authentication → Sign-in method** → enable **Email/Password**.
2. **Firestore Database → Create database** (production mode, choose a region such as `asia-south1`).
3. **Storage → Get started** (Firebase may ask you to upgrade to the Blaze pay-as-you-go plan to use
   Storage; the free usage quota is generous, but check the current terms on the Firebase pricing page).
4. **Publish the security rules** – this step is essential:
   - Firestore → Rules → paste the contents of `firestore.rules` → Publish
   - Storage → Rules → paste the contents of `storage.rules` → Publish
5. **Authentication → Settings → Authorized domains** → add the domain where you host the app
   (e.g. `yourname.github.io`, or your Vercel/Netlify domain). `localhost` is already allowed.

> The Firebase `apiKey` in `firebase-config.js` is a public web identifier, not a secret.
> Your data is protected by the rules in step 4.

## Run locally

ES modules need a web server (opening `index.html` by double-click will not work):

```bash
cd lawyer-case-diary
python3 -m http.server 8080
# open http://localhost:8080
```

## Deploy

**GitHub Pages:** push to GitHub → Settings → Pages → Deploy from branch → `main` / root.
Then add `<username>.github.io` to Firebase Authorized domains.

**Firebase Hosting (optional):**

```bash
npm i -g firebase-tools
firebase login
firebase use lawyercasediarypro-f13ecd27
firebase deploy
```

## Notes

- Case numbers are numbered per advocate per calendar year. Deleting a case does not reuse its number.
- Deleting a case also deletes its uploaded files.
- The PDF is generated in the browser, so no server is needed.
