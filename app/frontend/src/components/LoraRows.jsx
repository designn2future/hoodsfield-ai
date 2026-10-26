import React from 'react';

const uid = () => Math.random().toString(36).slice(2, 10);

/** Repeatable LoRA rows, chained onto the model + text encoder before sampling.
 * Shared between KreaPanel and SketchPanel's Krea 2 backend. */
export default function LoraRows({ loras, setLoras, loraOptions, busy, label = 'LoRAs', hint, labelFor }) {
  const addRow = () => setLoras((l) => [...l, { id: uid(), name: loraOptions[0] || '', strength: 1 }]);
  const removeRow = (id) => setLoras((l) => l.filter((row) => row.id !== id));
  const updateRow = (id, patch) =>
    setLoras((l) => l.map((row) => (row.id === id ? { ...row, ...patch } : row)));

  return (
    <>
      <label>{label}</label>
      <div className="hint">{hint || 'Chained onto the model + text encoder before sampling, in order.'}</div>
      {loras.map((row) => (
        <div className="grid2" key={row.id}>
          <label>LoRA
            <select value={row.name} disabled={busy || !loraOptions.length}
              onChange={(e) => updateRow(row.id, { name: e.target.value })}>
              {!loraOptions.length && <option value="">— none found / ComfyUI offline —</option>}
              {loraOptions.map((l) => <option key={l} value={l}>{labelFor ? labelFor(l) : l}</option>)}
            </select>
          </label>
          <label className={+row.strength === 0 ? 'warn' : ''}
            title={+row.strength === 0 ? 'Strength 0 = this LoRA does nothing' : undefined}>
            Strength{+row.strength === 0 ? ' ⚠ 0 = off' : ''}
            <input type="number" step={0.05} min={-2} max={2} value={row.strength} disabled={busy}
              onChange={(e) => updateRow(row.id, { strength: e.target.value === '' ? '' : +e.target.value })}
              onBlur={() => { if (row.strength === '' || Number.isNaN(+row.strength)) updateRow(row.id, { strength: 1 }); }} />
          </label>
          <button onClick={() => removeRow(row.id)} disabled={busy}>Remove</button>
        </div>
      ))}
      <button onClick={addRow} disabled={busy || !loraOptions.length}>+ Add LoRA</button>
    </>
  );
}
