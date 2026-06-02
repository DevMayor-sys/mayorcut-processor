// ============================================================
// Mayor Cut — Quality Engine
// Mayor Tech Inc © 2026
//
// Scores generated edits before export.
// Regenerates timeline if quality is below threshold.
//
// Scores:
//   - Beat sync accuracy
//   - Pacing accuracy  
//   - Energy curve match
//   - Transition quality
//   - Visual clarity
//
// Target: user posts without opening CapCut.
// ============================================================

// ── SCORE A GENERATED TIMELINE ───────────────────────────────
function scoreTimeline(generatedSegments, blueprint, beats) {
  const scores = {};

  // 1. Beat Sync Score
  // What % of cuts land within 0.1s of a beat
  scores.beatSync = scoreBeatSync(generatedSegments, beats);

  // 2. Pacing Score
  // How close is generated cut density to reference
  scores.pacing = scorePacing(generatedSegments, blueprint);

  // 3. Energy Curve Score
  // Does energy progression match reference
  scores.energy = scoreEnergyCurve(generatedSegments, blueprint);

  // 4. Transition Quality Score
  // Are effects applied intentionally, not spammed
  scores.transitions = scoreTransitions(generatedSegments, blueprint);

  // 5. Visual Clarity Score
  // Penalize effect overuse
  scores.clarity = scoreClarity(generatedSegments);

  // Weighted overall score
  scores.overall = Math.round(
    scores.beatSync    * 0.30 +
    scores.pacing      * 0.25 +
    scores.energy      * 0.20 +
    scores.transitions * 0.15 +
    scores.clarity     * 0.10
  );

  return scores;
}

function scoreBeatSync(segments, beats) {
  if (!beats.length || !segments.length) return 50;

  let synced = 0;
  const cutTimes = segments.map(s => s.start);

  for (const cutTime of cutTimes) {
    const nearest = beats.reduce((a, b) =>
      Math.abs(b.time - cutTime) < Math.abs(a.time - cutTime) ? b : a
    );
    if (Math.abs(nearest.time - cutTime) <= 0.15) synced++;
  }

  return Math.round((synced / cutTimes.length) * 100);
}

function scorePacing(segments, blueprint) {
  const refAvgCut = blueprint.avgCutDuration || 2.0;
  const genAvgCut = segments.length > 1
    ? segments.reduce((a, b) => a + b.duration, 0) / segments.length
    : 2.0;

  const diff = Math.abs(refAvgCut - genAvgCut) / refAvgCut;
  return Math.round(Math.max(0, 100 - diff * 150));
}

function scoreEnergyCurve(segments, blueprint) {
  const refCurve = blueprint.energyCurve || [];
  if (!refCurve.length || !segments.length) return 60;

  // Divide generated segments into same number of sections as ref curve
  const sections = refCurve.length;
  const perSection = Math.ceil(segments.length / sections);
  let totalDiff = 0;

  for (let i = 0; i < sections; i++) {
    const start = i * perSection;
    const slice = segments.slice(start, start + perSection);
    if (!slice.length) continue;

    const genEnergy = slice.reduce((a, b) => a + (b.energyScore || 0.5), 0) / slice.length;
    const refEnergy = refCurve[i] || 0.5;
    totalDiff += Math.abs(genEnergy - refEnergy);
  }

  const avgDiff = totalDiff / sections;
  return Math.round(Math.max(0, 100 - avgDiff * 100));
}

function scoreTransitions(segments, blueprint) {
  const effects = blueprint.effects || {};
  let score = 80; // base score

  // Check effect density
  const effectCount = segments.filter(s => s.hasEffect).length;
  const effectDensity = effectCount / segments.length;

  // Ideal: 20-50% of segments have effects
  if (effectDensity > 0.7) score -= 30; // too many effects
  if (effectDensity < 0.1 && Object.values(effects).some(v => v === true)) score -= 20; // should have effects but doesn't

  // Check if high-energy moments have effects
  const highEnergyWithEffect = segments.filter(s => s.energyScore > 0.7 && s.hasEffect).length;
  const highEnergy = segments.filter(s => s.energyScore > 0.7).length;
  if (highEnergy > 0) {
    const ratio = highEnergyWithEffect / highEnergy;
    score += Math.round(ratio * 20); // bonus for matching effects to energy
  }

  return Math.min(100, Math.max(0, score));
}

function scoreClarity(segments) {
  let score = 100;

  // Penalize too many different effects in a row
  let consecEffects = 0;
  let maxConsec = 0;
  for (const seg of segments) {
    if (seg.hasEffect) { consecEffects++; maxConsec = Math.max(maxConsec, consecEffects); }
    else consecEffects = 0;
  }
  if (maxConsec > 4) score -= 20;
  if (maxConsec > 6) score -= 20;

  // Penalize very short segments (under 0.5s = too chaotic)
  const tooShort = segments.filter(s => s.duration < 0.5).length;
  if (tooShort > segments.length * 0.3) score -= 15;

  // Penalize very long segments mixed with very short (pacing inconsistency)
  const durations = segments.map(s => s.duration);
  const avgDur = durations.reduce((a, b) => a + b, 0) / durations.length;
  const variance = durations.reduce((a, b) => a + Math.pow(b - avgDur, 2), 0) / durations.length;
  const stdDev = Math.sqrt(variance);
  if (stdDev > avgDur * 1.5) score -= 10;

  return Math.max(0, score);
}

// ── IMPROVE TIMELINE ──────────────────────────────────────────
// Adjusts timeline to improve quality score
function improveTimeline(segments, blueprint, beats, clipInfos, attempt) {
  const improved = [...segments];

  // Pass 1: Snap cuts to nearest beats
  for (let i = 0; i < improved.length; i++) {
    const seg = improved[i];
    const nearest = beats.reduce((a, b) =>
      Math.abs(b.time - seg.clipStart) < Math.abs(a.time - seg.clipStart) ? b : a,
      { time: seg.clipStart, strength: 0 }
    );
    if (nearest && Math.abs(nearest.time - seg.clipStart) < 0.3) {
      const diff = nearest.time - seg.clipStart;
      improved[i] = { ...seg, clipStart: Math.max(0, seg.clipStart + diff * 0.5) };
    }
  }

  // Pass 2: Remove effect spam
  let consecutiveEffects = 0;
  for (let i = 0; i < improved.length; i++) {
    if (improved[i].hasEffect) {
      consecutiveEffects++;
      if (consecutiveEffects > 2) {
        improved[i] = { ...improved[i], hasEffect: false, effectType: null };
        consecutiveEffects = 0;
      }
    } else {
      consecutiveEffects = 0;
    }
  }

  // Pass 3: Ensure energy curve is preserved
  const refCurve = blueprint.energyCurve || [];
  if (refCurve.length && attempt > 0) {
    const sections = refCurve.length;
    const perSection = Math.ceil(improved.length / sections);

    for (let i = 0; i < sections; i++) {
      const refEnergy = refCurve[i] || 0.5;
      const start = i * perSection;
      const slice = improved.slice(start, start + perSection);

      for (let j = 0; j < slice.length; j++) {
        const seg = slice[j];
        // High energy section: prefer high-motion clip segments
        if (refEnergy > 0.7 && seg.energyScore < 0.4) {
          // Try to find a better clip segment
          const betterClip = findBestClipSegment(clipInfos, seg.duration, refEnergy);
          if (betterClip) {
            improved[start + j] = { ...seg, ...betterClip };
          }
        }
      }
    }
  }

  return improved;
}

function findBestClipSegment(clipInfos, duration, targetEnergy) {
  // Find a clip segment that matches the target energy level
  for (const clip of clipInfos) {
    if (clip.motionLevel === 'high' && targetEnergy > 0.6) {
      const start = clip.bestMoments?.[0] || clip.duration * 0.1;
      return { clipPath: clip.path, clipStart: start, clipDuration: Math.min(duration, clip.duration - start) };
    }
  }
  return null;
}

module.exports = { scoreTimeline, improveTimeline };
