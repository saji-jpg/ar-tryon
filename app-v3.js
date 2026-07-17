const video = document.querySelector('#camera');
const canvas = document.querySelector('#output');
const ctx = canvas.getContext('2d');
const welcome = document.querySelector('#welcome');
const startButton = document.querySelector('#startButton');
const statusLabel = document.querySelector('#status');
const stage = document.querySelector('.stage');
const cameraPicker = document.querySelector('#cameraPicker');
const cameraSelect = document.querySelector('#cameraSelect');

const uniforms = {
  natsu: { src: 'natsu.png', scale: 6.2, y: 0.20, x: 0.00 },
  aihuku: { src: 'aihuku.png', scale: 6.0, y: 0.20, x: -0.01 },
  huyu: { src: 'huyu.png', scale: 6.5, y: 0.19, x: 0.00 },
};

let selected = 'natsu';
let pose = null;
let running = false;
let mediaStream = null;
let frameBusy = false;
const images = {};
const imageLoads = [];

for (const [key, item] of Object.entries(uniforms)) {
  const image = new Image();
  imageLoads.push(new Promise((resolve, reject) => {
    image.addEventListener('load', resolve, { once: true });
    image.addEventListener('error', () => reject(new Error(`${item.src} を読み込めません`)), { once: true });
  }));
  image.src = new URL(item.src, document.baseURI).href;
  images[key] = image;
}

function resizeCanvas() {
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const rect = stage.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(rect.width * ratio));
  canvas.height = Math.max(1, Math.round(rect.height * ratio));
}

function coverTransform(sourceWidth, sourceHeight) {
  const scale = Math.max(canvas.width / sourceWidth, canvas.height / sourceHeight);
  return {
    scale,
    width: sourceWidth * scale,
    height: sourceHeight * scale,
    x: (canvas.width - sourceWidth * scale) / 2,
    y: (canvas.height - sourceHeight * scale) / 2,
  };
}

function onResults(results) {
  if (!video.videoWidth) return;
  const fit = coverTransform(video.videoWidth, video.videoHeight);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.save();
  ctx.translate(canvas.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(results.image, fit.x, fit.y, fit.width, fit.height);
  ctx.restore();

  const points = results.poseLandmarks;
  if (!points || !Number.isFinite(points[11]?.x) || !Number.isFinite(points[12]?.x)) {
    statusLabel.textContent = '全身が映る位置に立ってください';
    statusLabel.classList.remove('tracking');
    stage.classList.add('searching');
    return;
  }

  stage.classList.remove('searching');
  const names = { natsu: '夏服', aihuku: '合服', huyu: '冬服' };
  statusLabel.textContent = `姿勢を認識中・${names[selected]}を表示`;
  statusLabel.classList.add('tracking');

  const left = {
    x: canvas.width - (points[11].x * video.videoWidth * fit.scale + fit.x),
    y: points[11].y * video.videoHeight * fit.scale + fit.y,
  };
  const right = {
    x: canvas.width - (points[12].x * video.videoWidth * fit.scale + fit.x),
    y: points[12].y * video.videoHeight * fit.scale + fit.y,
  };
  const shoulderWidth = Math.hypot(left.x - right.x, left.y - right.y);
  const angle = Math.atan2(right.y - left.y, right.x - left.x);
  const centerX = (left.x + right.x) / 2;
  const centerY = (left.y + right.y) / 2;
  const item = uniforms[selected];
  const image = images[selected];
  if (!image.complete || !image.naturalWidth) return;

  const drawWidth = shoulderWidth * item.scale;
  const drawHeight = drawWidth * image.naturalHeight / image.naturalWidth;
  ctx.save();
  ctx.translate(centerX + shoulderWidth * item.x, centerY + drawHeight * item.y);
  ctx.rotate(angle);
  ctx.globalAlpha = 0.97;
  ctx.drawImage(image, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
  ctx.restore();
}

async function startCamera() {
  if (running) return;
  startButton.disabled = true;
  startButton.textContent = '起動しています…';
  statusLabel.textContent = 'カメラを準備中';
  try {
    if (!window.Pose) throw new Error('姿勢認識ライブラリを読み込めませんでした。インターネット接続を確認してください。');
    await Promise.all(imageLoads);
    pose = new Pose({ locateFile: file => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}` });
    pose.setOptions({
      modelComplexity: 1,
      smoothLandmarks: true,
      enableSegmentation: false,
      minDetectionConfidence: 0.55,
      minTrackingConfidence: 0.55,
    });
    pose.onResults(onResults);
    await openCamera('');
    running = true;
    requestAnimationFrame(processFrame);
    welcome.classList.add('hidden');
    stage.classList.add('searching');
    resizeCanvas();
  } catch (error) {
    console.error(error);
    startButton.disabled = false;
    startButton.textContent = 'もう一度試す';
    statusLabel.textContent = 'カメラを開始できません';
    welcome.querySelector('p').textContent = error.name === 'NotAllowedError'
      ? 'カメラの使用が許可されていません。アドレスバーのカメラ設定から許可してください。'
      : error.message;
  }
}

async function updateCameraList(selectedDeviceId = '') {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cameras = devices.filter(device => device.kind === 'videoinput');
  cameraSelect.replaceChildren();
  cameras.forEach((device, index) => {
    const option = document.createElement('option');
    option.value = device.deviceId;
    option.textContent = device.label || `カメラ ${index + 1}`;
    cameraSelect.append(option);
  });
  if (selectedDeviceId && cameras.some(device => device.deviceId === selectedDeviceId)) {
    cameraSelect.value = selectedDeviceId;
  }
  cameraPicker.classList.toggle('hidden', cameras.length === 0);
}

async function openCamera(deviceId) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('このブラウザではカメラを使用できません。');
  }
  if (mediaStream) mediaStream.getTracks().forEach(track => track.stop());
  const videoSettings = deviceId
    ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
    : { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } };
  mediaStream = await navigator.mediaDevices.getUserMedia({ video: videoSettings, audio: false });
  video.srcObject = mediaStream;
  await video.play();
  const activeId = mediaStream.getVideoTracks()[0]?.getSettings().deviceId || deviceId;
  await updateCameraList(activeId);
}

async function processFrame() {
  if (!running) return;
  if (!frameBusy && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    frameBusy = true;
    try {
      await pose.send({ image: video });
    } catch (error) {
      console.error('Pose processing failed', error);
    } finally {
      frameBusy = false;
    }
  }
  requestAnimationFrame(processFrame);
}

cameraSelect.addEventListener('change', async () => {
  cameraSelect.disabled = true;
  statusLabel.textContent = 'カメラを切り替えています';
  try {
    await openCamera(cameraSelect.value);
    statusLabel.textContent = 'カメラを切り替えました';
  } catch (error) {
    console.error(error);
    statusLabel.textContent = 'カメラを切り替えられませんでした';
  } finally {
    cameraSelect.disabled = false;
  }
});

navigator.mediaDevices?.addEventListener?.('devicechange', () => {
  const activeId = mediaStream?.getVideoTracks()[0]?.getSettings().deviceId || '';
  updateCameraList(activeId).catch(console.error);
});

startButton.addEventListener('click', startCamera);
window.addEventListener('resize', resizeCanvas);
new ResizeObserver(resizeCanvas).observe(stage);

document.querySelectorAll('.uniform-button').forEach(button => {
  button.addEventListener('click', () => {
    selected = button.dataset.uniform;
    document.querySelectorAll('.uniform-button').forEach(other => {
      const active = other === button;
      other.classList.toggle('selected', active);
      other.setAttribute('aria-pressed', String(active));
    });
  });
});

document.querySelector('#fullscreenButton').addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch (error) {
    console.warn('Fullscreen is unavailable', error);
  }
});

resizeCanvas();
