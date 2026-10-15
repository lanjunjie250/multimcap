export const CONNECTIONS = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],
  [5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],
  [0,17],[17,18],[18,19],[19,20]];

// One fixed color for every hand, independent of handedness classification,
// confidence and result ordering (all of which can change between frames).
export const HAND_COLOR = '#46e3a5';

export function drawHands(canvas, result) {
  // Keep this small 2D annotation layer on a CPU backing store: NVIDIA Vulkan
  // has occasionally retained alpha even after a canvas resize. Inference and
  // video decoding retain their existing GPU paths.
  canvas.width = canvas.width;
  const context = canvas.getContext('2d', {willReadFrequently: true});
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (!result) return;
  result.hands.forEach(hand => {
    const points = hand.landmarks;
    context.strokeStyle = context.fillStyle = HAND_COLOR;
    context.lineWidth = Math.max(2, canvas.width / 350);
    context.beginPath();
    for (const [a,b] of CONNECTIONS) {
      context.moveTo(points[a].x * canvas.width, points[a].y * canvas.height);
      context.lineTo(points[b].x * canvas.width, points[b].y * canvas.height);
    }
    context.stroke();
    for (const point of points) {
      context.beginPath();
      context.arc(point.x * canvas.width, point.y * canvas.height, Math.max(3, canvas.width / 220), 0, 2 * Math.PI);
      context.fill();
    }
  });
}
