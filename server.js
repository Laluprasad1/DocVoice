const express = require('express');
const multer = require('multer');
const pdf = require('pdf-parse');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { randomUUID } = require('crypto');
const cors = require('cors');
const ffmpeg = require('fluent-ffmpeg');
const { WaveFile } = require('wavefile');
const axios = require('axios');
const session = require('express-session');
const db = require('./database');
require('dotenv').config();

let ffmpegPath = null;
try {
  ffmpegPath = require('ffmpeg-static');
} catch (error) {
  ffmpegPath = null;
  console.warn(`ffmpeg-static is unavailable in this environment. Reason: ${error.message}`);
}

// Initialize database
db.initializeDatabase();

const app = express();
const BASE_PORT = Number.parseInt(process.env.PORT, 10) || 3002;
const MAX_PORT_RETRIES = 10;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session middleware for OAuth
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-key-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

function ensureAuthenticatedPage(req, res, next) {
  if (req.session && req.session.user) {
    return next();
  }
  const nextPath = encodeURIComponent(req.originalUrl || '/app');
  return res.redirect(`/login?next=${nextPath}`);
}

function ensureAuthenticatedApi(req, res, next) {
  if (req.session && req.session.user) {
    return next();
  }
  return res.status(401).json({ error: 'Not authenticated' });
}

// Serve landing and app pages from root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index-landing.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'login.html'));
});

app.get('/signup', (req, res) => {
  res.sendFile(path.join(__dirname, 'signup.html'));
});

app.get('/dashboard', ensureAuthenticatedPage, (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.get('/my-pdfs.html', ensureAuthenticatedPage, (req, res) => {
  res.sendFile(path.join(__dirname, 'my-pdfs.html'));
});

app.get('/voices.html', ensureAuthenticatedPage, (req, res) => {
  res.sendFile(path.join(__dirname, 'voices.html'));
});

app.get('/favorites.html', ensureAuthenticatedPage, (req, res) => {
  res.sendFile(path.join(__dirname, 'favorites.html'));
});

app.get('/settings.html', ensureAuthenticatedPage, (req, res) => {
  res.sendFile(path.join(__dirname, 'settings.html'));
});

app.get('/admin-dashboard', ensureAuthenticatedPage, (req, res) => {
  res.sendFile(path.join(__dirname, 'admin-dashboard.html'));
});

app.get('/app', ensureAuthenticatedPage, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/index.html', ensureAuthenticatedPage, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ===== GOOGLE OAUTH ROUTES =====

// 1. Initiate OAuth flow - redirects to Google login
app.get('/api/auth/google', (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  const scope = 'profile email';
  
  const googleAuthUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
    `client_id=${clientId}&` +
    `redirect_uri=${encodeURIComponent(redirectUri)}&` +
    `response_type=code&` +
    `scope=${encodeURIComponent(scope)}&` +
    `access_type=offline`;
  
  res.redirect(googleAuthUrl);
});

// 2. OAuth callback - handles token exchange and user info
app.get('/api/auth/google/callback', async (req, res) => {
  try {
    const { code, error } = req.query;
    
    if (error) {
      return res.redirect(`/login?error=${error}`);
    }
    
    if (!code) {
      return res.redirect('/login?error=missing_code');
    }
    
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri = process.env.GOOGLE_REDIRECT_URI;
    
    // Exchange authorization code for tokens
    const tokenResponse = await axios.post('https://oauth2.googleapis.com/token', {
      client_id: clientId,
      client_secret: clientSecret,
      code: code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri
    });
    
    const { access_token } = tokenResponse.data;
    
    // Get user info from Google
    const userResponse = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: {
        Authorization: `Bearer ${access_token}`
      }
    });
    
    const { email, name, picture, id } = userResponse.data;
    
    // Store user session
    req.session.user = {
      id: id,
      email: email,
      name: name,
      picture: picture,
      role: 'user', // Default role - you can update this based on email domain or DB
      loggedInAt: new Date().toISOString(),
      authProvider: 'google'
    };
    req.session.save((err) => {
      if (err) {
        console.error('Failed to save Google OAuth session:', err);
        return res.redirect('/login?error=session_save_failed');
      }

      return res.redirect('/app');
    });
  } catch (error) {
    console.error('Google OAuth callback failed:', error);
    res.redirect('/login?error=oauth_failed');
  }
});
// 4. Check session status
app.get('/api/auth/session', (req, res) => {
  if (req.session.user) {
    res.json({
      authenticated: true,
      user: req.session.user
    });
  } else {
    res.json({
      authenticated: false
    });
  }
});

// 5. Bootstrap local session for email/password login (non-OAuth)
app.post('/api/auth/session/local', (req, res) => {
  try {
    const { email, firstName, lastName, name, role } = req.body || {};
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const localId = String(email).toLowerCase().replace(/[^a-z0-9]/g, '_');
    const displayName = String(name || `${firstName || ''} ${lastName || ''}`.trim() || email.split('@')[0]);

    const localUser = {
      id: `local_${localId}`,
      email,
      firstName: firstName || '',
      lastName: lastName || '',
      name: displayName,
      picture: '',
      role: role || 'user',
      loggedInAt: new Date().toISOString(),
      authProvider: 'local'
    };

    req.session.user = localUser;
    db.saveUserData(localUser.id, localUser);

    req.session.save((err) => {
      if (err) {
        return res.status(500).json({ error: 'Failed to save session' });
      }
      res.json({ success: true, user: localUser });
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create local session' });
  }
});

// Serve public directory AFTER routes
app.use(express.static('public'));

let ffmpegRuntimeAvailable = false;
let ffmpegRuntimeError = null;

function validateFfmpegBinary(binaryPath) {
  if (!binaryPath) {
    return { ok: false, reason: 'ffmpeg-static binary path not found' };
  }

  try {
    const result = spawnSync(binaryPath, ['-version'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 8000
    });

    if (result.error) {
      return { ok: false, reason: result.error.message };
    }

    if (typeof result.status === 'number' && result.status !== 0) {
      const stderr = (result.stderr || '').toString().trim();
      return { ok: false, reason: stderr || `ffmpeg exited with code ${result.status}` };
    }

    return { ok: true, reason: null };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

const ffmpegValidation = validateFfmpegBinary(ffmpegPath);
if (ffmpegValidation.ok) {
  ffmpeg.setFfmpegPath(ffmpegPath);
  ffmpegRuntimeAvailable = true;
} else {
  ffmpegRuntimeAvailable = false;
  ffmpegRuntimeError = ffmpegValidation.reason;
  console.warn(`Local ffmpeg unavailable. Falling back to browser speech recognition. Reason: ${ffmpegRuntimeError}`);
}

// Setup multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files allowed'), false);
    }
  }
});

const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 12 * 1024 * 1024
  }
});

// Store current PDF data by authenticated user
const userReadingState = new Map();

function createEmptyReadingState() {
  return {
    pages: [],
    currentPageIndex: 0,
    fileName: ''
  };
}

function getReadingStateForUser(userId) {
  if (!userReadingState.has(userId)) {
    userReadingState.set(userId, createEmptyReadingState());
  }
  return userReadingState.get(userId);
}

function getRequestUserReadingState(req) {
  if (!req.session || !req.session.user || !req.session.user.id) {
    return null;
  }
  return getReadingStateForUser(req.session.user.id);
}

let whisperPipelinePromise = null;
let whisperModelLoadError = null;
let whisperModelReady = false;
const whisperModelName = process.env.WHISPER_MODEL || 'onnx-community/whisper-base.en';

async function getWhisperPipeline() {
  if (!whisperPipelinePromise) {
    whisperPipelinePromise = (async () => {
      try {
        const transformers = await import('@huggingface/transformers');
        transformers.env.cacheDir = path.join(__dirname, '.cache', 'transformers');
        transformers.env.allowLocalModels = false;

        const pipelineInstance = await transformers.pipeline('automatic-speech-recognition', whisperModelName, {
          dtype: 'q8'
        });
        whisperModelReady = true;
        whisperModelLoadError = null;
        return pipelineInstance;
      } catch (error) {
        whisperModelLoadError = error;
        whisperModelReady = false;
        whisperPipelinePromise = null;
        throw error;
      }
    })();
  }

  return whisperPipelinePromise;
}

function convertAudioToWave(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioChannels(1)
      .audioFrequency(16000)
      .format('wav')
      .on('end', resolve)
      .on('error', reject)
      .save(outputPath);
  });
}

function loadWaveFileAsFloat32Array(filePath) {
  const wav = new WaveFile(fs.readFileSync(filePath));
  wav.toBitDepth('32f');
  wav.toSampleRate(16000);

  const samples = wav.getSamples(false, Float32Array);
  if (Array.isArray(samples)) {
    if (samples.length === 0) {
      return new Float32Array();
    }
    if (samples.length === 1) {
      return samples[0];
    }

    const merged = new Float32Array(samples[0].length);
    for (let i = 0; i < samples[0].length; i++) {
      let sum = 0;
      for (let channel = 0; channel < samples.length; channel++) {
        sum += samples[channel][i];
      }
      merged[i] = sum / samples.length;
    }
    return merged;
  }

  return samples;
}

function sanitizeTranscriptText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function transcribeAudioBuffer(audioBuffer) {
  if (!ffmpegRuntimeAvailable) {
    throw new Error(`Local transcription is unavailable: ${ffmpegRuntimeError || 'ffmpeg runtime is not available'}`);
  }

  const tempId = randomUUID();
  const inputPath = path.join(os.tmpdir(), `${tempId}.webm`);
  const outputPath = path.join(os.tmpdir(), `${tempId}.wav`);

  try {
    await fs.promises.writeFile(inputPath, audioBuffer);
    await convertAudioToWave(inputPath, outputPath);

    const audioData = loadWaveFileAsFloat32Array(outputPath);
    const transcriber = await getWhisperPipeline();
    const result = await transcriber(audioData, {
      language: 'english',
      task: 'transcribe',
      return_timestamps: false,
      chunk_length_s: 20,
      stride_length_s: 4
    });

    return sanitizeTranscriptText(result.text);
  } finally {
    await Promise.allSettled([
      fs.promises.unlink(inputPath),
      fs.promises.unlink(outputPath)
    ]);
  }
}

// Extract text similarity (fuzzy matching) - More Lenient Version
function calculateSimilarity(str1, str2) {
  // Convert to lowercase and remove extra whitespace
  const s1 = str1.toLowerCase().trim();
  const s2 = str2.toLowerCase().trim();

  // Remove ALL punctuation and special characters
  const s1Clean = s1.replace(/[.,!?;:\-"'()[\]{}]/g, '').replace(/\s+/g, ' ');
  const s2Clean = s2.replace(/[.,!?;:\-"'()[\]{}]/g, '').replace(/\s+/g, ' ');

  // Split into words for word-based matching
  const words1 = s1Clean.split(/\s+/).filter(w => w.length > 0);
  const words2 = s2Clean.split(/\s+/).filter(w => w.length > 0);

  // Calculate word overlap (more forgiving for short texts)
  let wordMatches = 0;
  words2.forEach(word2 => {
    if (words1.some(word1 => 
      word1 === word2 || 
      (word1.length > 3 && word2.length > 3 && calculateWordSimilarity(word1, word2) > 0.85)
    )) {
      wordMatches++;
    }
  });

  const wordSimilarity = words2.length > 0 ? wordMatches / words2.length : 0;

  // Also calculate character-based similarity
  const longer = s1Clean.length > s2Clean.length ? s1Clean : s2Clean;
  const shorter = longer === s1Clean ? s2Clean : s1Clean;

  if (longer.length === 0) return 1.0;

  const editDistance = getEditDistance(longer, shorter);
  const charSimilarity = (longer.length - editDistance) / longer.length;

  // Use weighted average: prioritize word matching for better user experience
  return (wordSimilarity * 0.6) + (charSimilarity * 0.4);
}

// Calculate similarity between two words
function calculateWordSimilarity(word1, word2) {
  const longer = word1.length > word2.length ? word1 : word2;
  const shorter = longer === word1 ? word2 : word1;
  
  if (longer.length === 0) return 1.0;
  
  const editDistance = getEditDistance(longer, shorter);
  return (longer.length - editDistance) / longer.length;
}

// Levenshtein distance calculation
function getEditDistance(s1, s2) {
  const costs = [];
  for (let i = 0; i <= s1.length; i++) {
    let lastValue = i;
    for (let j = 0; j <= s2.length; j++) {
      if (i === 0) {
        costs[j] = j;
      } else if (j > 0) {
        let newValue = costs[j - 1];
        if (s1.charAt(i - 1) !== s2.charAt(j - 1)) {
          newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
        }
        costs[j - 1] = lastValue;
        lastValue = newValue;
      }
    }
    if (i > 0) costs[s2.length] = lastValue;
  }
  return costs[s2.length];
}

function normalizePdfText(rawText) {
  return String(rawText || '')
    .replace(/\r\n/g, '\n')
    .replace(/(\w)-\n(\w)/g, '$1$2')
    .replace(/\u00A0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s*\d+\s*$/gm, '')
    .replace(/([a-z0-9,;:])\n(?=[a-z0-9])/gi, '$1 ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\n{2,}/g, '\n\n')
    .trim();
}

function splitTextIntoSentences(text) {
  const sentenceMatches = String(text || '').match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [];
  return sentenceMatches
    .map((item) => item.replace(/\s+/g, ' ').trim())
    .filter((item) => item.length >= 8);
}

function countWords(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  return words.length;
}

function chunkLongSentence(sentence, maxWords) {
  const words = sentence.split(/\s+/).filter(Boolean);
  const chunks = [];

  for (let index = 0; index < words.length; index += maxWords) {
    chunks.push(words.slice(index, index + maxWords).join(' '));
  }

  return chunks;
}

function buildReadingChunks(rawText, options = {}) {
  const targetWords = options.targetWords || 90;
  const minWords = options.minWords || 45;
  const maxWords = options.maxWords || 130;

  const cleanedText = normalizePdfText(rawText);
  if (!cleanedText) {
    return [];
  }

  const paragraphs = cleanedText
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => countWords(paragraph) >= 4);

  const chunks = [];

  for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex++) {
    const sentences = splitTextIntoSentences(paragraphs[paragraphIndex]);
    if (sentences.length === 0) {
      continue;
    }

    let buffer = [];
    let bufferWordCount = 0;

    for (let sentenceIndex = 0; sentenceIndex < sentences.length; sentenceIndex++) {
      const sentence = sentences[sentenceIndex];
      const sentenceWordCount = countWords(sentence);

      if (sentenceWordCount > maxWords) {
        if (bufferWordCount >= minWords) {
          chunks.push(buffer.join(' ').trim());
          buffer = [];
          bufferWordCount = 0;
        }

        const longSentencePieces = chunkLongSentence(sentence, targetWords);
        for (let pieceIndex = 0; pieceIndex < longSentencePieces.length; pieceIndex++) {
          const piece = longSentencePieces[pieceIndex].trim();
          if (piece) {
            chunks.push(piece);
          }
        }
        continue;
      }

      if (bufferWordCount + sentenceWordCount > maxWords && bufferWordCount >= minWords) {
        chunks.push(buffer.join(' ').trim());
        buffer = [];
        bufferWordCount = 0;
      }

      buffer.push(sentence);
      bufferWordCount += sentenceWordCount;

      if (bufferWordCount >= targetWords) {
        chunks.push(buffer.join(' ').trim());
        buffer = [];
        bufferWordCount = 0;
      }
    }

    if (bufferWordCount > 0) {
      if (chunks.length > 0 && bufferWordCount < minWords) {
        const mergedTail = `${chunks[chunks.length - 1]} ${buffer.join(' ')}`.trim();
        if (countWords(mergedTail) <= maxWords + minWords) {
          chunks[chunks.length - 1] = mergedTail;
        } else {
          chunks.push(buffer.join(' ').trim());
        }
      } else {
        chunks.push(buffer.join(' ').trim());
      }
    }
  }

  if (chunks.length === 0) {
    const fallbackSentences = splitTextIntoSentences(cleanedText);
    return fallbackSentences.length > 0 ? fallbackSentences : [cleanedText];
  }

  return chunks.filter((chunk) => chunk.length > 0);
}

// API endpoint: Upload PDF
app.post('/api/upload', ensureAuthenticatedApi, upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const pdfBuffer = req.file.buffer;

    // Parse PDF and build speech-friendly chunks for real documents
    const data = await pdf(pdfBuffer);
    const fullText = data.text;

    const pages = buildReadingChunks(fullText, {
      targetWords: 90,
      minWords: 45,
      maxWords: 130
    });

    if (pages.length === 0) {
      return res.status(422).json({ error: 'No readable text content found in PDF' });
    }

    const currentPdfData = getRequestUserReadingState(req);
    currentPdfData.pages = pages;
    currentPdfData.currentPageIndex = 0;
    currentPdfData.fileName = req.file.originalname;

    res.json({
      success: true,
      totalPages: pages.length,
      firstPage: pages[0],
      currentPageIndex: 0
    });
  } catch (error) {
    console.error('PDF parsing error:', error);
    res.status(500).json({ error: 'Failed to process PDF: ' + error.message });
  }
});

// API endpoint: Get current page
app.get('/api/current-page', ensureAuthenticatedApi, (req, res) => {
  const currentPdfData = getRequestUserReadingState(req);
  if (currentPdfData.pages.length === 0) {
    return res.status(400).json({ error: 'No PDF loaded' });
  }

  const page = currentPdfData.pages[currentPdfData.currentPageIndex];
  res.json({
    success: true,
    pageIndex: currentPdfData.currentPageIndex,
    totalPages: currentPdfData.pages.length,
    content: page,
    lastLine: page.split('\n').pop() || page
  });
});

// API endpoint: Get next page
app.post('/api/next-page', ensureAuthenticatedApi, (req, res) => {
  const currentPdfData = getRequestUserReadingState(req);
  if (currentPdfData.pages.length === 0) {
    return res.status(400).json({ error: 'No PDF loaded' });
  }

  if (currentPdfData.currentPageIndex < currentPdfData.pages.length - 1) {
    currentPdfData.currentPageIndex++;
    const page = currentPdfData.pages[currentPdfData.currentPageIndex];

    res.json({
      success: true,
      pageIndex: currentPdfData.currentPageIndex,
      totalPages: currentPdfData.pages.length,
      content: page,
      lastLine: page.split('\n').pop() || page
    });
  } else {
    res.json({
      success: false,
      message: 'End of document reached'
    });
  }
});

// API endpoint: Verify spoken text
app.post('/api/verify-text', ensureAuthenticatedApi, (req, res) => {
  try {
    const { spokenText } = req.body;

    if (!spokenText) {
      return res.status(400).json({ error: 'No spoken text provided' });
    }

    const currentPdfData = getRequestUserReadingState(req);
    if (currentPdfData.pages.length === 0) {
      return res.status(400).json({ error: 'No PDF loaded' });
    }

    const currentPage = currentPdfData.pages[currentPdfData.currentPageIndex];
    const pageText = currentPage || '';

    // Calculate similarity (MUCH MORE LENIENT - 50% threshold)
    const similarity = calculateSimilarity(spokenText, pageText);
    const threshold = 0.50; // Lowered to 50% for better accuracy with speech recognition

    const result = {
      success: true,
      similarity: Math.round(similarity * 100),
      matched: similarity >= threshold,
      spokenText: spokenText,
      expectedText: pageText,
      message: similarity >= threshold
        ? '✓ Perfect! Moving to next page...'
        : `✗ Close! Similarity: ${Math.round(similarity * 100)}% (Need 50%)`
    };

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Verification error: ' + error.message });
  }
});

app.get('/api/stt/health', async (req, res) => {
  const localSttEnabled = ffmpegRuntimeAvailable && !whisperModelLoadError;
  res.json({
    success: localSttEnabled,
    engine: 'local-whisper',
    model: whisperModelName,
    ready: whisperModelReady,
    ffmpegAvailable: ffmpegRuntimeAvailable,
    error: whisperModelLoadError
      ? whisperModelLoadError.message
      : (ffmpegRuntimeError || null)
  });
});

app.post('/api/transcribe-audio', audioUpload.single('audio'), async (req, res) => {
  try {
    if (!ffmpegRuntimeAvailable) {
      return res.status(503).json({
        error: 'Local transcription engine is unavailable',
        details: ffmpegRuntimeError || 'ffmpeg runtime is not available on this machine'
      });
    }

    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: 'No audio chunk provided' });
    }

    const transcript = await transcribeAudioBuffer(req.file.buffer);
    res.json({
      success: true,
      text: transcript,
      engine: 'local-whisper',
      model: whisperModelName
    });
  } catch (error) {
    console.error('Local transcription error:', error);
    res.status(500).json({
      error: 'Failed to transcribe audio chunk',
      details: error.message
    });
  }
});

// API endpoint: Reset to first page
app.post('/api/reset', ensureAuthenticatedApi, (req, res) => {
  const currentPdfData = getRequestUserReadingState(req);
  currentPdfData.currentPageIndex = 0;
  res.json({ success: true, message: 'Reset to first page' });
});

// ===== USER PROFILE & STATS ENDPOINTS =====

app.get('/api/user/stats', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const stats = db.getUserStats(req.session.user.id);
    res.json(stats);
  } catch (err) {
    console.error('Error fetching user stats:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ===== PDF MANAGEMENT ENDPOINTS =====

app.post('/api/pdfs', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { fileName, filePath, totalPages, topics } = req.body;
  try {
    const pdf = db.savePdf(req.session.user.id, {
      fileName,
      filePath,
      totalPages,
      topics
    });
    res.json({ success: true, pdf });
  } catch (err) {
    console.error('Error saving PDF:', err);
    res.status(500).json({ error: 'Failed to save PDF' });
  }
});

app.get('/api/pdfs', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const pdfs = db.getPdfsByUser(req.session.user.id);
    res.json({ success: true, pdfs });
  } catch (err) {
    console.error('Error fetching PDFs:', err);
    res.status(500).json({ error: 'Failed to fetch PDFs' });
  }
});

app.get('/api/pdfs/:pdfId', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const pdf = db.getPdfById(req.session.user.id, req.params.pdfId);
    if (!pdf) {
      return res.status(404).json({ error: 'PDF not found' });
    }
    res.json({ success: true, pdf });
  } catch (err) {
    console.error('Error fetching PDF:', err);
    res.status(500).json({ error: 'Failed to fetch PDF' });
  }
});

app.put('/api/pdfs/:pdfId', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { progress } = req.body;
  try {
    db.updatePdfProgress(req.session.user.id, req.params.pdfId, progress);
    res.json({ success: true });
  } catch (err) {
    console.error('Error updating PDF:', err);
    res.status(500).json({ error: 'Failed to update PDF' });
  }
});

app.delete('/api/pdfs/:pdfId', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    db.deletePdf(req.session.user.id, req.params.pdfId);
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting PDF:', err);
    res.status(500).json({ error: 'Failed to delete PDF' });
  }
});

// ===== VOICE CLIPS ENDPOINTS =====

app.post('/api/voice-clips', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { pdfId, fileName, filePath, duration, recordedContent, accuracy } = req.body;
  try {
    const clip = db.saveVoiceClip(req.session.user.id, {
      pdfId,
      fileName,
      filePath,
      duration,
      recordedContent,
      accuracy
    });
    res.json({ success: true, clip });
  } catch (err) {
    console.error('Error saving voice clip:', err);
    res.status(500).json({ error: 'Failed to save voice clip' });
  }
});

app.get('/api/voice-clips', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const clips = db.getVoiceClipsByUser(req.session.user.id);
    res.json({ success: true, clips });
  } catch (err) {
    console.error('Error fetching voice clips:', err);
    res.status(500).json({ error: 'Failed to fetch voice clips' });
  }
});

app.get('/api/voice-clips/pdf/:pdfId', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const clips = db.getVoiceClipsByPdf(req.session.user.id, req.params.pdfId);
    res.json({ success: true, clips });
  } catch (err) {
    console.error('Error fetching PDF clips:', err);
    res.status(500).json({ error: 'Failed to fetch PDF clips' });
  }
});

app.put('/api/voice-clips/:clipId', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { fileName } = req.body;
  try {
    db.renameVoiceClip(req.session.user.id, req.params.clipId, fileName);
    res.json({ success: true });
  } catch (err) {
    console.error('Error renaming clip:', err);
    res.status(500).json({ error: 'Failed to rename clip' });
  }
});

app.delete('/api/voice-clips/:clipId', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    db.deleteVoiceClip(req.session.user.id, req.params.clipId);
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting clip:', err);
    res.status(500).json({ error: 'Failed to delete clip' });
  }
});

// ===== FAVORITES ENDPOINTS =====

app.post('/api/favorites/:pdfId', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    db.addFavorite(req.session.user.id, req.params.pdfId);
    res.json({ success: true });
  } catch (err) {
    console.error('Error adding favorite:', err);
    res.status(500).json({ error: 'Failed to add favorite' });
  }
});

app.delete('/api/favorites/:pdfId', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    db.removeFavorite(req.session.user.id, req.params.pdfId);
    res.json({ success: true });
  } catch (err) {
    console.error('Error removing favorite:', err);
    res.status(500).json({ error: 'Failed to remove favorite' });
  }
});

app.get('/api/favorites', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const favorites = db.getFavorites(req.session.user.id);
    res.json({ success: true, favorites });
  } catch (err) {
    console.error('Error fetching favorites:', err);
    res.status(500).json({ error: 'Failed to fetch favorites' });
  }
});

app.post('/api/favorites/voice/:clipId', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    db.addFavoriteVoiceClip(req.session.user.id, req.params.clipId);
    res.json({ success: true });
  } catch (err) {
    console.error('Error adding voice favorite:', err);
    res.status(500).json({ error: 'Failed to add voice favorite' });
  }
});

app.delete('/api/favorites/voice/:clipId', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    db.removeFavoriteVoiceClip(req.session.user.id, req.params.clipId);
    res.json({ success: true });
  } catch (err) {
    console.error('Error removing voice favorite:', err);
    res.status(500).json({ error: 'Failed to remove voice favorite' });
  }
});

app.get('/api/favorites/voice', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const clips = db.getFavoriteVoiceClips(req.session.user.id);
    res.json({ success: true, clips });
  } catch (err) {
    console.error('Error fetching voice favorites:', err);
    res.status(500).json({ error: 'Failed to fetch voice favorites' });
  }
});

app.get('/api/favorites/all', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const pdfs = db.getFavorites(req.session.user.id);
    const clips = db.getFavoriteVoiceClips(req.session.user.id);
    res.json({ success: true, pdfs, clips });
  } catch (err) {
    console.error('Error fetching all favorites:', err);
    res.status(500).json({ error: 'Failed to fetch favorites' });
  }
});

// ===== SETTINGS ENDPOINTS =====

app.post('/api/settings', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    db.saveUserSettings(req.session.user.id, req.body);
    res.json({ success: true });
  } catch (err) {
    console.error('Error saving settings:', err);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

app.get('/api/settings', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const settings = db.getUserSettings(req.session.user.id);
    res.json({ success: true, settings });
  } catch (err) {
    console.error('Error fetching settings:', err);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// ===== USER PROFILE ENDPOINTS =====

app.get('/api/user/profile', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const profile = db.getUserProfile(req.session.user.id);
    res.json({ success: true, profile });
  } catch (err) {
    console.error('Error fetching profile:', err);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

app.post('/api/user/profile', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const nextProfile = db.saveUserProfile(req.session.user.id, req.body || {});
    req.session.user = {
      ...req.session.user,
      ...nextProfile,
      id: req.session.user.id,
      authProvider: req.session.user.authProvider
    };

    req.session.save((err) => {
      if (err) {
        return res.status(500).json({ error: 'Failed to update session profile' });
      }
      res.json({ success: true, profile: nextProfile });
    });
  } catch (err) {
    console.error('Error saving profile:', err);
    res.status(500).json({ error: 'Failed to save profile' });
  }
});

// ===== IMPROVED ACCURACY DETECTION =====

// Analyze speech accuracy with sentence skipping detection
app.post('/api/analyze-accuracy', (req, res) => {
  try {
    const { spokenText, expectedText, pageContext } = req.body;

    if (!spokenText || !expectedText) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Calculate primary similarity
    const primarySimilarity = calculateSimilarity(spokenText, expectedText);
    const threshold = 0.50;

    // Detect sentence skipping by analyzing word order and content
    const spokenWords = spokenText.toLowerCase().match(/\b\w+\b/g) || [];
    const expectedWords = expectedText.toLowerCase().match(/\b\w+\b/g) || [];

    // Calculate sequence accuracy - checks if words appear in right order
    let sequenceMatches = 0;
    let lastMatchIndex = -1;
    spokenWords.forEach(word => {
      const nextIndex = expectedWords.indexOf(word, lastMatchIndex + 1);
      if (nextIndex > lastMatchIndex) {
        sequenceMatches++;
        lastMatchIndex = nextIndex;
      }
    });
    const sequenceAccuracy = expectedWords.length > 0 ? (sequenceMatches / expectedWords.length) * 100 : 0;

    // Calculate coverage - percentage of expected text covered by spoken text
    let coveredWords = 0;
    expectedWords.forEach(word => {
      if (spokenWords.includes(word)) coveredWords++;
    });
    const coverageAccuracy = expectedWords.length > 0 ? (coveredWords / expectedWords.length) * 100 : 0;

    // Detect sentence skipping
    const sentenceSkipped = coverageAccuracy < 60 && sequenceAccuracy < 60;
    const matched = primarySimilarity >= threshold && !sentenceSkipped;

    // Provide detailed feedback
    let feedback = '';
    if (sentenceSkipped) {
      feedback = 'It seems you may have skipped ahead. Please read the current sentence first.';
    } else if (matched) {
      feedback = 'Excellent! Text recognized correctly.';
    } else if (coverageAccuracy >= 80) {
      feedback = 'Good! Most words recognized, but some may be missing or altered.';
    } else if (coverageAccuracy >= 60) {
      feedback = 'Partial match. Try reading more clearly or check if you skipped ahead.';
    } else {
      feedback = 'Low accuracy. Please try again, reading the text clearly.';
    }

    res.json({
      success: true,
      primarySimilarity: Math.round(primarySimilarity * 100),
      sequenceAccuracy: Math.round(sequenceAccuracy),
      coverageAccuracy: Math.round(coverageAccuracy),
      matched,
      sentenceSkipped,
      feedback,
      recommendations: {
        readSlowly: primarySimilarity < 0.4,
        enunciateClearly: sequenceAccuracy < 50,
        checkFocus: sentenceSkipped,
        tryAgain: !matched
      }
    });
  } catch (err) {
    console.error('Error analyzing accuracy:', err);
    res.status(500).json({ error: 'Failed to analyze accuracy' });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  const currentPdfData = getRequestUserReadingState(req) || createEmptyReadingState();
  res.json({ 
    status: 'running',
    pdfLoaded: currentPdfData.pages.length > 0,
    totalPages: currentPdfData.pages.length,
    sttEngine: 'local-whisper',
    sttModel: whisperModelName
  });
});

function startServer(port, retriesLeft = MAX_PORT_RETRIES) {
  const server = app.listen(port, () => {
    console.log(`\n🎤 PDF Speech Reader API`);
    console.log(`🚀 Server running at http://localhost:${port}`);
    if (port !== BASE_PORT) {
      console.log(`⚠️  Requested port ${BASE_PORT} was busy, so the server started on ${port} instead.`);
    }
    console.log(`\n📝 API Endpoints:`);
    console.log(`   POST   http://localhost:${port}/api/upload - Upload PDF file`);
    console.log(`   GET    http://localhost:${port}/api/current-page - Get current page`);
    console.log(`   POST   http://localhost:${port}/api/next-page - Move to next page`);
    console.log(`   POST   http://localhost:${port}/api/verify-text - Verify spoken text`);
    console.log(`   POST   http://localhost:${port}/api/transcribe-audio - Transcribe mic audio chunk`);
    console.log(`   GET    http://localhost:${port}/api/stt/health - Local STT status`);
    console.log(`   POST   http://localhost:${port}/api/reset - Reset to first page`);
    console.log(`   GET    http://localhost:${port}/api/health - Health check\n`);

    if (ffmpegRuntimeAvailable) {
      getWhisperPipeline()
        .then(() => {
          console.log(`Local Whisper model ready: ${whisperModelName}`);
        })
        .catch((error) => {
          console.error(`Local Whisper model failed to load: ${error.message}`);
        });
    }
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE' && retriesLeft > 0) {
      console.warn(`Port ${port} is already in use. Trying ${port + 1}...`);
      server.close(() => startServer(port + 1, retriesLeft - 1));
      return;
    }

    console.error('Server failed to start:', error);
    process.exit(1);
  });
}

// Start local server only when not running as a Vercel serverless function.
if (process.env.VERCEL !== '1') {
  startServer(BASE_PORT);
}

module.exports = app;
