# ⚡ SparksChat

> **Anonymous real-time 1-on-1 random chat web & mobile application** with ephemeral messaging, WebRTC peer-to-peer voice calling, media sharing, and automated trust & safety moderation.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org/)
[![Socket.IO](https://img.shields.io/badge/Socket.IO-4.8.1-black.svg)](https://socket.io/)
[![WebRTC](https://img.shields.io/badge/WebRTC-Audio%20P2P-orange.svg)](https://webrtc.org/)
[![Capacitor](https://img.shields.io/badge/Capacitor-Android%208.5-blueviolet.svg)](https://capacitorjs.com/)

---

## 🌟 Highlights & Features

- **Instant 1-on-1 Stranger Matchmaking:** Ephemeral matching queue with mutual block-list exclusion.
- **Privacy & Anonymity First:** Zero account registration, zero database tracking, and zero conversation logs.
- **🔞 18+ Age Verification & Community Guidelines:** Strict Age Gate modal and an 8-rule inline community safety accordion drawer.
- **Real-Time Ephemeral Text Chat:** Socket.IO powered messaging with live typing indicator.
- **Media & File Sharing (Up to 10MB):** Image and document sharing with an automatic **sensitive content blur** and full-screen **lightbox zoom**.
- **Voice Notes & Live WebRTC Voice Calling:** One-tap voice note recording plus peer-to-peer live WebRTC voice calling with animated audio visualizer.
- **Trust & Safety Moderation:**
  - Automated regex text filter intercepting external spam, phishing links, and abuse before transmission.
  - User reporting modal with categorized abuse reporting (*harassment*, *inappropriate*, *spam*, *underage*).
  - One-click blocking preventing users from ever pairing together again.
  - **3-Strike Automated Cooldown:** Automatically applies a temporary 30-minute restriction to abusive actors.
- **Protected Admin Dashboard:** Real-time metrics and reports log review at `/admin/reports?key=sparksAdmin2026`.
- **Installable PWA & Native Android Support:** Includes `manifest.json`, Service Worker, and `@capacitor/android` configuration.

---

## 🚀 Quick Start

### 1. Clone & Install Dependencies
```bash
git clone https://github.com/ansarpersonal001-dotcom/sparkschat.git
cd sparkschat
npm install
```

### 2. Start the Server
```bash
npm start
```
SparksChat will be running locally at: **`http://localhost:3000`**

---

## 🧪 Verification & Automated Testing

### A. Technical SEO & Schema Verification
Verifies `<title>`, description snippets, Open Graph tags, Twitter Cards, Schema.org WebApplication JSON-LD, `robots.txt`, and `sitemap.xml`:
```bash
node test/verify_seo.js
```

### B. Headless Multi-Client Simulation Test
Launches automated concurrent virtual clients testing matchmaking, content moderation regex filters, mutual block exclusion, 3-strike auto-cooldowns, and admin endpoints:
```bash
npm run test:sim
```

---

## 📱 Mobile App (Capacitor Android)

To build and sync the native Android project:
```bash
npm run cap:sync
npm run cap:open
```

---

## 📁 Project Structure

```
Sparkschat/
├── public/                  # Frontend client assets
│   ├── css/style.css        # Responsive glassmorphism styling
│   ├── js/app.js            # Client chat controller, WebRTC & PWA
│   ├── icons/               # PWA icons & Open Graph social banner
│   ├── index.html           # Main chat app interface & SEO schema
│   ├── guidelines.html      # Standalone Community Guidelines page
│   ├── manifest.json        # Progressive Web App manifest
│   ├── sw.js                # Service Worker for offline asset caching
│   ├── robots.txt           # Search crawler directives
│   └── sitemap.xml          # XML sitemap
├── server.js                # Express & Socket.IO server with safety moderation
├── test/
│   ├── simulate_chat.js     # Automated headless moderation simulation
│   └── verify_seo.js        # Technical SEO test suite
├── android/                 # Capacitor Android native project
├── package.json             # Scripts & dependencies
└── README.md                # Documentation
```

---

## 🛡️ License

This project is licensed under the [MIT License](LICENSE).
