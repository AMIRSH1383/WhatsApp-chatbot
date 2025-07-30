// const qrcode = require('qrcode-terminal');
const qrcode = require('qrcode');
const open = require('open').default;
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage
} = require('@whiskeysockets/baileys');

const app = express();
app.use(express.json());
app.use('/media', express.static(path.join(__dirname)));
app.use('/upload', express.raw({ type: '*/*', limit: '50mb' }));

const sockets = {}; // Store socket instances per user
const latestQRCodes = {}; // username => base64 QR
const connectionStatus = {}; // username => true when connected


async function createNewSession(username) {
  const userAuthPath = path.join(__dirname, 'auth', username);
  const { state, saveCreds } = await useMultiFileAuthState(userAuthPath);

  const sock = makeWASocket({ auth: state });
  sockets[username] = sock;

  sock.ev.on('creds.update', saveCreds);

  // sock.ev.on('connection.update', (update) => {
  //   const { connection, lastDisconnect, qr } = update;
  //   if (qr) {
  //     console.log(`\n📲 [${username}] Scan this QR with your WhatsApp:\n`);
  //     qrcode.generate(qr, { small: true });
  //   }
  //   if (connection === 'close') {
  //     const shouldReconnect = (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut);
  //     console.log(`[${username}] Connection closed. Reconnecting: ${shouldReconnect}`);
  //     if (shouldReconnect) createNewSession(username);
  //   } else if (connection === 'open') {
  //     console.log(`✅ [${username}] Connected to WhatsApp!`);
  //   }
  // });
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      // Save the latest QR
      qrcode.toDataURL(qr, (err, url) => {
        if (!err) {
          latestQRCodes[username] = url;
        }
      });
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut);
      console.log(`[${username}] Connection closed. Reconnecting: ${shouldReconnect}`);
      if (shouldReconnect) createNewSession(username);
    } else if (connection === 'open') {
      console.log(`✅ [${username}] Connected to WhatsApp!`);
      connectionStatus[username] = true;
      delete latestQRCodes[username];
    }
  });


  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const from = msg.key.remoteJid;
    let body = '';
    let mediaType = '';
    let filePath = null;

    try {
      if (msg.message.conversation || msg.message.extendedTextMessage) {
        body = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        mediaType = 'text';
      } else if (msg.message.audioMessage) {
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: sock.logger });
        filePath = `voice_${Date.now()}.ogg`;
        fs.writeFileSync(filePath, buffer);
        mediaType = 'audio';
        body = '[Voice message]';
      } else if (msg.message.imageMessage) {
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: sock.logger });
        filePath = `image_${Date.now()}.jpg`;
        fs.writeFileSync(filePath, buffer);
        mediaType = 'image';
        body = '[Image received]';
      } else if (msg.message.videoMessage) {
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: sock.logger });
        filePath = `video_${Date.now()}.mp4`;
        fs.writeFileSync(filePath, buffer);
        mediaType = 'video';
        body = '[Video received]';
      } else if (msg.message.documentMessage) {
        const ext = msg.message.documentMessage.fileName?.split('.').pop() || 'pdf';
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: sock.logger });
        filePath = `document_${Date.now()}.${ext}`;
        fs.writeFileSync(filePath, buffer);
        mediaType = 'document';
        body = `[Document: ${msg.message.documentMessage.fileName}]`;
      }

      console.log(`[${username}] [${from}] ${body}`);

      await axios.post('http://localhost:5678/webhook/54391c60-bee3-4ebc-914d-4ea16121e8f4', {
        from,
        body,
        mediaType,
        filePath,
        username
      });

    } catch (err) {
      console.error(`[${username}] ❌ Error processing message:`, err);
    }
  });

  app.post('/send', async (req, res) => {
    const { to, message, username } = req.body;

    if (!to || !message || !username) {
      return res.status(400).send({ success: false, error: "`to`, `message`, and `username` are required" });
    }

    const sock = sockets[username];
    if (!sock) {
      return res.status(404).send({ success: false, error: `No session found for user '${username}'` });
    }

    try {
      await sock.sendMessage(to, { text: message });
      console.log(`✅ [${username}] Sent text to ${to}`);
      res.send({ success: true });
    } catch (err) {
      console.error(`[${username}] ❌ Failed to send message:`, err);
      res.status(500).send({ success: false, error: 'Failed to send message' });
    }
  });

  app.post('/upload', (req, res) => {
    const fileName = req.query.fileName;
    if (!fileName || !req.body || !req.body.length) {
      return res.status(400).send({ success: false, error: 'Missing file or fileName' });
    }

    const filePath = path.join(__dirname, fileName);
    fs.writeFileSync(filePath, req.body);
    console.log(`✅ Uploaded file saved to ${filePath}`);
    res.send({ success: true, filePath: `/media/${fileName}` });
  });

  app.post('/sendAudio', async (req, res) => {
    try {
      const { to, filePath, mimetype, ptt, username } = req.body;

      if (!to || !filePath || !mimetype || !username) {
        return res.status(400).send({ success: false, error: '`to`, `filePath`, `mimetype`, and `username` are required' });
      }

      const sock = sockets[username];
      if (!sock) {
        return res.status(404).send({ success: false, error: `No session for '${username}'` });
      }

      const fullPath = path.resolve(__dirname, filePath);
      if (!fs.existsSync(fullPath)) {
        return res.status(404).send({ success: false, error: `File not found at ${fullPath}` });
      }

      const audioBuffer = fs.readFileSync(fullPath);
      
      console.log(`👉 [${username}] Sending audio to ${to}...`);
      await sock.sendMessage(to, {
        audio: audioBuffer,
        mimetype,
        ptt: ptt === 'true',
      });

      console.log(`✅ [${username}] Sent audio to ${to}`);
      res.send({ success: true });

    } catch (err) {
      console.error('❌ Error sending audio:', err);
      res.status(500).send({ success: false, error: err.message });
    }
  });
}

// Allow command line input to add users
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// CLI listener: always ready to add more users
function listenForCommands() {
  rl.question('\n💬 Type a command (`new_user` to add): ', (command) => {
    if (command.trim() === 'new_user') {
      promptNewUser();
    } else {
      console.log('⚠️ Unknown command.');
      listenForCommands();
    }
  });
}

// Prompt and create a new user
// function promptNewUser() {
//   rl.question('👤 Enter username for new session: ', async (username) => {
//     if (sockets[username]) {
//       console.log(`⚠️ User '${username}' is already active.`);
//     } else {
//       await createNewSession(username);
//     }
//     listenForCommands(); // Go back to waiting for new command
//   });
// }
function promptNewUser() {
  rl.question('👤 Enter username for new session: ', async (username) => {
    if (sockets[username]) {
      console.log(`⚠️ User '${username}' is already active.`);
    } else {
      await createNewSession(username);
      open(`http://localhost:3000/qr/${username}`);
    }
    listenForCommands();
  });
}

// Restore existing sessions if present
async function restoreAllUsers() {
  const authDir = path.join(__dirname, 'auth');
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir);

  let users = fs.readdirSync(authDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name);

  // Remove empty or invalid auth folders
  users = users.filter(username => {
    const userPath = path.join(authDir, username);
    const contents = fs.readdirSync(userPath);
    if (contents.length === 0) {
      console.log(`🗑️ Removed empty session folder for '${username}'`);
      fs.rmSync(userPath, { recursive: true, force: true });
      return false;
    }
    return true;
  });

  if (users.length === 0) {
    console.log('💬 No saved users. Type `new_user` to begin:');
  } else {
    console.log('🔄 Restoring saved sessions...');
    for (const username of users) {
      try {
        await createNewSession(username);
      } catch (err) {
        console.error(`❌ Could not restore session for '${username}':`, err.message);
      }
    }
  }

  listenForCommands(); // Always enter command listening mode
}

app.get('/qr/:username', (req, res) => {
  const { username } = req.params;
  const qrImage = latestQRCodes[username];
  const isConnected = connectionStatus[username];

  if (isConnected) {
    return res.send(`<html><body><script>window.close()</script></body></html>`);
  }

  if (!qrImage) {
    return res.send('<html><body><h2>Waiting for QR generation...</h2><meta http-equiv="refresh" content="30"/></body></html>');
  }

  res.send(`
    <html>
      <head><title>Scan QR</title></head>
      <body style="text-align:center; font-family:sans-serif">
        <h2>Scan this QR with your WhatsApp</h2>
        <img src="${qrImage}" width="300" height="300"/>
        <p>Waiting for connection...</p>
        <meta http-equiv="refresh" content="30">
      </body>
    </html>
  `);
});


restoreAllUsers();

app.listen(3000, () => console.log('📡 Multi-user WhatsApp bot server running on port 3000'));

