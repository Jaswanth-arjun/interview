// ─── DOM References ──────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);

const statusDot   = $('#statusDot');
const statusText  = $('#statusText');
const questionBox = $('#questionBox');
const questionPH  = $('#questionPlaceholder');
const questionTxt = $('#questionText');
const answerBox   = $('#answerBox');
const answerPH    = $('#answerPlaceholder');
const answerTxt   = $('#answerText');
const loader      = $('#loader');
const btnListen   = $('#btnListen');
const listenLabel = $('#listenLabel');
const btnType     = $('#btnType');
const manualInput = $('#manualInput');
const manualQ     = $('#manualQ');
const btnSend     = $('#btnSend');
const btnCopy     = $('#btnCopy');
const btnSetup    = $('#btnSetup');
const btnClose    = $('#btnClose');

// ─── State ───────────────────────────────────────────────────
let isListening = false;
let isContinuousMode = false;
let mediaRecorder = null;
let audioChunks = [];
let audioStream = null;
let audioContext = null;
let silenceTimeout = null;

// Microphone analysis for user voice filtering (echo/user response cancellation)
let micStream = null;
let micAnalyser = null;
let micDataArray = null;
let hasUserSpoken = false;

// ─── Status Helpers ──────────────────────────────────────────
function setStatus(state, text) {
  statusDot.className = 'status-dot ' + state;
  statusText.textContent = text;
}

// ─── UI Visual Handlers ──────────────────────────────────────
function showQuestion(text) {
  questionPH.style.display = 'none';
  questionTxt.style.display = 'block';
  questionTxt.textContent = text;
}

function showAnswer(text) {
  loader.style.display = 'none';
  answerPH.style.display = 'none';
  answerTxt.style.display = 'block';
  answerTxt.textContent = text;
}

function showLoader() {
  answerPH.style.display = 'none';
  answerTxt.style.display = 'none';
  loader.style.display = 'flex';
}

function showError(msg) {
  loader.style.display = 'none';
  answerPH.style.display = 'none';
  answerTxt.style.display = 'block';
  answerTxt.textContent = '⚠️ ' + msg;
  setStatus('error', 'Error occurred');
}

// ─── Helpers ─────────────────────────────────────────────────
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

// ─── Microphone Init Helper ──────────────────────────────────
async function initMic() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const micContext = new AudioCtx();
    const source = micContext.createMediaStreamSource(micStream);
    micAnalyser = micContext.createAnalyser();
    micAnalyser.fftSize = 256;
    source.connect(micAnalyser);
    micDataArray = new Uint8Array(micAnalyser.frequencyBinCount);
    console.log('✓ Microphone initialized for user voice filtering.');
  } catch (err) {
    console.warn('Microphone access not granted or failed:', err);
  }
}

// ─── Audio Capture (MediaRecorder + Gemini/Groq Transcription) ────
async function startListening(isAutoRestart = false) {
  if (isListening) return;
  if (!isAutoRestart) {
    isContinuousMode = true;
  }
  hasUserSpoken = false; // Reset speaker state

  try {
    // Capture system audio (interviewer's voice from screen/video call)
    const displayStream = await navigator.mediaDevices.getDisplayMedia({
      audio: true,
      video: true, // Required by API — we discard it immediately
    });

    // Keep only audio tracks — stop video tracks
    const audioTracks = displayStream.getAudioTracks();
    displayStream.getVideoTracks().forEach((t) => t.stop());

    if (audioTracks.length === 0) {
      displayStream.getTracks().forEach((t) => t.stop());
      setStatus('error', 'No system audio detected — is your call playing sound?');
      isContinuousMode = false;
      stopListeningUI();
      return;
    }

    audioStream = new MediaStream(audioTracks);

    // Set up audio analysis for silence detection
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioContext.createMediaStreamSource(audioStream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.85;
    source.connect(analyser);

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    const SILENCE_THRESHOLD = 12;
    const SILENCE_DURATION = 600; // 0.6s of silence → auto-stop (fast detection)
    let hasSpeechStarted = false;

    // Pick a supported MIME type
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : '';

    const recorderOptions = mimeType ? { mimeType } : {};
    mediaRecorder = new MediaRecorder(audioStream, recorderOptions);
    audioChunks = [];

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      cleanupAudio();

      // If user was speaking, discard and start listening again immediately
      if (hasUserSpoken) {
        console.log('User voice detected. Discarding transcription.');
        setStatus('ready', 'User voice ignored — listening for interviewer...');
        if (isContinuousMode) {
          listenLabel.textContent = 'Resuming...';
          setTimeout(() => startListening(true), 300);
        } else {
          stopListeningUI();
        }
        return;
      }

      if (audioChunks.length === 0) {
        setStatus('ready', 'No audio captured — resuming...');
        if (isContinuousMode) {
          listenLabel.textContent = 'Resuming...';
          setTimeout(() => startListening(true), 300);
        } else {
          stopListeningUI();
        }
        return;
      }

      const actualMime = mimeType ? mimeType.split(';')[0] : 'audio/webm';
      const audioBlob = new Blob(audioChunks, { type: actualMime });

      // Skip if audio is too short (< 1KB = ~noise)
      if (audioBlob.size < 1000) {
        setStatus('ready', 'Too short — resuming...');
        if (isContinuousMode) {
          listenLabel.textContent = 'Resuming...';
          setTimeout(() => startListening(true), 300);
        } else {
          stopListeningUI();
        }
        return;
      }

      // Convert to base64 and send for transcription
      const arrayBuffer = await audioBlob.arrayBuffer();
      const base64Audio = arrayBufferToBase64(arrayBuffer);

      setStatus('thinking', 'Transcribing audio...');
      if (isContinuousMode) {
        listenLabel.textContent = 'Transcribing...';
      } else {
        stopListeningUI();
      }
      showLoader();

      try {
        const result = await window.api.transcribeAudio(base64Audio, actualMime);
        if (result.success && result.text) {
          const question = result.text.trim();
          processQuestion(question);
        } else {
          if (result.noSpeech) {
            // Suppress background noise / silence without showing errors
            setStatus('listening', 'Capturing interviewer audio from screen');
            hideLoader();
            if (isContinuousMode) {
              listenLabel.textContent = 'Listening...';
              startListening(true);
            } else {
              stopListeningUI();
            }
          } else {
            showError(result.error || 'Transcription failed');
            if (isContinuousMode) {
              listenLabel.textContent = 'Resuming...';
              setTimeout(() => startListening(true), 500);
            }
          }
        }
      } catch (e) {
        showError('Transcription failed: ' + e.message);
        if (isContinuousMode) {
          listenLabel.textContent = 'Resuming...';
          setTimeout(() => startListening(true), 2000);
        }
      }
    };

    // Start recording — collect data every 500ms
    mediaRecorder.start(500);

    isListening = true;
    btnListen.classList.add('active');
    listenLabel.textContent = 'Recording...';
    setStatus('listening', 'Capturing interviewer audio from screen');

    // ─── Silence detection loop ─────────────────────────────
    function checkSilence() {
      if (!isListening) return;

      // 1. Check system audio (interviewer)
      analyser.getByteFrequencyData(dataArray);
      const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;

      // 2. Check mic audio (user)
      let avgMic = 0;
      if (micAnalyser && micDataArray) {
        micAnalyser.getByteFrequencyData(micDataArray);
        avgMic = micDataArray.reduce((a, b) => a + b, 0) / micDataArray.length;
      }

      // Only flag as user speaking if mic is loud AND system audio is quiet (to avoid speaker echo)
      const MIC_TALKING_THRESHOLD = 18;
      const SYSTEM_SILENT_THRESHOLD = 5;
      if (avgMic > MIC_TALKING_THRESHOLD && avg < SYSTEM_SILENT_THRESHOLD) {
        hasUserSpoken = true;
      }

      if (avg > SILENCE_THRESHOLD) {
        hasSpeechStarted = true;
        clearTimeout(silenceTimeout);
        silenceTimeout = null;
      } else if (hasSpeechStarted && !silenceTimeout) {
        // Speech was detected, now it's quiet → start countdown
        silenceTimeout = setTimeout(() => {
          if (isListening) stopListening(false); // Silence trigger is NOT manual
        }, SILENCE_DURATION);
      }

      requestAnimationFrame(checkSilence);
    }
    checkSilence();

  } catch (e) {
    console.error('System audio error:', e);
    if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
      setStatus('error', 'Screen capture denied — try again');
    } else {
      setStatus('error', 'Audio capture error: ' + e.message);
    }
    isContinuousMode = false;
    stopListeningUI();
  }
}

function stopListening(isManual = false) {
  isListening = false;
  if (isManual) {
    isContinuousMode = false;
  }
  clearTimeout(silenceTimeout);
  silenceTimeout = null;

  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop(); // triggers onstop → transcription
  } else {
    cleanupAudio();
    stopListeningUI();
  }
}

function cleanupAudio() {
  if (audioStream) {
    audioStream.getTracks().forEach((t) => t.stop());
    audioStream = null;
  }
  if (audioContext && audioContext.state !== 'closed') {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
}

function stopListeningUI() {
  isListening = false;
  btnListen.classList.remove('active');
  listenLabel.textContent = 'Start Listening';
}

// ─── Process Question → Generate Answer ──────────────────────
async function processQuestion(question) {
  if (!question) return;

  showQuestion(question);
  showLoader();
  setStatus('thinking', 'Generating answer...');
  if (isContinuousMode) {
    listenLabel.textContent = 'Thinking...';
  }

  try {
    const result = await window.api.generateAnswer(question);
    if (result.success) {
      showAnswer(result.answer);
      setStatus('ready', 'Answer ready ✓');
      if (isContinuousMode) {
        listenLabel.textContent = 'Resuming...';
        setTimeout(() => startListening(true), 300);
      }
    } else {
      showError(result.error);
      if (isContinuousMode) {
        listenLabel.textContent = 'Resuming...';
        setTimeout(() => startListening(true), 500);
      }
    }
  } catch (e) {
    showError('Failed to generate answer: ' + e.message);
    if (isContinuousMode) {
      listenLabel.textContent = 'Resuming...';
      setTimeout(() => startListening(true), 2000);
    }
  }
}

// ─── Event Listeners ─────────────────────────────────────────

// Toggle listening (acts as loop start/stop)
btnListen.addEventListener('click', () => {
  if (isContinuousMode || isListening) {
    stopListening(true); // Manual stop disables continuous loop
    setStatus('ready', 'Ready');
  } else {
    startListening();
  }
});

// Toggle manual input
btnType.addEventListener('click', () => {
  const vis = manualInput.style.display === 'none';
  manualInput.style.display = vis ? 'flex' : 'none';
  if (vis) manualQ.focus();
});

// Submit manual question
btnSend.addEventListener('click', () => {
  const q = manualQ.value.trim();
  if (q) {
    manualQ.value = '';
    processQuestion(q);
  }
});
manualQ.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') btnSend.click();
});

// Copy answer
btnCopy.addEventListener('click', () => {
  const text = answerTxt.textContent;
  if (text && answerTxt.style.display !== 'none') {
    navigator.clipboard.writeText(text);
    btnCopy.textContent = '✅';
    setTimeout(() => btnCopy.textContent = '📋', 1500);
  }
});

// Title bar actions
btnSetup.addEventListener('click', () => window.api.showSetup());
btnClose.addEventListener('click', () => window.api.hideOverlay());

// Escape key to hide
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.api.hideOverlay();
});

// ─── Init ────────────────────────────────────────────────────
// Listen for real-time streaming answer chunks from main process
window.api.onAnswerChunk((chunk) => {
  if (loader.style.display !== 'none') {
    loader.style.display = 'none';
    answerPH.style.display = 'none';
    answerTxt.style.display = 'block';
    answerTxt.textContent = '';
  }
  answerTxt.textContent += chunk;
});

setStatus('ready', 'Ready — Click 🎤 to capture interviewer audio');

// Auto-start listening on load without needing manual button click
window.addEventListener('DOMContentLoaded', () => {
  initMic().then(() => {
    setTimeout(() => {
      console.log('Auto-starting mock interview listener loop...');
      startListening();
    }, 1000);
  });
});
