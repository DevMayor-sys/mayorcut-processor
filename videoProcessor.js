// ============================================================
// Mayor Cut — Video Processor v4
// Mayor Tech Inc © 2026
//
// If reference video uploaded → uses Blueprint Engine
// (frame-by-frame clone of the reference edit)
//
// If preset style selected → uses Style Presets
// ============================================================

const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const path = require('path');
const fs = require('fs-extra');
const { createBlueprint, executeBlueprint } = require('./blueprintEngine');

ffmpeg.setFfmpegPath(ffmpegStatic);

// ── STYLE PRESETS ─────────────────────────────────────────────
const STYLES = {
  'football-hype': {
    label:'Football Hype', segmentDuration:1.5, minSegment:1.0, maxOutput:60,
    fadeIn:0.12, fadeOut:0.12, speed:1.1, brightness:0.08, contrast:1.2, saturation:1.35,
    beatSyncTightness:0.8, bpmRange:[128,160],
    useFlashCuts:true, useZoomPunches:true, useShakeEffect:false, useSpeedRamps:false, lutStyle:'vibrant'
  },
  'fast-cuts': {
    label:'Fast Cuts', segmentDuration:1.2, minSegment:0.8, maxOutput:60,
    fadeIn:0.08, fadeOut:0.08, speed:1.15, brightness:0.04, contrast:1.1, saturation:1.2,
    beatSyncTightness:0.9, bpmRange:[120,150],
    useFlashCuts:true, useZoomPunches:false, useShakeEffect:false, useSpeedRamps:false, lutStyle:'natural'
  },
  'cinematic': {
    label:'Cinematic', segmentDuration:3.5, minSegment:2.0, maxOutput:90,
    fadeIn:0.5, fadeOut:0.5, speed:0.95, brightness:-0.06, contrast:1.25, saturation:0.8,
    beatSyncTightness:0.5, bpmRange:[70,100],
    useFlashCuts:false, useZoomPunches:false, useShakeEffect:false, useSpeedRamps:true, lutStyle:'dark-cinematic'
  }
};

const FORMATS = {
  '9:16': {w:1080,h:1920}, '1:1':{w:1080,h:1080},
  '16:9':{w:1920,h:1080},  'source':null
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

// ── BEAT DETECTION ────────────────────────────────────────────
async function detectBeats(audioPath, preset) {
  return new Promise((resolve) => {
    const peaks = [];
    ffmpeg(audioPath)
      .outputOptions(['-af','astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-','-f','null','-vn'])
      .output('/dev/null')
      .on('stderr',(line)=>{
        const m=line.match(/lavfi\.astats\.Overall\.RMS_level=(-?\d+\.?\d*)/);
        if(m){const r=parseFloat(m[1]);if(r>-20)peaks.push({time:peaks.length*0.1,rms:r});}
      })
      .on('end',()=>{
        if(peaks.length<3) return resolve(fallbackBeats(preset));
        const top=[...peaks].sort((a,b)=>b.rms-a.rms).slice(0,40).map(p=>p.time).sort((a,b)=>a-b);
        const f=[top[0]];
        for(let i=1;i<top.length;i++){if(top[i]-f[f.length-1]>=0.3)f.push(top[i]);}
        resolve(f);
      })
      .on('error',()=>resolve(fallbackBeats(preset)))
      .run();
  });
}

function fallbackBeats(preset) {
  const [min,max]=preset.bpmRange||[100,140];
  const bpm=min+Math.random()*(max-min);
  const interval=60/bpm;
  const b=[];
  for(let t=0;t<120;t+=interval)b.push(parseFloat(t.toFixed(3)));
  return b;
}

function snapToBeat(time,beats,tightness,tol=0.25){
  if(!beats.length||!tightness)return time;
  let n=beats[0],d=Math.abs(time-beats[0]);
  for(const b of beats){const x=Math.abs(time-b);if(x<d){d=x;n=b;}}
  return d<=tol?time+(n-time)*tightness:time;
}

function getVideoInfo(f){
  return new Promise((res,rej)=>{
    ffmpeg.ffprobe(f,(err,m)=>{
      if(err)return rej(err);
      const vs=m.streams.find(s=>s.codec_type==='video');
      res({duration:m.format.duration||10,width:vs?.width||1080,height:vs?.height||1920,hasAudio:m.streams.some(s=>s.codec_type==='audio')});
    });
  });
}

function extractAudio(i,o){
  return new Promise(res=>{
    ffmpeg(i).outputOptions(['-vn','-acodec','pcm_s16le','-ar','22050','-ac','1'])
    .output(o).on('end',res).on('error',()=>res()).run();
  });
}

function processSegment({input,start,duration,preset,format,outputPath,segIndex}){
  return new Promise((res,rej)=>{
    const fmt=FORMATS[format];
    const spd=typeof preset.speed==='number'?preset.speed:1.0;
    const vf=[];
    if(fmt){vf.push(`scale=${fmt.w}:${fmt.h}:force_original_aspect_ratio=increase`);vf.push(`crop=${fmt.w}:${fmt.h}`);}
    vf.push(`setpts=${(1/spd).toFixed(4)}*PTS`);
    vf.push(`eq=brightness=${preset.brightness}:contrast=${preset.contrast}:saturation=${preset.saturation}`);
    const lut=getLUTFilter(preset.lutStyle);if(lut)vf.push(lut);
    if(preset.useZoomPunches&&segIndex%3===0&&fmt){
      const fd=duration/spd;
      vf.push(`zoompan=z='if(lte(on,${Math.ceil(0.15*30)}),1.07,1.0)':d=${Math.ceil(fd*30)}:s=${fmt.w}x${fmt.h}`);
    }
    if(preset.useShakeEffect&&segIndex%4===0){
      vf.push(`crop=iw-16:ih-16:${segIndex%2===0?8:0}:${segIndex%3===0?8:0}`);
      if(fmt)vf.push(`scale=${fmt.w}:${fmt.h}`);
    }
    const fd=duration/spd;
    vf.push(`fade=t=in:st=0:d=${preset.fadeIn}`);
    vf.push(`fade=t=out:st=${Math.max(0,fd-preset.fadeOut).toFixed(3)}:d=${preset.fadeOut}`);
    if(preset.useFlashCuts&&segIndex>0&&segIndex%2===0)vf.push(`fade=t=in:st=0:d=0.04:color=white`);

    const af=[
      `atempo=${Math.min(Math.max(spd,0.5),2.0).toFixed(4)}`,
      `afade=t=in:st=0:d=${preset.fadeIn}`,
      `afade=t=out:st=${Math.max(0,fd-preset.fadeOut).toFixed(3)}:d=${preset.fadeOut}`
    ];

    ffmpeg(input)
      .inputOptions([`-ss ${start.toFixed(3)}`,`-t ${duration.toFixed(3)}`])
      .videoFilter(vf.join(','))
      .audioFilter(af.join(','))
      .outputOptions(['-c:v','libx264','-preset','fast','-crf','23','-c:a','aac','-ar','44100','-b:a','128k','-movflags','+faststart','-pix_fmt','yuv420p','-avoid_negative_ts','make_zero'])
      .output(outputPath)
      .on('end',res).on('error',rej).run();
  });
}

function applyWatermark(i,o,format){
  return new Promise((res,rej)=>{
    const fmt=FORMATS[format]||FORMATS['9:16'];
    const fs2=fmt?Math.round(fmt.w*0.022):22;
    ffmpeg(i).videoFilter([`drawtext=text='𝙿𝙾𝚆𝙴𝚁𝙴𝙳 𝙱𝚈 𝙼𝙰𝙸𝙾𝚁 𝚃𝙴𝙲𝙷 𝙸𝙽𝙲':fontsize=${fs2}:fontcolor=white@0.55:x=w-text_w-20:y=h-text_h-20:shadowcolor=black@0.4:shadowx=1:shadowy=1:box=1:boxcolor=black@0.15:boxborderw=6`])
    .outputOptions(['-c:v','libx264','-preset','fast','-crf','22','-c:a','copy','-movflags','+faststart'])
    .output(o).on('end',res).on('error',rej).run();
  });
}

function concatSegments(segs,out){
  return new Promise((res,rej)=>{
    const lf=out+'.list.txt';
    fs.writeFileSync(lf,segs.map(p=>`file '${path.resolve(p)}'`).join('\n'));
    ffmpeg().input(lf).inputOptions(['-f','concat','-safe','0'])
    .outputOptions(['-c:v','libx264','-preset','fast','-crf','22','-c:a','aac','-ar','44100','-movflags','+faststart','-pix_fmt','yuv420p'])
    .output(out)
    .on('end',()=>{fs.remove(lf).catch(()=>{});res();})
    .on('error',(e)=>{fs.remove(lf).catch(()=>{});rej(e);})
    .run();
  });
}

// ── MAIN PIPELINE ─────────────────────────────────────────────
async function processVideo({ jobId, clips, reference, style, format, outputPath, addWatermark, onProgress }) {
  const tempDir = `./temp/${jobId}`;
  fs.ensureDirSync(tempDir);

  try {
    // ════════════════════════════════════════════════════════
    // BLUEPRINT MODE — Reference video uploaded
    // Creates frame-by-frame clone of the reference edit
    // ════════════════════════════════════════════════════════
    if (reference) {
      console.log(`[${jobId}] 🔬 BLUEPRINT MODE — cloning reference edit style`);
      await onProgress(10);

      const blueprint = await createBlueprint(reference, jobId);
      await onProgress(20);

      await executeBlueprint({
        blueprint,
        clips,
        format,
        outputPath,
        addWatermark,
        jobId,
        onProgress: async(p) => await onProgress(20 + Math.floor(p*0.8))
      });

      return; // done!
    }

    // ════════════════════════════════════════════════════════
    // PRESET MODE — No reference, use style preset
    // ════════════════════════════════════════════════════════
    const preset = STYLES[style] || STYLES['fast-cuts'];
    console.log(`[${jobId}] 🎨 PRESET MODE — using style: ${preset.label}`);
    await onProgress(15);

    // Extract audio + detect beats
    const audioPath = path.join(tempDir,'audio.wav');
    await extractAudio(clips[0], audioPath);
    await onProgress(20);

    let beats=[];
    try{ beats=await detectBeats(audioPath,preset); }
    catch{ beats=fallbackBeats(preset); }
    await onProgress(28);

    // Plan segments
    const segments=[];
    for(const clip of clips){
      let info;
      try{info=await getVideoInfo(clip);}catch{continue;}
      const {duration}=info;
      const skipPct=duration<10?0:0.08;
      const skip=duration*skipPct;
      const usable=duration-skip*2;
      if(usable<=preset.minSegment){
        if(duration>=0.8)segments.push({file:clip,start:0,duration});
        continue;
      }
      let t=skip;
      while(t<skip+usable-0.5){
        const rem=(skip+usable)-t;
        const raw=t+Math.min(preset.segmentDuration,rem);
        const snp=snapToBeat(raw,beats,preset.beatSyncTightness);
        const seg=Math.max(0.4,Math.min(snp-t,preset.segmentDuration*1.5,rem));
        segments.push({file:clip,start:t,duration:seg});
        t+=seg;
        if(t>=skip+usable-0.3)break;
      }
    }

    if(!segments.length)throw new Error('No usable segments found.');
    console.log(`[${jobId}] 📐 Planned ${segments.length} segments`);

    let total=0;const finals=[];
    for(const s of segments){if(total>=preset.maxOutput)break;finals.push(s);total+=s.duration/(preset.speed||1);}
    await onProgress(35);

    const segPaths=[];
    for(let i=0;i<finals.length;i++){
      const seg=finals[i];
      const out=path.join(tempDir,`seg_${String(i).padStart(4,'0')}.mp4`);
      try{
        await processSegment({input:seg.file,start:seg.start,duration:seg.duration,preset,format,outputPath:out,segIndex:i});
        segPaths.push(out);
      }catch(e){console.warn(`[${jobId}] Seg ${i} failed: ${e.message}`);}
      await onProgress(35+Math.floor((i/finals.length)*52));
    }

    if(!segPaths.length)throw new Error('All segments failed.');
    await onProgress(88);

    const concatPath=path.join(tempDir,'concat.mp4');
    await concatSegments(segPaths,concatPath);
    await onProgress(93);

    if(addWatermark){
      const wmPath=path.join(tempDir,'watermarked.mp4');
      await applyWatermark(concatPath,wmPath,format);
      await fs.move(wmPath,outputPath,{overwrite:true});
    } else {
      await fs.move(concatPath,outputPath,{overwrite:true});
    }

    await onProgress(100);
    console.log(`[${jobId}] ✅ Done → ${outputPath}`);

  } finally {
    fs.remove(tempDir).catch(()=>{});
  }
}

module.exports = { processVideo, STYLES };
