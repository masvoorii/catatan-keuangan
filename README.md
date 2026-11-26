# Catatan Keuangan — Personal Expense & Envelope Budgeting Tracker 💰📊

![HTML5](https://img.shields.io/badge/HTML5-Single_File_App-E34F26?style=flat-square&logo=html5&logoColor=white)
![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-Dark_&_Light_Mode-06B6D4?style=flat-square&logo=tailwindcss&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-ES6+_Modules-F7DF1E?style=flat-square&logo=javascript&logoColor=black)
![Firebase](https://img.shields.io/badge/Firebase-Realtime_Database-FFCA28?style=flat-square&logo=firebase&logoColor=black)

A lightweight, offline-first **personal finance and envelope budgeting web application** built as a zero-build single-page app using **HTML5**, **Tailwind CSS**, **Vanilla JS (ES6+ Modules)**, and **Firebase Realtime Database**. Designed to track multi-account balances, manage weekly cash envelopes with rollover logic, and synchronize records seamlessly across devices.

---

### ✨ Key Features

- **🔐 Multi-Profile Access & Client-Side SHA-256 Auth:**
  - Supports multiple isolated user profiles protected by password hashing via the browser's native **Web Crypto API (`SHA-256`)**.
  - Includes account creation with custom initial balances, password updates, session locking, and profile reset/deletion.
- **☁️ Real-Time Cloud Sync & Offline Resilience:**
  - Synchronizes balances, envelopes, and transaction logs instantaneously via **Firebase Realtime Database** while maintaining a `localStorage` mirror for uninterrupted offline access.
- **✉️ Weekly Envelope Budgeting & Rollover System:**
  - Allocates weekly cash budgets (`Minggu 1–4`) with sequential unlocking and automatic calculation of unspent remainders into a **Rollover Balance** (`Saldo Rollover`) or dedicated savings goals.
- **💳 Multi-Account Balance & Progress Tracking:**
  - Tracks individual account balances, remaining budget percentages with visual progress bars, and separate reward points/coins.
- **⚡ Quick Presets, Filtering & JSON Backup:**
  - One-click expense presets for frequent daily spending, full transaction CRUD (`Add`, `Edit`, `Delete` with automatic balance reconciliation), account/keyword search filtering, Dark/Light mode toggle, and full `.json` data export/import.

---

### 🛠️ Tech Stack

- **Frontend:** Semantic HTML5, Vanilla JavaScript (ES6+ Modules), Tailwind CSS (with class-based Dark Mode)
- **Database & Sync:** Firebase Realtime Database (`v10.12.2` Modular SDK) + Browser `localStorage`
- **Security:** Native Web Crypto API (`SHA-256` password hashing)

---

### 🚀 Getting Started

1. **Clone the repository:**
   ```bash
   git clone [https://github.com/masvoorii/catatan-keuangan.git](https://github.com/masvoorii/catatan-keuangan.git)
   cd catatan-keuangan
   ```

2. **Configure Firebase (Optional for Custom Deployment):**
   Update `FIREBASE_CONFIG` and `DB_PATH` inside the `<script type="module">` block in `index.html` if connecting to your own Firebase Realtime Database instance.

3. **Launch the Application:**
   Open `index.html` directly in any modern web browser or host it statically (e.g., via GitHub Pages).
