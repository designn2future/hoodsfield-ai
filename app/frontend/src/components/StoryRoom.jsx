import React, { useEffect, useRef, useState } from 'react';
import { useGenre } from '../genreStore.js';
import { storyRoomStatus, storyRoomSetKey, storyRoomForgetKey, storyRoomSetModel, storyRoomChat, storyRoomScript } from '../api.js';

const CHIPS = ['Give me 3 premises', "What's the scariest version of this?", 'What should the final shot be?', 'Make the threat less obvious', 'Add a twist'];
const SECONDS = { '15s': 15, '30s': 30, '60s': 60, '3min': 180 };
const GREETING = "I'm your producer and writer. Tell me an idea (even half of one), or tap “Give me 3 premises”. We'll shape the story together: the hook, the rule of the haunting, how it escalates, the last frame. When it feels right, press “Write the shot list” and it goes straight into your script.";

/** Story Room: chat with a producer/screenwriter, then turn the conversation into the script. Local AI or Claude (own API key). */
export default function StoryRoom({ tk, setTk, onScript, goScript }) {
  const { genre } = useGenre();
  const room = tk.room || { messages: [], engine: '' };
  const [st, setSt] = useState(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [writing, setWriting] = useState(false);
  const [err, setErr] = useState('');
  const [keyInput, setKeyInput] = useState('');
  const [showKey, setShowKey] = useState(false);
  const endRef = useRef(null);
  const seconds = SECONDS[tk.lengthPreset] || 30;

  const patch = (p) => setTk((m) => ({ ...m, room: { ...(m.room || { messages: [], engine: '' }), ...p } }));
  useEffect(() => { storyRoomStatus().then(setSt); }, []);
  const engine = room.engine || (st?.claude_code?.available ? 'claude_code' : st?.claude.configured ? 'claude' : 'local');
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [room.messages.length, busy]);

  const ask = async (messages) => {
    setBusy(true); setErr('');
    try {
      const r = await storyRoomChat({ engine, genre: genre.id, scare: tk.scare || 'creepy', seconds, messages });
      patch({ messages: [...messages, { role: 'assistant', content: r.text.trim() }], pending: false });
    } catch (e) { setErr(e.message); patch({ pending: false }); } finally { setBusy(false); }
  };

  // arriving from "Make a video" with an idea: the producer answers it straight away
  useEffect(() => {
    if (room.pending && st && room.messages.length && room.messages[room.messages.length - 1].role === 'user' && !busy) ask(room.messages);
  }, [room.pending, st]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = (text) => {
    const t = (text ?? input).trim();
    if (!t || busy) return;
    setInput('');
    const messages = [...room.messages, { role: 'user', content: t }];
    patch({ messages });
    ask(messages);
  };

  const writeScript = async () => {
    setWriting(true); setErr('');
    try {
      const r = await storyRoomScript({ engine, genre: genre.id, scare: tk.scare || 'creepy', seconds, messages: room.messages, concept: tk.concept });
      patch({ scriptText: r.text });
      await onScript(r.text);
      goScript();
    } catch (e) { setErr(e.message); } finally { setWriting(false); }
  };

  const saveKey = async () => {
    try { await storyRoomSetKey(keyInput.trim()); setKeyInput(''); setShowKey(false); setErr(''); setSt(await storyRoomStatus()); patch({ engine: 'claude' }); } catch (e) { setErr(e.message); }
  };

  const claudeReady = !!st?.claude.configured;
  const canWrite = room.messages.some((m) => m.role === 'user') || (tk.concept || '').trim().length > 8;

  return (
    <div className="sr">
      <div className="sr-head">
        <h4>💬 Story Room <small>develop the story with a producer, then write the shot list</small></h4>
        <div className="sr-engine">
          <button className={engine === 'local' ? 'on' : ''} onClick={() => patch({ engine: 'local' })} title={st?.local.ok ? `Local AI (${st.local.model}): free and private, a smaller writer` : 'Ollama is not running'}>
            🖥 Local AI {st ? (st.local.ok ? '●' : '○') : ''}
          </button>
          <button className={engine === 'claude_code' ? 'on' : ''} disabled={!st?.claude_code?.available} onClick={() => patch({ engine: 'claude_code' })}
            title={st?.claude_code?.available ? 'Claude, using your Claude subscription through the Claude Code that is already signed in on this computer. No API key. Takes a few seconds longer per reply.' : 'Claude Code is not installed on this computer'}>
            ✨ Claude (my subscription) {st?.claude_code?.available ? '●' : '○'}
          </button>
          <button className={engine === 'claude' ? 'on' : ''} onClick={() => (claudeReady ? patch({ engine: 'claude' }) : setShowKey(true))} title="Claude through the Anthropic API with your own API key (billed separately from a subscription); only this conversation is sent.">
            🔑 Claude API key {claudeReady ? '●' : ''}
          </button>
        </div>
      </div>

      {showKey && (
        <div className="sr-key">
          <div className="hint">Paste your Anthropic API key (starts with <code>sk-ant-</code>). It is stored only on this computer, in the backend folder. Only the story conversation is sent to Anthropic, never your images or videos. Get one at console.anthropic.com.</div>
          <div className="row">
            <input type="password" value={keyInput} placeholder="sk-ant-…" onChange={(e) => setKeyInput(e.target.value)} />
            <button disabled={!keyInput.trim()} onClick={saveKey}>Save key</button>
            <button onClick={() => setShowKey(false)}>Cancel</button>
          </div>
        </div>
      )}
      {engine === 'claude_code' && (
        <div className="sr-meta">
          Uses your Claude Code login (your subscription), so there's nothing to set up. Replies take a few seconds longer, and it counts toward your plan's usage.
          <select value={st?.claude_code?.choice || 'sonnet'} onChange={async (e) => { await storyRoomSetModel(e.target.value); setSt(await storyRoomStatus()); }}>
            <option value="sonnet">Sonnet: fast and strong</option>
            <option value="opus">Opus: strongest</option>
          </select>
        </div>
      )}
      {claudeReady && engine === 'claude' && (
        <div className="sr-meta">
          Claude {st.claude.choice === 'opus' ? 'Opus (best, slower)' : 'Sonnet'} · key …{st.claude.last4}
          <select value={st.claude.choice} onChange={async (e) => { await storyRoomSetModel(e.target.value); setSt(await storyRoomStatus()); }}>
            <option value="sonnet">Sonnet: fast and strong</option>
            <option value="opus">Opus: strongest</option>
          </select>
          <button className="sr-link" onClick={async () => { await storyRoomForgetKey(); setSt(await storyRoomStatus()); patch({ engine: 'local' }); }}>forget key</button>
        </div>
      )}

      <div className="sr-chat">
        <div className="sr-msg bot">{GREETING}</div>
        {room.messages.map((m, i) => <div key={i} className={`sr-msg ${m.role === 'user' ? 'me' : 'bot'}`}>{m.content}</div>)}
        {busy && <div className="sr-msg bot dim">thinking…</div>}
        <div ref={endRef} />
      </div>

      <div className="sr-chips">
        {CHIPS.map((c) => <button key={c} disabled={busy} onClick={() => send(c)}>{c}</button>)}
      </div>
      <div className="sr-input">
        <textarea rows={2} value={input} placeholder="Tell the producer your idea, answer its question, or ask for options…" disabled={busy}
          onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
        <button disabled={busy || !input.trim()} onClick={() => send()}>Send</button>
      </div>
      {err && <div className="error">{err}</div>}
      <button className="primary" disabled={writing || busy || !canWrite} onClick={writeScript}>
        {writing ? `⏳ Writing the shot list with ${engine === 'local' ? 'the local AI' : 'Claude'}… (this can take a minute or two)` : '✍️ Write the shot list from this conversation →'}
      </button>
      <div className="hint">It writes about {seconds} seconds of shots (3–5 s each) with the picture, movement, dialogue and sound for every shot, then opens it in the Script step where you can edit anything.</div>
    </div>
  );
}
