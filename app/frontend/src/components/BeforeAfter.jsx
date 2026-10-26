import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSameCamera } from '../cameraMatch.js';

/** Before/after slider: drag (or use ←/→) to reveal more or less of the original over the edited image. */
export default function BeforeAfter({ before, after, beforeLabel = 'Before', afterLabel = 'After', className = '', onZoom }) {
  const [pos, setPos] = useState(50);              // % of the width showing "before"
  const box = useRef(null);
  const dragging = useRef(false);
  const [broken, setBroken] = useState(false);   // the original could not be loaded: show the edit alone rather than a slider with nothing behind it
  useEffect(() => setBroken(false), [before, after]);

  const setFrom = useCallback((clientX) => {
    const r = box.current?.getBoundingClientRect();
    if (!r || !r.width) return;
    setPos(Math.max(0, Math.min(100, ((clientX - r.left) / r.width) * 100)));
  }, []);

  useEffect(() => {
    const move = (e) => {
      const d = dragging.current;
      if (!d) return;
      if (d.touch && !d.on) { if (Math.abs(e.clientX - d.x) < 8) return; d.on = true; }   // a finger must move sideways first, so up/down still scrolls the page
      setFrom(e.clientX);
    };
    const up = () => { dragging.current = false; };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); };
  }, [setFrom]);

  if (broken) return <img className="ba-img" src={after} alt={afterLabel} />;
  return (
    <div className={`ba ${className}`} ref={box} tabIndex={0}
      onPointerDown={(e) => { const touch = e.pointerType === 'touch'; dragging.current = { touch, on: !touch, x: e.clientX }; if (!touch) setFrom(e.clientX); }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') setPos((p) => Math.max(0, p - 4));
        else if (e.key === 'ArrowRight') setPos((p) => Math.min(100, p + 4));
      }}
      onDoubleClick={() => onZoom?.()}>
      <img className="ba-img" src={after} alt={afterLabel} draggable={false} />
      <img className="ba-img ba-top" src={before} alt={beforeLabel} draggable={false} onError={() => setBroken(true)} style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }} />
      <span className="ba-tag ba-l" style={{ opacity: pos > 12 ? 1 : 0 }}>{beforeLabel}</span>
      <span className="ba-tag ba-r" style={{ opacity: pos < 88 ? 1 : 0 }}>{afterLabel}</span>
      <div className="ba-line" style={{ left: `${pos}%` }}><i>↔</i></div>
    </div>
  );
}

/** The slider only when the camera stayed put (a changed character or outfit is fine); otherwise `children` (the plain picture). */
export function CompareIfSame({ before, after, children, ...rest }) {
  const same = useSameCamera(before, after);
  return same ? <BeforeAfter before={before} after={after} {...rest} /> : children;
}
