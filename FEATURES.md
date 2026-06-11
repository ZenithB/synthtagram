# Feature map: community wishlist → Synthtagram

Before building, we researched (a) why Ableton Live succeeded and (b) what its community has been asking for, across the Ableton Forum's [Feature Wishlist board](https://forum.ableton.com/viewforum.php?f=3), Reddit, KVR, Gearspace and production blogs. This file maps those findings to what shipped.

## The big one: collaboration

Real-time collaboration is the most-wished "someday" feature across every DAW community — the reason tools like Splice Studio and BandLab exist. It is Synthtagram's foundation, not an add-on: the whole project is a CRDT document (Yjs), so simultaneous edits from any number of people merge cleanly at per-note granularity, with presence, ghost playheads, per-user undo, and shared chat. Sharing is one click and serverless (WebRTC P2P via Trystero; BroadcastChannel between tabs; IndexedDB autosave for offline-first).

## Wishlist items shipped at launch

| # | Community wish | Evidence | What we built |
|---|---|---|---|
| 1 | **Autosave** — Live still has none; losing a set to a crash is a rite of passage | [Auto-save? (Ableton Forum)](https://forum.ableton.com/viewtopic.php?t=130663), [autosave thread](https://forum.ableton.com/viewtopic.php?t=134606) | Continuous IndexedDB autosave; there is no Save button to forget |
| 2 | **Visible / persistent undo history** — undo in Live is blind and dies with the session | [Feature Wishlist 2024](https://forum.ableton.com/viewtopic.php?t=248653) | Undo History panel: every edit labeled ("Move notes", "Add Echo"…), click any entry to rewind to it |
| 3 | **Per-note probability** — demanded for years before Live 11 shipped it | Live 11 release proved the demand | "Chance" lane next to velocity in the piano roll; dice-roll per note per loop |
| 4 | **Scale awareness** — wished forever, arrived in Live 12 | Live 12 release | Global key + scale, row highlighting, snap-to-scale on input & transpose, fold-to-scale view |
| 5 | **Capture MIDI** (loved in Live, missing elsewhere) | Widely praised Live 9.7+ feature | `CAP` button: the last ~30 s you played becomes a clip with inferred loop length — even if you weren't recording |
| 6 | **Better MIDI tools in fewer clicks** | [Top 10 features needed (90+ wishes)](https://www.productionmusiclive.com/blogs/news/117172869-top-10-features-needed-in-ableton-live-10-plus-90-wishes-and-suggestions) | Tools menu in the editor: diatonic Chordify, Arp (up/down/up-down), Strum, Humanize, Quantize 100/50%, Legato, Reverse, velocity ramps, double/halve loop |
| 7 | **Session → Arrangement friction** ("the loop trap") | [Gearspace thread](https://gearspace.com/board/electronic-music-instruments-and-electronic-music-production/832895-ableton-live-switching-between-session-arrangement-view.html), [Soundfly](https://flypaper.soundfly.com/produce/ableton-live-when-how-to-go-from-session-to-arrangement-view/) | One-click "Send clip/scene to Arrangement @ playhead"; drag session clips straight onto the timeline |
| 8 | **Mixer in Arrangement view** — "a very common feature request" | [Gearspace: Ableton shortcomings](https://gearspace.com/board/ableton-live/1040755-ableton-shortcomings-cons.html), [KVR thread](https://www.kvraudio.com/forum/viewtopic.php?t=500149) | Mute strips on every lane; the full mixer is one `Tab` away and the layout never changes |
| 9 | **Searchable everything / command palette** | Browser-search praise + palette culture from code editors | `Ctrl/Cmd+K` palette: every action, preset and effect is type-ahead |
| 10 | **Stem export without manual bouncing** | Constant request in collab/mixing threads | One click renders every track to its own WAV |
| 11 | **In-app guidance instead of manuals** | Live's Info View is its most-copied teaching idea | Hover-help status bar on every control + built-in help overlay |
| 12 | **Hover help, stable layout, no modals** | [MusicRadar 20-years retrospective](https://www.musicradar.com/news/story-of-ableton-live-at-20) | Single window, bottom detail panel, popups only for share/help |

## Content library

- ~50 instrument presets across Lead / Pad / Keys / Bass / Pluck / Bell, 12 synthesized drum kits, 40 MIDI loops (drums, bass, chords, melodies, arps).
- A **key-aware chord progression generator**: 16 named progressions (with roman numerals) that render into whatever key/scale the project is set to — a "chord track"-style helper users have long asked DAWs for.
- 7 instruments + 17 effects, all schema-driven so every one works identically in the live engine, the preset system and the offline renderer.

## Quality-of-life defaults

- Launch quantize is editable (None / 1 / 2 / 4 bars) and shown in the top bar — the #1 "why does my clip start late" confusion, made visible.
- Tap tempo; drag-anywhere BPM; global swing knob.
- Keyboard piano always available (Live's `A–K` layout, `Z/X` octave, `C/V` velocity), with a toggle so typing never fights shortcuts.
- Scene launch on number keys `1–9`.
- Per-user color & name; remote editors visibly "hold" the clip they're editing.
- Light + dark themes.
- Web MIDI: plug in a controller and play (Chrome/Edge).
- 2× oversampled audio path (88.2 kHz graph) so FM and distortion don't alias — an audio-nerd complaint about budget web synths generally.

## Deliberately not in v1 (the honest list)

- **Parameter automation lanes** — the next big feature; the schema-driven device layer was designed so automation can target any knob.
- **Audio clips / recording / sample import** — synthesis-only keeps the collab payload tiny and the engine deterministic; samples need asset sync (planned: chunked transfer over the existing data channels).
- **ARA-style pitch correction, comping, warping** — out of scope for "lightweight"; Live's deep-audio territory.
- Groove pool, MPE, racks-with-macros, nested groups.

## Sources

- [Ableton Forum — Feature Wishlist board](https://forum.ableton.com/viewforum.php?f=3) · [Auto-save?](https://forum.ableton.com/viewtopic.php?t=130663) · [autosave](https://forum.ableton.com/viewtopic.php?t=134606) · [Feature Wishlist 2024](https://forum.ableton.com/viewtopic.php?t=248653) · [We need ARA in 2025](https://forum.ableton.com/viewtopic.php?t=252112)
- [Gearspace — Ableton shortcomings/cons](https://gearspace.com/board/ableton-live/1040755-ableton-shortcomings-cons.html) · [Session ↔ Arrangement](https://gearspace.com/board/electronic-music-instruments-and-electronic-music-production/832895-ableton-live-switching-between-session-arrangement-view.html)
- [KVR — Live criticisms thread](https://www.kvraudio.com/forum/viewtopic.php?t=500149)
- [Production Music Live — Top 10 features + 90 wishes](https://www.productionmusiclive.com/blogs/news/117172869-top-10-features-needed-in-ableton-live-10-plus-90-wishes-and-suggestions)
- [MusicRadar — The story of Ableton Live at 20](https://www.musicradar.com/news/story-of-ableton-live-at-20) · [Vice — The Untold Story of Ableton Live](https://www.vice.com/en/article/ableton-live-history-interview-founders-berhard-behles-robert-henke/) · [Tape Op — Gerhard Behles interview](https://tapeop.com/interviews/73/gerhard-behles-dave-hill)
