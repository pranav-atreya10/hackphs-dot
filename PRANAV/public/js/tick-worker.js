// Steady ticks for the camera page while its tab is in the background. Browsers pause requestAnimationFrame in
// hidden tabs, but a worker's timer keeps running, so the camera keeps streaming while you watch the tower tab.
// postMessage(ms) starts ticking every ms milliseconds; postMessage(0) stops.
let timer = null;
onmessage = ({ data }) => {
  clearInterval(timer); timer = null;
  if (data > 0) timer = setInterval(() => postMessage(0), data);
};
