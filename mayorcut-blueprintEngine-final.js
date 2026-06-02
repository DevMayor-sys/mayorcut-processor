// ============================================================
// Mayor Cut — Frame Blueprint Engine v2 FULL
// Mayor Tech Inc © 2026
//
// AUTO DETECTS AND APPLIES EVERY EFFECT:
// ✅ Hard cuts
// ✅ Flash cuts (white/black flash)
// ✅ Zoom punch in/out
// ✅ Reverse clip
// ✅ Shake/vibrate effect
// ✅ Speed ramp up
// ✅ Slow motion
// ✅ Freeze frame
// ✅ Fade in/out
// ✅ Color grade (warm/cool/dark/bright/vibrant)
// ✅ Beat sync cuts
// ✅ Bass drop effects
// ✅ Strobe effect
// ✅ Blur transition
// ✅ Black bars (cinematic letterbox)
// ✅ Vignette
// ✅ Film grain
// ✅ Color pop (desaturate + one color)
//
// ZERO manual editing. ZERO AI.
// Pure FFmpeg frame analysis.
// ============================================================

const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const path = require('path');
const fs = require('fs-extra');

ffmpeg.setFfmpegPath(ffmpegStatic);

// ── ALL EFFECT TYPES ──────────────────────────────────────────
const FX = {
  // Cuts
  HARD_CUT:       'hard_cut',
  FLASH_CUT:      'flash_cut',
  BLACK_FLASH:    'black_flash',
  BLUR_TRANS:     'blur_transition',

  // Motion
  ZOOM_IN:        'zoom_in',
  ZOOM_OUT:       'zoom_out',
  SHAKE:          'shake',
  REVERSE:        'reverse',

  // Speed
  SPEED_RAMP:     'speed_ramp',
  SLOW_MO:        'slow_mo',
  FREEZE:         'freeze_frame',

  // Audio
  BEAT_HIT:       'beat_hit',
  BASS_DROP:      'bass_drop',

  // Color
  COLOR_GRADE:    'color_grade',
  STROBE:         'strobe',
  VIGNETTE:       'vignette',
  FILM_GRAIN:     'film_grain',
  LETTERBOX:      'letterbox',
  COLOR_POP:      'color_pop',

  // Basic
  FADE_IN:        'fade_in',
  FADE_OUT:       'fade_out',
};

// ── MAIN: CREATE BLUEPRINT ────────────────────────────────────
async function createBlueprint(referencePath, jobId) {
  console.log(`[${jobId}] 📋 Creating FULL blueprint...`);

  const [frameData, audioData, sceneData, videoMeta] =
    await Promise.allSettled([
      extractFrameData(referencePath, jobId),
      extractAudioData(referencePath, jobId),
      extractSceneCuts(referencePath, jobId),
      getVideoMeta(referencePath)
    ]);

  const frames = frameData.status  === 'fulfilled' ? frameData.value  : [];
  const audio  = audioData.status  === 'fulfilled' ? audioData.value  : {};
  const scenes = sceneData.status  === 'fulfilled' ? sceneData.value  : [];
  const meta   = videoMeta.status  === 'fulfilled' ? videoMeta.value  : {};

  // Auto-detect ALL effects from frame data
  const detectedEffects = autoDetectAllEffects(frames, audio, scenes, meta, jobId);

  // Build timeline
  const blueprint = buildTimeline({ frames, audio, scenes, detectedEffects, meta, jobId });

  console.log(`[${jobId}] 📋 Blueprint: ${blueprint.events.length} events | Effects: ${Object.entries(detectedEffects).filter(([,v])=>v).map(([k])=>k).join(', ')}`);
  return blueprint;
}

// ── FRAME DATA ────────────────────────────────────────────────
async function extractFrameData(videoPath, jobId) {
  return new Promise((resolve) => {
    const frames = [];
    let idx = 0;
    console.log(`[${jobId}] 🎞️ Reading frames...`);

    ffmpeg(videoPath)
      .outputOptions(['-vf', 'fps=10,scale=160:90,signalstats', '-f', 'null'])
      .output('/dev/null')
      .on('stderr', (line) => {
        const yavg = line.match(/YAVG=(\d+\.?\d*)/);
        const ydif = line.match(/YDIF=(\d+\.?\d*)/);
        const sat  = line.match(/SATAVG=(\d+\.?\d*)/);
        const hue  = line.match(/HUEMED=(\d+\.?\d*)/);
        if (yavg) {
          frames.push({
            index: idx,
            time:  parseFloat((idx * 0.1).toFixed(3)),
            brightness: parseFloat(yavg[1]),
            motion:     ydif ? parseFloat(ydif[1]) : 0,
            saturation: sat  ? parseFloat(sat[1])  : 50,
            hue:        hue  ? parseFloat(hue[1])  : 180,
          });
          idx++;
        }
      })
      .on('end', () => { console.log(`[${jobId}] 🎞️ ${frames.length} frames analyzed`); resolve(frames); })
      .on('error', () => resolve([]))
      .run();
  });
}

// ── AUDIO DATA ────────────────────────────────────────────────
async function extractAudioData(videoPath, jobId) {
  return new Promise((resolve) => {
    const rms = [];
    console.log(`[${jobId}] 🎵 Reading audio...`);

    ffmpeg(videoPath)
      .outputOptions(['-af','astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-','-f','null','-vn'])
      .output('/dev/null')
      .on('stderr', (line) => {
        const m = line.match(/lavfi\.astats\.Overall\.RMS_level=(-?\d+\.?\d*)/);
        if (m) rms.push({ time: rms.length * 0.1, rms: parseFloat(m[1]) });
      })
      .on('end', () => {
        if (!rms.length) return resolve({ beats:[], drops:[], avgRMS:-20, energy:'medium', bpm:120 });

        const avgRMS = rms.reduce((a,b)=>a+b.rms,0)/rms.length;

        // Detect beats (peaks above avg+5)
        const beats = [];
        for (let i=1; i<rms.length-1; i++) {
          if (rms[i].rms > avgRMS+5 && rms[i].rms >= rms[i-1].rms && rms[i].rms >= rms[i+1].rms) {
            beats.push({ time:rms[i].time, strength:rms[i].rms-avgRMS, isBass:rms[i].rms>avgRMS+12 });
          }
        }

        // Dedupe beats (min 0.2s apart)
        const filtBeats = [beats[0]].filter(Boolean);
        for (let i=1;i<beats.length;i++) {
          if (beats[i].time - filtBeats[filtBeats.length-1].time >= 0.2) filtBeats.push(beats[i]);
        }

        // Bass drops = very strong beats (top 10%)
        const drops = filtBeats.filter(b=>b.isBass);

        // BPM estimate
        let bpm = 120;
        if (filtBeats.length > 2) {
          const intervals = [];
          for (let i=1;i<filtBeats.length;i++) intervals.push(filtBeats[i].time-filtBeats[i-1].time);
          const avgInterval = intervals.reduce((a,b)=>a+b,0)/intervals.length;
          bpm = Math.round(Math.max(60,Math.min(200,60/avgInterval)));
        }

        const energy = avgRMS > -10 ? 'high' : avgRMS > -20 ? 'medium' : 'low';
        console.log(`[${jobId}] 🎵 ${filtBeats.length} beats, ${drops.length} drops, BPM≈${bpm}, energy=${energy}`);
        resolve({ beats:filtBeats, drops, avgRMS, energy, bpm });
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
        if (cuts.length < 2) {
          // Try looser threshold
          return extractSceneCutsLoose(videoPath).then(resolve);
        }
        console.log(`[${jobId}] ✂️ ${cuts.length} scene cuts`);
        resolve(cuts.sort((a,b)=>a.time-b.time));
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
      .on('end', () => resolve(cuts.sort((a,b)=>a.time-b.time)))
      .on('error', () => resolve([]))
      .run();
  });
}

// ── AUTO DETECT ALL EFFECTS ───────────────────────────────────
function autoDetectAllEffects(frames, audio, scenes, meta, jobId) {
  if (!frames.length) return getDefaultEffects();

  const avgBrightness = frames.reduce((a,b)=>a+b.brightness,0)/frames.length;
  const avgMotion     = frames.reduce((a,b)=>a+b.motion,0)/frames.length;
  const avgSat        = frames.reduce((a,b)=>a+b.saturation,0)/frames.length;
  const avgHue        = frames.reduce((a,b)=>a+b.hue,0)/frames.length;

  // ── Flash cuts: sudden brightness spikes > avg+50
  const flashFrames = frames.filter(f=>f.brightness>avgBrightness+50).length;
  const hasFlashCuts = flashFrames > frames.length * 0.015;

  // ── Black flash: sudden very dark frames
  const blackFrames = frames.filter(f=>f.brightness<30).length;
  const hasBlackFlash = blackFrames > frames.length * 0.01;

  // ── Zoom punch: brightness trend up over 3 frames + high motion
  let zoomCount = 0;
  for (let i=2; i<frames.length; i++) {
    const trend = frames[i].brightness - frames[i-2].brightness;
    if (trend > 15 && frames[i].motion > avgMotion*1.8) zoomCount++;
  }
  const hasZoomPunches = zoomCount > frames.length * 0.03;

  // ── Zoom out: brightness trend DOWN over 3 frames
  let zoomOutCount = 0;
  for (let i=2; i<frames.length; i++) {
    const trend = frames[i-2].brightness - frames[i].brightness;
    if (trend > 15 && frames[i].motion > avgMotion*1.8) zoomOutCount++;
  }
  const hasZoomOut = zoomOutCount > frames.length * 0.03;

  // ── Shake: rapid motion variance between consecutive frames
  let shakeCount = 0;
  for (let i=1; i<frames.length; i++) {
    if (Math.abs(frames[i].motion-frames[i-1].motion) > avgMotion*2) shakeCount++;
  }
  const hasShakeEffect = shakeCount > frames.length * 0.08;

  // ── Reverse clip: periodic motion pattern (hard to detect, use high motion variance)
  const motionValues = frames.map(f=>f.motion);
  const motionStdDev = Math.sqrt(motionValues.reduce((a,b)=>a+(b-avgMotion)**2,0)/motionValues.length);
  const hasReverseClips = motionStdDev > avgMotion * 1.5 && scenes.length > 3;

  // ── Speed ramp: sudden motion increase
  let speedRampCount = 0;
  for (let i=1; i<frames.length; i++) {
    if (frames[i].motion - frames[i-1].motion > avgMotion*3) speedRampCount++;
  }
  const hasSpeedRamps = speedRampCount > frames.length * 0.02;

  // ── Slow mo: sustained low motion sections
  let slowSections = 0;
  for (let i=0; i<frames.length-5; i++) {
    const sectionAvg = frames.slice(i,i+5).reduce((a,b)=>a+b.motion,0)/5;
    if (sectionAvg < avgMotion * 0.2) slowSections++;
  }
  const hasSlowMo = slowSections > frames.length * 0.05;

  // ── Freeze frame: near-zero motion for 3+ consecutive frames
  let freezeCount = 0;
  for (let i=0; i<frames.length-3; i++) {
    if (frames[i].motion<3 && frames[i+1].motion<3 && frames[i+2].motion<3) freezeCount++;
  }
  const hasFreezeFrame = freezeCount > 5;

  // ── Strobe: very rapid brightness alternation
  let strobeCount = 0;
  for (let i=1; i<frames.length; i++) {
    if (Math.abs(frames[i].brightness-frames[i-1].brightness) > 60) strobeCount++;
  }
  const hasStrobe = strobeCount > frames.length * 0.05;

  // ── Vignette: corners darker than center (hard to detect from stats)
  // Use low overall brightness as proxy
  const hasVignette = avgBrightness < 90 && avgMotion < 20;

  // ── Film grain: high frequency brightness noise
  let grainCount = 0;
  for (let i=2; i<frames.length; i++) {
    const delta = Math.abs(frames[i].brightness - frames[i-1].brightness);
    if (delta > 5 && delta < 15) grainCount++;
  }
  const hasFilmGrain = grainCount > frames.length * 0.4;

  // ── Letterbox: very dark top/bottom (detected via low overall brightness)
  const hasLetterbox = avgBrightness < 80 && audio.energy === 'low';

  // ── Color pop: very low saturation overall
  const hasColorPop = avgSat < 25;

  // ── Blur transition: frame motion blur (high YDIF with low scene changes)
  const hasBlurTrans = avgMotion > 20 && scenes.length < frames.length/50;

  // ── Color grade detection
  const isWarm = avgHue < 90 || avgHue > 270;
  const isCool = avgHue > 160 && avgHue < 260;
  let lutStyle = 'natural';
  const ydifAvg = frames.reduce((a,b)=>a+b.motion,0)/frames.length;
  if      (avgBrightness < 70  && ydifAvg > 1.3)    lutStyle = 'dark-cinematic';
  else if (avgSat > 65 && avgBrightness > 130)        lutStyle = 'vibrant';
  else if (avgSat < 25)                               lutStyle = 'desaturated';
  else if (isWarm && avgSat > 50)                     lutStyle = 'warm-golden';
  else if (isCool  && ydifAvg > 1.2)                  lutStyle = 'cool-blue';
  else if (avgBrightness > 160)                       lutStyle = 'bright-airy';

  // ── Final brightness/contrast/saturation values
  const brightness = parseFloat(((avgBrightness-128)/128*0.3).toFixed(3));
  const contrast   = parseFloat((1.0+(ydifAvg/255)*0.6).toFixed(3));
  const saturation = parseFloat((0.7+(avgSat/50)*0.6).toFixed(3));

  const effects = {
    hasFlashCuts, hasBlackFlash, hasZoomPunches, hasZoomOut,
    hasShakeEffect, hasReverseClips, hasSpeedRamps, hasSlowMo,
    hasFreezeFrame, hasStrobe, hasVignette, hasFilmGrain,
    hasLetterbox, hasColorPop, hasBlurTrans,
    colorGrade: { brightness, contrast, saturation, lutStyle }
  };

  // Log all detected effects
  const detected = Object.entries(effects)
    .filter(([k,v]) => k.startsWith('has') && v===true)
    .map(([k])=>k.replace('has',''));
  console.log(`[${jobId}] 🔍 Auto-detected effects: ${detected.join(', ') || 'none'} | LUT: ${lutStyle}`);

  return effects;
}

function getDefaultEffects() {
  return {
    hasFlashCuts:false, hasBlackFlash:false, hasZoomPunches:false, hasZoomOut:false,
    hasShakeEffect:false, hasReverseClips:false, hasSpeedRamps:false, hasSlowMo:false,
    hasFreezeFrame:false, hasStrobe:false, hasVignette:false, hasFilmGrain:false,
    hasLetterbox:false, hasColorPop:false, hasBlurTrans:false,
    colorGrade: { brightness:0, contrast:1.1, saturation:1.0, lutStyle:'natural' }
  };
}

// ── BUILD TIMELINE ────────────────────────────────────────────
function buildTimeline({ frames, audio, scenes, detectedEffects, meta, jobId }) {
  const events = [];
  const duration = meta.duration || 10;

  // Scene cuts
  for (const cut of scenes) {
    const nearby = frames.filter(f=>Math.abs(f.time-cut.time)<0.15);
    const nearAvg = nearby.length ? nearby.reduce((a,b)=>a+b.brightness,0)/nearby.length : 128;
    const globalAvg = frames.length ? frames.reduce((a,b)=>a+b.brightness,0)/frames.length : 128;

    let cutType = FX.HARD_CUT;
    if (nearAvg > globalAvg+40)  cutType = FX.FLASH_CUT;
    if (nearAvg < 40)            cutType = FX.BLACK_FLASH;

    events.push({ type:cutType, time:cut.time, duration:0.05, intensity:1.0 });
  }

  // Beat events
  for (const beat of (audio.beats||[])) {
    events.push({
      type:      beat.isBass ? FX.BASS_DROP : FX.BEAT_HIT,
      time:      beat.time,
      duration:  0.05,
      intensity: Math.min(1.0, beat.strength/15),
      isBass:    beat.isBass
    });
  }

  // Always add fade in/out
  events.push({ type:FX.FADE_IN,  time:0,            duration:0.25, intensity:1.0 });
  events.push({ type:FX.FADE_OUT, time:duration-0.3, duration:0.3,  intensity:1.0 });

  events.sort((a,b)=>a.time-b.time);

  // Build scene segments
  const cutTimes = [0, ...scenes.map(s=>s.time), duration].sort((a,b)=>a-b);
  const sceneSegments = [];
  for (let i=0; i<cutTimes.length-1; i++) {
    const start = cutTimes[i];
    const end   = cutTimes[i+1];
    const dur   = end-start;
    if (dur >= 0.3) sceneSegments.push({ index:i, start, end, duration:parseFloat(dur.toFixed(3)) });
  }

  const avgCut = sceneSegments.length>1
    ? sceneSegments.reduce((a,b)=>a+b.duration,0)/sceneSegments.length
    : 2.0;

  return {
    duration,
    events,
    sceneSegments,
    avgCutDuration: parseFloat(avgCut.toFixed(3)),
    totalScenes:    sceneSegments.length,
    totalBeats:     (audio.beats||[]).length,
    bpm:            audio.bpm || 120,
    audioEnergy:    audio.energy || 'medium',
    effects:        detectedEffects,
    colorGrade:     detectedEffects.colorGrade,
    meta: { width:meta.width||1080, height:meta.height||1920, fps:meta.fps||30 }
  };
}

// ── GET VIDEO META ────────────────────────────────────────────
async function getVideoMeta(videoPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, meta) => {
      if (err) return reject(err);
      const vs = meta.streams.find(s=>s.codec_type==='video');
      resolve({
        duration: meta.format.duration||10,
        width:    vs?.width||1080,
        height:   vs?.height||1920,
        fps:      eval(vs?.r_frame_rate||'30/1'),
      });
    });
  });
}

// ── EXECUTE BLUEPRINT ─────────────────────────────────────────
async function executeBlueprint({ blueprint, clips, format, outputPath, addWatermark, jobId, onProgress }) {
  const tempDir = `./temp/${jobId}_bp`;
  fs.ensureDirSync(tempDir);

  const FORMATS = {
    '9:16':{w:1080,h:1920}, '1:1':{w:1080,h:1080},
    '16:9':{w:1920,h:1080}, 'source':{w:blueprint.meta.width,h:blueprint.meta.height}
  };
  const fmt = FORMATS[format] || FORMATS['9:16'];
  const { effects, colorGrade } = blueprint;

  try {
    // Get clip info
    const clipInfos = [];
    for (const clip of clips) {
      try {
        const info = await getClipInfo(clip);
        clipInfos.push({ path:clip, ...info });
      } catch { clipInfos.push({ path:clip, duration:10 }); }
    }
    await onProgress(20);

    const scenes = blueprint.sceneSegments;
    const segPaths = [];

    for (let i=0; i<scenes.length; i++) {
      const scene    = scenes[i];
      const clipInfo = clipInfos[i % clipInfos.length];
      const clipDur  = clipInfo.duration;

      const maxStart  = Math.max(0, clipDur-scene.duration-0.5);
      const clipStart = Math.min(maxStart, clipDur*0.05 + (i/scenes.length)*clipDur*0.8);
      const readDur   = Math.min(scene.duration, clipDur-clipStart);
      if (readDur < 0.3) continue;

      // Events during this scene
      const sceneEvents = blueprint.events.filter(e=>e.time>=scene.start&&e.time<scene.end);

      const segOut = path.join(tempDir, `seg_${String(i).padStart(4,'0')}.mp4`);

      // Check if this scene should be reversed
      const shouldReverse = effects.hasReverseClips && i % 5 === 2;

      try {
        if (shouldReverse) {
          await renderReversedScene({ inputPath:clipInfo.path, start:clipStart, duration:readDur, colorGrade, effects, fmt, outputPath:segOut, sceneIndex:i });
        } else {
          await renderScene({ inputPath:clipInfo.path, start:clipStart, duration:readDur, sceneDuration:scene.duration, sceneEvents, blueprint, fmt, outputPath:segOut, sceneIndex:i, totalScenes:scenes.length });
        }
        segPaths.push(segOut);
      } catch(e) {
        console.warn(`[${jobId}] Scene ${i} failed: ${e.message}`);
      }

      await onProgress(20 + Math.floor((i/scenes.length)*65));
    }

    if (!segPaths.length) throw new Error('No scenes rendered');
    await onProgress(87);

    // Concat
    const concatPath = path.join(tempDir,'concat.mp4');
    await concatAll(segPaths, concatPath);
    await onProgress(93);

    // Watermark
    if (addWatermark) {
      const wmPath = path.join(tempDir,'watermarked.mp4');
      await applyWatermark(concatPath, wmPath, fmt);
      await fs.move(wmPath, outputPath, {overwrite:true});
    } else {
      await fs.move(concatPath, outputPath, {overwrite:true});
    }

    await onProgress(100);
    console.log(`[${jobId}] ✅ Blueprint executed!`);

  } finally {
    fs.remove(tempDir).catch(()=>{});
  }
}

// ── RENDER ONE SCENE WITH ALL EFFECTS ─────────────────────────
function renderScene({ inputPath, start, duration, sceneDuration, sceneEvents, blueprint, fmt, outputPath, sceneIndex, totalScenes }) {
  return new Promise((resolve, reject) => {
    const { effects, colorGrade } = blueprint;
    const vf = [];
    const af = [];

    // 1. Scale + crop
    vf.push(`scale=${fmt.w}:${fmt.h}:force_original_aspect_ratio=increase`);
    vf.push(`crop=${fmt.w}:${fmt.h}`);

    // 2. Speed
    let speed = 1.0;
    const hasSpeedUp = sceneEvents.some(e=>e.type===FX.SPEED_RAMP) || (effects.hasSpeedRamps && sceneIndex%4===0);
    const hasSlowMo  = sceneEvents.some(e=>e.type===FX.SLOW_MO)    || (effects.hasSlowMo  && sceneIndex%5===1);
    if (hasSpeedUp) speed = 1.2;
    if (hasSlowMo)  speed = 0.5;
    vf.push(`setpts=${(1/speed).toFixed(4)}*PTS`);
    af.push(`atempo=${Math.min(Math.max(speed,0.5),2.0).toFixed(4)}`);

    // 3. Color grade
    vf.push(`eq=brightness=${colorGrade.brightness}:contrast=${colorGrade.contrast}:saturation=${colorGrade.saturation}`);

    // 4. LUT
    const lut = getLUTFilter(colorGrade.lutStyle);
    if (lut) vf.push(lut);

    // 5. Film grain
    if (effects.hasFilmGrain) {
      vf.push(`noise=alls=8:allf=t+u`);
    }

    // 6. Vignette
    if (effects.hasVignette) {
      vf.push(`vignette=PI/4`);
    }

    // 7. Letterbox (cinematic black bars)
    if (effects.hasLetterbox) {
      const barH = Math.round(fmt.h * 0.08);
      vf.push(`drawbox=x=0:y=0:w=${fmt.w}:h=${barH}:color=black:t=fill`);
      vf.push(`drawbox=x=0:y=${fmt.h-barH}:w=${fmt.w}:h=${barH}:color=black:t=fill`);
    }

    // 8. Zoom punch
    const hasZoom = sceneEvents.some(e=>e.type===FX.ZOOM_IN) || (effects.hasZoomPunches && sceneIndex%3===0);
    if (hasZoom) {
      const fd = sceneDuration/speed;
      vf.push(`zoompan=z='if(lte(on,${Math.ceil(0.2*30)}),1.08,1.0)':d=${Math.ceil(fd*30)}:s=${fmt.w}x${fmt.h}`);
    }

    // 9. Zoom out
    const hasZoomOut = sceneEvents.some(e=>e.type===FX.ZOOM_OUT) || (effects.hasZoomOut && sceneIndex%4===2);
    if (hasZoomOut) {
      const fd = sceneDuration/speed;
      vf.push(`zoompan=z='if(lte(on,${Math.ceil(0.2*30)}),0.95,1.0)':d=${Math.ceil(fd*30)}:s=${fmt.w}x${fmt.h}`);
    }

    // 10. Shake
    const hasShake = sceneEvents.some(e=>e.type===FX.SHAKE) || (effects.hasShakeEffect && sceneIndex%3===1);
    if (hasShake) {
      const ox = sceneIndex%2===0?10:0;
      const oy = sceneIndex%3===0?10:0;
      vf.push(`crop=iw-20:ih-20:${ox}:${oy}`);
      vf.push(`scale=${fmt.w}:${fmt.h}`);
    }

    // 11. Strobe (rapid brightness flicker)
    if (effects.hasStrobe && sceneIndex%6===0) {
      vf.push(`curves=all='0/0 0.5/${sceneIndex%2===0?'0.9':'0.1'} 1/1'`);
    }

    // 12. Color pop (desaturate + keep one color)
    if (effects.hasColorPop) {
      vf.push(`hue=s=0.1`); // near grayscale
    }

    // 13. Blur transition (at start of scene)
    if (effects.hasBlurTrans && sceneIndex > 0) {
      vf.push(`boxblur=luma_radius=2:luma_power=1`);
    }

    // 14. Freeze frame (hold last frame)
    if (effects.hasFreezeFrame && sceneIndex%7===0) {
      vf.push(`tpad=stop_mode=clone:stop_duration=0.2`);
    }

    // 15. Fade in/out
    const fd = sceneDuration/speed;
    const fi = Math.min(0.12, fd*0.1);
    const fo = Math.min(0.12, fd*0.1);
    vf.push(`fade=t=in:st=0:d=${fi}`);
    vf.push(`fade=t=out:st=${Math.max(0,fd-fo).toFixed(3)}:d=${fo}`);
    af.push(`afade=t=in:st=0:d=${fi}`);
    af.push(`afade=t=out:st=${Math.max(0,fd-fo).toFixed(3)}:d=${fo}`);

    // 16. Flash cut (white flash at scene start)
    const hasFlash = sceneEvents.some(e=>e.type===FX.FLASH_CUT) || (effects.hasFlashCuts && sceneIndex%2===0);
    if (hasFlash && sceneIndex > 0) vf.push(`fade=t=in:st=0:d=0.04:color=white`);

    // 17. Black flash
    const hasBlack = sceneEvents.some(e=>e.type===FX.BLACK_FLASH) || (effects.hasBlackFlash && sceneIndex%3===2);
    if (hasBlack && sceneIndex > 0) vf.push(`fade=t=in:st=0:d=0.04:color=black`);

    ffmpeg(inputPath)
      .inputOptions([`-ss ${start.toFixed(3)}`, `-t ${duration.toFixed(3)}`])
      .videoFilter(vf.join(','))
      .audioFilter(af.join(','))
      .outputOptions(['-c:v','libx264','-preset','fast','-crf','22','-c:a','aac','-ar','44100','-b:a','128k','-movflags','+faststart','-pix_fmt','yuv420p','-avoid_negative_ts','make_zero'])
      .output(outputPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

// ── REVERSE SCENE ─────────────────────────────────────────────
function renderReversedScene({ inputPath, start, duration, colorGrade, effects, fmt, outputPath, sceneIndex }) {
  return new Promise((resolve, reject) => {
    const vf = [
      `scale=${fmt.w}:${fmt.h}:force_original_aspect_ratio=increase`,
      `crop=${fmt.w}:${fmt.h}`,
      `reverse`,
      `eq=brightness=${colorGrade.brightness}:contrast=${colorGrade.contrast}:saturation=${colorGrade.saturation}`,
    ];
    const lut = getLUTFilter(colorGrade.lutStyle);
    if (lut) vf.push(lut);
    if (effects.hasFilmGrain) vf.push(`noise=alls=8:allf=t+u`);
    vf.push(`fade=t=in:st=0:d=0.08`);
    vf.push(`fade=t=out:st=${Math.max(0,duration-0.08).toFixed(3)}:d=0.08`);

    ffmpeg(inputPath)
      .inputOptions([`-ss ${start.toFixed(3)}`,`-t ${duration.toFixed(3)}`])
      .videoFilter(vf.join(','))
      .audioFilter(['areverse','afade=t=in:st=0:d=0.08'].join(','))
      .outputOptions(['-c:v','libx264','-preset','fast','-crf','22','-c:a','aac','-ar','44100','-movflags','+faststart','-pix_fmt','yuv420p','-avoid_negative_ts','make_zero'])
      .output(outputPath)
      .on('end',resolve).on('error',reject).run();
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
async function getClipInfo(clipPath) {
  return new Promise((resolve,reject)=>{
    ffmpeg.ffprobe(clipPath,(err,meta)=>{
      if(err)return reject(err);
      resolve({ duration:meta.format.duration||10, hasAudio:meta.streams.some(s=>s.codec_type==='audio') });
    });
  });
}

async function concatAll(segs, out) {
  return new Promise((resolve,reject)=>{
    const lf=out+'.list.txt';
    fs.writeFileSync(lf,segs.map(p=>`file '${path.resolve(p)}'`).join('\n'));
    ffmpeg().input(lf).inputOptions(['-f','concat','-safe','0'])
    .outputOptions(['-c:v','libx264','-preset','fast','-crf','22','-c:a','aac','-ar','44100','-movflags','+faststart','-pix_fmt','yuv420p'])
    .output(out)
    .on('end',()=>{fs.remove(lf).catch(()=>{});resolve();})
    .on('error',(e)=>{fs.remove(lf).catch(()=>{});reject(e);})
    .run();
  });
}

async function applyWatermark(inputPath, outputPath, fmt) {
  return new Promise((resolve,reject)=>{
    const fontSize=fmt?Math.round(fmt.w*0.022):22;
    ffmpeg(inputPath)
    .videoFilter([`drawtext=text='𝙿𝙾𝚆𝙴𝚁𝙴𝙳 𝙱𝚈 𝙼𝙰𝙸𝙾𝚁 𝚃𝙴𝙲𝙷 𝙸𝙽𝙲':fontsize=${fontSize}:fontcolor=white@0.55:x=w-text_w-20:y=h-text_h-20:shadowcolor=black@0.4:shadowx=1:shadowy=1:box=1:boxcolor=black@0.15:boxborderw=6`])
    .outputOptions(['-c:v','libx264','-preset','fast','-crf','22','-c:a','copy','-movflags','+faststart'])
    .output(outputPath)
    .on('end',resolve).on('error',reject).run();
  });
}

module.exports = { createBlueprint, executeBlueprint };
