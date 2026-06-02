// ============================================================
// Mayor Cut — External FFmpeg Processor
// Mayor Tech Inc © 2026
// Runs on Railway / Render / Fly.io
// Receives uploads → processes via FFmpeg → calls Worker back
// ============================================================

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');
const { processVideo } = require('./videoProcessor');

const app = express();
const PORT = process.env.PORT || 3001;
const WORKER_URL = process.env.WORKER_URL || 'http://localhost:8787';
const PROCESSOR_SECRET = process.env.PROCESSOR_SECRET || 'dev-secret-change-in-prod';
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

fs.ensureDirSync('./uploads');
fs.ensureDirSync('./processed');
fs.ensureDirSync('./temp');

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use('/processed', express.static('./processed'));

// ── MULTER ────────────────────────────────────────────────────
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
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1GB hard limit
  fileFilter: (req, file, cb) => {
    if (/mp4|mov|avi|mkv|webm|m4v/i.test(path.extname(file.originalname))) {
      cb(null, true);
    } else {
      cb(new Error('Video files only'));
    }
  }
});

// In-memory active jobs tracker
const activeJobs = new Map();

// ── ROUTES ────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'Mayor Cut Processor', activeJobs: activeJobs.size });
});

// Upload clips for a job
app.post('/upload/:jobId',
  upload.fields([{ name: 'clips', maxCount: 20 }, { name: 'reference', maxCount: 1 }]),
  async (req, res) => {
    const { jobId } = req.params;
    const clips = (req.files['clips'] || []).map(f => f.path);
    const reference = (req.files['reference'] || [])[0]?.path || null;

    if (!clips.length) {
      return res.status(400).json({ error: 'At least one clip required' });
    }

    activeJobs.set(jobId, { clips, reference, status: 'uploaded' });
    res.json({ success: true, clipsReceived: clips.length, hasReference: !!reference });
  }
);

// Start processing a job
app.post('/process/:jobId', async (req, res) => {
  const { jobId } = req.params;
  const { style, format, addWatermark, role } = req.body;

  const jobData = activeJobs.get(jobId);
  if (!jobData) {
    return res.status(404).json({ error: 'Job not found or clips not uploaded' });
  }

  // Respond immediately, process async
  res.json({ success: true, message: 'Processing started' });

  // Update worker: processing started
  await notifyWorker(jobId, { status: 'processing', progress: 10 });

  try {
    const outputPath = `./processed/${jobId}.mp4`;

    await processVideo({
      jobId,
      clips: jobData.clips,
      reference: jobData.reference,
      style: style || 'fast-cuts',
      format: format || '9:16',
      outputPath,
      addWatermark: !!addWatermark,
      onProgress: async (p) => {
        activeJobs.set(jobId, { ...activeJobs.get(jobId), progress: p });
        // Throttle worker updates to every 20% to avoid spam
        if (p % 20 === 0) {
          await notifyWorker(jobId, { status: 'processing', progress: p });
        }
      }
    });

    const outputUrl = `${PUBLIC_URL}/processed/${jobId}.mp4`;

    // Notify worker: done
    await notifyWorker(jobId, { status: 'done', outputUrl, progress: 100 });
    activeJobs.delete(jobId);
    fs.remove(`./uploads/${jobId}`).catch(() => {});

  } catch (err) {
    console.error(`Job ${jobId} failed:`, err.message);
    await notifyWorker(jobId, { status: 'error', error: err.message });
    activeJobs.delete(jobId);
    fs.remove(`./uploads/${jobId}`).catch(() => {});
  }
});

// Get processor-side job progress (for polling fallback)
app.get('/progress/:jobId', (req, res) => {
  const job = activeJobs.get(req.params.jobId);
  res.json({ progress: job?.progress || 0, status: job?.status || 'unknown' });
});

// Cleanup processed files older than 6h
setInterval(() => {
  const SIX_HOURS = 6 * 60 * 60 * 1000;
  fs.readdir('./processed', (err, files) => {
    if (err) return;
    files.forEach(file => {
      const filePath = path.join('./processed', file);
      fs.stat(filePath, (err, stats) => {
        if (!err && Date.now() - stats.mtimeMs > SIX_HOURS) {
          fs.remove(filePath).catch(() => {});
        }
      });
    });
  });
}, 60 * 60 * 1000);

// ── WORKER CALLBACK ───────────────────────────────────────────
async function notifyWorker(jobId, update) {
  try {
    await fetch(`${WORKER_URL}/api/job/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jobId,
        processorSecret: PROCESSOR_SECRET,
        ...update
      })
    });
  } catch (e) {
    console.warn(`Could not notify worker for job ${jobId}:`, e.message);
  }
}

app.listen(PORT, () => {
  console.log(`\n🎬 Mayor Cut Processor | Mayor Tech Inc`);
  console.log(`   Running on http://localhost:${PORT}`);
  console.log(`   Worker URL: ${WORKER_URL}\n`);
});
