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
console.log(process.env.OMNI_ROUTE_API_KEY && !process.env.OMNI_ROUTE_API_KEY.startsWith('your_') ? '✓ Loaded OmniRoute API key' : '✗ No OmniRoute API key loaded');

function getNextKey() {
  if (API_KEYS.length === 0) return null;
  const key = API_KEYS[currentKeyIndex];
  currentKeyIndex = (currentKeyIndex + 1) % API_KEYS.length;
  return key;
}

// ─── Resilient Fetch (auto-retry on network failures) ────────────
async function fetchWithRetry(url, options = {}, { retries = 2, timeoutMs = 15000, retryDelayMs = 1000 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timer);
      return response;
    } catch (err) {
      clearTimeout(timer);
      const isLastAttempt = attempt === retries;
      const isNetworkError = err.name === 'AbortError' || err.message?.includes('fetch failed') || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT';
      if (isLastAttempt || !isNetworkError) throw err;
      console.log(`⟳ Network error on attempt ${attempt + 1}/${retries + 1}, retrying in ${retryDelayMs}ms...`);
      await new Promise(r => setTimeout(r, retryDelayMs));
    }
  }
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
  const candidateContext = `TARGET JOB DETAILS:
- Role: ${d.roleName || 'Not specified'}
- Company: ${d.companyName || 'Not specified'}
- Target Job Description: ${d.jobDescription || 'Not provided'}

DETAILED RESUME CONTENT:
${d.resumeText || 'Not provided'}

DETAILED PROJECTS, SKILLS, & ACHIEVEMENTS:
${d.projects || 'Not provided'}

EXTRA CANDIDATE NOTES:
${d.extraNotes || 'Not provided'}`;

  return `You are a candidate in a live interview. Answer: "${question}"

RULES:
- SUBJECT/TECHNICAL questions: explain the concept directly using your knowledge. Do NOT reference your resume or projects unless asked about your experience.
- RESUME/PROJECT questions: answer using ONLY facts from the candidate context below. Never invent details.
- Speak first person, natural, conversational. 3-5 sentences max.
- NO bullet points, NO markdown, NO lists, NO filler like "Sure" or "Certainly".
- Start answering immediately as the candidate.

─── CONTEXT ───
Role: ${d.roleName || 'N/A'} at ${d.companyName || 'N/A'}
JD: ${d.jobDescription || 'N/A'}
Resume: ${d.resumeText || 'N/A'}
Projects: ${d.projects || 'N/A'}
Notes: ${d.extraNotes || 'N/A'}
───────────────
Answer now:`;
}
function cleanTranscriptionText(text) {
  if (!text) return '';
  
  // 1. If the transcription is just a common silent audio hallucination, suppress it.
  const lower = text.toLowerCase().trim().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, "");
  const hallucinations = [
    "thank you",
    "thank you thank you",
    "thank you very much",
    "thank you for watching",
    "subtitles by yify",
    "please subscribe",
    "subscribe to my channel",
    "reformatted by",
    "you"
  ];
  if (hallucinations.includes(lower)) {
    return '';
  }

  // 2. Remove continuous repeated words (e.g., "you you you you" or "thank thank thank")
  let cleaned = text.replace(/\b(\w+)(?:\s+\1)+\b/gi, '$1');
  
  // 3. Remove repeated sentences or phrases (e.g., "Thank you. Thank you.")
  const sentences = cleaned.split(/(?<=[.!?])\s+/);
  const deduplicatedSentences = [];
  let lastSentence = "";
  let repeatCount = 0;
  for (const sentence of sentences) {
    const norm = sentence.trim().toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, "");
    const normLast = lastSentence.trim().toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, "");
    if (norm === normLast) {
      repeatCount++;
      if (repeatCount < 1) {
        deduplicatedSentences.push(sentence);
      }
    } else {
      deduplicatedSentences.push(sentence);
      lastSentence = sentence;
      repeatCount = 0;
    }
  }
  cleaned = deduplicatedSentences.join(' ').trim();
  
  // 4. Repeatedly strip leading/trailing Whisper hallucination / silence loop phrases from the actual question
  let cleanText = cleaned.trim();
  let prev;
  do {
    prev = cleanText;
    cleanText = cleanText.replace(/^(thank you|thanks|you|please subscribe|subscribe|thank you very much|reformatted by|subtitles by yify)[.,\s!?]*/gi, '');
  } while (cleanText !== prev);

  cleaned = cleanText.trim();

  // 5. If the remaining text is just a bunch of repeated short words (like "you you"), clear it
  const words = cleaned.toLowerCase().split(/\s+/);
  const uniqueWords = new Set(words);
  if (words.length > 5 && uniqueWords.size === 1) {
    return '';
  }
  if (words.length > 5 && uniqueWords.size === 2 && (uniqueWords.has('thank') || uniqueWords.has('you') || uniqueWords.has('thanks'))) {
    return '';
  }

  return cleaned;
}

// ─── IPC Handlers ────────────────────────────────────────────────
function registerIPC() {
  ipcMain.handle('save-setup-data', async (_e, data) => {
    // Save raw details
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

  // ─── Helper: Stream OpenAI-compatible response ─────────────────
  async function streamOpenAIResponse(response, webContents) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
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
          } catch (err) { /* skip malformed chunks */ }
        }
      }
    }
    return fullText;
  }

  ipcMain.handle('generate-answer', async (e, question) => {
    const webContents = e.sender;
    const prompt = buildPrompt(question);
    const errors = [];

    // ══════ 1. GROQ (fastest — sub-second streaming) ══════
    const groqKey = process.env.GROQ_API_KEY;
    if (groqKey && !groqKey.startsWith('your_')) {
      try {
        console.log('⚡ Trying Groq (fastest)...');
        const response = await fetchWithRetry('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` },
          body: JSON.stringify({
            model: 'llama-3.3-70b-versatile',
            messages: [{ role: 'user', content: prompt }],
            stream: true,
            temperature: 0.6,
            max_tokens: 300
          })
        });
        if (!response.ok) throw new Error(`Groq HTTP ${response.status}`);
        const fullText = await streamOpenAIResponse(response, webContents);
        if (fullText) {
          console.log('✓ Answer via Groq (fast path)');
          return { success: true, answer: fullText };
        }
        throw new Error('Groq empty response');
      } catch (e) {
        console.warn(`✗ Groq failed: ${e.message}`);
        errors.push(`Groq: ${e.message}`);
      }
    }

    // ══════ 2. OmniRoute ══════
    const omniRouteKey = process.env.OMNI_ROUTE_API_KEY;
    if (omniRouteKey && !omniRouteKey.startsWith('your_')) {
      const modelName = process.env.OMNI_ROUTE_MODEL || 'mimo-v2.5-free';
      const baseUrl = process.env.OMNI_ROUTE_BASE_URL || 'http://localhost:20128/v1';
      try {
        console.log(`Trying OmniRoute ${modelName}...`);
        const response = await fetchWithRetry(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${omniRouteKey}` },
          body: JSON.stringify({ model: modelName, messages: [{ role: 'user', content: prompt }], stream: true })
        });
        if (!response.ok) throw new Error(`OmniRoute HTTP ${response.status}`);
        const fullText = await streamOpenAIResponse(response, webContents);
        if (fullText) {
          console.log(`✓ Answer via OmniRoute (${modelName})`);
          return { success: true, answer: fullText };
        }
        throw new Error('OmniRoute empty response');
      } catch (e) {
        console.warn(`✗ OmniRoute failed: ${e.message}`);
        errors.push(`OmniRoute: ${e.message}`);
      }
    }

    // ══════ 3. Gemini fallback ══════
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    if (API_KEYS.length === 0) {
      return { success: false, error: 'No API keys configured. Add GROQ_API_KEY or GEMINI_API_KEY_1 to .env file.' };
    }

    const MODELS = ['gemini-2.0-flash-lite', 'gemini-2.0-flash'];
    for (let i = 0; i < API_KEYS.length; i++) {
      const apiKey = getNextKey();
      const keyNum = ((currentKeyIndex - 1 + API_KEYS.length) % API_KEYS.length) + 1;
      for (const modelName of MODELS) {
        try {
          console.log(`Trying Gemini ${modelName} (Key #${keyNum})...`);
          const genAI = new GoogleGenerativeAI(apiKey);
          const model = genAI.getGenerativeModel({ model: modelName });
          const result = await model.generateContentStream(prompt);
          let fullText = '';
          for await (const chunk of result.stream) {
            const chunkText = chunk.text();
            fullText += chunkText;
            webContents.send('answer-chunk', chunkText);
          }
          console.log(`✓ Answer via Gemini (Key #${keyNum}, ${modelName})`);
          return { success: true, answer: fullText };
        } catch (e) {
          const msg = e.message || '';
          console.warn(`✗ Gemini Key #${keyNum}/${modelName}: ${msg.substring(0, 60)}`);
          if (msg.includes('400') || msg.includes('API_KEY_INVALID')) break;
          errors.push(`Gemini #${keyNum}/${modelName}: ${msg}`);
        }
      }
    }

    return { success: false, error: errors.join('\n') || 'All providers failed.' };
  });

  ipcMain.handle('transcribe-audio', async (_e, base64Audio, mimeType) => {
    const errors = [];

    // Helper: build audio form data
    function buildFormData(model) {
      const buffer = Buffer.from(base64Audio, 'base64');
      const fd = new FormData();
      let ext = 'webm';
      if (mimeType && mimeType.includes('wav')) ext = 'wav';
      else if (mimeType && mimeType.includes('mp3')) ext = 'mp3';
      else if (mimeType && mimeType.includes('m4a')) ext = 'm4a';
      const blob = new Blob([buffer], { type: mimeType || 'audio/webm' });
      fd.append('file', blob, `audio.${ext}`);
      fd.append('model', model);
      return fd;
    }

    // Helper: process transcription result
    function processResult(providerName, text) {
      const cleaned = cleanTranscriptionText(text);
      if (!cleaned) {
        console.log(`✓ ${providerName}: "${text.substring(0, 50)}..." → silence/hallucination suppressed`);
        return { success: false, error: 'No speech detected', noSpeech: true };
      }
      console.log(`✓ ${providerName}: "${cleaned.substring(0, 60)}..."`);
      return { success: true, text: cleaned };
    }

    // ══════ 1. GROQ Whisper (fastest — sub-second) ══════
    const groqKey = process.env.GROQ_API_KEY;
    if (groqKey && !groqKey.startsWith('your_')) {
      try {
        console.log('⚡ Transcribing via Groq Whisper (fastest)...');
        const response = await fetchWithRetry('https://api.groq.com/openai/v1/audio/transcriptions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${groqKey}` },
          body: buildFormData('whisper-large-v3')
        });
        if (response.ok) {
          const data = await response.json();
          const text = data.text?.trim();
          if (text) return processResult('Groq', text);
        } else {
          console.warn(`✗ Groq Whisper HTTP ${response.status}`);
          errors.push(`Groq: HTTP ${response.status}`);
        }
      } catch (e) {
        console.warn(`✗ Groq Whisper failed: ${e.message}`);
        errors.push(`Groq: ${e.message}`);
      }
    }

    // ══════ 2. OmniRoute Whisper ══════
    const omniRouteKey = process.env.OMNI_ROUTE_API_KEY;
    if (omniRouteKey && !omniRouteKey.startsWith('your_')) {
      const baseUrl = process.env.OMNI_ROUTE_BASE_URL || 'http://localhost:20128/v1';
      try {
        console.log('Transcribing via OmniRoute Whisper...');
        const response = await fetchWithRetry(`${baseUrl}/audio/transcriptions`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${omniRouteKey}` },
          body: buildFormData('whisper-1')
        });
        if (response.ok) {
          const data = await response.json();
          const text = data.text?.trim();
          if (text) return processResult('OmniRoute', text);
        } else {
          console.warn(`✗ OmniRoute Whisper HTTP ${response.status}`);
          errors.push(`OmniRoute: HTTP ${response.status}`);
        }
      } catch (e) {
        console.warn(`✗ OmniRoute Whisper failed: ${e.message}`);
        errors.push(`OmniRoute: ${e.message}`);
      }
    }

    // ══════ 3. Gemini fallback ══════
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    if (API_KEYS.length === 0) {
      return { success: false, error: 'No API keys found. Add GROQ_API_KEY or GEMINI_API_KEY_1 to .env.' };
    }

    for (let i = 0; i < API_KEYS.length; i++) {
      const apiKey = getNextKey();
      const keyNum = ((currentKeyIndex - 1 + API_KEYS.length) % API_KEYS.length) + 1;
      try {
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
        const result = await model.generateContent([
          { text: 'Transcribe the following audio exactly as spoken. Return ONLY the transcription text, nothing else.' },
          { inlineData: { mimeType: mimeType || 'audio/webm', data: base64Audio } },
        ]);
        const text = result.response.text().trim();
        return processResult(`Gemini #${keyNum}`, text);
      } catch (e) {
        console.warn(`✗ Gemini Transcription Key #${keyNum}: ${(e.message || '').substring(0, 60)}`);
        errors.push(`Gemini #${keyNum}: ${e.message}`);
      }
    }

    return { success: false, error: errors.join('; ') || 'All transcription providers failed.' };
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
