// ============================================================
// Mayor Cut — FFmpeg Video Processor + Beat Sync
// Mayor Tech Inc © 2026
// ============================================================

const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const path = require('path');
const fs = require('fs-extra');

ffmpeg.setFfmpegPath(ffmpegStatic);

// ── STYLE PRESETS ─────────────────────────────────────────────
const STYLES = {
  'football-hype': {
    label: 'Football Hype',
    segmentDuration: 1.5,
    minSegment: 1.0,
    maxOutput: 60,
    fadeIn: 0.12,
    fadeOut: 0.12,
    speed: 1.1,
    brightness: 0.08,
    contrast: 1.2,
    saturation: 1.35,
    // Beat sync: cut tighter on beats
    beatSyncTightness: 0.8,   // how much to snap to beats (0-1)
    bpmRange: [128, 160],     // expected BPM range for style
  },
  'fast-cuts': {
    label: 'Fast Cuts',
    segmentDuration: 1.2,
    minSegment: 0.8,
    maxOutput: 60,
    fadeIn: 0.08,
    fadeOut: 0.08,
    speed: 1.15,
    brightness: 0.04,
    contrast: 1.1,
    saturation: 1.2,
    beatSyncTightness: 0.9,
    bpmRange: [120, 150],
  },
  'cinematic': {
    label: 'Cinematic',
    segmentDuration: 3.5,
    minSegment: 2.0,
    maxOutput: 90,
    fadeIn: 0.5,
    fadeOut: 0.5,
    speed: 0.95,
    brightness: -0.06,
    contrast: 1.25,
    saturation: 0.8,
    beatSyncTightness: 0.5,
    bpmRange: [70, 100],
  }
};

// ── FORMAT SPECS ──────────────────────────────────────────────
const FORMATS = {
  '9:16':   { w: 1080, h: 1920 },
  '1:1':    { w: 1080, h: 1080 },
  '16:9':   { w: 1920, h: 1080 },
  'source': null // preserve original
};

// ── BEAT DETECTION (Lightweight) ──────────────────────────────
// Uses FFmpeg's astats + silencedetect filters to approximate beat positions
// Falls back to fixed BPM if detection fails
async function detectBeats(audioPath, style) {
  const preset = STYLES[style] || STYLES['fast-cuts'];

  return new Promise((resolve) => {
    const peaks = [];
    let stderr = '';

    // Extract audio peaks using FFmpeg's ebur128 loudness filter
    // We detect moments of high energy as "beat-like" events
    ffmpeg(audioPath)
      .outputOptions([
        '-af', 'aresample=22050,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-',
        '-f', 'null',
        '-vn'
      ])
      .output('/dev/null')
      .on('stderr', (line) => {
        stderr += line + '\n';
        // Parse RMS level metadata
        const match = line.match(/lavfi\.astats\.Overall\.RMS_level=(-?\d+\.?\d*)/);
        if (match) {
          const rms = parseFloat(match[1]);
          // RMS level spikes (less negative) indicate loud moments = beats
          if (rms > -20) {
            peaks.push({ time: peaks.length * 0.1, rms });
          }
        }
      })
      .on('end', () => {
        if (peaks.length < 3) {
          // Fallback: generate synthetic beat times from BPM range
          resolve(generateFallbackBeats(preset));
          return;
        }
        // Convert peaks to beat timestamps
        const beatTimes = refinePeaks(peaks, preset);
        resolve(beatTimes);
      })
      .on('error', () => {
        // On any error, use fallback
        resolve(generateFallbackBeats(preset));
      })
      .run();
  });
}

// Refine raw peaks into clean beat timestamps
function refinePeaks(peaks, preset) {
  if (!peaks.length) return generateFallbackBeats(preset);

  // Sort by RMS (strongest first), then take top N, sort by time
  const sorted = [...peaks].sort((a, b) => b.rms - a.rms);
  const topPeaks = sorted.slice(0, Math.min(sorted.length, 40));
  const beatTimes = topPeaks.map(p => p.time).sort((a, b) => a - b);

  // Remove beats too close together (< 0.3s apart)
  const filtered = [beatTimes[0]];
  for (let i = 1; i < beatTimes.length; i++) {
    if (beatTimes[i] - filtered[filtered.length - 1] >= 0.3) {
      filtered.push(beatTimes[i]);
    }
  }

  return filtered;
}

// Fallback: generate evenly-spaced beat times from a BPM estimate
function generateFallbackBeats(preset) {
  const [minBPM, maxBPM] = preset.bpmRange;
  const bpm = minBPM + Math.random() * (maxBPM - minBPM);
  const interval = 60 / bpm; // seconds per beat
  const beats = [];
  // Generate 120 seconds worth of beats
  for (let t = 0; t < 120; t += interval) {
    beats.push(parseFloat(t.toFixed(3)));
  }
  return beats;
}

// Snap a timestamp to the nearest beat (within tolerance)
function snapToBeat(time, beats, tightness, tolerance = 0.25) {
  if (!beats.length || tightness === 0) return time;

  let nearest = beats[0];
  let minDist = Math.abs(time - beats[0]);

  for (const beat of beats) {
    const dist = Math.abs(time - beat);
    if (dist < minDist) { minDist = dist; nearest = beat; }
  }

  if (minDist <= tolerance) {
    // Blend between original time and beat time based on tightness
    return time + (nearest - time) * tightness;
  }
  return time;
}

// ── VIDEO UTILITIES ───────────────────────────────────────────
function getVideoDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, meta) => {
      if (err) return reject(err);
      resolve(meta.format.duration || 10);
    });
  });
}

function getVideoInfo(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, meta) => {
      if (err) return reject(err);
      const vs = meta.streams.find(s => s.codec_type === 'video');
      resolve({
        duration: meta.format.duration || 10,
        width: vs?.width || 1080,
        height: vs?.height || 1920,
        hasAudio: meta.streams.some(s => s.codec_type === 'audio')
      });
    });
  });
}

// ── EXTRACT AUDIO ─────────────────────────────────────────────
function extractAudio(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions(['-vn', '-acodec', 'pcm_s16le', '-ar', '22050', '-ac', '1'])
      .output(outputPath)
      .on('end', resolve)
      .on('error', () => resolve()) // non-fatal
      .run();
  });
}

// ── PROCESS ONE SEGMENT ───────────────────────────────────────
function processSegment({ input, start, duration, preset, format, outputPath }) {
  return new Promise((resolve, reject) => {
    const fmt = FORMATS[format] || FORMATS['9:16'];

    // Build video filter chain
    const filters = [];

    // 1. Scale + crop to target format
    if (fmt) {
      filters.push(`scale=${fmt.w}:${fmt.h}:force_original_aspect_ratio=increase`);
      filters.push(`crop=${fmt.w}:${fmt.h}`);
    }

    // 2. Speed
    filters.push(`setpts=${(1 / preset.speed).toFixed(4)}*PTS`);

    // 3. Color grade
    filters.push(`eq=brightness=${preset.brightness}:contrast=${preset.contrast}:saturation=${preset.saturation}`);

    // 4. Fade in/out
    const fadedDuration = duration / preset.speed;
    filters.push(`fade=t=in:st=0:d=${preset.fadeIn}`);
    filters.push(`fade=t=out:st=${Math.max(0, fadedDuration - preset.fadeOut).toFixed(3)}:d=${preset.fadeOut}`);

    // Audio filters
    const aFilters = [];
    aFilters.push(`atempo=${Math.min(Math.max(preset.speed, 0.5), 2.0).toFixed(4)}`);
    aFilters.push(`afade=t=in:st=0:d=${preset.fadeIn}`);
    aFilters.push(`afade=t=out:st=${Math.max(0, fadedDuration - preset.fadeOut).toFixed(3)}:d=${preset.fadeOut}`);

    ffmpeg(input)
      .inputOptions([`-ss ${start.toFixed(3)}`, `-t ${duration.toFixed(3)}`])
      .videoFilter(filters.join(','))
      .audioFilter(aFilters.join(','))
      .outputOptions([
        '-c:v libx264', '-preset fast', '-crf 23',
        '-c:a aac', '-ar 44100', '-b:a 128k',
        '-movflags +faststart', '-pix_fmt yuv420p',
        '-avoid_negative_ts make_zero'
      ])
      .output(outputPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

// ── WATERMARK ─────────────────────────────────────────────────
function applyWatermark(inputPath, outputPath, format) {
  return new Promise((resolve, reject) => {
    // Position: bottom-right, scaled to format
    const fmt = FORMATS[format] || FORMATS['9:16'];
    const fontSize = fmt ? Math.round(fmt.w * 0.022) : 22;

    ffmpeg(inputPath)
      .videoFilter([
        `drawtext=text='𝙿𝙾𝚆𝙴𝚁𝙴𝙳 𝙱𝚈 𝙼𝙰𝙸𝙾𝚁 𝚃𝙴𝙲𝙷 𝙸𝙽𝙲':` +
        `fontsize=${fontSize}:` +
        `fontcolor=white@0.55:` +
        `x=w-text_w-20:` +
        `y=h-text_h-20:` +
        `shadowcolor=black@0.4:shadowx=1:shadowy=1:` +
        `box=1:boxcolor=black@0.15:boxborderw=6`
      ])
      .outputOptions(['-c:v libx264', '-preset fast', '-crf 22', '-c:a copy', '-movflags +faststart'])
      .output(outputPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

// ── CONCAT SEGMENTS ───────────────────────────────────────────
function concatSegments(segmentPaths, outputPath) {
  return new Promise((resolve, reject) => {
    const listFile = outputPath + '.list.txt';
    fs.writeFileSync(listFile, segmentPaths.map(p => `file '${path.resolve(p)}'`).join('\n'));

    ffmpeg()
      .input(listFile)
      .inputOptions(['-f concat', '-safe 0'])
      .outputOptions([
        '-c:v libx264', '-preset fast', '-crf 22',
        '-c:a aac', '-ar 44100',
        '-movflags +faststart', '-pix_fmt yuv420p'
      ])
      .output(outputPath)
      .on('end', () => { fs.remove(listFile).catch(() => {}); resolve(); })
      .on('error', (e) => { fs.remove(listFile).catch(() => {}); reject(e); })
      .run();
  });
}

// ── MAIN PIPELINE ─────────────────────────────────────────────
async function processVideo({ jobId, clips, reference, style, format, outputPath, addWatermark, onProgress }) {
  const tempDir = `./temp/${jobId}`;
  fs.ensureDirSync(tempDir);

  try {
    // 1. Resolve style (reference → nearest preset in MVP)
    let activeStyle = style;
    if (reference) {
      // MVP: map reference to nearest style by heuristic
      // Future: real ML analysis
      activeStyle = mapReferenceToStyle(reference);
      console.log(`[${jobId}] Reference video mapped to style: ${activeStyle}`);
    }
    const preset = STYLES[activeStyle] || STYLES['fast-cuts'];
    await onProgress(15);

    // 2. Extract audio from first clip for beat detection
    const audioPath = path.join(tempDir, 'audio.wav');
    await extractAudio(clips[0], audioPath);
    await onProgress(20);

    // 3. Detect beats
    let beats = [];
    try {
      beats = await detectBeats(audioPath, activeStyle);
      console.log(`[${jobId}] Detected ${beats.length} beat points`);
    } catch (e) {
      console.warn(`[${jobId}] Beat detection failed, using fallback`);
      beats = generateFallbackBeats(preset);
    }
    await onProgress(28);

    // 4. Plan segments from all clips using beat-aware timing
    const segments = [];
    for (const clip of clips) {
      let info;
      try {
        info = await getVideoInfo(clip);
      } catch { continue; }

      const { duration } = info;

      // For short clips (under 10s) skip the 8% trim — use full clip
      const skipPct = duration < 10 ? 0 : 0.08;
      const skip = duration * skipPct;
      const usable = duration - skip * 2;

      // If entire clip is shorter than minSegment, use whole clip as one segment
      if (usable <= preset.minSegment) {
        if (duration >= 1.0) {
          segments.push({ file: clip, start: 0, duration });
          console.log(`[${jobId}] Short clip used as single segment: ${duration.toFixed(1)}s`);
        }
        continue;
      }

      let t = skip;
      while (t < skip + usable - 0.5) {
        const remaining = (skip + usable) - t;
        // Snap cut point to nearest beat
        const rawEnd = t + Math.min(preset.segmentDuration, remaining);
        const snappedEnd = snapToBeat(rawEnd, beats, preset.beatSyncTightness);
        const segDur = Math.max(0.5, Math.min(snappedEnd - t, preset.segmentDuration * 1.5, remaining));

        segments.push({ file: clip, start: t, duration: segDur });
        t += segDur;

        if (t >= skip + usable - 0.3) break;
      }
    }

    if (!segments.length) {
      throw new Error('No usable segments found. Try uploading longer clips (3s minimum).');
    }

    console.log(`[${jobId}] Planned ${segments.length} segments`);

    // Trim to max output duration
    let total = 0;
    const finalSegments = [];
    for (const seg of segments) {
      if (total >= preset.maxOutput) break;
      finalSegments.push(seg);
      total += seg.duration / preset.speed;
    }

    await onProgress(35);

    // 5. Process each segment
    const segPaths = [];
    for (let i = 0; i < finalSegments.length; i++) {
      const seg = finalSegments[i];
      const segOut = path.join(tempDir, `seg_${String(i).padStart(4, '0')}.mp4`);

      try {
        await processSegment({
          input: seg.file,
          start: seg.start,
          duration: seg.duration,
          preset,
          format,
          outputPath: segOut
        });
        segPaths.push(segOut);
      } catch (e) {
        console.warn(`[${jobId}] Segment ${i} failed: ${e.message}, skipping`);
      }

      const pct = 35 + Math.floor((i / finalSegments.length) * 45);
      await onProgress(pct);
    }

    if (!segPaths.length) {
      throw new Error('All segments failed to process. Check clip format compatibility.');
    }

    await onProgress(82);

    // 6. Concatenate
    const concatPath = path.join(tempDir, 'concat.mp4');
    await concatSegments(segPaths, concatPath);
    await onProgress(90);

    // 7. Watermark (free users)
    if (addWatermark) {
      const wmPath = path.join(tempDir, 'watermarked.mp4');
      await applyWatermark(concatPath, wmPath, format);
      await fs.move(wmPath, outputPath, { overwrite: true });
    } else {
      await fs.move(concatPath, outputPath, { overwrite: true });
    }

    await onProgress(100);
    console.log(`[${jobId}] ✅ Processing complete → ${outputPath}`);

  } finally {
    fs.remove(tempDir).catch(() => {});
  }
}

// Map reference video to nearest preset style (MVP heuristic)
// Future: real ML-based style analysis
function mapReferenceToStyle(referencePath) {
  const filename = path.basename(referencePath).toLowerCase();
  if (filename.includes('cinema') || filename.includes('film')) return 'cinematic';
  if (filename.includes('foot') || filename.includes('sport') || filename.includes('hype')) return 'football-hype';
  return 'fast-cuts'; // default
}

module.exports = { processVideo, STYLES, detectBeats };
