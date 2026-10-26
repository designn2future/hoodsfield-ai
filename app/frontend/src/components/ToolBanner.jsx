import React from 'react';
import BannerVideo from './BannerVideo.jsx';
import { FEATURES, BANNERS } from '../features.js';

/** Slim cinematic header shown at the top of every tool: its showcase clip
 * faded behind the title, tagline and a one-line description. */
export default function ToolBanner({ overlay }) {
  const media = BANNERS[overlay];
  const f = FEATURES.find((x) => x.media === media && x.overlay === overlay) || FEATURES.find((x) => x.overlay === overlay);
  if (!f) return null;
  return (
    <header className="toolbanner" style={{ '--accent': f.accent }}>
      <BannerVideo media={f.media} />
      <div className="toolbanner-shade" />
      <div className="toolbanner-copy">
        <span className="toolbanner-icon">{f.icon}</span>
        <div>
          <div className="toolbanner-title">{f.title}{f.badge && <em>{f.badge}</em>}</div>
          <div className="toolbanner-blurb">{f.blurb}</div>
        </div>
      </div>
    </header>
  );
}
