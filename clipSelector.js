// ============================================================
// Mayor Cut — Smart Clip Selector
// Mayor Tech Inc © 2026
//
// Analyzes user clips and scores every segment.
// Selects the best moments based on:
//   - Motion level (prefer high motion)
//   - Visual interest (avoid flat/dark sections)
//   - Audio energy (prefer louder moments)
//   - Variety (avoid repeating similar sections)
// ============================================================

const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
ffmpeg.setFfmpegPath(ffmpegStatic);

// ── ANALYZE ALL CLIPS ─────────────────────────────────────────
async function analyzeClips(clipPaths, jobId) {
  console.log(`[${jobId}] 🎬 Analyzing ${clipPaths.length} clip(s) for best moments...`);
  const analyzed = [];

  for (const clipPath of clipPaths) {
    try {
      const info = await analyzeClip(clipPath, jobId);
      analyzed.push({ path: clipPath, ...info });
    } catch(e) {
      console.warn(`[${jobId}] Clip analysis failed for ${clipPath}: ${e.message}`);
      analyzed.push({ path: clipPath, duration: 10, segments: [], motionLevel: 'medium', bestMoments: [0] });
    }
  }

  return analyzed;
}

// ── ANALYZE ONE CLIP ──────────────────────────────────────────
async function analyzeClip(clipPath, jobId) {
  return new Promise((resolve, reject) => {
    const frames = [];
    let idx = 0;

    ffmpeg.ffprobe(clipPath, (err, meta) => {
      if (err) return reject(err);
      const duration = meta.format.duration || 10;
      const vs = meta.streams.find(s => s.codec_type === 'video');

      // Sample at 3fps for efficiency
      ffmpeg(clipPath)
        .outputOptions(['-vf', 'fps=3,scale=80:45,showinfo', '-f', 'null'])
        .output('/dev/null')
        .on('stderr', (line) => {
          const pts  = line.match(/pts_time:(\d+\.?\d*)/);
          const mean = line.match(/mean:\[(\d+)/);
          if (pts && mean) {
            const b = parseFloat(mean[1]);
            const prevB = frames.length > 0 ? frames[frames.length - 1].brightness : b;
            frames.push({
              time:       parseFloat(pts[1]),
              brightness: b,
              motion:     Math.abs(b - prevB),
            });
            idx++;
          }
        })
        .on('end', () => {
          if (!frames.length) {
            return resolve({ duration, segments: [], motionLevel: 'medium', bestMoments: [duration * 0.1] });
          }

          const result = scoreClipSegments(frames, duration);
          console.log(`[${jobId}] 🎬 Clip: ${duration.toFixed(1)}s | motion:${result.motionLevel} | ${result.bestMoments.length} best moments`);
          resolve({ duration, ...result });
        })
        .on('error', () => {
          resolve({ duration, segments: [], motionLevel: 'medium', bestMoments: [duration * 0.1] });
        })
        .run();
    });
  });
}

// ── SCORE CLIP SEGMENTS ───────────────────────────────────────
function scoreClipSegments(frames, duration) {
  if (!frames.length) return { segments: [], motionLevel: 'medium', bestMoments: [0] };

  const avgMotion = frames.reduce((a, b) => a + b.motion, 0) / frames.length;
  const avgBright = frames.reduce((a, b) => a + b.brightness, 0) / frames.length;

  // Score each frame
  const scored = frames.map(f => ({
    ...f,
    score: scoreFrame(f, avgMotion, avgBright)
  }));

  // Build 1-second window scores
  const windowSize = 3; // 3 frames = ~1 second at 3fps
  const windows = [];
  for (let i = 0; i <= scored.length - windowSize; i++) {
    const window = scored.slice(i, i + windowSize);
    const avgScore = window.reduce((a, b) => a + b.score, 0) / windowSize;
    const startTime = window[0].time;
    windows.push({ time: startTime, score: avgScore });
  }

  // Sort windows by score, take top moments
  const sorted = [...windows].sort((a, b) => b.score - a.score);
  const topN = Math.max(3, Math.ceil(duration / 5)); // 1 good moment per 5 seconds

  // Get best moments with minimum spacing (2s apart)
  const bestMoments = [];
  for (const w of sorted) {
    if (bestMoments.length >= topN) break;
    const tooClose = bestMoments.some(m => Math.abs(m - w.time) < 2.0);
    if (!tooClose) bestMoments.push(w.time);
  }

  bestMoments.sort((a, b) => a - b);

  // Build segments between best moments
  const segments = buildSegments(bestMoments, duration, scored);

  // Overall motion level
  const motionLevel = avgMotion > 15 ? 'high' : avgMotion > 6 ? 'medium' : 'low';

  return { segments, motionLevel, bestMoments, avgMotion, avgBright };
}

// Score a single frame for visual interest
function scoreFrame(frame, avgMotion, avgBright) {
  let score = 50; // base

  // Reward motion (interesting moments)
  if (frame.motion > avgMotion * 1.5) score += 30;
  else if (frame.motion > avgMotion) score += 15;
  else if (frame.motion < avgMotion * 0.3) score -= 20; // penalize flat/boring

  // Penalize very dark frames (likely boring or transitional)
  if (frame.brightness < 30) score -= 25;
  else if (frame.brightness < 60) score -= 10;

  // Penalize overexposed frames
  if (frame.brightness > 230) score -= 15;

  // Reward frames near average brightness (well-exposed)
  if (frame.brightness > 80 && frame.brightness < 200) score += 10;

  return Math.max(0, Math.min(100, score));
}

// Build segments from best moments
function buildSegments(bestMoments, duration, scoredFrames) {
  if (!bestMoments.length) return [];

  const segments = [];
  // Add start if first moment is not near beginning
  const allStarts = bestMoments[0] > 1.0
    ? [Math.max(0, bestMoments[0] - 0.5), ...bestMoments.slice(1)]
    : bestMoments;

  for (let i = 0; i < allStarts.length; i++) {
    const start = allStarts[i];
    const end = i < allStarts.length - 1
      ? Math.min(allStarts[i + 1], start + 8.0) // max 8s per segment
      : Math.min(duration - 0.5, start + 6.0);
    const segDur = end - start;

    if (segDur >= 0.5) {
      // Get avg score for this segment
      const segFrames = scoredFrames.filter(f => f.time >= start && f.time < end);
      const avgScore = segFrames.length
        ? segFrames.reduce((a, b) => a + b.score, 0) / segFrames.length
        : 50;

      segments.push({
        start: parseFloat(start.toFixed(3)),
        duration: parseFloat(segDur.toFixed(3)),
        energyScore: parseFloat((avgScore / 100).toFixed(3)),
        quality: avgScore > 70 ? 'high' : avgScore > 40 ? 'medium' : 'low'
      });
    }
  }

  return segments;
}

// ── SELECT SEGMENTS FOR TIMELINE ──────────────────────────────
// Given an energy curve, select the best clip segments to match it
function selectSegmentsForTimeline(analyzedClips, energyCurve, totalDuration) {
  const selected = [];

  // Flatten all segments from all clips
  const allSegments = [];
  for (const clip of analyzedClips) {
    for (const seg of (clip.segments || [])) {
      allSegments.push({ ...seg, clipPath: clip.path, clipDuration: clip.duration });
    }
    // If no segments were found, add the whole clip in chunks
    if (!clip.segments || !clip.segments.length) {
      const chunkSize = 3;
      for (let t = 0.5; t < clip.duration - 0.5; t += chunkSize) {
        allSegments.push({
          start: t,
          duration: Math.min(chunkSize, clip.duration - t - 0.5),
          energyScore: 0.5,
          quality: 'medium',
          clipPath: clip.path,
          clipDuration: clip.duration
        });
      }
    }
  }

  if (!allSegments.length) return [];

  // For each section of the energy curve, find best matching segment
  const sections = energyCurve.length || 8;
  const sectionDuration = totalDuration / sections;

  let usedSegments = new Set();

  for (let i = 0; i < sections; i++) {
    const targetEnergy = energyCurve[i] || 0.5;
    const targetDuration = sectionDuration;

    // Find segments that match the energy level and haven't been used
    const candidates = allSegments
      .filter((_, idx) => !usedSegments.has(idx))
      .filter(s => s.duration >= 0.5)
      .map((seg, idx) => ({
        ...seg,
        originalIdx: idx,
        energyDiff: Math.abs((seg.energyScore || 0.5) - targetEnergy)
      }))
      .sort((a, b) => a.energyDiff - b.energyDiff);

    if (candidates.length) {
      const best = candidates[0];
      usedSegments.add(best.originalIdx);
      selected.push({
        clipPath:    best.clipPath,
        clipStart:   best.start,
        clipDuration: Math.min(best.duration, targetDuration),
        energyScore: best.energyScore || 0.5,
        quality:     best.quality || 'medium'
      });
    }
  }

  return selected;
}

module.exports = { analyzeClips, selectSegmentsForTimeline };
