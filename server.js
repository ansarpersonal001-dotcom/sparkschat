const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Enable JSON body parsing for admin actions
app.use(express.json());

// Configure Socket.IO with 10MB buffer size
const io = new Server(server, {
  maxHttpBufferSize: 10 * 1024 * 1024, // 10MB
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'sparksAdmin2026';

// Ensure logs directory exists for reports
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}
const reportsFilePath = path.join(logsDir, 'reports.json');

// In-Memory State
let waitingQueue = []; // Array of socket IDs
const activePairs = new Map(); // socket.id -> partnerSocket.id
const userProfiles = new Map(); // socket.id -> { name, age, gender, avatar }
const socketToSession = new Map(); // socket.id -> sessionId
const userBlocks = new Map(); // sessionId -> Set(blockedSessionId)
const activeCooldowns = new Map(); // sessionId -> { expiresAt, reason, reportCount }

// Load existing reports or initialize
let reportsLog = [];
if (fs.existsSync(reportsFilePath)) {
  try {
    reportsLog = JSON.parse(fs.readFileSync(reportsFilePath, 'utf8'));
  } catch (err) {
    reportsLog = [];
  }
}

function persistReports() {
  try {
    fs.writeFileSync(reportsFilePath, JSON.stringify(reportsLog, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save reports log:', err);
  }
}

// Helper: Check if session is in active cooldown
function isSessionInCooldown(sessionId) {
  if (!sessionId) return null;
  const cooldown = activeCooldowns.get(sessionId);
  if (!cooldown) return null;

  if (Date.now() > cooldown.expiresAt) {
    activeCooldowns.delete(sessionId);
    return null;
  }
  const remainingMins = Math.ceil((cooldown.expiresAt - Date.now()) / (60 * 1000));
  return { ...cooldown, remainingMins };
}

// Lightweight Content Moderation: Text filter for spam links & severe abuse
const SPAM_PATTERNS = [
  /t\.me\/[a-zA-Z0-9_+]+/i,
  /wa\.me\/[0-9]+/i,
  /bit\.ly\/[a-zA-Z0-9]+/i,
  /discord\.gg\/[a-zA-Z0-9]+/i,
  /cash\.app\/\$[a-zA-Z0-9]+/i,
  /tinyurl\.com\/[a-zA-Z0-9]+/i,
  /\b(?:free\s+crypto|free\s+bitcoin|whatsapp\s+me|telegram\s+me)\b/i
];

const BANNED_WORDS = [
  /\bnigger\b/i,
  /\bfaggot\b/i,
  /\bkike\b/i,
  /\bchink\b/i,
  /\bchild\s*porn\b/i,
  /\bcp\s*links?\b/i
];

function checkMessageSafety(text) {
  for (const pattern of SPAM_PATTERNS) {
    if (pattern.test(text)) {
      return { safe: false, reason: 'Spam, advertising, or external links are prohibited.' };
    }
  }
  for (const pattern of BANNED_WORDS) {
    if (pattern.test(text)) {
      return { safe: false, reason: 'Hate speech or severe harassment is strictly prohibited.' };
    }
  }
  return { safe: true };
}

// Helper: Profile Sanitization
function sanitizeProfile(raw) {
  if (!raw || typeof raw !== 'object') {
    return { name: 'Stranger', age: '', gender: '', avatar: '' };
  }
  const name = typeof raw.name === 'string' && raw.name.trim()
    ? raw.name.trim().slice(0, 30)
    : 'Stranger';
  const age = raw.age ? (parseInt(raw.age, 10) || '') : '';
  const gender = typeof raw.gender === 'string' ? raw.gender.slice(0, 20) : '';
  const avatar = typeof raw.avatar === 'string' && raw.avatar.startsWith('data:image/') && raw.avatar.length <= 3 * 1024 * 1024
    ? raw.avatar
    : '';
  return { name, age, gender, avatar };
}

function removeFromQueue(socketId) {
  waitingQueue = waitingQueue.filter(id => id !== socketId);
}

function unpair(socketId, notifyPartner = true, reason = 'Stranger has disconnected.') {
  const partnerId = activePairs.get(socketId);
  if (partnerId) {
    activePairs.delete(socketId);
    activePairs.delete(partnerId);

    if (notifyPartner) {
      const partnerSocket = io.sockets.sockets.get(partnerId);
      if (partnerSocket) {
        partnerSocket.emit('voice_call_end');
        partnerSocket.emit('stranger_disconnected', {
          reason,
          timestamp: Date.now()
        });
      }
    }
  }
  return partnerId;
}

function broadcastOnlineCount() {
  io.emit('online_count', { count: io.engine.clientsCount });
}

function pairUsers(socket) {
  removeFromQueue(socket.id);
  unpair(socket.id, true, 'Stranger has skipped to a new chat.');

  const socketSession = socketToSession.get(socket.id);

  // Check if current user is under cooldown
  const userCooldown = isSessionInCooldown(socketSession);
  if (userCooldown) {
    socket.emit('cooldown_active', {
      remainingMinutes: userCooldown.remainingMins,
      reason: userCooldown.reason
    });
    return;
  }

  const socketProfile = userProfiles.get(socket.id) || { name: 'Stranger', age: '', gender: '', avatar: '' };
  const socketBlocked = userBlocks.get(socketSession) || new Set();

  let candidateFound = null;
  const inspectedCandidates = [];

  while (waitingQueue.length > 0) {
    const candidateId = waitingQueue.shift();
    if (candidateId === socket.id) continue;

    const candidateSocket = io.sockets.sockets.get(candidateId);
    if (!candidateSocket || !candidateSocket.connected) continue;

    const candidateSession = socketToSession.get(candidateId);

    // Skip if candidate is in cooldown
    if (isSessionInCooldown(candidateSession)) continue;

    // Check mutual block list
    const candidateBlocked = userBlocks.get(candidateSession) || new Set();
    if (socketBlocked.has(candidateSession) || candidateBlocked.has(socketSession)) {
      // Mutual block active! Keep searching other candidates
      inspectedCandidates.push(candidateId);
      continue;
    }

    // Valid mutual match found!
    candidateFound = candidateSocket;
    break;
  }

  // Restore non-matching candidates back to queue
  waitingQueue = inspectedCandidates.concat(waitingQueue);

  if (candidateFound) {
    activePairs.set(socket.id, candidateFound.id);
    activePairs.set(candidateFound.id, socket.id);

    const candidateProfile = userProfiles.get(candidateFound.id) || { name: 'Stranger', age: '', gender: '', avatar: '' };

    socket.emit('chat_start', {
      partner: 'stranger',
      partnerProfile: candidateProfile,
      timestamp: Date.now()
    });

    candidateFound.emit('chat_start', {
      partner: 'stranger',
      partnerProfile: socketProfile,
      timestamp: Date.now()
    });
    return;
  }

  // If no candidate available, add to waiting queue
  waitingQueue.push(socket.id);
  socket.emit('waiting', {
    message: 'Looking for someone you can chat with...',
    timestamp: Date.now()
  });
}

// Serve static frontend files with fresh cache-control headers
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
}));

// Public Community Guidelines standalone route
app.get('/guidelines', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'guidelines.html'));
});

// Public health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    online: io.engine.clientsCount,
    waiting: waitingQueue.length,
    activeRooms: activePairs.size / 2
  });
});

// Admin Review Dashboard (Protected by ADMIN_KEY)
app.get('/admin/reports', (req, res) => {
  const key = req.query.key || req.headers['x-admin-key'];
  if (key !== ADMIN_KEY) {
    return res.status(403).send(`
      <!DOCTYPE html>
      <html>
      <head><title>Access Denied - SparksChat Admin</title><style>body{background:#0b0f19;color:#f8fafc;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}</style></head>
      <body><div style="text-align:center;"><h2>🔒 403 Forbidden</h2><p>Invalid or missing admin security key.</p></div></body>
      </html>
    `);
  }

  // Calculate statistics
  const totalReports = reportsLog.length;
  const reasonCounts = {};
  reportsLog.forEach(r => {
    reasonCounts[r.reason] = (reasonCounts[r.reason] || 0) + 1;
  });

  const activeCooldownList = [];
  activeCooldowns.forEach((val, sessionId) => {
    const remainingMins = Math.ceil((val.expiresAt - Date.now()) / (60 * 1000));
    if (remainingMins > 0) {
      activeCooldownList.push({ sessionId, remainingMins, reason: val.reason });
    }
  });

  const recentReports = reportsLog.slice(-50).reverse();

  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>SparksChat - Admin Trust & Safety Dashboard</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #0b0f19; color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 2rem; line-height: 1.5; }
        .container { max-width: 1100px; margin: 0 auto; }
        .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 1rem; margin-bottom: 2rem; }
        .badge { background: #ef4444; color: white; padding: 0.2rem 0.6rem; border-radius: 99px; font-size: 0.8rem; font-weight: bold; }
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
        .card { background: #121826; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 1.25rem; }
        .card-val { font-size: 2rem; font-weight: bold; color: #3b82f6; }
        .card-lbl { color: #94a3b8; font-size: 0.85rem; }
        table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
        th, td { text-align: left; padding: 0.75rem; border-bottom: 1px solid rgba(255,255,255,0.06); font-size: 0.875rem; }
        th { color: #94a3b8; font-weight: 600; text-transform: uppercase; font-size: 0.75rem; }
        .reason-pill { display: inline-block; padding: 0.2rem 0.5rem; border-radius: 6px; font-size: 0.75rem; font-weight: 600; }
        .reason-harassment { background: rgba(239, 68, 68, 0.2); color: #fca5a5; }
        .reason-inappropriate { background: rgba(245, 158, 11, 0.2); color: #fcd34d; }
        .reason-spam { background: rgba(59, 130, 246, 0.2); color: #93c5fd; }
        .reason-underage { background: rgba(220, 38, 38, 0.3); color: #f87171; border: 1px solid #ef4444; }
        .reason-other { background: rgba(255, 255, 255, 0.1); color: #cbd5e1; }
        .btn { background: #3b82f6; color: white; border: none; padding: 0.4rem 0.8rem; border-radius: 6px; cursor: pointer; text-decoration: none; font-size: 0.8rem; }
        .btn-danger { background: #ef4444; }
        .session-id { font-family: monospace; color: #60a5fa; background: rgba(255,255,255,0.04); padding: 0.15rem 0.4rem; border-radius: 4px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <div>
            <h1>🛡️ SparksChat Trust & Safety</h1>
            <p style="color: #94a3b8; font-size: 0.9rem;">Anonymous Moderation & Report Logs (Zero Personal Data)</p>
          </div>
          <div>
            <a href="/admin/reports/export?key=${encodeURIComponent(key)}" class="btn" download>📥 Export JSON</a>
          </div>
        </div>

        <div class="stats-grid">
          <div class="card">
            <div class="card-val">${totalReports}</div>
            <div class="card-lbl">Total Reports Logged</div>
          </div>
          <div class="card">
            <div class="card-val" style="color: #ef4444;">${activeCooldownList.length}</div>
            <div class="card-lbl">Active Auto-Cooldowns</div>
          </div>
          <div class="card">
            <div class="card-val" style="color: #10b981;">${io.engine.clientsCount}</div>
            <div class="card-lbl">Users Online Now</div>
          </div>
        </div>

        <div class="card" style="margin-bottom: 2rem;">
          <h3>Active Restriction Cooldowns (3+ Strikes)</h3>
          ${activeCooldownList.length === 0 ? '<p style="color: #64748b; margin-top: 0.5rem;">No active cooldowns currently enforced.</p>' : `
            <table>
              <thead>
                <tr>
                  <th>Anonymous Session ID</th>
                  <th>Remaining Time</th>
                  <th>Trigger Reason</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                ${activeCooldownList.map(c => `
                  <tr>
                    <td><span class="session-id">${c.sessionId}</span></td>
                    <td>${c.remainingMins} mins</td>
                    <td>${c.reason}</td>
                    <td>
                      <button onclick="liftCooldown('${c.sessionId}')" class="btn btn-danger">Lift Cooldown</button>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          `}
        </div>

        <div class="card">
          <h3>Recent Reports (Last 50)</h3>
          ${recentReports.length === 0 ? '<p style="color: #64748b; margin-top: 0.5rem;">No reports recorded yet.</p>' : `
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Reason</th>
                  <th>Reported Anonymous ID</th>
                  <th>Reporter Anonymous ID</th>
                </tr>
              </thead>
              <tbody>
                ${recentReports.map(r => `
                  <tr>
                    <td>${new Date(r.timestamp).toLocaleString()}</td>
                    <td><span class="reason-pill reason-${r.reason}">${r.reason}</span></td>
                    <td><span class="session-id">${r.reportedSessionId}</span></td>
                    <td><span class="session-id">${r.reporterSessionId}</span></td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          `}
        </div>
      </div>

      <script>
        async function liftCooldown(sessionId) {
          if (!confirm('Lift cooldown restriction for ' + sessionId + '?')) return;
          const res = await fetch('/admin/cooldown/remove?key=' + encodeURIComponent('${key}'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId })
          });
          if (res.ok) {
            alert('Cooldown lifted!');
            location.reload();
          } else {
            alert('Error lifting cooldown');
          }
        }
      </script>
    </body>
    </html>
  `);
});

// Admin Export Reports JSON
app.get('/admin/reports/export', (req, res) => {
  const key = req.query.key;
  if (key !== ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized' });
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="sparkschat_reports.json"');
  res.send(JSON.stringify(reportsLog, null, 2));
});

// Admin Lift Cooldown endpoint
app.post('/admin/cooldown/remove', (req, res) => {
  const key = req.query.key || req.headers['x-admin-key'];
  if (key !== ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized' });

  const { sessionId } = req.body;
  if (sessionId) {
    activeCooldowns.delete(sessionId);
    return res.json({ success: true, message: `Cooldown lifted for ${sessionId}` });
  }
  res.status(400).json({ error: 'Session ID required' });
});

// Socket.io Connection Logic
io.on('connection', (socket) => {
  // Assign or extract session ID
  const clientSessionId = socket.handshake.auth?.sessionId;
  const sessionId = clientSessionId && typeof clientSessionId === 'string' && clientSessionId.startsWith('anon-')
    ? clientSessionId.slice(0, 32)
    : 'anon-' + crypto.randomBytes(6).toString('hex');

  socketToSession.set(socket.id, sessionId);
  broadcastOnlineCount();

  // User starts chat
  socket.on('start_chat', (profile) => {
    userProfiles.set(socket.id, sanitizeProfile(profile));
    pairUsers(socket);
  });

  // User skips chat
  socket.on('skip_chat', (profile) => {
    if (profile) userProfiles.set(socket.id, sanitizeProfile(profile));
    pairUsers(socket);
  });

  // User blocks current stranger
  socket.on('block_user', () => {
    const partnerId = activePairs.get(socket.id);
    const mySession = socketToSession.get(socket.id);

    if (partnerId) {
      const partnerSession = socketToSession.get(partnerId);
      if (partnerSession && mySession) {
        if (!userBlocks.has(mySession)) {
          userBlocks.set(mySession, new Set());
        }
        userBlocks.get(mySession).add(partnerSession);
      }

      // Disconnect current partner and notify them
      unpair(socket.id, true, 'Stranger has left the chat.');
    }

    socket.emit('blocked_success', {
      message: 'Stranger blocked. You will not be matched with them again.'
    });
  });

  // User reports current stranger
  socket.on('report_user', (data) => {
    const validReasons = ['harassment', 'inappropriate', 'spam', 'underage', 'other'];
    const reason = data && validReasons.includes(data.reason) ? data.reason : 'other';

    const partnerId = activePairs.get(socket.id);
    const mySession = socketToSession.get(socket.id);
    const partnerSession = partnerId ? socketToSession.get(partnerId) : null;

    if (partnerSession) {
      // 1. Log report entry (zero personal data / zero message text)
      const reportEntry = {
        id: 'rep-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6),
        timestamp: Date.now(),
        reason,
        reporterSessionId: mySession,
        reportedSessionId: partnerSession
      };
      reportsLog.push(reportEntry);
      persistReports();

      // 2. Count reports against this session within the last 60 minutes
      const oneHourAgo = Date.now() - 60 * 60 * 1000;
      const recentStrikeCount = reportsLog.filter(
        r => r.reportedSessionId === partnerSession && r.timestamp > oneHourAgo
      ).length;

      // 3. Auto-cooldown enforcement: 3+ reports = 30-minute restriction
      if (recentStrikeCount >= 3) {
        const cooldownDuration = 30 * 60 * 1000; // 30 mins
        activeCooldowns.set(partnerSession, {
          expiresAt: Date.now() + cooldownDuration,
          reason: `Automated restriction due to ${recentStrikeCount} community reports (${reason})`,
          reportCount: recentStrikeCount
        });

        // Immediately disconnect the reported user
        const partnerSocket = io.sockets.sockets.get(partnerId);
        if (partnerSocket) {
          partnerSocket.emit('cooldown_active', {
            remainingMinutes: 30,
            reason: 'Your account has been temporarily restricted due to multiple community reports.'
          });
          unpair(partnerId, false);
          partnerSocket.disconnect(true);
        }
      }

      // Automatically add to reporter's block list so they never match again
      if (mySession) {
        if (!userBlocks.has(mySession)) {
          userBlocks.set(mySession, new Set());
        }
        userBlocks.get(mySession).add(partnerSession);
      }

      // Unpair current chat
      unpair(socket.id, true, 'Stranger was reported and disconnected.');
    }

    socket.emit('report_success', {
      message: 'Report submitted. Thank you for helping keep SparksChat safe.'
    });
  });

  // Profile update during active chat
  socket.on('update_profile', (profile) => {
    const sanitized = sanitizeProfile(profile);
    userProfiles.set(socket.id, sanitized);

    const partnerId = activePairs.get(socket.id);
    if (partnerId) {
      const partnerSocket = io.sockets.sockets.get(partnerId);
      if (partnerSocket) {
        partnerSocket.emit('partner_profile_updated', {
          partnerProfile: sanitized
        });
      }
    }
  });

  // User leaves chat
  socket.on('leave_chat', () => {
    removeFromQueue(socket.id);
    unpair(socket.id, true, 'Stranger has left the conversation.');
    socket.emit('left_chat');
  });

  // Incoming text message with safety moderation filter
  socket.on('chat_message', (data) => {
    if (!data || typeof data.text !== 'string') return;
    const text = data.text.trim();
    if (!text || text.length > 4000) return;

    // Run text content moderation filter
    const safetyCheck = checkMessageSafety(text);
    if (!safetyCheck.safe) {
      socket.emit('message_filtered', {
        reason: safetyCheck.reason
      });
      return;
    }

    const partnerId = activePairs.get(socket.id);
    if (!partnerId) return;

    const partnerSocket = io.sockets.sockets.get(partnerId);
    if (!partnerSocket) {
      unpair(socket.id, false);
      socket.emit('stranger_disconnected', { reason: 'Stranger has disconnected.' });
      return;
    }

    const payload = {
      text,
      timestamp: Date.now()
    };

    partnerSocket.emit('chat_message', { ...payload, sender: 'stranger' });
    socket.emit('chat_message', { ...payload, sender: 'you' });
  });

  // Incoming file message (Image, Document, Audio Note)
  socket.on('chat_file', (data) => {
    if (!data || !data.fileData || !data.fileName) return;

    if (typeof data.fileData === 'string' && data.fileData.length > 14 * 1024 * 1024) {
      socket.emit('file_error', { message: 'File exceeds 10MB limit.' });
      return;
    }

    const partnerId = activePairs.get(socket.id);
    if (!partnerId) return;

    const partnerSocket = io.sockets.sockets.get(partnerId);
    if (!partnerSocket) {
      unpair(socket.id, false);
      socket.emit('stranger_disconnected', { reason: 'Stranger has disconnected.' });
      return;
    }

    const isImage = Boolean(data.isImage);

    const payload = {
      fileName: String(data.fileName).slice(0, 150),
      fileType: String(data.fileType || 'application/octet-stream'),
      fileSize: Number(data.fileSize || 0),
      fileData: data.fileData,
      isImage,
      isAudio: Boolean(data.isAudio),
      // Mark images as potentially sensitive so client blurs until clicked
      isSensitive: isImage,
      caption: data.caption ? String(data.caption).slice(0, 500) : '',
      timestamp: Date.now()
    };

    partnerSocket.emit('chat_file', { ...payload, sender: 'stranger' });
    socket.emit('chat_file', { ...payload, sender: 'you', isSensitive: false });
  });

  // Typing indicator
  socket.on('typing', (data) => {
    const partnerId = activePairs.get(socket.id);
    if (!partnerId) return;

    const partnerSocket = io.sockets.sockets.get(partnerId);
    if (partnerSocket) {
      partnerSocket.emit('stranger_typing', {
        isTyping: Boolean(data && data.isTyping)
      });
    }
  });

  // WebRTC Voice Call Signaling
  socket.on('voice_call_request', () => {
    const partnerId = activePairs.get(socket.id);
    if (!partnerId) return;

    const partnerSocket = io.sockets.sockets.get(partnerId);
    if (partnerSocket) {
      partnerSocket.emit('voice_call_incoming');
    }
  });

  socket.on('voice_call_response', (data) => {
    const partnerId = activePairs.get(socket.id);
    if (!partnerId) return;

    const partnerSocket = io.sockets.sockets.get(partnerId);
    if (partnerSocket) {
      partnerSocket.emit('voice_call_response', {
        accepted: Boolean(data && data.accepted)
      });
    }
  });

  socket.on('webrtc_signal', (data) => {
    const partnerId = activePairs.get(socket.id);
    if (!partnerId) return;

    const partnerSocket = io.sockets.sockets.get(partnerId);
    if (partnerSocket && data && data.signal) {
      partnerSocket.emit('webrtc_signal', {
        signal: data.signal
      });
    }
  });

  socket.on('voice_call_end', () => {
    const partnerId = activePairs.get(socket.id);
    if (!partnerId) return;

    const partnerSocket = io.sockets.sockets.get(partnerId);
    if (partnerSocket) {
      partnerSocket.emit('voice_call_end');
    }
  });

  // Disconnection cleanup
  socket.on('disconnect', () => {
    removeFromQueue(socket.id);
    unpair(socket.id, true, 'Stranger has disconnected.');
    userProfiles.delete(socket.id);
    socketToSession.delete(socket.id);
    broadcastOnlineCount();
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`⚡ SparksChat server running on all interfaces at http://localhost:${PORT}`);
  console.log(`🛡️  Admin Trust & Safety Dashboard: http://localhost:${PORT}/admin/reports?key=${ADMIN_KEY}`);
});
