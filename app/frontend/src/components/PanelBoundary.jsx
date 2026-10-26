import React from 'react';

/** Keeps a render error in one panel from blanking the whole app (and losing the session). */
export default class PanelBoundary extends React.Component {
  state = { err: null };
  static getDerivedStateFromError(err) { return { err }; }
  componentDidCatch(err, info) { console.error('panel crashed:', err, info?.componentStack); }
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div className="glass" style={{ margin: 24, padding: 20 }}>
        <h3>Something in this panel broke</h3>
        <div className="hint">Your project is safe: everything is kept in the app and autosaved. Nothing running was stopped.</div>
        <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, opacity: 0.8 }}>{String(this.state.err?.stack || this.state.err).slice(0, 800)}</pre>
        <button onClick={() => this.setState({ err: null })}>Try again</button>
      </div>
    );
  }
}
