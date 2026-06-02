// ============================================================
// Mayor Cut — Processor Server v2
// Mayor Tech Inc © 2026
// Accepts: clips + reference + music track
// ============================================================

const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs-extra');
const { v4: uuidv4 } = require('uuid');
const { processVideo } = require('./videoProcessor');

const app = express();
const PORT             = process.env.PORT             || 3001;
const WORKER_URL       = process.env.WORKER_URL       || 'http://localhost:8787';
const PROCESSOR_SECRET = process.env.PROCESSOR_SECRET || 'dev-secret';
const PUBLIC_URL       = process.env.PUBLIC_URL       || `http://localhost:${PORT}`;

fs.ensureDirSync('./uploads');
fs.ensureDirSync('./processed');
fs.ensureDirSync('./temp');

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use('/processed', express.static('./processed'));

// ── MULTER — accepts video + audio ───────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = `./uploads/${req.params.jobId}`;
    fs.ensureDirSync(dir);
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${Math.random().toString(36).substr(2,6)}${path.extname(file.originalname)}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 1024 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    // Accept video AND audio files
    const validVideo = /mp4|mov|avi|mkv|webm|m4v/.test(ext);
    const validAudio = /mp3|wav|aac|m4a|ogg|flac/.test(ext);
    if (validVideo || validAudio) {
      cb(null, true);
    } else {
      cb(new Error('Video or audio files only'));
    }
  }
});

const activeJobs = new Map();

// ── HEALTH ───────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status:'ok', service:'Mayor Cut Processor', activeJobs:activeJobs.size });
});

// ── UPLOAD: clips + reference + music ────────────────────────
app.post('/upload/:jobId',
  upload.fields([
    { name: 'clips',     maxCount: 20 },
    { name: 'reference', maxCount: 1  },
    { name: 'music',     maxCount: 1  }
  ]),
  async (req, res) => {
    const { jobId } = req.params;
    const clips     = (req.files['clips']     || []).map(f => f.path);
    const reference = (req.files['reference'] || [])[0]?.path || null;
    const music     = (req.files['music']     || [])[0]?.path || null;

    if (!clips.length) {
      return res.status(400).json({ error: 'At least one clip required' });
    }

    activeJobs.set(jobId, { clips, reference, music, status: 'uploaded' });

    console.log(`[${jobId}] Uploaded: ${clips.length} clips | ref:${!!reference} | music:${!!music}`);
    res.json({ success:true, clipsReceived:clips.length, hasReference:!!reference, hasMusic:!!music });
  }
);

// ── PROCESS ───────────────────────────────────────────────────
app.post('/process/:jobId', async (req, res) => {
  const { jobId } = req.params;
  const { style, format, addWatermark, role } = req.body;

  const jobData = activeJobs.get(jobId);
  if (!jobData) {
    return res.status(404).json({ error: 'Job not found or clips not uploaded' });
  }

  res.json({ success:true, message:'Processing started' });
  await notifyWorker(jobId, { status:'processing', progress:10 });

  try {
    const outputPath = `./processed/${jobId}.mp4`;

    await processVideo({
      jobId,
      clips:        jobData.clips,
      reference:    jobData.reference,
      music:        jobData.music,
      style:        style || 'fast-cuts',
      format:       format || '9:16',
      outputPath,
      addWatermark: !!addWatermark,
      role:         role || 'free',
      onProgress: async (p) => {
        activeJobs.set(jobId, { ...activeJobs.get(jobId), progress: p });
        if (p % 15 === 0) await notifyWorker(jobId, { status:'processing', progress:p });
      }
    });

    const outputUrl = `${PUBLIC_URL}/processed/${jobId}.mp4`;
    await notifyWorker(jobId, { status:'done', outputUrl, progress:100 });
    activeJobs.delete(jobId);
    fs.remove(`./uploads/${jobId}`).catch(() => {});

  } catch(err) {
    console.error(`[${jobId}] Failed:`, err.message);
    await notifyWorker(jobId, { status:'error', error:err.message });
    activeJobs.delete(jobId);
    fs.remove(`./uploads/${jobId}`).catch(() => {});
  }
});

// ── WORKER NOTIFY ─────────────────────────────────────────────
async function notifyWorker(jobId, update) {
  try {
    await fetch(`${WORKER_URL}/api/job/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, processorSecret: PROCESSOR_SECRET, ...update })
    });
  } catch(e) {
    console.warn(`[${jobId}] Worker notify failed: ${e.message}`);
  }
}

// ── CLEANUP OLD FILES ─────────────────────────────────────────
setInterval(() => {
  const SIX_HOURS = 6 * 60 * 60 * 1000;
  fs.readdir('./processed', (err, files) => {
    if (err) return;
    files.forEach(file => {
      const fp = path.join('./processed', file);
      fs.stat(fp, (err, stats) => {
        if (!err && Date.now() - stats.mtimeMs > SIX_HOURS) fs.remove(fp).catch(() => {});
      });
    });
  });
}, 60 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`\n🎬 Mayor Cut Processor | Mayor Tech Inc`);
  console.log(`   Running on http://localhost:${PORT}`);
  console.log(`   Worker URL: ${WORKER_URL}\n`);
});
