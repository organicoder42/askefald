import { Engine } from './core/engine';
import { Input } from './core/input';
import { qualityManager } from './core/quality';
import { SceneManager, type GameScene } from './core/sceneManager';
import { FreeCam } from './debug/freeCam';
import { PerfHud } from './debug/perfHud';
import { setupLookdevGui } from './debug/gui';
import { createPostStack } from './graphics/post';
import { ACT_CONFIGS } from './graphics/palette';
import { buildLookdevScene } from './scenes/lookdev';
import { createAct1City, type Act1Deps } from './scenes/act1_city';
import { AudioEngine } from './audio/audioEngine';
import { GameState } from './systems/gameState';
import { Meters } from './systems/meters';
import { GeigerAudio } from './audio/geigerAudio';
import { GeigerCounter } from './systems/geiger';
import { Radio } from './systems/radio';
import { DialogueRunner } from './systems/dialogue';
import { SaveSystem } from './systems/save';
import { UiShell } from './ui/uiShell';
import { Hud } from './ui/hud';
import { SubtitleDisplay } from './ui/subtitles';
import { RadioOverlay } from './ui/radioOverlay';
import { JournalUi } from './ui/journal';
import { ACT1_JOURNAL } from './story/act1Beats';

// ---- M3: scene manager + survival systems / radio / dialogue / journal ----

const container = document.getElementById('app')!;
const engine = new Engine(container);
const input = new Input(engine.canvas);
const perfHud = new PerfHud(engine);
const freeCam = new FreeCam(engine.camera, input);
freeCam.enabled = false;

engine.resolutionScale = qualityManager.current.resolutionScale;
engine.applySize();

const post = createPostStack(engine, {
  godRaysSource: null,
  quality: qualityManager.current,
  act: 'act1',
});
post.setExposure(ACT_CONFIGS.act1.exposure, true);
engine.setRenderFn((dt) => post.render(dt));
engine.onResize((w, h) => post.setSize(w, h));

// App-level singletons (survive scene switches). Audio stays silent until
// the first user gesture; the UI shell is one fixed overlay root.
const audio = new AudioEngine();
const state = new GameState();
const ui = new UiShell();
const subtitles = new SubtitleDisplay(ui);
const dialogue = new DialogueRunner(subtitles);
const gameHud = new Hud(ui, state);
const radioOverlay = new RadioOverlay(ui, state);
const journal = new JournalUi(ui, state, ACT1_JOURNAL);
const geiger = new GeigerCounter(new GeigerAudio(audio));
const radio = new Radio(audio, state);
const meters = new Meters(state);
const save = new SaveSystem(state);

const act1Deps: Act1Deps = {
  state,
  meters,
  geiger,
  radio,
  dialogue,
  hud: gameHud,
  radioOverlay,
  journal,
  save,
};

const sceneManager = new SceneManager(engine);

// Generic glue (was per-scene wrapper code): the post stack tracks the
// scene's sun disc, free-cam yields to playable scenes, and the survival
// HUD shows only in playable scenes.
sceneManager.onSwitch((scene) => {
  post.setGodRaysSource(scene?.godRaysSource ?? null);
  if (scene?.player) freeCam.enabled = false;
  gameHud.setVisible(!!scene?.player);
});

sceneManager.register('lookdev', (): GameScene => {
  let scene: ReturnType<typeof buildLookdevScene> | null = null;
  let guiTeardown: (() => void) | null = null;
  const wrapper: GameScene = {
    id: 'lookdev',
    godRaysSource: null,
    load() {
      scene = buildLookdevScene(engine);
      wrapper.godRaysSource = scene.godRaysSource;
      post.setExposure(ACT_CONFIGS.act1.exposure, true);
      guiTeardown = setupLookdevGui(engine, scene, post);
      engine.camera.position.set(1.2, 1.7, 28);
      engine.camera.lookAt(0.5, 3.5, -80);
      freeCam.syncFromCamera(); // keep the authored framing
      freeCam.enabled = true;
    },
    update(dt, elapsed) {
      scene?.update(dt, elapsed, engine.camera);
    },
    applyQuality(q) {
      scene?.sunRig.setShadowMapSize(q.shadowMapSize);
      scene?.ash.setDensity(q.particleMultiplier);
    },
    dispose() {
      guiTeardown?.();
      scene?.dispose();
      scene = null;
      wrapper.godRaysSource = null;
    },
  };
  return wrapper;
});

sceneManager.register('act1', () => createAct1City(engine, input, post, act1Deps));

qualityManager.onChange((q) => {
  engine.resolutionScale = q.resolutionScale;
  engine.applySize();
  post.applyQuality(q);
  sceneManager.applyQuality(q);
});

// Debug controls: F3 perf HUD, F8 free-cam toggle, 1/2 scene jump.
input.onKey('F3', () => perfHud.toggle());
input.onKey('F8', () => {
  freeCam.enabled = !freeCam.enabled;
  if (freeCam.enabled) freeCam.syncFromCamera(); // continue from the current view
  const player = sceneManager.currentScene?.player;
  if (player) player.enabled = !freeCam.enabled;
});
input.onKey('Digit1', () => sceneManager.switchTo('lookdev'));
input.onKey('Digit2', () => sceneManager.switchTo('act1'));

// Gameplay controls (playable scenes only): R radio, E skip line, J journal,
// F5 quicksave, F9 quickload. Arrow keys tune the dial (handled in the scene).
const inGame = (): boolean => !!sceneManager.currentScene?.player;
input.onKey('KeyR', () => {
  if (inGame()) radio.toggle();
});
input.onKey('KeyE', () => {
  if (inGame() && dialogue.active) dialogue.advance();
});
input.onKey('KeyJ', () => {
  if (inGame()) journal.toggle();
});
input.onKey('F5', () => {
  const player = sceneManager.currentScene?.player;
  if (player) save.save('act1', { x: player.position.x, z: player.position.z, yaw: player.heading });
});
input.onKey('F9', () => {
  const data = save.load();
  if (!data) return;
  sceneManager.switchTo(data.sceneId === 'lookdev' ? 'lookdev' : 'act1');
  state.applySave(data);
  const player = sceneManager.currentScene?.player;
  if (player) player.spawn(data.player.x, data.player.z, data.player.yaw);
  radio.syncFromState();
});
perfHud.toggle(); // on by default during development

engine.onUpdate((dt, elapsed) => {
  if (freeCam.enabled) freeCam.update(dt);
  sceneManager.update(dt, elapsed);
  perfHud.update(dt);
  input.endFrame();
});

// Headless verification hooks: ?scene=lookdev, ?walk (auto-walk forward),
// ?cam=x,y,z,tx,ty,tz (free-cam pose), ?noao, ?stats.
const search = location.search;
const sceneParam = /[?&]scene=(\w+)/.exec(search)?.[1];
sceneManager.switchTo(sceneParam === 'lookdev' ? 'lookdev' : 'act1');

if (search.includes('walk')) input.debugHold('KeyW');

// ?spawn=x,z,yaw repositions the player (e.g. inside the flat to verify the
// exposure-adaptation trigger headlessly).
const spawnParam = /[?&]spawn=([^&]+)/.exec(search);
if (spawnParam) {
  const v = spawnParam[1].split(',').map(Number);
  const player = sceneManager.currentScene?.player;
  if (player && v.length === 3 && v.every((n) => Number.isFinite(n))) {
    player.spawn(v[0], v[1], v[2]);
  }
}

const camParam = /[?&]cam=([^&]+)/.exec(search);
if (camParam) {
  const v = camParam[1].split(',').map(Number);
  if (v.length === 6 && v.every((n) => Number.isFinite(n))) {
    freeCam.enabled = false; // static framing for screenshots
    const player = sceneManager.currentScene?.player;
    if (player) player.enabled = false;
    engine.camera.position.set(v[0], v[1], v[2]);
    engine.camera.lookAt(v[3], v[4], v[5]);
  }
}

if (search.includes('noao')) {
  post.applyQuality({ ...qualityManager.current, aoEnabled: false });
}

// M3 UI verification hooks (headless can't deliver gestures): ?radio turns
// the set on, ?freq=NN.N tunes it, ?journal opens the map, ?sub shows a
// sample subtitle line.
if (search.includes('radio') && !state.radio.on) radio.toggle();
const freqParam = /[?&]freq=([\d.]+)/.exec(search);
if (freqParam) {
  const f = Number(freqParam[1]);
  if (Number.isFinite(f)) state.radio.freq = f;
}
if (search.includes('journal')) journal.toggle();
if (search.includes('sub')) {
  dialogue.play([{ speaker: 'ELLEN', text: 'Vi går mod Roskilde. Hold dig tæt på.', duration: 9999 }]);
}

if (search.includes('stats')) {
  setInterval(() => {
    const info = engine.renderer.info;
    console.log(
      `STATS calls=${engine.frameStats.calls} tris=${engine.frameStats.triangles} ` +
        `geom=${info.memory.geometries} tex=${info.memory.textures} progs=${info.programs?.length ?? 0}`,
    );
  }, 2000);
}

engine.start();
document.getElementById('boot')?.remove();
