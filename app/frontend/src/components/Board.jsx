import React, { useEffect, useRef } from 'react';
import SceneCard from './SceneCard.jsx';
import { resolveDisplayAsset } from '../utils.js';

/**
 * Board — infinite pan/zoom canvas (ComfyUI-style dot grid).
 * Scenes are free-floating cards; storyboard order = left-to-right position.
 */
const TAGS = { 'Empty scene': 'Blank', 'Music video': 'Beat-map', 'TikTok video': '9:16 vertical', 'Product ad': 'Commercial', 'Make an image': 'Flux 3 · ~5 s' };

export default function Board({
  view, setView, scenes, assets, h3Grid, sections,
  onDropAsset, onMoveScene, onUpdateScene, onGenerateScene, onGenerateStill, onDeleteScene, onCancelScene, onOpenDetail, onToTimeline, starts }) {
  const ref = useRef(null);

  // wheel zoom (native listener: React's onWheel is passive)
  useEffect(() => {
    const el = ref.current;
    const onWheel = (e) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
      setView((v) => {
        const k2 = Math.min(2.5, Math.max(0.15, v.k * Math.exp(-e.deltaY * 0.0012)));
        return { x: sx - ((sx - v.x) * k2) / v.k, y: sy - ((sy - v.y) * k2) / v.k, k: k2 };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [setView]);

  // pan on empty space
  const onPointerDown = (e) => {
    if (e.target.closest('.scene-card')) return;
    const start = { x: e.clientX, y: e.clientY };
    const v0 = { ...view };
    const move = (ev) =>
      setView({ ...v0, x: v0.x + ev.clientX - start.x, y: v0.y + ev.clientY - start.y });
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const toWorld = (clientX, clientY) => {
    const rect = ref.current.getBoundingClientRect();
    return {
      x: (clientX - rect.left - view.x) / view.k,
      y: (clientY - rect.top - view.y) / view.k,
    };
  };

  const onDrop = (e) => {
    e.preventDefault();
    const id = e.dataTransfer.getData('asset-id');
    if (!id) return;
    const p = toWorld(e.clientX, e.clientY);
    onDropAsset(id, p.x - 150, p.y - 100);
  };

  const order = [...scenes].sort((a, b) => a.x - b.x || a.y - b.y);
  const charName = (id) => {
    const c = assets.find((a) => a.id === id);
    return c ? (c.meta?.name || c.name) : null;
  };

  return (
    <div
      ref={ref}
      className="board"
      style={{
        backgroundSize: `${24 * view.k}px ${24 * view.k}px, ${120 * view.k}px ${120 * view.k}px`,
        backgroundPosition: `${view.x}px ${view.y}px, ${view.x}px ${view.y}px`,
      }}
      onPointerDown={onPointerDown}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      <div className="board-hud" onPointerDown={(e) => e.stopPropagation()}>
        <i /><span>Workspace // canvas</span>
        <small>Nodes {scenes.length} · X {Math.round(-view.x / view.k)} Y {Math.round(-view.y / view.k)} · Zoom {Math.round(view.k * 100)}%</small>
      </div>
      <div
        className="world"
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}
      >
        {scenes.map((s) => (
          <SceneCard
            key={s.id}
            scene={s}
            idx={order.indexOf(s)}
            asset={resolveDisplayAsset(assets.find((a) => a.id === s.assetId), assets)}
            videoAsset={assets.find((a) => a.id === s.videoAssetId)}
            castNames={(s.cast || []).map(charName).filter(Boolean)}
            sections={sections}
            h3Grid={h3Grid}
            k={view.k}
            onMove={onMoveScene}
            onUpdate={onUpdateScene}
            onGenerate={onGenerateScene}
            onGenerateStill={onGenerateStill}
            onDelete={onDeleteScene}
            onCancel={onCancelScene}
            onOpenDetail={onOpenDetail}
            onToTimeline={onToTimeline}
          />
        ))}
      </div>
      {!scenes.length && (
        <div className="board-empty">
          <div className="be-pill"><i />Synthetic media pipeline<em>Stage 0 ready</em></div>
          <div className="be-title">Your storyboard is empty</div>
          <div className="be-sub">Every scene card, still and clip lives on this infinite canvas. Start one of these, or drag Gallery images anywhere.</div>
          <div className="be-actions">
            {(starts || []).map((s) => (
              <button key={s.label} onClick={s.run} data-tag={TAGS[s.label] || 'START'}>
                <span className="be-ico">{s.icon}</span><b>{s.label}</b><small>{s.sub}</small><em>{TAGS[s.label] || 'START'} →</em>
              </button>
            ))}
          </div>
          <div className="be-tip">Tip: drop media from the Gallery below, or use <kbd>Space</kbd> to pan, scroll to zoom.</div>
        </div>
      )}
    </div>
  );
}
