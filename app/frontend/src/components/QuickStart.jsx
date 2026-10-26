import React, { useEffect, useState } from 'react';
import { useGenre } from '../genreStore.js';
import { storyIdeas } from '../api.js';

const LENGTHS = [['15s', '15 seconds', 'a quick hook'], ['30s', '30 seconds', 'the sweet spot'], ['60s', '1 minute', 'a full story'], ['3min', '3 minutes', 'long form']];

/** "Make a video": three plain questions (what kind, what idea, how long) that set up the whole pipeline and drop you at the script. */
export default function QuickStart({ onCreate, onClose }) {
  const { genre, defs, setGenre } = useGenre();
  const [concept, setConcept] = useState('');
  const [length, setLength] = useState('30s');
  const [aspect, setAspect] = useState('9:16');
  const [ideas, setIdeas] = useState([]);
  const [src, setSrc] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { let on = true; storyIdeas(genre.id, '', 6).then((r) => { if (on) { setIdeas(r.ideas || []); setSrc(r.source || ''); } }); return () => { on = false; }; }, [genre.id]);

  const more = async () => {
    setBusy(true);
    const r = await storyIdeas(genre.id, concept, 6);
    setIdeas(r.ideas || []); setSrc(r.source || ''); setBusy(false);
  };
  const ready = concept.trim().length >= 8;

  return (
    <div className="qs">
      <div className="qs-wrap">
        <button className="qs-x" onClick={onClose} title="Close">✕</button>
        <h1>✨ Make a video</h1>
        <p className="qs-lede">Three quick questions. I'll set everything up, write the script, and walk you through the rest.</p>

        <section>
          <h2><span>1</span> What kind of video?</h2>
          <div className="qs-genres">
            {(defs.length ? defs : [genre]).map((g) => (
              <button key={g.id} className={g.id === genre.id ? 'on' : ''} onClick={() => setGenre(g.id)} title={g.blurb}>
                <b>{g.icon} {g.label}</b><small>{g.blurb}</small>
              </button>
            ))}
          </div>
        </section>

        <section>
          <h2><span>2</span> What's the idea?</h2>
          <textarea rows={4} value={concept} autoFocus onChange={(e) => setConcept(e.target.value)}
            placeholder={'One or two sentences is plenty. Who is in it, where are they, and what goes wrong?\ne.g. "Mia films a camping trip at a lake. At night something knocks on the inside of her tent."'} />
          <div className="qs-ideas-head">
            <span>💡 Stuck? Tap an idea to use it{src === 'ollama' ? ' (fresh from your local AI)' : ''}:</span>
            <button disabled={busy} onClick={more} title="Ask the local AI for new ideas (it uses what you've typed as a direction)">{busy ? '⏳ Thinking…' : '🔄 More ideas'}</button>
          </div>
          <div className="qs-ideas">
            {ideas.map((i, n) => (
              <button key={n} onClick={() => setConcept(i.title ? `${i.title}: ${i.concept}` : i.concept)}>{i.title && <b>{i.title}</b>}{i.concept}</button>
            ))}
          </div>
        </section>

        <section>
          <h2><span>3</span> How long, and what shape?</h2>
          <div className="qs-row">
            {LENGTHS.map(([id, label, note]) => (
              <button key={id} className={length === id ? 'on' : ''} onClick={() => setLength(id)}><b>{label}</b><small>{note}</small></button>
            ))}
          </div>
          <div className="qs-row">
            <button className={aspect === '9:16' ? 'on' : ''} onClick={() => setAspect('9:16')}><b>📱 Vertical 9:16</b><small>TikTok, Reels, Shorts</small></button>
            <button className={aspect === '16:9' ? 'on' : ''} onClick={() => setAspect('16:9')}><b>🖥 Wide 16:9</b><small>YouTube</small></button>
          </div>
        </section>

        <div className="qs-go">
          <button className="primary" disabled={!ready} onClick={() => onCreate({ genreId: genre.id, concept: concept.trim(), lengthPreset: length, aspect, mode: 'room' })}>
            💬 Develop it in the Story Room →
          </button>
          <button disabled={!ready} onClick={() => onCreate({ genreId: genre.id, concept: concept.trim(), lengthPreset: length, aspect })}>⚡ Just write the script</button>
          <span>{ready ? 'Story Room: chat with a producer and shape the story, then it writes the shots. Or skip straight to a quick script.' : 'Type your idea above to continue.'}</span>
        </div>
        <p className="qs-fine">After the script you'll make the pictures, then the clips (they get the {genre.post ? 'camera look and sound design automatically' : 'film look'}), then cut and render. The wizard tells you what to do at each step.</p>
      </div>
    </div>
  );
}
