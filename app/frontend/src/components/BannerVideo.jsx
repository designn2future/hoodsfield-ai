import React, { useEffect, useRef, useState } from 'react';
import { mediaUrl, posterUrl } from '../features.js';

/** Looping muted clip that only plays while on screen (so a wall of banners
 * stays cheap). Falls back to nothing if the file is missing, letting the
 * gradient art behind it show through. `hoverPlay` = start on hover only. */
export default function BannerVideo({ media, className = '', hoverPlay = false, eager = false }) {
  const ref = useRef(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const v = ref.current;
    if (!v || failed) return undefined;
    if (hoverPlay) return undefined;
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) v.play().catch(() => {});
      else v.pause();
    }, { threshold: 0.25 });
    io.observe(v);
    return () => io.disconnect();
  }, [failed, hoverPlay, media]);

  if (!media || failed) return null;
  return (
    <video
      ref={ref} className={`banner-video ${className}`} src={mediaUrl(media)} poster={posterUrl(media)}
      muted loop playsInline preload={eager ? 'auto' : 'metadata'}
      onError={() => setFailed(true)}
      onMouseEnter={hoverPlay ? () => ref.current?.play().catch(() => {}) : undefined}
      onMouseLeave={hoverPlay ? () => { ref.current?.pause(); } : undefined}
    />
  );
}
