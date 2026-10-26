import React from 'react';

const uid = () => Math.random().toString(36).slice(2, 10);

/** Repeatable face-swap rows (ReActor), one per person to replace, indexed
 * left-to-right (0 = leftmost) in the generated image. Shared between
 * KreaPanel and SketchPanel's Krea 2 backend. */
export default function FaceSwapRows({
  faces, setFaces, swapModels, faceRestoreModels, swapModel, faceRestoreModel,
  onSwapModelChange, onFaceRestoreModelChange, busy,
}) {
  const addRow = () => setFaces((f) => [...f, { id: uid(), index: f.length, file: null }]);
  const removeRow = (id) => setFaces((f) => f.filter((row) => row.id !== id));
  const updateRow = (id, patch) =>
    setFaces((f) => f.map((row) => (row.id === id ? { ...row, ...patch } : row)));

  return (
    <>
      <label>Face swap</label>
      <div className="hint">One row per person to replace, indexed left-to-right (0 = leftmost) in the generated image.</div>
      {faces.map((row) => (
        <div className="grid2" key={row.id}>
          <label>Person index
            <input type="number" min={0} value={row.index} disabled={busy}
              onChange={(e) => updateRow(row.id, { index: +e.target.value })} />
          </label>
          <label>Face image
            <input type="file" accept="image/*" disabled={busy}
              onChange={(e) => updateRow(row.id, { file: e.target.files?.[0] || null })} />
          </label>
          <span>{row.file?.name || '— no file —'}</span>
          <button onClick={() => removeRow(row.id)} disabled={busy}>Remove</button>
        </div>
      ))}
      <button onClick={addRow} disabled={busy}>+ Add face</button>
      {faces.length > 0 && (
        <>
          <label>Swap model</label>
          <select value={swapModel || ''} disabled={busy || !swapModels.length}
            onChange={(e) => onSwapModelChange(e.target.value)}>
            {swapModels.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <label>Face restore</label>
          <select value={faceRestoreModel || 'none'} disabled={busy}
            onChange={(e) => onFaceRestoreModelChange(e.target.value)}>
            {(faceRestoreModels.length ? faceRestoreModels : ['none']).map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </>
      )}
    </>
  );
}
