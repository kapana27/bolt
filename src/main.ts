import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';

import characterUrl from './assets/models/character.glb?url';
import characterJumpUrl from './assets/models/character-jump.glb?url';
import characterWalkUrl from './assets/models/character-walk.glb?url';
import characterIdleUrl from './assets/models/character-idle.glb?url';
import characterCelebrateUrl from './assets/models/character-celebrate.glb?url';
import characterStandUrl from './assets/models/character-stand.glb?url';
import bushUrl from './assets/models/bush.glb?url';
import treeUrl from './assets/models/tree.glb?url';
import taxiUrl from './assets/models/taxi.glb?url';

// Optional image assets — if missing, CSS fallbacks take over.
// Drop these files into /public to enable them:
//   /public/girl-winner.png
//   /public/girl-lost.jpg
const WIN_IMG = '/girl-winner.png';
const LOST_IMG = '/girl-lost.jpg';

// ─── DOM ─────────────────────────────────────────────────────
const stage = document.getElementById('stage') as HTMLDivElement;
const bgA = document.getElementById('bgA') as HTMLDivElement;
const bgB = document.getElementById('bgB') as HTMLDivElement;
const scoreEl = document.getElementById('score') as HTMLDivElement;
const hintEl = document.getElementById('hint') as HTMLDivElement;

// Compute the on-screen width of one bg tile so scaled aspect matches the
// natural image. Updated on resize + after the image actually loads.
let bgTileWidth = window.innerWidth;
function setBgTileWidth(px: number): void {
  bgTileWidth = px;
  bgA.style.width = `${px}px`;
  bgB.style.width = `${px}px`;
}
setBgTileWidth(bgTileWidth);
const bgImg = new Image();
bgImg.onload = () => {
  // Scale the tile so it matches the screen height and preserves aspect.
  const w = window.innerHeight * (bgImg.naturalWidth / bgImg.naturalHeight);
  setBgTileWidth(w);
};
bgImg.src = '/background.jpg';
window.addEventListener('resize', () => {
  if (bgImg.naturalHeight) {
    setBgTileWidth(window.innerHeight * (bgImg.naturalWidth / bgImg.naturalHeight));
  }
});
const loaderEl = document.getElementById('loader') as HTMLDivElement;
const lostOverlay = document.getElementById('lostOverlay') as HTMLDivElement;
const winOverlay = document.getElementById('winOverlay') as HTMLDivElement;
const lostImg = document.getElementById('lostImg') as HTMLImageElement;
const winImg = document.getElementById('winImg') as HTMLImageElement;

lostImg.onerror = () => { lostImg.style.display = 'none'; };
winImg.onerror = () => { winImg.style.display = 'none'; };
lostImg.src = LOST_IMG;
winImg.src = WIN_IMG;

// ─── Scene / Camera / Renderer ───────────────────────────────
const scene = new THREE.Scene();

const FRUSTUM = 6;
let aspect = window.innerWidth / window.innerHeight;
const camera = new THREE.OrthographicCamera(
  -FRUSTUM * aspect, FRUSTUM * aspect,
  FRUSTUM, -FRUSTUM, 0.1, 100,
);
camera.position.set(0, 0, 30);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });
// Cap to 1 — Retina (devicePixelRatio = 2) was rendering 4× the pixels.
renderer.setPixelRatio(1);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = false;
stage.appendChild(renderer.domElement);

window.addEventListener('resize', () => {
  aspect = window.innerWidth / window.innerHeight;
  camera.left = -FRUSTUM * aspect;
  camera.right = FRUSTUM * aspect;
  camera.top = FRUSTUM;
  camera.bottom = -FRUSTUM;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ─── Lighting (Claymorphism: soft fill + warm key + cool rim) ─
scene.add(new THREE.AmbientLight(0xfff2e0, 0.85));
const key = new THREE.DirectionalLight(0xffe8c2, 1.4);
key.position.set(6, 10, 8);
scene.add(key);
const rim = new THREE.DirectionalLight(0x88aaff, 0.4);
rim.position.set(-6, 4, -3);
scene.add(rim);

// ─── Game constants ──────────────────────────────────────────
const GROUND_Y   = -5.0;   // sit on the asphalt road painted in background.png
const CHAR_X     = -5;
// Spawn / despawn just off the visible edges (depends on screen aspect).
function spawnX(): number {
  return FRUSTUM * (window.innerWidth / window.innerHeight) + 0.5;
}
function despawnX(): number {
  return -FRUSTUM * (window.innerWidth / window.innerHeight) - 0.5;
}
const WIN_JUMPS  = 15;

// Jump physics — single jump just barely clears a bush; tree requires the
// mid-air second tap.
const GRAVITY         = -45;
const JUMP_VEL        =  12;  // ground jump impulse (max rise ≈ 1.6)
const DOUBLE_JUMP_VEL =   9;  // mid-air floor (combined max rise ≈ 2.5)


// Pickup choreography: brief stand → walk to the parked taxi door → fade.
const STAND_DURATION  = 0.4;
const WALK_DURATION   = 0.9;
const FADE_DURATION   = 0.5;
const PICKUP_DURATION = STAND_DURATION + WALK_DURATION + FADE_DURATION;

// Where the taxi stops once it has scrolled in next to the character.
const TAXI_PARK_X = CHAR_X + 1.8;

// Parallax — fraction of obstacle world-speed at which the bg scrolls.
// 1.0 keeps the road moving in lock-step with the obstacles (so bushes/trees
// look glued to the road); <1.0 would give Mario-style layered depth (only
// useful with separate fg/bg layers).
const PARALLAX_FACTOR = 1.0;
let bgOffsetX = 0;
// 1 world unit on screen = innerHeight / (2 * FRUSTUM) pixels.
function pxPerWorldUnit(): number {
  return window.innerHeight / (2 * FRUSTUM);
}

// ─── Asset loading ───────────────────────────────────────────
const gltfLoader = new GLTFLoader();
function loadGLB(url: string): Promise<THREE.Group> {
  return new Promise((resolve, reject) => {
    gltfLoader.load(url, (g) => resolve(g.scene), undefined, reject);
  });
}
function loadGLTF(url: string): Promise<GLTF> {
  return new Promise((resolve, reject) => {
    gltfLoader.load(url, resolve, undefined, reject);
  });
}

// The Meshy biped GLB ships geometry only — no materials, no textures.
// Paint the outfit (white boots → black pants → green shirt → tan skin → dark
// hair bun) using per-vertex colors keyed off the rest-pose Y of each vertex.
// Vertex colors travel with the skin, so the bands stay glued to body parts
// through the running animation.
function applyOutfitColors(model: THREE.Object3D): void {
  const tmp = new THREE.Color();
  model.traverse((c) => {
    const mesh = c as THREE.Mesh;
    if (!(mesh as THREE.Mesh).isMesh && !(mesh as unknown as THREE.SkinnedMesh).isSkinnedMesh) return;
    const geom = mesh.geometry as THREE.BufferGeometry;
    const pos = geom.attributes.position;
    if (!pos) return;

    let minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const span = Math.max(maxY - minY, 1e-6);

    const colors = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const t = (pos.getY(i) - minY) / span; // 0 = feet, 1 = top of hair
      if      (t < 0.06) tmp.setHex(0xffffff); // boots
      else if (t < 0.55) tmp.setHex(0x1a1a1a); // pants
      else if (t < 0.85) tmp.setHex(0x16a34a); // shirt — Bolt green
      else if (t < 0.93) tmp.setHex(0xc8966c); // face/neck — tan
      else               tmp.setHex(0x4a1c2c); // hair bun — dark purple
      colors[i * 3 + 0] = tmp.r;
      colors[i * 3 + 1] = tmp.g;
      colors[i * 3 + 2] = tmp.b;
    }
    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    mesh.material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.7,
      metalness: 0,
      transparent: true,    // enabled so we can fade-out on taxi entry
      opacity: 1,
    });
  });
}

function fitModel(obj: THREE.Object3D, targetHeight: number, restY: number): THREE.Object3D {
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  if (size.y > 0) obj.scale.multiplyScalar(targetHeight / size.y);
  obj.updateMatrixWorld(true);
  const box2 = new THREE.Box3().setFromObject(obj);
  const footOffset = box2.min.y - obj.position.y;
  obj.position.y = restY - footOffset;
  obj.traverse((c) => {
    const m = c as THREE.Mesh;
    if (m.isMesh) { m.castShadow = false; m.receiveShadow = false; }
  });
  return obj;
}

interface Models {
  character: GLTF;
  bush: THREE.Group;
  tree: THREE.Group;
  taxi: THREE.Group;
}
type ClipName = 'run' | 'jump' | 'walk' | 'idle' | 'celebrate' | 'stand';
let MODELS: Models;
let CLIPS: Record<ClipName, THREE.AnimationClip>;
let CACHED_BUSH_BOX: THREE.Box3;
let CACHED_TREE_BOX: THREE.Box3;

// All Meshy animations include Hips.position keyframes (root motion). When the
// mixer crossfades between actions the root snaps to the next clip's starting
// position, which visually slides/rewinds the character. We drive position
// manually, so strip those tracks at load time.
function stripRootMotion(clip: THREE.AnimationClip): THREE.AnimationClip {
  clip.tracks = clip.tracks.filter((t) => {
    return !/^(Hips|Spine)\.position$/.test(t.name);
  });
  return clip;
}

async function loadAssets(): Promise<void> {
  const [character, bush, tree, taxi, jumpGltf, walkGltf, idleGltf, celebrateGltf, standGltf] = await Promise.all([
    loadGLTF(characterUrl),
    loadGLB(bushUrl),
    loadGLB(treeUrl),
    loadGLB(taxiUrl),
    loadGLTF(characterJumpUrl),
    loadGLTF(characterWalkUrl),
    loadGLTF(characterIdleUrl),
    loadGLTF(characterCelebrateUrl),
    loadGLTF(characterStandUrl),
  ]);
  MODELS = { character, bush, tree, taxi };

  // Pre-fit bush and tree to their gameplay sizes ONCE so spawnObstacle()
  // can just clone + position (no per-spawn setFromObject inside fitModel).
  fitModel(bush, 0.7, GROUND_Y);
  fitModel(tree, 1.7, GROUND_Y);
  // Strip shadow casting from obstacles — every new shadow caster forces the
  // directional-light shadow map to recompute, which is the biggest source
  // of per-spawn frame hitches.
  for (const m of [bush, tree]) {
    m.traverse((c) => {
      const mesh = c as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = false;
        mesh.receiveShadow = false;
      }
    });
  }
  // Cache the resulting world bboxes, expressed relative to mesh.position.
  function cacheRel(o: THREE.Object3D): THREE.Box3 {
    const wb = new THREE.Box3().setFromObject(o);
    const rb = wb.clone();
    rb.min.sub(o.position);
    rb.max.sub(o.position);
    return rb;
  }
  CACHED_BUSH_BOX = cacheRel(bush);
  CACHED_TREE_BOX = cacheRel(tree);
  CLIPS = {
    run:       stripRootMotion(character.animations[0]),
    jump:      stripRootMotion(jumpGltf.animations[0]),
    walk:      stripRootMotion(walkGltf.animations[0]),
    idle:      stripRootMotion(idleGltf.animations[0]),
    celebrate: stripRootMotion(celebrateGltf.animations[0]),
    stand:     stripRootMotion(standGltf.animations[0]),
  };
}

// ─── Game state ──────────────────────────────────────────────
type GameState = 'loading' | 'playing' | 'won' | 'lost';
type TaxiPhase = 'pickup' | 'done' | null;

interface Obstacle {
  mesh: THREE.Object3D;
  scored: boolean;
  // World-space bbox at spawn, expressed relative to mesh.position. Per-frame
  // collision recomposes it as relBox + current position — far cheaper than
  // setFromObject() on a 30MB GLB every tick.
  relBox: THREE.Box3;
}

const game = {
  state: 'loading' as GameState,
  speed: 5,
  baseSpeed: 5,
  jumps: 0,
  character: null as THREE.Object3D | null,
  velocityY: 0,
  onGround: true,
  obstacles: [] as Obstacle[],
  spawnTimer: 1.2,
  startTime: 0,
  lastSpeedTier: 0,
  taxi: null as THREE.Object3D | null,
  taxiPhase: null as TaxiPhase,
  taxiTimer: 0,
  charBaseScale: 1,
  mixer: null as THREE.AnimationMixer | null,
  actions: null as Record<ClipName, THREE.AnimationAction> | null,
  currentAction: null as ClipName | null,
  jumpsRemaining: 2,        // 1 ground jump + 1 mid-air jump available per landing
  obstaclesSpawned: 0,      // count toward WIN_JUMPS — once reached, taxi
                            // spawns instead of more obstacles.
  introTime: 0,             // seconds since Play; covers stand → speed ramp.
  charRelBox: null as THREE.Box3 | null,  // character bbox cached at spawn
  // Pre-created obstacle pool — all WIN_JUMPS instances cloned + uploaded to
  // the GPU once at game start, so spawning becomes a position swap.
  obstaclePool: [] as Obstacle[],
  nextPoolIndex: 0,
};

// Intro phasing: brief stand, then ramp speed 0 → baseSpeed.
const INTRO_STAND = 0.6;
const INTRO_RAMP  = 1.0;
const INTRO_TOTAL = INTRO_STAND + INTRO_RAMP;

function setScore(): void {
  scoreEl.textContent = `Jumps: ${game.jumps} / ${WIN_JUMPS}`;
}

// Pre-create the entire obstacle set once at game start. All clones, texture
// uploads, and shader compiles happen here so the gameplay loop never pays
// for new objects appearing.
function buildObstaclePool(): void {
  const PARK_OFFSCREEN = 100; // far off-screen to the right
  for (let i = 0; i < WIN_JUMPS; i++) {
    const isBush = Math.random() < 0.6;
    const src = isBush ? MODELS.bush : MODELS.tree;
    const mesh = src.clone(true);
    mesh.position.x = PARK_OFFSCREEN;
    // Keep VISIBLE during pre-warm so renderer.compile + the first render
    // actually compile shaders and upload textures for these meshes.
    // (Three.js skips invisible objects during compile/render, which would
    //  otherwise defer that work to first spawn → frame hitch.)
    mesh.visible = true;
    mesh.traverse((c) => { c.frustumCulled = false; });
    scene.add(mesh);
    const relBox = (isBush ? CACHED_BUSH_BOX : CACHED_TREE_BOX).clone();
    game.obstaclePool.push({ mesh, scored: false, relBox });
  }
  // Compile shaders + force one render pass so textures upload to GPU NOW.
  renderer.compile(scene, camera);
  renderer.render(scene, camera);
  // Hide them until they're actually spawned into play.
  for (const o of game.obstaclePool) o.mesh.visible = false;
}

function spawnObstacle(): void {
  if (game.nextPoolIndex >= game.obstaclePool.length) return;
  const o = game.obstaclePool[game.nextPoolIndex++];
  o.mesh.position.x = spawnX() + Math.random() * 0.5;
  o.mesh.visible = true;
  o.scored = false;
  game.obstacles.push(o);
}

// Reusable Box3 instances — avoid per-frame allocations.
const _tmpCharBox = new THREE.Box3();
const _tmpObsBox = new THREE.Box3();

function checkCollision(): boolean {
  if (!game.character || !game.charRelBox) return false;
  // Character bbox: cached relBox + current position (Y changes during jumps).
  _tmpCharBox.copy(game.charRelBox);
  _tmpCharBox.min.add(game.character.position);
  _tmpCharBox.max.add(game.character.position);
  _tmpCharBox.expandByScalar(-0.25);
  for (const o of game.obstacles) {
    _tmpObsBox.copy(o.relBox);
    _tmpObsBox.min.add(o.mesh.position);
    _tmpObsBox.max.add(o.mesh.position);
    _tmpObsBox.expandByScalar(-0.15);
    if (_tmpCharBox.intersectsBox(_tmpObsBox)) return true;
  }
  return false;
}

function startGame(): void {
  // Skinned/animated character — use loaded scene directly (skeleton clones
  // need SkeletonUtils which we don't need for a single instance).
  game.character = MODELS.character.scene;
  applyOutfitColors(game.character);
  fitModel(game.character, 1.8, GROUND_Y);
  game.character.position.x = CHAR_X;
  // Face the camera but slightly turned so the run looks natural side-on.
  game.character.rotation.y = Math.PI * 0.15;
  game.charBaseScale = game.character.scale.x;
  // SkinnedMesh frustum culling can clip the character if its bounding sphere
  // doesn't capture animated bone displacement — and the per-frame check
  // itself is wasted work for a stationary on-screen character.
  game.character.traverse((c) => { c.frustumCulled = false; });
  scene.add(game.character);

  // Cache character bbox once (rest pose) for cheap per-frame collision.
  const cWorldBox = new THREE.Box3().setFromObject(game.character);
  game.charRelBox = cWorldBox.clone();
  game.charRelBox.min.sub(game.character.position);
  game.charRelBox.max.sub(game.character.position);

  // Build a mixer with all animation actions; start with run.
  game.mixer = new THREE.AnimationMixer(game.character);
  game.actions = {
    run:       game.mixer.clipAction(CLIPS.run),
    jump:      game.mixer.clipAction(CLIPS.jump),
    walk:      game.mixer.clipAction(CLIPS.walk),
    idle:      game.mixer.clipAction(CLIPS.idle),
    celebrate: game.mixer.clipAction(CLIPS.celebrate),
    stand:     game.mixer.clipAction(CLIPS.stand),
  };
  // Configure one-shot actions to play once and clamp at the final frame.
  for (const name of ['jump', 'celebrate'] as const) {
    game.actions[name].setLoop(THREE.LoopOnce, 1);
    game.actions[name].clampWhenFinished = true;
  }
  // Start in stand pose; the intro phase swaps to run as speed ramps.
  playAction('stand');

  buildObstaclePool();

  game.state = 'playing';
  game.introTime = 0;
  game.speed = 0;
  game.startTime = performance.now();
  setScore();
}

function playAction(name: ClipName, fadeSec = 0.18): void {
  if (!game.actions || game.currentAction === name) return;
  const next = game.actions[name];
  next.reset().setEffectiveWeight(1).fadeIn(fadeSec).play();
  if (game.currentAction) game.actions[game.currentAction].fadeOut(fadeSec);
  game.currentAction = name;
}

function triggerLoss(): void {
  game.state = 'lost';
  hintEl.classList.add('hide');
  // Freeze world + obstacle so the character is visibly standing right
  // behind the bush/tree she hit, then surface the overlay after a beat.
  game.speed = 0;
  playAction('stand');
  setTimeout(() => lostOverlay.classList.add('show'), 800);
}

function spawnTaxi(): void {
  game.taxi = MODELS.taxi.clone(true);
  fitModel(game.taxi, 1.7, GROUND_Y + 0.4);
  // Spawn at SPAWN_X just like an obstacle and scroll toward the character.
  game.taxi.position.x = spawnX();
  game.taxi.position.z = -1.8;
  game.taxi.rotation.y = Math.PI;
  scene.add(game.taxi);
}

function triggerPickup(): void {
  game.state = 'won';
  hintEl.classList.add('hide');
  game.speed = 0;
  playAction('stand');
  game.taxiPhase = 'pickup';
  game.taxiTimer = PICKUP_DURATION;
}

function showWinOverlay(): void {
  winOverlay.classList.add('show');
}

// ─── Input ───────────────────────────────────────────────────
function isPortraitMobile(): boolean {
  return window.innerWidth < window.innerHeight && window.innerWidth < 900;
}

function jump(): void {
  if (isPortraitMobile()) return;     // game paused behind the rotate prompt
  if (game.state !== 'playing') return;
  if (game.jumpsRemaining <= 0) return;
  // Replace velocity on ground jump (predictable height); add to it for the
  // mid-air second tap so it visibly boosts the existing arc.
  if (game.onGround) {
    game.velocityY = JUMP_VEL;
  } else {
    // Mid-air tap: lift to at least DOUBLE_JUMP_VEL but never stack on top of
    // the existing upward speed (so quick double-taps can't shoot to the moon).
    game.velocityY = Math.max(game.velocityY, DOUBLE_JUMP_VEL);
  }
  game.jumpsRemaining -= 1;
  game.onGround = false;
  playAction('jump');
  hintEl.classList.add('hide');
}
function isUITarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!(el && el.closest && el.closest('.cta-pill, button, .overlay, #loader, #rotatePrompt'));
}
window.addEventListener('mousedown', (e) => {
  if (isUITarget(e.target)) return;
  jump();
});
window.addEventListener('touchstart', (e) => {
  if (isUITarget(e.target)) return;   // let buttons receive their tap
  e.preventDefault();
  jump();
}, { passive: false });
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' || e.code === 'ArrowUp') { e.preventDefault(); jump(); }
});

document.getElementById('retryBtn')!.addEventListener('click', () => location.reload());
document.getElementById('playAgainBtn')!.addEventListener('click', () => location.reload());

// ─── Main loop ───────────────────────────────────────────────
let lastT = performance.now();
function tick(): void {
  requestAnimationFrame(tick);
  const now = performance.now();
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;

  if (game.mixer) game.mixer.update(dt);

  // Parallax background — two tiles slide left in lock-step. The B tile is
  // horizontally mirrored so that wherever bgA's right edge meets bgB's left
  // edge (or vice versa) the same column of pixels is shown on both sides,
  // hiding the seam regardless of whether the source image was authored to
  // tile.
  if (game.state === 'playing' || game.state === 'won') {
    bgOffsetX += game.speed * pxPerWorldUnit() * PARALLAX_FACTOR * dt;
    const pos = -((bgOffsetX) % bgTileWidth);   // ∈ (-bgTileWidth, 0]
    bgA.style.transform = `translateX(${pos}px)`;
    bgB.style.transform = `translateX(${pos + bgTileWidth}px)`;
  }

  if (game.state === 'playing') {
    game.introTime += dt;

    if (game.introTime < INTRO_STAND) {
      // Stand still — Play has just been pressed.
      game.speed = 0;
    } else if (game.introTime < INTRO_TOTAL) {
      // Ramp up: 0 → baseSpeed over INTRO_RAMP seconds.
      const t = (game.introTime - INTRO_STAND) / INTRO_RAMP;
      game.speed = game.baseSpeed * t;
      if (game.currentAction !== 'run') playAction('run');
    } else {
      // Normal play — speed picks up every 4 obstacles passed (handled in
      // the score block). Hold whatever the current speed is here.
    }

    const c = game.character!;
    c.position.y += game.velocityY * dt;
    game.velocityY += GRAVITY * dt;
    if (c.position.y <= GROUND_Y) {
      c.position.y = GROUND_Y;
      game.velocityY = 0;
      if (!game.onGround) {
        game.jumpsRemaining = 2;  // refresh on landing
        playAction('run');         // back to running
      }
      game.onGround = true;
    }

    // Spawn obstacles up to WIN_JUMPS; after that, the taxi takes the next
    // slot in the queue. Hold off until the intro ends so the player has a
    // beat to acclimate.
    if (game.introTime >= INTRO_TOTAL) {
      game.spawnTimer -= dt;
    }
    if (game.spawnTimer <= 0) {
      if (game.obstaclesSpawned < WIN_JUMPS) {
        spawnObstacle();
        game.obstaclesSpawned += 1;
        // Varied but bounded gaps — no more 6-sec voids.
        const speedScale = game.baseSpeed / game.speed;
        if (Math.random() < 0.2) {
          // Occasional cluster — quick second after the previous obstacle.
          game.spawnTimer = (1.0 + Math.random() * 0.5) * speedScale;
        } else {
          // Default breather — 2.0 to 4.0 seconds.
          game.spawnTimer = (2.0 + Math.random() * 1.5) * speedScale;
        }
      } else if (!game.taxi) {
        spawnTaxi();
        game.spawnTimer = Infinity;       // no more spawns after the taxi
      }
    }

    for (const o of game.obstacles) {
      o.mesh.position.x -= game.speed * dt;
      if (!o.scored && o.mesh.position.x < CHAR_X - 0.5) {
        o.scored = true;
        game.jumps += 1;
        setScore();
        // Bump speed by 10% every 4th obstacle for a gentle ramp.
        if (game.jumps % 4 === 0) {
          game.speed *= 1.10;
        }
      }
    }

    // Taxi scrolls like an obstacle until it pulls up next to the character;
    // then we freeze the world and start the pickup choreography.
    if (game.taxi) {
      game.taxi.position.x -= game.speed * dt;
      if (game.taxi.position.x <= TAXI_PARK_X) {
        game.taxi.position.x = TAXI_PARK_X;
        triggerPickup();
      }
    }
    game.obstacles = game.obstacles.filter((o) => {
      if (o.mesh.position.x < despawnX()) { o.mesh.visible = false; return false; }
      return true;
    });

    if (checkCollision()) triggerLoss();

  } else if (game.state === 'won') {
    // Keep character physics running so they land if they were mid-jump when
    // the win condition triggered (without this they'd freeze in mid-air).
    if (game.character) {
      game.character.position.y += game.velocityY * dt;
      game.velocityY += GRAVITY * dt;
      if (game.character.position.y <= GROUND_Y) {
        game.character.position.y = GROUND_Y;
        game.velocityY = 0;
        game.onGround = true;
      }
    }

    for (const o of game.obstacles) o.mesh.position.x -= game.speed * dt;
    game.obstacles = game.obstacles.filter((o) => {
      if (o.mesh.position.x < despawnX()) { o.mesh.visible = false; return false; }
      return true;
    });

    if (game.taxiPhase === 'pickup') {
      game.taxiTimer -= dt;
      if (game.character) {
        const elapsed = PICKUP_DURATION - game.taxiTimer;
        const TARGET_X = TAXI_PARK_X - 0.6;     // stop right at the door

        if (elapsed < STAND_DURATION) {
          // Brief stop after passing the last obstacle.
          if (game.currentAction !== 'stand') playAction('stand');
        } else if (elapsed < STAND_DURATION + WALK_DURATION) {
          // Run/jog up the road to the taxi.
          if (game.currentAction !== 'run') playAction('run');
          const wt = (elapsed - STAND_DURATION) / WALK_DURATION;
          game.character.position.x = CHAR_X + wt * (TARGET_X - CHAR_X);
        } else {
          // Reached the door — stand and fade out.
          if (game.currentAction !== 'stand') playAction('stand');
          game.character.position.x = TARGET_X;
          const ft = Math.max(0, game.taxiTimer / FADE_DURATION);
          game.character.traverse((c) => {
            const m = c as THREE.Mesh;
            if (m.isMesh) {
              const mat = m.material as THREE.MeshStandardMaterial;
              if (mat) mat.opacity = ft;
            }
          });
        }
      }
      if (game.taxiTimer <= 0 && game.character) {
        scene.remove(game.character);
        game.character = null;
        // Taxi stays parked — show the win overlay right away.
        game.taxiPhase = 'done';
        showWinOverlay();
      }
    }
  }

  renderer.render(scene, camera);
}

// ─── Boot ────────────────────────────────────────────────────
(async function boot() {
  try {
    await loadAssets();
  } catch (err) {
    console.error(err);
    loaderEl.textContent =
      'Failed to load GLB models. Check src/assets/models/.';
    return;
  }
  loaderEl.style.display = 'none';

  // Show the Play overlay; the game only starts on the first click.
  const startOverlay = document.getElementById('startOverlay') as HTMLDivElement;
  const playBtn = document.getElementById('playBtn') as HTMLButtonElement;
  startOverlay.classList.add('show');
  playBtn.addEventListener('click', () => {
    startOverlay.classList.remove('show');
    startGame();
    tick();
  }, { once: true });
})();
