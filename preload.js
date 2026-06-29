const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Setup data
  saveSetupData: (data) => ipcRenderer.invoke('save-setup-data', data),
  getSetupData: () => ipcRenderer.invoke('get-setup-data'),

  // PDF parsing
  openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),
  parsePDF: (filePath) => ipcRenderer.invoke('parse-pdf', filePath),

  // AI
  generateAnswer: (question) => ipcRenderer.invoke('generate-answer', question),
  onAnswerChunk: (callback) => ipcRenderer.on('answer-chunk', (event, chunk) => callback(chunk)),
  transcribeAudio: (base64Audio, mimeType) => ipcRenderer.invoke('transcribe-audio', base64Audio, mimeType),

  // Window controls
  startPractice: () => ipcRenderer.invoke('start-practice'),
  hideOverlay: () => ipcRenderer.invoke('hide-overlay'),
  showSetup: () => ipcRenderer.invoke('show-setup'),
  minimizeWindow: () => ipcRenderer.invoke('minimize-window'),
  closeWindow: () => ipcRenderer.invoke('close-window'),
});
