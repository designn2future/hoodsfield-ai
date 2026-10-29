# Lip-sync, Swap & Perform, voices and Ads presenters

These tools share one engine: **MiniMax H3 with a voice file**. H3 makes the face and the sound in one pass, so when it is given a recorded voice the lips follow that voice. Hoodsfield puts the original, untouched audio back on the finished clip.

## Characters and voices
- **Characters** (left rail): one photo becomes a character sheet (turnaround, expressions). Each character can have a **voice**, picked in the inspector. Scenes, Ads, Music Video and TikTok use the character automatically.
- **Voice**: clones a voice from a short, clean sample (10 to 20 seconds) with Chatterbox, locally. Every generated voice is saved to the Gallery, so it can be picked on other pages.
- **Speak as**: on the Voice page, one click selects a character's voice.

## Lip-sync
1. Pick a face (a character photo or any portrait) and a voice (upload, record, pick from the Gallery, or type a line and press *Say it in the character's voice*).
2. Press generate. About 3 minutes for 5 seconds at *Standard*.
3. **Best** (0.8 MP, slower) uses the 8-step sampler. Use it for wide shots where faces are small.

Tips: the first frame sets what H3 keeps, so use a clear, front-facing picture with open eyes. The words are transcribed automatically and sent to H3 with the prompt, so you do not need to type them. A clip is up to about 7 seconds of speech; for longer ads, make one clip per section and join them on the Timeline.

If the mouth barely moves, the app makes one more take and keeps the livelier one. If H3 is not available in ComfyUI, Lip-sync falls back to LTX 2.3.

## Swap & Perform (left rail: Perform)
Replace a person in a clip with your character, and have them perform the clip's own audio (rap, song, speech).
1. Drop a clip with sound; say **who to replace** ("the man on the left in the yellow cap").
2. Pick the new character (or upload a photo); optionally say what they wear.
3. Press **Swap & perform**. The app (a) makes a full-body picture of the new person, (b) swaps them into the clip's first frame with Qwen (whole person: face, hair, body, clothes), asking for open, clearly visible eyes, then (c) runs the H3 lip-sync with the clip's audio. The people who are not swapped are told to stay quiet.
4. About 10 to 15 minutes. If the swap in frame 1 looks wrong, press Stop and use *Another take*.

Use footage you own or have rights to.

## Ads with a presenter
In **Ads**, choose a **Presenter** (a character). Shots where the person talks to the camera are lip-synced in their own voice; product shots that have a line get a voice-over. Make a character sheet first for the best result: the sheet's plain-background views keep the photo's own background from leaking into the ad.

## Connections
Nothing here needs an account except what you choose to connect in **Settings**: the address of your own local Ollama. All generation runs on your PC through ComfyUI.
