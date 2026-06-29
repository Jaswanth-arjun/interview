// ─── DOM References ──────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const uploadZone  = $('#uploadZone');
const uploadStatus = $('#uploadStatus');
const resumeText  = $('#resumeText');
const companyName = $('#companyName');
const roleName    = $('#roleName');
const jobDesc     = $('#jobDescription');
const projects    = $('#projects');
const extraNotes  = $('#extraNotes');
const toast       = $('#toast');

// ─── Toast helper ────────────────────────────────────────────
function showToast(msg, type = 'success') {
  toast.textContent = msg;
  toast.className = 'toast show ' + type;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toast.className = 'toast', 2500);
}

// ─── Load saved data on startup ──────────────────────────────
(async function loadSaved() {
  try {
    const data = await window.api.getSetupData();
    if (!data) return;
    resumeText.value  = data.resumeText  || '';
    companyName.value  = data.companyName  || '';
    roleName.value     = data.roleName     || '';
    jobDesc.value      = data.jobDescription || '';
    projects.value     = data.projects     || '';
    extraNotes.value   = data.extraNotes   || '';
    if (data.resumeText) {
      uploadStatus.textContent = 'Resume loaded from saved profile';
      uploadStatus.classList.add('success');
    }
  } catch (e) {
    console.warn('Could not load saved data', e);
  }
})();

// ─── PDF Upload ──────────────────────────────────────────────
uploadZone.addEventListener('click', async () => {
  const result = await window.api.openFileDialog();
  if (!result.success) return;
  await parsePDF(result.filePath);
});

// Drag & drop support
uploadZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  uploadZone.classList.add('drag-over');
});
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
uploadZone.addEventListener('drop', async (e) => {
  e.preventDefault();
  uploadZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file && file.name.endsWith('.pdf')) {
    await parsePDF(file.path);
  } else {
    showToast('Please drop a PDF file', 'error');
  }
});

async function parsePDF(filePath) {
  uploadStatus.textContent = 'Parsing PDF...';
  uploadStatus.classList.remove('success');
  try {
    const result = await window.api.parsePDF(filePath);
    if (result.success) {
      resumeText.value = result.text;
      uploadStatus.textContent = '✅ Resume parsed successfully!';
      uploadStatus.classList.add('success');
      showToast('Resume PDF loaded!');
    } else {
      throw new Error(result.error);
    }
  } catch (e) {
    uploadStatus.textContent = 'Failed to parse PDF';
    showToast('PDF parsing failed: ' + e.message, 'error');
  }
}

// ─── Collect form data ──────────────────────────────────────
function collectData() {
  return {
    resumeText:     resumeText.value.trim(),
    companyName:    companyName.value.trim(),
    roleName:       roleName.value.trim(),
    jobDescription: jobDesc.value.trim(),
    projects:       projects.value.trim(),
    extraNotes:     extraNotes.value.trim(),
  };
}

// ─── Save Profile ────────────────────────────────────────────
$('#saveBtn').addEventListener('click', async () => {
  const data = collectData();
  if (!data.resumeText && !data.jobDescription) {
    showToast('Please add at least a resume or job description', 'error');
    return;
  }
  await window.api.saveSetupData(data);
  showToast('Profile saved! ✅');
});

// ─── Start Practice ──────────────────────────────────────────
$('#startBtn').addEventListener('click', async () => {
  const data = collectData();
  if (!data.resumeText && !data.jobDescription) {
    showToast('Please add at least a resume or job description', 'error');
    return;
  }
  await window.api.saveSetupData(data);
  showToast('Starting practice mode...');
  setTimeout(async () => {
    await window.api.startPractice();
  }, 600);
});

// ─── Titlebar controls ──────────────────────────────────────
$('#btnMinimize').addEventListener('click', () => window.api.minimizeWindow());
$('#btnClose').addEventListener('click', () => window.api.closeWindow());
