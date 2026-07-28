const video = document.querySelector('#camera');
const canvas = document.querySelector('#output');
const ctx = canvas.getContext('2d');
const welcome = document.querySelector('#welcome');
const startButton = document.querySelector('#startButton');
const statusLabel = document.querySelector('#status');
const stage = document.querySelector('.stage');
const cameraPicker = document.querySelector('#cameraPicker');
const cameraSelect = document.querySelector('#cameraSelect');
const beautyToggle = document.querySelector('#beautyToggle');
const beautyStrength = document.querySelector('#beautyStrength');
const beautyValue = document.querySelector('#beautyValue');
const beautyStatus = document.querySelector('#beautyStatus');
const peopleModeButtons = [...document.querySelectorAll('.people-mode-button')];
const effectCanvas = document.createElement('canvas');
const effectCtx = effectCanvas.getContext('2d');

const FACE_OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
const LEFT_EYE = [33, 133, 159, 145];
const RIGHT_EYE = [362, 263, 386, 374];

const uniforms = {
  natsu: { src: 'natsu.png', scale: 6.2, y: 0.33, x: 0.00 },
  aihuku: { src: 'aihuku.png', scale: 6.0, y: 0.30, x: -0.01 },
  huyu: { src: 'huyu.png', scale: 6.5, y: 0.29, x: 0.00 },
};

let selected = 'natsu';
let pose = null;
let faceMesh = null;
let peopleMode = 'single';
let multiPoseLandmarker = null;
let multiModelsPromise = null;
let latestFaceLandmarks = null;
let latestMultiFaceLandmarks = [];
let running = false;
let mediaStream = null;
let frameBusy = false;
let modeSwitching = false;
let frameNumber = 0;
const INPUT_IDLE_MS = 40;
const MULTI_INPUT_IDLE_MS = 90;
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
  effectCanvas.width = canvas.width;
  effectCanvas.height = canvas.height;
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

function facePoint(point, fit) {
  return {
    x: canvas.width - (point.x * video.videoWidth * fit.scale + fit.x),
    y: point.y * video.videoHeight * fit.scale + fit.y,
  };
}

function eyeGeometry(points, indices, fit) {
  const corners = [facePoint(points[indices[0]], fit), facePoint(points[indices[1]], fit)];
  const upper = facePoint(points[indices[2]], fit);
  const lower = facePoint(points[indices[3]], fit);
  return {
    center: {
      x: (corners[0].x + corners[1].x + upper.x + lower.x) / 4,
      y: (corners[0].y + corners[1].y + upper.y + lower.y) / 4,
    },
    width: Math.max(1, Math.hypot(corners[0].x - corners[1].x, corners[0].y - corners[1].y)),
  };
}

function drawEyeMagnification(points, indices, fit, strength) {
  const eye = eyeGeometry(points, indices, fit);
  const sourceWidth = eye.width * 1.85;
  const sourceHeight = eye.width * 1.18;
  const zoom = 1 + strength * 0.192;
  const drawWidth = sourceWidth * zoom;
  const drawHeight = sourceHeight * zoom;
  const sourceX = eye.center.x - sourceWidth / 2;
  const sourceY = eye.center.y - sourceHeight / 2;

  ctx.save();
  ctx.beginPath();
  ctx.ellipse(eye.center.x, eye.center.y, drawWidth * 0.47, drawHeight * 0.43, 0, 0, Math.PI * 2);
  ctx.clip();
  ctx.globalAlpha = 0.96;
  ctx.drawImage(
    effectCanvas,
    sourceX, sourceY, sourceWidth, sourceHeight,
    eye.center.x - drawWidth / 2, eye.center.y - drawHeight / 2, drawWidth, drawHeight,
  );
  ctx.restore();
}

function drawBlush(points, fit, strength) {
  const leftCheek = facePoint(points[117], fit);
  const rightCheek = facePoint(points[346], fit);
  const faceLeft = facePoint(points[234], fit);
  const faceRight = facePoint(points[454], fit);
  const faceWidth = Math.max(1, Math.hypot(faceLeft.x - faceRight.x, faceLeft.y - faceRight.y));
  const radius = faceWidth * 0.105;

  ctx.save();
  ctx.globalAlpha = strength;
  for (const cheek of [leftCheek, rightCheek]) {
    const gradient = ctx.createRadialGradient(cheek.x, cheek.y, 0, cheek.x, cheek.y, radius);
    gradient.addColorStop(0, 'rgba(255, 112, 150, 0.24)');
    gradient.addColorStop(0.5, 'rgba(255, 130, 160, 0.12)');
    gradient.addColorStop(1, 'rgba(255, 150, 175, 0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(cheek.x, cheek.y, radius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function applyBeautyEffect(points, fit) {
  const strength = Number(beautyStrength.value) / 100;
  if (!beautyToggle.checked || strength <= 0 || !points) return;

  effectCtx.clearRect(0, 0, effectCanvas.width, effectCanvas.height);
  effectCtx.drawImage(canvas, 0, 0);

  const oval = FACE_OVAL.map(index => facePoint(points[index], fit));
  const mouthLeft = facePoint(points[61], fit);
  const mouthRight = facePoint(points[291], fit);
  const mouthCenter = {
    x: (mouthLeft.x + mouthRight.x) / 2,
    y: (mouthLeft.y + mouthRight.y) / 2,
  };
  const mouthWidth = Math.max(1, Math.hypot(mouthLeft.x - mouthRight.x, mouthLeft.y - mouthRight.y));

  ctx.save();
  ctx.beginPath();
  oval.forEach((point, index) => {
    if (index === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  });
  ctx.closePath();
  ctx.ellipse(mouthCenter.x, mouthCenter.y, mouthWidth * 0.62, mouthWidth * 0.34, 0, 0, Math.PI * 2);
  ctx.clip('evenodd');
  ctx.globalAlpha = 0.22 + strength * 0.42;
  ctx.filter = `blur(${Math.max(1.5, strength * 8).toFixed(1)}px) brightness(${(1 + strength * 0.14).toFixed(3)}) saturate(${(1 + strength * 0.08).toFixed(3)})`;
  ctx.drawImage(effectCanvas, 0, 0);
  ctx.restore();

  drawBlush(points, fit, strength);

  // Re-snapshot after smoothing so enlarged eye patches keep the beauty effect.
  effectCtx.clearRect(0, 0, effectCanvas.width, effectCanvas.height);
  effectCtx.drawImage(canvas, 0, 0);

  drawEyeMagnification(points, LEFT_EYE, fit, strength);
  drawEyeMagnification(points, RIGHT_EYE, fit, strength);
}

function smoothFace(previous, detected) {
  if (!previous || previous.length !== detected.length) return detected.map(point => ({ ...point }));
  return detected.map((point, index) => ({
    x: previous[index].x * 0.65 + point.x * 0.35,
    y: previous[index].y * 0.65 + point.y * 0.35,
    z: previous[index].z * 0.65 + point.z * 0.35,
  }));
}

function onFaceResults(results) {
  const detectedFaces = results.multiFaceLandmarks || [];
  if (peopleMode === 'multi') {
    latestMultiFaceLandmarks = detectedFaces.slice(0, 3).map((detected, index) =>
      smoothFace(latestMultiFaceLandmarks[index], detected));
    beautyStatus.textContent = beautyToggle.checked
      ? latestMultiFaceLandmarks.length + '人に美肌＋自然なデカ目'
      : '補正はオフです';
    return;
  }

  const detected = detectedFaces[0];
  if (!detected) {
    latestFaceLandmarks = null;
    beautyStatus.textContent = beautyToggle.checked ? '顔を正面に映してください' : '補正はオフです';
    return;
  }

  latestFaceLandmarks = smoothFace(latestFaceLandmarks, detected);
  beautyStatus.textContent = '美肌＋自然なデカ目';
}

function drawCameraFrame(source, fit) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.translate(canvas.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(source, fit.x, fit.y, fit.width, fit.height);
  ctx.restore();
}

function drawUniform(points, fit) {
  if (!points || !Number.isFinite(points[11]?.x) || !Number.isFinite(points[12]?.x)) return false;

  const left = {
    x: canvas.width - (points[11].x * video.videoWidth * fit.scale + fit.x),
    y: points[11].y * video.videoHeight * fit.scale + fit.y,
  };
  const right = {
    x: canvas.width - (points[12].x * video.videoWidth * fit.scale + fit.x),
    y: points[12].y * video.videoHeight * fit.scale + fit.y,
  };
  const shoulderWidth = Math.hypot(left.x - right.x, left.y - right.y);
  if (!Number.isFinite(shoulderWidth) || shoulderWidth < 8) return false;

  const angle = Math.atan2(right.y - left.y, right.x - left.x);
  const centerX = (left.x + right.x) / 2;
  const centerY = (left.y + right.y) / 2;
  const item = uniforms[selected];
  const image = images[selected];
  if (!image.complete || !image.naturalWidth) return false;

  const drawWidth = shoulderWidth * item.scale;
  const drawHeight = drawWidth * image.naturalHeight / image.naturalWidth;
  ctx.save();
  ctx.translate(centerX + shoulderWidth * item.x, centerY + drawHeight * item.y);
  ctx.rotate(angle);
  ctx.globalAlpha = 0.97;
  ctx.drawImage(image, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
  ctx.restore();
  return true;
}

function shoulderSpan(points) {
  if (!points || !points[11] || !points[12]) return 0;
  return Math.hypot(points[11].x - points[12].x, points[11].y - points[12].y);
}

function drawScene(source, poseSets = [], faceSets = []) {
  if (!video.videoWidth) return;
  const fit = coverTransform(video.videoWidth, video.videoHeight);
  drawCameraFrame(source, fit);

  if (beautyToggle.checked) {
    faceSets.slice(0, peopleMode === 'multi' ? 3 : 1).forEach(points => applyBeautyEffect(points, fit));
  }

  const orderedPoses = poseSets
    .filter(points => Number.isFinite(points?.[11]?.x) && Number.isFinite(points?.[12]?.x))
    .slice(0, peopleMode === 'multi' ? 3 : 1)
    .sort((a, b) => shoulderSpan(a) - shoulderSpan(b));
  const drawnCount = orderedPoses.reduce((count, points) => count + (drawUniform(points, fit) ? 1 : 0), 0);

  if (drawnCount === 0) {
    statusLabel.textContent = peopleMode === 'multi' ? '最大3人が映る位置に立ってください' : '全身が映る位置に立ってください';
    statusLabel.classList.remove('tracking');
    stage.classList.add('searching');
  } else {
    const names = { natsu: '夏服', aihuku: '合服', huyu: '冬服' };
    statusLabel.textContent = peopleMode === 'multi'
      ? names[selected] + 'を' + drawnCount + '人に表示中'
      : '姿勢を認識中・' + names[selected] + 'を表示';
    statusLabel.classList.add('tracking');
    stage.classList.remove('searching');
  }

  if (peopleMode === 'multi') {
    beautyStatus.textContent = beautyToggle.checked
      ? Math.min(faceSets.length, 3) + '人に美肌＋自然なデカ目'
      : '補正はオフです';
  }
}

function onResults(results) {
  if (peopleMode !== 'single') return;
  const poses = results.poseLandmarks ? [results.poseLandmarks] : [];
  const faces = latestFaceLandmarks ? [latestFaceLandmarks] : [];
  drawScene(results.image, poses, faces);
}

function ensureFaceMesh(maxFaces) {
  if (!faceMesh) {
    faceMesh = new FaceMesh({ locateFile: file => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}` });
    faceMesh.onResults(onFaceResults);
  }
  faceMesh.setOptions({
    maxNumFaces: maxFaces,
    refineLandmarks: true,
    selfieMode: false,
    minDetectionConfidence: 0.55,
    minTrackingConfidence: 0.55,
  });
}

function ensureSinglePersonPose() {
  if (pose) return;
  pose = new Pose({ locateFile: file => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}` });
  pose.setOptions({
    modelComplexity: 0,
    smoothLandmarks: true,
    enableSegmentation: false,
    minDetectionConfidence: 0.55,
    minTrackingConfidence: 0.55,
  });
  pose.onResults(onResults);
}

function disposeSinglePersonPose() {
  pose?.close?.();
  pose = null;
}

function disposeMultiPersonPose() {
  multiPoseLandmarker?.close?.();
  multiPoseLandmarker = null;
  multiModelsPromise = null;
}

async function ensureMultiPersonModels() {
  if (multiPoseLandmarker) return;
  if (multiModelsPromise) return multiModelsPromise;

  multiModelsPromise = (async () => {
    const vision = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/vision_bundle.mjs');
    const fileset = await vision.FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm',
    );

    const createPoseModel = delegate => vision.PoseLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
        delegate,
      },
      runningMode: 'VIDEO',
      numPoses: 3,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
      outputSegmentationMasks: false,
    });

    try {
      multiPoseLandmarker = await createPoseModel('GPU');
    } catch (gpuError) {
      console.warn('GPU multi-person pose unavailable, using CPU', gpuError);
      multiPoseLandmarker?.close?.();
      multiPoseLandmarker = await createPoseModel('CPU');
    }
  })().catch(error => {
    multiModelsPromise = null;
    multiPoseLandmarker?.close?.();
    multiPoseLandmarker = null;
    throw error;
  });

  return multiModelsPromise;
}

async function configureModelsForMode() {
  if (peopleMode === 'multi') {
    disposeSinglePersonPose();
    ensureFaceMesh(3);
    await ensureMultiPersonModels();
  } else {
    disposeMultiPersonPose();
    ensureFaceMesh(1);
    ensureSinglePersonPose();
  }
}

function updatePeopleModeButtons() {
  peopleModeButtons.forEach(button => {
    const active = button.dataset.peopleMode === peopleMode;
    button.classList.toggle('selected', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

async function setPeopleMode(nextMode) {
  const requestedMode = nextMode === 'multi' ? 'multi' : 'single';
  if (requestedMode === peopleMode) return;

  const previousMode = peopleMode;
  modeSwitching = true;
  while (frameBusy) await new Promise(resolve => setTimeout(resolve, 25));

  peopleMode = requestedMode;
  latestFaceLandmarks = null;
  latestMultiFaceLandmarks = [];
  frameNumber = 0;
  updatePeopleModeButtons();

  try {
    if (running) await configureModelsForMode();
    if (peopleMode === 'multi') {
      statusLabel.textContent = running ? '最大3人が映る位置に立ってください' : '最大3人モード';
      beautyStatus.textContent = '最大3人の顔を検出します';
    } else {
      statusLabel.textContent = running ? '1人が映る位置に立ってください' : '1人モード';
      beautyStatus.textContent = beautyToggle.checked ? '美肌＋自然なデカ目' : '補正はオフです';
    }
  } catch (error) {
    peopleMode = previousMode;
    updatePeopleModeButtons();
    try {
      if (running) await configureModelsForMode();
    } catch (restoreError) {
      console.error('Could not restore previous mode', restoreError);
    }
    statusLabel.textContent = '複数人モードを開始できませんでした';
    beautyStatus.textContent = '元のモードに戻しました';
    throw error;
  } finally {
    modeSwitching = false;
  }
}

async function startCamera() {
  if (running) return;
  startButton.disabled = true;
  startButton.textContent = '起動しています…';
  statusLabel.textContent = 'カメラを準備中';
  let startPhase = 'camera';
  try {
    if (!window.Pose || !window.FaceMesh) throw new Error('認識ライブラリを読み込めませんでした。インターネット接続を確認してください。');
    await Promise.all(imageLoads);
    await openCamera('');

    startPhase = peopleMode === 'multi' ? 'multi-model' : 'single-model';
    statusLabel.textContent = peopleMode === 'multi' ? '最大3人モードを準備中' : '1人モードを準備中';
    modeSwitching = true;
    await configureModelsForMode();
    modeSwitching = false;

    running = true;
    requestAnimationFrame(processFrame);
    welcome.classList.add('hidden');
    stage.classList.add('searching');
    updatePeopleModeButtons();
    resizeCanvas();
  } catch (error) {
    modeSwitching = false;
    console.error(error);
    if (mediaStream) {
      mediaStream.getTracks().forEach(track => track.stop());
      mediaStream = null;
      video.srcObject = null;
    }
    startButton.disabled = false;
    startButton.textContent = 'もう一度試す';
    const multiModelFailed = startPhase === 'multi-model';
    statusLabel.textContent = multiModelFailed ? '最大3人モードを準備できません' : 'カメラを開始できません';
    welcome.querySelector('p').textContent = error.name === 'NotAllowedError'
      ? 'カメラの使用が許可されていません。アドレスバーのカメラ設定から許可してください。'
      : multiModelFailed
        ? '端末の空きメモリまたは通信を確認し、他のタブを閉じてから再読み込みしてください。'
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
    ? { deviceId: { exact: deviceId }, width: { ideal: 960 }, height: { ideal: 540 } }
    : { facingMode: 'user', width: { ideal: 960 }, height: { ideal: 540 } };
  mediaStream = await navigator.mediaDevices.getUserMedia({ video: videoSettings, audio: false });
  video.srcObject = mediaStream;
  await video.play();
  const activeId = mediaStream.getVideoTracks()[0]?.getSettings().deviceId || deviceId;
  await updateCameraList(activeId);
}

function scheduleNextFrame() {
  const idleTime = peopleMode === 'multi' ? MULTI_INPUT_IDLE_MS : INPUT_IDLE_MS;
  setTimeout(() => requestAnimationFrame(processFrame), idleTime);
}

async function processFrame() {
  if (!running) return;
  if (!frameBusy && !modeSwitching && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    frameBusy = true;
    try {
      frameNumber += 1;
      if (peopleMode === 'multi') {
        if (beautyToggle.checked && frameNumber % 3 === 0) {
          await faceMesh.send({ image: video });
        } else if (!beautyToggle.checked) {
          latestMultiFaceLandmarks = [];
        }
        const timestamp = performance.now();
        const poseResult = multiPoseLandmarker.detectForVideo(video, timestamp);
        drawScene(video, poseResult.landmarks || [], latestMultiFaceLandmarks);
      } else {
        if (beautyToggle.checked && frameNumber % 3 === 0) {
          await faceMesh.send({ image: video });
        }
        await pose.send({ image: video });
      }
    } catch (error) {
      console.error('MediaPipe processing failed', error);
    } finally {
      frameBusy = false;
    }
  }
  scheduleNextFrame();
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

let suppressBeautyClickUntil = 0;

beautyToggle.addEventListener('pointerup', event => {
  if (event.pointerType !== 'touch') return;
  event.preventDefault();
  suppressBeautyClickUntil = performance.now() + 800;
  beautyToggle.checked = !beautyToggle.checked;
  beautyToggle.dispatchEvent(new Event('change'));
});

beautyToggle.addEventListener('click', event => {
  if (performance.now() < suppressBeautyClickUntil) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
});

beautyToggle.addEventListener('change', () => {
  latestFaceLandmarks = null;
  latestMultiFaceLandmarks = [];
  beautyStrength.disabled = !beautyToggle.checked;
  beautyStatus.textContent = beautyToggle.checked ? '顔を検出しています…' : '補正はオフです';
});

beautyStrength.addEventListener('input', () => {
  beautyValue.value = `${beautyStrength.value}%`;
});

const lastTouchActivation = new WeakMap();

function bindActivation(element, handler) {
  const run = event => {
    Promise.resolve(handler(event)).catch(error => console.error('Control action failed', error));
  };

  element.addEventListener('pointerup', event => {
    if (event.pointerType !== 'touch') return;
    event.preventDefault();
    lastTouchActivation.set(element, performance.now());
    run(event);
  });

  element.addEventListener('click', event => {
    const lastTouch = lastTouchActivation.get(element) || 0;
    if (performance.now() - lastTouch < 800) {
      event.preventDefault();
      return;
    }
    run(event);
  });
}

bindActivation(startButton, startCamera);
peopleModeButtons.forEach(button => {
  bindActivation(button, () => setPeopleMode(button.dataset.peopleMode));
});
window.addEventListener('resize', resizeCanvas);
new ResizeObserver(resizeCanvas).observe(stage);

document.querySelectorAll('.uniform-button').forEach(button => {
  bindActivation(button, () => {
    selected = button.dataset.uniform;
    document.querySelectorAll('.uniform-button').forEach(other => {
      const active = other === button;
      other.classList.toggle('selected', active);
      other.setAttribute('aria-pressed', String(active));
    });
  });
});

const fullscreenButton = document.querySelector('#fullscreenButton');
bindActivation(fullscreenButton, async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch (error) {
    console.warn('Fullscreen is unavailable', error);
  }
});

updatePeopleModeButtons();
resizeCanvas();
