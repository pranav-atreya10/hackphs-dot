# SkySentry models: what they are, where the numbers live, how to run them locally

Every model and setting is stored in an open, documented file with a version and a checksum, so it can move to a
local or open-source runtime without rewriting anything.

| Part | What it decides | Portable file(s) | Runs locally today? |
|---|---|---|---|
| Detection engine | Motion, tracking, wingbeat, debris, flocks, forecast, risk | `VIVAN/detection/models/engine_config.json` (every setting, preset and allowed range) | Yes: plain JavaScript, in the browser, phone or server |
| Drone-sound model | "Is there a drone sound in this 1 s?" | `VIVAN/detection/models/drone_audio_v0.json` (browser weights), `.onnx` (ONNX), `.card.json` (how to feed it) | Yes: the browser runs the JSON; the ONNX runs in onnxruntime anywhere |
| Bird judge | "Is this crop really a bird?" (second opinion) | `PRANAV/ai-voice/bird-judge.spec.json` (rubric, answer schema, labels, confidence floor, sampling) | Switchable: `BIRD_JUDGE=gemini` (default) or `local` |
| COCO-SSD | Optional bird check in the tower | TensorFlow.js files in `PRANAV/public/ai-models` | Yes: open model, runs in the browser |

The OpenAI assistant and the Gemini incident reports are not part of this (they stay cloud services).

## Detection engine settings

`engine_config.json` is generated from `src/config.js` and `src/params.js`: `node VIVAN/detection/tools/export-config.mjs`.
A server test fails if it falls out of date. Presets are partial overrides, deep-merged onto the defaults.
Settings were last tuned with `node VIVAN/detection/tools/autotune.mjs` (report in `VIVAN/detection/tuning/`).

## Drone-sound model

- **Train:** `.venv/bin/python benchmarks/train/train_audio.py --out models/audio/vN_audio.pt [--noise_aug DIR] [--extra_negatives DIR]`
  (needs `data/dads` shards and, for the options, ESC-50 folds 4–5 only). Training metadata lands in `models/audio/vN_audio.pt.json`.
- **Score:** `.venv/bin/python benchmarks/eval_audio_holdout.py --model <.pt or .json> --out benchmarks/audio_holdout/vN.json`
  (held-out DADS shards 3/36, ESC-50 folds 1–3 look-alikes, noisy mixes; 95% CIs). Results so far: `benchmarks/CHANGELOG.md`.
- **Export for the browser:** `.venv/bin/python benchmarks/export_audio_web.py --weights models/audio/vN_audio.pt --out VIVAN/detection/models/drone_audio_vN.json`
- **Export to ONNX:** `.venv/bin/python benchmarks/export_audio_onnx.py --json VIVAN/detection/models/drone_audio_vN.json`
  Both exports are checked against stored reference outputs, so all three formats give the same answers.

Using the ONNX file from Python:

```python
import onnxruntime as ort, numpy as np
sess = ort.InferenceSession("drone_audio_v0.onnx")
prob = sess.run(None, {"logmel": logmel})[0]   # logmel: float32 [batch, 1, 64, 101], made as described in the .card.json
```

## Bird judge: moving from Gemini to a local model

1. Install [Ollama](https://ollama.com) (or LM Studio / llama.cpp / vLLM) and a vision model: `ollama pull qwen2.5vl:7b`.
2. Set `BIRD_JUDGE=local` (defaults: `LOCAL_JUDGE_URL=http://localhost:11434/v1`, `LOCAL_JUDGE_MODEL=qwen2.5vl:7b`).
   `/health` shows `bird_judge: local qwen2.5vl:7b: live` once it answers.
3. Measure it before trusting it: `cd PRANAV && npm run export-judge` (needs `MONGODB_URI`; set `SAVE_JUDGE_IMAGES=on`
   for a while first to collect crops), then `npm run eval-local-judge -- judge-dataset --model qwen2.5vl:7b`.
   It reports agreement with Gemini per label and how many real birds it called "not_bird".
4. If it isn't good enough, fine-tune it on `judge-dataset/train.jsonl`. The file is in the chat layout LLaMA-Factory
   and similar tools read (system = rubric, user = image + hint, assistant = the JSON answer), then score again on `test.jsonl`.

The judge always answers in the same JSON shape, and a model that fails or is unsure gives "uncertain", never a guess.
