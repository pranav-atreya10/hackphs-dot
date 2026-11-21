# Big flocks, drones inside flocks, tiny / fast / crossing birds

The questions: can SkySentry handle 50-60 birds at once, and can it still pick out a drone when birds
and a drone share the sky? The answer has two halves, because two programs must both get it right:

1. **Vivan's engine** (`VIVAN/detection/src/`) finds moving things and gives each one a **box**.
   If two birds, or a bird and a drone, end up in one box, nothing downstream can separate them.
2. **The classifier** (SkyNetLite, this folder) looks at a crop around each box and says bird / drone / other.

Part A below tests half 1 (read-only, nothing in `VIVAN/` was changed). Parts B and C build a stress
test for half 2.

Files (all in this folder):

| file | what it does |
|---|---|
| `engine_flock_probe.mjs` | drives the real engine with synthetic frames and measures tracks, boxes, IDs, speed |
| `make_stress_set.py` | builds about 60 synthetic crowded-sky images into `data/stress_flocks/` |
| `eval_stress.py` | runs a classifier checkpoint on every object in those images |

---

## Part A: what the engine does with many birds and a drone

### How it works (with file:line references)

All pixel numbers are at the engine's processing size, **320 x 240** (the camera page shrinks every frame to
320 px wide before `engine.process()`, see `PRANAV/public/js/camera.js:4`).

* **Motion** (`motion.js`): every pixel that differs from the learned sky by more than 16 grey levels is
  "changed" (`config.js` motion.threshold). Changed pixels are then grown by 1 px (`config.js:23` dilate: 1)
  so wing tips join their body. If more than 12 % of the sky changes at once the frame is treated as camera
  shake and thrown away (`config.js:24`, `motion.js:110`). A very large, close flock could trip this.
* **Blobs** (`blobs.js`): touching changed pixels become one blob. Then blobs whose boxes are within
  2 px of each other are merged (`config.js:34` mergeGap: 2, `blobs.js:82-95`), as long as the pair
  together is at most 400 px (`config.js:35`). Blobs under 3 px are dropped as specks (`config.js:31`,
  `blobs.js:74`) and blobs over 4 % of the frame (3,072 px) are dropped as cloud edges (`config.js:32`).
  The last rule means a close flock that merges into one huge blob would vanish completely.
* **Per-frame blob cap: yes.** If a frame has more than **200** separate pieces (`config.js:33`
  maxBlobs: 200), the labeller stops and returns no blobs at all (`blobs.js:34`), the engine passes an
  empty list (`engine.js:219`) and **skips tracking for that frame** (`engine.js:233`). It is all or
  nothing: 201 pieces gives zero detections, not 200.
* **Track cap: no.** There is no maximum number of tracks. The tracker compares every track with every
  blob inside a distance gate (`tracker.js:70-74`), sorts all candidate pairs and assigns them
  closest-first (`tracker.js:81`). Unmatched blobs start new tracks (`tracker.js:109`). A track is
  "confirmed" after 4 frames in a row and 2.5 px of movement (`config.js:48,51`, `tracker.js:155`).
* **Flocks** (`flocks.js`): confirmed tracks closer than 14 % of the frame width (44.8 px) **and** flying
  within 30 degrees of the same heading are joined (`config.js:97-98`, `flocks.js:31-36`). The joining is a
  chain (union-find), so a long string of birds can become one flock. A moving track and a nearly still
  one (under 4 px/s) are never joined (`flocks.js:38`).
* **A flock is NOT one track.** Each bird keeps its own track and its own box (`engine.js:543`,
  `state.tracks[i].bbox`). The flock is an extra group on top with its own big box around all members
  (`flocks.js:87`). The only time many birds really become one track is when their outlines touch
  and merge into one blob; then the "dense flock" check counts dark cores inside that one blob
  (`blobs.js:142`, `engine.js:243`, `config.js:103` denseMin: 5) and reports that count as the size
  (`engine.js:516`).
* **Cost:** the matching is tracks x blobs and the flock step is tracks x tracks, so it grows with the
  square of the count, but at these sizes it is tiny (see the numbers below).

### Two engine behaviours that matter for drones in flocks

1. **A drone that flies along with a flock gets relabelled "bird".** When a flock counts as birds,
   every member still marked "unknown" is switched to bird with the reason "flies with flock"
   (`engine.js:490-493`). A silent drone is "unknown" (a steady size alone is not enough,
   `engine.js:461`), so if it is within 45 px and on a similar heading, it becomes a bird.
2. **With drone sound, the whole flock becomes a "drone".** If any member is a drone, the flock is
   classified drone (`engine.js:488`). In the probe below, a flock of 30 was reported as one drone group.
   Safe for the alarm level (red either way), but the birds disappear from the bird count.

Also: the snapshot that is sent with an event is **one crop of the most important group**
(`engine.js:668-676`). When that group is a flock, the crop is the whole flock box. So the classifier
must be fed the per-track boxes from `state.tracks[].bbox` (which `skysentry_classifier.js`
`classifyBoxes()` is built for), never the event's `crop_box`.

### Probe results (`node "Shreyansh Local Ai Model/engine_flock_probe.mjs"`, about 2 minutes)

The probe uses the team's own `SyntheticSky` (same sky, clouds and sensor noise as
`VIVAN/detection/test`) and the same bird and drone shapes as `synthetic.js`. Birds are small (about
3-6 px across, flapping 4-6 Hz) and fly right at ~15 px/s. The drone is a steady 8 x 5 px shape.
Because every object's true position is known, each confirmed track can be checked against reality.
"Own track" means a confirmed track sits on the object (within ~4 px) and its box contains no other
object's centre. All numbers are the median after the first 2 s. Speed is `engine.process()` time only,
on this sandbox's CPU (2 threads).

**1. Many birds + one drone, birds 10 px apart**

| birds | drone | blobs | tracks | birds with own track | drone tracked | drone own box | drone put in a flock | drone track IDs | drone ends up as | ms / frame |
|---|---|---|---|---|---|---|---|---|---|---|
| 10 | crosses flock | 6 | 7 | 3/10 | 85 % | 77 % | 0 % | 1 | unknown | 3.4 |
| 10 | flies with flock | 4 | 5 | 2/10 | 44 % | 0 % | 96 % | 4 | **bird** (flies with flock) | 3.5 |
| 30 | crosses | 16 | 19 | 12/30 | 73 % | 62 % | 1 % | 4 | unknown | 3.6 |
| 30 | with | 13 | 16 | 9/30 | 20 % | 0 % | 95 % | 5 | **bird** | 3.0 |
| 60 | crosses | 25 | 29 | 17/60 | 58 % | 55 % | 5 % | 3 | unknown | 3.9 |
| 60 | with | 22 | 25 | 16/60 | 34 % | 26 % | 100 % | 5 | **bird** | 3.4 |
| 100 | crosses | 34 | 43 | 23/100 | 56 % | 48 % | 11 % | 6 | unknown | 4.1 |
| 100 | with | 33 | 40 | 23/100 | 21 % | 0 % | 82 % | 13 | **bird** | 4.1 |

Stage times at 100 birds: motion 2.5 ms, blobs 0.5, tracking 0.4, wingbeat 1.3, groups 0.4.
**Speed is not the problem**; at 200 separate dots it was ~15 ms per frame.

**Spacing matters more than the count** (60 birds, drone crossing):

| gap between birds | blobs | tracks | engine's bird count | birds with own track | drone tracked / own box |
|---|---|---|---|---|---|
| 6 px (outlines touch) | 6 | 7 | 56 (dense-flock core count) | 2/60 | 65 % / 65 % |
| 8 px | 12 | 15 | **15** | 6/60 | 62 % / 60 % |
| 10 px | 23 | 27 | **27** | 16/60 | 67 % / 58 % |
| 14 px | 53 | 56 | 56 | 48/60 | 93 % / 52 % |
| 18 px | 60 | 60 | 60 | 59/60 | 94 % / 52 % |

At 8-10 px gaps, birds merge in pairs and threes (wings ~6 px + 1 px growth + 2 px merge gap). Those
small clumps are too small for the dense-flock core count (it needs 30 px blobs with 5+ cores), so the
engine reports **15-27 birds when there are 60**. Very tight flocks are counted better (56) than
medium-tight ones. Even at 18 px gaps, about half the frames have a bird centre inside the drone's
box as it passes through rows of birds.

**Other N=60 variants:** with 4 px gaps the 60 birds become 2 blobs, counted as ~30 birds. With drone
sound and the drone flying with the flock, the result was "flock of 30: drone" (the birds are now
counted inside a drone group). A nearly stationary drone that the flock flies past was tracked in only
6 % of frames (it moves too little to pass the 2.5 px "minTravel" test) and the few times it was, it
was labelled bird via "flies with flock".

**Blob cap:** 150 dots: fine. 200 dots: 1 skipped frame. **250 dots: 91 of 120 frames skipped. 300 dots:
105 of 120 skipped and zero confirmed tracks.** Note these are separate *pieces*, so noise, clouds and
wing tips count too.

**2. Tiny objects (2-4 px)**: 20 well-spaced birds.

| wingspan | normal contrast | faint (half contrast) |
|---|---|---|
| ~2 px | 18/20 own track | **6/20** |
| ~3 px | 20/20 | 20/20 |
| ~4 px | 20/20 | 20/20 |

2 px birds sit right at the 3-pixel minimum blob size. The team's `distant_birds` preset
(`params.js:220`, minArea 2, threshold 12) brought the 2 px case to 20/20 in this test. Tiny birds are
also "too small to judge" for wingbeat (`config.js:70` minArea 6), so they only become "bird" through
flock inference.

**3. Fast objects** (30 fps, no motion blur drawn, so real life will be worse):

| speed | bird: frames tracked | drone: frames tracked |
|---|---|---|
| 4 px/frame | 77/78 | 77/78 |
| 10 px/frame | 29/31 | 29/31 |
| 15 px/frame | 18/21 | 18/21 |
| 20 px/frame | 13/16 | 13/16 |
| 24 px/frame | 10/13 | 8/13 |
| **30 px/frame** | **0/10 (never seen)** | **0/10** |

The cliff is `tracker.maxJump` = 24 px (`config.js:46`): a new track has no speed yet, so its second
sighting must be within 24 px. Faster than that, the object is a new "tentative" track every frame and
never confirms. The `phone_15fps` preset (maxJump 36) tracked 30 px/frame at 15 fps (8/10) but not
36 px/frame (0/9). Once a track has a velocity it predicts ahead, so a fast object that confirms stays
locked (1 ID the whole way).

**4. Crossing paths** (6 seeds each, so 12 objects for 2-object tests). "Kept" = same track ID 0.6 s
before and 0.8 s after the crossing. "Lost" includes "got a new ID" and "had no box of its own".

| situation | kept ID | swapped IDs | lost / new ID | frames near crossing with a shared box |
|---|---|---|---|---|
| 2 birds, 90 degree X | 5/12 | 2 | 5 | 37 % |
| 2 birds, 30 degree X | 5/12 | 1 | 6 | 91 % |
| 2 birds, 10 degree (almost parallel) | 2/12 | 0 | 10 | 100 % |
| 2 tiny birds (2 px), 90 degree X | 5/12 | 2 | 5 | 25 % |
| 2 birds head-on | 2/12 | **4** | 6 | 41 % |
| 2 fast birds (10 px/frame), 90 degree X | 12/12 | 0 | 0 | 3 % |
| 4 birds crossing at one point | 3/24 | 2 | 19 | 100 % |
| drone crossing a bird, 90 degree X | 5/12 | 1 | 6 | 40 % |
| drone crossing a bird, 20 degree | 6/12 | 0 | 6 | 100 % |
| drone overtaking a bird on the same line | 4/12 | 0 | 8 | 98 % |

When two objects overlap, their blobs merge into one. The tracker gives that merged blob to whichever
track is closest and the other track coasts on its prediction; when they separate, it often grabs the
wrong one (a swap) or a new ID is born. Fast crossings are fine because they only overlap for a frame.
**A drone crossing a bird keeps its own ID only about half the time.** If the classifier's "drone"
verdict is stored per track ID, it can jump to the bird or be lost at the crossing.

### Summary of Part A

* There is **no limit on tracks**, and speed is fine (3-5 ms per frame at 60-100 birds).
* There **is** an all-or-nothing limit of **200 blob pieces per frame**; above it whole frames are skipped.
* Birds are **not** merged into one flock *track*; every bird keeps its own track and box *if its blob
  is separate*. The real problem is **blob merging**: at the processing size of 320 px, birds closer than
  ~12 px share blobs and boxes, and medium-tight flocks are undercounted by half or more.
* A drone **crossing** a flock usually keeps its own track (about 55-85 % of frames, depending on flock size)
  and is not put in the flock, but its box often contains a bird.
* A drone **flying with** a flock is grouped into it and **relabelled bird** by `engine.js:490-493`.
* Identity is unreliable when paths cross slowly or head-on; fast crossings and well-separated paths are fine.

---

## Part B: the synthetic stress set

```
python3 "Shreyansh Local Ai Model/make_stress_set.py"      # ~1 min; writes data/stress_flocks/
```

It makes **60 images (1280 x 720), 15 of each type, with 3,129 pasted objects: 3,068 birds and 61 drones**:

| type | what is in it | scenes | birds | drones | motion-blurred birds |
|---|---|---|---|---|---|
| `dense` | 50-60 birds, 10-40 px, in one flock | 15 | 817 | 0 | 214 |
| `mixed` | 30-60 birds + 1-3 drones elsewhere in the sky | 15 | 694 | 32 | 154 |
| `drone_in_flock` | 30-60 birds + 1-2 drones inside the flock's area | 15 | 714 | 23 | 186 |
| `tiny` | 50-60 birds at 3-8 px; half the scenes add one 4-10 px drone inside the flock | 15 | 843 | 6 | 355 |

How it is made:
* Objects come **only from the Mendeley VALID split** (`data/mendeley/Dataset/valid`). The script
  refuses any path containing a `test` folder. Class comes from the file name (BV = bird, DV = drone),
  not the label's class number. Polygon labels become boxes by min/max.
* Only polygon-labelled objects are used (426 birds, 389 drones), and the polygon is the cut-out shape.
  `--allow-box-labels` also uses box-only labels with an ellipse cut-out.
* Each cut-out gets a soft, feathered edge (blurred mask) and is alpha-blended onto the sky.
* Backgrounds: half are a smooth gradient sky with faint clouds and noise; half are an object-free
  strip of a valid image (at least 30 px from any labelled box, and rejected if anything small sticks
  out of the smooth sky), enlarged to 1280 x 720.
* Some birds (25 %, or 40 % in `tiny`) get a straight-line motion smear 0.6-1.5x their size, to imitate
  fast flight. Their boxes include the smear, like a tracker blob would.
* Flocks are dense on purpose: about 1.6-3 bird-sizes of space per bird, so the crop around one bird
  often shows its neighbours, as it would live.
* `data/stress_flocks/manifest.json` lists, for every object: its box `[x1, y1, x2, y2]`, class, source
  photo and box, cut-out shape, motion blur, a rough visible fraction (how much of its box is not
  covered by objects pasted later; drones are pasted last so they are never covered), and whether its
  source photo is a near-duplicate of a test image. It also has the fixed seed (20261119) and the sha256
  of every image. Running the script again gives byte-identical images (checked).

### Limits: please read

* **These are crude pastes, not real footage.** Lighting, colour, sharpness and noise of the cut-out do
  not match the new sky, and the feathered edge keeps a thin rim of the original photo's background.
  Big close-up photos (median object is about half of a 640 px image) are shrunk to a few-to-40 px, which
  is not how a real far-away bird looks (haze, sensor noise, compression). The motion blur is a simple
  smear. Many Mendeley birds are colourful close-ups (kingfishers, songbirds), unlike gulls at an airport.
* **Not independent evidence.** The valid split is used for model selection (`train.py` loads
  `valid.npz` to pick the best epoch), and the team's own check found most valid images are
  near-duplicates of the frozen test images: `valid_excluded.json` lists 1,677 of 1,740 valid images
  within pHash distance 12 of a test image, and **2,989 of the 3,129 pasted objects** come from those photos.
  So a good score here mostly repeats what the test set says; it does not add new evidence.
* **Never train on `data/stress_flocks/` or on crops cut from it.** That would leak near-copies of the
  test set into training.
* There are only 61 drones, so drone recall moves by ~1.6 % per drone (and the `tiny` type has only 6).
* What it *is* good for: finding failures caused by crowding, neighbours inside the crop, tiny sizes and
  blur, and comparing two checkpoints on the same fixed images.

---

## Part C: running the classifier on it

```
python3 "Shreyansh Local Ai Model/eval_stress.py" --checkpoint path/to/best.pt
python3 "Shreyansh Local Ai Model/eval_stress.py" --checkpoint path/to/best.pt --json stress_result.json
python3 "Shreyansh Local Ai Model/eval_stress.py" --checkpoint path/to/best.pt --min-visible 0.5   # skip half-covered birds
```

The checkpoint may be `{"model": state_dict, ...}` (what `train.py` saves) or a bare state_dict. Every
ground-truth box is cropped with `crops.square_for_box` + `crops.cut` (the live rule: a square 1.4x the
box's long side, at least 32 px, resized to 64 x 64). It prints, per scene type: bird recall, drone
recall, birds called drones, drones called birds, birds called other, how many scenes had every drone
flagged with no bird called a drone (and the strict version: every bird stayed bird), the same split by
sharp vs motion-blurred birds, a per-scene list for scenes with drones, and the time to classify 60 crops
in one batch. It also checks each image's sha256 against the manifest.

**Sanity check with an untrained model** (`/tmp/random_stress.pt`, random weights, seed 0): it called
every one of the 3,129 objects "drone": bird recall 0 %, drone recall 100 %, balanced recall 50 %,
0 of 60 scenes passed. That is the expected chance-level behaviour of an untrained network (it picks
one class for everything), and it shows the scoring catches a model that floods the screen with drone alarms.

**Speed:** cutting 60 crops takes ~30-65 ms in Python; one batch of 60 through SkyNetLite took
~80-580 ms on this shared 2-thread sandbox CPU (the number jumped around between runs). A phone or laptop
browser using `skysentry_classifier.js` will differ; measure it there. Either way, classifying 60 crops
**every frame** is too slow at 30 fps, so classify each track once when it is confirmed and re-check it
every second or so (see recommendation 3).

---

## Suggestions for Vivan (not implemented; the engine was not changed)

Ordered by how much they matter for "60 birds and a drone":

1. **Do not turn a steady-size track into a bird just because it flies with a flock.** In
   `classifyFlock` (`engine.js:490-493`), skip members whose profile is `steady` (and any the classifier
   calls drone). Better still, keep a steady or classifier-drone track out of the flock group so it is
   reported on its own.
2. **Report a drone as its own group even inside a flock.** Today one drone member turns the whole flock
   into a drone group (`engine.js:488`). Keep the flock as birds and add the drone separately, so the
   tower sees "flock of 30 birds + 1 drone".
3. **Classify per track, not per event.** Feed `state.tracks[].bbox` to `classifyBoxes()` in one batch,
   cache the result by track ID, and re-check every ~1 s or when the box size changes a lot. Do not use
   the event's `crop_box` for this; for a flock it is the whole flock.
4. **Make the 200-piece cap fail softly.** Instead of returning zero blobs (`blobs.js:34`), keep the 200
   strongest or largest pieces, or raise the cap (200 separate dots cost only ~15 ms). Right now a sky with
   250 specks (a big distant flock plus noise) gives no detections at all.
5. **Help medium-tight flocks.** Birds 8-10 px apart at 320 px are counted at 25-45 % of the truth.
   Options: process flock regions at a higher resolution (640 px), use `distant_birds`-style settings
   (dilate 1, mergeGap 1) when many small blobs are present, or run the dark-core count on all blobs of
   ~10 px and up (not only 30 px and up with 5+ cores) so a 2-3 bird clump counts as 2-3.
6. **Handle merges at crossings.** When two predicted tracks both want the same blob, mark both as
   "merged" and let both coast on their predictions instead of giving the blob to one and starting a new ID
   later. A size cue helps too: a drone's size is steady, a bird's pulses. This would stop the drone label
   from jumping to a bird at a crossing.
7. **Fast objects:** a new track's first link is limited to `maxJump` 24 px per frame. Allow a larger
   first-link gate (or a second chance using two-frame direction) for small, consistent objects, or run at a
   higher frame rate. Real fast birds are also smeared and fainter, so expect worse than these numbers.
8. **Tiny objects:** consider switching to `distant_birds` settings automatically when the median blob is
   under ~6 px; in the probe it took 2 px birds from 18/20 (and 6/20 when faint) to 20/20.
9. **Hovering drone near a flock:** a nearly still drone never passes `minTravel` 2.5 px
   (`config.js:51`) and was tracked in only 6 % of frames. A separate "stationary but steady and
   contrasty" path to confirmation would help.
10. **Close flocks:** a flock merged into one blob larger than 4 % of the frame is dropped as a cloud edge
    (`config.js:32`), and more than 12 % of the sky changing is treated as camera shake (`config.js:24`).
    Neither was hit in these tests, but a big flock close to the camera could hit both.

## Reproduce everything

```
node "Shreyansh Local Ai Model/engine_flock_probe.mjs"            # Part A (~2 min; --quick for fewer seeds)
python3 "Shreyansh Local Ai Model/make_stress_set.py"             # Part B (~1 min)
python3 "Shreyansh Local Ai Model/eval_stress.py" --checkpoint X  # Part C (~30 s)
```
