import React, { useRef, useState } from 'react';
import BeforeAfter from './BeforeAfter.jsx';
import { useSameCamera } from '../cameraMatch.js';
import GalleryPanel from './GalleryPanel.jsx';

/** The ↔ compare button, only for an image whose camera matches the one it was edited from. */
function CmpButton({ before, after, onOpen }) {
  const same = useSameCamera(before, after);
  if (!same) return null;
  return <button className="xbtn thumb-cmp" title="Compare with the original: drag the slider" onClick={(e) => { e.stopPropagation(); onOpen({ before, after }); }}>↔</button>;
}

/** Floating gallery of everything generated/drawn. Drag (or click) onto the board. */
export default function HistoryDock({ onToTimeline, panelOpen, onPanelOpen, onPanelClose, assets, onAddToBoard, onDeleteAsset, onEditSketch, onEditKrea, onEditFlux, onEditStudio, onVideoLab, onGenjutsu, onRemix, onRestore, onUploadImages, onOpenMv }) {
  const uploadRef = useRef(null);
  const [cmp, setCmp] = useState(null);   // {before, after} urls shown in the compare slider
  return (
    <>
    <div className="dock glass">
      <span className="dock-label">Gallery</span>
      <button className="dock-all" onClick={onPanelOpen} title="Browse every item in a side panel: search, filter, preview">☰ Browse all{assets.length ? ` (${assets.length})` : ''}</button>
      <button className="dock-add" title="Add image(s) from disk — ComfyUI PNGs keep their embedded prompt"
        onClick={() => uploadRef.current?.click()}>＋</button>
      <input ref={uploadRef} type="file" accept="image/*" multiple hidden
        onChange={(e) => { if (e.target.files?.length) onUploadImages([...e.target.files]); e.target.value = ''; }} />
      <div className="dock-items" onWheel={(e) => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY; }}>
        {assets.map((a) => {
          const isAudio = a.kind === 'audio' || a.mime.startsWith('audio');
          const isChar = a.kind === 'character';
          const isStyle = a.kind === 'styleref';
          const boardable = !isAudio && !isStyle;
          return (
            <div
              key={a.id}
              className={`thumb ${isAudio ? 'thumb-audio' : ''}`}
              draggable={boardable}
              title={isAudio ? `${a.name} — music track (open Music Video)` : isChar ? `${a.meta?.name || a.name} — character` : isStyle ? `${a.name} — style/environment reference (open Music Video)` : `${a.name} — drag to board or click to add`}
              onDragStart={(e) => boardable && e.dataTransfer.setData('asset-id', a.id)}
              onClick={() => (isAudio || isStyle ? onOpenMv?.() : onAddToBoard(a.id))}
            >
              {isAudio ? (
                <div className="thumb-audio-body"><span>🎵</span><small>{a.name}</small></div>
              ) : a.mime.startsWith('video') ? (
                <video src={a.url} muted loop autoPlay />
              ) : (
                <img src={a.url} alt={a.name} />
              )}
              <span className={`tk tk-${a.kind}`}>{isChar ? (a.meta?.name || 'character') : isStyle ? 'style' : a.meta?.source === 'final' ? 'final' : a.kind}</span>
              <button className="xbtn thumb-x" onClick={(e) => { e.stopPropagation(); onDeleteAsset(a.id); }}>✕</button>
              {(a.meta?.editedFrom && assets.some((x) => x.id === a.meta.editedFrom)) && (
                <CmpButton before={assets.find((x) => x.id === a.meta.editedFrom)?.url} after={a.url} onOpen={setCmp} />
              )}
              {a.kind === 'sketch' && (
                <button className="xbtn thumb-edit" title="Reopen in sketch pad (restores its prompt)"
                  onClick={(e) => { e.stopPropagation(); onEditSketch(a); }}>✎</button>
              )}
              {a.meta?.source === 'krea2' && (
                <button className="xbtn thumb-edit" title="Reopen in Krea 2 panel (restores its prompt and settings)"
                  onClick={(e) => { e.stopPropagation(); onEditKrea(a); }}>✎</button>
              )}
              {a.meta?.source === 'flux3' && !a.meta?.editTool && (
                <button className="xbtn thumb-edit" title="Reopen in the Flux 3 panel (restores its prompt and settings)"
                  onClick={(e) => { e.stopPropagation(); onEditFlux(a); }}>✎</button>
              )}
              {a.meta?.settings && a.meta?.source !== 'krea2' && a.meta?.source !== 'flux3' && a.kind !== 'sketch' && !a.mime.startsWith('video') && (
                <button className="xbtn thumb-edit"
                  title="Restore this iteration — reopens the sketch pad with the source sketch, settings, LoRAs, and seed used for this image"
                  onClick={(e) => { e.stopPropagation(); onRestore(a); }}>⟲</button>
              )}
              {a.mime.startsWith('video') && onGenjutsu && (
                <button className="xbtn thumb-remix" title="Open in Genjutsu (motion transfer / object swap / restyle)"
                  onClick={(e) => { e.stopPropagation(); onGenjutsu(a); }}>🌀</button>
              )}
              {a.mime.startsWith('video') && (
                <button className="xbtn thumb-fx" title="Open in Video Lab (upscale, slow-mo, cutout, reframe…)"
                  onClick={(e) => { e.stopPropagation(); onVideoLab(a); }}>🧰</button>
              )}
              {!a.mime.startsWith('video') && !isAudio && !isStyle && a.kind !== 'sketch' && (
                <button className="xbtn thumb-fx" title="Open in Edit Studio (inpaint, relight, try-on, restyle…)"
                  onClick={(e) => { e.stopPropagation(); onEditStudio(a); }}>🪄</button>
              )}
              {!a.mime.startsWith('video') && !isAudio && !isStyle && a.kind !== 'sketch' && (
                <button className="xbtn thumb-remix"
                  title="Generate a new image from this one — opens it in the sketch pad as an img2img base (Denoise = how much changes)"
                  onClick={(e) => { e.stopPropagation(); onRemix(a); }}>🎨</button>
              )}
            </div>
          );
        })}
        {!assets.length && <span className="hint">Empty — sketch or render something</span>}
      </div>
      {cmp && (
        <div className="ba-modal" onClick={() => setCmp(null)}>
          <div onClick={(e) => e.stopPropagation()}><BeforeAfter before={cmp.before} after={cmp.after} /></div>
          <button className="ba-close" onClick={() => setCmp(null)}>✕ Close</button>
        </div>
      )}
    </div>
    <GalleryPanel onToTimeline={onToTimeline} assets={assets} open={!!panelOpen} onClose={onPanelClose} onAddToBoard={onAddToBoard} onDeleteAsset={onDeleteAsset}
      onEditStudio={onEditStudio} onVideoLab={onVideoLab} onGenjutsu={onGenjutsu} onRemix={onRemix} onOpenMv={onOpenMv} />
    </>
  );
}
