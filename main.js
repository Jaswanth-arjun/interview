const {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Tray,
  Menu,
  screen,
  session,
  dialog,
  nativeImage,
  desktopCapturer,
} = require('electron');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '.env') });

// ─── State ───────────────────────────────────────────────────────
let setupWindow = null;
let overlayWindow = null;
let tray = null;
let isOverlayVisible = false;
let profileData = {};

// ─── Multi-Key Round Robin ───────────────────────────────────────
const API_KEYS = [
  process.env.GEMINI_API_KEY_1,
  process.env.GEMINI_API_KEY_2,
  process.env.GEMINI_API_KEY_3,
].filter((k) => k && !k.startsWith('your_'));  // Only keep real keys

let currentKeyIndex = 0;
console.log(`✓ Loaded ${API_KEYS.length} Gemini API key(s)`);
console.log(process.env.GROQ_API_KEY && !process.env.GROQ_API_KEY.startsWith('your_') ? '✓ Loaded Groq API key' : '✗ No Groq API key loaded');

function getNextKey() {
  if (API_KEYS.length === 0) return null;
  const key = API_KEYS[currentKeyIndex];
  currentKeyIndex = (currentKeyIndex + 1) % API_KEYS.length;
  return key;
}

const storePath = path.join(app.getPath('userData'), 'profile-data.json');

// ─── Data Persistence ────────────────────────────────────────────
function loadProfileData() {
  try {
    if (fs.existsSync(storePath)) {
      profileData = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
    }
  } catch (e) {
    console.error('Failed to load profile data:', e);
    profileData = {};
  }
}

function saveProfileData(data) {
  profileData = data;
  fs.writeFileSync(storePath, JSON.stringify(data, null, 2));
}

// ─── Windows ─────────────────────────────────────────────────────
function createSetupWindow() {
  setupWindow = new BrowserWindow({
    width: 1050,
    height: 780,
    minWidth: 800,
    minHeight: 600,
    frame: false,
    backgroundColor: '#08081a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  });

  setupWindow.loadFile(path.join(__dirname, 'src/setup/setup.html'));
  setupWindow.once('ready-to-show', () => setupWindow.show());
  setupWindow.on('closed', () => { setupWindow = null; });
}

function createOverlayWindow() {
  const { width } = screen.getPrimaryDisplay().workAreaSize;

  overlayWindow = new BrowserWindow({
    width: 480,
    height: 620,
    x: width - 510,
    y: 40,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  });

  overlayWindow.loadFile(path.join(__dirname, 'src/overlay/overlay.html'));
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
}

function toggleOverlay() {
  if (!overlayWindow) return;
  if (isOverlayVisible) {
    overlayWindow.hide();
  } else {
    overlayWindow.show();
  }
  isOverlayVisible = !isOverlayVisible;
}

// ─── Tray ────────────────────────────────────────────────────────
function createTrayIcon() {
  // Create a 16x16 indigo icon programmatically (BGRA format)
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // Create a subtle gradient from indigo to cyan
      const ratio = (x + y) / (size * 2);
      buf[i]     = Math.round(99  + ratio * (6   - 99));  // R
      buf[i + 1] = Math.round(102 + ratio * (182 - 102)); // G
      buf[i + 2] = Math.round(241 + ratio * (212 - 241)); // B
      buf[i + 3] = 255;                                   // A
    }
  }
  return nativeImage.createFromBuffer(buf, { width: size, height: size });
}

function createTray() {
  try {
    const trayIcon = createTrayIcon();
    tray = new Tray(trayIcon);
  } catch (e) {
    console.error('Failed to create tray icon:', e);
    return;
  }

  tray.setToolTip('Interview Practice Assistant');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: 'Open Setup',
        click: () => {
          if (setupWindow) setupWindow.show();
          else createSetupWindow();
        },
      },
      {
        label: 'Toggle Overlay  (Ctrl+Shift+A)',
        click: toggleOverlay,
      },
      { type: 'separator' },
      { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
    ])
  );
  tray.on('double-click', () => {
    if (setupWindow) setupWindow.show();
    else createSetupWindow();
  });
}

// ─── Prompt Builder ──────────────────────────────────────────────
function buildPrompt(question) {
  const d = profileData;
  return `You are a human job candidate answering an interview question in real-time.
Answer this question: "${question}"

RULES FOR A HUMAN-LIKE RESPONSE:
1. Speak in first person ("I", "my", "we").
2. Use simple, clear, everyday language. Avoid complex words, jargon, or standard AI lecturing templates.
3. Sound like a real person talking naturally. Feel free to use brief conversational transitions (e.g. "To be honest...", "Well, in my last role...", "Actually...", "Basically...").
4. Keep it highly concise (4 to 7 sentences max). Get straight to the point.
5. Absolutely NO bullet points, NO markdown formatting, NO lists, and NO typical AI prefaces like "Sure!", "Here is an answer", or "Certainly". Start answering the question directly.
6. Rely ONLY on the candidate context below. Do not invent any projects or details.

─── CANDIDATE CONTEXT ───
Resume:
${d.resumeText || 'Not provided'}

Job Details:
Company: ${d.companyName || 'Not specified'}
Role: ${d.roleName || 'Not specified'}
Job Description: ${d.jobDescription || 'Not provided'}

Projects / Skills / Achievements:
${d.projects || 'Not provided'}

Extra Notes:
${d.extraNotes || 'Not provided'}
──────────────────────────

Begin speaking naturally now:`;
}

// ─── IPC Handlers ────────────────────────────────────────────────
function registerIPC() {
  ipcMain.handle('save-setup-data', async (_e, data) => {
    saveProfileData(data);
    return { success: true };
  });

  ipcMain.handle('get-setup-data', async () => {
    loadProfileData();
    return profileData;
  });

  ipcMain.handle('open-file-dialog', async () => {
    const result = await dialog.showOpenDialog(setupWindow, {
      properties: ['openFile'],
      filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
    });
    if (result.canceled) return { success: false };
    return { success: true, filePath: result.filePaths[0] };
  });

  ipcMain.handle('parse-pdf', async (_e, filePath) => {
    try {
      const pdfParse = require('pdf-parse');
      const buffer = fs.readFileSync(filePath);
      const data = await pdfParse(buffer);
      return { success: true, text: data.text };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('generate-answer', async (e, question) => {
    const webContents = e.sender;

    // 1. Try NaraRouter first if configured
    const naraRouterKey = process.env.NARA_ROUTER_API_KEY;
    if (naraRouterKey && !naraRouterKey.startsWith('your_') && !naraRouterKey.includes('gy1N4ZJB..')) {
      const modelName = process.env.NARA_ROUTER_MODEL || 'mimo-v2.5-free';
      const baseUrl = process.env.NARA_ROUTER_BASE_URL || 'https://router.bynara.id/v1';
      try {
        console.log(`Trying NaraRouter with model ${modelName} (streaming)...`);
        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${naraRouterKey}`
          },
          body: JSON.stringify({
            model: modelName,
            messages: [
              {
                role: 'user',
                content: buildPrompt(question)
              }
            ],
            stream: true
          })
        });

        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`NaraRouter HTTP error ${response.status}: ${errText}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let fullText = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop(); // Keep incomplete line in buffer

          for (const line of lines) {
            const cleaned = line.trim();
            if (cleaned.startsWith('data: ')) {
              const dataStr = cleaned.slice(6);
              if (dataStr === '[DONE]') break;
              try {
                const data = JSON.parse(dataStr);
                const chunk = data.choices?.[0]?.delta?.content;
                if (chunk) {
                  fullText += chunk;
                  webContents.send('answer-chunk', chunk);
                }
              } catch (err) {
                // Ignore JSON parse errors for incomplete lines
              }
            }
          }
        }

        if (fullText) {
          console.log(`✓ Answer generated via NaraRouter — Model: ${modelName}`);
          return { success: true, answer: fullText };
        }
        throw new Error('NaraRouter returned empty response');
      } catch (e) {
        console.warn(`✗ NaraRouter failed: ${e.message}. Falling back to Gemini...`);
      }
    }

    // 2. Gemini fallback
    const { GoogleGenerativeAI } = require('@google/generative-ai');

    if (API_KEYS.length === 0) {
      return { success: false, error: 'No API keys found. Add NARA_ROUTER_API_KEY or GEMINI_API_KEY_1 to .env file.' };
    }

    // Two models to try — flash-lite has separate, higher free quota
    const MODELS = ['gemini-2.0-flash-lite', 'gemini-2.0-flash'];
    let lastError = '';

    // Fast: try each key × each model (no retry delays)
    for (let i = 0; i < API_KEYS.length; i++) {
      const apiKey = getNextKey();
      const keyNum = ((currentKeyIndex - 1 + API_KEYS.length) % API_KEYS.length) + 1;

      for (const modelName of MODELS) {
        try {
          console.log(`Trying Gemini with model ${modelName} (streaming)...`);
          const genAI = new GoogleGenerativeAI(apiKey);
          const model = genAI.getGenerativeModel({ model: modelName });
          const result = await model.generateContentStream(buildPrompt(question));
          
          let fullText = '';
          for await (const chunk of result.stream) {
            const chunkText = chunk.text();
            fullText += chunkText;
            webContents.send('answer-chunk', chunkText);
          }

          console.log(`✓ Answer generated — Key #${keyNum}, model: ${modelName}`);
          return { success: true, answer: fullText };
        } catch (e) {
          const msg = e.message || '';
          const is429 = msg.includes('429');
          const is400 = msg.includes('400') || msg.includes('API_KEY_INVALID');
          console.warn(`✗ Key #${keyNum} / ${modelName} — ${is429 ? 'rate-limited' : is400 ? 'invalid key' : 'error'}`);

          if (is400) {
            lastError = `Key #${keyNum} is invalid or expired. Please generate a new key.`;
            break; // Don't try other models with a bad key
          }
          lastError = is429 ? 'Rate limit exceeded' : msg;
        }
      }
    }

    // All failed — show helpful message
    const helpMsg = lastError.includes('invalid') || lastError.includes('API_KEY')
      ? `${lastError}\n\nPlease update your API key in the .env file.`
      : `${lastError}\n\nTip: Wait 1 minute or check your API key quota.`;

    return { success: false, error: helpMsg };
  });

  ipcMain.handle('transcribe-audio', async (_e, base64Audio, mimeType) => {
    // 1. Try NaraRouter Whisper first if configured
    const naraRouterKey = process.env.NARA_ROUTER_API_KEY;
    if (naraRouterKey && !naraRouterKey.startsWith('your_') && !naraRouterKey.includes('gy1N4ZJB..')) {
      const baseUrl = process.env.NARA_ROUTER_BASE_URL || 'https://router.bynara.id/v1';
      try {
        console.log(`Trying NaraRouter Whisper transcription...`);
        const buffer = Buffer.from(base64Audio, 'base64');
        const formData = new FormData();
        
        let ext = 'webm';
        if (mimeType && mimeType.includes('wav')) ext = 'wav';
        else if (mimeType && mimeType.includes('mp3')) ext = 'mp3';
        else if (mimeType && mimeType.includes('m4a')) ext = 'm4a';

        const blob = new Blob([buffer], { type: mimeType || 'audio/webm' });
        formData.append('file', blob, `audio.${ext}`);
        formData.append('model', 'whisper-1');

        const response = await fetch(`${baseUrl}/audio/transcriptions`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${naraRouterKey}`
          },
          body: formData
        });

        if (response.ok) {
          const data = await response.json();
          const text = data.text?.trim();
          if (text) {
            console.log(`✓ Transcribed via NaraRouter: "${text.substring(0, 60)}..."`);
            return { success: true, text };
          }
        } else {
          const errText = await response.text();
          console.warn(`✗ NaraRouter Whisper HTTP error ${response.status}: ${errText}`);
        }
      } catch (e) {
        console.warn(`✗ NaraRouter Whisper failed: ${e.message}`);
      }
    }

    // 2. Try Groq Whisper if configured
    const groqKey = process.env.GROQ_API_KEY;
    if (groqKey && !groqKey.startsWith('your_')) {
      try {
        console.log('Trying Groq Whisper transcription...');
        const buffer = Buffer.from(base64Audio, 'base64');
        const groqFormData = new FormData();
        let ext = 'webm';
        if (mimeType && mimeType.includes('wav')) ext = 'wav';
        else if (mimeType && mimeType.includes('mp3')) ext = 'mp3';
        else if (mimeType && mimeType.includes('m4a')) ext = 'm4a';

        const groqBlob = new Blob([buffer], { type: mimeType || 'audio/webm' });
        groqFormData.append('file', groqBlob, `audio.${ext}`);
        groqFormData.append('model', 'whisper-large-v3');

        const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${groqKey}`
          },
          body: groqFormData
        });

        if (response.ok) {
          const data = await response.json();
          const text = data.text?.trim();
          if (text) {
            console.log(`✓ Transcribed via Groq: "${text.substring(0, 60)}..."`);
            return { success: true, text };
          }
        } else {
          const errText = await response.text();
          console.warn(`✗ Groq Whisper HTTP error ${response.status}: ${errText}`);
        }
      } catch (e) {
        console.warn(`✗ Groq Whisper failed: ${e.message}`);
      }
    }

    // 3. Gemini fallback
    const { GoogleGenerativeAI } = require('@google/generative-ai');

    if (API_KEYS.length === 0) {
      return { success: false, error: 'No API keys found. Add GEMINI_API_KEY_1 to .env file.' };
    }

    for (let i = 0; i < API_KEYS.length; i++) {
      const apiKey = getNextKey();
      const keyNum = ((currentKeyIndex - 1 + API_KEYS.length) % API_KEYS.length) + 1;

      try {
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

        const result = await model.generateContent([
          { text: 'Transcribe the following audio exactly as spoken. Return ONLY the transcription text, nothing else. No quotes, no labels, no formatting.' },
          { inlineData: { mimeType: mimeType || 'audio/webm', data: base64Audio } },
        ]);

        const text = result.response.text().trim();
        console.log(`✓ Transcribed (Key #${keyNum}): "${text.substring(0, 60)}..."`);
        return { success: true, text };
      } catch (e) {
        const msg = e.message || '';
        console.warn(`✗ Transcription Key #${keyNum} — ${msg.substring(0, 80)}`);
        if (msg.includes('400') || msg.includes('API_KEY_INVALID')) continue;
      }
    }

    return { success: false, error: 'Transcription failed: Gemini API quota exceeded or key invalid. (Free tier keys share project quota - try creating a new key in a new AI Studio project)' };
  });

  ipcMain.handle('start-practice', async () => {
    if (setupWindow) setupWindow.hide();
    if (!overlayWindow) createOverlayWindow();
    return { success: true };
  });

  ipcMain.handle('hide-overlay', async () => {
    if (overlayWindow) { overlayWindow.hide(); isOverlayVisible = false; }
  });

  ipcMain.handle('show-setup', async () => {
    if (setupWindow) setupWindow.show();
    else createSetupWindow();
  });

  ipcMain.handle('minimize-window', async (e) => {
    BrowserWindow.fromWebContents(e.sender)?.minimize();
  });

  ipcMain.handle('close-window', async (e) => {
    BrowserWindow.fromWebContents(e.sender)?.close();
  });
}

// ─── App Lifecycle ───────────────────────────────────────────────
app.whenReady().then(() => {
  // Allow all media permissions automatically
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(true));
  session.defaultSession.setPermissionCheckHandler(() => true);

  // Auto-handle display media requests — capture system audio (loopback)
  // This lets the renderer call getDisplayMedia() without a picker dialog
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      // Auto-select primary screen + system audio loopback
      callback({ video: sources[0], audio: 'loopback' });
    }).catch((err) => {
      console.error('Desktop capturer error:', err);
      callback(null);
    });
  });

  loadProfileData();
  registerIPC();
  createSetupWindow();
  createTray();

  globalShortcut.register('CommandOrControl+Shift+A', toggleOverlay);
});

app.on('will-quit', () => globalShortcut.unregisterAll());

// Keep running in tray even when all windows close
app.on('window-all-closed', () => {
  // On Windows, don't quit when all windows are closed — keep in tray
  // App will only quit via Tray > Quit
});
