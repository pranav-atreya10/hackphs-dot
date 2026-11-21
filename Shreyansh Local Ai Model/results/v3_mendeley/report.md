# SkyNetLite evaluation: v3_mendeley

Checkpoint `/home/claude/pranav-atreya10/hackphs-dot/Shreyansh Local Ai Model/runs/v3/best.pt` (SHA-256 `7b47e5ea0ca4f468...`), run 2026-11-19T18:46:53Z.

Every number below comes with a **95% confidence interval** in brackets: the range the true value probably lies in, given how many test pictures we have. Wide brackets mean "we don't know this precisely yet". The 889 test images are mostly frames from a few videos, so they were grouped into 176 groups of near-identical frames, and the brackets are computed by resampling whole groups (protocol section 5). That makes them honest but wide.

## Headline numbers

- **Drone recall: 100.0% (100.0% to 100.0%)**: of 526 real drones, the share the model called "drone".
- **False-alarm rate: 5.9% (4.5% to 7.8%)**: of 2667 empty sky / background squares, the share the model called "bird" or "drone".
- Overall accuracy: 95.6% (94.1% to 96.6%) over all 3571 crops.
- Bird recall: 99.7% (99.1% to 100.0%) of 378 real birds called "bird".
- Birds called drones: 0.3% (0.0% to 0.9%). Drones called birds: 0.0% (0.0% to 0.0%).
- Balanced accuracy (average of bird, drone and other recall): 97.9% (97.3% to 98.4%).

Note: 2667 of the 3571 crops (75%) are "other" squares, so overall accuracy leans heavily on how well the model recognises empty sky. Read drone recall and false-alarm rate first.

## All overall numbers

| Metric | Value (95% CI) | n (denominator) |
|---|---|---|
| Overall accuracy | 95.6% (94.1% to 96.6%) | 3571 |
| Balanced accuracy (mean of the 3 recalls) | 97.9% (97.3% to 98.4%) | 3571 |
| Drone recall | 100.0% (100.0% to 100.0%) | 526 |
| Bird recall | 99.7% (99.1% to 100.0%) | 378 |
| Other recall | 94.1% (92.2% to 95.5%) | 2667 |
| Drone precision | 85.5% (80.0% to 89.7%) | 615 |
| Bird precision | 84.5% (76.3% to 89.6%) | 446 |
| Other precision | 100.0% (100.0% to 100.0%) | 2510 |
| False-alarm rate | 5.9% (4.5% to 7.8%) | 2667 |
| Birds called drones | 0.3% (0.0% to 0.9%) | 378 |
| Drones called birds | 0.0% (0.0% to 0.0%) | 526 |

Recall = of the real X's, how many were called X. Precision = of everything called X, how many really were X.

### Confusion matrix (counts; rows = truth, columns = what the model said)

| truth \ model said | bird | drone | other | total |
|---|---|---|---|---|
| **bird** | 377 | 1 | 0 | 378 |
| **drone** | 0 | 526 | 0 | 526 |
| **other** | 69 | 88 | 2510 | 2667 |

## By object size

Size = box area / image area: small < 1%, medium 1-10%, large > 10% (tags stored in the manifest). "Other" squares carry the size tag of the real box whose square size they copied.

| Size | crops (bird / drone / other) | groups | Accuracy | Drone recall | Bird recall | False-alarm rate | Birds called drones | Drones called birds |
|---|---|---|---|---|---|---|---|---|
| small | 957 (8 / 73 / 876) | 137 | 93.5% (91.6% to 95.0%) | 100.0% (100.0% to 100.0%) | 87.5% (0.0% to 100.0%) | 7.0% (5.5% to 8.7%) | 12.5% (0.0% to 100.0%) | 0.0% (0.0% to 0.0%) |
| medium | 1829 (105 / 211 / 1513) | 161 | 95.3% (93.0% to 96.8%) | 100.0% (100.0% to 100.0%) | 100.0% (100.0% to 100.0%) | 5.7% (3.8% to 8.3%) | 0.0% (0.0% to 0.0%) | 0.0% (0.0% to 0.0%) |
| large | 785 (265 / 242 / 278) | 151 | 98.7% (97.5% to 99.6%) | 100.0% (100.0% to 100.0%) | 100.0% (100.0% to 100.0%) | 3.6% (1.0% to 8.6%) | 0.0% (0.0% to 0.0%) | 0.0% (0.0% to 0.0%) |

## By sky condition

Condition tags (clear, cloudy, backlit, cluttered) are stored per image in the manifest.

| Condition | crops (bird / drone / other) | groups | Accuracy | Drone recall | Bird recall | False-alarm rate | Birds called drones | Drones called birds |
|---|---|---|---|---|---|---|---|---|
| clear | 1710 (124 / 308 / 1278) | 94 | 93.9% (91.3% to 95.8%) | 100.0% (100.0% to 100.0%) | 100.0% (100.0% to 100.0%) | 8.1% (5.6% to 11.6%) | 0.0% (0.0% to 0.0%) | 0.0% (0.0% to 0.0%) |
| cloudy | 573 (69 / 81 / 423) | 24 | 98.3% (96.5% to 99.4%) | 100.0% (100.0% to 100.0%) | 100.0% (100.0% to 100.0%) | 2.4% (0.8% to 4.9%) | 0.0% (0.0% to 0.0%) | 0.0% (0.0% to 0.0%) |
| backlit | 460 (42 / 73 / 345) | 22 | 94.3% (78.1% to 97.1%) | 100.0% (100.0% to 100.0%) | 100.0% (100.0% to 100.0%) | 7.5% (3.9% to 29.2%) | 0.0% (0.0% to 0.0%) | 0.0% (0.0% to 0.0%) |
| cluttered | 828 (143 / 64 / 621) | 39 | 97.8% (96.6% to 99.0%) | 100.0% (100.0% to 100.0%) | 99.3% (96.9% to 100.0%) | 2.7% (1.1% to 4.3%) | 0.7% (0.0% to 3.1%) | 0.0% (0.0% to 0.0%) |

Cells with fewer than 30 crops have very wide brackets; don't read much into them: size:small (bird_recall: 8 crops).

## What this test does and does not show

- This is **Tier 1 only**: the Mendeley dataset's own test split (pre-cut boxes around objects in 640x640 images). It is **not field footage**. The real app sees crops around tracker boxes from our own cameras, which can be blurrier, smaller and messier. Tier 2 (our own footage) is not run here.
- The model only sorts crops someone already found. It does not test finding the object in the first place.
- "Other" crops are random sky / background squares from the same test images, with no bird or drone in them. Real distractors (planes, helicopters, insects, kites) are not in this test.
- "Other" squares are smaller than object squares (median side 205 px vs 388 px), because a big empty square rarely fits beside a big object. Compare sizes using the size table above, not just the overall numbers.

### 99% target

**No.** The lower end of the overall-accuracy bracket is 94.1%, not above 99%, so this run does **not** show the 99% target is met, even on Tier 1. Meeting 99% on Tier 1 would still not show 99% in the field.

### Leakage check (protocol section 6)

Existing image check `benchmarks/leakage_report.json`: 0 exact duplicates and 0 test images with a near-duplicate among 18323 Mendeley train images. The valid split was not part of that check.

## Reproducibility

- git commit `45f47a52d53c3824109169ea08da8614f8e259fd` (working tree dirty: True; this folder tracked by git: False)
- torch 2.15.0+cpu, numpy 2.5.3, Pillow 12.3.0, Python 3.13.18
- CPU: Intel(R) Xeon(R) Processor @ 2.10GHz, 2 cores available, 2 torch threads
- seeds: other crops 1234, bootstrap 0 (1000 group resamples)
- runtime 7.7 s; all 1778 test files passed SHA-256 verification
