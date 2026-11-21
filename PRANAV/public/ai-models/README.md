# Browser bird verification assets

## SkySentry v4.1 export

The tower loads the first-party v4.1 browser classifier only after **Enable v4.1 browser check**. A worker classifies matching frames, and the page averages five distinct probability vectors per ongoing track before displaying a `bird`, `drone`, or `other` advisory. It never writes live labels, changes risk or alerts, or provides clearance.

The browser rotates among camera feeds and samples up to eight tracks in one batch every 350 ms when the worker is free. On slower devices or busy multi-camera views, a track may stay at **collecting** if it is not sampled again before the three-second vote window expires. A missing advisory does not indicate a clear scene.

The immutable export from `Shreyansh Local Ai Model/` at `fd85c001` is served at `/ai-models/skysentry_classifier.js` and `/ai-models/skysentry_classifier.json`. Run `npm --prefix PRANAV run sync-web` from the repository root to copy the export or `npm --prefix PRANAV run check:web` to verify its exact bytes.

The browser does not upload crops for inference or review. If cloud evidence review is allowed by the deployment and the operator explicitly opts in, the server can send an authenticated, frame-bound crop from a server-tracked camera to the provider. A separately configured local server judge does not enable cloud review. This is a project demonstration, not a validated aviation safety system.

## Legacy COCO-SSD files

The previous pretrained COCO-SSD assets remain available for the legacy adapter but are not loaded by the tower's v4.1 browser check. The checked-in scripts, manifest, and weights total 19,887,101 bytes (about 19 MiB before transport compression).

Upstream assets:

- TensorFlow.js 3.21.0: https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@3.21.0/dist/tf.min.js
- COCO-SSD 2.2.2: https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.2/dist/coco-ssd.min.js
- Lite MobileNet v2 model manifest: https://storage.googleapis.com/tfjs-models/savedmodel/ssdlite_mobilenet_v2/model.json
- Every weightsManifest path in that manifest, resolved under the same model directory, is required in `coco/`.

TensorFlow.js and TensorFlow.js Models are published by Google under the Apache 2.0 license. Original license headers are retained in the script files. Official projects: https://github.com/tensorflow/tfjs and https://github.com/tensorflow/tfjs-models/tree/master/coco-ssd.
