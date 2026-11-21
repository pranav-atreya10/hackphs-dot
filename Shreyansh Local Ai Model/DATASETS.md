# Extra training data for the bird / drone / other classifier

Research done 2026-11-19. Nothing listed here has been downloaded into the repo. The only file
fetched was Mendeley's 10 KB "Raw DataSet links .xlsx", plus a few small label/metadata files used to
check the claims below (all kept in `/tmp`, outside the repo).

**Before downloading anything below, ask Vivan.** `benchmarks/BENCHMARK_PROTOCOL.md` section 7 says:
stop and ask before downloading anything other than ESC-50.

Reachability was tested from this workspace on 2026-11-19 with `curl -sI -m 15` (or a 1-byte ranged
GET) on the **actual download file**, not only the home page. "Yes" means HTTP 200/206 came back.

---

## 1. Ranked table (best first)

Ranking rule for training candidates: the licence allows training, the workspace can download it,
and it adds something Mendeley lacks (real sky backgrounds, distant objects, distractors).
Test-only candidates are marked separately.

| # | Dataset | Licence | Reachable? | Size | Format | Classes | Flocks / mixed bird+drone? | Leak risk vs Mendeley test |
|---|---|---|---|---|---|---|---|---|
| 1 | **Svanström Drone Detection Dataset** (Halmstad Univ.) | **CC0 1.0** (LICENSE file in the zip) | Yes (Zenodo) | 311 MB | 285 visible + 365 IR videos (10 s each), per-frame boxes (.mat) | drone, bird, airplane, helicopter | No flocks. A few clips have 2 drones. No bird+drone frames. | Very low (own recordings in Sweden) |
| 2 | **DUT Anti-UAV, detection part** (Dalian Univ. of Tech.) | **Apache-2.0** (authors' repo LICENSE) | Yes (Hugging Face mirror) | 1.39 GB (3 zips) | 10,000 images, Pascal VOC boxes | drone (UAV) | No | Low to medium (where the images came from is not documented) |
| 3 | **DCSkyCam Helicopter Classification** | **CC BY 4.0** | Yes (Hugging Face) | 495 MB | 8,100 ready-made sky **crops** (JPEG) | helicopter (5,153), not_helicopter (2,947: mostly birds, small planes, cloud blobs) | No | Very low (own Raspberry Pi sky camera, Washington DC) |
| 4 | **FBD-SV-2024** (flying birds in surveillance video) | Figshare says **CC BY 4.0**, but the description adds "for learning and research purposes only, **not for commercial use**" | Yes (figshare) | 1.79 GB | 483 videos (1280x720), boxes (labels inside .rar) | bird | No (about 1.2 birds per frame) | Very low (authors' own cameras) |
| 5 | **AirBirds** (real airport, bird-strike prevention) | **CC BY-NC-SA 4.0** (research/test-only if cleared; not a release source) | Yes (Hugging Face) | 176 GB total; one shard 11.7-21.7 GB; labels tiny | 1920x1080 images, YOLO boxes | bird | **Somewhat dense**: mean 4.8 birds/frame, max 32, 15% of frames have 10+ birds (measured on upstream train shard `labels9.zip`). Median width there was 5 px. | Different capture source from Mendeley; verify recording provenance and leakage before use |
| 6 | **AOD-4** (Air-borne Object Detection) | Package is **CC BY 4.0**, but ~45% of images are YouTube frames (see notes) | Yes (Mendeley) | 1.92 GB | 22,516 images 1024x1024, COCO / VOC / YOLO boxes | airplane, helicopter, drone, bird | Rare (max 36 objects in one image, 125 train images with 10+) | **Medium**: contains 748 Pexels bird photos (no ID match with Mendeley's 42 videos, but same website) |
| 7 | **Cranfield Synthetic Drone Detection** | **CC BY 4.0** | Yes (Hugging Face) | 54 GB total; zips of 0.9-7.7 GB | Rendered (synthetic) images with masks | drone, plus birds and distractors in some zips | **Yes, mixed**: `drones_with_birds_40m.zip`, `drones_realistic_distractors_40m.zip` | None (computer-generated) |
| 8 | **Drone and Bird Synthetic 10k** (athkot) | **CC BY 4.0** | Yes (Hugging Face) | 395 MB | 9,950 AI-generated 640x640 images, boxes + masks | drone, bird, airplane, helicopter | Max 2 classes per scene, so some bird+drone images | None (AI-generated) |
| 9 | **Open Images V7** (subset only) | Boxes **CC BY 4.0**; images "listed as" **CC BY 2.0** (Google says check each image) | Yes (storage.googleapis.com and the open-images-dataset S3 bucket) | Pick a subset; the train box CSV alone is 2.26 GB | Photos (Flickr), boxes | Bird, Airplane, Aircraft, Helicopter, Kite, Balloon, Insect, Parachute | Has "group-of" boxes for flocks (64 of 902 bird boxes in the validation split). Mostly not sky scenes. | Low (Flickr, not Pexels) |
| 10 | **Klim / Skagen birds** (Mid Sweden Univ., wind farms) | **CC BY 4.0** | Yes (api.researchdata.se) | 3.43 GB total (k-fold.zip 1.62 GB) | Monochrome frames, YOLO boxes | bird | No (about 1.2 birds per frame) | Very low (own cameras, Denmark) |
| 11 | **IBERBIRDS** | **CC BY 4.0** | Yes (Zenodo) | 4.57 GB | 4,000 photos of flying birds, YOLO boxes | 10 bird species | No (mid-to-long-range photos) | Low (where the photos came from is not stated) |
| 12 | **Airborne Object Tracking (AOT)**, Amazon Prime Air | **CDLA-Permissive 1.0** | Yes (public S3 bucket, no account needed) | Very large: 4,943 flights, each about 3-5 GB | 2448x2048 **grayscale** PNG sequences, boxes | airplanes, helicopters, birds and other airborne objects | Some | None (own flight recordings) |
| 13 | **MBAOD** (Multi-Background Airborne Object Detection) | **CC BY 4.0** | Yes (Mendeley) | 6.69 GB (.rar) | 35,106 clean images (+ weather variants), boxes | airplane, bird, helicopter, **kite, parachute**, UAV | Some multi-object | **High**: "compiled from multiple sources", which are not listed. It could even contain Mendeley 6ghdz52pd7 itself. |
| 14 | **Seraphim Drone Detection** | **CC BY 4.0** (aggregate) | Yes (Hugging Face) | 9.1 GB | 83,483 images 640x640, YOLO | drone | Multi-drone images | **High**: merged from 22 Roboflow/Kaggle sets plus #15 below. Includes marketing and synthetic images. |
| 15 | pathikg drone-detection-dataset (Pawełczyk & Wojtyra) | MIT, **for the labels only**. The images are YouTube frames (author's README). | Yes (Hugging Face) | 4.65 GB | 54k images, COCO boxes | drone | No | Medium. **Licence problem**: avoid. |
| 16 | Lookupjet ADS-B optical jets | **CC BY-NC 4.0** | Gated: needs a Hugging Face login and accepting terms | 2.2 GB | Frames of jets in the sky, COCO boxes | airplane | No | Very low |
| - | Anti-UAV300/410/600 | Unclear (MIT covers the code; the data has no stated licence) | Google Drive / Baidu / ModelScope; only third-party HF re-uploads | large | RGB+IR video (300), IR only (410/600) | drone | No | Low |
| - | Drone-vs-Bird Challenge (WOSDETC) | Research-only data agreement, by email | Not open | - | video | drone (+bird) | some | Unknown. **Not openly licensed: skip.** |
| - | Roboflow Universe and Kaggle "bird vs drone" sets | Varies (often CC BY 4.0) | **No** (Roboflow Universe: Cloudflare block; Kaggle: 404 without a login) | - | - | - | - | Often **high**: many are built from Pexels or YouTube clips |
| - | SOD4SB (MVA2023 birds), BirdCollect | No licence stated / cranes on the ground with point labels | Google Drive | - | - | bird | BirdCollect: about 190 birds per image, but **not in the sky** | - |

**Flocks of 50-60 birds:** no open, reachable dataset was found with dozens of birds in the sky in
most frames. The closest are AirBirds (up to 32 per frame, non-commercial) and Open Images "group-of"
bird boxes. For real 50+ flocks, the honest options are (a) the team's own field footage (tier 2) and
(b) compositing: paste many bird crops from CC0/CC BY sources (#1, #3, #4) onto empty-sky backgrounds.

**Mixed bird + drone in one frame:** only the synthetic sets (#7, #8) have this in quantity. Real
mixed frames are very rare (AOD-4 has 4 YouTube frames).

---

## 2. Notes per dataset

**1. Svanström Drone Detection Dataset.** https://zenodo.org/records/5500576. Made by Fredrik
Svanström at Halmstad University. It is the paper "A dataset for multi-sensor drone detection" (Data in
Brief, 2021). The zip has `LICENSE` = **CC0 1.0** (public domain). The README says "Free to download,
use and edit." Visible clips: 114 drone, 51 bird, 59 airplane, 61 helicopter. IR clips: 157 / 79 / 74
/ 55. Labels are MATLAB `.mat` files. `pip install mcos-decoder` (on PyPI, reachable) reads them in
Python. Objects range from close to very distant (up to 200 m), which is exactly the
"tiny distant object" case. **Exclude the 49 visible clips (38 helicopter, 11 airplane) whose
`Video_dataset_description.xlsx` row gives a YouTube channel as "INTERNET SOURCE".** They are someone
else's YouTube videos, not CC0. IR clips are grayscale thermal. Use them only if you want robustness;
the live camera is visible-light.

**2. DUT Anti-UAV (detection).** https://huggingface.co/datasets/aegean-ai/dut-anti-uav is a
byte-for-byte re-upload of the authors' Google Drive zips (SHA-256 listed in its README). The original
repo `wangdongdut/DUT-Anti-UAV` has an Apache-2.0 LICENSE (checked on raw.githubusercontent.com).
It has 10,000 visible images with 5,200 / 2,600 / 2,200 in train / val / test, VOC XML boxes, and
class `UAV`. The background mix and drone sizes were not checked here, so look at a sample first. Its own "test" split
is not our test set, so all of it may be used for training. Keep some aside for validation. The paper
does not say where every image came from, so run the leakage check.

**3. DCSkyCam Helicopter Classification.** https://huggingface.co/datasets/dcskycam/helicopter-classification.
These are already **crops around a detector box from a fixed sky camera**, which is almost exactly
what our tracker gives the model. "helicopter" crops become `other`. The 2,947 "not_helicopter" crops
are a mix. A random sample of 12 showed mostly birds against sky, plus small planes and cloud blobs.
**They must be hand-sorted** into bird / other before use. Do not put them all in one class.

**4. FBD-SV-2024.** https://figshare.com/articles/dataset/FBD-SV-2024/27377595. Paper arXiv
2409.00317. 483 clips from the authors' own outdoor surveillance cameras, 28,366 bird boxes. Most
birds are 10x10 to 70x70 px. Videos are in the zip; labels are in `labels.rar` (this workspace has no
`unrar`/`7z`, so it would need one installed). Licence conflict: the figshare licence field says
CC BY 4.0, but the description says "not for commercial use". Treat it as **non-commercial**. That is
fine for a school project, but drop it if SkySentry is ever sold.

**5. AirBirds.** The [authors' project page](https://airbirdsdata.github.io/) and
[dataset card](https://huggingface.co/datasets/auniquesun/AirBirds) specify non-commercial research
and educational use only, under [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/).
The authors extracted 1920x1080 time-series frames from videos at one airport. The card documents
normalized YOLO boxes for birds only, including empty label files for bird-free frames. Shards 0-9
are the upstream training set; the published test split names two dated `D02` sequences, not many
independent airport sessions. The earlier 5 px figure is box **width** on one upstream training shard,
not the longest-side distribution of the test set. See the intake and permission requirements below.

**6. AOD-4.** https://data.mendeley.com/datasets/cd5z895tr2/1. Licence CC BY 4.0, but Mendeley's own
licence text says "further permission may be required for any content ... belonging to a third
party". The train annotations were read, and the file names show the sources: ~7,100 frames named
`yt-<YouTube id>` (YouTube), ~3,700 Anti-UAV frames, ~3,450 frames named `V_DRONE/V_AIRPLANE/V_HELICOPTER_*`
(these are **Svanström #1 frames**), 748 `pexels-*` bird photos, ~700 Unsplash bird photos.
**If used, drop every `yt-*` image** (the team rule: no YouTube). Also drop the `V_*` frames if #1
is used, or they will be counted twice. What remains (Pexels/Unsplash bird photos plus Anti-UAV
drones) is moderately useful. The Pexels photo IDs found (183) do not match any of Mendeley's 42 Pexels
video IDs, but they come from the same website, so run the pHash check.

**7. Cranfield synthetic.** https://huggingface.co/datasets/mazqtpopx/cranfield-synthetic-drone-detection
(paper arXiv 2411.09077). Rendered drones, some zips with birds and realistic distractors. Good for
"bird and drone in the same scene". It is synthetic, so check that it helps on the real test set,
one version at a time.

**8. Drone and Bird Synthetic 10k.** https://huggingface.co/datasets/athkot/drone-vs-bird-synthetic-10k.
FLUX-generated images, auto-labelled by SAM 3, checked by a vision-language model, and no human
labels. It is small and easy to try, but quality is unknown. Treat it like #7.

**9. Open Images V7.** https://storage.googleapis.com/openimages/web/factsfigures_v7.html. Download
only the classes needed, by image ID, from `https://open-images-dataset.s3.amazonaws.com/<split>/<ImageID>.jpg`.
This is the best open source for **kites, balloons, parachutes and insects** as distractors. Many photos
are close-ups on the ground, so filter for sky backgrounds.

**10. Klim / Skagen.** https://researchdata.se/en/catalogue/dataset/2021-316-1. Birds near wind
farms, monochrome wide-angle cameras. The k-fold zip has 8,600 image files spread over 5 folds, so
there are fewer unique frames.

**11. IBERBIRDS.** https://zenodo.org/records/15090760. Good-quality flying-bird photos with boxes.
They are larger and closer than airport birds.

**12. AOT.** https://registry.opendata.aws/airborne-object-tracking/. Real far-away aircraft and
birds filmed from an aircraft. It is grayscale and huge. Only worth it if you take one or two flights
(`aws s3 sync --no-sign-request s3://airborne-obj-detection-challenge-training/part1/Images/<flight_id> ...`).

**13. MBAOD.** https://data.mendeley.com/datasets/zfc8hndczp/1. It is the only reachable open set
with **kite** and **parachute** boxes. Sources are not listed and it is a 6.7 GB RAR, so contents
could not be checked. Assume it may contain Mendeley 6ghdz52pd7 or the same Pexels clips until the
pHash check says otherwise.

**14-15. Seraphim / pathikg.** These are large drone-only collections. Seraphim's README lists its
22 Roboflow/Kaggle sources, and it includes #15, whose images are YouTube frames (its README says the
MIT licence covers the labels only). There is a real risk of Pexels drone clips appearing here, and
of images whose copyright was never cleared. Use them last, if ever.

---

## 3. Recommended next downloads (at most 3, ask Vivan first)

These three cover the headline metrics. #1 and #2 add many new **drones** (drone recall), and #1 and
#3 add real **airplanes, helicopters and sky birds** (false-alarm rate). All three are permissively
licensed (CC0 / Apache-2.0 / CC BY 4.0, commercial use allowed), reachable from this workspace, and
small. Together they are about 2.2 GB.

1. **Svanström Drone Detection Dataset (CC0)**, 311,348,350 bytes (311 MB)
   `https://zenodo.org/api/records/5500576/files/DroneDetectionThesis/Drone-detection-dataset-v1.0.0.zip/content`
   Then: `pip install mcos-decoder`, use visible clips only, and skip the 49 YouTube-sourced rows in
   `Video_dataset_description.xlsx`. Split train/valid **by clip, never by frame**.

2. **DUT Anti-UAV detection (Apache-2.0)**, 1.39 GB total
   - `https://huggingface.co/datasets/aegean-ai/dut-anti-uav/resolve/main/detection/train.zip` (744.6 MB)
   - `https://huggingface.co/datasets/aegean-ai/dut-anti-uav/resolve/main/detection/val.zip` (372.3 MB)
   - `https://huggingface.co/datasets/aegean-ai/dut-anti-uav/resolve/main/detection/test.zip` (271.2 MB)
   Check each zip's SHA-256 against the dataset README.

3. **DCSkyCam Helicopter Classification (CC BY 4.0)**, about 495 MB (8,100 small JPEGs + `metadata.csv`)
   `hf download dcskycam/helicopter-classification --repo-type dataset`
   (or `huggingface_hub.snapshot_download("dcskycam/helicopter-classification", repo_type="dataset")`).
   Page: https://huggingface.co/datasets/dcskycam/helicopter-classification
   Hand-sort the `not_helicopter` crops into bird / other first.

FBD-SV-2024 and AirBirds are not routine training downloads; see their separate license and test-only
notes above.

Attribution: CC BY sources need credit (name, link, licence) in the README / model card.

---

## 4. Leakage-check plan

**What Mendeley was built from.** The "Raw DataSet links .xlsx" lists **42 Pexels stock videos**
(23 bird, 19 drone), not YouTube. Pexels video IDs:
bird: 4713259, 10184756, 5057337, 3826855, 5614748, 14303142, 4849093, 5570169, 5853148, 6113966,
7037850, 4438384, 11760741, 2402369, 7722592, 14346624, 3440391, 14265468, 14195903, 14606411,
14195904, 3564297, 3320544.
drone: 4124907, 3764259, 5009335, 14297349, 3643613, 4446309, 9940813, 3723537, 9940815, 5203928,
8239187, 8459631, 10277987, 10393579, 10530074, 12738673, 12901425, 10659644, 12147662.
(Several "bird" videos show perched birds on branches, fences or grass, not birds in the sky.)

So the danger is **any dataset that also used Pexels footage**. Among the candidates that means AOD-4
(Pexels photos), MBAOD (unknown sources), Seraphim and any Roboflow/Kaggle set. #1-#4, #7, #8, #10 and
#12 are the authors' own recordings or synthetic, so the risk there is very low. They still get checked.

Note: Mendeley's own train and test splits were cut from these same 42 videos. Mendeley-test scores
are therefore already optimistic, whatever new data is added. (The existing `leakage_report.json`
found no pHash near-duplicates at distance 6 or less between Mendeley train and test, but that does
not mean they come from different videos.)

**Steps for each new dataset, before any training run:**

1. **Source check (by name).** Search file names, metadata and READMEs for `pexels`, the 42 IDs
   above, `B (`/`D (`-style Mendeley names, and `6ghdz52pd7`. Any match: remove that whole source
   video or clip, not just the matching frames.
2. **Whole-image pHash (the repo tool).** Extract frames (videos: e.g. 1 frame per second) into a
   folder, then run
   `.venv/bin/python benchmarks/leakage_check.py --images data/<new_set>/frames`.
   It compares against every frozen test image in `test_sets.json`. Exact SHA-256 duplicates and
   pHash Hamming distance ≤ 6 count as leaks. **Caution:** the script overwrites
   `benchmarks/leakage_report.json`. Copy the old one first, or save each report under a new name.
3. **Look at the closest pairs.** pHash on mostly-empty sky can give false alarms (two plain skies
   look alike), and different crops of the same video can give misses. Open the 50 closest
   test/train pairs from the report's `examples` and decide by eye. If a pair is from the same
   scene, remove that whole source clip.
4. **Group by source for our own validation split.** Frames from one video or clip go entirely into
   train or entirely into valid, never both. Also dedupe **between** new sets (AOD-4 contains
   Svanström frames).
5. **Record it.** Put the leakage numbers next to the result (protocol section 6). If anything leaks,
   stop and ask Vivan.

## 5. v5 train/SELECT preflight

From the repo root, on Python 3.11+ with NumPy and Pillow:

```powershell
python 'Shreyansh Local Ai Model\sources\verify_corpus.py' --data-root 'D:\path\to\audited-corpus'
```

Omit `--data-root` to check the worktree's `data` directory. The verifier is read-only and does not
need PyTorch, a GPU, or test media. It checks a supplied bundle, not a crop preparation pipeline.
No audited training bundle was materialized or verified here. `--inventory-only` emits
the observed SHA-256 lock for review, **not permission to fit**. Only the normal mode (or the
`sources.verify_corpus.verify_corpus(data_root)` API) enforces the audited evidence. Use the same
read-only bundle for verification and training; retain the returned JSON with the run.

| Source(s) | Exact train/SELECT inputs relative to the data root | Preparation and attribution |
|---|---|---|
| `mendeley` | `shreyansh_crops_v2`: `fit_{X,y}.npy`, `holdout_{X,y}.npy`, `row_lineage.npz` | [6ghdz52pd7 v5](https://data.mendeley.com/datasets/6ghdz52pd7/5), CC BY 4.0 plus underlying Pexels terms. `prepare_v2.py` uses the pinned **TRAIN-derived** `split.json`, not published VALID. |
| `svanstrom` | `shreyansh_crops_v3`: `svan_{train,select}_X.npy` and matching `_meta.npz` | [Svanstrom et al.](https://zenodo.org/records/5500576), CC0 1.0; `prepare_svanstrom.py` uses whole visible clips. The 49 YouTube clips are test-only. |
| `aod4` | `shreyansh_crops_v4`: `<source>_{train,select}_{X.npy,meta.npz,info.json}` for each of the eight v4 sources | [AOD-4](https://data.mendeley.com/datasets/cd5z895tr2/1), package CC BY 4.0; `aod4.py` drops YouTube and Svanstrom copies. Review the remaining third-party rights, including Anti-UAV frames. |
| `dcskycam` | Same v4 layout | [DCSkyCam](https://huggingface.co/datasets/dcskycam/helicopter-classification), CC BY 4.0; `dcskycam.py` uses labelled helicopter crops only; pin the provider commit and per-file digests. |
| `dut_anti_uav` | Same v4 layout | [DUT Anti-UAV](https://huggingface.co/datasets/aegean-ai/dut-anti-uav), Apache-2.0 reported by the authors; `dut_anti_uav.py` uses the detection archives, independently regrouped. Verify rights to the images as well as repo code. |
| `iberbirds` | Same v4 layout | [IBERBIRDS](https://zenodo.org/records/15090760), CC BY 4.0; `iberbirds.py` groups likely bursts. |
| `klim_skagen` | Same v4 layout | [Klim/Skagen](https://researchdata.se/en/catalogue/dataset/2021-316-1), CC BY 4.0; `klim_skagen.py` uses `models-Klim.zip` and `Test-Skagen.zip`, and groups frame blocks per site. |
| `openimages` | Same v4 layout | [Open Images](https://storage.googleapis.com/openimages/web/factsfigures_v7.html), boxes CC BY 4.0; retain the pinned CC BY 2.0 per-image credits for every group used by `openimages.py`. Lock the exact metadata and JPEG inputs. |
| `synth_athkot` | Same v4 layout | [athkot, pinned release](https://huggingface.co/api/datasets/athkot/drone-vs-bird-synthetic-10k/tree/27c462c54d4208d7691e0a90af60e8bc1699da4a/yolo), CC BY 4.0; `synth.py` uses `dataset-yolo.zip` (394,513,209 bytes) and image stems as groups. |
| `synth_cranfield` | Same v4 layout | [Cranfield, pinned release](https://huggingface.co/api/datasets/mazqtpopx/cranfield-synthetic-drone-detection/tree/7657fcbb1ada0f5210e2c198c78742108e2430ee), CC BY 4.0; cite the [dataset paper](https://arxiv.org/abs/2411.09077). `synth.py` uses `multi_drone_no_birds_40m_small.zip` (885,888,520 bytes) and render runs. Its legacy pHash skip is not audit clearance. |

`row_lineage.npz` is an additional producer receipt: `fit_image`, `fit_group`, `holdout_image`,
`holdout_group`, each a 1-D Unicode array with one entry per corresponding v2 crop, in crop row
order. Record this at preparation time using the input filename and original sequence grouping.
The old v2 crop/label pairs do not have this mapping. Do not invent groups from crop counts or assign
each crop a unique group. The verifier checks the pinned holdout and drop lists, disjoint groups,
and Svanstrom clip roles against `svanstrom_split.json`. The v4 inputs must agree with the group
split rule and crop summaries. The frozen manifest and tracked credits are pinned at `fd85c001`
(text digest normalizes CRLF); the verifier does not open frozen media.

The approved packager keeps the audit records and supplies `v5_corpus_evidence.json` beside the
three crop directories, with:

- `schema_version: 1` and `files`, the **exact** root-relative SHA-256 map from `--inventory-only`.
- `sources`, keyed by the ten source names. Each entry has the pinned `revision`, `input_bytes`,
  `upstream_manifest_sha256` (digest of the reviewed per-file sizes/digests), `attribution` (credit,
  origin and terms), `rights_review` (reviewer and record), and `train_select_rights_confirmed: true`.
  For sources with `ARCHIVE_PINS` in the verifier, include `archive_digests` keyed by those names with
  full `sha256:<hex>` or `md5:<hex>` digests. Use the full published pins (including the two
  Hugging Face LFS SHA-256s), not an extracted-folder marker.
- `duplicate_audit` with `review` (reviewer and traceable report), `max_hamming: 6`,
  `svan_test_phash_sha256`, `fbd_sv_excluded: true`, and `checks` for `train_vs_select`,
  `cross_source`, and `train_select_vs_mendeley_and_svanstrom_tests`. Each check records positive
  `items_checked`, zero `exact_matches`, zero `unresolved_phash_matches` and zero
  `overlapping_groups`. Review raw recording/source aliases across sources, not just
  identical crop bytes or group names. This is verified against the supplied bundle hashes, not
  a repeat of the pixel audit; do not make a receipt from synthetic results or old summaries alone.

For preparation, retain the pinned Mendeley test images and Svanstrom reference cache
`shreyansh_crops_v4\svan_test_phash.npy` (nonempty `uint64` vector, derived from the frozen clips).
`common.leak_check` requires both and checks the Mendeley image SHA-256s before computing pHashes.
Mendeley's published train and test still share underlying Pexels recordings; that score is not
independent. If the audit cannot clear recording-group overlap, do not issue a passing receipt.
**Do not place FBD-SV in staging, training, selection, or the duplicate audit.** Keep
the frozen FBD-SV assets separate for the final unseen-source headline and grouped confidence ranges.

Do not run the legacy download/prep scripts against an existing data folder: several delete raw or
extracted files. Before any new provider fetch, verify licence, pinned sizes and hashes, peak
archive + extraction + crop/memmap space with a reserve, and shared access from the trainer. Use one
bounded staging root, not one copy per worktree. No crop files, source archives or audit receipts
belong in Git.

## 6. Real small-bird evidence intake

**Status: no new footage or evaluation.** The Svanström 7/10/13 px rows shrink the same held-out
videos and measure simulated distance, not independent sightings of originally tiny birds. Its
native-size v4.1 test has no birds in the reported 7-15 px bin. Existing source-specific results are
not a substitute for an independent airport evaluation at those sizes.

Use AirBirds only for isolated, non-commercial research evaluation if the intended use and access
terms are confirmed before obtaining media; otherwise leave it blocked (or obtain written permission
from the rights holders). Keep permitted media private and separate from fit, tuning, weights,
releases, and public galleries. Record the pinned revision, license, attribution and provenance.
An upstream split or archive name is not proof of an independent recording. The same requirements
for source provenance and leakage apply to any separately authorized field data.

From this folder, run `python small_bird_preflight.py path-to-intake.json`. It reads local, private
JSON metadata and prints coverage counts; it does not fetch, freeze, inspect images, or score
anything. Supply:

- `used_source_groups`: a nonempty, audited inventory of original recording/session IDs already
  used in development, including training lineage, model selection, tuning and viewed evaluations.
- `frames`: one object per original frame, with `source_group`, `frame_id`, `geometry: "native"`,
  `frame_size: [width, height]`, and `bird_boxes_xyxy` (pixel `[x1, y1, x2, y2]` boxes; `[]` for a
  verified bird-free frame). Use decoded native-frame dimensions to denormalize YOLO annotations;
  never use the 32 px minimum crop, the 64 px model input, or a resized frame to assign size.

Use the same canonical source-group ID for related captures and all copies or excerpts of a
recording, across inventories and datasets. Resolve aliases and unknown provenance before intake;
matching strings only detects overlap in the supplied inventory. Count the longest native box side
in `<7`, `7-15` (both endpoints included), and `>15` px; these are not the benchmark's area-fraction
tags. The check rejects non-native rows and known source-group overlap. It cannot grant permission,
verify provenance, replace SHA-256/pHash checks or authorize a holdout run.

Before reporting performance, approve and checksum-freeze an independent cohort under the
[benchmark protocol](../benchmarks/BENCHMARK_PROTOCOL.md). Predefine size strata and minimum
independent recording coverage per stratum. Report recall, bird-to-drone errors and counts by size;
separate annotated-box classification from native full-frame tracking/detection (including missed
tracks). Report 95% CIs from 1,000 fixed-seed bootstrap resamples of whole independent sessions,
not crops, boxes or overlapping vote windows. Sparse or single-session bins are insufficient
evidence regardless of frame count. Performance on a bird-only collection does not measure drone
recall or operational false alarms per hour; those require independent truth and timed exposure.

---

## Sources checked

- Mendeley API: `6ghdz52pd7`, `cd5z895tr2` (AOD-4), `zfc8hndczp` (MBAOD). All CC BY 4.0.
- Zenodo API records 5500576, 15090760, 18281801; figshare API article 27377595.
- Hugging Face dataset cards and file lists for the HF sets above.
- Svanström zip: `LICENSE` (CC0 1.0) and `Video_dataset_description.xlsx` read via HTTP range requests.
- AOD-4: train `_annotations.coco.json` read via HTTP range requests (file-name sources counted).
- AirBirds: `labels9.zip` downloaded (2.4 MB) to measure birds per frame.
- Open Images: validation box CSV (25 MB) downloaded to count class and group-of boxes.
- GitHub READMEs: DroneDetectionThesis/Drone-detection-dataset, wangdongdut/DUT-Anti-UAV (LICENSE),
  Maciullo/DroneDetectionDataset, wosdetc/challenge, ZhaoJ9014/Anti-UAV.
