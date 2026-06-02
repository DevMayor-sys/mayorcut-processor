// ============================================================
// Mayor Cut — Blueprint Engine v5 QUALITY FOCUS
// Mayor Tech Inc © 2026
//
// Priority: output quality above everything else.
// A user should be able to post without touching CapCut.
// ============================================================

const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const path = require('path');
const fs = require('fs-extra');
const { analyzeClips, selectSegmentsForTimeline } = require('./clipSelector');
const { scoreTimeline, improveTimeline } = require('./qualityEngine');

ffmpeg.setFfmpegPath(ffmpegStatic);

const QUALITY_THRESHOLD = 65; // minimum score to export
const MAX_IMPROVE_ATTEMPTS = 3;

// ── MAIN: CREATE BLUEPRINT ────────────────────────────────────
async function createBlueprint(referencePath, jobId) {
  console.log(`[${jobId}] 📋 Creating quality blueprint...`);

  const [frameData, audioData, sceneData, videoMeta] = await Promise.allSettled([
    extractFrameData(referencePath, jobId),
    extractAudioData(referencePath, jobId),
    extractSceneCuts(referencePath, jobId),
    getVideoMeta(referencePath)
  ]);

  const frames = frameData.status === 'fulfilled' ? frameData.value : [];
  const audio  = audioData.status === 'fulfilled' ? audioData.value : { beats:[], drops:[], avgRMS:-20, energy:'medium', bpm:120 };
  const scenes = sceneData.status === 'fulfilled' ? sceneData.value : [];
  const meta   = videoMeta.status === 'fulfilled' ? videoMeta.value : { duration:10, width:1080, height:1920, fps:30 };

  // Build energy curve (most important for pacing)
  const energyCurve = buildEnergyCurve(frames, meta.duration);
  console.log(`[${jobId}] ⚡ Energy curve: [${energyCurve.map(v => v.toFixed(2)).join(', ')}]`);

  // Detect effects (smart — avoids overdetection)
  const effects = detectEffectsSmart(frames, audio, scenes, jobId);

  // Build timeline
  const blueprint = buildTimeline({ frames, audio, scenes, effects, meta, energyCurve, jobId });

  console.log(`[${jobId}] ✅ Blueprint: ${blueprint.events.length} events | ${blueprint.totalScenes} scenes | BPM:${blueprint.bpm} | Energy:${audio.energy}`);
  return blueprint;
}

// ── ENERGY CURVE ──────────────────────────────────────────────
// Divides video into 8 sections, calculates energy per section
// Returns array of 0-1 values representing energy progression
function buildEnergyCurve(frames, duration) {
  const SECTIONS = 8;
  if (!frames.length) return Array(SECTIONS).fill(0.5);

  const sectionSize = frames.length / SECTIONS;
  const curve = [];

  for (let i = 0; i < SECTIONS; i++) {
    const start = Math.floor(i * sectionSize);
    const end   = Math.floor((i + 1) * sectionSize);
    const section = frames.slice(start, end);

    if (!section.length) { curve.push(0.5); continue; }

    const avgMotion = section.reduce((a, b) => a + b.motion, 0) / section.length;
    const avgBright = section.reduce((a, b) => a + b.brightness, 0) / section.length;

    // Energy = combination of motion and brightness variance
    const brightVar = section.reduce((a, b) => a + Math.pow(b.brightness - avgBright, 2), 0) / section.length;
    const energy = Math.min(1.0, (avgMotion / 30 * 0.6) + (Math.sqrt(brightVar) / 50 * 0.4));
    curve.push(parseFloat(energy.toFixed(3)));
  }

  // Normalize curve to 0-1 range
  const maxE = Math.max(...curve);
  const minE = Math.min(...curve);
  const range = maxE - minE;
  if (range > 0.1) {
    return curve.map(v => parseFloat(((v - minE) / range).toFixed(3)));
  }
  return curve;
}

// ── SMART EFFECT DETECTION ────────────────────────────────────
// Detects effects conservatively to avoid spam
function detectEffectsSmart(frames, audio, scenes, jobId) {
  if (!frames.length) return buildAudioOnlyEffects(audio);

  const avgB   = frames.reduce((a, b) => a + b.brightness, 0) / frames.length;
  const avgM   = frames.reduce((a, b) => a + b.motion, 0) / frames.length;
  const avgSat = frames.reduce((a, b) => a + b.saturation, 0) / frames.length;
  const avgHue = frames.reduce((a, b) => a + b.hue, 0) / frames.length;

  // CONSERVATIVE thresholds — only detect if clearly present
  // Flash cuts: at least 3% of frames are very bright
  const flashFrames = frames.filter(f => f.brightness > avgB + 60).length;
  const hasFlashCuts = flashFrames > frames.length * 0.025;

  // Black flash: at least 1% of frames are very dark
  const darkFrames = frames.filter(f => f.brightness < 25).length;
  const hasBlackFlash = darkFrames > frames.length * 0.015;

  // Zoom: clear brightness trend over 4+ frames
  let zoomCount = 0;
  for (let i = 3; i < frames.length; i++) {
    const trend = frames[i].brightness - frames[i-3].brightness;
    if (trend > 20 && frames[i].motion > avgM * 2) zoomCount++;
  }
  const hasZoomPunches = zoomCount > frames.length * 0.04;

  // Shake: strong rapid motion variance
  let shakeCount = 0;
  for (let i = 1; i < frames.length; i++) {
    if (Math.abs(frames[i].motion - frames[i-1].motion) > avgM * 2.5) shakeCount++;
  }
  const hasShakeEffect = shakeCount > frames.length * 0.10;

  // Speed ramp: very sudden motion spike
  let rampCount = 0;
  for (let i = 1; i < frames.length; i++) {
    if (frames[i].motion - frames[i-1].motion > avgM * 4) rampCount++;
  }
  const hasSpeedRamps = rampCount > frames.length * 0.025;

  // Slow mo: sustained very low motion
  let slowCount = 0;
  for (let i = 0; i < frames.length - 5; i++) {
    const avg = frames.slice(i, i+5).reduce((a,b) => a + b.motion, 0) / 5;
    if (avg < avgM * 0.15) slowCount++;
  }
  const hasSlowMo = slowCount > frames.length * 0.06;

  // Film grain: only if clearly present (high noise pattern)
  let grainCount = 0;
  for (let i = 2; i < frames.length; i++) {
    const d = Math.abs(frames[i].brightness - frames[i-1].brightness);
    if (d > 3 && d < 12) grainCount++;
  }
  const hasFilmGrain = grainCount > frames.length * 0.45;

  // Letterbox: very dark overall + cinematic feel
  const hasLetterbox = avgB < 75 && audio.energy !== 'high';

  // Glitch: very high brightness alternation
  let glitchCount = 0;
  for (let i = 2; i < frames.length; i++) {
    if (Math.abs(frames[i].brightness - frames[i-2].brightness) > 80) glitchCount++;
  }
  const hasGlitch = glitchCount > frames.length * 0.05;

  // Whip pan: sudden extreme motion spike
  let whipCount = 0;
  for (let i = 1; i < frames.length; i++) {
    if (frames[i].motion > avgM * 5 && frames[i-1].motion < avgM) whipCount++;
  }
  const hasWhipPan = whipCount >= 2;

  // Color grade
  const isWarm = avgHue < 90 || avgHue > 270;
  const isCool = avgHue > 160 && avgHue < 260;
  let lutStyle = 'natural';
  if      (avgB < 70 && avgM > 1.3)           lutStyle = 'dark-cinematic';
  else if (avgSat > 65 && avgB > 130)          lutStyle = 'vibrant';
  else if (avgSat < 22)                        lutStyle = 'desaturated';
  else if (isWarm && avgSat > 50)              lutStyle = 'warm-golden';
  else if (isCool && avgM > 1.2)               lutStyle = 'cool-blue';
  else if (avgB > 165)                         lutStyle = 'bright-airy';

  const brightness = parseFloat(((avgB - 128) / 128 * 0.25).toFixed(3));
  const contrast   = parseFloat((1.0 + (avgM / 255) * 0.5).toFixed(3));
  const saturation = parseFloat((0.75 + (avgSat / 50) * 0.5).toFixed(3));

  // Count active effects to warn about overdetection
  const activeEffects = [hasFlashCuts, hasBlackFlash, hasZoomPunches, hasShakeEffect,
    hasSpeedRamps, hasSlowMo, hasGlitch, hasWhipPan].filter(Boolean).length;

  if (activeEffects > 5) {
    console.log(`[Unknown job] ⚠️ High effect count (${activeEffects}) — reducing to avoid spam`);
  }

  const detected = { hasFlashCuts, hasBlackFlash, hasZoomPunches, hasZoomOut: false,
    hasShakeEffect, hasWhipPan, hasSpeedRamps, hasSlowMo,
    hasFilmGrain, hasLetterbox, hasGlitch,
    colorGrade: { brightness, contrast, saturation, lutStyle }
  };

  const names = Object.entries(detected).filter(([k,v]) => k.startsWith('has') && v === true).map(([k]) => k.replace('has',''));
  console.log(`[?] 🔍 Effects: ${names.join(', ') || 'minimal'} | LUT:${lutStyle}`);
  return detected;
}

function buildAudioOnlyEffects(audio) {
  const h = audio.energy === 'high';
  return {
    hasFlashCuts: h, hasBlackFlash: false, hasZoomPunches: h,
    hasZoomOut: false, hasShakeEffect: false, hasWhipPan: false,
    hasSpeedRamps: h, hasSlowMo: !h, hasFilmGrain: false,
    hasLetterbox: !h, hasGlitch: false,
    colorGrade: { brightness: 0, contrast: 1.1, saturation: 1.0, lutStyle: 'natural' }
  };
}

// ── FRAME EXTRACTION ─────────────────────────────────────────
async function extractFrameData(videoPath, jobId) {
  return new Promise((resolve) => {
    const frames = [];
    let idx = 0;
    console.log(`[${jobId}] 🎞️ Reading frames...`);
    ffmpeg(videoPath)
      .outputOptions(['-vf','fps=5,scale=160:90,signalstats,metadata=print:file=-','-f','null'])
      .output('/dev/null')
      .on('stderr', (line) => {
        const yavg = line.match(/lavfi\.signalstats\.YAVG=(\d+\.?\d*)/);
        const ydif = line.match(/lavfi\.signalstats\.YDIF=(\d+\.?\d*)/);
        const sat  = line.match(/lavfi\.signalstats\.SATAVG=(\d+\.?\d*)/);
        const hue  = line.match(/lavfi\.signalstats\.HUEMED=(\d+\.?\d*)/);
        if (yavg) {
          frames.push({ index:idx, time:parseFloat((idx*0.2).toFixed(3)),
            brightness:parseFloat(yavg[1]), motion:ydif?parseFloat(ydif[1]):0,
            saturation:sat?parseFloat(sat[1]):50, hue:hue?parseFloat(hue[1]):180 });
          idx++;
        }
      })
      .on('end', () => {
        console.log(`[${jobId}] 🎞️ ${frames.length} frames`);
        if (!frames.length) return extractFrameFallback(videoPath, jobId).then(resolve);
        resolve(frames);
      })
      .on('error', () => extractFrameFallback(videoPath, jobId).then(resolve))
      .run();
  });
}

async function extractFrameFallback(videoPath, jobId) {
  return new Promise((resolve) => {
    const frames = [];
    let idx = 0;
    console.log(`[${jobId}] 🎞️ Frame fallback...`);
    ffmpeg(videoPath)
      .outputOptions(['-vf','fps=2,scale=80:45,showinfo','-f','null'])
      .output('/dev/null')
      .on('stderr', (line) => {
        const pts  = line.match(/pts_time:(\d+\.?\d*)/);
        const mean = line.match(/mean:\[(\d+)/);
        if (pts && mean) {
          const b = parseFloat(mean[1]);
          frames.push({ index:idx, time:parseFloat(pts[1]), brightness:b,
            motion: idx > 0 ? Math.abs(b - (frames[idx-1]?.brightness || b)) : 0,
            saturation:50, hue:180 });
          idx++;
        }
      })
      .on('end', () => { console.log(`[${jobId}] 🎞️ Fallback: ${frames.length} frames`); resolve(frames); })
      .on('error', () => resolve([]))
      .run();
  });
}

// ── AUDIO EXTRACTION ─────────────────────────────────────────
async function extractAudioData(videoPath, jobId) {
  return new Promise((resolve) => {
    const rms = [];
    ffmpeg(videoPath)
      .outputOptions(['-af','astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-','-f','null','-vn'])
      .output('/dev/null')
      .on('stderr', (line) => {
        const m = line.match(/lavfi\.astats\.Overall\.RMS_level=(-?\d+\.?\d*)/);
        if (m) rms.push({ time: rms.length * 0.1, rms: parseFloat(m[1]) });
      })
      .on('end', () => {
        if (!rms.length) return resolve({ beats:[], drops:[], avgRMS:-20, energy:'medium', bpm:120 });
        const avgRMS = rms.reduce((a,b) => a+b.rms, 0) / rms.length;
        const raw = [];
        for (let i = 1; i < rms.length-1; i++) {
          if (rms[i].rms > avgRMS+5 && rms[i].rms >= rms[i-1].rms && rms[i].rms >= rms[i+1].rms)
            raw.push({ time:rms[i].time, strength:rms[i].rms-avgRMS, isBass:rms[i].rms>avgRMS+12 });
        }
        const filtered = [raw[0]].filter(Boolean);
        for (let i = 1; i < raw.length; i++) {
          if (raw[i].time - filtered[filtered.length-1].time >= 0.2) filtered.push(raw[i]);
        }
        let bpm = 120;
        if (filtered.length > 2) {
          const iv = [];
          for (let i = 1; i < filtered.length; i++) iv.push(filtered[i].time - filtered[i-1].time);
          bpm = Math.round(Math.max(60, Math.min(200, 60 / (iv.reduce((a,b)=>a+b,0)/iv.length))));
        }
        const energy = avgRMS > -10 ? 'high' : avgRMS > -20 ? 'medium' : 'low';
        console.log(`[${jobId}] 🎵 ${filtered.length} beats | BPM≈${bpm} | energy=${energy}`);
        resolve({ beats:filtered, drops:filtered.filter(b=>b.isBass), avgRMS, energy, bpm });
      })
      .on('error', () => resolve({ beats:[], drops:[], avgRMS:-20, energy:'medium', bpm:120 }))
      .run();
  });
}

// ── SCENE CUTS ────────────────────────────────────────────────
async function extractSceneCuts(videoPath, jobId) {
  return new Promise((resolve) => {
    const cuts = [];
    ffmpeg(videoPath)
      .outputOptions(['-vf',"select='gt(scene,0.2)',showinfo",'-vsync','vfr','-f','null'])
      .output('/dev/null')
      .on('stderr', (line) => {
        const t = line.match(/pts_time:(\d+\.?\d*)/);
        if (t) cuts.push({ time: parseFloat(t[1]) });
      })
      .on('end', () => {
        if (cuts.length < 2) return extractSceneCutsLoose(videoPath).then(resolve);
        console.log(`[${jobId}] ✂️ ${cuts.length} scene cuts`);
        resolve(cuts.sort((a,b) => a.time - b.time));
      })
      .on('error', () => resolve([]))
      .run();
  });
}

async function extractSceneCutsLoose(videoPath) {
  return new Promise((resolve) => {
    const cuts = [];
    ffmpeg(videoPath)
      .outputOptions(['-vf',"select='gt(scene,0.1)',showinfo",'-vsync','vfr','-f','null'])
      .output('/dev/null')
      .on('stderr', (line) => {
        const t = line.match(/pts_time:(\d+\.?\d*)/);
        if (t) cuts.push({ time: parseFloat(t[1]) });
      })
      .on('end', () => resolve(cuts.sort((a,b) => a.time - b.time)))
      .on('error', () => resolve([]))
      .run();
  });
}

async function getVideoMeta(videoPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, meta) => {
      if (err) return reject(err);
      const vs = meta.streams.find(s => s.codec_type === 'video');
      resolve({ duration:meta.format.duration||10, width:vs?.width||1080, height:vs?.height||1920, fps:eval(vs?.r_frame_rate||'30/1') });
    });
  });
}

// ── BUILD TIMELINE ────────────────────────────────────────────
function buildTimeline({ frames, audio, scenes, effects, meta, energyCurve, jobId }) {
  const events = [];
  const duration = meta.duration || 10;
  const avgB = frames.length ? frames.reduce((a,b)=>a+b.brightness,0)/frames.length : 128;

  for (const cut of scenes) {
    const nb = frames.filter(f => Math.abs(f.time - cut.time) < 0.15);
    const na = nb.length ? nb.reduce((a,b)=>a+b.brightness,0)/nb.length : 128;
    const ct = na > avgB + 40 ? 'flash_cut' : na < 40 ? 'black_flash' : 'hard_cut';
    events.push({ type:ct, time:cut.time, duration:0.05, intensity:1.0 });
  }

  for (const beat of (audio.beats || [])) {
    events.push({ type:beat.isBass?'bass_drop':'beat_hit', time:beat.time, duration:0.05,
      intensity:Math.min(1.0, beat.strength/15), isBass:beat.isBass });
  }

  events.push({ type:'fade_in',  time:0,            duration:0.25, intensity:1.0 });
  events.push({ type:'fade_out', time:duration-0.3, duration:0.3,  intensity:1.0 });
  events.sort((a,b) => a.time - b.time);

  const cutTimes = [0, ...scenes.map(s=>s.time), duration].sort((a,b) => a-b);
  const sceneSegments = [];
  for (let i = 0; i < cutTimes.length-1; i++) {
    const s=cutTimes[i], e=cutTimes[i+1], d=e-s;
    if (d >= 0.3) {
      // Tag each scene with its energy level from the curve
      const sectionIdx = Math.floor((s / duration) * energyCurve.length);
      const sceneEnergy = energyCurve[Math.min(sectionIdx, energyCurve.length-1)] || 0.5;
      sceneSegments.push({ index:i, start:s, end:e, duration:parseFloat(d.toFixed(3)), energyLevel:sceneEnergy });
    }
  }

  const avgCut = sceneSegments.length > 1
    ? sceneSegments.reduce((a,b)=>a+b.duration,0)/sceneSegments.length : 2.0;

  return {
    duration, events, sceneSegments,
    avgCutDuration: parseFloat(avgCut.toFixed(3)),
    totalScenes:    sceneSegments.length,
    totalBeats:     (audio.beats||[]).length,
    bpm:            audio.bpm || 120,
    audioEnergy:    audio.energy || 'medium',
    energyCurve,
    effects,
    colorGrade:     effects.colorGrade,
    beats:          audio.beats || [],
    meta:           { width:meta.width||1080, height:meta.height||1920, fps:meta.fps||30 }
  };
}

// ── EXECUTE BLUEPRINT ─────────────────────────────────────────
async function executeBlueprint({ blueprint, clips, format, outputPath, addWatermark, jobId, onProgress }) {
  const tempDir = `./temp/${jobId}_bp`;
  fs.ensureDirSync(tempDir);

  const FORMATS = { '9:16':{w:1080,h:1920}, '1:1':{w:1080,h:1080}, '16:9':{w:1920,h:1080}, 'source':{w:blueprint.meta.width,h:blueprint.meta.height} };
  const fmt = FORMATS[format] || FORMATS['9:16'];

  try {
    // Step 1: Analyze clips for best moments
    console.log(`[${jobId}] 🎬 Analyzing clips for best moments...`);
    const analyzedClips = await analyzeClips(clips, jobId);
    await onProgress(15);

    // Step 2: Select best segments matching energy curve
    const selectedSegs = selectSegmentsForTimeline(analyzedClips, blueprint.energyCurve, blueprint.duration);
    await onProgress(22);

    // Step 3: Build initial timeline
    let timeline = buildRenderTimeline(blueprint, selectedSegs, analyzedClips);
    await onProgress(28);

    // Step 4: Quality scoring loop
    console.log(`[${jobId}] 📊 Scoring timeline quality...`);
    let scores = scoreTimeline(timeline, blueprint, blueprint.beats);
    console.log(`[${jobId}] 📊 Initial scores: overall=${scores.overall} beat=${scores.beatSync} pacing=${scores.pacing} energy=${scores.energy}`);

    let attempt = 0;
    while (scores.overall < QUALITY_THRESHOLD && attempt < MAX_IMPROVE_ATTEMPTS) {
      attempt++;
      console.log(`[${jobId}] 🔧 Quality below ${QUALITY_THRESHOLD} — improving (attempt ${attempt})...`);
      timeline = improveTimeline(timeline, blueprint, blueprint.beats, analyzedClips, attempt);
      scores = scoreTimeline(timeline, blueprint, blueprint.beats);
      console.log(`[${jobId}] 📊 After improvement: overall=${scores.overall} beat=${scores.beatSync} pacing=${scores.pacing}`);
    }

    console.log(`[${jobId}] ✅ Final quality: ${scores.overall}/100 | beat:${scores.beatSync} pacing:${scores.pacing} energy:${scores.energy} clarity:${scores.clarity}`);
    await onProgress(35);

    // Step 5: Render all scenes
    const segPaths = [];
    for (let i = 0; i < timeline.length; i++) {
      const seg = timeline[i];
      const segOut = path.join(tempDir, `seg_${String(i).padStart(4,'0')}.mp4`);
      const shouldReverse = blueprint.effects.hasReverseClips && i % 5 === 2;

      try {
        if (shouldReverse) {
          await renderReversed({ inputPath:seg.clipPath, start:seg.clipStart, duration:seg.clipDuration,
            colorGrade:blueprint.colorGrade, effects:blueprint.effects, fmt, outputPath:segOut, sceneIndex:i });
        } else {
          await renderScene({ inputPath:seg.clipPath, start:seg.clipStart, duration:seg.clipDuration,
            sceneDuration:seg.clipDuration, sceneEvents:seg.events||[], blueprint, fmt,
            outputPath:segOut, sceneIndex:i, totalScenes:timeline.length,
            energyLevel:seg.energyLevel||0.5 });
        }
        segPaths.push(segOut);
      } catch(e) {
        console.warn(`[${jobId}] Scene ${i} failed: ${e.message}`);
      }

      await onProgress(35 + Math.floor((i / timeline.length) * 52));
    }

    if (!segPaths.length) throw new Error('No scenes rendered successfully');
    await onProgress(88);

    const concatPath = path.join(tempDir, 'concat.mp4');
    await concatAll(segPaths, concatPath);
    await onProgress(93);

    if (addWatermark) {
      const wmPath = path.join(tempDir, 'watermarked.mp4');
      await applyWatermark(concatPath, wmPath, fmt);
      await fs.move(wmPath, outputPath, { overwrite:true });
    } else {
      await fs.move(concatPath, outputPath, { overwrite:true });
    }

    await onProgress(100);
    console.log(`[${jobId}] ✅ Done! Quality: ${scores.overall}/100`);

  } finally {
    fs.remove(tempDir).catch(() => {});
  }
}

// ── BUILD RENDER TIMELINE ─────────────────────────────────────
function buildRenderTimeline(blueprint, selectedSegs, analyzedClips) {
  const timeline = [];
  const scenes   = blueprint.sceneSegments;

  for (let i = 0; i < scenes.length; i++) {
    const scene    = scenes[i];
    const selected = selectedSegs[i % selectedSegs.length];
    const clipInfo = selected || getDefaultClipSeg(analyzedClips, i, scene.duration);

    if (!clipInfo) continue;

    // Get events during this scene
    const sceneEvents = blueprint.events.filter(e => e.time >= scene.start && e.time < scene.end);

    // Decide if this scene gets effects (energy-based, not random)
    const hasEffect = shouldApplyEffect(scene.energyLevel, i, blueprint.effects);

    timeline.push({
      clipPath:     clipInfo.clipPath || clipInfo.path,
      clipStart:    clipInfo.clipStart || clipInfo.start || 0,
      clipDuration: Math.min(clipInfo.clipDuration || scene.duration, scene.duration),
      energyLevel:  scene.energyLevel || 0.5,
      energyScore:  clipInfo.energyScore || 0.5,
      events:       sceneEvents,
      hasEffect,
      sceneStart:   scene.start,
      sceneEnd:     scene.end
    });
  }

  return timeline;
}

// Decide intelligently whether to apply effects to this scene
function shouldApplyEffect(energyLevel, sceneIndex, effects) {
  // High energy scenes: more likely to have effects
  // Low energy scenes: effects should be rare
  const anyEffects = Object.entries(effects).some(([k,v]) => k.startsWith('has') && v === true);
  if (!anyEffects) return false;

  if (energyLevel > 0.7) return sceneIndex % 2 === 0;  // 50% of high-energy scenes
  if (energyLevel > 0.4) return sceneIndex % 3 === 0;  // 33% of medium scenes
  return sceneIndex % 5 === 0; // 20% of low-energy scenes
}

function getDefaultClipSeg(analyzedClips, index, duration) {
  const clip = analyzedClips[index % analyzedClips.length];
  if (!clip) return null;
  const start = Math.min(clip.duration * 0.1 + (index * 2) % (clip.duration * 0.7), clip.duration - duration - 0.5);
  return { clipPath: clip.path, clipStart: Math.max(0, start), clipDuration: duration, energyScore: 0.5 };
}

// ── RENDER SCENE ──────────────────────────────────────────────
function renderScene({ inputPath, start, duration, sceneDuration, sceneEvents, blueprint, fmt, outputPath, sceneIndex, totalScenes, energyLevel }) {
  return new Promise((resolve, reject) => {
    const { effects, colorGrade } = blueprint;
    const vf = [], af = [];

    // Scale + crop
    vf.push(`scale=${fmt.w}:${fmt.h}:force_original_aspect_ratio=increase`);
    vf.push(`crop=${fmt.w}:${fmt.h}`);

    // Speed — based on energy level and reference effects
    let speed = 1.0;
    const hasSpeedUp = sceneEvents.some(e => e.type==='speed_ramp') || (effects.hasSpeedRamps && energyLevel > 0.7 && sceneIndex % 3 === 0);
    const hasSlowMo  = sceneEvents.some(e => e.type==='slow_mo')    || (effects.hasSlowMo  && energyLevel < 0.3 && sceneIndex % 4 === 1);
    if (hasSpeedUp) speed = 1.2;
    if (hasSlowMo)  speed = 0.6;
    vf.push(`setpts=${(1/speed).toFixed(4)}*PTS`);
    af.push(`atempo=${Math.min(Math.max(speed,0.5),2.0).toFixed(4)}`);

    // Color grade
    vf.push(`eq=brightness=${colorGrade.brightness}:contrast=${colorGrade.contrast}:saturation=${colorGrade.saturation}`);
    const lut = getLUTFilter(colorGrade.lutStyle);
    if (lut) vf.push(lut);

    // Film grain — subtle, only if reference had it
    if (effects.hasFilmGrain) vf.push(`noise=c0s=6:c0f=t`);

    // Letterbox — only if reference had it
    if (effects.hasLetterbox) {
      const bh = Math.round(fmt.h * 0.07);
      vf.push(`drawbox=x=0:y=0:w=${fmt.w}:h=${bh}:color=black:t=fill`);
      vf.push(`drawbox=x=0:y=${fmt.h-bh}:w=${fmt.w}:h=${bh}:color=black:t=fill`);
    }

    // Zoom punch — only on high energy scenes
    const applyZoom = sceneEvents.some(e => e.type==='zoom_in') ||
      (effects.hasZoomPunches && energyLevel > 0.6 && sceneIndex % 3 === 0);
    if (applyZoom) {
      const fd = sceneDuration / speed;
      vf.push(`zoompan=z='if(lte(on,${Math.ceil(0.18*30)}),1.07,1.0)':d=${Math.ceil(fd*30)}:s=${fmt.w}x${fmt.h}`);
    }

    // Shake — only on very high energy, sparingly
    const applyShake = sceneEvents.some(e => e.type==='shake') ||
      (effects.hasShakeEffect && energyLevel > 0.8 && sceneIndex % 4 === 1);
    if (applyShake) {
      const ox = sceneIndex % 2 === 0 ? 8 : 0;
      const oy = sceneIndex % 3 === 0 ? 8 : 0;
      vf.push(`crop=iw-16:ih-16:${ox}:${oy}`);
      vf.push(`scale=${fmt.w}:${fmt.h}`);
    }

    // Whip pan blur — very selective
    if (effects.hasWhipPan && energyLevel > 0.75 && sceneIndex % 5 === 0) {
      vf.push(`boxblur=luma_radius=2:luma_power=1`);
    }

    // Glitch — rare, only on bass drops
    const isBassDrop = sceneEvents.some(e => e.type === 'bass_drop');
    if (effects.hasGlitch && isBassDrop) {
      vf.push(`rgbashift=rh=2:bh=-2`);
    }

    // Fades — proportional to scene length
    const fd = sceneDuration / speed;
    const fi = energyLevel > 0.6 ? 0.06 : 0.2;
    const fo = energyLevel > 0.6 ? 0.06 : 0.2;
    vf.push(`fade=t=in:st=0:d=${fi}`);
    vf.push(`fade=t=out:st=${Math.max(0, fd-fo).toFixed(3)}:d=${fo}`);
    af.push(`afade=t=in:st=0:d=${fi}`);
    af.push(`afade=t=out:st=${Math.max(0, fd-fo).toFixed(3)}:d=${fo}`);

    // Flash cut — only on flash cut events
    const isFlash = sceneEvents.some(e => e.type==='flash_cut') || (effects.hasFlashCuts && energyLevel > 0.65 && sceneIndex % 2 === 0);
    if (isFlash && sceneIndex > 0) vf.push(`fade=t=in:st=0:d=0.04:color=white`);

    // Black flash — only on black flash events
    const isBlack = sceneEvents.some(e => e.type==='black_flash') || (effects.hasBlackFlash && sceneIndex % 4 === 2);
    if (isBlack && sceneIndex > 0) vf.push(`fade=t=in:st=0:d=0.04:color=black`);

    ffmpeg(inputPath)
      .inputOptions([`-ss ${start.toFixed(3)}`, `-t ${duration.toFixed(3)}`])
      .videoFilter(vf.join(','))
      .audioFilter(af.join(','))
      .outputOptions(['-c:v','libx264','-preset','fast','-crf','21','-c:a','aac','-ar','44100','-b:a','192k','-movflags','+faststart','-pix_fmt','yuv420p','-avoid_negative_ts','make_zero'])
      .output(outputPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

// ── RENDER REVERSED ───────────────────────────────────────────
function renderReversed({ inputPath, start, duration, colorGrade, effects, fmt, outputPath }) {
  return new Promise((resolve, reject) => {
    const vf = [
      `scale=${fmt.w}:${fmt.h}:force_original_aspect_ratio=increase`,
      `crop=${fmt.w}:${fmt.h}`, `reverse`,
      `eq=brightness=${colorGrade.brightness}:contrast=${colorGrade.contrast}:saturation=${colorGrade.saturation}`
    ];
    const lut = getLUTFilter(colorGrade.lutStyle);
    if (lut) vf.push(lut);
    if (effects.hasFilmGrain) vf.push(`noise=c0s=6:c0f=t`);
    vf.push(`fade=t=in:st=0:d=0.08`);
    vf.push(`fade=t=out:st=${Math.max(0,duration-0.08).toFixed(3)}:d=0.08`);

    ffmpeg(inputPath)
      .inputOptions([`-ss ${start.toFixed(3)}`, `-t ${duration.toFixed(3)}`])
      .videoFilter(vf.join(','))
      .audioFilter(['areverse','afade=t=in:st=0:d=0.08'].join(','))
      .outputOptions(['-c:v','libx264','-preset','fast','-crf','21','-c:a','aac','-ar','44100','-movflags','+faststart','-pix_fmt','yuv420p','-avoid_negative_ts','make_zero'])
      .output(outputPath)
      .on('end', resolve).on('error', reject).run();
  });
}

// ── LUT FILTER ────────────────────────────────────────────────
function getLUTFilter(lutStyle) {
  switch(lutStyle) {
    case 'vibrant':        return `curves=r='0/0 0.5/0.58 1/1':g='0/0 0.5/0.52 1/1':b='0/0 0.5/0.48 1/0.95'`;
    case 'dark-cinematic': return `curves=r='0/0.05 0.5/0.48 1/0.92':g='0/0.02 0.5/0.47 1/0.9':b='0/0.03 0.5/0.52 1/0.95'`;
    case 'warm-golden':    return `curves=r='0/0 0.5/0.58 1/1':g='0/0 0.5/0.5 1/0.95':b='0/0 0.5/0.42 1/0.85'`;
    case 'cool-blue':      return `curves=r='0/0 0.5/0.44 1/0.92':g='0/0 0.5/0.49 1/0.97':b='0/0 0.5/0.56 1/1.0'`;
    case 'desaturated':    return `curves=r='0/0.05 1/0.95':g='0/0.05 1/0.95':b='0/0.05 1/0.95'`;
    case 'bright-airy':    return `curves=r='0/0.08 0.5/0.6 1/1':g='0/0.08 0.5/0.6 1/1':b='0/0.1 0.5/0.62 1/1'`;
    default: return null;
  }
}

// ── UTILS ─────────────────────────────────────────────────────
async function concatAll(segs, out) {
  return new Promise((resolve, reject) => {
    const lf = out + '.list.txt';
    fs.writeFileSync(lf, segs.map(p => `file '${path.resolve(p)}'`).join('\n'));
    ffmpeg().input(lf).inputOptions(['-f','concat','-safe','0'])
      .outputOptions(['-c:v','libx264','-preset','fast','-crf','21','-c:a','aac','-ar','44100','-movflags','+faststart','-pix_fmt','yuv420p'])
      .output(out)
      .on('end', () => { fs.remove(lf).catch(() => {}); resolve(); })
      .on('error', (e) => { fs.remove(lf).catch(() => {}); reject(e); })
      .run();
  });
}

async function applyWatermark(inputPath, outputPath, fmt) {
  return new Promise((resolve, reject) => {
    const fs2 = fmt ? Math.round(fmt.w * 0.022) : 22;
    ffmpeg(inputPath)
      .videoFilter([`drawtext=text='POWERED BY MAYOR TECH INC':fontsize=${fs2}:fontcolor=white@0.55:x=w-text_w-20:y=h-text_h-20:shadowcolor=black@0.4:shadowx=1:shadowy=1:box=1:boxcolor=black@0.2:boxborderw=6`])
      .outputOptions(['-c:v','libx264','-preset','fast','-crf','22','-c:a','copy','-movflags','+faststart'])
      .output(outputPath)
      .on('end', resolve).on('error', reject).run();
  });
}

module.exports = { createBlueprint, executeBlueprint };
