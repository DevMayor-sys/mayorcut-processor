// ============================================================
// Mayor Cut — Blueprint Engine v4 COMPLETE
// Mayor Tech Inc © 2026
// Full auto-detection + all effects + music sync
// ============================================================

const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const path = require('path');
const fs = require('fs-extra');

ffmpeg.setFfmpegPath(ffmpegStatic);

const FX = {
  HARD_CUT:'hard_cut', FLASH_CUT:'flash_cut', BLACK_FLASH:'black_flash',
  ZOOM_IN:'zoom_in', ZOOM_OUT:'zoom_out', SHAKE:'shake', REVERSE:'reverse',
  SPEED_RAMP:'speed_ramp', SLOW_MO:'slow_mo', FREEZE:'freeze_frame',
  BEAT_HIT:'beat_hit', BASS_DROP:'bass_drop',
  FADE_IN:'fade_in', FADE_OUT:'fade_out',
  WHIP_PAN:'whip_pan', GLITCH:'glitch', STROBE:'strobe',
  LETTERBOX:'letterbox', FILM_GRAIN:'film_grain', COLOR_POP:'color_pop',
};

// ── MAIN CREATE BLUEPRINT ─────────────────────────────────────
async function createBlueprint(referencePath, jobId) {
  console.log(`[${jobId}] 📋 Creating full blueprint...`);
  const [frameData, audioData, sceneData, videoMeta] = await Promise.allSettled([
    extractFrameData(referencePath, jobId),
    extractAudioData(referencePath, jobId),
    extractSceneCuts(referencePath, jobId),
    getVideoMeta(referencePath)
  ]);
  const frames = frameData.status==='fulfilled' ? frameData.value : [];
  const audio  = audioData.status==='fulfilled' ? audioData.value : {beats:[],drops:[],avgRMS:-20,energy:'medium',bpm:120};
  const scenes = sceneData.status==='fulfilled' ? sceneData.value : [];
  const meta   = videoMeta.status==='fulfilled' ? videoMeta.value : {duration:10,width:1080,height:1920,fps:30};
  const effects = autoDetectEffects(frames, audio, scenes, jobId);
  const blueprint = buildTimeline({frames, audio, scenes, effects, meta, jobId});
  console.log(`[${jobId}] ✅ Blueprint: ${blueprint.events.length} events | ${blueprint.totalScenes} scenes | BPM:${blueprint.bpm}`);
  return blueprint;
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
          frames.push({
            index:idx, time:parseFloat((idx*0.2).toFixed(3)),
            brightness:parseFloat(yavg[1]), motion:ydif?parseFloat(ydif[1]):0,
            saturation:sat?parseFloat(sat[1]):50, hue:hue?parseFloat(hue[1]):180
          });
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
    console.log(`[${jobId}] 🎞️ Frame fallback...`);
    const frames = [];
    let idx = 0;
    ffmpeg(videoPath)
      .outputOptions(['-vf','fps=2,scale=80:45,showinfo','-f','null'])
      .output('/dev/null')
      .on('stderr', (line) => {
        const pts = line.match(/pts_time:(\d+\.?\d*)/);
        const mean = line.match(/mean:\[(\d+)/);
        if (pts && mean) {
          const b = parseFloat(mean[1]);
          frames.push({ index:idx, time:parseFloat(pts[1]), brightness:b,
            motion:idx>0?Math.abs(b-(frames[idx-1]?.brightness||128)):0, saturation:50, hue:180 });
          idx++;
        }
      })
      .on('end', () => { console.log(`[${jobId}] 🎞️ Fallback: ${frames.length} frames`); resolve(frames); })
      .on('error', () => resolve([]))
      .run();
  });
}

// ── AUDIO EXTRACTION ──────────────────────────────────────────
async function extractAudioData(videoPath, jobId) {
  return new Promise((resolve) => {
    const rms = [];
    console.log(`[${jobId}] 🎵 Reading audio...`);
    ffmpeg(videoPath)
      .outputOptions(['-af','astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-','-f','null','-vn'])
      .output('/dev/null')
      .on('stderr', (line) => {
        const m = line.match(/lavfi\.astats\.Overall\.RMS_level=(-?\d+\.?\d*)/);
        if (m) rms.push({ time:rms.length*0.1, rms:parseFloat(m[1]) });
      })
      .on('end', () => {
        if (!rms.length) return resolve({beats:[],drops:[],avgRMS:-20,energy:'medium',bpm:120});
        const avgRMS = rms.reduce((a,b)=>a+b.rms,0)/rms.length;
        const beats=[], raw=[];
        for (let i=1;i<rms.length-1;i++) {
          if (rms[i].rms>avgRMS+5 && rms[i].rms>=rms[i-1].rms && rms[i].rms>=rms[i+1].rms)
            raw.push({time:rms[i].time,strength:rms[i].rms-avgRMS,isBass:rms[i].rms>avgRMS+12});
        }
        const filtered=[raw[0]].filter(Boolean);
        for(let i=1;i<raw.length;i++){if(raw[i].time-filtered[filtered.length-1].time>=0.2)filtered.push(raw[i]);}
        const drops=filtered.filter(b=>b.isBass);
        let bpm=120;
        if(filtered.length>2){
          const iv=[];
          for(let i=1;i<filtered.length;i++)iv.push(filtered[i].time-filtered[i-1].time);
          const ai=iv.reduce((a,b)=>a+b,0)/iv.length;
          bpm=Math.round(Math.max(60,Math.min(200,60/ai)));
        }
        const energy=avgRMS>-10?'high':avgRMS>-20?'medium':'low';
        console.log(`[${jobId}] 🎵 ${filtered.length} beats, BPM≈${bpm}, energy=${energy}`);
        resolve({beats:filtered,drops,avgRMS,energy,bpm});
      })
      .on('error', ()=>resolve({beats:[],drops:[],avgRMS:-20,energy:'medium',bpm:120}))
      .run();
  });
}

// ── SCENE CUTS ────────────────────────────────────────────────
async function extractSceneCuts(videoPath, jobId) {
  return new Promise((resolve) => {
    const cuts=[];
    ffmpeg(videoPath)
      .outputOptions(['-vf',"select='gt(scene,0.2)',showinfo",'-vsync','vfr','-f','null'])
      .output('/dev/null')
      .on('stderr',(line)=>{const t=line.match(/pts_time:(\d+\.?\d*)/);if(t)cuts.push({time:parseFloat(t[1])});})
      .on('end',()=>{
        if(cuts.length<2) return extractSceneCutsLoose(videoPath).then(resolve);
        console.log(`[${jobId}] ✂️ ${cuts.length} scene cuts`);
        resolve(cuts.sort((a,b)=>a.time-b.time));
      })
      .on('error',()=>resolve([]))
      .run();
  });
}

async function extractSceneCutsLoose(videoPath) {
  return new Promise((resolve)=>{
    const cuts=[];
    ffmpeg(videoPath)
      .outputOptions(['-vf',"select='gt(scene,0.1)',showinfo",'-vsync','vfr','-f','null'])
      .output('/dev/null')
      .on('stderr',(line)=>{const t=line.match(/pts_time:(\d+\.?\d*)/);if(t)cuts.push({time:parseFloat(t[1])});})
      .on('end',()=>resolve(cuts.sort((a,b)=>a.time-b.time)))
      .on('error',()=>resolve([]))
      .run();
  });
}

// ── AUTO DETECT ALL EFFECTS ───────────────────────────────────
function autoDetectEffects(frames, audio, scenes, jobId) {
  if (!frames.length) {
    console.log(`[${jobId}] ⚠️ No frames — using audio-based detection only`);
    return buildEffectsFromAudioOnly(audio);
  }

  const avgB   = frames.reduce((a,b)=>a+b.brightness,0)/frames.length;
  const avgM   = frames.reduce((a,b)=>a+b.motion,0)/frames.length;
  const avgSat = frames.reduce((a,b)=>a+b.saturation,0)/frames.length;
  const avgHue = frames.reduce((a,b)=>a+b.hue,0)/frames.length;

  // Flash cuts
  const flashF = frames.filter(f=>f.brightness>avgB+50).length;
  const hasFlashCuts = flashF > frames.length*0.015;

  // Black flash
  const blackF = frames.filter(f=>f.brightness<30).length;
  const hasBlackFlash = blackF > frames.length*0.01;

  // Zoom punch
  let zoomC=0;
  for(let i=2;i<frames.length;i++){if(frames[i].brightness-frames[i-2].brightness>15&&frames[i].motion>avgM*1.8)zoomC++;}
  const hasZoomPunches = zoomC>frames.length*0.03;

  // Zoom out
  let zoomOC=0;
  for(let i=2;i<frames.length;i++){if(frames[i-2].brightness-frames[i].brightness>15&&frames[i].motion>avgM*1.8)zoomOC++;}
  const hasZoomOut = zoomOC>frames.length*0.03;

  // Shake
  let shakeC=0;
  for(let i=1;i<frames.length;i++){if(Math.abs(frames[i].motion-frames[i-1].motion)>avgM*2)shakeC++;}
  const hasShakeEffect = shakeC>frames.length*0.08;

  // Whip pan (very sudden high motion)
  let whipC=0;
  for(let i=1;i<frames.length;i++){if(frames[i].motion>avgM*4&&frames[i-1].motion<avgM)whipC++;}
  const hasWhipPan = whipC>2;

  // Reverse
  const motionVals=frames.map(f=>f.motion);
  const mStd=Math.sqrt(motionVals.reduce((a,b)=>a+(b-avgM)**2,0)/motionVals.length);
  const hasReverseClips = mStd>avgM*1.5&&scenes.length>3;

  // Speed ramp
  let sramC=0;
  for(let i=1;i<frames.length;i++){if(frames[i].motion-frames[i-1].motion>avgM*3)sramC++;}
  const hasSpeedRamps = sramC>frames.length*0.02;

  // Slow mo
  let slowS=0;
  for(let i=0;i<frames.length-5;i++){
    const sa=frames.slice(i,i+5).reduce((a,b)=>a+b.motion,0)/5;
    if(sa<avgM*0.2)slowS++;
  }
  const hasSlowMo = slowS>frames.length*0.05;

  // Strobe
  let strobeC=0;
  for(let i=1;i<frames.length;i++){if(Math.abs(frames[i].brightness-frames[i-1].brightness)>60)strobeC++;}
  const hasStrobe = strobeC>frames.length*0.05;

  // Film grain
  let grainC=0;
  for(let i=2;i<frames.length;i++){const d=Math.abs(frames[i].brightness-frames[i-1].brightness);if(d>5&&d<15)grainC++;}
  const hasFilmGrain = grainC>frames.length*0.4;

  // Letterbox
  const hasLetterbox = avgB<80&&audio.energy==='low';

  // Color pop
  const hasColorPop = avgSat<25;

  // Glitch (very rapid alternation)
  let glitchC=0;
  for(let i=2;i<frames.length;i++){
    if(Math.abs(frames[i].brightness-frames[i-2].brightness)>70)glitchC++;
  }
  const hasGlitch = glitchC>frames.length*0.04;

  // Color grade
  const isWarm=avgHue<90||avgHue>270;
  const isCool=avgHue>160&&avgHue<260;
  let lutStyle='natural';
  if(avgB<70&&avgM>1.3)             lutStyle='dark-cinematic';
  else if(avgSat>65&&avgB>130)       lutStyle='vibrant';
  else if(avgSat<25)                 lutStyle='desaturated';
  else if(isWarm&&avgSat>50)         lutStyle='warm-golden';
  else if(isCool&&avgM>1.2)          lutStyle='cool-blue';
  else if(avgB>160)                  lutStyle='bright-airy';

  const brightness=parseFloat(((avgB-128)/128*0.3).toFixed(3));
  const contrast=parseFloat((1.0+(avgM/255)*0.6).toFixed(3));
  const saturation=parseFloat((0.7+(avgSat/50)*0.6).toFixed(3));

  const fx={
    hasFlashCuts,hasBlackFlash,hasZoomPunches,hasZoomOut,
    hasShakeEffect,hasWhipPan,hasReverseClips,hasSpeedRamps,
    hasSlowMo,hasStrobe,hasFilmGrain,hasLetterbox,
    hasColorPop,hasGlitch,
    colorGrade:{brightness,contrast,saturation,lutStyle}
  };

  const det=Object.entries(fx).filter(([k,v])=>k.startsWith('has')&&v===true).map(([k])=>k.replace('has',''));
  console.log(`[${jobId}] 🔍 Detected: ${det.join(', ')||'basic'} | LUT:${lutStyle}`);
  return fx;
}

function buildEffectsFromAudioOnly(audio) {
  const isHigh=audio.energy==='high';
  const isMed=audio.energy==='medium';
  return {
    hasFlashCuts:isHigh, hasBlackFlash:false,
    hasZoomPunches:isHigh, hasZoomOut:false,
    hasShakeEffect:isHigh, hasWhipPan:false,
    hasReverseClips:false, hasSpeedRamps:isMed||isHigh,
    hasSlowMo:!isHigh, hasStrobe:false,
    hasFilmGrain:false, hasLetterbox:!isHigh,
    hasColorPop:false, hasGlitch:false,
    colorGrade:{brightness:0,contrast:1.1,saturation:1.0,lutStyle:'natural'}
  };
}

// ── BUILD TIMELINE ────────────────────────────────────────────
function buildTimeline({frames,audio,scenes,effects,meta,jobId}) {
  const events=[];
  const duration=meta.duration||10;

  const avgB=frames.length?frames.reduce((a,b)=>a+b.brightness,0)/frames.length:128;

  for(const cut of scenes) {
    const nb=frames.filter(f=>Math.abs(f.time-cut.time)<0.15);
    const na=nb.length?nb.reduce((a,b)=>a+b.brightness,0)/nb.length:128;
    let ct=FX.HARD_CUT;
    if(na>avgB+40)ct=FX.FLASH_CUT;
    if(na<40)ct=FX.BLACK_FLASH;
    events.push({type:ct,time:cut.time,duration:0.05,intensity:1.0});
  }

  for(const beat of (audio.beats||[])) {
    events.push({type:beat.isBass?FX.BASS_DROP:FX.BEAT_HIT,time:beat.time,duration:0.05,intensity:Math.min(1.0,beat.strength/15),isBass:beat.isBass});
  }

  events.push({type:FX.FADE_IN,time:0,duration:0.25,intensity:1.0});
  events.push({type:FX.FADE_OUT,time:duration-0.3,duration:0.3,intensity:1.0});
  events.sort((a,b)=>a.time-b.time);

  const cutTimes=[0,...scenes.map(s=>s.time),duration].sort((a,b)=>a-b);
  const sceneSegments=[];
  for(let i=0;i<cutTimes.length-1;i++){
    const s=cutTimes[i],e=cutTimes[i+1],d=e-s;
    if(d>=0.3)sceneSegments.push({index:i,start:s,end:e,duration:parseFloat(d.toFixed(3))});
  }

  const avgCut=sceneSegments.length>1?sceneSegments.reduce((a,b)=>a+b.duration,0)/sceneSegments.length:2.0;

  return {
    duration,events,sceneSegments,
    avgCutDuration:parseFloat(avgCut.toFixed(3)),
    totalScenes:sceneSegments.length,
    totalBeats:(audio.beats||[]).length,
    bpm:audio.bpm||120,
    audioEnergy:audio.energy||'medium',
    effects,
    colorGrade:effects.colorGrade,
    meta:{width:meta.width||1080,height:meta.height||1920,fps:meta.fps||30}
  };
}

// ── EXECUTE BLUEPRINT ─────────────────────────────────────────
async function executeBlueprint({blueprint,clips,format,outputPath,addWatermark,jobId,onProgress}) {
  const tempDir=`./temp/${jobId}_bp`;
  fs.ensureDirSync(tempDir);

  const FORMATS={'9:16':{w:1080,h:1920},'1:1':{w:1080,h:1080},'16:9':{w:1920,h:1080},'source':{w:blueprint.meta.width,h:blueprint.meta.height}};
  const fmt=FORMATS[format]||FORMATS['9:16'];
  const {effects,colorGrade}=blueprint;

  try {
    const clipInfos=[];
    for(const clip of clips){
      try{const i=await getClipInfo(clip);clipInfos.push({path:clip,...i});}
      catch{clipInfos.push({path:clip,duration:10});}
    }
    await onProgress(20);

    const scenes=blueprint.sceneSegments;
    const segPaths=[];

    for(let i=0;i<scenes.length;i++){
      const scene=scenes[i];
      const ci=clipInfos[i%clipInfos.length];
      const cd=ci.duration;
      const maxS=Math.max(0,cd-scene.duration-0.5);
      const cs=Math.min(maxS,cd*0.05+(i/scenes.length)*cd*0.8);
      const rd=Math.min(scene.duration,cd-cs);
      if(rd<0.3)continue;

      const sceneEvents=blueprint.events.filter(e=>e.time>=scene.start&&e.time<scene.end);
      const shouldReverse=effects.hasReverseClips&&i%5===2;
      const segOut=path.join(tempDir,`seg_${String(i).padStart(4,'0')}.mp4`);

      try {
        if(shouldReverse){
          await renderReversed({inputPath:ci.path,start:cs,duration:rd,colorGrade,effects,fmt,outputPath:segOut,sceneIndex:i});
        } else {
          await renderScene({inputPath:ci.path,start:cs,duration:rd,sceneDuration:scene.duration,sceneEvents,blueprint,fmt,outputPath:segOut,sceneIndex:i,totalScenes:scenes.length});
        }
        segPaths.push(segOut);
      } catch(e){console.warn(`[${jobId}] Scene ${i} failed: ${e.message}`);}

      await onProgress(20+Math.floor((i/scenes.length)*65));
    }

    if(!segPaths.length)throw new Error('No scenes rendered');
    await onProgress(87);

    const concatPath=path.join(tempDir,'concat.mp4');
    await concatAll(segPaths,concatPath);
    await onProgress(93);

    if(addWatermark){
      const wmPath=path.join(tempDir,'watermarked.mp4');
      await applyWatermark(concatPath,wmPath,fmt);
      await fs.move(wmPath,outputPath,{overwrite:true});
    } else {
      await fs.move(concatPath,outputPath,{overwrite:true});
    }

    await onProgress(100);
    console.log(`[${jobId}] ✅ Blueprint executed!`);
  } finally {
    fs.remove(tempDir).catch(()=>{});
  }
}

// ── RENDER SCENE ──────────────────────────────────────────────
function renderScene({inputPath,start,duration,sceneDuration,sceneEvents,blueprint,fmt,outputPath,sceneIndex,totalScenes}) {
  return new Promise((resolve,reject)=>{
    const {effects,colorGrade}=blueprint;
    const vf=[], af=[];

    // Scale + crop
    vf.push(`scale=${fmt.w}:${fmt.h}:force_original_aspect_ratio=increase`);
    vf.push(`crop=${fmt.w}:${fmt.h}`);

    // Speed
    let speed=1.0;
    if(sceneEvents.some(e=>e.type===FX.SPEED_RAMP)||(effects.hasSpeedRamps&&sceneIndex%4===0))speed=1.2;
    if(sceneEvents.some(e=>e.type===FX.SLOW_MO)||(effects.hasSlowMo&&sceneIndex%5===1))speed=0.5;
    vf.push(`setpts=${(1/speed).toFixed(4)}*PTS`);
    af.push(`atempo=${Math.min(Math.max(speed,0.5),2.0).toFixed(4)}`);

    // Color grade
    vf.push(`eq=brightness=${colorGrade.brightness}:contrast=${colorGrade.contrast}:saturation=${colorGrade.saturation}`);

    // LUT
    const lut=getLUTFilter(colorGrade.lutStyle);
    if(lut)vf.push(lut);

    // Film grain
    if(effects.hasFilmGrain)vf.push(`noise=c0s=8:c0f=t`);

    // Letterbox
    if(effects.hasLetterbox){
      const bh=Math.round(fmt.h*0.08);
      vf.push(`drawbox=x=0:y=0:w=${fmt.w}:h=${bh}:color=black:t=fill`);
      vf.push(`drawbox=x=0:y=${fmt.h-bh}:w=${fmt.w}:h=${bh}:color=black:t=fill`);
    }

    // Zoom punch
    if(sceneEvents.some(e=>e.type===FX.ZOOM_IN)||(effects.hasZoomPunches&&sceneIndex%3===0)){
      const fd=sceneDuration/speed;
      vf.push(`zoompan=z='if(lte(on,${Math.ceil(0.2*30)}),1.08,1.0)':d=${Math.ceil(fd*30)}:s=${fmt.w}x${fmt.h}`);
    }

    // Zoom out
    if(effects.hasZoomOut&&sceneIndex%4===2){
      const fd=sceneDuration/speed;
      vf.push(`zoompan=z='if(lte(on,${Math.ceil(0.2*30)}),0.94,1.0)':d=${Math.ceil(fd*30)}:s=${fmt.w}x${fmt.h}`);
    }

    // Shake
    if(sceneEvents.some(e=>e.type===FX.SHAKE)||(effects.hasShakeEffect&&sceneIndex%3===1)){
      const ox=sceneIndex%2===0?10:0, oy=sceneIndex%3===0?10:0;
      vf.push(`crop=iw-20:ih-20:${ox}:${oy}`);
      vf.push(`scale=${fmt.w}:${fmt.h}`);
    }

    // Whip pan blur
    if(effects.hasWhipPan&&sceneIndex%5===0){
      vf.push(`boxblur=luma_radius=3:luma_power=1`);
    }

    // Glitch
    if(effects.hasGlitch&&sceneIndex%6===0){
      vf.push(`rgbashift=rh=3:bh=-3`);
    }

    // Strobe
    if(effects.hasStrobe&&sceneIndex%8===0){
      vf.push(`curves=all='0/0 0.5/0.85 1/1'`);
    }

    // Color pop (near grayscale)
    if(effects.hasColorPop){
      vf.push(`hue=s=0.15`);
    }

    // Fades
    const fd=sceneDuration/speed;
    const fi=Math.min(0.12,fd*0.1);
    const fo=Math.min(0.12,fd*0.1);
    vf.push(`fade=t=in:st=0:d=${fi}`);
    vf.push(`fade=t=out:st=${Math.max(0,fd-fo).toFixed(3)}:d=${fo}`);
    af.push(`afade=t=in:st=0:d=${fi}`);
    af.push(`afade=t=out:st=${Math.max(0,fd-fo).toFixed(3)}:d=${fo}`);

    // Flash cut
    if((sceneEvents.some(e=>e.type===FX.FLASH_CUT)||(effects.hasFlashCuts&&sceneIndex%2===0))&&sceneIndex>0)
      vf.push(`fade=t=in:st=0:d=0.04:color=white`);

    // Black flash
    if((sceneEvents.some(e=>e.type===FX.BLACK_FLASH)||(effects.hasBlackFlash&&sceneIndex%3===2))&&sceneIndex>0)
      vf.push(`fade=t=in:st=0:d=0.04:color=black`);

    ffmpeg(inputPath)
      .inputOptions([`-ss ${start.toFixed(3)}`,`-t ${duration.toFixed(3)}`])
      .videoFilter(vf.join(','))
      .audioFilter(af.join(','))
      .outputOptions(['-c:v','libx264','-preset','fast','-crf','22','-c:a','aac','-ar','44100','-b:a','128k','-movflags','+faststart','-pix_fmt','yuv420p','-avoid_negative_ts','make_zero'])
      .output(outputPath)
      .on('end',resolve).on('error',reject).run();
  });
}

// ── RENDER REVERSED ───────────────────────────────────────────
function renderReversed({inputPath,start,duration,colorGrade,effects,fmt,outputPath,sceneIndex}) {
  return new Promise((resolve,reject)=>{
    const vf=[
      `scale=${fmt.w}:${fmt.h}:force_original_aspect_ratio=increase`,
      `crop=${fmt.w}:${fmt.h}`,
      `reverse`,
      `eq=brightness=${colorGrade.brightness}:contrast=${colorGrade.contrast}:saturation=${colorGrade.saturation}`,
    ];
    const lut=getLUTFilter(colorGrade.lutStyle);
    if(lut)vf.push(lut);
    if(effects.hasFilmGrain)vf.push(`noise=c0s=8:c0f=t`);
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
async function getVideoMeta(videoPath) {
  return new Promise((resolve,reject)=>{
    ffmpeg.ffprobe(videoPath,(err,meta)=>{
      if(err)return reject(err);
      const vs=meta.streams.find(s=>s.codec_type==='video');
      resolve({duration:meta.format.duration||10,width:vs?.width||1080,height:vs?.height||1920,fps:eval(vs?.r_frame_rate||'30/1')});
    });
  });
}

async function getClipInfo(clipPath) {
  return new Promise((resolve,reject)=>{
    ffmpeg.ffprobe(clipPath,(err,meta)=>{
      if(err)return reject(err);
      resolve({duration:meta.format.duration||10,hasAudio:meta.streams.some(s=>s.codec_type==='audio')});
    });
  });
}

async function concatAll(segs,out) {
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

async function applyWatermark(inputPath,outputPath,fmt) {
  return new Promise((resolve,reject)=>{
    const fs2=fmt?Math.round(fmt.w*0.022):22;
    ffmpeg(inputPath)
    .videoFilter([`drawtext=text='POWERED BY MAYOR TECH INC':fontsize=${fs2}:fontcolor=white@0.55:x=w-text_w-20:y=h-text_h-20:shadowcolor=black@0.4:shadowx=1:shadowy=1:box=1:boxcolor=black@0.2:boxborderw=6`])
    .outputOptions(['-c:v','libx264','-preset','fast','-crf','22','-c:a','copy','-movflags','+faststart'])
    .output(outputPath)
    .on('end',resolve).on('error',reject).run();
  });
}

module.exports = { createBlueprint, executeBlueprint };
