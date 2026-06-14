import type { AudioEngine } from './audioEngine';
import type { RadioSignal } from '../systems/radio';

/**
 * Synthesized radio audio (M3 §4.4) on the engine's `radio` bus:
 *  - static bed: looped seeded-noise through a band-pass, level = 1 − lock
 *  - heterodyne whistle: detune tracks dial distance to the nearest signal
 *    (the classic "approaching a station" cue)
 *  - morse beacon: gated ~620 Hz tone following the message pattern
 *  - 'voice': unintelligible distant-voice placeholder (wandering formants)
 * All graphs are built once on engine.onReady; per-frame work is parameter
 * automation only (no node churn). Silent without errors pre-gesture.
 *
 * Spec: docs/m3-specs/radio.md
 */

const DIT = 0.085;
const DAH = DIT * 3;
const TAIL = 1.2; // silence between message loops

// Morse table (A–Z, 0–9). Unknown chars / spaces become a word gap.
const MORSE: Record<string, string> = {
  A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.',
  H: '....', I: '..', J: '.---', K: '-.-', L: '.-..', M: '--', N: '-.',
  O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-', U: '..-',
  V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..',
  '0': '-----', '1': '.----', '2': '..---', '3': '...--', '4': '....-',
  '5': '.....', '6': '-....', '7': '--...', '8': '---..', '9': '----.',
};

export class RadioAudio {
  private readonly engine: AudioEngine;
  private built = false;
  private disposed = false;

  // Speaker chain + per-voice gains (created once in onReady).
  private voiceGain!: GainNode;
  private staticGain!: GainNode;
  private hetGain!: GainNode;
  private hetOsc!: OscillatorNode;
  private morseGain!: GainNode;
  private voiceLevelGain!: GainNode; // on/off gate for the spoken voice

  private on = false;

  // Morse pattern timeline (cumulative starts + on/off flags), rebuilt on
  // signal change. Plain parallel arrays → allocation-free scan per frame.
  private curSignal: RadioSignal | null = null;
  private segStart: number[] = [];
  private segOn: boolean[] = [];
  private morseTotal = 0;
  private morsePhase = 0;

  constructor(engine: AudioEngine) {
    this.engine = engine;
    engine.onReady((ctx) => {
      if (this.disposed) return;
      this.build(ctx);
    });
  }

  private build(ctx: AudioContext): void {
    const bus = this.engine.radio;
    if (!bus) return;

    // Speaker character: telephone-band grit (HP 280 → LP 3200).
    this.voiceGain = ctx.createGain();
    this.voiceGain.gain.value = 0; // starts off
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 280;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3200;
    this.voiceGain.connect(hp);
    hp.connect(lp);
    lp.connect(bus);

    // 1. Static bed.
    const noise = this.engine.noiseBuffer(2, 77);
    this.staticGain = ctx.createGain();
    this.staticGain.gain.value = 0;
    const staticBP = ctx.createBiquadFilter();
    staticBP.type = 'bandpass';
    staticBP.frequency.value = 1600;
    staticBP.Q.value = 0.5;
    staticBP.connect(this.staticGain);
    this.staticGain.connect(this.voiceGain);
    if (noise) {
      const src = ctx.createBufferSource();
      src.buffer = noise;
      src.loop = true;
      src.connect(staticBP);
      src.start();
    }

    // 2. Heterodyne whistle.
    this.hetOsc = ctx.createOscillator();
    this.hetOsc.type = 'sine';
    this.hetOsc.frequency.value = 400;
    this.hetGain = ctx.createGain();
    this.hetGain.gain.value = 0;
    this.hetOsc.connect(this.hetGain);
    this.hetGain.connect(this.voiceGain);
    this.hetOsc.start();

    // 3. Morse beacon.
    const morseOsc = ctx.createOscillator();
    morseOsc.type = 'square';
    morseOsc.frequency.value = 620;
    const morseLP = ctx.createBiquadFilter();
    morseLP.type = 'lowpass';
    morseLP.frequency.value = 1200;
    this.morseGain = ctx.createGain();
    this.morseGain.gain.value = 0;
    morseOsc.connect(morseLP);
    morseLP.connect(this.morseGain);
    this.morseGain.connect(this.voiceGain);
    morseOsc.start();

    // 4. Distant voice — two detuned saws through three wandering formants,
    //    with a slow tremolo. voiceLevelGain is the on/off gate (so the
    //    tremolo never leaks when the voice is silent).
    const saw1 = ctx.createOscillator();
    saw1.type = 'sawtooth';
    saw1.frequency.value = 110;
    const saw2 = ctx.createOscillator();
    saw2.type = 'sawtooth';
    saw2.frequency.value = 111.5;
    const tremGain = ctx.createGain(); // tremolo-modulated body
    tremGain.gain.value = 0.65;
    const formantSpecs: Array<[number, number, number, number]> = [
      // [centre, Q, lfoHz, lfoDepth]
      [520, 9, 0.31, 160],
      [1180, 9, 0.47, 240],
      [2500, 9, 0.23, 300],
    ];
    for (const [centre, q, lfoHz, depth] of formantSpecs) {
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = centre;
      f.Q.value = q;
      saw1.connect(f);
      saw2.connect(f);
      f.connect(tremGain);
      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = lfoHz;
      const lfoDepth = ctx.createGain();
      lfoDepth.gain.value = depth;
      lfo.connect(lfoDepth);
      lfoDepth.connect(f.frequency);
      lfo.start();
    }
    // AM tremolo on the voice body.
    const trem = ctx.createOscillator();
    trem.type = 'sine';
    trem.frequency.value = 5.5;
    const tremDepth = ctx.createGain();
    tremDepth.gain.value = 0.35;
    trem.connect(tremDepth);
    tremDepth.connect(tremGain.gain);
    trem.start();
    this.voiceLevelGain = ctx.createGain();
    this.voiceLevelGain.gain.value = 0;
    tremGain.connect(this.voiceLevelGain);
    this.voiceLevelGain.connect(this.voiceGain);
    saw1.start();
    saw2.start();

    this.built = true;
    // Reflect any setOn() that happened before the graph existed.
    this.voiceGain.gain.value = this.on ? 0.9 : 0;
  }

  /** Power state: ramps the whole radio voice in/out (~80 ms). */
  setOn(on: boolean): void {
    this.on = on;
    if (!this.built) return;
    const ctx = this.engine.ctx;
    if (!ctx) return;
    this.voiceGain.gain.setTargetAtTime(on ? 0.9 : 0, ctx.currentTime, 0.08);
    if (on) {
      // Tiny power pop.
      const pop = ctx.createOscillator();
      pop.type = 'sine';
      pop.frequency.value = 50;
      const pg = ctx.createGain();
      pg.gain.setValueAtTime(0.18, ctx.currentTime);
      pg.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.09);
      pop.connect(pg);
      pg.connect(this.voiceGain);
      pop.start();
      pop.stop(ctx.currentTime + 0.1);
    }
  }

  /**
   * Per-frame drive. staticLevel/lock/audible are 0..1; dialDelta is the
   * signed MHz distance to the nearest signal (heterodyne pitch); signal is
   * the locked signal (its kind/message select the foreground voice) or null.
   */
  update(dt: number, staticLevel: number, lock: number, audible: number, dialDelta: number, signal: RadioSignal | null): void {
    if (!this.built || this.disposed) return;
    const ctx = this.engine.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;

    this.staticGain.gain.setTargetAtTime(0.32 * staticLevel, t, 0.05);

    // Heterodyne: whistles only near a carrier, vanishes when centred/locked.
    const ad = Math.abs(dialDelta);
    const hetFreq = Math.min(2800, 120 + ad * 750);
    this.hetOsc.frequency.setTargetAtTime(hetFreq, t, 0.04);
    const hetLevel = 0.18 * (1 - lock) * Math.max(0, 1 - ad / 1.6);
    this.hetGain.gain.setTargetAtTime(hetLevel, t, 0.04);

    // Foreground voice selection.
    const isMorse = signal !== null && signal.kind === 'morse';
    const isVoice = signal !== null && signal.kind === 'voice';
    if (signal !== this.curSignal) {
      this.curSignal = signal;
      this.rebuildMorse(isMorse ? signal!.message : undefined);
    }

    let morseLevel = 0;
    if (isMorse && this.morseTotal > 0) {
      this.morsePhase += dt;
      if (this.morsePhase >= this.morseTotal) this.morsePhase %= this.morseTotal;
      if (this.segmentOn(this.morsePhase)) morseLevel = 0.42 * audible;
    }
    this.morseGain.gain.setTargetAtTime(morseLevel, t, 0.008);

    this.voiceLevelGain.gain.setTargetAtTime(isVoice ? 0.42 * audible : 0, t, 0.03);
  }

  /** Cumulative-time scan (small array, allocation-free). */
  private segmentOn(phase: number): boolean {
    const starts = this.segStart;
    let on = false;
    for (let i = 0; i < starts.length; i++) {
      if (phase >= starts[i]) on = this.segOn[i];
      else break;
    }
    return on;
  }

  /** Rebuild the morse timeline (event, not per-frame — allocation OK). */
  private rebuildMorse(message: string | undefined): void {
    this.segStart.length = 0;
    this.segOn.length = 0;
    this.morseTotal = 0;
    this.morsePhase = 0;
    if (!message) return;

    const ons: boolean[] = [];
    const durs: number[] = [];
    const pushOn = (d: number) => {
      ons.push(true);
      durs.push(d);
    };
    const pushOff = (d: number) => {
      if (ons.length > 0 && !ons[ons.length - 1]) durs[durs.length - 1] += d;
      else {
        ons.push(false);
        durs.push(d);
      }
    };

    for (const ch of message.toUpperCase()) {
      if (ch === ' ') {
        pushOff(7 * DIT);
        continue;
      }
      const code = MORSE[ch];
      if (!code) {
        pushOff(7 * DIT);
        continue;
      }
      for (let i = 0; i < code.length; i++) {
        pushOn(code[i] === '.' ? DIT : DAH);
        if (i < code.length - 1) pushOff(DIT); // intra-character gap
      }
      pushOff(3 * DIT); // inter-character gap
    }
    pushOff(TAIL); // loop tail

    let acc = 0;
    for (let i = 0; i < ons.length; i++) {
      this.segStart.push(acc);
      this.segOn.push(ons[i]);
      acc += durs[i];
    }
    this.morseTotal = acc;
  }

  dispose(): void {
    this.disposed = true;
    // Oscillators/sources stop with the AudioContext close in AudioEngine;
    // drop our references so the graph can be collected.
    this.built = false;
  }
}
