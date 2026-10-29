import React, { useEffect, useState } from 'react';

/** Agent / MCP page: the exact command for this machine + the tool list. */
export default function McpPage() {
  const [info, setInfo] = useState(null);
  const [copied, setCopied] = useState('');
  useEffect(() => { fetch('/api/mcp/info').then((r) => (r.ok ? r.json() : null)).then(setInfo).catch(() => {}); }, []);
  const copy = (k, text) => { navigator.clipboard?.writeText(text); setCopied(k); setTimeout(() => setCopied(''), 1500); };

  return (
    <div className="mcp-page">
      <div className="mcp-card">
        <h2>🤖 Let an agent drive the studio</h2>
        <p>
          Hoodsfield ships a local <b>Model Context Protocol</b> server. Register it once and any MCP client can generate and
          edit images, build character sheets, upscale, cut out backgrounds, interpolate, animate stills and run Genjutsu — on your GPU, with no cloud.
          Keep the backend and ComfyUI running.
        </p>
        {info?.claude_code && (<>
          <h3>Claude Code</h3>
          <pre>{info.claude_code}</pre>
          <button onClick={() => copy('cc', info.claude_code)}>{copied === 'cc' ? 'Copied ✓' : 'Copy command'}</button>
        </>)}
        <h3>MCP clients (JSON)</h3>
        <pre>{info ? JSON.stringify(info.json, null, 2) : 'loading…'}</pre>
        <button disabled={!info} onClick={() => copy('js', JSON.stringify(info.json, null, 2))}>{copied === 'js' ? 'Copied ✓' : 'Copy JSON'}</button>
      </div>
      <div className="mcp-card">
        <h3>Tools exposed ({info?.tools?.length ?? 0})</h3>
        <ul className="mcp-tools">
          {(info?.tools || []).map((t) => <li key={t.name}><code>{t.name}</code><span>{t.description}</span></li>)}
        </ul>
      </div>
    </div>
  );
}
