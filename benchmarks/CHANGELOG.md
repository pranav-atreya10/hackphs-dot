# Detection changelog

One entry per version: hypothesis, decision, reason. Reverted versions stay.

## Test-set change: dataset/visual re-frozen (2026-10-11T00:46:58Z)

Approved by Vivan: published Mendeley v5 labels put birds and drones in one class id (only 89 of ~380 bird boxes in test were class 1; all train/valid boxes class 0), so classes now come from file names (B=bird, D=drone) and the one doubly-annotated object (BT (21)) is merged. Near-duplicate consecutive frames (889 images -> ~176 groups) now carry a group id so bootstrap CIs resample groups. No results existed on the old freeze.
Old version archived: `benchmarks/test_sets_archive/dataset_visual_2026-10-11T004658Z.json`.
