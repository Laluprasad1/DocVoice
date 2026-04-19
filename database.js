const fs = require('fs');
const path = require('path');

// Database file paths
const DB_DIR = path.join(__dirname, '.data');
const USERS_DB = path.join(DB_DIR, 'users.json');
const PDFS_DB = path.join(DB_DIR, 'pdfs.json');
const VOICE_CLIPS_DB = path.join(DB_DIR, 'voice-clips.json');
const FAVORITES_DB = path.join(DB_DIR, 'favorites.json');
const SETTINGS_DB = path.join(DB_DIR, 'settings.json');

// Ensure database directory exists
function initializeDatabase() {
  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }

  // Initialize empty databases if they don't exist
  if (!fs.existsSync(USERS_DB)) {
    fs.writeFileSync(USERS_DB, JSON.stringify({}));
  }
  if (!fs.existsSync(PDFS_DB)) {
    fs.writeFileSync(PDFS_DB, JSON.stringify({}));
  }
  if (!fs.existsSync(VOICE_CLIPS_DB)) {
    fs.writeFileSync(VOICE_CLIPS_DB, JSON.stringify({}));
  }
  if (!fs.existsSync(FAVORITES_DB)) {
    fs.writeFileSync(FAVORITES_DB, JSON.stringify({}));
  }
  if (!fs.existsSync(SETTINGS_DB)) {
    fs.writeFileSync(SETTINGS_DB, JSON.stringify({}));
  }
}

// ====== USER MANAGEMENT ======

function getUserData(userId) {
  const data = JSON.parse(fs.readFileSync(USERS_DB, 'utf-8'));
  return data[userId] || null;
}

function saveUserData(userId, userData) {
  const data = JSON.parse(fs.readFileSync(USERS_DB, 'utf-8'));
  data[userId] = {
    ...userData,
    updatedAt: new Date().toISOString()
  };
  fs.writeFileSync(USERS_DB, JSON.stringify(data, null, 2));
}

function getUserStats(userId) {
  try {
    const pdfs = getPdfsByUser(userId);
    const clips = getVoiceClipsByUser(userId);
    const userData = getUserData(userId);

    const totalListeningTime = (userData?.totalListeningSeconds || 0) / 3600; // Convert to hours
    const activeDays = userData?.activeDays || 0;

    return {
      documentsProcessed: pdfs.length,
      activeDays: activeDays,
      listeningHours: Math.round(totalListeningTime * 10) / 10,
      savedClips: clips.length,
      lastActive: userData?.lastActive || new Date().toISOString()
    };
  } catch (err) {
    return {
      documentsProcessed: 0,
      activeDays: 0,
      listeningHours: 0,
      savedClips: 0
    };
  }
}

// ====== PDF MANAGEMENT ======

function savePdf(userId, pdfData) {
  const data = JSON.parse(fs.readFileSync(PDFS_DB, 'utf-8'));
  if (!data[userId]) data[userId] = [];

  const pdf = {
    id: pdfData.id || `pdf-${Date.now()}`,
    fileName: pdfData.fileName,
    filePath: pdfData.filePath,
    totalPages: pdfData.totalPages,
    uploadDate: new Date().toISOString(),
    lastAccessed: new Date().toISOString(),
    topics: pdfData.topics || [],
    isFavorite: false,
    readingProgress: 0
  };

  data[userId].push(pdf);
  fs.writeFileSync(PDFS_DB, JSON.stringify(data, null, 2));
  return pdf;
}

function getPdfsByUser(userId) {
  const data = JSON.parse(fs.readFileSync(PDFS_DB, 'utf-8'));
  return data[userId] || [];
}

function getPdfById(userId, pdfId) {
  const pdfs = getPdfsByUser(userId);
  return pdfs.find(p => p.id === pdfId);
}

function updatePdfProgress(userId, pdfId, progress) {
  const data = JSON.parse(fs.readFileSync(PDFS_DB, 'utf-8'));
  if (!data[userId]) return;

  const pdf = data[userId].find(p => p.id === pdfId);
  if (pdf) {
    pdf.readingProgress = progress;
    pdf.lastAccessed = new Date().toISOString();
    fs.writeFileSync(PDFS_DB, JSON.stringify(data, null, 2));
  }
}

function deletePdf(userId, pdfId) {
  const data = JSON.parse(fs.readFileSync(PDFS_DB, 'utf-8'));
  if (!data[userId]) return;

  data[userId] = data[userId].filter(p => p.id !== pdfId);
  fs.writeFileSync(PDFS_DB, JSON.stringify(data, null, 2));

  // Also remove from favorites
  removeFavorite(userId, pdfId);
}

// ====== VOICE CLIPS MANAGEMENT ======

function saveVoiceClip(userId, clipData) {
  const data = JSON.parse(fs.readFileSync(VOICE_CLIPS_DB, 'utf-8'));
  if (!data[userId]) data[userId] = [];

  const clip = {
    id: clipData.id || `clip-${Date.now()}`,
    pdfId: clipData.pdfId,
    fileName: clipData.fileName || `Clip ${new Date().toLocaleTimeString()}`,
    filePath: clipData.filePath,
    duration: clipData.duration || 0,
    createdAt: new Date().toISOString(),
    recordedContent: clipData.recordedContent || '',
    accuracy: clipData.accuracy || 0,
    isFavorite: false
  };

  data[userId].push(clip);
  fs.writeFileSync(VOICE_CLIPS_DB, JSON.stringify(data, null, 2));
  return clip;
}

function getVoiceClipsByUser(userId) {
  const data = JSON.parse(fs.readFileSync(VOICE_CLIPS_DB, 'utf-8'));
  return data[userId] || [];
}

function getVoiceClipsByPdf(userId, pdfId) {
  const clips = getVoiceClipsByUser(userId);
  return clips.filter(c => c.pdfId === pdfId);
}

function renameVoiceClip(userId, clipId, newName) {
  const data = JSON.parse(fs.readFileSync(VOICE_CLIPS_DB, 'utf-8'));
  if (!data[userId]) return;

  const clip = data[userId].find(c => c.id === clipId);
  if (clip) {
    clip.fileName = newName;
    fs.writeFileSync(VOICE_CLIPS_DB, JSON.stringify(data, null, 2));
  }
}

function deleteVoiceClip(userId, clipId) {
  const data = JSON.parse(fs.readFileSync(VOICE_CLIPS_DB, 'utf-8'));
  if (!data[userId]) return;

  data[userId] = data[userId].filter(c => c.id !== clipId);
  fs.writeFileSync(VOICE_CLIPS_DB, JSON.stringify(data, null, 2));
}

// ====== FAVORITES MANAGEMENT ======

function getFavoriteStoreByUser(userId) {
  const data = JSON.parse(fs.readFileSync(FAVORITES_DB, 'utf-8'));
  const raw = data[userId];

  if (Array.isArray(raw)) {
    return {
      data,
      store: {
        pdfIds: raw,
        voiceClipIds: []
      }
    };
  }

  if (raw && typeof raw === 'object') {
    return {
      data,
      store: {
        pdfIds: Array.isArray(raw.pdfIds) ? raw.pdfIds : [],
        voiceClipIds: Array.isArray(raw.voiceClipIds) ? raw.voiceClipIds : []
      }
    };
  }

  return {
    data,
    store: {
      pdfIds: [],
      voiceClipIds: []
    }
  };
}

function addFavorite(userId, pdfId) {
  const { data, store } = getFavoriteStoreByUser(userId);

  if (!store.pdfIds.includes(pdfId)) {
    store.pdfIds.push(pdfId);
    data[userId] = store;
    fs.writeFileSync(FAVORITES_DB, JSON.stringify(data, null, 2));
  }

  // Also update PDF favorite flag
  const pdfData = JSON.parse(fs.readFileSync(PDFS_DB, 'utf-8'));
  if (pdfData[userId]) {
    const pdf = pdfData[userId].find(p => p.id === pdfId);
    if (pdf) {
      pdf.isFavorite = true;
      fs.writeFileSync(PDFS_DB, JSON.stringify(pdfData, null, 2));
    }
  }
}

function removeFavorite(userId, pdfId) {
  const { data, store } = getFavoriteStoreByUser(userId);

  store.pdfIds = store.pdfIds.filter(id => id !== pdfId);
  data[userId] = store;
  fs.writeFileSync(FAVORITES_DB, JSON.stringify(data, null, 2));

  // Also update PDF favorite flag
  const pdfData = JSON.parse(fs.readFileSync(PDFS_DB, 'utf-8'));
  if (pdfData[userId]) {
    const pdf = pdfData[userId].find(p => p.id === pdfId);
    if (pdf) {
      pdf.isFavorite = false;
      fs.writeFileSync(PDFS_DB, JSON.stringify(pdfData, null, 2));
    }
  }
}

function getFavorites(userId) {
  const { store } = getFavoriteStoreByUser(userId);
  const favoriteIds = store.pdfIds;

  const pdfs = getPdfsByUser(userId);
  return pdfs.filter(p => favoriteIds.includes(p.id));
}

function addFavoriteVoiceClip(userId, clipId) {
  const { data, store } = getFavoriteStoreByUser(userId);

  if (!store.voiceClipIds.includes(clipId)) {
    store.voiceClipIds.push(clipId);
    data[userId] = store;
    fs.writeFileSync(FAVORITES_DB, JSON.stringify(data, null, 2));
  }

  const clipData = JSON.parse(fs.readFileSync(VOICE_CLIPS_DB, 'utf-8'));
  if (clipData[userId]) {
    const clip = clipData[userId].find(c => c.id === clipId);
    if (clip) {
      clip.isFavorite = true;
      fs.writeFileSync(VOICE_CLIPS_DB, JSON.stringify(clipData, null, 2));
    }
  }
}

function removeFavoriteVoiceClip(userId, clipId) {
  const { data, store } = getFavoriteStoreByUser(userId);

  store.voiceClipIds = store.voiceClipIds.filter(id => id !== clipId);
  data[userId] = store;
  fs.writeFileSync(FAVORITES_DB, JSON.stringify(data, null, 2));

  const clipData = JSON.parse(fs.readFileSync(VOICE_CLIPS_DB, 'utf-8'));
  if (clipData[userId]) {
    const clip = clipData[userId].find(c => c.id === clipId);
    if (clip) {
      clip.isFavorite = false;
      fs.writeFileSync(VOICE_CLIPS_DB, JSON.stringify(clipData, null, 2));
    }
  }
}

function getFavoriteVoiceClips(userId) {
  const { store } = getFavoriteStoreByUser(userId);
  const favoriteClipIds = store.voiceClipIds;

  const clips = getVoiceClipsByUser(userId);
  return clips.filter(c => favoriteClipIds.includes(c.id));
}

// ====== SETTINGS MANAGEMENT ======

function saveUserSettings(userId, settings) {
  const data = JSON.parse(fs.readFileSync(SETTINGS_DB, 'utf-8'));
  data[userId] = {
    ...settings,
    updatedAt: new Date().toISOString()
  };
  fs.writeFileSync(SETTINGS_DB, JSON.stringify(data, null, 2));
}

function getUserSettings(userId) {
  const data = JSON.parse(fs.readFileSync(SETTINGS_DB, 'utf-8'));
  return data[userId] || {
    theme: 'light',
    speechRate: 1.0,
    volume: 1.0,
    accent: 'en-US',
    linesPerScreen: 6,
    fontSize: 100,
    autoSaveClips: true,
    autoPlayback: false,
    accuracyThreshold: 50
  };
}

function getUserProfile(userId) {
  const profile = getUserData(userId) || {};
  return {
    id: userId,
    firstName: profile.firstName || '',
    lastName: profile.lastName || '',
    name: profile.name || '',
    email: profile.email || '',
    picture: profile.picture || '',
    role: profile.role || 'user'
  };
}

function saveUserProfile(userId, profileData) {
  const current = getUserData(userId) || {};
  const next = {
    ...current,
    ...profileData,
    name: profileData.name || `${profileData.firstName || current.firstName || ''} ${profileData.lastName || current.lastName || ''}`.trim()
  };
  saveUserData(userId, next);
  return getUserProfile(userId);
}

module.exports = {
  initializeDatabase,
  getUserData,
  saveUserData,
  getUserStats,
  savePdf,
  getPdfsByUser,
  getPdfById,
  updatePdfProgress,
  deletePdf,
  saveVoiceClip,
  getVoiceClipsByUser,
  getVoiceClipsByPdf,
  renameVoiceClip,
  deleteVoiceClip,
  addFavorite,
  removeFavorite,
  getFavorites,
  addFavoriteVoiceClip,
  removeFavoriteVoiceClip,
  getFavoriteVoiceClips,
  saveUserSettings,
  getUserSettings,
  getUserProfile,
  saveUserProfile
};
