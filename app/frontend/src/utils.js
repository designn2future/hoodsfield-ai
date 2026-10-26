// ComfyUI's CLIPLoader/VAELoader dropdowns are shared across every installed model
// family, so "first in the list" is often wrong for Krea2 — prefer a Krea2-correct
// match (Qwen3-VL-4B encoder, qwen_image_vae) before falling back to index 0.
export const pickDefault = (list, preferredPattern) =>
  list.find((n) => preferredPattern.test(n)) || list[0];

// Scene cards store a single assetId, which can point at either the sketch
// itself (if that's what got dragged onto the board) or a generated image.
// Prefer showing the most recent photorealistic result derived from a sketch
// asset, falling back to the sketch itself if nothing's been generated yet.
export const resolveDisplayAsset = (asset, assets) => {
  if (!asset || asset.kind !== 'sketch') return asset;
  const derived = assets.filter((a) => a.meta?.sourceSketchId === asset.id);
  return derived.length ? derived[derived.length - 1] : asset;
};
