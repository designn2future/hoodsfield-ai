"""Genres / niches: one place that says what a kind of video *is*, so every part of the studio agrees.

A genre changes four things:
  still_style / motion_style   words appended to image and video prompts (what the camera and its footage look like)
  director_rules               extra rules for the AI writer/director (how shots are staged, paced and sounded)
  post                         the camera-format look applied to finished clips (see footage.py), or None
  sound                        what the soundscape should be built from
"""

GENRES = [
    {"id": "cinematic", "ideas": ['A lighthouse keeper finds a message in a bottle addressed to him, dated tomorrow.', 'A street musician plays one note and the whole city goes silent for a moment.', 'Two strangers realise they have been having the same dream every night.', 'A chef cooks the last meal in a restaurant that closes at midnight forever.'], "label": "Cinematic", "icon": "🎬", "blurb": "Polished film look: smooth camera, shallow depth of field, graded colour.",
     "still_style": "", "motion_style": "", "director_rules": "", "sound": "", "post": None, "post_opts": {}},

    {"id": "found_footage", "ideas": ['Mia films a camping trip at a lake. At night something knocks on the inside of her tent.', 'Two friends explore an abandoned hospital for a video. One of them stops answering from the next room.', "A hiker's camera is found on a trail: the last 40 seconds show someone following her through the trees.", 'A girl films her new house to show her mom. In every room, a door is open that she closed.', 'Three friends on a night drive film a bright light that follows their car, then the car stops.', 'A UFO hunter films a field at night. The lights in the sky come closer and the crickets go silent.'], "label": "Found footage horror", "icon": "📹", "blurb": "Handheld camcorder horror (Blair Witch, Paranormal Activity): shaky, soft, in-and-out of focus, glimpsed threats, long takes.",
     "still_style": ("found-footage still frame from a handheld consumer camcorder: amateur off-centre framing, subject partly cut off or half out of frame, "
                     "harsh on-camera light or murky available light, noisy low-light video, slight motion blur, soft focus, blown highlights and crushed shadows, "
                     "washed colours, cheap lens, no cinematic composition, no studio lighting, no shallow-depth-of-field bokeh, looks like real accidental footage"),
     "motion_style": ("handheld camera held by a frightened operator: constant shaky wobble and body sway, sudden jerky whip-pans toward sounds, focus hunting in and out, "
                      "auto-exposure pumping, camera light swinging, one long unbroken take, no dolly, no crane, no smooth cinematic movement"),
     "director_rules": (
         "GENRE: FOUND-FOOTAGE HORROR. The whole piece is raw footage recorded by someone IN the scene, never a movie. Rules: "
         "(1) The camera is a character: a person holds it, breathes behind it, runs with it, drops it, points it where their fear points. Describe what the operator does "
         "(turns toward a noise, backs away, lifts the camera light, fumbles the lens). "
         "(2) The threat is IMPLIED, never shown clearly: glimpsed at the edge of frame, behind a door, in the dark past the camera light, a shape that is there in one frame and gone in the next. "
         "Never describe a monster, ghost or killer in detail; describe what the operator SEES for half a second and cannot make sense of. "
         "(3) Practical light only: camera-mounted light, a flashlight, a phone screen, moonlight, a TV glow, streetlamps. Nothing is lit for the camera. "
         "(4) Amateur framing: subjects off-centre, heads cut off, people half out of frame, the camera tilted. Not composed, not symmetrical, not pretty. "
         "(5) Long takes and real-time pacing: few cuts, quiet stretches where nothing happens and tension builds, then a sudden burst of motion and noise. "
         "(6) Shots end abruptly (the camera is dropped, the light dies, a hard cut to black). "
         "(7) Dialogue is realistic and unscripted: breathless, overlapping, whispered, trailing off, people saying 'did you hear that?', 'turn the light off', 'stop filming'. "
         "(8) NEVER use cinematic vocabulary (anamorphic, bokeh, shallow depth of field, color grade, golden hour, cinematic lighting, dolly, crane, smooth). "
         "(9) No music. All sound is diegetic and cheap-microphone: footsteps, breathing, wind, a creaking house, cloth rustle, the camera bumping, distant unexplained sounds, silence that is too quiet."),
     "sound": "diegetic only, recorded on a cheap camcorder microphone: breathing, footsteps on leaves or floorboards, wind, cloth rustle, distant unexplained knocks, room tone, mic bumps. No music, no score.",
     "sound_opts": {"ambience": "wind", "unease": "medium", "bumps": "on", "breathing": "scared"}, "post": "camcorder", "post_opts": {"shake": "medium", "focus": "some", "glitches": "few", "wear": "medium"}},

    {"id": "phone_pov", "ideas": ['A man films his apartment hallway at night because something keeps moving the cable hanging from the ceiling.', 'A woman walks out into a dark field behind her house to film a strange glowing shape hovering over the trees.', 'A teenager films a quiet suburban street at night from his front yard because every porch light is going out one by one.', 'Two friends film their way down a basement staircase after hearing knocking from inside the wall.'], "label": "Handheld POV (TikTok found footage)", "icon": "🤳", "blurb": "Raw phone video reposted to TikTok: dark, badly aimed, low-bitrate, nobody looks at the camera, the threat barely visible.",
     "still_style": ("frame from handheld amateur video shot on a phone by someone on foot and reposted to social media: poorly aimed and slightly tilted, framed on the wrong thing "
                     "(a doorframe, the floor, a wall, the ceiling, a branch, the sky), shot directly in the open air or inside a house, dim flat overcast light, grey-blue and muddy, no golden hour, no orange sunset glow, no warm tones, "
                     "underexposed and dark with a blown-out pale sky, auto-exposure struggling, smudged phone lens, low resolution, "
                     "heavy video compression and macroblocking, muddy colours, any person seen only as a dark silhouette, the back of a head or a hand, never facing the camera, "
                     "looks like real accidental footage"),
     "motion_style": ("a handheld phone camera jostled by the walking operator: the framing drifts off the subject toward the floor and ceiling, sudden lurches, "
                      "brief whip toward a noise, exposure brightening and darkening as the lights outside change, one continuous unedited take, no dolly, no crane, no smooth cinematic movement, "
                      "nobody looks into the camera"),
     "director_rules": (
         "GENRE: PHONE-POV FOUND FOOTAGE (a real-looking TikTok repost). The whole piece is ONE person's handheld recording, and the viewer only sees what that camera happens to be pointing at. Rules: "
         "(1) NOBODY LOOKS AT THE CAMERA. The operator never films people's faces or reactions. Other people appear only as silhouettes, the backs of heads, a hand, an elbow, a shoulder at the frame edge, partly out of frame. "
         "Their reactions come through SOUND (a gasp, a whisper, a voice off-screen), not through close-ups of scared faces. "
         "(2) The camera is badly aimed. Much of the time it points at the wrong thing: the ceiling, a doorframe, the wall beside the subject, the floor, the sky. The subject is often partly or mostly out of frame. "
         "(3) The threat is seen LATE, briefly and partially: a light at the edge of a doorway, a glow behind a tree line, a beam that appears for a second. Never a clear, centred, well-lit object. "
         "Hold back the strongest image for the last seconds. "
         "(4) Boring, ordinary, specific surroundings: a real apartment hallway, a back garden, a stairwell, a quiet street, real clutter. Nothing is dressed or lit for the camera. NEVER set a shot inside a car or other vehicle and NEVER film through a car window, windscreen or any pane of glass. "
         "(5) Dark and underexposed with blown highlights; the exposure hunts. Practical light only. "
         "(6) Real time, one continuous take: no establishing shot, no reveal shot, no cutaway, minimal cuts. Quiet stretches where nothing happens are GOOD. "
         "(7) Nothing is explained. No narration, no scripted lines. Voices are muffled, overlapping, off-screen, breathless: 'what is that', 'are you seeing this', 'go, go'. "
         "(8) The footage ends abruptly, on a jolt, a blow-out of light, or mid-sentence. "
         "(9) NEVER use cinematic vocabulary. No music. All sound is a cheap built-in microphone: wind, footsteps, cloth rustle, thumps, clipping on loud sounds. (10) KEEP IT CONSISTENT. Decide where the threat is relative to the operator and keep it there: a light stays on the same side and only changes as the operator moves, and a shot never ends facing a different direction from the light it started on. Only technology of the story's era appears: in a story set before 1995 there are NO phones, screens or modern dashboards anywhere, and vehicles, radios and clothes are period-correct. Never show anyone holding a camera or device."),
     "sound": "cheap built-in microphone outdoors or in a room: wind, footsteps, room tone, muffled off-screen voices, thumps, loud sounds clipping. No music, no score.",
     "sound_opts": {"ambience": "wind", "unease": "low", "bumps": "off", "breathing": "none"}, "post": "tiktok", "post_opts": {"shake": "medium", "focus": "off", "glitches": "none", "wear": "heavy"}},

    {"id": "ugc_vlog", "ideas": ['A woman films her apartment to show her followers that a floor lamp keeps falling over by itself, then sets up the camera and it falls again while she watches.', 'A man films his hallway because the same cabinet door keeps opening on its own, and finally films it opening.', 'A renter films every room of her old apartment to prove nothing is there, while a picture frame slides off the wall behind her.'], "label": "UGC vlog (apartment, voice-over)", "icon": "🏠", "blurb": "An ordinary person filming their home on a phone and talking over it, deadpan: normal daylight, real clutter, one small thing that moves by itself.",
     "still_style": ("ordinary amateur video frame filmed by a resident inside their own lived-in apartment: normal everyday daylight and lamp light, real clutter on every surface, "
                     "slightly soft, auto-exposure, a few compression artifacts, the filmer's own hand or foot sometimes in the frame, nobody looking at the camera, looks like real accidental footage"),
     "motion_style": ("a handheld camera held by the resident: easy walking sway, the framing drifts and corrects as they look around, quick turns toward a sound, one continuous unedited take, "
                      "no dolly, no crane, no smooth cinematic movement, nobody looks into the camera"),
     "director_rules": (
         "GENRE: UGC APARTMENT VLOG (a real-looking TikTok about something odd at home). One person films their own apartment with a handheld camera and talks over it in a dry, unimpressed voice; the viewer never sees their face. Rules: "
         "(1) The filmer is never shown, only their hand, arm or foot at the edge of the frame. Nobody looks into the camera. "
         "(2) Ordinary, specific, slightly messy surroundings: a real old apartment, hardwood floor, a radiator, a bookshelf, cables, laundry, a half-closed door. Nothing is dressed or lit for the camera. "
         "(3) ONE small thing happens by itself (a lamp tips over, a door eases open, a frame slides off a shelf), plainly and without any dramatic framing. Show the aftermath first, then set up a locked-off camera and show it happen. "
         "(4) The narration is dry, practical and a bit sarcastic: it explains the room, rules out boring causes (window closed, no pets, heavy base), and sounds more tired than scared until the very end. "
         "(5) Keep geometry and period consistent from shot to shot (same room, same lamp, same side of the room). No cinematic vocabulary. "
         "(6) No music. All sound is a phone microphone: room tone, footsteps, a radiator, distant street noise, the object falling."),
     "sound": "phone microphone in a quiet apartment: room tone, footsteps on hardwood, a radiator tick, distant street noise, the sound of the object falling. No music, no score.",
     "sound_opts": {"ambience": "room tone", "unease": "none", "bumps": "on", "breathing": "none"}, "post": "ugc", "post_opts": {"shake": "light", "focus": "off", "glitches": "none", "wear": "medium"}},

    {"id": "monitor_cam", "ideas": ['A baby monitor in an empty nursery: the rocking chair starts to rock by itself, faster each minute, until something is sitting in it.', 'A nanny cam in a living room: the same dark shape stands behind the sofa in every motion clip, a step closer each time.', 'A pet camera in the kitchen: the dog stares at the same corner every night at 3 AM, and tonight something is there.'], "label": "Baby monitor / pet cam (infrared)", "icon": "👶", "blurb": "A fixed black-and-white infrared home camera in a dark room: wide, grainy, high corner view, timestamps, something small changes each minute and builds.",
     "still_style": ("frame from a fixed baby-monitor night camera mounted in a high corner of a dark nursery, black and white infrared image, a bright IR hotspot on the near wall, "
                     "wide-angle, grainy, low resolution, compression artifacts, flat infrared lighting, no colour, nothing is dressed or lit for the camera, no signs or writing"),
     "motion_style": "completely static fixed camera, it never moves, pans or tilts, low frame rate, infrared noise shimmer",
     "director_rules": ("GENRE: INFRARED HOME CAMERA (baby monitor / nanny cam / pet cam). One fixed wide view of a dark room, always identical framing. The dread BUILDS across the shots, each one a clear notch worse than the last: "
                        "(1) calm, nothing wrong; (2) a tiny wrongness (barely moves); (3) it is plainly happening; (4) faster, more insistent, a second thing joins in; (5) everything stops and goes completely still, and something that was not there is now there; "
                        "(6) the payoff: it turns toward the camera. NOBODY'S FACE IS EVER VISIBLE: a figure is a dark infrared silhouette with a blank black head, its eyes only two small bright reflective dots; no child is ever shown. "
                        "Nothing is explained. Text on screen tells the story (the timestamp, a short caption). No cinematic vocabulary.")
     ,
     "sound": "baby monitor microphone: room tone, a creaking chair, faint wordless humming near the microphone, a mobile's tick, a long silence. No music.", "sound_opts": {"ambience": "room tone", "unease": "low", "bumps": "off", "breathing": "none"}, "post": "babycam", "post_opts": {"shake": "none", "focus": "off", "glitches": "few", "wear": "medium"}},

    {"id": "trail_cam", "ideas": ['A trail camera on a deer trail: the animals all leave at 1:14 AM every night, and on the last night something very tall is standing between the trees.', 'A trail camera pointed at a bait pile: every clip the same pale shape stands a little closer to the lens.', 'A game camera strapped to a tree near a lake: a long arm reaches into the frame at the end of the memory card.'], "label": "Trail / game camera (infrared)", "icon": "🦌", "blurb": "A hunting trail camera strapped to a tree in a night forest: fixed black-and-white infrared frames with a data bar (time, temperature, moon). Animals, then the animals leave, then something tall.",
     "still_style": ("frame from a hunting trail camera strapped to a tree trunk facing a forest trail at night, black and white infrared flash photograph, harsh bright flash falloff, "
                     "grainy, low resolution, pine trees and undergrowth, a worn dirt trail, nothing is dressed or lit for the camera, no signs or writing"),
     "motion_style": "completely static fixed camera strapped to a tree, it never moves, low frame rate, infrared noise shimmer, harsh flash flicker",
     "director_rules": ("GENRE: TRAIL / GAME CAMERA. One fixed wide view of a forest trail at night, always the same framing. The dread BUILDS across the shots, each a clear notch worse: "
                        "(1) ordinary wildlife (a deer walks through); (2) more ordinary wildlife (a raccoon); (3) the animal reacts to something off-screen and bolts; (4) the forest is empty and something passes at the edge of the frame; "
                        "(5) a very tall pale figure stands far back between the trees, motionless, facing the camera; (6) it is right at the camera, a long arm reaching for the lens. "
                        "NOBODY'S FACE IS EVER VISIBLE: the figure is a pale infrared shape with a blank smooth head, extremely tall and thin, limbs too long. Nothing is explained. Text on screen tells the story. No cinematic vocabulary.")
     ,
     "sound": "forest at night through a cheap camera microphone: crickets, a distant owl, leaves, hooves, then everything going silent. No music.", "sound_opts": {"ambience": "room tone", "unease": "low", "bumps": "off", "breathing": "none"}, "post": "trailcam", "post_opts": {"shake": "none", "focus": "off", "glitches": "few", "wear": "medium"}},

    {"id": "bodycam", "ideas": ['An officer answers a noise call at an empty farmhouse. The radio starts repeating his own voice.', 'A patrol stops at a car on a dark road. The driver is gone and the engine is still warm.', 'An officer searches a basement after a 911 call that came from a house with no power.'], "label": "Body cam / police footage", "icon": "🚓", "blurb": "Chest-mounted wide-angle body camera: bobbing, barrel distortion, radio chatter, timestamp.",
     "still_style": "body-worn camera still: chest-mounted ultra-wide fisheye lens, bobbing amateur framing, harsh flashlight and car headlights, overexposed highlights, noisy dark shadows, compression artifacts, looks like real police body-cam footage",
     "motion_style": "chest-mounted camera bobbing with each step, sudden turns, wide-angle barrel distortion, the officer's hands and flashlight sometimes entering the frame, exposure pumping when lights hit the lens",
     "director_rules": ("GENRE: BODY-CAM FOOTAGE. The camera is chest-mounted on a person in uniform. Wide, low, bobbing framing; hands and flashlight enter the shot; radio chatter and procedure dialogue "
                        "(calm, clipped, professional, then fraying). The horror or drama is glimpsed, never staged for the camera. No cinematic vocabulary. Diegetic sound only."),
     "sound": "diegetic: boots, breathing, radio chatter and static, flashlight clicks, car engines, wind. No music.", "sound_opts": {"ambience": "wind", "unease": "low", "bumps": "on", "breathing": "calm"}, "post": "bodycam", "post_opts": {"shake": "medium", "focus": "off", "glitches": "few", "wear": "light"}},

    {"id": "cctv", "ideas": ['A night guard watches a corridor camera: the same figure appears one step closer each minute.', 'A shop camera shows the cashier talking to an empty doorway for ten minutes.', 'A parking-garage camera catches a car that arrives, parks, and nobody ever gets out.'], "label": "Security camera", "icon": "🎥", "blurb": "Locked-off CCTV: grainy, low frame rate, wide, events small in the frame.",
     "still_style": "security camera still: fixed ceiling-mounted high wide-angle view, grainy low-resolution, desaturated cold colours, compression artifacts, harsh overhead light, looks like real CCTV footage",
     "motion_style": "completely static locked-off camera, no camera movement at all, low frame rate, subjects move through the frame, occasional compression glitches",
     "director_rules": ("GENRE: SECURITY / CCTV FOOTAGE. The camera NEVER moves and never reframes. One fixed high wide angle per camera. Things happen small in the frame, in the background, "
                        "or off to the edge; long quiet stretches; something is wrong in the second half of a shot, not the first. No cinematic vocabulary. Usually no dialogue, no music; only room tone."),
     "sound": "room tone, distant sounds, hum of lights; often silent", "sound_opts": {"ambience": "room tone", "unease": "low", "bumps": "off", "breathing": "none"}, "post": "cctv", "post_opts": {"shake": "none", "focus": "off", "glitches": "few", "wear": "heavy"}},

    {"id": "doorbell", "ideas": ['The doorbell camera shows a delivery that was never ordered, then a hand reaching toward the lens.', 'Every night at 3:12 AM the motion alert fires and the porch is empty. Tonight the door is open.', 'A neighbour stands on the porch for an hour and never knocks.'], "label": "Doorbell cam", "icon": "🔔", "blurb": "Ultra-wide fisheye doorstep camera with motion alerts.",
     "still_style": "doorbell camera still: ultra-wide fisheye lens at head height looking out at a porch and front yard, cool low-resolution image, infrared-tinged night, compression noise, looks like real doorbell footage",
     "motion_style": "completely static ultra-wide camera, low frame rate, people arrive and leave the frame, slight exposure shifts when headlights pass",
     "director_rules": ("GENRE: DOORBELL CAMERA. Static fisheye view of a porch, always the same framing. A person or thing approaches, stops too long, or is simply there when the motion alert fires. "
                        "NOBODY'S FACE IS EVER VISIBLE: a visitor is a backlit silhouette, a figure at the very edge of the frame, a face lost in shadow, or the lens filled by a dark coat at chest height. "
                        "Nothing is explained, nobody knocks, nothing is said. Ordinary night details (moths around the porch light, a passing car's headlights, a flickering bulb). No cinematic vocabulary."),
     "sound": "porch ambience, wind, insects, footsteps, a muffled voice", "sound_opts": {"ambience": "wind", "unease": "low", "bumps": "off", "breathing": "none"}, "post": "doorbell", "post_opts": {"shake": "none", "focus": "off", "glitches": "none", "wear": "medium"}},

    {"id": "vhs", "ideas": ['A 1994 birthday tape. Someone in the background of every shot is slightly closer.', 'A recovered family video: the camera pans across the living room and a stranger sits in the old armchair.', 'A tape labelled DO NOT PLAY. It shows a staircase and a door that opens by itself.'], "label": "VHS / analog horror", "icon": "📼", "blurb": "Degraded tape: smeared colour, tracking glitches, 80s-90s home video.",
     "still_style": "frame from an old VHS home video tape: smeared colours, scan lines, analog noise, chroma bleed, washed-out 1990s consumer video look, soft focus, dated clothing and decor",
     "motion_style": "home-video camcorder movement from the 1990s, wobbly handheld, tracking glitches and tape noise, zooming in and out awkwardly",
     "director_rules": ("GENRE: VHS / ANALOG HORROR. A degraded tape from decades ago. Ordinary domestic scenes that are slightly off; things that should not be on the tape; "
                        "abrupt tracking glitches; dated clothes and decor. No cinematic vocabulary."),
     "sound": "tape hiss, muffled home-video audio, television static, distant music box", "sound_opts": {"ambience": "room tone", "unease": "medium", "bumps": "off", "breathing": "none"}, "post": "vhs", "post_opts": {"shake": "light", "focus": "some", "glitches": "many", "wear": "heavy"}},

    {"id": "night_vision", "ideas": ['Ghost hunters in an old school: the infrared shows something warm standing between them.', 'A farmer films his barn after cattle go missing: the night vision picks up glowing eyes in the rafters.', 'A UFO watch in the desert: a silent disc hangs above the camera and the light drains from the screen.', 'An investigator walks through a hallway. In the green dark, every door she passes is open one more time.'], "label": "Night vision / ghost hunt", "icon": "👁️", "blurb": "Infrared green night-vision with eye-shine and noise.",
     "still_style": "infrared night-vision camera still: green monochrome image, heavy grain and noise, glowing eyes, hot-spot bloom from the IR light, dark corners",
     "motion_style": "handheld night-vision camera, shaky, the IR light sweeping the dark, auto-gain pumping, noise swirling",
     "director_rules": ("GENRE: NIGHT-VISION INVESTIGATION. Everything is seen through an infrared camera: green, noisy, limited range, the dark just beyond the light. "
                        "Investigators whisper. Something is in the periphery. No cinematic vocabulary."),
     "sound": "whispers, breathing, footsteps, house creaks, an EVP-like murmur", "sound_opts": {"ambience": "house at night", "unease": "high", "bumps": "on", "breathing": "scared"}, "post": "nightvision", "post_opts": {"shake": "medium", "focus": "some", "glitches": "few", "wear": "medium"}},

    {"id": "phone", "ideas": ['A girl records a selfie video from her bedroom at 2 AM and notices something standing in the mirror.', 'A guy livestreams his drive home and a car keeps matching every turn he takes.', "A woman films a 'room tour' of her new apartment. The closet door keeps opening on its own."], "label": "Phone / UGC", "icon": "📱", "blurb": "Someone filming on their phone: vertical, wobbly, autofocus hunting.",
     "still_style": "vertical smartphone video frame: handheld phone camera, slightly wobbly, mixed ambient lighting, autofocus hunting, mild noise, candid framing, looks like a real social-media clip",
     "motion_style": "handheld smartphone camera, natural wobble, autofocus drifting, the person speaking or reacting to the camera",
     "director_rules": ("GENRE: PHONE / USER-GENERATED CONTENT. Someone films themselves or their surroundings on a phone. Casual direct-to-camera talk, selfie angles, quick pans to show something, "
                        "unpolished framing. No cinematic vocabulary."),
     "sound": "phone microphone: voices close, wind noise, ambient room sound", "sound_opts": {"ambience": "room tone", "unease": "none", "bumps": "on", "breathing": "none"}, "post": "phone", "post_opts": {"shake": "light", "focus": "some", "glitches": "none", "wear": "light"}},
]

BY_ID = {g["id"]: g for g in GENRES}

import re

# vocabulary that makes an image or clip look like a movie: stripped from every prompt in the raw-footage genres
_CINEMATIC = re.compile(
    r"\b(?:shallow depth[- ]of[- ]field|depth[- ]of[- ]field|bokeh|cinematic(?: lighting| look| style| shot| quality)?|anamorphic|film(?:ic)? (?:look|grain|stock)|"
    r"colou?r[- ]?grad(?:e|ed|ing)|golden hour|dolly(?: shot| in| out)?|crane(?: shot| move)?|smooth(?:ly)? (?:tracking|pan|camera|glid\w+)|"
    r"professionally lit|studio lighting|rim light(?:ing)?|volumetric(?: light(?:ing)?)?|teal and orange|35mm film)\b[,]?\s*", re.I)
_RAW = {"found_footage", "bodycam", "cctv", "doorbell", "vhs", "night_vision", "phone"}


def scrub(text: str, gid: str | None) -> str:
    if (gid or "") not in _RAW or not text:
        return text
    return re.sub(r"\s{2,}", " ", _CINEMATIC.sub("", text)).strip()


def get(gid: str | None) -> dict:
    return BY_ID.get(gid or "cinematic", BY_ID["cinematic"])


_SCARY = {"found_footage", "bodycam", "cctv", "doorbell", "vhs", "night_vision"}

SCARE_LEVELS = {
    "subtle": ("SCARE LEVEL: SUBTLE UNEASE. Wrongness is small and deniable: a door that is open when it was closed, a shape that might be a coat, a sound that might be the wind. "
               "Nothing is ever confirmed. One quiet, deniable sighting near the end."),
    "creepy": ("SCARE LEVEL: CREEPY. Escalate steadily. Shot 1 is ordinary and grounded. From shot 2 on, EVERY still_prompt must contain one specific, visible, unsettling detail (placed in the "
               "background, at the edge of frame, or half-hidden): a door ajar, a figure-shaped silhouette far behind the person, a handprint on the glass, a light that should be off. "
               "Each shot's wrongness is stronger or closer than the last. In the final third the figure is clearly glimpsed (distant, partly hidden, in the camera light for a moment). "
               "End on an abrupt cut: the camera falls, the light dies, a sound, black."),
    "terrifying": ("SCARE LEVEL: TERRIFYING. Escalate hard, with a real jump-scare moment. Shot 1 is ordinary. From shot 2 on, EVERY still_prompt contains a specific, visible, unsettling detail, and from shot 3 a "
                   "figure is visible at a distance in the camera light (tall, thin, pale, motionless, wrong proportions, face never clear). It is CLOSER in every shot: far in the trees, then at the tent, "
                   "then at the lens. Put one sudden event in a motion_prompt (it steps into the light, a face appears in the dark right at the lens, the camera whips round and it is already there). "
                   "The last shot: the operator falls or drops the camera and the thing stands over the lens as the light dies. Keep it unexplained and disturbing; never gory."),
}

SCARE_BANK = [
    "a tall, thin, pale figure stands motionless far behind the person at the edge of the camera light, half hidden by a tree, face in shadow",
    "the door at the end of the room is open a few centimetres and something pale is visible in the gap",
    "a long-limbed silhouette stands in the dark doorway behind the person, perfectly still, too tall for the door",
    "fresh child-sized handprints on the inside of the glass, and a pale shape just beyond them in the dark",
    "a faint human face is visible in the dark window glass behind the person, not reflecting anyone in the room",
    "the shape of a person is crouched in the corner of the frame, barely lit, head tilted at a wrong angle",
]


def scare_rules(level: str | None) -> str:
    return "\n\n" + SCARE_LEVELS.get(level or "creepy", SCARE_LEVELS["creepy"])


def rules_for(gid: str | None, scare: str | None = None) -> str:
    g = get(gid)
    base = ("\n\n" + g["director_rules"]) if g["director_rules"] else ""
    return base + (scare_rules(scare) if g["id"] in _SCARY and scare != "off" else "")


# escalation ladder used to guarantee something unsettling is VISIBLE in the pictures (image models only draw what the prompt names)
_WRONG = re.compile(r"\b(figure|silhouette|handprint|ajar|pale|crouch\w*|motionless|stands? (?:still|behind|there)|something (?:is )?(?:standing|watching|there)|face in the (?:dark|window|glass)|too tall|watching (?:her|him|them|the camera))\b", re.I)
STAGES = [
    [  # 1: small, deniable
        "the flap of the tent is open a few centimetres and something pale is just visible in the dark gap",
        "a door in the background is slightly ajar that was closed a moment ago",
        "fresh handprints on the glass and a faint pale shape just beyond them in the dark",
    ],
    [  # 2: a figure, far away, partly hidden
        "a tall, thin, pale figure stands motionless far behind the person at the very edge of the light, half hidden, face in shadow",
        "a long-limbed silhouette stands perfectly still in the dark doorway far behind the person",
        "a pale figure is just visible between the trees in the distance, too still and too tall, face never clear",
    ],
    [  # 3: closer
        "the tall pale figure is much closer now, standing just outside the circle of light behind the person, head tilted at a wrong angle, face still in shadow",
        "the long pale figure stands right at the edge of the frame beside the person, half out of shot, motionless",
    ],
    [  # 4: at the lens
        "the tall pale figure is right at the lens, filling the frame from the edge, the camera light catching a pale face that never looks quite human",
    ],
]


def ensure_scare(script: dict, level: str | None) -> dict:
    """Guarantee escalating, visible wrongness in the stills of horror shots (the small writer model often skips it)."""
    if level in (None, "off"):
        return script
    sc = script.get("scenes", []) or []
    n = len(sc)
    if n < 3:
        return script
    for i, s in enumerate(sc):
        key = "still_prompt" if "still_prompt" in s else "stillPrompt"
        if i == 0 or _WRONG.search(s.get(key, "") or ""):
            continue
        t = i / (n - 1)
        stage = 0 if t < 0.4 else 1 if t < 0.7 else 2 if t < 1.0 else 3
        if level == "subtle":
            stage = min(stage, 1) if i < n - 1 else 1
        if level != "terrifying" and stage == 3:
            stage = 2
        phrase = STAGES[stage][i % len(STAGES[stage])]
        s[key] = f"{(s.get(key) or '').rstrip('. ')}. {phrase[0].upper() + phrase[1:]}."
    return script


def decorate_script(script: dict, gid: str | None, scare: str | None = None) -> dict:
    """Make sure every shot's image / video prompt carries the genre's look, once."""
    g = get(gid)
    if not g["still_style"] and not g["motion_style"]:
        return script
    if g["id"] in _SCARY:
        ensure_scare(script, scare or "creepy")
    for sc in script.get("scenes", []) or []:
        for key in ("still_prompt", "stillPrompt", "motion_prompt", "motionPrompt", "continuity"):
            if key in sc and isinstance(sc[key], str):
                sc[key] = scrub(sc[key], gid)
        for key, style in (("still_prompt", g["still_style"]), ("stillPrompt", g["still_style"]), ("motion_prompt", g["motion_style"]), ("motionPrompt", g["motion_style"])):
            if style and key in sc and style[:40] not in (sc.get(key) or ""):
                sc[key] = f"{(sc[key] or '').rstrip('. ')}. {style}."
        if g["sound"] and not (sc.get("soundscape") or "").strip():
            sc["soundscape"] = g["sound"]
    if g["still_style"]:
        script["style"] = (script.get("style", "") + " " + g["still_style"]).strip()
    script["genre"] = g["id"]
    return script


def ideas_for(gid: str | None) -> list[str]:
    return list(get(gid).get("ideas", []))


SCORE_PROMPTS = {
    "found_footage": "sparse low dread drone, distant detuned piano notes, slow heartbeat pulse, unsettling tension, no melody, no drums",
    "bodycam": "low tense drone, sparse sub-bass pulse, distant radio static, ominous, no melody",
    "cctv": "very quiet cold electrical hum, faint high-pitched tone, slow low pulse, empty and unsettling",
    "doorbell": "quiet night ambience with a faint unsettling drone and a distant slow pulse",
    "vhs": "warped detuned music-box melody over tape hiss, slow, unsettling, analog horror",
    "night_vision": "low sinister drone, faint whispering texture, slow heartbeat, tension rising",
    "phone": "subtle low tension bed, very quiet",
    "cinematic": "cinematic tension underscore, strings and low drone, slow build",
}
