import React, { useState, useMemo, useEffect, useLayoutEffect, useRef } from 'react';
import { createNoise2D } from 'simplex-noise';

// Create a new noise instance
const noise2D = createNoise2D();

const GRID_SIZE = 16; // 16x16 grid for a much faster, condensed "song" map (~1 min 15s)
const TOTAL_CELLS = GRID_SIZE * GRID_SIZE;
const NOISE_SCALE = 2.5; // High scale to aggressively break apart looping contiguous blobs

// Audio context
let audioCtx: AudioContext | null = null;
const initAudio = () => {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
};

const playNote = (noteStr: string, exactTime?: number) => {
  if (!audioCtx) return;
  const frequencies: Record<string, number> = {
    'C': 261.63,
    'D': 293.66,
    'E': 329.63,
    'F': 349.23,
    'G': 392.00,
    'A': 440.00
  };
  if (!frequencies[noteStr]) return;
  
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  
  // High fidelity scheduling utilizing Web Audio's CPU-independent internal clock
  const time = exactTime !== undefined ? exactTime : audioCtx.currentTime;
  const scheduleTime = Math.max(time, audioCtx.currentTime);

  osc.type = 'triangle';
  osc.frequency.setValueAtTime(frequencies[noteStr], scheduleTime);
  
  gain.gain.setValueAtTime(0.15, scheduleTime);
  gain.gain.exponentialRampToValueAtTime(0.001, scheduleTime + 0.2);
  
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  
  osc.start(scheduleTime);
  osc.stop(scheduleTime + 0.25);

  // Critical Memory Leak Fix: Explicitly sever Audio Nodes from Graph allowing immediate GC disposal reducing audio-thread latency polynomial buildup cleanly
  osc.onended = () => {
    osc.disconnect();
    gain.disconnect();
  };
};

// Extracted logic for noise sampling and quantization
function getRawNoiseData(x: number, y: number, zOffset: number) {
  const rawNoise = noise2D(x * NOISE_SCALE, (y + zOffset) * NOISE_SCALE);
  const normalized = Math.pow((rawNoise + 1) / 2, 1.2);
  
  // Heavily lowered the probability of 'S' so the track isn't completely empty!
  if (normalized <= 0.15) return { mappedIntensity: 0, rawText: 'S' };
  if (normalized <= 0.45) return { mappedIntensity: 0.25, rawText: 'C' };
  if (normalized <= 0.70) return { mappedIntensity: 0.51, rawText: 'E' };
  return { mappedIntensity: 1, rawText: 'G' };
}

// Reusable presentational component, 100% disconnected from React loop logic
const MapBoardMemo = React.memo(({ grid }: { grid: any[][] }) => {
  return (
    <div className="noise-board combined-board">
      {grid.map((row, y) => (
        <div key={`row-${y}`} className="noise-row">
          {row.map((cell: any, x: number) => {
            const index = y * GRID_SIZE + x;
            const isDark = cell.mappedIntensity < 0.5;
            let textColor = isDark ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.85)';
            let backgroundColor = `rgba(255, 255, 255, ${cell.mappedIntensity})`;
            
            if (cell.isMutated && cell.displayText !== 'SS') {
              const hue = 120 - (cell.mappedIntensity * 60); 
              const lightness = 15 + (cell.mappedIntensity * 40); 
              backgroundColor = `hsl(${hue}, 100%, ${lightness}%)`;
            }

            return (
              <div 
                id={`cell-${index}`}
                key={`cell-${x}-${y}`} 
                className="noise-cell"
                style={{ backgroundColor, color: textColor }}
                title={`Intensity: ${cell.mappedIntensity}`}
              >
                <span className="noise-value">{cell.displayText}</span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
});

// Separating the falling notes renderer entirely so keypresses don't force a virtual-DOM check on 256 children
const FallingNotes = React.memo(({ notes, isPlaying, startTimeRef }: any) => {
  const notesRef = useRef<(HTMLDivElement | null)[]>([]);

  // Sync refs array size dynamically
  useEffect(() => {
    notesRef.current = notesRef.current.slice(0, notes.length);
  }, [notes]);

  useLayoutEffect(() => {
    if (!isPlaying) return;
    let raf: number;
    const loop = (now: number) => {
      const rTime = now - startTimeRef.current;
      
      for (let i = 0; i < notes.length; i++) {
        const note = notes[i];
        const el = notesRef.current[i];
        if (!el) continue;

        const tDiff = note.tick * 300 - rTime;
        
        // Culling bounds optimizations natively bypassing rendering completely offscreen items drastically cutting composite usage!
        if (tDiff < -300 || tDiff > 3500) {
          if (el.style.display !== 'none') el.style.display = 'none';
        } else {
          if (el.style.display === 'none') el.style.display = 'block';
          const y = 400 - (tDiff * (400 / 1500));
          el.style.transform = `translateY(${y}px)`;
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying, notes, startTimeRef]);

  return (
    <>
      {notes.map((note: any, i: number) => {
        let colorClass = '';
        if (note.lane === 0) colorClass = 'note-s';
        if (note.lane === 1) colorClass = 'note-d';
        if (note.lane === 2) colorClass = 'note-f';

        return (
          <div 
            key={note.id} 
            ref={el => { notesRef.current[i] = el; }}
            className={`falling-note ${colorClass}`} 
            style={{ top: 0, left: `${note.lane * 33.33}%`, display: 'none' }} 
          />
        );
      })}
    </>
  );
});

// The wrapper for the static keybind GUI and lane styling encapsulating falling-notes natively
const GuitarHeroTrack = React.memo(({ grid, isPlaying, startTimeRef }: any) => {
  const notes = useMemo(() => {
    const arr: any[] = [];
    let tick = 0;
    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        const chars = grid[y][x].displayText;
        if (chars.includes('C') || chars.includes('D')) arr.push({ tick, lane: 0, id: `n-${tick}-0` });
        if (chars.includes('E') || chars.includes('F')) arr.push({ tick, lane: 1, id: `n-${tick}-1` });
        if (chars.includes('G') || chars.includes('A')) arr.push({ tick, lane: 2, id: `n-${tick}-2` });
        tick++;
      }
    }
    return arr;
  }, [grid]);

  // Keys state explicitly stripped out from React bounds to block ALL game stutters
  // We use vanilla JS class manipulation to push lane animations instantly to the GPU!
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.repeat) return; // STRICTLY block held key repeating events crushing OS event queues
      const k = e.key.toLowerCase();
      if (['s','d','f'].includes(k)) {
         document.getElementById(`target-${k}`)?.classList.add('pressed');
         document.getElementById(`lane-${k}`)?.classList.add('lane-pressed');
      }
    };
    const up = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (['s','d','f'].includes(k)) {
         document.getElementById(`target-${k}`)?.classList.remove('pressed');
         document.getElementById(`lane-${k}`)?.classList.remove('lane-pressed');
      }
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); }
  }, []);

  return (
    <div className="highway">
      <div className={`highway-bg ${isPlaying ? 'playing' : ''}`}></div>
      
      <div className="hit-line">
         <div className="target"><div id="target-s" className="target-key">S</div></div>
         <div className="target"><div id="target-d" className="target-key">D</div></div>
         <div className="target"><div id="target-f" className="target-key">F</div></div>
      </div>
      
      <div id="lane-s" className="lane s-lane" />
      <div id="lane-d" className="lane d-lane" />
      <div id="lane-f" className="lane f-lane" />

      <FallingNotes notes={notes} isPlaying={isPlaying} startTimeRef={startTimeRef} />
    </div>
  );
});

function App() {
  const [globalZ, setGlobalZ] = useState(0);

  // Playback state -> We strip EVERYTHING highly volatile OUT of React completely! 
  // No more score, hits, indices inside React state tracking causing 10,000s bounds tree rebuilds.
  const [isPlaying, setIsPlaying] = useState(false);
  const [hasFailed, setHasFailed] = useState(false);
  
  // High density game loop variables transitioned strictly natively into vanilla refs
  const scoreRef = useRef(0);
  const accuracyRef = useRef(100);
  const hitIndicesRef = useRef<Set<number>>(new Set());
  const hitCountRef = useRef(0);
  const resolvedTicksRef = useRef<Set<number>>(new Set());
  const consecutiveMissesRef = useRef(0);

  // Ref tracking time continuously
  const appStartTime = useRef(0);
  const trackAudioStartTimeRef = useRef(0);
  const playheadTick = useRef(-1);
  const scheduledTickRef = useRef(-1);

  const computeAccuracy = () => {
    const passed = resolvedTicksRef.current.size;
    const hits = hitCountRef.current;
    if (passed === 0) return 100;
    return (hits / passed) * 100;
  };

  const updateUIStats = () => {
    const scoreEl = document.getElementById('score-display');
    const accEl = document.getElementById('accuracy-display');
    const acc = accuracyRef.current;

    // Use textContent explicitly bypassing innerText expensive CSS layout reflow triggering
    if (scoreEl) scoreEl.textContent = `Score: ${scoreRef.current}`;
    if (accEl) {
      accEl.textContent = `Acc: ${acc.toFixed(1)}%`;
      accEl.style.color = acc < 50 ? '#ef4444' : '#10b981';
    }
  };

  const triggerRedPulse = () => {
    const el = document.getElementById('red-pulse-overlay');
    if (el) {
      // Direct Web Animations API payload purely pushing to the GPU avoiding layout ticks natively!
      el.animate([
        { opacity: 1 },
        { opacity: 0 }
      ], {
        duration: 400,
        easing: 'ease-out'
      });
    }
  };

  const resetAllNativeVisuals = () => {
    const cells = document.querySelectorAll('.noise-cell');
    cells.forEach(c => c.classList.remove('active-playhead', 'hit-cell', 'miss-cell'));
    const lanes = document.querySelectorAll('.lane');
    lanes.forEach(l => l.classList.remove('lane-pressed'));
    const targets = document.querySelectorAll('.target-key');
    targets.forEach(t => t.classList.remove('pressed'));
  };

  const generateNewNoise = () => {
    setGlobalZ(prev => prev + Math.random() * 50 + 10);
    setIsPlaying(false);
    setHasFailed(false);
    
    scoreRef.current = 0;
    accuracyRef.current = 100;
    hitIndicesRef.current.clear();
    hitCountRef.current = 0;
    resolvedTicksRef.current.clear();
    consecutiveMissesRef.current = 0;
    playheadTick.current = -1;
    scheduledTickRef.current = -1;
    
    resetAllNativeVisuals();
    setTimeout(updateUIStats, 0); // Give React DOM a cycle to attach the element handles
  };

  const togglePlay = () => {
    if (!isPlaying) {
      initAudio();
      setHasFailed(false);
      
      scoreRef.current = 0;
      accuracyRef.current = 100;
      hitIndicesRef.current.clear();
      hitCountRef.current = 0;
      resolvedTicksRef.current.clear();
      consecutiveMissesRef.current = 0;
      playheadTick.current = -1;
      scheduledTickRef.current = -1;
      
      resetAllNativeVisuals();
      setTimeout(updateUIStats, 0);

      // Add a generous 2.4-second delay (8 beats breathing room)
      appStartTime.current = performance.now() + 2400;
      trackAudioStartTimeRef.current = audioCtx!.currentTime + 2.4; 
    }
    setIsPlaying(!isPlaying);
  };

  const gridCombined = useMemo(() => {
    const dataCombined = [];
    let isAlt = false;

    // We scan spatially, exactly like reading a book (left-to-right, top-to-bottom)
    for (let y = 0; y < GRID_SIZE; y++) {
      const rowCombined = [];
      for (let x = 0; x < GRID_SIZE; x++) {
        const rawA = getRawNoiseData(x, y, globalZ);
        const rawB = getRawNoiseData(x, y, globalZ + 9999);
        
        let displayA = rawA.rawText;
        let displayB = rawB.rawText;

        // Apply current spatial state to determine display text
        if (isAlt) {
          if (displayA === 'C') displayA = 'D';
          else if (displayA === 'E') displayA = 'F';
          else if (displayA === 'G') displayA = 'A';

          if (displayB === 'C') displayB = 'D';
          else if (displayB === 'E') displayB = 'F';
          else if (displayB === 'G') displayB = 'A';
        }

        rowCombined.push({
          mappedIntensity: (rawA.mappedIntensity + rawB.mappedIntensity) / 2,
          displayText: `${displayA}${displayB}`,
          isMutated: isAlt
        });

        if (displayA === displayB && displayA !== 'S') {
          isAlt = !isAlt;
        }
      }
      dataCombined.push(rowCombined);
    }
    return dataCombined;
  }, [globalZ]);

  // Main game loop evaluating current discrete tick
  useLayoutEffect(() => {
    if (!isPlaying) return;
    
    let raf: number;
    const loop = (now: number) => {
      const elapsed = now - appStartTime.current;
      const currentTick = Math.floor(elapsed / 300);
      
      // 1) High Precision Audio Scheduling Sequence (100% constant BPM completely isolated from visual freezing)
      if (audioCtx) {
        const elapsedSec = (now - appStartTime.current) / 1000;
        const lookaheadTimeSeconds = 0.5; // Load audio 500ms cleanly into the WebAudio hardware buffer beforehand
        const targetScheduleTick = Math.min(
           TOTAL_CELLS - 1, 
           Math.floor((elapsedSec + lookaheadTimeSeconds) / 0.3)
        );

        for (let t = Math.max(0, scheduledTickRef.current + 1); t <= targetScheduleTick; t++) {
           const exactTime = trackAudioStartTimeRef.current + (t * 0.3);
           
           const cRow = Math.floor(t / GRID_SIZE);
           const cCol = t % GRID_SIZE;
           const tickCell = gridCombined[cRow][cCol];
           
           const charA = tickCell.displayText[0];
           const charB = tickCell.displayText[1];
           
           if (charA !== 'S') playNote(charA, exactTime);
           if (charB !== 'S' && charB !== charA) {
             playNote(charB, exactTime + 0.02); // staggered 20ms mathematically perfectly
           } else if (charB === charA && charB !== 'S') {
             playNote(charB, exactTime);
           }
           scheduledTickRef.current = t;
        }
      }

      // 2) Visual Playhead rendering mapping correctly executing skips
      if (currentTick > playheadTick.current && currentTick >= 0 && currentTick < TOTAL_CELLS) {
        
        // Dom native rendering of active playhead looping cleanly tracing over dropped hardware visual frames ensuring none skip
        for (let t = playheadTick.current + 1; t <= currentTick; t++) {
           const prevEl = document.getElementById(`cell-${t - 1}`);
           if (prevEl) prevEl.classList.remove('active-playhead');
           
           const nextEl = document.getElementById(`cell-${t}`);
           if (nextEl) nextEl.classList.add('active-playhead');
        }
        
        // Evaluate completely missed notes from the ticks that just fully passed the threshold window
        if (playheadTick.current >= 0) {
          let anyMissed = false;
          
          for (let tick = Math.max(0, playheadTick.current); tick < currentTick; tick++) {
            const row = Math.floor(tick / GRID_SIZE);
            const col = tick % GRID_SIZE;
            const cell = gridCombined[row][col];
            
            // Requires hitting if it possesses any character that is not purely 'S'
            const requiresAction = cell.displayText[0] !== 'S' || cell.displayText[1] !== 'S';
            
            // Check if we didn't log a keyboard hit for this tick
            if (requiresAction && !hitIndicesRef.current.has(tick)) {
              anyMissed = true;
              document.getElementById(`cell-${tick}`)?.classList.add('miss-cell');
              
              if (!resolvedTicksRef.current.has(tick)) {
                resolvedTicksRef.current.add(tick);
                consecutiveMissesRef.current += 1;
              }
            }
          }
          
          if (anyMissed) {
            triggerRedPulse(); // Visual miss splash natively pushed
            
            accuracyRef.current = computeAccuracy();
            updateUIStats();
            
            // Give 4 notes grace before failing under strictly 50%, or 10 rapid misses straight
            if ((resolvedTicksRef.current.size > 4 && accuracyRef.current < 50) || consecutiveMissesRef.current >= 10) {
              setHasFailed(true);
              setIsPlaying(false);
            }
          }
        }

        playheadTick.current = currentTick;
      } else if (currentTick >= TOTAL_CELLS) {
        setIsPlaying(false);
        return;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    
    return () => cancelAnimationFrame(raf);
  }, [isPlaying, gridCombined]);


  // Keyboard hit detection entirely uncoupled from DOM React renders!
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isPlaying || hasFailed || e.repeat) return; // Ensure repeat events don't trigger simultaneous redundant clicks!
      const key = e.key.toLowerCase();
      if (!['s', 'd', 'f'].includes(key)) return;

      const elapsed = performance.now() - appStartTime.current;
      const targetTick = Math.round(elapsed / 300);
      
      if (targetTick < 0 || targetTick >= TOTAL_CELLS) return;
      
      // EXTREMELY IMPORTANT: Block duplicate hits instantly! Double-tapping broke accuracy totally triggering immense unhandled UI updates
      if (resolvedTicksRef.current.has(targetTick)) return;

      const row = Math.floor(targetTick / GRID_SIZE);
      const col = targetTick % GRID_SIZE;
      const cell = gridCombined[row][col];
      
      const required = new Set();
      for (const char of cell.displayText) {
        if (char === 'C' || char === 'D') required.add('s');
        if (char === 'E' || char === 'F') required.add('d');
        if (char === 'G' || char === 'A') required.add('f');
      }

      if (required.has(key)) {
        scoreRef.current += 10;
        consecutiveMissesRef.current = 0; // Reset streak on valid hit
        
        hitIndicesRef.current.add(targetTick);
        document.getElementById(`cell-${targetTick}`)?.classList.add('hit-cell');
        
        if (!resolvedTicksRef.current.has(targetTick)) {
          resolvedTicksRef.current.add(targetTick);
          hitCountRef.current++;
        }
      } else {
        document.getElementById(`cell-${targetTick}`)?.classList.add('miss-cell');
        triggerRedPulse(); 
        
        if (!resolvedTicksRef.current.has(targetTick)) {
          resolvedTicksRef.current.add(targetTick);
          consecutiveMissesRef.current += 1;
        }
      }

      accuracyRef.current = computeAccuracy();
      updateUIStats();

      if ((resolvedTicksRef.current.size > 4 && accuracyRef.current < 50) || consecutiveMissesRef.current >= 10) {
        setHasFailed(true);
        setIsPlaying(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isPlaying, hasFailed, gridCombined]);

  return (
    <div className="app-container">
      {hasFailed && (
        <div className="fail-screen">
          <h1 className="fail-title">FAILED</h1>
          <p className="fail-score">Final Score: {scoreRef.current}</p>
          <p className="fail-acc">Accuracy: {accuracyRef.current.toFixed(1)}%</p>
          <button className="action-btn" onClick={generateNewNoise} style={{ marginTop: '2rem' }}>Play Again</button>
        </div>
      )}

      {/* Visual Punishment Miss Overlay */}
      {!hasFailed && <div id="red-pulse-overlay" className="red-pulse-overlay" style={{ opacity: 0 }} />}

      <div className="header">
        <h1 className="title">Perlin Noise Map</h1>
        <p className="subtitle">Rhythm Mini-Game: Hit the keys S, D, F to the melody!</p>
        <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center' }}>
          <button className="action-btn" onClick={generateNewNoise}>
            Generate New Noise
          </button>
          <button className="action-btn" onClick={togglePlay} style={{ background: isPlaying ? 'linear-gradient(135deg, #ef4444 0%, #b91c1c 100%)' : 'linear-gradient(135deg, #10b981 0%, #047857 100%)' }}>
            {isPlaying ? 'Stop' : 'Play'}
          </button>
        </div>
        
        {/* We keep the UI container dynamically bound through our native updater! */}
        <div style={{ display: 'inline-flex', gap: '2rem', justifyContent: 'center', marginTop: '1rem', opacity: isPlaying || scoreRef.current > 0 ? 1 : 0, transition: 'opacity 0.2s' }}>
          <h2 id="score-display" style={{ fontSize: '2rem', color: '#6366f1', margin: 0 }}>Score: {scoreRef.current}</h2>
          <h2 id="accuracy-display" style={{ fontSize: '2rem', color: accuracyRef.current < 50 ? '#ef4444' : '#10b981', margin: 0 }}>
            Acc: {accuracyRef.current.toFixed(1)}%
          </h2>
        </div>
      </div>

      <div className="maps-layout" style={{ flexWrap: 'nowrap', alignItems: 'flex-start', justifyContent: 'center' }}>
        <div style={{ flex: 1, maxWidth: '600px', display: 'flex', justifyContent: 'center' }}>
          <MapBoardMemo grid={gridCombined} />
        </div>
        <GuitarHeroTrack grid={gridCombined} isPlaying={isPlaying} startTimeRef={appStartTime} />
      </div>
    </div>
  );
}

export default App;
