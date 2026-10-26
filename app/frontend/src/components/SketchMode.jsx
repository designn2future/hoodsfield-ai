import React, { useEffect, useRef, useState } from 'react';

/**
 * SketchMode — 2D drawing surface (pencil / pen / eraser, undo, clear).
 * Stays mounted (hidden) when inactive so the drawing survives tab switches.
 * Exposes apiRef.current.getBlob() for the generate flow.
 */
const W = 1024, H = 768;
const MAX_UNDO = 15;

export default function SketchMode({ active, apiRef, onSaveSketch, onStrokeEnd }) {
  const canvasRef = useRef(null);
  const [tool, setTool] = useState('pen');
  const [size, setSize] = useState(6);
  const [color, setColor] = useState('#000000');
  const undoStack = useRef([]);
  const drawing = useRef(false);
  const last = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    ctx.lineCap = ctx.lineJoin = 'round';

    if (apiRef) {
      apiRef.current = {
        getBlob: () => new Promise((res) => canvas.toBlob(res, 'image/png')),
        /** Load an existing sketch (or any image) back onto the canvas. */
        loadBlob: async (blob) => {
          const url = URL.createObjectURL(blob);
          try {
            const img = await new Promise((res, rej) => {
              const i = new Image();
              i.onload = () => res(i);
              i.onerror = rej;
              i.src = url;
            });
            undoStack.current.push(ctx.getImageData(0, 0, W, H));
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, W, H);
            const s = Math.min(W / img.width, H / img.height);
            const w = img.width * s, h = img.height * s;
            ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
          } finally {
            URL.revokeObjectURL(url);
          }
        },
      };
    }
  }, [apiRef]);

  const toolStyle = (t, s, c) =>
    t === 'pencil'
      ? { stroke: c, width: 2, alpha: 0.85 }
      : t === 'eraser'
        ? { stroke: '#ffffff', width: s * 3, alpha: 1 }
        : { stroke: c, width: s, alpha: 1 };

  const pos = (e) => {
    const r = canvasRef.current.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * W,
      y: ((e.clientY - r.top) / r.height) * H,
    };
  };

  const pushUndo = () => {
    const ctx = canvasRef.current.getContext('2d');
    undoStack.current.push(ctx.getImageData(0, 0, W, H));
    if (undoStack.current.length > MAX_UNDO) undoStack.current.shift();
  };

  const onDown = (e) => {
    e.preventDefault();
    canvasRef.current.setPointerCapture(e.pointerId);
    pushUndo();
    drawing.current = true;
    last.current = pos(e);
    drawTo(pos(e)); // dot on click
  };

  const drawTo = (p) => {
    const ctx = canvasRef.current.getContext('2d');
    const { stroke, width, alpha } = toolStyle(tool, size, color);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = width;
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.moveTo(last.current.x, last.current.y);
    // midpoint smoothing
    const mx = (last.current.x + p.x) / 2, my = (last.current.y + p.y) / 2;
    ctx.quadraticCurveTo(last.current.x, last.current.y, mx, my);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    ctx.globalAlpha = 1;
    last.current = p;
  };

  const onMove = (e) => {
    if (!drawing.current) return;
    e.preventDefault();
    drawTo(pos(e));
  };

  const onUp = () => {
    if (!drawing.current) return;
    drawing.current = false;
    onStrokeEnd?.();
  };

  const undo = () => {
    const img = undoStack.current.pop();
    if (img) canvasRef.current.getContext('2d').putImageData(img, 0, 0);
  };

  const clear = () => {
    pushUndo();
    const ctx = canvasRef.current.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
  };

  const hidden = active ? {} : { display: 'none' };

  return (
    <>
      <div className="sketch-wrap" style={hidden}>
        <canvas
          ref={canvasRef} width={W} height={H} className="sketch-canvas"
          onPointerDown={onDown} onPointerMove={onMove}
          onPointerUp={onUp} onPointerLeave={onUp}
        />
      </div>
      <div className="sketch-tools" style={hidden}>
        {[['pencil', '✏️ Pencil'], ['pen', '🖊 Pen'], ['eraser', '⬜ Eraser']].map(([t, label]) => (
          <button key={t} className={tool === t ? 'active' : ''} onClick={() => setTool(t)}>
            {label}
          </button>
        ))}
        <input type="color" value={color} disabled={tool === 'eraser'}
          title="Rough in color blocks (skin, sky, ground) instead of just black lines — gives img2img real chromatic material to refine into a photo, instead of only high-contrast linework it tends to preserve as-is."
          onChange={(e) => setColor(e.target.value)} />
        <span className="size-label">Size</span>
        <input className="size" type="range" min={2} max={40} value={size}
          onChange={(e) => setSize(+e.target.value)} />
        <span className="size-label">{size}px</span>
        <div className="spacer" />
        <button onClick={async () => onSaveSketch?.(await new Promise((res) => canvasRef.current.toBlob(res, 'image/png')))}
          title="Add the current drawing to the gallery">★ To gallery</button>
        <button onClick={undo}>↩ Undo</button>
        <button className="danger" onClick={clear}>Clear</button>
      </div>
    </>
  );
}
