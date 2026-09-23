const BASE_WINDOW = { width: 320, height: 380 };
const FRAME_DIR = '../../assets/actions';
const ACTIONS = {
  idle: { label: '待机', frames: 4, fps: 4, loop: true, mode: 'idle' },
  wave: { label: '挥手', frames: 6, fps: 8, loop: false, mode: 'wave', next: 'idle' },
  cast: { label: '施法', frames: 6, fps: 8, loop: false, mode: 'cast', next: 'idle' },
  attack: { label: '攻击', frames: 6, fps: 10, loop: false, mode: 'attack', next: 'idle' },
  hurt: { label: '受击', frames: 4, fps: 8, loop: false, mode: 'hurt', next: 'idle' },
  run: { label: '跑动', frames: 8, fps: 12, loop: false, mode: 'run', next: 'idle', locomotion: true },
  jump: { label: '跳跃', frames: 6, fps: 9, loop: false, mode: 'jump', next: 'idle', airborne: true },
  bow: { label: '鞠躬', frames: 4, fps: 7, loop: false, mode: 'bow', next: 'idle' },
  dance: { label: '舞蹈', frames: 8, fps: 10, loop: false, mode: 'dance', next: 'idle' },
  sit: { label: '坐下', frames: 4, fps: 6, loop: false, mode: 'sit', next: 'idle' },
  sleep: { label: '困倦', frames: 4, fps: 3, loop: false, mode: 'sleep', next: 'idle' },
  turn: { label: '转身', frames: 6, fps: 7, loop: false, mode: 'turn', next: 'idle' },
  clap: { label: '鼓掌', frames: 6, fps: 8, loop: false, mode: 'clap', next: 'idle' },
  surprise: { label: '惊讶', frames: 4, fps: 8, loop: false, mode: 'surprise', next: 'idle' },
  sad: { label: '难过', frames: 4, fps: 5, loop: false, mode: 'sad', next: 'idle' },
};

const root = document.getElementById('pet-root');
const stage = document.getElementById('pet-stage');
const stack = document.getElementById('sprite-stack');
const shadow = document.getElementById('pet-shadow');
const frameLayers = [document.getElementById('sprite-a'), document.getElementById('sprite-b')];
const statusLabel = document.getElementById('status-label');
const zoomLabel = document.getElementById('zoom-label');
const isElectron = Boolean(window.desktopPet);
const WEB_ROOT_WIDTH = 660;
let webBounds = {
  x: Math.max(16, Math.round((window.innerWidth - WEB_ROOT_WIDTH) / 2)),
  y: Math.max(16, Math.round((window.innerHeight - BASE_WINDOW.height) / 2)),
  width: WEB_ROOT_WIDTH,
  height: BASE_WINDOW.height,
};
let webDragState = null;
if (!isElectron) document.body.classList.add('browser-mode');
if (isElectron) document.body.classList.add('electron-mode');

const desktopApi = window.desktopPet || {
  getState: async () => ({
    bounds: { ...webBounds },
    display: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
  }),
  moveRelative: async (dx, dy = 0) => {
    webBounds.x += Number(dx || 0);
    webBounds.y += Number(dy || 0);
    webBounds.x = Math.max(0, Math.min(webBounds.x, window.innerWidth - webBounds.width));
    webBounds.y = Math.max(0, Math.min(webBounds.y, window.innerHeight - webBounds.height));
    root.style.left = `${webBounds.x}px`;
    root.style.top = `${webBounds.y}px`;
    return { ...webBounds };
  },
  setSize: async (width, height) => {
    webBounds.width = Math.max(WEB_ROOT_WIDTH, Math.round(Number(width) || BASE_WINDOW.width));
    webBounds.height = Math.max(260, Math.round(Number(height) || BASE_WINDOW.height));
    webBounds.x = Math.max(0, Math.min(webBounds.x, window.innerWidth - webBounds.width));
    webBounds.y = Math.max(0, Math.min(webBounds.y, window.innerHeight - webBounds.height));
    root.style.width = `${webBounds.width}px`;
    root.style.height = `${webBounds.height}px`;
    root.style.left = `${webBounds.x}px`;
    root.style.top = `${webBounds.y}px`;
    return { ...webBounds };
  },
  dragStart: (point) => {
    webDragState = { start: point, position: { x: webBounds.x, y: webBounds.y } };
  },
  dragMove: (point) => {
    if (!webDragState) return;
    webBounds.x = webDragState.position.x + (Number(point?.x) - Number(webDragState.start.x));
    webBounds.y = webDragState.position.y + (Number(point?.y) - Number(webDragState.start.y));
    webBounds.x = Math.max(0, Math.min(webBounds.x, window.innerWidth - webBounds.width));
    webBounds.y = Math.max(0, Math.min(webBounds.y, window.innerHeight - webBounds.height));
    root.style.left = `${webBounds.x}px`;
    root.style.top = `${webBounds.y}px`;
  },
  dragEnd: () => { webDragState = null; },
  onPlay: () => () => {},
};
let layerIndex = 0;
let currentAction = 'idle';
let frameIndex = 0;
let lastFrameAt = performance.now();
let actionStartedAt = lastFrameAt;
let idleTimer = null;
let runDirection = Math.random() > .5 ? 1 : -1;
let runLoops = 0;
let dragging = false;
let pointerDown = null;
let zoom = Number(localStorage.getItem('xiaoyan-zoom') || 1);

function framePath(action, index) {
  const number = index + 1;
  return `${FRAME_DIR}/${action}/${action}-${number}.png`;
}

function setStatus(action) {
  statusLabel.textContent = ACTIONS[action]?.label || action;
}

function showFrame(action, index, crossfade = true) {
  const nextLayer = frameLayers[layerIndex ^ 1];
  nextLayer.src = framePath(action, index);
  // Both layers are preloaded before playback. Swap them atomically instead of
  // cross-fading two semi-transparent character poses, which creates brightness
  // pulses and ghosting on anti-aliased hair and sleeves.
  nextLayer.classList.add('visible');
  frameLayers[layerIndex].classList.remove('visible');
  layerIndex ^= 1;
  frameIndex = index;
}

function addSparkles(count = 5) {
  const host = document.getElementById('motion-particles');
  for (let i = 0; i < count; i += 1) {
    const particle = document.createElement('i');
    particle.className = 'particle';
    particle.style.left = `${130 + (Math.random() * 56 - 28)}px`;
    particle.style.top = `${120 + (Math.random() * 90 - 45)}px`;
    particle.style.setProperty('--dx', `${Math.random() * 54 - 27}px`);
    particle.style.setProperty('--dy', `${Math.random() * -52 - 8}px`);
    host.appendChild(particle);
    particle.addEventListener('animationend', () => particle.remove(), { once: true });
  }
}

function scheduleIdleBehavior() {
  clearTimeout(idleTimer);
  if (currentAction !== 'idle') return;
  idleTimer = setTimeout(() => {
    const choices = ['wave', 'cast', 'attack', 'jump', 'run', 'bow', 'dance', 'sit', 'sleep', 'turn', 'clap', 'surprise', 'sad', 'idle', 'idle'];
    const action = choices[Math.floor(Math.random() * choices.length)];
    if (action === 'idle') {
      scheduleIdleBehavior();
      return;
    }
    playAction(action);
  }, 2800 + Math.random() * 6200);
}

function playAction(actionName) {
  const action = ACTIONS[actionName] ? actionName : 'idle';
  currentAction = action;
  frameIndex = 0;
  actionStartedAt = performance.now();
  lastFrameAt = actionStartedAt;
  runLoops = 0;
  setStatus(action);
  showFrame(action, 0, true);
  stack.style.transform = action === 'run'
    ? `scaleX(${runDirection}) scale(var(--pet-scale))`
    : 'scale(var(--pet-scale))';
  shadow.classList.toggle('airborne', Boolean(ACTIONS[action].airborne));
  if (action === 'wave' || action === 'cast') addSparkles(action === 'cast' ? 8 : 3);
  scheduleIdleBehavior();
}

async function stepLocomotion(action) {
  if (!action.locomotion) return;
  const speed = currentAction === 'run' ? 3.1 : 1.4;
  const bounds = await desktopApi.moveRelative(speed * runDirection, 0);
  if (bounds) {
    const display = await desktopApi.getState();
    if (display?.display) {
      const left = display.display.x + 28;
      const right = display.display.x + display.display.width - bounds.width - 28;
      if (bounds.x <= left || bounds.x >= right) runDirection *= -1;
    }
  }
  stack.style.transform = `scaleX(${runDirection}) scale(var(--pet-scale))`;
}

function tick(now) {
  const action = ACTIONS[currentAction];
  if (now - lastFrameAt >= 1000 / action.fps) {
    lastFrameAt = now;
    let next = frameIndex + 1;
    if (next >= action.frames) {
      if (action.loop) {
        next = 0;
      } else {
        if (currentAction === 'run' && runLoops < 1) {
          runLoops += 1;
          next = 0;
        } else {
          playAction(action.next || 'idle');
          requestAnimationFrame(tick);
          return;
        }
      }
    }
    showFrame(currentAction, next, true);
    if (currentAction === 'jump') {
      const jumpY = [4, -4, -13, -19, -10, 2][next] || 0;
      stack.style.transform = `translateY(${jumpY}px) scale(var(--pet-scale))`;
    }
    stepLocomotion(action);
  }
  requestAnimationFrame(tick);
}

async function setZoom(nextZoom) {
  zoom = Math.min(3, Math.max(.75, Math.round(nextZoom * 4) / 4));
  localStorage.setItem('xiaoyan-zoom', String(zoom));
  root.style.setProperty('--pet-scale', String(zoom));
  zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
  await desktopApi.setSize(BASE_WINDOW.width * zoom, BASE_WINDOW.height * zoom);
}

function installControls() {
  document.querySelectorAll('[data-action]').forEach((button) => {
    button.addEventListener('click', () => playAction(button.dataset.action));
  });
  document.querySelector('[data-zoom="up"]').addEventListener('click', () => setZoom(zoom + .25));
  document.querySelector('[data-zoom="down"]').addEventListener('click', () => setZoom(zoom - .25));
  window.addEventListener('keydown', (event) => {
    if (event.key === '+' || event.key === '=') setZoom(zoom + .25);
    if (event.key === '-') setZoom(zoom - .25);
    if (event.key === '0') setZoom(1);
    if (event.key.toLowerCase() === 'w') playAction('wave');
    if (event.key.toLowerCase() === 'j') playAction('jump');
    if (event.key.toLowerCase() === 'c') playAction('cast');
  });
  desktopApi.onPlay(playAction);
}

function installDrag() {
  stage.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    pointerDown = { x: event.screenX, y: event.screenY, time: performance.now() };
    stage.setPointerCapture?.(event.pointerId);
    desktopApi.dragStart({ x: event.screenX, y: event.screenY });
    dragging = true;
  });
  stage.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    desktopApi.dragMove({ x: event.screenX, y: event.screenY });
  });
  stage.addEventListener('pointerup', (event) => {
    if (!dragging) return;
    desktopApi.dragEnd();
    dragging = false;
    const distance = pointerDown ? Math.hypot(event.screenX - pointerDown.x, event.screenY - pointerDown.y) : 0;
    if (distance < 5 && performance.now() - (pointerDown?.time || 0) < 350) playAction('wave');
  });
  stage.addEventListener('pointercancel', () => { dragging = false; desktopApi.dragEnd(); });
}

function preloadFrames() {
  const sources = Object.entries(ACTIONS).flatMap(([name, action]) => (
    Array.from({ length: action.frames }, (_, index) => framePath(name, index))
  ));
  return Promise.all(sources.map((src) => new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      if (typeof image.decode === 'function') {
        image.decode().catch(() => {}).finally(resolve);
      } else {
        resolve();
      }
    };
    image.onerror = resolve;
    image.src = src;
  })));
}

async function boot() {
  root.style.setProperty('--pet-scale', String(zoom));
  zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
  installControls();
  installDrag();
  await preloadFrames();
  playAction('idle');
  await desktopApi.setSize(BASE_WINDOW.width * zoom, BASE_WINDOW.height * zoom);
  requestAnimationFrame(tick);
}

boot();
