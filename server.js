// ============================================================
// MayorCut — Processor (Phase 1: R2 + synchronous render)
// Mayor Tech Inc © 2026
//
// /process/:jobId  — SYNCHRONOUS. Pulls clips from R2, renders a
//   simple clean edit, pushes output.mp4 back to R2, then returns
//   200. Idempotent: re-running overwrites the same output key.
//
// Phase 1 render is intentionally simple (normalize → join →
// music → watermark). The template/beat engine comes in Phase 2,
// on top of this proven-reliable pipeline.
//
// Env (Cloud Run):
//   PORT                 8080
//   WORKER_URL           https://mayorcut-worker.mayortech.workers.dev
//   PROCESSOR_SECRET     shared secret
//   R2_ACCESS_KEY_ID     (secret)  ← add this
//   R2_SECRET_ACCESS_KEY (secret)  ← add this
//   R2_ACCOUNT_ID        optional (hardcoded fallback below)
//   R2_BUCKET            optional (hardcoded fallback below)
// ============================================================

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs-extra');
const ffmpeg  = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const { pipeline } = require('stream/promises');
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');

ffmpeg.setFfmpegPath(ffmpegStatic);

const PORT             = process.env.PORT || 8080;
const WORKER_URL       = process.env.WORKER_URL || 'http://localhost:8787';
const PROCESSOR_SECRET = process.env.PROCESSOR_SECRET || 'dev-secret';

// Non-sensitive defaults (overridable via env)
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || '959d378fb62b30a5f1680b7079ec3ef7';
const R2_BUCKET     = process.env.R2_BUCKET     || 'mayorcut';

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '1mb' }));

// ── R2 helpers ───────────────────────────────────────────────
async function downloadFromR2(key, localPath) {
  const resp = await s3.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
  await pipeline(resp.Body, fs.createWriteStream(localPath));
}

async function uploadToR2(localPath, key, contentType = 'video/mp4') {
  const body = await fs.readFile(localPath);
  await s3.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: body, ContentType: contentType }));
}

// ── Worker callback ──────────────────────────────────────────
async function notifyWorker(jobId, update) {
  try {
    await fetch(`${WORKER_URL}/api/job/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, processorSecret: PROCESSOR_SECRET, ...update }),
    });
  } catch (e) {
    console.warn(`[${jobId}] worker notify failed: ${e.message}`);
  }
}

// ── ffprobe helpers ──────────────────────────────────────────
function clipDuration(p) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(p, (err, meta) => resolve(err ? 8 : (meta.format.duration || 8)));
  });
}
function hasAudio(p) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(p, (err, meta) => resolve(err ? false : meta.streams.some(s => s.codec_type === 'audio')));
  });
}

// ── Render building blocks ───────────────────────────────────
const FORMATS = { '9:16': { w:1080, h:1920 }, '1:1': { w:1080, h:1080 }, '16:9': { w:1920, h:1080 } };

// Normalize one clip to the target format. Guarantees a stereo
// 44.1k AAC track (adds silence if the clip has none) so concat is clean.
async function normalizeClip(input, out, fmt, dur) {
  const audio = await hasAudio(input);
  return new Promise((resolve, reject) => {
    const cmd = ffmpeg(input);
    const vchain = `[0:v]scale=${fmt.w}:${fmt.h}:force_original_aspect_ratio=increase,crop=${fmt.w}:${fmt.h},fps=30,setsar=1[v]`;
    let maps;
    if (audio) {
      cmd.complexFilter([vchain]);
      maps = ['-map', '[v]', '-map', '0:a'];
    } else {
      cmd.input('anullsrc=channel_layout=stereo:sample_rate=44100').inputOptions(['-f', 'lavfi']);
      cmd.complexFilter([vchain]);
      maps = ['-map', '[v]', '-map', '1:a'];
    }
    cmd.outputOptions([
      ...maps,
      '-t', dur.toFixed(2),
      '-shortest',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '22', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-b:a', '128k',
      '-movflags', '+faststart', '-avoid_negative_ts', 'make_zero',
    ]).output(out).on('end', resolve).on('error', reject).run();
  });
}

// Concat normalized segments (re-encode for max reliability).
function concatSegments(segs, out) {
  return new Promise((resolve, reject) => {
    const list = out + '.txt';
    fs.writeFileSync(list, segs.map(s => `file '${path.resolve(s)}'`).join('\n'));
    ffmpeg().input(list).inputOptions(['-f', 'concat', '-safe', '0'])
      .outputOptions([
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '22', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-b:a', '128k', '-movflags', '+faststart',
      ])
      .output(out)
      .on('end', () => { fs.remove(list).catch(() => {}); resolve(); })
      .on('error', (e) => { fs.remove(list).catch(() => {}); reject(e); })
      .run();
  });
}

// Mix music over the joined video; duck original audio. Logs loudly on failure.
function mixMusic(video, music, out, jobId) {
  return new Promise((resolve, reject) => {
    ffmpeg().input(video).input(music)
      .complexFilter([
        '[0:a]volume=0.08[a0]',
        '[1:a]volume=1.0[a1]',
        '[a0][a1]amix=inputs=2:duration=first:dropout_transition=2[a]',
      ])
      .outputOptions(['-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-ar', '44100', '-b:a', '192k', '-shortest', '-movflags', '+faststart'])
      .output(out)
      .on('end', resolve)
      .on('error', (e) => {
        console.error(`[${jobId}] ⚠️ MUSIC MIX FAILED: ${e.message} — keeping video audio`);
        fs.copy(video, out).then(resolve).catch(reject);
      })
      .run();
  });
}

function applyWatermark(input, out, fmt) {
  return new Promise((resolve, reject) => {
    const fontSize = Math.round(fmt.w * 0.024);
    ffmpeg(input)
      .videoFilter(`drawtext=text='MayorCut':fontsize=${fontSize}:fontcolor=white@0.6:x=w-text_w-24:y=h-text_h-24:shadowcolor=black@0.4:shadowx=1:shadowy=1:box=1:boxcolor=black@0.2:boxborderw=6`)
      .outputOptions(['-c:v', 'libx264', '-preset', 'fast', '-crf', '21', '-c:a', 'copy', '-movflags', '+faststart'])
      .output(out).on('end', resolve).on('error', reject).run();
  });
}

// ── Simple render pipeline ───────────────────────────────────
async function renderSimple({ clips, music, format, addWatermark, outPath, workDir, jobId, onProgress }) {
  const fmt = FORMATS[format] || FORMATS['9:16'];

  // 1. Normalize each clip (cap 10s each for Phase 1)
  const segs = [];
  for (let i = 0; i < clips.length; i++) {
    const seg = path.join(workDir, `seg_${String(i).padStart(3, '0')}.mp4`);
    const dur = Math.min(await clipDuration(clips[i]), 10);
    console.log(`[${jobId}] normalizing clip ${i} (${dur.toFixed(1)}s)`);
    await normalizeClip(clips[i], seg, fmt, dur);
    segs.push(seg);
    await onProgress(Math.floor((i / clips.length) * 60));
  }

  // 2. Join
  console.log(`[${jobId}] concatenating ${segs.length} segments`);
  const joined = path.join(workDir, 'joined.mp4');
  await concatSegments(segs, joined);
  await onProgress(75);

  // 3. Music
  let pre = joined;
  if (music) {
    console.log(`[${jobId}] mixing music`);
    const wm = path.join(workDir, 'music.mp4');
    await mixMusic(joined, music, wm, jobId);
    pre = wm;
  }
  await onProgress(85);

  // 4. Watermark
  if (addWatermark) {
    console.log(`[${jobId}] applying watermark`);
    await applyWatermark(pre, outPath, fmt);
  } else {
    await fs.move(pre, outPath, { overwrite: true });
  }
}

// ── Endpoints ────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'MayorCut Processor', r2Bucket: R2_BUCKET });
});

// SYNCHRONOUS render. Returns 200 only when the output is in R2.
// body: { processorSecret, manifest:{ jobId, clipKeys, musicKey, format, outputKey, addWatermark } }
app.post('/process/:jobId', async (req, res) => {
  const { jobId } = req.params;
  const { processorSecret, manifest } = req.body || {};

  if (processorSecret !== PROCESSOR_SECRET) return res.status(401).json({ error: 'unauthorized' });
  if (!manifest || !Array.isArray(manifest.clipKeys) || !manifest.clipKeys.length) {
    return res.status(400).json({ error: 'manifest with clipKeys required' });
  }

  const workDir = `/tmp/${jobId}`;
  console.log(`[${jobId}] 🎬 process start | clips:${manifest.clipKeys.length} music:${!!manifest.musicKey} fmt:${manifest.format}`);

  try {
    await fs.remove(workDir);     // idempotent: clean slate on retry
    await fs.ensureDir(workDir);
    await notifyWorker(jobId, { status: 'processing', progress: 10 });

    // 1. Pull inputs from R2
    const localClips = [];
    for (let i = 0; i < manifest.clipKeys.length; i++) {
      const lp = path.join(workDir, `clip_${i}.mp4`);
      console.log(`[${jobId}] downloading ${manifest.clipKeys[i]}`);
      await downloadFromR2(manifest.clipKeys[i], lp);
      localClips.push(lp);
    }
    let localMusic = null;
    if (manifest.musicKey) {
      localMusic = path.join(workDir, 'music_in');
      await downloadFromR2(manifest.musicKey, localMusic);
    }
    await notifyWorker(jobId, { status: 'processing', progress: 35 });

    // 2. Render
    const outPath = path.join(workDir, 'output.mp4');
    await renderSimple({
      clips: localClips,
      music: localMusic,
      format: manifest.format || '9:16',
      addWatermark: !!manifest.addWatermark,
      outPath, workDir, jobId,
      onProgress: async (p) => {
        if (p % 20 === 0) await notifyWorker(jobId, { status: 'processing', progress: 35 + Math.floor(p * 0.5) });
      },
    });
    await notifyWorker(jobId, { status: 'processing', progress: 90 });

    // 3. Push output to R2
    const outputKey = manifest.outputKey || `${jobId}/output.mp4`;
    console.log(`[${jobId}] uploading output → ${outputKey}`);
    await uploadToR2(outPath, outputKey, 'video/mp4');

    await notifyWorker(jobId, { status: 'done', progress: 100 });
    console.log(`[${jobId}] ✅ done → r2:${outputKey}`);
    res.json({ success: true, jobId, outputKey });

  } catch (err) {
    console.error(`[${jobId}] ❌ failed: ${err.message}`);
    await notifyWorker(jobId, { status: 'error', error: err.message });
    // 500 so Cloud Tasks (step 4) will retry.
    res.status(500).json({ error: err.message });
  } finally {
    fs.remove(workDir).catch(() => {});
  }
});

const server = app.listen(PORT, () => {
  console.log(`\n🎬 MayorCut Processor | Mayor Tech Inc`);
  console.log(`   Port: ${PORT}`);
  console.log(`   Worker: ${WORKER_URL}`);
  console.log(`   R2 bucket: ${R2_BUCKET}\n`);
});
// Allow long synchronous renders (Cloud Tasks holds the connection open).
server.requestTimeout = 0;
server.headersTimeout = 0;
server.setTimeout(3600000);
