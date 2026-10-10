// Drop-in slot for your own bird model. Pick "Custom model" on the camera page to use it.
//
// Fill in load() and detect(). detect() must return birds only, as
//   [{ x, y, width, height, score }, ...]   in pixels of the <video> frame (x, y = top-left).
// Tracking, risk scoring, snapshots and sending to the server all happen downstream, unchanged.
//
// Example for a TensorFlow.js graph model exported to ./models/bird/model.json:
//
//   await loadScript('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js');
//   model = await tf.loadGraphModel('./models/bird/model.json');
//   ...run the model on tf.browser.fromPixels(source), decode boxes, keep class "bird"...

export function customDetector() {
  return {
    name: 'Custom model (not installed yet)',
    async load() {
      throw new Error('No custom model yet. Edit camera/models/custom.js, or choose COCO-SSD or Simulated.');
    },
    async detect(_source) {
      return [];
    }
  };
}
