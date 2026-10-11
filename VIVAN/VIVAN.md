This is the file for Vivan. Refer to AI.md for reference.

## Optional trained bird verification
Tower now checks sufficiently large, stable tracked crops with COCO-SSD, using locally served TensorFlow/model assets. It adds bird evidence without inventing a drone class and keeps the motion pipeline active when disabled or unavailable. Tests verify label fusion and reject stale/invalid labels. No frozen dataset, training weights or held-out test manifest was changed. Synthetic startup regressions are separate from the benchmark protocol and do not establish drone recall or false-alarm rate.
