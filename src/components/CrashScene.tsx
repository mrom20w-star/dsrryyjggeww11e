import { useEffect, useLayoutEffect, useRef } from 'react';
import { MOUNTAIN_BG_URI, PLANE_SPRITE_URI } from '../data/crashAssets';
import { EXPLOSION_FPS, EXPLOSION_FRAMES } from '../data/explosionAssets';
import {
  MAXBET_WAITING_SEC,
  multiplierAtFlightSec,
} from '../services/maxbetLive';
import { BetNoticeToast, GamePhase, SceneResultBanner } from '../types/crash';

interface CrashSceneProps {
  phase: GamePhase;
  countdownSeconds: number;
  waitStartTime: number;
  flightStartTime: number;
  crashStartTime: number;
  crashedMultiplier: number;
  flightCrashedSec: number;
  flightGrowthK: number;
  resultBanner: SceneResultBanner | null;
  betNotice?: BetNoticeToast | null;
  isFirebaseClosed?: boolean;
}

// Exact dial & chart geometry from MaxBet reference (viewBox 0 0 1000 356)
const START_X = 40;
const BASELINE_Y = 289.5;
const DIAL_CX = 911;
const DIAL_CY = 241;
const TICK_R_INNER = 168;
const TICK_R_OUTER = 195;
const TICK_ANGLES_DEG = [189, 169, 149, 130, 110, 90, 70] as const;

function dialPoint(deg: number, radius: number) {
  const rad = (deg * Math.PI) / 180;
  return {
    x: DIAL_CX + Math.cos(rad) * radius,
    y: DIAL_CY - Math.sin(rad) * radius,
  };
}

function lerpTickDeg(idx: number): number {
  const first = TICK_ANGLES_DEG[0] ?? 189;
  const second = TICK_ANGLES_DEG[1] ?? 160;
  if (idx < 0) {
    return first + (first - second) * -idx;
  }
  const floorIdx = Math.min(TICK_ANGLES_DEG.length - 1, Math.floor(idx));
  const frac = idx - floorIdx;
  const base = TICK_ANGLES_DEG[floorIdx] ?? 70;
  const next = TICK_ANGLES_DEG[floorIdx + 1] ?? base;
  return base + (next - base) * frac;
}

const DOT_POS = dialPoint(188, 137);
const DOT_RADIUS = 14.5;
const MOUNTAIN_BG_STYLE = { backgroundImage: `url("${MOUNTAIN_BG_URI}")` };

function getTrajectoryGeometry(phase: GamePhase, elapsedSec: number) {
  if (phase === 'waiting') {
    return {
      pathD: `M ${START_X} ${BASELINE_Y} C ${START_X} ${BASELINE_Y} ${START_X} ${BASELINE_Y} ${START_X} ${BASELINE_Y}`,
      tipX: START_X,
      tipY: BASELINE_Y,
      angleDeg: 0,
    };
  }

  const t = Math.max(0, elapsedSec);
  const dx = 665 * (1 - Math.exp(-t / 3.8));
  const dy = 170 * Math.pow(1 - Math.exp(-t / 3.2), 1.35);

  const tipX = START_X + dx;
  const tipY = BASELINE_Y - dy;
  const c1x = START_X + dx * 0.44;
  const c1y = BASELINE_Y;
  const c2x = START_X + dx * 0.74;
  const c2y = BASELINE_Y - dy * 0.30;

  // Smooth monotonic upward takeoff pitch matching the video (~0deg -> -14.5deg)
  const angleDeg = -14.5 * (1 - Math.exp(-t / 1.8));

  return {
    pathD: `M ${START_X} ${BASELINE_Y} C ${c1x} ${c1y} ${c2x} ${c2y} ${tipX} ${tipY}`,
    tipX,
    tipY,
    angleDeg,
  };
}

function renderMultiplierChars(value: number) {
  const formatted = value.toFixed(2);
  return (
    <>
      {formatted.split('').map((ch, idx) =>
        ch === '.' ? (
          <span key={`dot-${idx}`}>.</span>
        ) : (
          <span key={`d-${idx}`} className="mult-digit">
            {ch}
          </span>
        )
      )}
      <span>x</span>
    </>
  );
}

function writeMultiplierDom(el: HTMLElement, value: number) {
  const str = `${value.toFixed(2)}x`;
  if (el.childNodes.length !== str.length) {
    const frag = document.createDocumentFragment();
    for (let i = 0; i < str.length; i++) {
      const span = document.createElement('span');
      const ch = str[i];
      if (ch !== '.' && ch !== 'x') {
        span.className = 'mult-digit';
      }
      span.textContent = ch;
      frag.appendChild(span);
    }
    el.replaceChildren(frag);
    return;
  }

  for (let i = 0; i < str.length; i++) {
    const node = el.childNodes[i] as HTMLElement;
    const ch = str[i];
    if (node.textContent !== ch) {
      node.textContent = ch;
    }
    const wantsDigitClass = ch !== '.' && ch !== 'x';
    const hasDigitClass = node.className === 'mult-digit';
    if (wantsDigitClass !== hasDigitClass) {
      node.className = wantsDigitClass ? 'mult-digit' : '';
    }
  }
}

export function CrashScene({
  phase,
  countdownSeconds,
  waitStartTime,
  flightStartTime,
  crashStartTime,
  crashedMultiplier,
  flightCrashedSec,
  flightGrowthK,
  resultBanner,
  betNotice = null,
  isFirebaseClosed = false,
}: CrashSceneProps) {
  const sceneRef = useRef<HTMLElement | null>(null);
  const pathRef = useRef<SVGPathElement | null>(null);
  const planeRef = useRef<HTMLImageElement | null>(null);
  const flightMultRef = useRef<HTMLElement | null>(null);
  const explosionRef = useRef<HTMLImageElement | null>(null);
  const tickRefs = useRef<(SVGLineElement | null)[]>([]);
  const sceneSizeRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 });

  // Preload all 18 explosion sprite frames once on mount
  useEffect(() => {
    EXPLOSION_FRAMES.forEach((src) => {
      const img = new Image();
      img.src = src;
    });
  }, []);

  // Track exact rendered pixel dimensions of .crash-scene for GPU translate3d
  useLayoutEffect(() => {
    const el = sceneRef.current;
    if (!el) return;

    const updateSize = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        sceneSizeRef.current = { w: rect.width, h: rect.height };
      }
    };

    updateSize();
    if (typeof ResizeObserver === 'undefined') return;

    const ro = new ResizeObserver(() => {
      updateSize();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Smooth 60/120fps cubic-eased radial tick sweep during waiting countdown
  useLayoutEffect(() => {
    if (isFirebaseClosed || phase !== 'waiting') return;

    let rafId = 0;
    const renderWaitFrame = (now: number) => {
      const rawElapsed = Math.max(0, (now - waitStartTime) / 1000);
      const clampedElapsed = Math.min(MAXBET_WAITING_SEC - 0.001, rawElapsed);
      const sec = Math.max(1, MAXBET_WAITING_SEC - Math.floor(clampedElapsed));
      const frac = clampedElapsed - Math.floor(clampedElapsed);

      const isTransition = sec < TICK_ANGLES_DEG.length;
      const p = isTransition ? Math.min(1, frac / 0.55) : 1;
      const eased = p < 0.5 ? 4 * p ** 3 : 1 - ((-2 * p + 2) ** 3) / 2;
      const visibleCount = Math.min(
        TICK_ANGLES_DEG.length,
        isTransition ? sec + 1 : sec
      );

      for (let i = 0; i < TICK_ANGLES_DEG.length; i++) {
        const lineEl = tickRefs.current[i];
        if (!lineEl) continue;

        if (i >= visibleCount) {
          lineEl.style.display = 'none';
          continue;
        }

        const targetIdx = isTransition ? i - 1 : i;
        const deg = lerpTickDeg(i + (targetIdx - i) * eased);
        const p1 = dialPoint(deg, TICK_R_INNER);
        const p2 = dialPoint(deg, TICK_R_OUTER);
        const opacity = Math.max(p1.y, p2.y) >= BASELINE_Y ? 0 : 1;

        lineEl.style.display = '';
        lineEl.style.opacity = String(opacity);
        lineEl.setAttribute('x1', String(p1.x));
        lineEl.setAttribute('y1', String(p1.y));
        lineEl.setAttribute('x2', String(p2.x));
        lineEl.setAttribute('y2', String(p2.y));
        lineEl.className.baseVal =
          i === visibleCount - 1 ? 'countdown-mark is-current' : 'countdown-mark';
      }

      rafId = requestAnimationFrame(renderWaitFrame);
    };

    renderWaitFrame(performance.now());
    return () => cancelAnimationFrame(rafId);
  }, [isFirebaseClosed, phase, waitStartTime]);

  // Native 60/120fps direct GPU-composited DOM/SVG updates during flight
  useLayoutEffect(() => {
    if (isFirebaseClosed || phase !== 'flight') return;
    void flightGrowthK;

    let rafId = 0;
    const renderFrame = (now: number) => {
      const sec = Math.max(0, (now - flightStartTime) / 1000);
      const mult = Math.min(
        35,
        Math.floor(multiplierAtFlightSec(sec) * 100) / 100
      );
      const geom = getTrajectoryGeometry('flight', sec);

      if (pathRef.current) {
        pathRef.current.setAttribute('d', geom.pathD);
      }
      if (planeRef.current) {
        let { w, h } = sceneSizeRef.current;
        if ((w <= 0 || h <= 0) && sceneRef.current) {
          w = sceneRef.current.clientWidth;
          h = sceneRef.current.clientHeight;
          if (w > 0 && h > 0) sceneSizeRef.current = { w, h };
        }
        if (w > 0 && h > 0) {
          const pxX = (geom.tipX / 1000) * w;
          const pxY = (geom.tipY / 356) * h;
          planeRef.current.style.transform = `translate3d(${pxX.toFixed(2)}px, ${pxY.toFixed(2)}px, 0) translate(-14%, -80%) rotate(${geom.angleDeg.toFixed(3)}deg)`;
        }
      }
      if (flightMultRef.current) {
        writeMultiplierDom(flightMultRef.current, mult);
      }

      rafId = requestAnimationFrame(renderFrame);
    };

    renderFrame(performance.now());
    return () => cancelAnimationFrame(rafId);
  }, [isFirebaseClosed, phase, flightStartTime, flightGrowthK]);

  // Exact 14fps 18-frame explosion sequence during crashed phase
  useLayoutEffect(() => {
    const sceneEl = sceneRef.current;
    if (isFirebaseClosed) {
      if (sceneEl) {
        sceneEl.setAttribute('data-chart-lines', 'false');
      }
      return;
    }

    if (phase !== 'crashed') {
      if (sceneEl) {
        sceneEl.setAttribute(
          'data-chart-lines',
          phase === 'flight' ? 'true' : 'false'
        );
      }
      return;
    }

    let rafId = 0;
    let lastFrameIdx = -1;

    const renderCrashFrame = (now: number) => {
      const crashElapsed = Math.max(0, (now - crashStartTime) / 1000);
      const frameIdx = Math.floor(crashElapsed * EXPLOSION_FPS);
      const finished = frameIdx >= EXPLOSION_FRAMES.length;

      if (sceneEl) {
        sceneEl.setAttribute('data-chart-lines', finished ? 'false' : 'true');
      }

      const imgEl = explosionRef.current;
      if (finished) {
        if (imgEl) {
          imgEl.style.display = 'none';
        }
        return;
      }

      if (imgEl) {
        imgEl.style.display = 'block';
        if (frameIdx !== lastFrameIdx) {
          imgEl.src = EXPLOSION_FRAMES[frameIdx];
          lastFrameIdx = frameIdx;
        }
      }

      rafId = requestAnimationFrame(renderCrashFrame);
    };

    renderCrashFrame(performance.now());
    return () => cancelAnimationFrame(rafId);
  }, [isFirebaseClosed, phase, crashStartTime]);

  const crashedGeom = getTrajectoryGeometry(
    'crashed',
    phase === 'crashed' ? flightCrashedSec : 0
  );
  const leftPct = (crashedGeom.tipX / 1000) * 100;
  const topPct = (crashedGeom.tipY / 356) * 100;
  const effectivePhase = isFirebaseClosed ? 'waiting' : phase;

  return (
    <div className="scene-wrap">
      <section
        ref={sceneRef}
        className="crash-scene"
        data-phase={effectivePhase}
        data-chart-lines={!isFirebaseClosed && phase === 'flight' ? 'true' : 'false'}
        aria-label="جولة الطائرة"
      >
        <div className="mountains-clip" aria-hidden="true">
          <div className="mountains">
            <span style={MOUNTAIN_BG_STYLE} />
            <span className="is-mirrored" style={MOUNTAIN_BG_STYLE} />
            <span style={MOUNTAIN_BG_STYLE} />
            <span className="is-mirrored" style={MOUNTAIN_BG_STYLE} />
          </div>
        </div>

        <div className="chart-grid" />
        <svg
          className="chart-layer chart-guides-layer"
          viewBox="0 0 1000 356"
          aria-hidden="true"
        >
          {[66, 111, 156, 201, 246].map((yPos) => (
            <line
              key={yPos}
              x1={START_X}
              y1={yPos}
              x2={965}
              y2={yPos}
              className="chart-guide-line"
            />
          ))}
        </svg>
        <div className="chart-axis chart-axis-y">
          <i />
          <i />
          <i />
          <i />
          <i />
          <i />
        </div>
        <div className="chart-axis chart-axis-x">
          <i />
          <i />
          <i />
          <i />
          <i />
          <i />
        </div>

        {isFirebaseClosed ? (
          <div className="scene-closed-msg">
            تم إيقاف التوقعات — قاعدة البيانات مغلقة
          </div>
        ) : (
          <>
            {phase !== 'waiting' && (
              <>
                <svg
                  className="chart-layer trajectory-layer"
                  viewBox="0 0 1000 356"
                  aria-hidden="true"
                >
                  <defs>
                    <linearGradient
                      id="trajectory-gradient"
                      gradientUnits="userSpaceOnUse"
                      x1={START_X}
                      y1={BASELINE_Y}
                      x2={START_X + 700}
                      y2={BASELINE_Y - 236}
                    >
                      <stop offset="0" className="path-stop-start" />
                      <stop offset="0.55" className="path-stop-mid" />
                      <stop offset="1" className="path-stop-end" />
                    </linearGradient>
                  </defs>
                  <path
                    ref={pathRef}
                    className="trajectory-path"
                    d={phase === 'crashed' ? crashedGeom.pathD : undefined}
                    stroke="url(#trajectory-gradient)"
                  />
                  {phase === 'crashed' && (
                    <circle
                      className="trajectory-dot"
                      cx={crashedGeom.tipX}
                      cy={crashedGeom.tipY}
                      r={10}
                    />
                  )}
                </svg>

                {phase === 'flight' && (
                  <img
                    ref={planeRef}
                    className="plane"
                    alt="طائرة"
                    src={PLANE_SPRITE_URI}
                  />
                )}

                {phase === 'crashed' && (
                  <img
                    ref={explosionRef}
                    className="explosion"
                    src={EXPLOSION_FRAMES[0]}
                    alt=""
                    aria-hidden="true"
                    style={{ left: `${leftPct}%`, top: `${topPct}%` }}
                  />
                )}

                {phase === 'flight' && (
                  <strong
                    key="mult-flight"
                    ref={flightMultRef}
                    className="multiplier"
                  />
                )}

                {phase === 'crashed' && (
                  <strong key="mult-crashed" className="multiplier">
                    {renderMultiplierChars(crashedMultiplier)}
                  </strong>
                )}
              </>
            )}

            {phase === 'waiting' && (
              <div
                className="round-countdown"
                aria-label={`تبدأ الجولة خلال ${countdownSeconds} ثوانٍ`}
              >
                <svg
                  className="chart-layer countdown-layer"
                  viewBox="0 0 1000 356"
                  aria-hidden="true"
                >
                  <g>
                    {TICK_ANGLES_DEG.map((deg, idx) => {
                      const p1 = dialPoint(deg, TICK_R_INNER);
                      const p2 = dialPoint(deg, TICK_R_OUTER);
                      return (
                        <line
                          key={idx}
                          ref={(el) => {
                            tickRefs.current[idx] = el;
                          }}
                          x1={p1.x}
                          y1={p1.y}
                          x2={p2.x}
                          y2={p2.y}
                          className="countdown-mark"
                        />
                      );
                    })}
                    <circle
                      key={countdownSeconds}
                      className="countdown-dot"
                      cx={DOT_POS.x}
                      cy={DOT_POS.y}
                      r={DOT_RADIUS}
                    />
                  </g>
                </svg>
                <strong>{countdownSeconds}</strong>
              </div>
            )}

            {resultBanner && (
              <div
                key={resultBanner.id}
                className={`scene-result ${
                  resultBanner.type === 'win' ? 'is-win' : 'is-loss'
                }`}
              >
                {resultBanner.text}
              </div>
            )}

            {betNotice && (
              <div
                key={`notice-${betNotice.id}`}
                className={`bet-notice ${
                  betNotice.type === 'error' ? 'is-error' : ''
                }`}
              >
                {betNotice.text}
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
