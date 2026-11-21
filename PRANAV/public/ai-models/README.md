# Browser bird verification assets

SkySentry serves these public pretrained assets from its own server. They load only when a tower operator enables the local check. The checked-in scripts, manifest, and weights total 19,887,101 bytes (about 19 MiB before transport compression). The model is COCO-SSD, not a drone detector, and tiny distant birds may not produce a useful label.

Upstream assets:

- TensorFlow.js 3.21.0: https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@3.21.0/dist/tf.min.js
- COCO-SSD 2.2.2: https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.2/dist/coco-ssd.min.js
- Lite MobileNet v2 model manifest: https://storage.googleapis.com/tfjs-models/savedmodel/ssdlite_mobilenet_v2/model.json
- Every weightsManifest path in that manifest, resolved under the same model directory, is required in `coco/`.

TensorFlow.js and TensorFlow.js Models are published by Google under the Apache 2.0 license. Original license headers are retained in the script files. Official projects: https://github.com/tensorflow/tfjs and https://github.com/tensorflow/tfjs-models/tree/master/coco-ssd.

The faster motion tracker stays active during model loading and inference. The browser does not upload crops for review. If cloud evidence review is explicitly enabled, the server can send an authenticated, frame-bound crop from a server-tracked camera to the provider. Local checks and cloud results are advisory, not a change to risk or a clearance. This is a project demonstration, not a validated aviation safety system.
