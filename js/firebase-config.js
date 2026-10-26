// Firebase initialisation (modular SDK loaded from Google's CDN – no build step needed)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

// NOTE: These web-app keys are not secret. Your data is protected by
// firestore.rules (deploy them!), not by hiding this object.
const firebaseConfig = {
  apiKey: "AIzaSyC2Dx1J4_F_JUeZC_96Hg9yfq4k7aJ2cyg",
  authDomain: "lawyercasediarypro-f13ecd27.firebaseapp.com",
  projectId: "lawyercasediarypro-f13ecd27",
  storageBucket: "lawyercasediarypro-f13ecd27.firebasestorage.app",
  messagingSenderId: "413124660797",
  appId: "1:413124660797:web:c9022fd0ccc1ae3fdca454"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
