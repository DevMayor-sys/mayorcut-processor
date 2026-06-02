// ============================================================
// Mayor Cut — Video Processor v6 MUSIC + QUALITY
// Mayor Tech Inc © 2026
// ============================================================

const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const path = require('path');
const fs = require('fs-extra');
const { createBlueprint, executeBlueprint } = require('./blueprintEngine');

ffmpeg.setFfmpegPath(ffmpegStatic);

const FORMATS = {
  '9:16':   { w:1080, h:1920 },
  '1:1':    { w:1080, h:1080 },
  '16:9':   { w:1920, h:1080 },
  'source': null
};

const STYLES = {
  'football-hype': {
    label:'Football Hype', segmentDuration:1.5, minSegment:1.0, maxOutput:60,
    fadeIn:0.1, fadeOut:0.1, speed:1.1, brightness:0.08, contrast:1.2, saturation:1.35,
    beatSyncTightness:0.85, bpmRange:[128,160],
    useFlashCuts:true, useZoomPunches:true, useShakeEffect:false, lutStyle:'vibrant'
  },
  'fast-cuts': {
    label:'Fast Cuts', segmentDuration:1.2, minSegment:0.8, maxOutput:60,
    fadeIn:0.07, fadeOut:0.07, speed:1.15, brightness:0.04, contrast:1.1, saturation:1.2,
    beatSyncTightness:0.9, bpmRange:[120,150],
    useFlashCuts:true, useZoomPunches:false, useShakeEffect:false, lutStyle:'natural'
  },
  'cinematic': {
    label:'Cinematic', segmentDuration:3.5, minSegment:2.0, maxOutput:90,
    fadeIn:0.5, fadeOut:0.5, speed:0.95, brightness:-0.06, contrast:1.25, saturation:0.8,
    beatSyncTightness:0.5, bpmRange:[70,100],
    useFlashCuts:false, useZoomPunches:false, useShakeEffect:false, lutStyle:'dark-cinematic'
  }
};

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

// ── MUSIC MIXING ──────────────────────────────────────────────
// Mix background music with video, duck original audio
async function mixMusicWithVideo(videoPath, musicPath, outputPath, jobId) {
  return new Promise((resolve, reject) => {
    console.log(`[${jobId}] 🎵 Mixing music with video...`);

    ffmpeg()
      .input(videoPath)
      .input(musicPath)
      .complexFilter([
        // Lower original clip audio to 5% (just keep ambience faintly)
        '[0:a]volume=0.05[clip_audio]',
        // Music at full volume, trimmed to video length
        '[1:a]volume=1.0[music_audio]',
        // Mix both together
        '[clip_audio][music_audio]amix=inputs=2:duration=first:dropout_transition=2[mixed_audio]'
      ])
      .outputOptions([
        '-map', '0:v',
        '-map', '[mixed_audio]',
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-ar', '44100',
        '-b:a', '192k',
        '-shortest',
        '-movflags', '+faststart'
      ])
      .output(outputPath)
      .on('end', () => { console.log(`[${jobId}] ✅ Music mixed`); resolve(); })
      .on('error', (err) => {
        console.warn(`[${jobId}] Music mix failed: ${err.message} — using video audio only`);
        fs.copy(videoPath, outputPath).then(resolve).catch(reject);
      })
      .run();
  });
}

// ── BEAT DETECTION FROM MUSIC ─────────────────────────────────
// If music uploaded, detect beats from music (not clip audio)
async function detectBeatsFromFile(audioPath, bpmRange) {
  return new Promise((resolve) => {
    const rms = [];
    ffmpeg(audioPath)
      .outputOptions([
        '-af', 'astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-',
        '-f', 'null', '-vn'
      ])
      .output('/dev/null')
      .on('stderr', (line) => {
        const m = line.match(/lavfi\.astats\.Overall\.RMS_level=(-?\d+\.?\d*)/);
        if (m) rms.push({ time: rms.length * 0.1, rms: parseFloat(m[1]) });
      })
      .on('end', () => {
        if (!rms.length) return resolve(fallbackBeats(bpmRange));
        const avgRMS = rms.reduce((a,b) => a+b.rms, 0) / rms.length;
        const peaks = [];
        for (let i=1; i<rms.length-1; i++) {
          if (rms[i].rms > avgRMS+4 && rms[i].rms >= rms[i-1].rms && rms[i].rms >= rms[i+1].rms) {
            peaks.push({ time: rms[i].time, strength: rms[i].rms - avgRMS });
          }
        }
        const filtered = [peaks[0]].filter(Boolean);
        for (let i=1; i<peaks.length; i++) {
          if (peaks[i].time - filtered[filtered.length-1].time >= 0.18) filtered.push(peaks[i]);
        }
        resolve(filtered.map(p => p.time));
      })
      .on('error', () => resolve(fallbackBeats(bpmRange)))
      .run();
  });
}

function fallbackBeats(bpmRange) {
  const [min,max] = bpmRange || [100,140];
  const bpm = min + Math.random()*(max-min);
  const beats = [];
  for (let t=0; t<120; t+=60/bpm) beats.push(parseFloat(t.toFixed(3)));
  return beats;
}

function snapToBeat(time, beats, tightness, tol=0.2) {
  if (!beats.length || !tightness) return time;
  let n=beats[0], d=Math.abs(time-beats[0]);
  for (const b of beats) { const x=Math.abs(time-b); if(x<d){d=x;n=b;} }
  return d<=tol ? time+(n-time)*tightness : time;
}

// ── VIDEO UTILS ───────────────────────────────────────────────
function getVideoInfo(f) {
  return new Promise((res,rej) => {
    ffmpeg.ffprobe(f, (err,m) => {
      if(err) return rej(err);
      const vs = m.streams.find(s=>s.codec_type==='video');
      res({ duration:m.format.duration||10, width:vs?.width||1080, height:vs?.height||1920,
        hasAudio:m.streams.some(s=>s.codec_type==='audio') });
    });
  });
}

function extractAudio(i, o) {
  return new Promise(res => {
    ffmpeg(i).outputOptions(['-vn','-acodec','pcm_s16le','-ar','22050','-ac','1'])
      .output(o).on('end',res).on('error',()=>res()).run();
  });
}

// ── AUTO STYLE DETECTION ──────────────────────────────────────
async function detectAutoStyle(clips, music, jobId) {
  console.log(`[${jobId}] 🤖 AUTO MODE — detecting best style...`);
  try {
    // If music uploaded, analyze music energy
    const analyzeFile = music || clips[0];
    const tmpAudio = `./temp/auto_${jobId}.wav`;
    await extractAudio(analyzeFile, tmpAudio);

    const rms = await new Promise((resolve) => {
      const vals = [];
      ffmpeg(tmpAudio)
        .outputOptions(['-af','astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-','-f','null'])
        .output('/dev/null')
        .on('stderr',(line)=>{
          const m=line.match(/lavfi\.astats\.Overall\.RMS_level=(-?\d+\.?\d*)/);
          if(m) vals.push(parseFloat(m[1]));
        })
        .on('end',()=>resolve(vals))
        .on('error',()=>resolve([]))
        .run();
    });
    fs.remove(tmpAudio).catch(()=>{});

    const avg = rms.length ? rms.reduce((a,b)=>a+b,0)/rms.length : -20;
    const energy = avg > -10 ? 'high' : avg > -20 ? 'medium' : 'low';

    if (energy === 'high')   return STYLES['football-hype'];
    if (energy === 'medium') return STYLES['fast-cuts'];
    return STYLES['cinematic'];
  } catch {
    return STYLES['fast-cuts'];
  }
}

// ── PROCESS SEGMENT ───────────────────────────────────────────
function processSegment({ input, start, duration, preset, format, outputPath, segIndex }) {
  return new Promise((res, rej) => {
    const fmt = FORMATS[format];
    const spd = typeof preset.speed === 'number' ? preset.speed : 1.0;
    const vf = [];

    if (fmt) {
      vf.push(`scale=${fmt.w}:${fmt.h}:force_original_aspect_ratio=increase`);
      vf.push(`crop=${fmt.w}:${fmt.h}`);
    }

    vf.push(`setpts=${(1/spd).toFixed(4)}*PTS`);
    vf.push(`eq=brightness=${preset.brightness}:contrast=${preset.contrast}:saturation=${preset.saturation}`);

    const lut = getLUTFilter(preset.lutStyle);
    if (lut) vf.push(lut);

    if (preset.useZoomPunches && segIndex%3===0 && fmt) {
      const fd = duration/spd;
      vf.push(`zoompan=z='if(lte(on,${Math.ceil(0.18*30)}),1.07,1.0)':d=${Math.ceil(fd*30)}:s=${fmt.w}x${fmt.h}`);
    }

    if (preset.useShakeEffect && segIndex%4===0) {
      vf.push(`crop=iw-16:ih-16:${segIndex%2===0?8:0}:${segIndex%3===0?8:0}`);
      if (fmt) vf.push(`scale=${fmt.w}:${fmt.h}`);
    }

    const fd = duration/spd;
    vf.push(`fade=t=in:st=0:d=${preset.fadeIn}`);
    vf.push(`fade=t=out:st=${Math.max(0,fd-preset.fadeOut).toFixed(3)}:d=${preset.fadeOut}`);
    if (preset.useFlashCuts && segIndex>0 && segIndex%2===0)
      vf.push(`fade=t=in:st=0:d=0.04:color=white`);

    const af = [
      `atempo=${Math.min(Math.max(spd,0.5),2.0).toFixed(4)}`,
      `afade=t=in:st=0:d=${preset.fadeIn}`,
      `afade=t=out:st=${Math.max(0,fd-preset.fadeOut).toFixed(3)}:d=${preset.fadeOut}`
    ];

    ffmpeg(input)
      .inputOptions([`-ss ${start.toFixed(3)}`, `-t ${duration.toFixed(3)}`])
      .videoFilter(vf.join(','))
      .audioFilter(af.join(','))
      .outputOptions([
        '-c:v','libx264','-preset','fast','-crf','21',
        '-c:a','aac','-ar','44100','-b:a','192k',
        '-movflags','+faststart','-pix_fmt','yuv420p',
        '-avoid_negative_ts','make_zero'
      ])
      .output(outputPath)
      .on('end',res).on('error',rej).run();
  });
}

// ── WATERMARK ─────────────────────────────────────────────────
function applyWatermark(i, o, format) {
  return new Promise((res,rej) => {
    const fmt = FORMATS[format] || FORMATS['9:16'];
    const fs2 = fmt ? Math.round(fmt.w*0.022) : 22;
    ffmpeg(i)
      .videoFilter([`drawtext=text='POWERED BY MAYOR TECH INC':fontsize=${fs2}:fontcolor=white@0.55:x=w-text_w-20:y=h-text_h-20:shadowcolor=black@0.4:shadowx=1:shadowy=1:box=1:boxcolor=black@0.2:boxborderw=6`])
      .outputOptions(['-c:v','libx264','-preset','fast','-crf','22','-c:a','copy','-movflags','+faststart'])
      .output(o).on('end',res).on('error',rej).run();
  });
}

// ── CONCAT ────────────────────────────────────────────────────
function concatSegments(segs, out) {
  return new Promise((res,rej) => {
    const lf = out+'.list.txt';
    fs.writeFileSync(lf, segs.map(p=>`file '${path.resolve(p)}'`).join('\n'));
    ffmpeg().input(lf).inputOptions(['-f','concat','-safe','0'])
      .outputOptions(['-c:v','libx264','-preset','fast','-crf','21','-c:a','aac','-ar','44100','-movflags','+faststart','-pix_fmt','yuv420p'])
      .output(out)
      .on('end',()=>{ fs.remove(lf).catch(()=>{}); res(); })
      .on('error',(e)=>{ fs.remove(lf).catch(()=>{}); rej(e); })
      .run();
  });
}

// ── MAIN PIPELINE ─────────────────────────────────────────────
async function processVideo({ jobId, clips, reference, music, style, format, outputPath, addWatermark, onProgress }) {
  const tempDir = `./temp/${jobId}`;
  fs.ensureDirSync(tempDir);

  try {

    // ═══════════════════════════════════════════════════
    // BLUEPRINT MODE — reference video = exact clone
    // ═══════════════════════════════════════════════════
    if (reference) {
      console.log(`[${jobId}] 🔬 BLUEPRINT MODE`);
      await onProgress(10);
      const blueprint = await createBlueprint(reference, jobId);
      await onProgress(20);

      const rawOutput = path.join(tempDir, 'raw_output.mp4');

      await executeBlueprint({
        blueprint, clips, format,
        outputPath: rawOutput,
        addWatermark: false, // apply watermark after music mix
        jobId,
        onProgress: async(p) => await onProgress(20 + Math.floor(p*0.65))
      });

      await onProgress(87);

      // Mix music if provided
      let preWatermark = rawOutput;
      if (music) {
        const musicMixed = path.join(tempDir, 'music_mixed.mp4');
        await mixMusicWithVideo(rawOutput, music, musicMixed, jobId);
        preWatermark = musicMixed;
      }

      // Apply watermark
      if (addWatermark) {
        const wmPath = path.join(tempDir, 'watermarked.mp4');
        await applyWatermark(preWatermark, wmPath, format);
        await fs.move(wmPath, outputPath, { overwrite:true });
      } else {
        await fs.move(preWatermark, outputPath, { overwrite:true });
      }

      await onProgress(100);
      return;
    }

    // ═══════════════════════════════════════════════════
    // PRESET / AUTO MODE
    // ═══════════════════════════════════════════════════
    let preset;
    if (!style || style === 'auto') {
      preset = await detectAutoStyle(clips, music, jobId);
      console.log(`[${jobId}] 🤖 AUTO → ${preset.label}`);
    } else {
      preset = STYLES[style] || STYLES['fast-cuts'];
      console.log(`[${jobId}] 🎨 PRESET: ${preset.label}`);
    }
    await onProgress(12);

    // Detect beats from music if uploaded, otherwise from clip
    const beatSourcePath = music || clips[0];
    const audioPath = path.join(tempDir, 'beats.wav');
    await extractAudio(beatSourcePath, audioPath);
    await onProgress(18);

    let beats = [];
    try { beats = await detectBeatsFromFile(audioPath, preset.bpmRange); }
    catch { beats = fallbackBeats(preset.bpmRange); }
    console.log(`[${jobId}] 🎵 ${beats.length} beats detected from ${music ? 'music' : 'clip'}`);
    await onProgress(25);

    // Plan segments
    const segments = [];
    for (const clip of clips) {
      let info;
      try { info = await getVideoInfo(clip); } catch { continue; }
      const { duration } = info;
      const skipPct = duration < 10 ? 0 : 0.08;
      const skip    = duration * skipPct;
      const usable  = duration - skip*2;

      if (usable <= preset.minSegment) {
        if (duration >= 0.8) segments.push({ file:clip, start:0, duration });
        continue;
      }

      let t = skip;
      while (t < skip+usable-0.5) {
        const rem = (skip+usable)-t;
        const raw = t + Math.min(preset.segmentDuration, rem);
        const snp = snapToBeat(raw, beats, preset.beatSyncTightness);
        const seg = Math.max(0.4, Math.min(snp-t, preset.segmentDuration*1.5, rem));
        segments.push({ file:clip, start:t, duration:seg });
        t += seg;
        if (t >= skip+usable-0.3) break;
      }
    }

    if (!segments.length) throw new Error('No usable segments found. Try longer clips.');
    console.log(`[${jobId}] 📐 ${segments.length} segments planned`);

    // Trim to max output
    let total=0;
    const finals = [];
    for (const s of segments) {
      if (total >= preset.maxOutput) break;
      finals.push(s);
      total += s.duration / (preset.speed||1);
    }
    await onProgress(32);

    // Render segments
    const segPaths = [];
    for (let i=0; i<finals.length; i++) {
      const seg = finals[i];
      const out = path.join(tempDir, `seg_${String(i).padStart(4,'0')}.mp4`);
      try {
        await processSegment({ input:seg.file, start:seg.start, duration:seg.duration,
          preset, format, outputPath:out, segIndex:i });
        segPaths.push(out);
      } catch(e) { console.warn(`[${jobId}] Seg ${i}: ${e.message}`); }
      await onProgress(32 + Math.floor((i/finals.length)*48));
    }

    if (!segPaths.length) throw new Error('All segments failed to render.');
    await onProgress(82);

    // Concat
    const concatPath = path.join(tempDir, 'concat.mp4');
    await concatSegments(segPaths, concatPath);
    await onProgress(87);

    // Mix music
    let preWatermark = concatPath;
    if (music) {
      const musicMixed = path.join(tempDir, 'music_mixed.mp4');
      await mixMusicWithVideo(concatPath, music, musicMixed, jobId);
      preWatermark = musicMixed;
      await onProgress(93);
    }

    // Watermark
    if (addWatermark) {
      const wmPath = path.join(tempDir, 'watermarked.mp4');
      await applyWatermark(preWatermark, wmPath, format);
      await fs.move(wmPath, outputPath, { overwrite:true });
    } else {
      await fs.move(preWatermark, outputPath, { overwrite:true });
    }

    await onProgress(100);
    console.log(`[${jobId}] ✅ Done!`);

  } finally {
    fs.remove(tempDir).catch(()=>{});
  }
}

module.exports = { processVideo, STYLES };
