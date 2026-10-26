// Video restyle looks for Genjutsu. Each look has two prompts:
//   edit   - the Flux 3 instruction that redraws the first frame (it sets the new look and carries it through the clip)
//   prompt - the video-model prompt (style tokens first: LTX weighs the start of the prompt most)
// Most looks name the *medium* explicitly (cel animation, clay, brick, gouache...) because vague style words
// ("anime style") leave the source's photographic colour and lighting in place.

const keep = 'Keep the exact composition, camera angle, subjects, poses and background layout of the original frame.';

const L = (id, label, emoji, group, edit, prompt) => ({
  id, label, emoji, group,
  edit: `Redraw this exact frame as ${edit}. ${keep}`,
  prompt,
});

export const LOOK_GROUPS = ['Anime', '3D & toys', 'Painted', 'Drawn & graphic', 'Film & retro', 'Crafts & textures'];

export const VIDEO_LOOKS = [
  // ---- Anime ------------------------------------------------------------------------------------
  L('anime-cel', 'Anime (cel)', '🎌', 'Anime',
    'a hand-drawn 2D anime cel: crisp dark ink outlines, flat cel shading with hard-edged two-tone shadows, simplified faces with large glossy eyes, vivid saturated palette, painted anime background, no photographic texture, no realistic skin',
    '2D hand-drawn anime, cel animation, crisp ink outlines, flat colors with hard two-tone shading, painted anime background, limited animation frame rate feel, vibrant saturated palette'),
  L('anime-ghibli', 'Ghibli-style', '🌿', 'Anime',
    'a hand-painted Studio Ghibli-style animation frame: soft watercolor-gouache backgrounds with lush detail, gentle pencil-like outlines, warm natural colors, round friendly character design, cumulus clouds, painterly foliage, no photographic texture',
    'hand-painted Ghibli-style animation, soft gouache backgrounds, gentle linework, warm natural light, lush painterly foliage, calm cinematic movement'),
  L('anime-shinkai', 'Shinkai sky', '🌌', 'Anime',
    'a Makoto Shinkai-style anime frame: hyper-detailed painted sky with luminous clouds, intense lens flares and bloom, glowing rim light, crisp clean linework, saturated teal and magenta twilight palette, glossy highlights, no photographic texture',
    'Makoto Shinkai anime film look, luminous painted sky, lens flare and bloom, glowing rim lighting, saturated twilight colors, clean linework'),
  L('anime-90s', '90s retro anime', '📼', 'Anime',
    'a 1990s retro anime still: grainy cel animation on film, slightly faded colors, thick ink lines, airbrushed highlights, muted cyan-magenta palette, soft CRT glow, vintage OVA look, no photographic texture',
    '1990s retro anime, grainy cel animation, faded film colors, thick ink lines, airbrushed highlights, VHS-era OVA look'),
  L('anime-cyber', 'Cyberpunk anime', '🌆', 'Anime',
    'a cyberpunk anime illustration: bold neon magenta and cyan lighting, sharp cel-shaded shadows, rain-slick reflective streets, glowing signage, high-contrast inked outlines, detailed anime background art, no photographic texture',
    'cyberpunk anime, neon magenta and cyan glow, cel-shaded shadows, rain reflections, glowing signs, bold ink outlines, dynamic anime camera'),
  L('manga-bw', 'Manga (B&W)', '🖋️', 'Anime',
    'a black-and-white manga panel: heavy black ink linework, screentone dot shading, hatching, speed-line energy, dramatic contrast, white paper background, no color, no photographic texture',
    'black and white manga, heavy ink linework, screentone shading, hatching, dramatic contrast, hand-inked panel feel'),

  // ---- 3D & toys --------------------------------------------------------------------------------
  L('pixar', 'Pixar-style 3D', '🧸', '3D & toys',
    'a stylized Pixar-like 3D animated film frame: smooth sculpted shapes, soft subsurface-scattering skin, big expressive eyes, glossy materials, warm global illumination, shallow depth of field, clean render, no photographic texture',
    'stylized 3D animated feature film, Pixar-like render, soft subsurface lighting, glossy materials, expressive character animation, warm global illumination'),
  L('clay', 'Claymation', '🫠', '3D & toys',
    'a stop-motion claymation scene: everything modeled from plasticine with visible fingerprints and tool marks, slightly lumpy shapes, saturated clay colors, miniature set with soft studio light, shallow depth of field',
    'stop-motion claymation, plasticine texture with fingerprints, slightly jerky 12 fps animation feel, handmade miniature set, soft studio lighting'),
  L('lego', 'LEGO bricks', '🧱', '3D & toys',
    'a scene built entirely from LEGO bricks and minifigures: glossy plastic studs, visible brick seams, tilt-shift miniature lens, bright toy colors, brick-built environment',
    'LEGO brick animation, glossy plastic bricks and minifigures, brick-built set, tilt-shift miniature look, bright toy colors, stop-motion brick movement'),
  L('lowpoly', 'Low-poly 3D', '🔷', '3D & toys',
    'a low-poly 3D render: flat-shaded geometric facets, no textures, limited pastel palette, soft ambient occlusion, clean isometric-feeling lighting',
    'low-poly 3D animation, flat-shaded triangular facets, pastel palette, smooth geometric motion, clean lighting'),
  L('felt', 'Felt & plush', '🪡', '3D & toys',
    'a world made of felt and plush fabric: fuzzy wool fibers, visible stitching, soft button eyes, handmade craft-diorama set, warm soft light, shallow depth of field',
    'felt and plush puppet animation, fuzzy wool texture, visible stitches, handmade diorama set, soft warm light, stop-motion puppet movement'),
  L('voxel', 'Voxel / Minecraft', '🟩', '3D & toys',
    'a voxel world: everything built from chunky cubic blocks with pixelated textures, bright blocky sky, simple cubic lighting, Minecraft-like block aesthetic',
    'voxel block world, chunky cubes with pixel textures, blocky character movement, bright simple lighting'),

  // ---- Painted ----------------------------------------------------------------------------------
  L('oil', 'Oil painting', '🎨', 'Painted',
    'a classical oil painting: thick visible impasto brush strokes, rich pigment, canvas weave texture, warm chiaroscuro lighting, painterly edges, no photographic sharpness',
    'moving oil painting, thick impasto brush strokes, canvas texture, painterly edges, warm chiaroscuro light, boiling paint motion'),
  L('watercolor', 'Watercolor', '💧', 'Painted',
    'a loose watercolor painting on textured paper: bleeding translucent washes, soft wet edges, visible pigment blooms, unpainted white paper highlights, light pencil underdrawing',
    'animated watercolor painting, translucent washes bleeding on paper, soft wet edges, pigment blooms, gentle flowing motion'),
  L('arcane', 'Painterly 3D (Arcane)', '🔥', 'Painted',
    'a painterly stylized 3D frame in the style of Arcane: hand-painted textures with visible brush strokes over 3D forms, dramatic colored rim lighting, rich orange and teal palette, gritty detail, graphic shadows',
    'painterly 3D animation, hand-painted brush-stroke textures, dramatic colored rim light, orange and teal palette, stylized cinematic motion'),
  L('ukiyoe', 'Ukiyo-e print', '🌊', 'Painted',
    'a Japanese ukiyo-e woodblock print: flat areas of color, bold black outlines, wave and cloud motifs, muted indigo and vermilion palette, paper grain, carved-block texture',
    'ukiyo-e woodblock print come to life, flat colors, bold outlines, indigo and vermilion palette, paper grain, stylized flowing motion'),
  L('gouache', 'Storybook gouache', '📖', 'Painted',
    'a children\'s storybook illustration in opaque gouache: flat matte color shapes, soft hand-painted texture, naive friendly proportions, warm limited palette, visible paper tooth',
    'storybook gouache illustration animated, flat matte colors, hand-painted texture, friendly naive shapes, gentle cut-out style motion'),
  L('impressionist', 'Impressionist', '🌅', 'Painted',
    'an impressionist painting in the style of Monet: broken dabs of color, soft dissolving edges, shimmering light, pastel palette, visible short brush strokes',
    'impressionist painting in motion, broken dabs of color, shimmering light, soft dissolving edges, pastel palette'),

  // ---- Drawn & graphic -------------------------------------------------------------------------
  L('comic', 'Comic book', '💥', 'Drawn & graphic',
    'a halftone comic book panel: bold black ink outlines, flat saturated colors, Ben-Day dots, dramatic hatching, high contrast',
    'comic book animation, bold black ink outlines, halftone Ben-Day dots, flat saturated colors, dynamic panel-like motion'),
  L('spiderverse', 'Spider-Verse comic', '🕷️', 'Drawn & graphic',
    'a stylized comic-book 3D frame in the style of Spider-Man: Into the Spider-Verse: halftone dot shading, off-register color print offset, bold inked line accents, chromatic aberration, graphic pop colors',
    'comic-book 3D animation, halftone dots, off-register print offset, bold ink accents, chromatic aberration, animated on twos for a stuttery stylized motion'),
  L('rotoscope', 'Rotoscope', '✏️', 'Drawn & graphic',
    'a rotoscoped animation frame: traced hand-drawn contour lines, flat color fills that slightly wobble outside the lines, minimal shading, retro 1970s animated-film palette',
    'rotoscope animation, traced wobbling outlines, flat color fills, boiling line effect, retro animated film look'),
  L('sketch', 'Pencil sketch', '📝', 'Drawn & graphic',
    'a detailed graphite pencil sketch on white paper: cross-hatching, soft smudged shading, visible construction lines, no color',
    'animated pencil sketch, graphite cross-hatching, boiling pencil lines, smudged shading, white paper, no color'),
  L('pixel', 'Pixel art', '👾', 'Drawn & graphic',
    'detailed 16-bit pixel art: limited 32-color palette, hard pixel edges, dithering, no anti-aliasing, retro video game sprite look',
    '16-bit pixel art animation, limited palette, dithering, hard pixel edges, retro game sprite movement'),
  L('blueprint', 'Blueprint', '📐', 'Drawn & graphic',
    'a technical blueprint drawing: white thin linework on deep blue paper, dimension lines, grid, hatching, handwritten annotations, no photographic texture',
    'animated technical blueprint, white linework on blue paper, drawing itself, dimension lines and annotations'),

  // ---- Film & retro ----------------------------------------------------------------------------
  L('noir', 'Film noir', '🕶️', 'Film & retro',
    'a high-contrast black-and-white film noir still: deep inky shadows, hard window-blind light stripes, 35mm grain, smoky atmosphere, no color',
    'film noir, black and white, hard shadows with window-blind light, heavy 35mm grain, smoky atmosphere, slow moody camera'),
  L('wes', 'Wes Anderson', '🎀', 'Film & retro',
    'a Wes Anderson-style frame: perfectly symmetrical composition, pastel pink, mint and mustard palette, flat frontal staging, tidy production design, soft diffuse light',
    'Wes Anderson style, symmetrical framing, pastel pink and mustard palette, flat frontal staging, deadpan precise camera moves'),
  L('vhs', 'VHS 1989', '📺', 'Film & retro',
    'a worn VHS camcorder frame from 1989: soft low-resolution picture, color bleeding, tracking lines, date stamp, washed-out colors, scanline noise',
    'VHS camcorder footage, tape tracking glitches, color bleeding, scanlines, washed-out colors, handheld shake, 1989'),
  L('synthwave', 'Synthwave', '🌴', 'Film & retro',
    'a synthwave 1980s illustration: neon pink and cyan gradients, chrome lettering feel, glowing grid, sunset sun, airbrushed highlights, retro-futurist glow',
    'synthwave 1980s aesthetic, neon pink and cyan glow, airbrushed gradients, glowing grid, retro-futurist movement, bloom'),
  L('technicolor', 'Technicolor 1950s', '🎬', 'Film & retro',
    'a 1950s three-strip Technicolor film frame: richly saturated reds and teals, soft glamour lighting, matte-painting backdrop, fine film grain',
    '1950s Technicolor feature film, richly saturated colors, glamour lighting, matte-painted backdrops, classic studio camera moves'),

  // ---- Crafts & textures ----------------------------------------------------------------------
  L('papercut', 'Paper cutout', '✂️', 'Crafts & textures',
    'layered paper-cutout collage: each element cut from colored paper, soft drop shadows between layers, visible paper fibers, handmade craft look',
    'paper cutout animation, layered colored paper with soft shadows between layers, stop-motion shifting layers, handmade look'),
  L('stained', 'Stained glass', '🔮', 'Crafts & textures',
    'a stained-glass window: thick black lead lines, luminous jewel-colored glass panes, light glowing through, mosaic segmentation of every shape',
    'stained glass animation, luminous colored panes, thick lead lines, light glowing through glass, slowly shifting light'),
  L('embroidery', 'Embroidery', '🧵', 'Crafts & textures',
    'a hand-embroidered textile: every shape stitched in thread, visible stitch direction and thread sheen, linen fabric background, handmade imperfections',
    'embroidered textile animation, visible stitches and thread sheen, linen background, stop-motion stitching movement'),
  L('origami', 'Origami', '🦢', 'Crafts & textures',
    'a world folded from origami paper: crisp folded facets, visible creases, subtle paper grain, soft studio light, pastel and white palette',
    'origami paper-fold animation, crisp creases and facets, folding and unfolding motion, soft studio light, pastel palette'),
  L('marble', 'Marble & gold', '🏛️', 'Crafts & textures',
    'a classical polished marble sculpture with gold leaf accents: veined white marble, subsurface glow, museum spotlight, deep dark background',
    'living marble sculpture with gold leaf, polished veined stone, museum spotlight, slow majestic motion'),
];

export const lookById = (id) => VIDEO_LOOKS.find((l) => l.id === id) || null;
