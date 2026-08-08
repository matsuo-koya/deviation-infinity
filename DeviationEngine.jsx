import React, { useState, useRef, useEffect, useCallback } from "react";
import * as Tone from "tone";

/* ============================================================
   DEVIATION∞ / 偏差機関
   予測と偏差の無限音楽装置  —  TECHNO / MINIMAL / EDM
   ============================================================
   設計思想:
     反復は聴き手の予測モデルを安定させる (familiarity ↑)。
     安定した予測の上でだけ、微小なズレが予測誤差として際立つ。
     本機は「聴取シミュレータ」を内蔵し、慣れが飽和したら偏差を
     注入し、驚きが過剰なら反復に戻る。Wundt曲線の甘い帯域に
     予測誤差を保ち続けることで、無限に演奏し続ける。
   ============================================================ */

/* ---------- palette ---------- */
const C = {
  bg: "#0E0C0A",
  panel: "#17140F",
  panel2: "#1F1B14",
  line: "#302921",
  ink: "#EDE6D6",
  dim: "#8A8172",
  dimmer: "#5C554A",
  amber: "#F0A202", // 予測 / familiarity
  blue: "#4C8DFF", // 偏差 / prediction error
};
const MONO = `ui-monospace, "SF Mono", "Roboto Mono", Menlo, Consolas, monospace`;
const SANS = `"Helvetica Neue", Inter, system-ui, sans-serif`;

/* ---------- theory ---------- */
const SCALES = {
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
};

const LAYERS = ["kick", "sub", "snare", "clap", "hat", "ohat", "perc", "bass", "acid", "stab", "pad", "piano"];

// ミキサーが持つチャンネル。演奏レイヤーに加えてFX(ライザー)も含む。
const MIX = [...LAYERS, "fx"];

// チャンネルの初期音量（線形）。低域が重なるsub/bass/acidは控えめに置く。
const DEFAULT_LEVELS = {
  kick: 0.90, sub: 0.26, snare: 0.30, clap: 0.34, hat: 0.24, ohat: 0.16,
  perc: 0.15, bass: 0.26, acid: 0.20, stab: 0.16, pad: 0.15,
  piano: 0.40,
  fx: 0.10,
};
const LAYER_JP = {
  kick: "KICK",
  sub: "SUB",
  snare: "SNARE",
  clap: "CLAP",
  hat: "HAT",
  ohat: "OPEN",
  perc: "PERC",
  bass: "BASS",
  acid: "ACID",
  stab: "STAB",
  pad: "PAD",
  piano: "PIANO",
  fx: "RISER",
};

const GATES = {
  TECHNO: { kick: 0.02, sub: 0.1, hat: 0.14, bass: 0.22, pad: 0.34, perc: 0.3, clap: 0.38, ohat: 0.5, acid: 0.52, snare: 0.58, piano: 0.6, stab: 0.66 },
  MINIMAL: { stab: 0.02, pad: 0.05, piano: 0.08, perc: 0.1, bass: 0.2, hat: 0.28, kick: 0.35, sub: 0.45, ohat: 0.62, acid: 0.7, clap: 0.8, snare: 0.86 },
  EDM: { kick: 0.05, sub: 0.12, pad: 0.15, hat: 0.18, bass: 0.25, snare: 0.28, clap: 0.3, ohat: 0.4, perc: 0.42, piano: 0.46, stab: 0.48, acid: 0.6 },
};

const MODEP = {
  TECHNO: { bpm: 132, duck: 0.45, duckT: 0.16, change: 0.55, opt: 0.12, scale: "phrygian", root: 33, swing: 0.0 },
  MINIMAL: { bpm: 108, duck: 0.9, duckT: 0.1, change: 0.3, opt: 0.055, scale: "dorian", root: 38, swing: 0.0 },
  EDM: { bpm: 126, duck: 0.2, duckT: 0.24, change: 0.7, opt: 0.18, scale: "aeolian", root: 36, swing: 0.0 },
};

/* ---------- utils ---------- */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const pick = (a) => a[(Math.random() * a.length) | 0];
const chance = (p) => Math.random() < p;

function degOf(scaleName, i) {
  const sc = SCALES[scaleName];
  return sc[((i % sc.length) + sc.length) % sc.length] + 12 * Math.floor(i / sc.length);
}

// 和音根音の半音上に当たる音度を避ける。
// Phrygianのb2のように、旋法内でも持続すると外れて聞こえる音がある。
function safeDeg(scaleName, chordDeg, d) {
  const iv = (((degOf(scaleName, chordDeg + d) - degOf(scaleName, chordDeg)) % 12) + 12) % 12;
  return iv === 1 ? d - 1 : d;
}

function euclid(k, n) {
  const p = [];
  let bucket = 0;
  for (let i = 0; i < n; i++) {
    bucket += k;
    if (bucket >= n) {
      bucket -= n;
      p.push(1);
    } else p.push(0);
  }
  return p;
}
function rotate(arr, k) {
  const n = arr.length;
  const r = ((k % n) + n) % n;
  return arr.slice(n - r).concat(arr.slice(0, n - r));
}
function hamming(a, b) {
  if (!a || !b || a.length !== b.length) return 1;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i],
      y = b[i];
    const key = (v) =>
      v && typeof v === "object" ? (v.n !== undefined ? v.n : `${v.d}:${v.oct || 0}`) : v;
    const xv = key(x), yv = key(y);
    if (xv !== yv) d++;
  }
  return d / a.length;
}
const midiToNote = (m) => Tone.Frequency(Math.round(m), "midi").toNote();

// 音を指定した音域窓へオクターブ単位で畳み込む
function foldToWindow(n, low, high) {
  let g = 0;
  while (n < low && g++ < 8) n += 12;
  g = 0;
  while (n > high && g++ < 8) n -= 12;
  // 窓幅が1オクターブ未満のときは下限側を優先する
  if (n < low) n += 12;
  return n;
}

/* ---------- iOS audio unlock ----------
   iOSはWebAudioを既定で「環境音」セッションとして扱うため、
   本体の消音スイッチがオンだと無音になる。audioSession.type を
   playback に切り替え、無音バッファを鳴らして完全に起こす。      */
let silentEl = null;
async function unlockAudio() {
  try {
    if (typeof navigator !== "undefined" && navigator.audioSession) {
      navigator.audioSession.type = "playback";
    }
  } catch (_) {}

  // 無音のHTMLAudioを一度再生してメディアセッションを確保する
  try {
    if (!silentEl) {
      const n = 4410;
      const b = new Uint8Array(44 + n * 2);
      const dv = new DataView(b.buffer);
      const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
      w(0, "RIFF"); dv.setUint32(4, 36 + n * 2, true); w(8, "WAVEfmt ");
      dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
      dv.setUint32(24, 44100, true); dv.setUint32(28, 88200, true);
      dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
      w(36, "data"); dv.setUint32(40, n * 2, true);
      silentEl = new Audio(URL.createObjectURL(new Blob([b], { type: "audio/wav" })));
      silentEl.loop = false;
      silentEl.volume = 0.001;
    }
    await silentEl.play().catch(() => {});
  } catch (_) {}

  await Tone.start();
  const ctx = Tone.getContext().rawContext || Tone.context;
  if (ctx.state !== "running") { try { await ctx.resume(); } catch (_) {} }

  // 1サンプルの無音を鳴らして起床を確定させる
  try {
    const src = ctx.createBufferSource();
    src.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    src.connect(ctx.destination);
    src.start(0);
  } catch (_) {}

  return ctx.state;
}

/* ============================================================
   AUDIO ENGINE
   ============================================================ */
function buildAudio(lite) {
  const nodes = [];
  const keep = (n) => { nodes.push(n); return n; };

  const master = keep(new Tone.Limiter(-2)).toDestination();
  const meter = keep(new Tone.Meter({ smoothing: 0.5 }));
  master.connect(meter);
  const fft = keep(new Tone.Analyser({ type: "fft", size: lite ? 32 : 64, smoothing: 0.7 }));
  master.connect(fft);
  // 直流成分と超低域の蓄積を止める
  const dcBlock = keep(new Tone.Filter(28, "highpass")).connect(master);
  const glue = keep(new Tone.Compressor({ threshold: -20, ratio: 3, attack: 0.008, release: 0.12 })).connect(dcBlock);

  /* ===== ハコの音響 =====
     bus → サチュレーション → { ドライ / フランジャ / 部屋鳴り } → スタッター → glue
     スタッターを最後段に置くのは、残響ごと断ち切るのがクラブの挙動だから。 */

  const stutterGain = keep(new Tone.Gain(1)).connect(glue);
  const roomMix = keep(new Tone.Gain(1)).connect(stutterGain);

  // 部屋鳴り。低域を切って中高域だけ返すことで、床と壁の反射に寄せる。
  const roomOut = keep(new Tone.Filter({ frequency: 6200, type: "lowpass" })).connect(roomMix);
  const roomTone = keep(new Tone.Filter({ frequency: 240, type: "highpass" })).connect(roomOut);
  let room;
  if (lite) {
    room = keep(new Tone.Freeverb({ roomSize: 0.78, dampening: 2400, wet: 1 }));
  } else {
    room = keep(new Tone.Reverb({ decay: 3.4, preDelay: 0.022, wet: 1 }));
    try { room.generate(); } catch (_) {}
  }
  room.connect(roomTone);
  const roomSend = keep(new Tone.Gain(0.12)).connect(room);

  // フランジャ。短いディレイをLFOで揺らし、フィードバックで櫛形を立てる。
  const flangeMix = keep(new Tone.Gain(0)).connect(roomMix);
  const flangeDelay = keep(new Tone.FeedbackDelay({ delayTime: 0.003, feedback: 0.45, wet: 1 })).connect(flangeMix);
  // 櫛形が低域に掛かるとキックとベースの位相が崩れる。送りの手前で切る。
  const flangeIn = keep(new Tone.Filter({ frequency: 220, type: "highpass", rolloff: -24 })).connect(flangeDelay);
  const flangeLFO = keep(new Tone.LFO({ frequency: 0.1, min: 0.0007, max: 0.0045 }));
  try { flangeLFO.connect(flangeDelay.delayTime); flangeLFO.start(); } catch (_) {}

  // サチュレーション。tanhの軟らかいクリップで、前段のゲインが駆動量になる。
  const satOut = keep(new Tone.Gain(1)).connect(roomMix);
  // 原点での傾きを1に正規化する。前段のゲインだけが駆動量になり、
  // 駆動0のときは実質リニアに通る。
  const sat = keep(new Tone.WaveShaper((x) => Math.tanh(x), 4096)).connect(satOut);
  const satIn = keep(new Tone.Gain(1)).connect(sat);
  satOut.connect(flangeIn);
  satOut.connect(roomSend);

  const bus = keep(new Tone.Gain(0.7)).connect(satIn);

  // sidechained bus — everything melodic ducks under the kick
  const duck = keep(new Tone.Gain(1)).connect(bus);

  // 軽量モードではリバーブを完全に外す（単体で最も重い）
  let verb;
  if (lite) {
    verb = keep(new Tone.Gain(0)).connect(bus);
  } else {
    verb = keep(new Tone.Freeverb({ roomSize: 0.58, dampening: 3200, wet: 1 })).connect(keep(new Tone.Limiter(-6)).connect(bus));
  }
  const verbSend = keep(new Tone.Gain(0.0)).connect(verb);
  const delay = keep(new Tone.FeedbackDelay({ delayTime: "8n.", feedback: lite ? 0.18 : 0.24, wet: 1 })).connect(
    keep(new Tone.Limiter(-6)).connect(duck)
  );
  const delaySend = keep(new Tone.Gain(0.0)).connect(delay);

  // レイヤーごとのチャンネルゲイン。ここが唯一の音量調整点になる。
  const chan = {};
  const ch = (name, dest) => (chan[name] = keep(new Tone.Gain(DEFAULT_LEVELS[name])).connect(dest));

  const kickGain = ch("kick", bus);
  const kick = keep(
    new Tone.MembraneSynth({
      pitchDecay: 0.028,
      octaves: 4.5,
      oscillator: { type: "sine" },
      envelope: { attack: 0.0008, decay: 0.3, sustain: 0, release: 0.02 },
    })
  ).connect(kickGain);
  const kickClick = keep(
    new Tone.NoiseSynth({ noise: { type: "white" }, envelope: { attack: 0.0005, decay: 0.014, sustain: 0 } })
  ).connect(keep(new Tone.Filter(2400, "bandpass")).connect(kickGain));

  const sub = keep(
    new Tone.Synth({ oscillator: { type: "sine" }, envelope: { attack: 0.008, decay: 0.2, sustain: 0.7, release: 0.14 } })
  ).connect(ch("sub", duck));

  const hatFilt = keep(new Tone.Filter(8200, "highpass")).connect(ch("hat", bus));
  const ohatFilt = keep(new Tone.Filter(7600, "highpass")).connect(ch("ohat", bus));
  const hat = keep(new Tone.NoiseSynth({ noise: { type: "white" }, envelope: { attack: 0.001, decay: 0.035, sustain: 0 } })).connect(hatFilt);
  const ohat = keep(new Tone.NoiseSynth({ noise: { type: "white" }, envelope: { attack: 0.001, decay: 0.28, sustain: 0 } })).connect(ohatFilt);

  // SNARE — 帯域ノイズ（響き線）と同調した胴の二層で作る
  const snareCh = ch("snare", bus);
  const snareNoiseFilt = keep(new Tone.Filter({ frequency: 1900, type: "bandpass", Q: 0.8 })).connect(snareCh);
  const snareNoise = keep(
    new Tone.NoiseSynth({ noise: { type: "white" }, envelope: { attack: 0.001, decay: 0.14, sustain: 0 } })
  ).connect(snareNoiseFilt);
  const snareBody = keep(
    new Tone.Synth({
      oscillator: { type: "triangle" },
      envelope: { attack: 0.001, decay: 0.1, sustain: 0, release: 0.02 },
      volume: -6,
    })
  ).connect(snareCh);

  const clapFilt = keep(new Tone.Filter({ frequency: 1500, type: "bandpass", Q: 1.2 })).connect(ch("clap", bus));
  const clap = keep(new Tone.NoiseSynth({ noise: { type: "white" }, envelope: { attack: 0.004, decay: 0.19, sustain: 0 } })).connect(clapFilt);

  // MetalSynthはFM合成で重い。軽量モードは帯域通過ノイズで代用する。
  let perc, percFilt = null, percMetal = false;
  if (lite) {
    percFilt = keep(new Tone.Filter({ frequency: 1200, type: "bandpass", Q: 3 })).connect(ch("perc", bus));
    perc = keep(new Tone.NoiseSynth({ noise: { type: "white" }, envelope: { attack: 0.001, decay: 0.09, sustain: 0 } })).connect(percFilt);
  } else {
    percMetal = true;
    perc = keep(
      new Tone.MetalSynth({
        frequency: 320,
        envelope: { attack: 0.001, decay: 0.11, release: 0.01 },
        harmonicity: 5.1,
        modulationIndex: 30,
        resonance: 3800,
        octaves: 1.4,
      })
    ).connect(ch("perc", bus));
  }

  // BASS — 303の構造に寄せる。内蔵フィルタは開けたままにして、
  // カットオフの動きは外部のレゾナントフィルタで時刻指定して作る。
  // プロパティ代入では先読み時刻とずれるため、必ずSignalで自動化する。
  const bassFilt = keep(new Tone.Filter({ frequency: 400, type: "lowpass", rolloff: -24, Q: 4 })).connect(
    ch("bass", duck)
  );
  const bass = keep(
    new Tone.MonoSynth({
      oscillator: { type: "sawtooth" },
      filter: { Q: 0.6, type: "lowpass", rolloff: -12 },
      envelope: { attack: 0.003, decay: 0.06, sustain: 1.0, release: 0.05 },
      filterEnvelope: { attack: 0.002, decay: 0.05, sustain: 1, release: 0.05, baseFrequency: 4000, octaves: 0 },
    })
  ).connect(bassFilt);
  bass.portamento = 0.055;

  const acidDist = keep(new Tone.Distortion({ distortion: 0.32, wet: 0.5 })).connect(
    keep(new Tone.Limiter(-10)).connect(ch("acid", duck))
  );
  const acid = keep(new Tone.MonoSynth({
    oscillator: { type: "sawtooth" },
    filter: { Q: 8, type: "lowpass", rolloff: -24 },
    envelope: { attack: 0.003, decay: 0.18, sustain: 0.15, release: 0.08 },
    filterEnvelope: { attack: 0.004, decay: 0.2, sustain: 0.08, release: 0.1, baseFrequency: 220, octaves: 4 },
  })).connect(acidDist);
  acid.portamento = 0.055;        // スライドはレガートの重なりで起こす
  chan.acid.connect(delaySend);   // ポストフェーダー送り

  const stab = keep(
    new Tone.PolySynth(Tone.Synth, {
      oscillator: lite ? { type: "sawtooth" } : { type: "fatsawtooth", count: 2, spread: 22 },
      envelope: { attack: 0.004, decay: 0.24, sustain: 0.0, release: 0.14 },
    })
  ).connect(ch("stab", duck));
  stab.maxPolyphony = lite ? 4 : 8;
  chan.stab.connect(verbSend);    // ポストフェーダー送り
  chan.stab.connect(delaySend);

  // PAD — 予測の地盤を担う層。厚みはコーラスと多重デチューンで作り、
  // 変化はフィルタとコーラス深度の超低速ドリフトで与える。
  const padGain = ch("pad", duck);
  const padWidth = lite ? padGain : keep(new Tone.StereoWidener(0.72)).connect(padGain);
  const padChorus = keep(
    new Tone.Chorus({ frequency: 0.45, delayTime: 4.2, depth: 0.55, spread: 170, wet: 0.65 })
  ).connect(padWidth);
  try { padChorus.start(); } catch (_) {}
  const padFilter = keep(new Tone.Filter({ frequency: 1100, type: "lowpass", rolloff: -12, Q: 0.7 })).connect(padChorus);
  // 低域はbassとsubに譲る
  const padHP = keep(new Tone.Filter({ frequency: 170, type: "highpass", rolloff: -12 })).connect(padFilter);

  const pad = keep(
    new Tone.PolySynth(Tone.Synth, {
      oscillator: lite ? { type: "fatsawtooth", count: 2, spread: 16 } : { type: "fatsawtooth", count: 3, spread: 26 },
      envelope: { attack: 2.4, decay: 1.6, sustain: 0.75, release: 4.5 },
      volume: -7,
    })
  ).connect(padHP);
  pad.maxPolyphony = lite ? 5 : 10;
  padGain.connect(verbSend);

  // PIANO — Salamander Grand Piano のマルチサンプル。数音を読み込んで
  // Tone.Sampler が音階を補間する。低域はbass/subに譲るためHPで削り、
  // 空間はverb/delay送りで作る。読み込みは非同期なので loaded を見て鳴らす。
  const pianoHP = keep(new Tone.Filter({ frequency: 130, type: "highpass", rolloff: -12 })).connect(
    ch("piano", duck)
  );
  const pianoUrls = lite
    ? { C2: "C2.mp3", C3: "C3.mp3", C4: "C4.mp3", C5: "C5.mp3", C6: "C6.mp3" }
    : {
        A1: "A1.mp3", C2: "C2.mp3", "D#2": "Ds2.mp3", "F#2": "Fs2.mp3",
        A2: "A2.mp3", C3: "C3.mp3", "D#3": "Ds3.mp3", "F#3": "Fs3.mp3",
        A3: "A3.mp3", C4: "C4.mp3", "D#4": "Ds4.mp3", "F#4": "Fs4.mp3",
        A4: "A4.mp3", C5: "C5.mp3", "D#5": "Ds5.mp3", "F#5": "Fs5.mp3",
        A5: "A5.mp3", C6: "C6.mp3",
      };
  const piano = keep(
    new Tone.Sampler({
      urls: pianoUrls,
      baseUrl: "https://tonejs.github.io/audio/salamander/",
      release: 1.1,
      volume: -1,
    })
  ).connect(pianoHP);
  piano.maxPolyphony = lite ? 6 : 16;
  chan.piano.connect(verbSend);   // ポストフェーダー送り
  chan.piano.connect(delaySend);

  // ライザーはstart/stopを使わない。先読みスケジューリングでは未来時刻の
  // start()がSourceの状態と矛盾して例外を投げるため、常時鳴らしてゲインで開閉する。
  const riserAmp = keep(new Tone.Gain(0)).connect(ch("fx", bus));
  const riserFilt = new Tone.Filter({ frequency: 400, type: "bandpass", Q: 1.5 }).connect(riserAmp);
  const riser = new Tone.Noise("pink").connect(riserFilt);

  // iOS SafariはMediaRecorderのwebm出力に非対応。ここで落とさない。
  let recorder = null;
  try {
    if (typeof MediaRecorder !== "undefined") {
      recorder = new Tone.Recorder();
      master.connect(recorder);
    }
  } catch (_) {
    recorder = null;
  }

  return {
    lite, nodes, chan, fft, percFilt, percMetal, ohatFilt,
    stutterGain, roomMix, room, roomSend, flangeMix, flangeDelay, flangeIn, flangeLFO, sat, satIn, satOut,
    snareNoise, snareBody, snareNoiseFilt, bassFilt,
    master, meter, dcBlock, glue, bus, duck, verb, verbSend, delay, delaySend,
    kick, kickClick, kickGain, sub, hat, ohat, hatFilt, clap, clapFilt, perc,
    bass, acid, acidDist, stab, pad, padHP, padFilter, padChorus, padWidth, padGain,
    piano, pianoHP,
    riser, riserFilt, riserAmp, recorder,
  };
}

/* ============================================================
   PATTERN GENERATION
   ============================================================ */
function genPatterns(mode, root, scaleName) {
  const sc = SCALES[scaleName];
  const deg = (i) => sc[((i % sc.length) + sc.length) % sc.length] + 12 * Math.floor(i / sc.length);

  const p = {};

  if (mode === "MINIMAL") {
    p.kick = euclid(4, 16).map((v, i) => (i % 4 === 0 ? 1 : 0));
    p.hat = rotate(euclid(pick([5, 7, 9]), 16), 0);
    p.ohat = euclid(2, 16);
    // クラップはバックビート(2・4拍=step4,12)。裏には行かず、たまに表拍(0/8)のゴースト。
    p.clap = Array.from({ length: 16 }, (_, i) =>
      i === 4 || i === 12 ? 1 : (i === 0 || i === 8) && chance(0.1) ? 1 : 0
    );
    p.perc = euclid(pick([3, 5, 7]), 16);
    p.snare = Array.from({ length: 16 }, (_, i) => (i === 12 ? 1 : 0));
  } else {
    p.kick = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
    p.hat = Array.from({ length: 16 }, (_, i) => (i % 2 === 1 ? 1 : chance(0.15) ? 1 : 0));
    p.ohat = Array.from({ length: 16 }, (_, i) => (i % 8 === 6 ? 1 : 0));
    // クラップはバックビート(2・4拍=step4,12)。裏には行かず、たまに表拍(0/8)のゴースト。
    p.clap = Array.from({ length: 16 }, (_, i) =>
      i === 4 || i === 12 ? 1 : (i === 0 || i === 8) && chance(0.12) ? 1 : 0
    );
    p.perc = euclid(pick([3, 5, 7]), 16);
    // スネアは裏拍を担当し、たまにゴーストノートを置く
    p.snare = Array.from({ length: 16 }, (_, i) =>
      i === 4 || i === 12 ? 1 : (i === 7 || i === 14 || i === 10) && chance(0.3) ? 1 : 0
    );
  }

  p.sub = Array.from({ length: 16 }, (_, i) => (i % 8 === 0 ? 1 : 0));

  // bass: キック/サブと連動した上で遊ぶ。生のドラム&ベースの噛み合いに倣い、
  // まずキック拍(特に小節頭)に乗って土台をロックし、8分裏で遊ぶ。
  // 音度は和音度からの相対で保つ(主音固定にすると和音が動いたとき取り残される)。
  // bassDegはキック拍に根音、裏拍に5th/3rd/7thが来るよう配置してある。
  const bassDeg = [0, 0, 0, 4, 0, 2, 0, 6];
  p.bass = Array.from({ length: 16 }, (_, i) => {
    const kickBeat = i % 4 === 0;   // キックと同じ拍 (0,4,8,12)
    const off = i % 4 === 2;        // 8分裏 — 遊びの場
    let on;
    if (i === 0) on = true;                                          // 小節頭は必ずロック
    else if (kickBeat) on = chance(mode === "MINIMAL" ? 0.5 : 0.7);  // 他のキック拍にも高確率で連動
    else if (off) on = chance(mode === "MINIMAL" ? 0.5 : 0.85);      // 裏で遊ぶ
    else on = chance(0.1);                                           // 16分の経過音は稀に
    if (!on) return null;
    return { d: bassDeg[(i / 2) | 0] ?? 0, a: kickBeat ? chance(0.55) : chance(0.3), s: chance(0.26) };
  });

  // acid: 和音度からの相対音度で保持する。和音が動けば追随する。
  // 強拍はコードトーン、弱拍は経過音を許す。
  const dens = mode === "MINIMAL" ? 0.3 : 0.48;
  p.acid = Array.from({ length: 16 }, (_, i) =>
    chance(dens)
      ? {
          d: i % 4 === 0 ? pick([0, 0, 2, 4]) : pick([0, 0, 2, 4, 6, 1, 3, 5]),
          oct: chance(0.16) ? 1 : 0,
          a: chance(0.3),
          s: chance(0.25),
        }
      : null
  );

  // stab / pulse motor
  if (mode === "MINIMAL") {
    p.stab = Array.from({ length: 16 }, (_, i) =>
      i % 2 === 0 || chance(0.25) ? { n: root + 36 + deg(pick([0, 1, 2, 4, 5])), a: i % 4 === 0 } : null
    );
  } else {
    p.stab = Array.from({ length: 16 }, (_, i) =>
      (i % 8 === 3 || i % 8 === 6) && chance(0.8) ? { n: root + 24 + deg(pick([0, 2, 4])), a: true } : null
    );
  }

  // piano: 和音度を分散和音で辿る。stab(刻み)やpad(持続)と役割を分け、
  // 8分グリッド上をアルペジオで動く。音高は再生時に現在の和音度から導く。
  const pianoArp = mode === "MINIMAL" ? [0, 2, 4, 6, 4, 2] : [0, 2, 4, 2];
  const pianoDens = mode === "MINIMAL" ? 0.62 : mode === "EDM" ? 0.5 : 0.42;
  p.piano = Array.from({ length: 16 }, (_, i) => {
    if (i % 2 !== 0) return null;               // 8分グリッド
    if (!chance(pianoDens)) return null;
    const d = pianoArp[((i / 2) | 0) % pianoArp.length];
    return { d, oct: chance(0.18) ? 1 : 0, a: i % 8 === 0 };
  });

  return p;
}

function chordOf(root, scaleName, deg = 0) {
  const sc = SCALES[scaleName];
  const d = (i) => sc[((i % sc.length) + sc.length) % sc.length] + 12 * Math.floor(i / sc.length);
  return [root + 24 + d(deg), root + 24 + d(deg + 2), root + 24 + d(deg + 4)];
}

/* ---------- PAD の声部 ----------
   和音そのものはほとんど動かさない。動かすのは配置と付加音だけ。
   反復で固まった予測の上で、色だけがわずかにずれる状態を作る。 */
function padNotes(root, scaleName, chordDeg, st) {
  const sc = SCALES[scaleName];
  const d = (i) => sc[((i % sc.length) + sc.length) % sc.length] + 12 * Math.floor(i / sc.length);

  const degs = [0, st.sus ? 3 : 2, 4];
  if (st.tension === 9) {
    // 旋法の第2音が短2度ならb9になって濁る。その場合は11thで代替する。
    const iv = (d(chordDeg + 8) - d(chordDeg) + 120) % 12;
    degs.push(iv === 1 ? 10 : 8);
  } else if (st.tension === 6) degs.push(5);
  else if (st.tension === 7) degs.push(6);

  // 音名の集合に落としてから、音域窓の中へ配置する。
  // 窓に収まらない声部は捨てる。これで幅も衝突も上限が保証される。
  const pcs = [];
  for (const x of degs) {
    const pc = (((root + d(chordDeg + x)) % 12) + 12) % 12;
    if (!pcs.includes(pc)) pcs.push(pc);
  }

  // 下限そのものに上限を設けることで、窓の幅は常に確保しつつ音域を抑える
  const low = Math.min(root + 22 + st.inv * 3, 64);
  const ceil = low + 22;                          // 幅は2オクターブ以内
  const notes = [];
  pcs.forEach((pc, idx) => {
    let n = low + ((((pc - low) % 12) + 12) % 12);
    if (st.open && idx === 1) n += 12;  // 開離配置は内声を上へ
    let tries = 0;
    while (
      notes.some((m) => m === n || Math.abs(m - n) === 1 || Math.abs(m - n) === 13) &&
      tries++ < 3
    ) {
      n += 12;
    }
    if (n <= ceil) notes.push(n);
  });
  notes.sort((a, b) => a - b);
  // 声部が痩せたら付加音を諦めて三和音に戻す
  if (notes.length < 3 && st.tension) return padNotes(root, scaleName, chordDeg, { ...st, tension: null });
  return notes;
}

function padLabel(st) {
  const base = st.sus ? "sus4" : "triad";
  const t = st.tension ? `add${st.tension}` : "";
  return `${base}${t ? " " + t : ""} / inv${st.inv}${st.open ? " open" : ""}`;
}

function padDeviate(st) {
  const ops = [];
  if (st.inv !== 0 || true) ops.push("INVERT");
  ops.push("TENSION", "OPEN", "SUS");
  const op = pick(ops);
  if (op === "INVERT") {
    st.inv = (st.inv + (chance(0.5) ? 1 : 2)) % 3;
    return `PAD 転回 → inv${st.inv}`;
  }
  if (op === "TENSION") {
    st.tension = pick([null, 9, 6, 7, 9]);
    return `PAD 付加音 → ${st.tension ? st.tension + "th" : "なし"}`;
  }
  if (op === "OPEN") {
    st.open = !st.open;
    return `PAD 配置 → ${st.open ? "開離" : "密集"}`;
  }
  st.sus = !st.sus;
  return `PAD 三度 → ${st.sus ? "sus4に置換" : "三度に復帰"}`;
}

/* ============================================================
   SECTION / ARC
   ============================================================ */
function nextSection(mode, prev) {
  if (mode === "EDM") {
    const order = ["intro", "build", "drop", "sustain", "break", "build", "drop", "tunnel"];
    const i = prev ? (order.indexOf(prev.type) + 1) % order.length : 0;
    const t = order[i];
    const map = {
      intro: [16, 0.3], build: [16, 0.95], drop: [32, 0.92], sustain: [16, 0.78],
      break: [16, 0.26], tunnel: [24, 0.62],
    };
    return { type: t, len: map[t][0], target: map[t][1], left: map[t][0] };
  }
  if (mode === "MINIMAL") {
    const t = pick(["process", "process", "process", "thin", "dense"]);
    const map = { process: [32, 0.35 + Math.random() * 0.3], thin: [16, 0.18], dense: [32, 0.72] };
    return { type: t, len: map[t][0], target: map[t][1], left: map[t][0] };
  }
  const t = pick(["groove", "groove", "strip", "build", "peak", "tunnel"]);
  const map = { groove: [32, 0.5 + Math.random() * 0.2], strip: [16, 0.3], build: [16, 0.86], peak: [32, 0.9], tunnel: [24, 0.6] };
  return { type: t, len: map[t][0], target: map[t][1], left: map[t][0] };
}

/* ============================================================
   DEVIATION OPERATORS
   ============================================================ */
// 予測の地盤を保証する。偏差が何をしても、キックの4つ打ち(0,4,8,12)と
// 小節頭、サブの土台、そして両者の位相は常に元へ戻す。地盤が動くと
// 一貫性を測る基準そのものが消え、偏差が偏差として聴こえなくなる。
function enforceAnchors(E) {
  E.phase.kick = 0;
  if (E.pat.kick) {
    E.pat.kick = E.pat.kick.slice();
    for (let i = 0; i < 16; i += 4) E.pat.kick[i] = 1;   // 4つ打ちを再確約
  }
  E.phase.sub = 0;
  if (E.pat.sub) {
    E.pat.sub = E.pat.sub.slice();
    E.pat.sub[0] = 1;   // 小節頭
    E.pat.sub[8] = 1;   // 半小節
  }
  // クラップはバックビート(4,12)を維持し、裏拍(8分裏・16分)には出さない。
  // 表拍(0/8)のゴーストだけは許す。位相もずらさない。
  E.phase.clap = 0;
  if (E.pat.clap) {
    E.pat.clap = E.pat.clap.slice();
    for (let i = 0; i < 16; i++) if (i % 4 !== 0) E.pat.clap[i] = 0;
    E.pat.clap[4] = 1;
    E.pat.clap[12] = 1;
  }
  // ベースは小節頭でキック/サブと連動(根音)。遊びは残し、頭のロックだけ確約する。
  E.phase.bass = 0;
  if (E.pat.bass) {
    E.pat.bass = E.pat.bass.slice();
    const b0 = E.pat.bass[0];
    E.pat.bass[0] = b0 && typeof b0 === "object" ? { ...b0, d: 0 } : { d: 0, a: true, s: false };
  }
}

function applyDeviation(E) {
  const drumLayers = ["hat", "perc", "ohat", "clap", "snare", "kick"].filter((l) => E.active[l]);
  const toneLayers = ["bass", "acid", "stab"].filter((l) => E.active[l]);
  const all = [...drumLayers, ...toneLayers];
  if (!all.length) return null;

  const sc = SCALES[E.scaleName];
  const deg = (i) => sc[((i % sc.length) + sc.length) % sc.length] + 12 * Math.floor(i / sc.length);

  const ops = [];
  const w = (name, weight, fn) => ops.push({ name, weight, fn });

  w("ROTATE", 3, () => {
    // キック/クラップは回転させない。小節頭やバックビートがずれて地盤が動く。
    const l = pick(all.filter((x) => x !== "kick" && x !== "clap"));
    if (!l) return null;
    E.pat[l] = rotate(E.pat[l], chance(0.5) ? 1 : -1);
    return `${LAYER_JP[l]} を1ステップ回転`;
  });
  w("FLIP", 3, () => {
    const l = pick(drumLayers.length ? drumLayers : all);
    let i = (Math.random() * 16) | 0;
    // キックの4つ打ち(0,4,8,12)は反転で消さない。裏拍側だけを対象にする。
    if (l === "kick" && i % 4 === 0) i = (i + 1 + ((Math.random() * 3) | 0)) % 16;
    // クラップは裏に出さない。表拍(0/8)のゴーストだけを増減させる。
    if (l === "clap") i = pick([0, 8]);
    E.pat[l] = E.pat[l].slice();
    E.pat[l][i] = E.pat[l][i] ? 0 : 1;
    return `${LAYER_JP[l]} step ${i} を反転`;
  });
  w("PHASE", E.mode === "MINIMAL" ? 5 : 1, () => {
    // キックは位相ずらしの対象外。地盤の頭を固定する。
    const l = pick(["perc", "stab", "hat"].filter((x) => E.active[x])) || pick(all.filter((x) => x !== "kick"));
    if (!l) return null;
    E.phase[l] = (E.phase[l] || 0) + 1;
    E.process = "PHASING";
    return `${LAYER_JP[l]} を位相ずらし (+${E.phase[l]})`;
  });
  w("ADD", E.mode === "MINIMAL" ? 4 : 2, () => {
    // クラップは裏拍への追加を避けるため対象から外す(バックビート固定)。
    const l = pick(toneLayers.length ? toneLayers : all.filter((x) => x !== "clap"));
    if (!l) return null;
    const empty = E.pat[l].map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
    if (!empty.length) return null;
    const i = pick(empty);
    E.pat[l] = E.pat[l].slice();
    E.pat[l][i] =
      l === "bass"
        ? { d: pick([0, 0, 2, 4, 6]), a: chance(0.3), s: chance(0.3) }
        : l === "acid"
        ? { d: i % 4 === 0 ? pick([0, 2, 4]) : pick([0, 2, 4, 6, 1, 3, 5]), oct: 0, a: chance(0.4), s: chance(0.3) }
        : { n: E.root + 24 + deg(pick([0, 1, 2, 4, 5])), a: chance(0.4), s: chance(0.3) };
    E.process = "ADDITIVE";
    return `${LAYER_JP[l]} に音を追加 (step ${i})`;
  });
  w("SUBTRACT", 2, () => {
    const l = pick(all);
    let full = E.pat[l].map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
    // キックの4つ打ちは削除対象から外す。裏拍のゴーストだけ間引ける。
    if (l === "kick") full = full.filter((i) => i % 4 !== 0);
    // クラップのバックビート(4,12)は削除しない。
    if (l === "clap") full = full.filter((i) => i !== 4 && i !== 12);
    if (full.length < 3) return null;
    const i = pick(full);
    E.pat[l] = E.pat[l].slice();
    E.pat[l][i] = l === "bass" || l === "acid" || l === "stab" ? null : 0;
    return `${LAYER_JP[l]} から音を削除 (step ${i})`;
  });
  w("EUCLID", 2, () => {
    // キックは E(k,16) で作り直さない。4つ打ちの地盤を壊さないため。
    const pool = ["perc", "hat", "ohat", "snare"].filter((x) => E.active[x]);
    const l = pool.length ? pick(pool) : pick(drumLayers.filter((x) => x !== "kick" && x !== "clap"));
    if (!l) return null;
    const k = pick([3, 5, 7, 9, 11]);
    E.pat[l] = rotate(euclid(k, 16), (Math.random() * 4) | 0);
    E.process = "EUCLID ROTATION";
    return `${LAYER_JP[l]} を E(${k},16) に再構成`;
  });
  w("MEDIANT", 1.4, () => {
    // シューベルト的三度転位 — 反復の地盤を保ったまま色だけ移す。
    // 実際に適用できた量だけを移調に使う。クランプで根音が動かなかった場合に
    // パターンだけが移調されると、以後ずっと調がずれたままになる。
    const want = pick([3, -3, 4, -4]);
    const before = E.root;
    E.root = clamp(E.root + want, 28, 44);
    const applied = E.root - before;
    if (applied === 0) return null;
    E.pat.stab = E.pat.stab.map((v) => (v && v.n !== undefined ? { ...v, n: v.n + applied } : v));
    E.process = "MEDIANT SHIFT";
    return `三度転位 ${applied > 0 ? "+" : ""}${applied} semitone`;
  });
  w("TIMBRE", 2.5, () => {
    E.timbre.acidCut = clamp(E.timbre.acidCut * (chance(0.5) ? 1.35 : 0.72), 120, 3200);
    E.timbre.acidRes = clamp(E.timbre.acidRes + (chance(0.5) ? 1.5 : -1.5), 2, 7.5);
    E.process = "FILTER MORPH";
    return `ACID cutoff → ${Math.round(E.timbre.acidCut)}Hz / Q${E.timbre.acidRes.toFixed(0)}`;
  });
  w("DURATION", 1.6, () => {
    E.timbre.gate = clamp(E.timbre.gate * (chance(0.5) ? 1.4 : 0.7), 0.12, 1.6);
    E.process = "DURATION MORPH";
    return `ゲート長 ×${E.timbre.gate.toFixed(2)}`;
  });
  w("OCTAVE", 1.2, () => {
    const l = E.active.acid ? "acid" : null;   // BASSは音域窓に畳まれるので跳躍は無効
    if (!l) return null;
    const i = E.pat[l].map((v, j) => (v ? j : -1)).filter((j) => j >= 0);
    if (!i.length) return null;
    const k = pick(i);
    E.pat[l] = E.pat[l].slice();
    const cur = E.pat[l][k];
    E.pat[l][k] =
      cur.n !== undefined
        ? { ...cur, n: cur.n + (chance(0.6) ? 12 : -12) }
        : { ...cur, oct: cur.oct ? 0 : 1 };
    return `${LAYER_JP[l]} step ${k} をオクターブ跳躍`;
  });

  // ハコ全体に掛かる偏差。全体が固まっているほど大きな予測誤差になるので、
  // 強度が乗っているときだけ、しかも稀に起こす。
  w("FLANGE", E.energy > 0.5 && E.allowFx.autoFlange ? 1.0 : 0, () => {
    if (E.fx.flangeLeft > 0) return null;
    E.fx.flangeTotal = 8 + ((Math.random() * 9) | 0);
    E.fx.flangeLeft = E.fx.flangeTotal;
    E.process = "FLANGE SWEEP";
    return `フランジャを${E.fx.flangeTotal}小節かけて通過させる`;
  });
  w("STUTTER", E.energy > 0.6 && E.allowFx.autoStutter ? 0.7 : 0, () => {
    if (E.fx.stutterLeft > 0) return null;
    E.fx.stutterLeft = chance(0.6) ? 1 : 2;
    E.fx.stutterSlices = pick([2, 3, 4]);
    E.freeze = 4;   // 大きな誤差の後は反復へ戻して予測を建て直す
    E.process = "STUTTER";
    return `1/${16 * E.fx.stutterSlices} でスタッター ${E.fx.stutterLeft}小節`;
  });

  const total = ops.reduce((s, o) => s + o.weight, 0);
  let r = Math.random() * total;
  for (const o of ops) {
    r -= o.weight;
    if (r <= 0) {
      const text = o.fn();
      enforceAnchors(E);   // 何が起きても地盤は元へ戻す
      return text ? { op: o.name, text } : null;
    }
  }
  return null;
}

/* ============================================================
   COMPONENT
   ============================================================ */
export default function DeviationEngine() {
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [recording, setRecording] = useState(false);
  const [mode, setMode] = useState("TECHNO");
  const [bpm, setBpm] = useState(MODEP.TECHNO.bpm);
  const [appetite, setAppetite] = useState(1.0); // 変化欲求の倍率
  const [duckAmt, setDuckAmt] = useState(MODEP.TECHNO.duck);
  const [vol, setVol] = useState(0.85);
  const [ui, setUi] = useState(null);
  const [status, setStatus] = useState(null);
  const [levels, setLevels] = useState({ ...DEFAULT_LEVELS });
  const [mutes, setMutes] = useState({});
  const [showMixer, setShowMixer] = useState(false);
  const [spread, setSpread] = useState(14);   // キック基音からベース音域上端までの半音数
  const [b303, setB303] = useState({ cut: 190, res: 5.5, env: 0.55, dec: 0.22, acc: 0.6, glide: 0.055 });
  const [show303, setShow303] = useState(false);
  const [venue, setVenue] = useState({ room: 0.14, drive: 0.35, flange: 0, autoFlange: true, autoStutter: true });
  const [showVenue, setShowVenue] = useState(false);
  const [vizBig, setVizBig] = useState(false);
  const [vizMode, setVizMode] = useState("clock");
  const [overlay, setOverlay] = useState("min");
  const [grid, setGrid] = useState("off");
  const [vidRec, setVidRec] = useState(false);
  const [vidSecs, setVidSecs] = useState(0);
  const [vidFmt, setVidFmt] = useState("");
  const [lite, setLite] = useState(
    typeof navigator !== "undefined" && /iPhone|iPad|iPod|Android/i.test(navigator.userAgent || "")
  );
  const canRecord = typeof MediaRecorder !== "undefined";

  const A = useRef(null);
  const E = useRef(null);
  const loopId = useRef(null);
  const canvasRef = useRef(null);
  const vizCanvasRef = useRef(null);
  const vizRef = useRef({
    flash: {}, pulses: [], kick: 0, snap: 0,
    step: 0, stepStart: 0, stepDur: 0.11,
    section: "", sectionT: 0, lastT: 0,
    spawn: [], particles: [], hue: 200, spin: 1, bufA: null, bufB: null,
    chrome: null, ripT: -9, notes: [],
  });
  const vizModeRef = useRef("clock");
  const reducedMotionRef = useRef(false);
  const overlayRef = useRef("min");
  const gridRef = useRef("off");
  const vidRef = useRef({ rec: null, chunks: [], dest: null, timer: null, mime: "" });
  const rafRef = useRef(null);
  const ctxSwapped = useRef(false);
  const loopErr = useRef(false);
  const diagRef = useRef({});
  const timerRef = useRef(null);
  const nextTimeRef = useRef(0);
  const anchorRef = useRef(0);
  const stepIdxRef = useRef(0);
  const curBpmRef = useRef(MODEP.TECHNO.bpm);
  const firedRef = useRef(0);
  const skipRef = useRef(0);
  const bpmRef = useRef(MODEP.TECHNO.bpm);
  const duckRef = useRef(MODEP.TECHNO.duck);
  const appetiteRef = useRef(1.0);
  const liteRef = useRef(false);
  const spreadRef = useRef(14);
  const b303Ref = useRef({ cut: 190, res: 5.5, env: 0.55, dec: 0.22, acc: 0.6, glide: 0.055 });
  const venueRef = useRef({ room: 0.14, drive: 0.35, flange: 0, autoFlange: true, autoStutter: true });

  useEffect(() => { spreadRef.current = spread; }, [spread]);
  useEffect(() => { venueRef.current = venue; }, [venue]);
  useEffect(() => { overlayRef.current = overlay; }, [overlay]);
  useEffect(() => { gridRef.current = grid; }, [grid]);
  useEffect(() => {
    vizModeRef.current = vizMode;
    const V = vizRef.current;
    V.bufA = null; V.bufB = null; V.particles = []; V.chrome = null;
  }, [vizMode]);
  useEffect(() => {
    try {
      reducedMotionRef.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (_) {}
  }, []);
  useEffect(() => {
    b303Ref.current = b303;
    if (A.current && A.current.bass) A.current.bass.portamento = b303.glide;
  }, [b303]);

  useEffect(() => { liteRef.current = lite; }, [lite]);

  useEffect(() => { bpmRef.current = bpm; }, [bpm]);
  useEffect(() => { duckRef.current = duckAmt; }, [duckAmt]);
  useEffect(() => { appetiteRef.current = appetite; }, [appetite]);

  /* ---------- engine init ---------- */
  const initEngine = useCallback((m) => {
    const P = MODEP[m];
    const e = {
      mode: m,
      bar: 0,
      step: 0,
      root: P.root,
      scaleName: P.scale,
      energy: 0.25,
      section: nextSection(m, null),
      pat: genPatterns(m, P.root, P.scale),
      prevPat: {},
      phase: {},
      age: {},
      active: {},
      familiarity: 0,
      surprise: 0,
      interest: 0,
      freeze: 0,
      process: "—",
      log: [],
      trace: [],
      chordDeg: 0,
      padSt: { inv: 0, tension: 9, open: true, sus: false, age: 0 },
      padNotes: [],
      drift: { f: 0, c: 0, d: 0 },
      fx: { flangeLeft: 0, flangeTotal: 0, stutterLeft: 0, stutterSlices: 2 },
      allowFx: { autoFlange: true, autoStutter: true },
      timbre: { acidCut: 500, acidRes: 8, gate: 0.6 },
      lastDevBar: 0,
      devCount: 0,
      hitFlash: {},
      vizQ: [],
    };
    LAYERS.forEach((l) => (e.age[l] = 0));
    e.prevPat = JSON.parse(JSON.stringify(e.pat));
    return e;
  }, []);

  /* ---------- per-bar: listener model + controller ---------- */
  function barTick(e, time) {
    // 1. section / energy
    e.section.left -= 1;
    if (e.section.left <= 0) {
      e.section = nextSection(e.mode, e.section);
      e.chordDeg = pick([0, 0, 3, 5, 4]);
      e.vizQ.push({ t: time, l: "__section", v: e.section.type });
    }
    const k = e.section.type === "build" ? 0.14 : 0.045;
    e.energy += (e.section.target - e.energy) * k;
    if (e.section.type === "build") {
      const prog = 1 - e.section.left / e.section.len;
      e.energy = clamp(0.3 + prog * 0.65, 0, 1);
    }

    // 2. active layers from energy gates
    const gates = GATES[e.mode];
    const prevActive = { ...e.active };
    LAYERS.forEach((l) => (e.active[l] = e.energy >= gates[l]));
    LAYERS.forEach((l) => {
      if (e.active[l] !== prevActive[l]) e.age[l] = 0;
    });

    // 3. familiarity — 反復が予測モデルを固める
    const act = LAYERS.filter((l) => e.active[l]);
    const avgAge = act.length ? act.reduce((s, l) => s + e.age[l], 0) / act.length : 0;
    e.familiarity = 1 - Math.exp(-avgAge / 5);

    // 4. controller — 慣れが飽和したら偏差を注入する
    let devs = 0;
    if (e.freeze > 0) {
      e.freeze--;
    } else {
      const P = MODEP[e.mode];
      let p = clamp((e.familiarity - 0.4) * 1.7, 0, 1) * P.change * appetiteRef.current;
      if (e.section.type === "build") p *= 1.6;
      if (e.section.type === "drop" || e.section.type === "peak") p *= 0.5;
      if (chance(p)) devs = 1;
      if (e.familiarity > 0.92 && chance(0.55 * appetiteRef.current)) devs += 1;
    }
    for (let i = 0; i < devs; i++) {
      const r = applyDeviation(e);
      if (r) {
        e.devCount++;
        e.vizQ.push({ t: time, l: "__dev", v: r.op, x: r.text });
        e.log.unshift({ bar: e.bar, op: r.op, text: r.text });
        if (e.log.length > 40) e.log.pop();
        e.lastDevBar = e.bar;
      }
    }

    // 5. PAD — 地盤の層なので偏差は最小・最遅。色の連続移動と声部の最小移動のみ。
    e.padSt.age++;
    const padPressure = e.familiarity * (e.padSt.age / 14);
    if (e.active.pad && e.freeze === 0 && padPressure > 1 && chance(0.45 * appetiteRef.current)) {
      const txt = padDeviate(e.padSt);
      e.padSt.age = 0;
      e.devCount++;
      e.vizQ.push({ t: time, l: "__dev", v: "PAD VOICE", x: txt });
      e.log.unshift({ bar: e.bar, op: "PAD VOICE", text: txt });
      if (e.log.length > 40) e.log.pop();
    }

    // ハコの音響の更新
    if (A.current) {
      const R = A.current;
      const V = venueRef.current;
      e.allowFx = { autoFlange: V.autoFlange, autoStutter: V.autoStutter };

      // 部屋鳴りは薄い区間ほど効かせる。密度が上がると邪魔になる。
      R.roomSend.gain.setTargetAtTime(V.room * (1.25 - e.energy * 0.55), time, 1.5);

      // サチュレーションは強度に連動。PAを押している感触を作る。
      const drive = 0.35 + V.drive * (0.55 + e.energy * 0.75) * 3.2;
      // 基準振幅0.7が歪み後も0.7で出るように補償する。
      // これで駆動を上げても音量は動かず、倍音の量だけが増える。
      const makeup = 0.7 / Math.tanh(0.7 * drive);
      R.satIn.gain.setTargetAtTime(drive, time, 0.8);
      R.satOut.gain.setTargetAtTime(makeup, time, 0.8);

      // フランジャは山形の包絡で通過させる
      let auto = 0;
      if (e.fx.flangeLeft > 0) {
        const prog = 1 - e.fx.flangeLeft / Math.max(1, e.fx.flangeTotal);
        auto = Math.sin(prog * Math.PI) * 0.75;
        R.flangeLFO.frequency.rampTo(0.06 + prog * 0.22, 2);
        e.fx.flangeLeft--;
      }
      R.flangeMix.gain.setTargetAtTime(clamp(V.flange + auto, 0, 0.85), time, 0.6);

      // スタッターの残り小節
      if (e.fx.stutterLeft > 0) {
        e.fx.stutterLeft--;
        if (e.fx.stutterLeft === 0) {
          // 終了時の復帰。barTickは直前のstep15で積んだスタッター予約の後に走るため、
          // step15の「閉じる」勾配(最大~1step後)が復帰を上書きして0.015で固着し、
          // 以後stutterLeft=0でstepTickが触れず永久に無音化していた。
          // 未来の閉じ予約をすべて取り消してから、確実に開き直す。
          const sg = R.stutterGain.gain;
          sg.cancelScheduledValues(time + 0.0005);
          sg.setValueAtTime(1, time + 0.02);
        }
      }
    }

    // 連続ドリフト — 一歩が小さく、方向が持続するランダムウォーク
    const dr = e.drift;
    dr.f = clamp(dr.f * 0.94 + (Math.random() - 0.5) * 0.22, -1, 1);
    dr.c = clamp(dr.c * 0.96 + (Math.random() - 0.5) * 0.16, -1, 1);
    dr.d = clamp(dr.d * 0.95 + (Math.random() - 0.5) * 0.2, -1, 1);

    if (A.current) {
      const R = A.current;
      // ACIDのフィルタはエンベロープの基準周波数として渡す。
      // filter.frequencyを直接書くとフィルタエンベロープと取り合いになる。
      try {
        R.acid.filterEnvelope.baseFrequency = e.timbre.acidCut;
        R.acid.filter.Q.value = e.timbre.acidRes;
      } catch (_) {}
      // 明るさは強度に従い、そこへ気づかれない幅の揺れを重ねる
      const cut = clamp(620 + e.energy * 900 + dr.f * 380, 480, 2400);
      R.padFilter.frequency.setTargetAtTime(cut, time, 3.2);
      R.padChorus.depth = clamp(0.42 + dr.c * 0.22, 0.22, 0.78);
      try { R.padChorus.frequency.rampTo(clamp(0.42 + dr.c * 0.3, 0.22, 0.95), 6); } catch (_) {}
      try { R.pad.set({ detune: dr.d * 13 }); } catch (_) {}
      updatePadVoices(e, time);
    }

    // 6. surprise = 実際に起きた予測誤差
    let s = 0,
      n = 0;
    act.forEach((l) => {
      s += hamming(e.pat[l], e.prevPat[l]);
      n++;
    });
    const rawSurprise = n ? s / n : 0;
    e.surprise = e.surprise * 0.55 + rawSurprise * 0.45;

    // 7. Wundt — 驚きが最適帯にあるとき興味が最大化する
    const opt = MODEP[e.mode].opt;
    e.interest = Math.exp(-Math.pow(e.surprise - opt, 2) / (2 * 0.075 * 0.075)) * (0.35 + 0.65 * e.familiarity);

    // 過剰な誤差の後は反復に戻して予測を建て直す
    if (rawSurprise > opt * 2.6) e.freeze = 3 + ((Math.random() * 4) | 0);

    // 8. ages / memory update
    LAYERS.forEach((l) => {
      if (hamming(e.pat[l], e.prevPat[l]) > 0) e.age[l] = 0;
      else e.age[l] += 1;
    });
    e.prevPat = JSON.parse(JSON.stringify(e.pat));

    e.trace.push({ f: e.familiarity, s: e.surprise, i: e.interest, e: e.energy, d: devs > 0 });
    if (e.trace.length > 160) e.trace.shift();

    // 9. riser for builds
    if (A.current) {
      const R = A.current;
      if (e.section.type === "build") {
        const prog = 1 - e.section.left / e.section.len;
        R.riserFilt.frequency.setTargetAtTime(300 + prog * 5000, time, 0.3);
        R.riserAmp.gain.setTargetAtTime(1, time, 0.45);   // 音量はミキサーのFXチャンネルが持つ
      } else {
        R.riserAmp.gain.setTargetAtTime(0, time, 0.3);
      }
    }
    e.bar++;
  }

  /* ---------- PAD の声部更新 ----------
     共通音は鳴らしたまま保持し、変わった音だけを差し替える。
     全音を鳴らし直すと変化が「事件」になってしまうので、そうしない。 */
  function updatePadVoices(e, time) {
    const R = A.current;
    if (!R) return;
    if (!e.active.pad) {
      if (e.padNotes && e.padNotes.length) {
        R.pad.triggerRelease(e.padNotes.map(midiToNote), time);
        e.padNotes = [];
      }
      return;
    }
    const want = padNotes(e.root, e.scaleName, e.chordDeg, e.padSt);
    const cur = e.padNotes || [];
    const rel = cur.filter((n) => !want.includes(n));
    const add = want.filter((n) => !cur.includes(n));
    if (rel.length) R.pad.triggerRelease(rel.map(midiToNote), time);
    if (add.length) R.pad.triggerAttack(add.map(midiToNote), time + 0.02, 0.4);
    e.padNotes = want;
  }

  /* ---------- per-step scheduling ---------- */
  function stepTick(e, time) {
    const R = A.current;
    if (!R) return;
    const i = e.step;
    // 発音の実時刻を添えてイベントを積む。描画側はオーディオ時計で取り出すので、
    // 先読みスケジューリングでも画面が音に先行しない。
    const emit = (l, v) => e.vizQ.push({ t: time, l, v: v === undefined ? 0.7 : v });
    e.vizQ.push({ t: time, l: "__step", v: i, d: 60 / curBpmRef.current / 4 });
    if (e.vizQ.length > 512) e.vizQ.splice(0, e.vizQ.length - 512);
    const gate = e.timbre.gate;
    const g = (mult) => Math.max(0.02, 0.055 * gate * mult);

    const at = (layer, idx) => {
      const ph = e.phase[layer] || 0;
      return e.pat[layer][(idx + ph) % 16];
    };

    // KICK
    if (e.active.kick && at("kick", i)) {
      R.kick.triggerAttackRelease(midiToNote(e.root - 9), 0.26, time, 1);
      R.kickClick.triggerAttackRelease(0.012, time, 0.5);
      // sidechain duck
      const d = R.duck.gain;
      d.cancelScheduledValues(time);
      d.setValueAtTime(duckRef.current, time);
      d.linearRampToValueAtTime(1, time + MODEP[e.mode].duckT);
      emit("kick", 1);
      e.hitFlash.kick = 1;
    }
    if (e.active.sub && at("sub", i)) {
      // サブは現在の和音の根音に追随する。ベースの小節頭ロックと同じ音名なので、
      // キック・サブ・ベースが同じ土台を共有し、和音が動けば一緒に動く。
      const subRoot = e.root + degOf(e.scaleName, e.chordDeg);
      R.sub.triggerAttackRelease(midiToNote(foldToWindow(subRoot, e.root - 9, e.root + 3)), "8n", time, 0.6);
      emit("sub", 0.6);
      e.hitFlash.sub = 1;
    }
    if (e.active.hat && at("hat", i)) {
      R.hat.triggerAttackRelease(0.03, time, i % 4 === 0 ? 0.6 : 0.32);
      emit("hat", i % 4 === 0 ? 0.7 : 0.4);
      e.hitFlash.hat = 1;
    }
    if (e.active.ohat && at("ohat", i)) {
      R.ohat.triggerAttackRelease(0.22, time, 0.3);
      emit("ohat", 0.5);
      e.hitFlash.ohat = 1;
    }
    if (e.active.snare) {
      // ビルド区間では刻みが細かくなっていく（EDMの常套句）
      const prog = e.section.type === "build" ? 1 - e.section.left / e.section.len : 0;
      let hit = at("snare", i);
      let vel = hit === 1 && (i === 4 || i === 12) ? 0.85 : 0.4;
      if (prog > 0.35) {
        const div = prog > 0.82 ? 1 : prog > 0.62 ? 2 : 4;
        hit = i % div === 0 ? 1 : 0;
        vel = 0.35 + prog * 0.55;
      }
      if (hit) {
        R.snareNoise.triggerAttackRelease(0.13, time, vel);
        R.snareBody.triggerAttackRelease(midiToNote(e.root + 12), 0.09, time, vel * 0.8);
        emit("snare", vel);
        e.hitFlash.snare = 1;
      }
    }
    if (e.active.clap && at("clap", i)) {
      R.clap.triggerAttackRelease(0.16, time, 0.7);
      R.clap.triggerAttackRelease(0.06, time + 0.012, 0.4);
      emit("clap", 0.8);
      e.hitFlash.clap = 1;
    }
    if (e.active.perc && at("perc", i)) {
      if (R.percMetal) R.perc.frequency.setValueAtTime(240 + ((i * 37) % 260), time);
      else if (R.percFilt) R.percFilt.frequency.setValueAtTime(900 + ((i * 137) % 1700), time);
      R.perc.triggerAttackRelease(0.09, time, 0.28);
      emit("perc", 0.45);
      e.hitFlash.perc = 1;
    }
    if (e.active.bass) {
      const v = at("bass", i);
      if (v) {
        // キックの基音を基準にした音域窓へ畳み込む。
        // 両者が離れすぎると低域がひとつの塊として聴こえなくなる。
        const kickN = e.root - 9;
        const bd = safeDeg(e.scaleName, e.chordDeg, v.d);
        const raw = e.root + 12 + degOf(e.scaleName, e.chordDeg + bd);
        const n = foldToWindow(raw, kickN + 12, kickN + 12 + spreadRef.current);
        const P = b303Ref.current;
        const stepDur = 60 / curBpmRef.current / 4;

        // 303のアクセント: 音量だけでなく、フィルタの振り幅と速さも変える
        const base = P.cut;
        const envAmt = P.env * (v.a ? 1 + P.acc * 1.6 : 1);
        const peak = clamp(base * (1 + envAmt * 7), base + 20, 7000);
        const dec = Math.max(0.04, P.dec * (v.a ? 0.62 : 1));
        const f = R.bassFilt.frequency;
        f.cancelScheduledValues(time);
        f.setValueAtTime(base, time);
        f.linearRampToValueAtTime(peak, time + 0.006);
        f.exponentialRampToValueAtTime(base, time + 0.006 + dec);
        R.bassFilt.Q.setValueAtTime(clamp(P.res * (v.a ? 1.3 : 1), 0.5, 14), time);

        // グライド: 次の音がスライド指定なら現在の音を重ねて残す。
        // portamentoのプロパティ切り替えは先読み時刻とずれるので使わない。
        const nxt = at("bass", (i + 1) % 16);
        const dur = nxt && nxt.s ? stepDur * 1.06 : Math.min(stepDur * 0.88, dec + 0.06);
        R.bass.triggerAttackRelease(midiToNote(n), dur, time, v.a ? 1.0 : 0.7);
        emit("bass", v.a ? 1 : 0.6);
        e.hitFlash.bass = 1;
      }
    }
    if (e.active.acid) {
      const v = at("acid", i);
      if (v) {
        // 音高は現在の和音度から毎回導出する。和音が動けばACIDも追随する。
        const dd = safeDeg(e.scaleName, e.chordDeg, v.d);
        const n = e.root + 24 + degOf(e.scaleName, e.chordDeg + dd) + 12 * (v.oct || 0);
        const stepDur = 60 / curBpmRef.current / 4;
        // スライドはportamentoの切り替えではなく、音を重ねて残すことで作る。
        // プロパティ代入は先読み時刻とずれるため使わない。
        const nxt = at("acid", (i + 1) % 16);
        const dur = nxt && nxt.s ? stepDur * 1.06 : Math.min(g(1.0), stepDur * 0.9);
        R.acid.triggerAttackRelease(midiToNote(n), dur, time, v.a ? 1.0 : 0.62);
        emit("acid", v.a ? 1 : 0.6);
        e.hitFlash.acid = 1;
      }
    }
    if (e.active.stab) {
      const v = at("stab", i);
      if (v) {
        const notes =
          e.mode === "MINIMAL" ? [midiToNote(v.n)] : chordOf(e.root, e.scaleName, e.chordDeg).map((m) => midiToNote(m + 12));
        R.stab.triggerAttackRelease(notes, g(1.6), time, v.a ? 0.55 : 0.32);
        emit("stab", v.a ? 0.8 : 0.5);
        e.hitFlash.stab = 1;
      }
    }
    if (e.active.piano && R.piano && R.piano.loaded) {
      const v = at("piano", i);
      if (v) {
        // 音高は現在の和音度から毎回導出する。和音が動けばピアノも追随する。
        const dd = safeDeg(e.scaleName, e.chordDeg, v.d);
        const n = e.root + 24 + degOf(e.scaleName, e.chordDeg + dd) + 12 * (v.oct || 0);
        const stepDur = 60 / curBpmRef.current / 4;
        R.piano.triggerAttackRelease(midiToNote(n), stepDur * 2.4, time, v.a ? 0.72 : 0.5);
        emit("piano", v.a ? 0.85 : 0.55);
        e.hitFlash.piano = 1;
      }
    }

    // スタッター。ステップをさらに分割してマスターを断続させる。
    if (e.fx.stutterLeft > 0 && R.stutterGain) {
      const slices = e.fx.stutterSlices || 2;
      const sd = 60 / curBpmRef.current / 4;
      const sl = sd / slices;
      const sg = R.stutterGain.gain;
      sg.cancelScheduledValues(time);
      for (let k = 0; k < slices; k++) {
        const t0 = time + k * sl;
        const tOff = t0 + sl * 0.58;
        // 断続の縁を2ms前後で丸め、クリックノイズを避ける
        sg.setValueAtTime(0.015, t0);
        sg.linearRampToValueAtTime(1, t0 + 0.002);
        sg.setValueAtTime(1, tOff);
        sg.linearRampToValueAtTime(0.015, tOff + 0.003);
      }
    }

    // sends follow energy
    R.verbSend.gain.setTargetAtTime(0.08 + (1 - e.energy) * 0.14, time, 0.4);
    R.delaySend.gain.setTargetAtTime(0.05 + e.energy * 0.13, time, 0.4);
    R.hatFilt.frequency.setTargetAtTime(6000 + e.energy * 4500, time, 0.5);
    if (R.ohatFilt) R.ohatFilt.frequency.setTargetAtTime(5600 + e.energy * 4000, time, 0.5);

    e.step = (e.step + 1) % 16;
    if (e.step === 0) {
      try {
        barTick(e, time + 0.001);
      } catch (err) {
        e.bar++;
        if (!loopErr.current) {
          loopErr.current = true;
          setStatus(`小節処理でエラー: ${err && err.message ? err.message : String(err)}`);
        }
      }
    }
  }

  /* ---------- transport ---------- */
  /* ---------- transport (自前の先読みスケジューラ) ----------
     Tone.TransportのスケジューラはiOS上で発火しないことがあるため、
     AudioContextのcurrentTimeを直接見て、25ms間隔で150ms先まで
     イベントを積む方式にしている。クロックはWebAudioの時計そのもの。 */
  /* ---------- PADの停止 ----------
     先読みで未来に予約済みのtriggerAttackがあるため、現在時刻でreleaseすると
     リリースがアタックより先に走り、そのボイスが鳴り続けてしまう。
     先読み窓の外でリリースし、さらに念のため後追いでもう一度掛ける。 */
  const releasePad = () => {
    const R = A.current;
    if (!R) return;
    const now = Tone.getContext().currentTime;
    // 停止時だけリリースを短くする（演奏中の4.5秒は声部移動の滑らかさに必要）
    try { R.pad.set({ envelope: { release: 0.6 } }); } catch (_) {}
    try { R.pad.releaseAll(now + 0.45); } catch (_) { try { R.pad.releaseAll(); } catch (__) {} }
    setTimeout(() => {
      try { R.pad.releaseAll(); } catch (_) {}
      try { R.pad.set({ envelope: { release: 4.5 } }); } catch (_) {}
    }, 900);
    if (E.current) E.current.padNotes = [];
  };

  /* ---------- transport (アンカー基準の先読みスケジューラ) ----------
     発音時刻は常に anchor + k * dur で算出する。加算を累積しないので
     浮動小数の誤差が乗らず、追い越し時もグリッド位相を保ったまま
     必要数だけステップを読み飛ばして復帰する。 */
  const runScheduler = () => {
    if (timerRef.current !== null) return;
    const LOOKAHEAD = 0.32;
    anchorRef.current = Tone.getContext().currentTime + 0.15;
    stepIdxRef.current = 0;
    curBpmRef.current = bpmRef.current;
    timerRef.current = setInterval(() => {
      const e = E.current;
      if (!e) return;
      try {
        const now = Tone.getContext().currentTime;

        // テンポ変更時は現在のステップ位置を新しいアンカーにして位相を引き継ぐ
        if (bpmRef.current !== curBpmRef.current) {
          anchorRef.current = anchorRef.current + stepIdxRef.current * (60 / curBpmRef.current / 4);
          stepIdxRef.current = 0;
          curBpmRef.current = bpmRef.current;
        }

        const dur = 60 / curBpmRef.current / 4;
        const timeAt = (k) => anchorRef.current + k * dur;

        // 追い越されたら、グリッド上の次の格子点まで読み飛ばす（位相は保存される）
        if (timeAt(stepIdxRef.current) < now + 0.005) {
          const need = Math.ceil((now + 0.05 - anchorRef.current) / dur);
          if (need > stepIdxRef.current) {
            stepIdxRef.current = need;
            skipRef.current++;
          }
        }

        let guard = 0;
        while (timeAt(stepIdxRef.current) < now + LOOKAHEAD && guard++ < 32) {
          stepTick(e, timeAt(stepIdxRef.current));
          stepIdxRef.current++;
          firedRef.current++;
        }
        nextTimeRef.current = timeAt(stepIdxRef.current);
      } catch (err) {
        if (!loopErr.current) {
          loopErr.current = true;
          setStatus(`再生ループでエラー: ${err && err.message ? err.message : String(err)}`);
        }
      }
    }, 40);
  };

  const start = async () => {
    setStatus("起動中…");
    try {
      const state = await unlockAudio();
      if (state !== "running") {
        setStatus(`音声コンテキストが起動しません（state=${state}）。もう一度STARTを押してください。`);
        return;
      }
      if (!A.current) {
        A.current = buildAudio(lite);
        applyAllChannels(levels, mutes);
        A.current.bass.portamento = b303.glide;
      }
      if (!E.current) E.current = initEngine(mode);
      A.current.bus.gain.value = vol;
      try {
        if (A.current.riser.state !== "started") A.current.riser.start();
      } catch (_) {}
      loopErr.current = false;
      runScheduler();
      setPlaying(true);
      setReady(true);
      setStatus(null);

      setTimeout(() => {
        if (E.current && firedRef.current === 0 && !loopErr.current) {
          setStatus(`スケジューラが1回も発火していません（ctx=${Tone.getContext().state}）。`);
        }
      }, 1200);
    } catch (err) {
      setStatus(`起動に失敗: ${err && err.message ? err.message : String(err)}`);
      setPlaying(false);
    }
  };

  const stop = () => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    releasePad();
    if (A.current) A.current.riserAmp.gain.setTargetAtTime(0, Tone.getContext().currentTime, 0.1);
    vizRef.current.flash = {};
    vizRef.current.pulses = [];
    setPlaying(false);
  };

  const switchMode = (m) => {
    setMode(m);
    setBpm(MODEP[m].bpm);
    setDuckAmt(MODEP[m].duck);
    const wasPlaying = playing;
    E.current = initEngine(m);
    releasePad();
    if (wasPlaying) E.current.step = 0;
  };

  const toggleRecord = async () => {
    if (!A.current || !A.current.recorder) {
      setStatus("この端末では録音できません（iOS SafariはMediaRecorder非対応）。");
      return;
    }
    if (!recording) {
      A.current.recorder.start();
      setRecording(true);
    } else {
      const blob = await A.current.recorder.stop();
      setRecording(false);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `deviation-infinity-${mode.toLowerCase()}-${Date.now()}.webm`;
      a.click();
      URL.revokeObjectURL(url);
    }
  };

  const fireStutter = () => {
    if (!E.current) return;
    E.current.fx.stutterLeft = 1;
    E.current.fx.stutterSlices = pick([2, 3, 4]);
    E.current.process = "STUTTER";
  };

  /* ---------- 映像＋音声の録画 ----------
     canvasのフレームストリームと、マスターから分岐したMediaStreamを合成する。
     MP4が使えればMP4、駄目ならWebMへ落とす。 */
  const VIDEO_TYPES = [
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4;codecs=avc1,mp4a.40.2",
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];

  const startVideo = () => {
    const cv = vizCanvasRef.current;
    if (!cv || !A.current) { setStatus("先にSTARTで音を鳴らしてください。"); return; }
    if (typeof MediaRecorder === "undefined" || !cv.captureStream) {
      setStatus("この環境では録画できません（MediaRecorder非対応）。");
      return;
    }
    const mime = VIDEO_TYPES.find((t) => {
      try { return MediaRecorder.isTypeSupported(t); } catch (_) { return false; }
    });
    if (!mime) { setStatus("対応する録画形式が見つかりません。"); return; }

    try {
      const vs = cv.captureStream(30);
      const raw = Tone.getContext().rawContext || Tone.getContext();
      const dest = raw.createMediaStreamDestination();
      A.current.master.connect(dest);
      const mixed = new MediaStream([...vs.getVideoTracks(), ...dest.stream.getAudioTracks()]);
      const rec = new MediaRecorder(mixed, {
        mimeType: mime,
        videoBitsPerSecond: liteRef.current ? 4_000_000 : 9_000_000,
        audioBitsPerSecond: 192_000,
      });
      const chunks = [];
      rec.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
      rec.onstop = () => {
        try { A.current && A.current.master.disconnect(dest); } catch (_) {}
        const ext = mime.indexOf("mp4") >= 0 ? "mp4" : "webm";
        const blob = new Blob(chunks, { type: mime.split(";")[0] });
        const url = URL.createObjectURL(blob);
        const a2 = document.createElement("a");
        a2.href = url;
        a2.download = `deviation-infinity-${vizModeRef.current}-${Date.now()}.${ext}`;
        a2.click();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
      };
      rec.start(1000);
      vidRef.current = { rec, chunks, dest, mime, timer: null };
      setVidFmt(mime.indexOf("mp4") >= 0 ? "MP4" : "WebM");
      setVidSecs(0);
      vidRef.current.timer = setInterval(() => setVidSecs((v) => v + 1), 1000);
      setVidRec(true);
      setStatus(null);
    } catch (err) {
      setStatus(`録画を開始できません: ${err && err.message ? err.message : String(err)}`);
    }
  };

  const stopVideo = () => {
    const S = vidRef.current;
    if (S.timer) clearInterval(S.timer);
    try { S.rec && S.rec.state !== "inactive" && S.rec.stop(); } catch (_) {}
    setVidRec(false);
  };

  const toggleLite = () => {
    const next = !lite;
    setLite(next);
    const wasPlaying = playing;
    if (wasPlaying) stop();
    if (A.current) {
      try {
        A.current.nodes.forEach((n) => { try { n.dispose(); } catch (_) {} });
      } catch (_) {}
      A.current = null;
    }
    if (wasPlaying)
      setTimeout(() => {
        A.current = buildAudio(next);
        applyAllChannels(levels, mutes);
        runScheduler();
        setPlaying(true);
      }, 60);
  };

  useEffect(() => {
    if (A.current) A.current.bus.gain.rampTo(vol, 0.2);
  }, [vol]);

  const applyChannel = (l, value, muted) => {
    const R = A.current;
    if (!R || !R.chan || !R.chan[l]) return;
    R.chan[l].gain.rampTo(muted ? 0 : value, 0.04);
  };
  const applyAllChannels = (lv, mu) => MIX.forEach((l) => applyChannel(l, lv[l], !!mu[l]));

  const setLevel = (l, v) => {
    setLevels((prev) => {
      const next = { ...prev, [l]: v };
      applyChannel(l, v, !!mutes[l]);
      return next;
    });
  };
  const toggleMute = (l) => {
    setMutes((prev) => {
      const next = { ...prev, [l]: !prev[l] };
      applyChannel(l, levels[l], next[l]);
      return next;
    });
  };
  const resetLevels = () => {
    setLevels({ ...DEFAULT_LEVELS });
    setMutes({});
    applyAllChannels(DEFAULT_LEVELS, {});
  };

  /* ---------- UI refresh loop ---------- */
  useEffect(() => {
    let last = 0;
    let frame = 0;
    const tick = (t) => {
      rafRef.current = requestAnimationFrame(tick);
      // ビジュアライザは毎フレーム描く。React更新とは切り離す。
      frame++;
      if (!liteRef.current || frame % 2 === 0) {
        try {
          const m = vizModeRef.current;
          if (m === "acid") drawAcid(E.current);
          else if (m === "chrome") drawChrome(E.current);
          else drawViz(E.current);
        } catch (_) {}
      }
      const interval = liteRef.current ? 110 : 55;
      if (t - last < interval) return;
      last = t;
      try {
        const c = Tone.getContext();
        diagRef.current = {
          ver: Tone.version || "?",
          ctx: c.state,
          sr: Math.round(c.sampleRate),
          now: c.currentTime,
          tState: timerRef.current !== null ? "started" : "stopped",
          tSec: firedRef.current,
          lag: nextTimeRef.current - c.currentTime,
          skips: skipRef.current,
          lvl: A.current && A.current.meter ? A.current.meter.getValue() : null,
        };
      } catch (err) {
        diagRef.current = { ver: "?", ctx: "err", err: String(err && err.message) };
      }
      const e = E.current;
      if (!e) {
        setUi((p) => (p ? { ...p, diag: diagRef.current } : p));
        return;
      }
      // 表示はオーディオ時刻の状態を使う。スケジュール時刻だと先行してしまう。
      const V = vizRef.current;
      const flash = {};
      Object.keys(V.flash).forEach((k) => (flash[k] = 1));
      e.hitFlash = {};
      setUi({
        bar: e.bar,
        step: V.step,
        energy: e.energy,
        familiarity: e.familiarity,
        surprise: e.surprise,
        interest: e.interest,
        section: e.section,
        process: e.process,
        padLabel: padLabel(e.padSt),
        padActive: !!e.active.pad,
        root: e.root,
        scaleName: e.scaleName,
        devCount: e.devCount,
        freeze: e.freeze,
        active: { ...e.active },
        age: { ...e.age },
        pat: e.pat,
        phase: { ...e.phase },
        log: e.log.slice(0, 7),
        flash,
        diag: diagRef.current,
      });
      if (frame % 4 === 0) drawScope(e);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  /* ---------- テキストオーバーレイ（3モード共通）----------
     呼び出し側は CSS ピクセル座標系に変換済みであること。 */
  function drawOverlay(g, e, w, h) {
    const mode = overlayRef.current;
    if (mode === "off" || !e) return;
    const V = vizRef.current;
    const now = A.current ? Tone.getContext().currentTime : 0;
    const full = mode === "full";

    g.textAlign = "left";
    g.font = `600 12px ${SANS}`;
    const sAge = now - (V.sectionT || 0);
    const slide = sAge < 0.9 ? (1 - sAge / 0.9) * 22 : 0;
    g.fillStyle = `rgba(237,230,214,${sAge < 0.9 ? 0.45 + (1 - sAge / 0.9) * 0.5 : 0.6})`;
    g.fillText(String(V.section || e.section.type).toUpperCase(), 14 + slide, 22);

    g.font = `500 10px ${MONO}`;
    g.fillStyle = "rgba(138,129,114,0.85)";
    g.fillText(`BAR ${String(e.bar).padStart(4, "0")}   ${e.section.left}/${e.section.len}`, 14, 38);

    g.textAlign = "right";
    g.fillStyle = "rgba(240,162,2,0.85)";
    g.fillText(`慣れ ${(e.familiarity * 100).toFixed(0).padStart(3)}`, w - 14, 22);
    g.fillStyle = "rgba(76,141,255,0.9)";
    g.fillText(`誤差 ${(e.surprise * 100).toFixed(1).padStart(5)}`, w - 14, 38);

    if (full) {
      g.fillStyle = "rgba(138,129,114,0.8)";
      g.fillText(`${midiToNote(e.root)} ${e.scaleName}`, w - 14, 54);
      g.fillText(`${e.process}`, w - 14, 70);
      g.fillText(`偏差 ${e.devCount}`, w - 14, 86);
      g.fillStyle = e.freeze > 0 ? "rgba(240,162,2,0.8)" : "rgba(92,85,74,0.8)";
      g.fillText(e.freeze > 0 ? `反復固定 ${e.freeze}` : "偏差許容", w - 14, 102);
    }

    // 偏差の実況 — 発火時刻から時間とともに退く
    g.textAlign = "left";
    const list = V.notes.filter((n) => now - n.t0 < (full ? 14 : 5));
    let y = h - 16;
    for (let i = 0; i < list.length && (full || i < 2); i++) {
      const n = list[i];
      const age = now - n.t0;
      const life = full ? 14 : 5;
      const fade = clamp(1 - age / life, 0, 1);
      const pop = age < 0.35 ? 1 - age / 0.35 : 0;
      const alpha = 0.25 + fade * 0.6;
      g.font = `500 ${10 + pop * 1.5}px ${MONO}`;
      g.fillStyle = `rgba(76,141,255,${alpha})`;
      const head = `BAR ${String(n.bar).padStart(4, "0")} / ${n.op}`;
      g.fillText(head, 14 + pop * 5, y);
      if (n.text) {
        g.font = `400 ${11 + pop * 1.5}px ${SANS}`;
        g.fillStyle = `rgba(237,230,214,${alpha * 0.92})`;
        g.fillText(n.text, 14 + pop * 5, y + 14);
      }
      y -= n.text ? 32 : 18;
      if (y < 60) break;
    }
  }

  /* ---------- ステップ行列 / 16分グリッド オーバーレイ ----------
     どのビジュアライザ・モードの上にも重ねられる。
     "grid"  : 16分の縦グリッドと再生ヘッドだけを薄く重ねる。
     "matrix": レイヤー×16ステップのシーケンサ行列を下部に重ねる。 */
  function drawStepGrid(g, e, w, h, now) {
    const mode = gridRef.current;
    if (mode === "off" || !e || !e.pat) return;
    const V = vizRef.current;
    const cols = 16;
    const frac = V.stepDur > 0 ? clamp((now - V.stepStart) / V.stepDur, 0, 1) : 0;
    const head = ((V.step || 0) + frac) % cols;

    g.save();
    g.textAlign = "left";
    g.textBaseline = "alphabetic";

    if (mode === "grid") {
      // 16分の縦線。拍(4分割ごと)は明るく。再生ヘッドは寒色の縦帯。
      const mx = 12;
      const x0 = mx, gw = w - mx * 2;
      const cw = gw / cols;
      for (let i = 0; i <= cols; i++) {
        const x = x0 + i * cw;
        const beat = i % 4 === 0;
        g.strokeStyle = beat ? "rgba(237,230,214,0.22)" : "rgba(138,129,114,0.12)";
        g.lineWidth = beat ? 1.4 : 0.8;
        g.beginPath();
        g.moveTo(x, 8);
        g.lineTo(x, h - 8);
        g.stroke();
      }
      const hx = x0 + head * cw;
      g.fillStyle = "rgba(76,141,255,0.10)";
      g.fillRect(hx, 8, cw, h - 16);
      g.fillStyle = "rgba(76,141,255,0.85)";
      g.fillRect(hx - 1, 8, 2, h - 16);
      g.restore();
      return;
    }

    // --- matrix ---
    const marginX = 12, labelW = 56;
    const gx0 = marginX + labelW;
    const gw = w - gx0 - marginX;
    const rows = LAYERS.length;
    const rowH = clamp((h * 0.5) / rows, 11, 20);
    const gh = rowH * rows;
    const headH = 15;
    const gy0 = h - gh - 14;
    const cw = gw / cols;

    // 背板
    g.fillStyle = "rgba(14,12,10,0.62)";
    g.fillRect(marginX - 6, gy0 - headH - 6, w - (marginX - 6) * 2, gh + headH + 12);
    g.strokeStyle = "rgba(48,41,33,0.9)";
    g.lineWidth = 1;
    g.strokeRect(marginX - 6, gy0 - headH - 6, w - (marginX - 6) * 2, gh + headH + 12);

    g.font = `600 10px ${MONO}`;
    g.fillStyle = "rgba(138,129,114,0.9)";
    g.fillText("STEP MATRIX / 16分", gx0, gy0 - 5);

    // 拍の縦帯
    for (let i = 0; i < cols; i++) {
      if (i % 4 === 0) {
        g.fillStyle = "rgba(237,230,214,0.04)";
        g.fillRect(gx0 + i * cw, gy0, cw, gh);
      }
    }

    const at = (l, idx) => {
      const p = e.pat[l];
      if (!p) return null;
      const ph = e.phase[l] || 0;
      return p[(idx + ph) % cols];
    };

    for (let r = 0; r < rows; r++) {
      const l = LAYERS[r];
      const y = gy0 + r * rowH;
      const on = !!e.active[l];
      const fl = V.flash[l];
      const flAge = fl ? now - fl.t0 : 99;

      // レイヤー名（KICK / SUB / …）。非アクティブでも読めるようにする。
      g.font = `${on ? 700 : 500} 10px ${MONO}`;
      g.fillStyle = on ? "rgba(240,162,2,0.95)" : "rgba(150,140,124,0.8)";
      g.textAlign = "right";
      g.fillText(LAYER_JP[l] || l, gx0 - 7, y + rowH / 2 + 3.5);
      g.textAlign = "left";

      for (let i = 0; i < cols; i++) {
        const cx = gx0 + i * cw;
        const hit = at(l, i);
        if (hit) {
          const acc = typeof hit === "object" ? hit.a : i % 4 === 0;
          let alpha = on ? (acc ? 0.9 : 0.55) : 0.16;
          // 直近に発音したレイヤーの現在ステップは瞬かせる
          if (on && i === (V.step || 0) && flAge < 0.14) alpha = 1;
          g.fillStyle = on
            ? `rgba(240,162,2,${alpha})`
            : `rgba(138,129,114,${alpha})`;
          g.fillRect(cx + 1, y + 1, cw - 2, rowH - 2);
        } else {
          g.strokeStyle = "rgba(48,41,33,0.5)";
          g.lineWidth = 0.5;
          g.strokeRect(cx + 1, y + 1, cw - 2, rowH - 2);
        }
      }
    }

    // 再生ヘッド
    const hx = gx0 + head * cw;
    g.fillStyle = "rgba(76,141,255,0.12)";
    g.fillRect(gx0 + Math.floor(head) * cw, gy0, cw, gh);
    g.fillStyle = "rgba(76,141,255,0.9)";
    g.fillRect(hx - 1, gy0 - 3, 2, gh + 6);
    g.restore();
  }

  /* ============================================================
     VISUALIZER — 極座標の小節時計
     1小節を円周に、レイヤーを同心円に割り当てる。反復すれば静止した
     模様になり、偏差が入るとその環だけが破れる。
     ============================================================ */
  function drainViz(e, now) {
    const V = vizRef.current;
    const q = e.vizQ;
    let n = 0;
    while (q.length && q[0].t <= now) {
      const ev = q.shift();
      n++;
      if (ev.l === "__step") {
        V.step = ev.v;
        V.stepStart = ev.t;
        V.stepDur = ev.d;
      } else if (ev.l === "__dev") {
        V.pulses.push({ t0: now, op: ev.v });
        if (V.pulses.length > 8) V.pulses.shift();
        // 偏差のたびに色相が飛び、回転が反転する
        V.hue = (V.hue + 47 + Math.random() * 60) % 360;
        if (Math.random() < 0.4) V.spin *= -1;
        V.notes.unshift({ t0: now, op: ev.v, text: ev.x || "", bar: e.bar });
        if (V.notes.length > 7) V.notes.pop();
      } else if (ev.l === "__section") {
        V.section = ev.v;
        V.sectionT = now;
      } else {
        V.flash[ev.l] = { v: ev.v, t0: now };
        V.spawn.push({ l: ev.l, v: ev.v });
        if (V.spawn.length > 40) V.spawn.shift();
        if (ev.l === "kick") V.kick = 1;
        if (ev.l === "snare" || ev.l === "clap") V.snap = 1;
      }
      if (n > 200) break;
    }
  }

  function drawViz(e) {
    const cv = vizCanvasRef.current;
    if (!cv) return;
    const V = vizRef.current;
    const R = A.current;
    const now = R ? Tone.getContext().currentTime : 0;
    if (e && R) drainViz(e, now);

    const dpr = Math.min(window.devicePixelRatio || 1, liteRef.current ? 1.5 : 2);
    const w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    if (cv.width !== (w * dpr) | 0 || cv.height !== (h * dpr) | 0) {
      cv.width = w * dpr; cv.height = h * dpr;
    }
    const g = cv.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);

    const energy = e ? e.energy : 0;
    const fam = e ? e.familiarity : 0;
    const sur = e ? e.surprise : 0;

    // 背景 — 慣れは温色、誤差は寒色。地の色が状態を語る。
    g.fillStyle = C.bg;
    g.fillRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2;
    const rMax = Math.min(w, h) * 0.46;
    const bg = g.createRadialGradient(cx, cy, 0, cx, cy, rMax * 1.9);
    bg.addColorStop(0, `rgba(240,162,2,${0.05 + fam * 0.09 + V.kick * 0.06})`);
    bg.addColorStop(0.55, `rgba(76,141,255,${0.02 + Math.min(sur * 1.6, 0.5) * 0.11})`);
    bg.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);

    // 減衰
    const dt = Math.max(0, Math.min(0.05, now - (V.lastT || now)));
    V.lastT = now;
    V.kick = Math.max(0, V.kick - dt * 4.2);
    V.snap = Math.max(0, V.snap - dt * 6);

    const rIn = rMax * 0.30;
    const rOut = rMax * 0.94;
    const N = LAYERS.length;
    const band = (rOut - rIn) / N;

    // 連続的な小節位相
    const frac = V.stepDur > 0 ? clamp((now - V.stepStart) / V.stepDur, 0, 1) : 0;
    const phase = ((V.step + frac) % 16) / 16;
    const ang = (k) => -Math.PI / 2 + k * Math.PI * 2;

    // 16分のスポーク
    for (let i = 0; i < 16; i++) {
      const a = ang(i / 16);
      const strong = i % 4 === 0;
      g.strokeStyle = strong ? "rgba(237,230,214,0.16)" : "rgba(237,230,214,0.055)";
      g.lineWidth = strong ? 1.2 : 1;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * rIn, cy + Math.sin(a) * rIn);
      g.lineTo(cx + Math.cos(a) * rOut, cy + Math.sin(a) * rOut);
      g.stroke();
    }

    // レイヤーの環と、パターンの刻み
    LAYERS.forEach((l, li) => {
      const r = rIn + band * (li + 0.5);
      const on = e && e.active[l];
      const age = e ? e.age[l] || 0 : 0;
      // 反復が続くほど環は明るく安定する
      const stab = 1 - Math.exp(-age / 6);
      g.strokeStyle = on
        ? `rgba(240,162,2,${0.07 + stab * 0.20})`
        : "rgba(237,230,214,0.035)";
      g.lineWidth = 1;
      g.beginPath();
      g.arc(cx, cy, r, 0, Math.PI * 2);
      g.stroke();

      if (!on || !e || !e.pat[l]) return;
      const ph = e.phase[l] || 0;
      const row = e.pat[l];
      for (let i = 0; i < 16; i++) {
        const v = row[(i + ph) % 16];
        if (!v) continue;
        const acc = v && typeof v === "object" && v.a;
        const a0 = ang(i / 16) - 0.055;
        const a1 = ang(i / 16) + 0.055;
        g.strokeStyle = acc ? "rgba(240,162,2,0.55)" : "rgba(240,162,2,0.26)";
        g.lineWidth = band * (acc ? 0.5 : 0.34);
        g.beginPath();
        g.arc(cx, cy, r, a0, a1);
        g.stroke();
      }

      // 発音の閃光
      const f = V.flash[l];
      if (f) {
        const age2 = now - f.t0;
        if (age2 < 0.5) {
          const k = Math.pow(1 - age2 / 0.5, 2.2);
          const a = ang(phase);
          g.strokeStyle = `rgba(255,236,190,${k * (0.35 + f.v * 0.6)})`;
          g.lineWidth = band * (0.45 + f.v * 0.55);
          g.beginPath();
          g.arc(cx, cy, r, a - 0.10 - f.v * 0.05, a + 0.10 + f.v * 0.05);
          g.stroke();
        } else delete V.flash[l];
      }
    });

    // 再生ヘッド
    const pa = ang(phase);
    const grad = g.createLinearGradient(
      cx + Math.cos(pa) * rIn, cy + Math.sin(pa) * rIn,
      cx + Math.cos(pa) * rOut, cy + Math.sin(pa) * rOut
    );
    grad.addColorStop(0, "rgba(76,141,255,0.85)");
    grad.addColorStop(1, "rgba(76,141,255,0.06)");
    g.strokeStyle = grad;
    g.lineWidth = 1.6;
    g.beginPath();
    g.moveTo(cx + Math.cos(pa) * rIn, cy + Math.sin(pa) * rIn);
    g.lineTo(cx + Math.cos(pa) * rOut, cy + Math.sin(pa) * rOut);
    g.stroke();

    // 偏差のパルス — 環が破れて外へ抜ける
    V.pulses = V.pulses.filter((p2) => now - p2.t0 < 1.5);
    V.pulses.forEach((p2) => {
      const k = (now - p2.t0) / 1.5;
      const r = rIn + (rMax * 1.5 - rIn) * Math.pow(k, 0.55);
      g.strokeStyle = `rgba(76,141,255,${(1 - k) * 0.5})`;
      g.lineWidth = 2.4 * (1 - k) + 0.4;
      g.beginPath();
      g.arc(cx, cy, r, 0, Math.PI * 2);
      g.stroke();
    });

    // スペクトル — 環の外側に放射する
    if (R && R.fft && !liteRef.current) {
      let arr;
      try { arr = R.fft.getValue(); } catch (_) { arr = null; }
      if (arr && arr.length) {
        const n = arr.length;
        g.strokeStyle = "rgba(237,230,214,0.30)";
        g.lineWidth = 1.4;
        for (let i = 0; i < n; i++) {
          const mag = clamp((arr[i] + 96) / 96, 0, 1);
          if (mag < 0.02) continue;
          const a = ang(i / n);
          const r0 = rOut + 5;
          const r1 = r0 + mag * (rMax * 0.20);
          g.beginPath();
          g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
          g.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
          g.stroke();
        }
      }
    }

    // 中心 — キックの衝撃とスネアの弾け
    const coreR = rIn * (0.42 + V.kick * 0.5 + energy * 0.16);
    const cg = g.createRadialGradient(cx, cy, 0, cx, cy, Math.max(1, coreR));
    cg.addColorStop(0, `rgba(255,240,205,${0.30 + V.kick * 0.6})`);
    cg.addColorStop(0.6, `rgba(240,162,2,${0.14 + V.kick * 0.3})`);
    cg.addColorStop(1, "rgba(240,162,2,0)");
    g.fillStyle = cg;
    g.beginPath();
    g.arc(cx, cy, Math.max(1, coreR), 0, Math.PI * 2);
    g.fill();

    if (V.snap > 0.01) {
      g.strokeStyle = `rgba(200,220,255,${V.snap * 0.5})`;
      g.lineWidth = 1 + V.snap * 2;
      g.beginPath();
      g.arc(cx, cy, rIn * (0.6 + (1 - V.snap) * 1.1), 0, Math.PI * 2);
      g.stroke();
    }

    drawOverlay(g, e, w, h);
    drawStepGrid(g, e, w, h, now);
  }

  /* ============================================================
     ACID MODE — フレームフィードバックによる溶解
     前フレームを微小に回転・拡大して描き戻すと、映像が自分自身を
     食べ続けてトンネル状に溶ける。そこへ極座標の変形図形と
     発音由来のパーティクルを加算合成で重ねる。
     ============================================================ */
  function drawAcid(e) {
    const cv = vizCanvasRef.current;
    if (!cv) return;
    const V = vizRef.current;
    const R = A.current;
    const now = R ? Tone.getContext().currentTime : performance.now() / 1000;
    if (e && R) drainViz(e, now);

    const lite = liteRef.current;
    const calm = reducedMotionRef.current;
    const dpr = Math.min(window.devicePixelRatio || 1, lite ? 1 : 1.5);
    const w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    const W = Math.max(1, (w * dpr) | 0), H = Math.max(1, (h * dpr) | 0);
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    if (!V.bufA || V.bufA.width !== W || V.bufA.height !== H) {
      V.bufA = document.createElement("canvas"); V.bufA.width = W; V.bufA.height = H;
      V.bufB = document.createElement("canvas"); V.bufB.width = W; V.bufB.height = H;
      V.particles = [];
    }
    const a = V.bufA.getContext("2d");
    const dt = Math.max(0, Math.min(0.05, now - (V.lastT || now)));
    V.lastT = now;
    V.kick = Math.max(0, V.kick - dt * 4.2);
    V.snap = Math.max(0, V.snap - dt * 6);

    const energy = e ? e.energy : 0;
    const fam = e ? e.familiarity : 0;
    const sur = e ? e.surprise : 0;
    const flanging = e && e.fx && e.fx.flangeLeft > 0;
    const cx = W / 2, cy = H / 2;

    // ---- フィードバック ----
    a.setTransform(1, 0, 0, 1, 0, 0);
    a.globalCompositeOperation = "source-over";
    a.clearRect(0, 0, W, H);
    const zoom = calm ? 1.002 : 1.005 + V.kick * 0.028 + energy * 0.004;
    const rot = (calm ? 0.0008 : 0.0016 + Math.min(sur, 0.4) * 0.045 + (flanging ? 0.007 : 0)) * V.spin;
    a.save();
    a.translate(cx, cy);
    a.rotate(rot);
    a.scale(zoom, zoom);
    a.translate(-cx, -cy);
    a.globalAlpha = 0.94;
    a.drawImage(V.bufB, 0, 0);
    a.restore();
    a.globalAlpha = 1;
    a.fillStyle = "rgba(6,3,12,0.075)";
    a.fillRect(0, 0, W, H);

    // ---- 変形する図形 ----
    a.globalCompositeOperation = "lighter";
    V.hue = (V.hue + dt * (7 + energy * 42)) % 360;
    const baseR = Math.min(W, H) * (0.15 + energy * 0.11);
    const m1 = 3 + ((e ? e.chordDeg : 0) % 4);
    const m2 = 5 + Math.floor(fam * 5);
    const amp = 0.14 + Math.min(sur, 0.4) * 1.5 + V.kick * 0.3;
    const STEPS = lite ? 84 : 168;
    for (let layer = 0; layer < 2; layer++) {
      const sc = layer === 0 ? 1 : 1.75 + energy * 0.4;
      const spd = layer === 0 ? 1 : -0.55;
      for (let c = 0; c < 3; c++) {
        // 色収差 — 3枚をずらして加算し、輪郭に虹を出す
        a.strokeStyle = `hsla(${(V.hue + c * 27 + layer * 90) % 360},96%,${56 + c * 5}%,${layer ? 0.28 : 0.5})`;
        a.lineWidth = (1 + V.kick * 2.6) * dpr;
        a.beginPath();
        for (let i = 0; i <= STEPS; i++) {
          const th = (i / STEPS) * Math.PI * 2;
          const r =
            baseR * sc *
            (1 +
              amp * Math.sin(m1 * th + now * 0.9 * spd + c * 0.35) +
              amp * 0.72 * Math.sin(m2 * th - now * 1.4 * spd) +
              amp * 0.45 * Math.sin(2 * th + now * 0.42) +
              V.kick * 0.32 * Math.sin(8 * th + now * 3.1));
          const k = 1 + c * 0.022;
          const x = cx + Math.cos(th) * r * k;
          const y = cy + Math.sin(th) * r * k;
          i ? a.lineTo(x, y) : a.moveTo(x, y);
        }
        a.closePath();
        a.stroke();
      }
    }

    // ---- 発音から飛ぶ光 ----
    while (V.spawn.length) {
      const sp = V.spawn.shift();
      const li = Math.max(0, LAYERS.indexOf(sp.l));
      const n = lite ? 3 : 9;
      for (let k = 0; k < n; k++) {
        const th = Math.random() * Math.PI * 2;
        const v0 = (50 + Math.random() * 240) * (0.5 + sp.v) * dpr;
        V.particles.push({
          x: cx, y: cy,
          vx: Math.cos(th) * v0, vy: Math.sin(th) * v0,
          life: 1, hue: (V.hue + li * 31) % 360,
          sz: (0.9 + Math.random() * 2.3) * dpr,
        });
      }
    }
    const cap = lite ? 240 : 850;
    if (V.particles.length > cap) V.particles.splice(0, V.particles.length - cap);
    for (let i = V.particles.length - 1; i >= 0; i--) {
      const p2 = V.particles[i];
      // カール状の流れ場で軌道を曲げる
      const cur = Math.sin(p2.y * 0.006 + now * 1.1) * 1.1 + Math.cos(p2.x * 0.005 - now * 0.8) * 1.1;
      p2.vx += Math.cos(cur) * 95 * dt * dpr;
      p2.vy += Math.sin(cur) * 95 * dt * dpr;
      p2.vx *= 0.985; p2.vy *= 0.985;
      p2.x += p2.vx * dt; p2.y += p2.vy * dt;
      p2.life -= dt * 0.52;
      if (p2.life <= 0) { V.particles.splice(i, 1); continue; }
      a.fillStyle = `hsla(${p2.hue},100%,66%,${p2.life * 0.75})`;
      a.beginPath();
      a.arc(p2.x, p2.y, p2.sz * (0.35 + p2.life), 0, Math.PI * 2);
      a.fill();
    }

    // ---- 偏差の衝撃波 ----
    V.pulses = V.pulses.filter((p2) => now - p2.t0 < 1.6);
    V.pulses.forEach((p2) => {
      const k = (now - p2.t0) / 1.6;
      const r = Math.min(W, H) * 0.08 + Math.min(W, H) * 0.75 * Math.pow(k, 0.5);
      a.strokeStyle = `hsla(${(V.hue + 180) % 360},100%,70%,${(1 - k) * 0.55})`;
      a.lineWidth = (3.5 * (1 - k) + 0.4) * dpr;
      a.beginPath();
      a.arc(cx, cy, r, 0, Math.PI * 2);
      a.stroke();
    });

    // ---- 中心の核 ----
    const coreR = Math.min(W, H) * (0.02 + V.kick * 0.07);
    const cg = a.createRadialGradient(cx, cy, 0, cx, cy, Math.max(1, coreR * 3));
    cg.addColorStop(0, `hsla(${V.hue},100%,${70 + V.kick * 25}%,${0.5 + V.kick * 0.45})`);
    cg.addColorStop(1, "hsla(0,0%,0%,0)");
    a.fillStyle = cg;
    a.beginPath();
    a.arc(cx, cy, Math.max(1, coreR * 3), 0, Math.PI * 2);
    a.fill();

    // ---- 提示してバッファを入れ替える ----
    const g = cv.getContext("2d");
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);
    g.drawImage(V.bufA, 0, 0);
    const tmp = V.bufA; V.bufA = V.bufB; V.bufB = tmp;

    g.globalCompositeOperation = "source-over";
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawOverlay(g, e, w, h);
    drawStepGrid(g, e, w, h, now);
  }

  /* ============================================================
     CHROME MODE — 曲面の鏡面反射
     メタボールの高さ場を作り、有限差分で法線を求め、視線の反射ベクトルで
     手続き的な環境を引く。実際の鏡面反射と同じ計算を、低解像度バッファで行う。
     ============================================================ */
  const COS_LUT = (() => {
    const n = 1024, t = new Float32Array(n);
    for (let i = 0; i < n; i++) t[i] = Math.cos((i / n) * Math.PI * 2);
    return t;
  })();
  const fcos = (x) => COS_LUT[((x * 162.9746617 ) | 0) & 1023];   // 1024/(2π)

  function drawChrome(e) {
    const cv = vizCanvasRef.current;
    if (!cv) return;
    const V = vizRef.current;
    const R = A.current;
    const now = R ? Tone.getContext().currentTime : performance.now() / 1000;
    if (e && R) drainViz(e, now);

    const lite = liteRef.current;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    const dpr = Math.min(window.devicePixelRatio || 1, lite ? 1 : 1.5);
    const W = Math.max(1, (w * dpr) | 0), H = Math.max(1, (h * dpr) | 0);
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }

    const BW = lite ? 128 : 200;
    const BH = Math.max(8, Math.round((BW * h) / w));
    let B = V.chrome;
    if (!B || B.w !== BW || B.h !== BH) {
      const cnv = document.createElement("canvas");
      cnv.width = BW; cnv.height = BH;
      const ctx = cnv.getContext("2d");
      B = V.chrome = {
        w: BW, h: BH, cnv, ctx,
        img: ctx.createImageData(BW, BH),
        hf: new Float32Array(BW * BH),
        blobs: null,
      };
    }
    if (!B.blobs) {
      B.blobs = Array.from({ length: 7 }, (_, i) => ({
        ax: 0.35 + Math.random() * 0.5, ay: 0.3 + Math.random() * 0.45,
        fx: 0.11 + Math.random() * 0.29, fy: 0.13 + Math.random() * 0.31,
        px: Math.random() * 6.28, py: Math.random() * 6.28,
        r0: 0.09 + Math.random() * 0.10, r: 0.12,
        layer: LAYERS[(i * 3) % LAYERS.length],
      }));
    }

    const dt = Math.max(0, Math.min(0.05, now - (V.lastT || now)));
    V.lastT = now;
    V.kick = Math.max(0, V.kick - dt * 3.4);
    V.snap = Math.max(0, V.snap - dt * 5);

    const energy = e ? e.energy : 0;
    const fam = e ? e.familiarity : 0;
    const sur = e ? e.surprise : 0;
    const flanging = e && e.fx && e.fx.flangeLeft > 0;

    // 発音でその層に割り当てた球が膨らむ
    while (V.spawn.length) {
      const sp = V.spawn.shift();
      B.blobs.forEach((bl) => {
        if (bl.layer === sp.l) bl.r += 0.05 * sp.v;
      });
      if (sp.l === "kick") V.ripT = now;
    }

    const aspect = BW / BH;
    const hf = B.hf;
    // 慣れが高いほど動きが緩み、誤差が乗ると撹拌される
    const agit = 0.5 + Math.min(sur, 0.35) * 2.2;
    const swell = 1 + V.kick * 0.35 + energy * 0.12;

    B.blobs.forEach((bl) => {
      bl.r += (bl.r0 * swell - bl.r) * Math.min(1, dt * 7);
      bl.x = fcos(now * bl.fx * agit + bl.px) * bl.ax * aspect;
      bl.y = fcos(now * bl.fy * agit + bl.py + 1.57) * bl.ay;
    });

    // --- 高さ場 ---
    const rip = now - (V.ripT || -9);
    const ripA = rip < 1.1 ? (1 - rip / 1.1) * 0.5 : 0;
    for (let y = 0; y < BH; y++) {
      const fy = (y / BH - 0.5) * 2;
      const row = y * BW;
      for (let x = 0; x < BW; x++) {
        const fx = (x / BW - 0.5) * 2 * aspect;
        let sum = 0;
        for (let i = 0; i < B.blobs.length; i++) {
          const bl = B.blobs[i];
          const dx = fx - bl.x, dy = fy - bl.y;
          sum += bl.r / (dx * dx + dy * dy + bl.r * 0.42 + 0.012);
        }
        if (ripA > 0) {
          const d = Math.sqrt(fx * fx + fy * fy);
          sum += ripA * fcos(d * 13 - rip * 16) / (1 + d * 3.2);
        }
        hf[row + x] = sum;
      }
    }

    // --- 法線を求め、反射ベクトルで環境を引く ---
    const img = B.img, data = img.data;
    const envPh = (V.hue || 0) * 0.0175 + now * (flanging ? 0.9 : 0.22);
    const envFreq = flanging ? 11 : 5.5;
    const tint = 0.28 + energy * 0.42;
    const Lx = 0.42, Ly = -0.55, Lz = 0.72;
    const NS = 2.6 + fam * 1.4;   // 法線の立ち上がり

    for (let y = 0; y < BH; y++) {
      const row = y * BW;
      const up = y > 0 ? row - BW : row;
      const dn = y < BH - 1 ? row + BW : row;
      for (let x = 0; x < BW; x++) {
        const i = row + x;
        const xl = x > 0 ? i - 1 : i;
        const xr = x < BW - 1 ? i + 1 : i;
        const hv = hf[i];

        let nx = -(hf[xr] - hf[xl]) * NS;
        let ny = -(hf[dn] - hf[up]) * NS;
        const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
        nx *= inv; ny *= inv;
        const nz = inv;

        // 視線(0,0,1)の反射
        const rx = 2 * nz * nx;
        const ry = 2 * nz * ny;
        const rz = 2 * nz * nz - 1;

        // 手続き的な環境: 水平の帯 + 縦の筋
        const band = fcos(rx * envFreq + envPh) * fcos(ry * (envFreq * 0.7) - envPh * 0.6);
        let lum = 0.30 + 0.34 * (ry * 0.5 + 0.5) + 0.30 * band;

        // 鏡面ハイライト
        let sp = rx * Lx + ry * Ly + rz * Lz;
        if (sp > 0) { const s2 = sp * sp, s4 = s2 * s2, s8 = s4 * s4; lum += s8 * s8 * 1.5; }

        // フレネルの縁光り
        const fr = 1 - nz;
        lum += fr * fr * fr * 0.85;

        // 虹色の色付け
        const k = envPh * 0.8 + rx * 2.1 + ry * 1.3;
        const cr = lum * (1 - tint + tint * (0.5 + 0.5 * fcos(k)));
        const cg = lum * (1 - tint + tint * (0.5 + 0.5 * fcos(k + 2.094)));
        const cb = lum * (1 - tint + tint * (0.5 + 0.5 * fcos(k + 4.189)));

        const al = hv > 0.34 ? (hv - 0.34) * 2.6 : 0;
        const a8 = al > 1 ? 255 : (al * 255) | 0;
        const o = i << 2;
        data[o] = cr > 1 ? 255 : cr < 0 ? 0 : (cr * 255) | 0;
        data[o + 1] = cg > 1 ? 255 : cg < 0 ? 0 : (cg * 255) | 0;
        data[o + 2] = cb > 1 ? 255 : cb < 0 ? 0 : (cb * 255) | 0;
        data[o + 3] = a8;
      }
    }
    B.ctx.putImageData(img, 0, 0);

    // --- 提示 ---
    const g = cv.getContext("2d");
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = C.bg;
    g.fillRect(0, 0, W, H);
    g.imageSmoothingEnabled = true;
    try { g.imageSmoothingQuality = "high"; } catch (_) {}
    g.drawImage(B.cnv, 0, 0, W, H);

    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawOverlay(g, e, w, h);
    drawStepGrid(g, e, w, h, now);
  }

  /* ---------- scope ---------- */
  function drawScope(e) {
    const cv = canvasRef.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth,
      h = cv.clientHeight;
    if (cv.width !== w * dpr || cv.height !== h * dpr) {
      cv.width = w * dpr;
      cv.height = h * dpr;
    }
    const g = cv.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    g.fillStyle = C.panel;
    g.fillRect(0, 0, w, h);

    // graticule
    g.strokeStyle = C.line;
    g.lineWidth = 1;
    for (let i = 1; i < 5; i++) {
      const y = (h / 5) * i;
      g.beginPath();
      g.moveTo(0, y + 0.5);
      g.lineTo(w, y + 0.5);
      g.stroke();
    }

    const opt = MODEP[e.mode].opt;
    // Wundt band — 予測誤差の最適帯
    const bandTop = h - (opt + 0.075) * 2.2 * h;
    const bandBot = h - Math.max(0, opt - 0.075) * 2.2 * h;
    g.fillStyle = "rgba(76,141,255,0.09)";
    g.fillRect(0, bandTop, w, bandBot - bandTop);
    g.strokeStyle = "rgba(76,141,255,0.28)";
    g.setLineDash([3, 4]);
    g.beginPath();
    g.moveTo(0, h - opt * 2.2 * h);
    g.lineTo(w, h - opt * 2.2 * h);
    g.stroke();
    g.setLineDash([]);

    const T = e.trace;
    if (T.length < 2) return;
    const dx = w / 159;

    // deviation event ticks
    T.forEach((p, i) => {
      if (p.d) {
        g.strokeStyle = "rgba(76,141,255,0.35)";
        g.beginPath();
        g.moveTo(i * dx, 0);
        g.lineTo(i * dx, h);
        g.stroke();
      }
    });

    const line = (key, color, scale, width) => {
      g.strokeStyle = color;
      g.lineWidth = width;
      g.beginPath();
      T.forEach((p, i) => {
        const y = h - clamp(p[key] * scale, 0, 1) * (h - 4) - 2;
        i ? g.lineTo(i * dx, y) : g.moveTo(i * dx, y);
      });
      g.stroke();
    };

    line("e", "rgba(237,230,214,0.22)", 1, 1);
    line("f", C.amber, 1, 1.8); // familiarity
    line("s", C.blue, 2.2, 1.8); // surprise
  }

  useEffect(() => () => {
    if (timerRef.current !== null) clearInterval(timerRef.current);
  }, []);

  /* ============================================================
     RENDER
     ============================================================ */
  const u = ui || {
    bar: 0, step: 0, energy: 0, familiarity: 0, surprise: 0, interest: 0,
    section: { type: "—", left: 0, len: 0 }, process: "—", root: 33, scaleName: "—",
    devCount: 0, freeze: 0, active: {}, age: {}, pat: null, phase: {}, log: [], flash: {}, diag: {},
    padLabel: "—", padActive: false,
  };

  const label = { fontSize: 9.5, letterSpacing: "0.22em", color: C.dim, fontFamily: SANS, textTransform: "uppercase" };
  const panel = { background: C.panel, border: `1px solid ${C.line}`, padding: 14 };

  const Meter = ({ name, jp, v, color, scale = 1 }) => (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 5 }}>
        <span style={label}>
          {name} <span style={{ color: C.dimmer, letterSpacing: "0.05em" }}>{jp}</span>
        </span>
        <span style={{ fontFamily: MONO, fontSize: 12, color, fontVariantNumeric: "tabular-nums" }}>
          {(v * 100).toFixed(1).padStart(5, "0")}
        </span>
      </div>
      <div style={{ height: 3, background: C.line }}>
        <div style={{ height: "100%", width: `${clamp(v * scale, 0, 1) * 100}%`, background: color, transition: "width 80ms linear" }} />
      </div>
    </div>
  );

  const modeDesc = {
    TECHNO: "ベルリン／デトロイト系。強い四つ打ちで予測を固め、303と打楽器の回転で誤差を出す。",
    MINIMAL: "Reich／Glass的プロセス音楽。位相ずらしと加算過程が、気づかせずに絵を変えていく。",
    EDM: "フェス系。ビルドとドロップという大枠の予測を立て、その充足自体を報酬にする。",
  };

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.ink, fontFamily: SANS, padding: "20px 16px 40px" }}>
      <style>{`
        input[type=range]{-webkit-appearance:none;appearance:none;height:2px;background:${C.line};outline:none;width:100%}
        input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:11px;height:11px;background:${C.amber};cursor:pointer;border-radius:0}
        input[type=range]::-moz-range-thumb{width:11px;height:11px;background:${C.amber};cursor:pointer;border:none;border-radius:0}
        input[type=range]:focus-visible{box-shadow:0 0 0 2px ${C.blue}}
        button:focus-visible{outline:2px solid ${C.blue};outline-offset:2px}
        @media (prefers-reduced-motion: reduce){*{transition:none !important}}
      `}</style>

      <div style={{ maxWidth: 1180, margin: "0 auto" }}>
        {/* ---------- header ---------- */}
        <header style={{ borderBottom: `1px solid ${C.line}`, paddingBottom: 16, marginBottom: 18 }}>
          <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "flex-end", gap: 14 }}>
            <div>
              <div style={{ ...label, marginBottom: 8, color: C.dimmer }}>無限機関シリーズ ／ NO.09</div>
              <h1
                style={{
                  margin: 0,
                  fontSize: "clamp(30px,7vw,54px)",
                  fontWeight: 800,
                  letterSpacing: "-0.02em",
                  lineHeight: 0.9,
                }}
              >
                DEVIATION<span style={{ color: C.blue }}>∞</span>
              </h1>
              <div style={{ marginTop: 8, fontSize: 12, color: C.dim, letterSpacing: "0.1em" }}>
                偏差機関 — 予測と、その微細な裏切りによる無限演奏装置
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button
                onClick={playing ? stop : start}
                style={{
                  background: playing ? C.amber : "transparent",
                  color: playing ? C.bg : C.amber,
                  border: `1px solid ${C.amber}`,
                  padding: "11px 26px",
                  fontFamily: MONO,
                  fontSize: 12,
                  letterSpacing: "0.2em",
                  cursor: "pointer",
                }}
              >
                {playing ? "STOP" : "START"}
              </button>
              {canRecord && (
                <button
                  onClick={toggleRecord}
                  disabled={!ready}
                  style={{
                    background: "transparent",
                    color: recording ? C.blue : ready ? C.dim : C.dimmer,
                    border: `1px solid ${recording ? C.blue : C.line}`,
                    padding: "11px 18px",
                    fontFamily: MONO,
                    fontSize: 12,
                    letterSpacing: "0.2em",
                    cursor: ready ? "pointer" : "default",
                  }}
                >
                  {recording ? "■ 保存" : "● 録音"}
                </button>
              )}
            </div>
          </div>
        </header>

        {status && (
          <div
            style={{
              border: `1px solid ${C.blue}`,
              background: "rgba(76,141,255,0.08)",
              padding: "10px 14px",
              marginBottom: 14,
              fontSize: 11.5,
              color: C.ink,
              lineHeight: 1.6,
            }}
          >
            {status}
          </div>
        )}
        {!ready && (
          <div style={{ fontSize: 11, color: C.dimmer, marginBottom: 14, lineHeight: 1.7 }}>
            iPhone / iPadで音が出ない場合は、本体側面の消音スイッチを解除し、音量を上げてからSTARTを押してください。
          </div>
        )}

        {/* ---------- mode ---------- */}
        <div style={{ display: "flex", gap: 1, marginBottom: 6, background: C.line, border: `1px solid ${C.line}` }}>
          {["TECHNO", "MINIMAL", "EDM"].map((m) => (
            <button
              key={m}
              onClick={() => switchMode(m)}
              style={{
                flex: 1,
                background: mode === m ? C.panel2 : C.panel,
                color: mode === m ? C.ink : C.dimmer,
                border: "none",
                borderTop: `2px solid ${mode === m ? C.amber : "transparent"}`,
                padding: "14px 8px",
                fontFamily: MONO,
                fontSize: 12,
                letterSpacing: "0.22em",
                cursor: "pointer",
              }}
            >
              {m}
            </button>
          ))}
        </div>
        <div style={{ fontSize: 11.5, color: C.dim, lineHeight: 1.7, marginBottom: 18 }}>{modeDesc[mode]}</div>

        {/* ---------- main grid ---------- */}
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 264px", gap: 14 }} className="dv-main">
          <div>
            {/* visualizer */}
            <div style={{ ...panel, padding: 0, marginBottom: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "11px 14px", borderBottom: `1px solid ${C.line}` }}>
                <span style={label}>
                  {vizMode === "acid" ? "溶解 / acid feedback" : vizMode === "chrome" ? "鏡面 / specular surface" : "小節時計 / polar bar clock"}
                </span>
                <div style={{ display: "flex", gap: 6 }}>
                {[["clock", "時計"], ["acid", "アシッド"], ["chrome", "鏡面"]].map(([k, lbl]) => (
                  <button
                    key={k}
                    onClick={() => setVizMode(k)}
                    style={{
                      background: vizMode === k ? C.panel2 : "transparent",
                      border: `1px solid ${vizMode === k ? C.amber : C.line}`,
                      color: vizMode === k ? C.amber : C.dimmer,
                      padding: "5px 10px", fontFamily: MONO, fontSize: 10,
                      letterSpacing: "0.1em", cursor: "pointer",
                    }}
                  >
                    {lbl}
                  </button>
                ))}
                <button
                  onClick={() =>
                    setOverlay((o) => (o === "off" ? "min" : o === "min" ? "full" : "off"))
                  }
                  title="テキストオーバーレイ"
                  style={{
                    background: overlay !== "off" ? C.panel2 : "transparent",
                    border: `1px solid ${overlay === "full" ? C.blue : overlay === "min" ? C.line : C.line}`,
                    color: overlay === "full" ? C.blue : overlay === "min" ? C.dim : C.dimmer,
                    padding: "5px 10px", fontFamily: MONO, fontSize: 10,
                    letterSpacing: "0.1em", cursor: "pointer",
                  }}
                >
                  {overlay === "off" ? "字幕OFF" : overlay === "min" ? "字幕" : "字幕+"}
                </button>
                <button
                  onClick={() =>
                    setGrid((gm) => (gm === "off" ? "matrix" : gm === "matrix" ? "grid" : "off"))
                  }
                  title="ステップ行列 / 16分グリッド"
                  style={{
                    background: grid !== "off" ? C.panel2 : "transparent",
                    border: `1px solid ${grid === "matrix" ? C.amber : grid === "grid" ? C.blue : C.line}`,
                    color: grid === "matrix" ? C.amber : grid === "grid" ? C.blue : C.dimmer,
                    padding: "5px 10px", fontFamily: MONO, fontSize: 10,
                    letterSpacing: "0.1em", cursor: "pointer",
                  }}
                >
                  {grid === "off" ? "格子OFF" : grid === "grid" ? "16分" : "行列"}
                </button>
                <button
                  onClick={vidRec ? stopVideo : startVideo}
                  style={{
                    background: vidRec ? C.blue : "transparent",
                    border: `1px solid ${vidRec ? C.blue : C.line}`,
                    color: vidRec ? C.bg : C.dim,
                    padding: "5px 10px", fontFamily: MONO, fontSize: 10,
                    letterSpacing: "0.1em", cursor: "pointer",
                  }}
                >
                  {vidRec ? `■ ${Math.floor(vidSecs / 60)}:${String(vidSecs % 60).padStart(2, "0")}` : "● 録画"}
                </button>
                <button
                  onClick={() => setVizBig((v) => !v)}
                  style={{
                    background: "transparent", border: `1px solid ${C.line}`, color: C.dim,
                    padding: "5px 12px", fontFamily: MONO, fontSize: 10, letterSpacing: "0.14em", cursor: "pointer",
                  }}
                >
                  {vizBig ? "縮小" : "拡大"}
                </button>
                </div>
              </div>
              <canvas
                ref={vizCanvasRef}
                style={{ width: "100%", height: vizBig ? "min(78vh, 720px)" : "min(52vh, 420px)", display: "block" }}
              />
              <div style={{ padding: "9px 14px", borderTop: `1px solid ${C.line}`, fontSize: 10.5, color: C.dimmer, lineHeight: 1.6 }}>
                {vizMode === "acid"
                  ? "前フレームを微小に回転・拡大して描き戻すことで、映像が自分自身を食べて溶けていく。回転量は予測誤差に、色相の跳躍は偏差の発火に連動する。"
                  : vizMode === "chrome"
                  ? "メタボールの高さ場から法線を求め、視線の反射ベクトルで手続き的な環境を引いている。各レイヤーに球が割り当てられ、発音のたびに膨らんで融合と分離を繰り返す。"
                  : null}
                {vidRec && (
                  <span style={{ color: C.blue }}>
                    {" "}録画中（{vidFmt}／映像はこのキャンバス、音声はマスターから分岐）。停止すると自動で保存される。
                  </span>
                )}
                {vizMode === "clock"
                  ? " 1小節が円周、同心円が各レイヤー。反復が続くほど環は明るく安定し、偏差は青い波として外へ抜ける。発音は再生時刻で描画しているので、先読みスケジューリングでも画面が音に先行しない。"
                  : null}
              </div>
            </div>

            {/* scope */}
            <div style={{ ...panel, padding: 0, marginBottom: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "11px 14px", borderBottom: `1px solid ${C.line}` }}>
                <span style={label}>予測誤差スコープ / prediction error</span>
                <span style={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: "0.1em" }}>
                  <span style={{ color: C.amber }}>━ 慣れ</span>{"  "}
                  <span style={{ color: C.blue }}>━ 誤差</span>{"  "}
                  <span style={{ color: C.dimmer }}>━ 強度</span>
                </span>
              </div>
              <canvas ref={canvasRef} style={{ width: "100%", height: 168, display: "block" }} />
              <div style={{ padding: "9px 14px", borderTop: `1px solid ${C.line}`, fontSize: 10.5, color: C.dimmer, lineHeight: 1.6 }}>
                青い帯が最適誤差域。慣れが飽和すると機関が偏差を注入し（縦線）、誤差が過剰なら反復に戻して予測を建て直す。
              </div>
            </div>

            {/* venue */}
            <div style={{ ...panel, padding: 0, marginBottom: 14 }}>
              <button
                onClick={() => setShowVenue((v) => !v)}
                style={{
                  width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center",
                  background: "transparent", border: "none",
                  borderBottom: showVenue ? `1px solid ${C.line}` : "none",
                  padding: "11px 14px", cursor: "pointer", color: C.dim,
                }}
              >
                <span style={label}>ハコの音響 / venue</span>
                <span style={{ fontFamily: MONO, fontSize: 11, color: C.dimmer }}>{showVenue ? "閉じる ▲" : "開く ▼"}</span>
              </button>
              {showVenue && (
                <div style={{ padding: "14px 14px 12px" }}>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))", gap: "0 22px" }}>
                    <Slider lab="Room" val={venue.room} min={0} max={0.45} step={0.01}
                      onChange={(v) => setVenue((p2) => ({ ...p2, room: v }))} fmt={(v) => v.toFixed(2)} />
                    <Slider lab="Saturation" val={venue.drive} min={0} max={1} step={0.01}
                      onChange={(v) => setVenue((p2) => ({ ...p2, drive: v }))} fmt={(v) => v.toFixed(2)} />
                    <Slider lab="Flange" val={venue.flange} min={0} max={0.8} step={0.01}
                      onChange={(v) => setVenue((p2) => ({ ...p2, flange: v }))} fmt={(v) => v.toFixed(2)} />
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 4 }}>
                    {[
                      ["autoFlange", "自動フランジ"],
                      ["autoStutter", "自動スタッター"],
                    ].map(([k, lbl]) => (
                      <button
                        key={k}
                        onClick={() => setVenue((p2) => ({ ...p2, [k]: !p2[k] }))}
                        style={{
                          background: venue[k] ? C.panel2 : "transparent",
                          color: venue[k] ? C.amber : C.dimmer,
                          border: `1px solid ${venue[k] ? C.amber : C.line}`,
                          padding: "8px 14px", fontFamily: MONO, fontSize: 10,
                          letterSpacing: "0.14em", cursor: "pointer",
                        }}
                      >
                        {lbl} {venue[k] ? "ON" : "OFF"}
                      </button>
                    ))}
                    <button
                      onClick={fireStutter}
                      disabled={!playing}
                      style={{
                        background: "transparent", color: playing ? C.blue : C.dimmer,
                        border: `1px solid ${playing ? C.blue : C.line}`,
                        padding: "8px 18px", fontFamily: MONO, fontSize: 10,
                        letterSpacing: "0.14em", cursor: playing ? "pointer" : "default",
                      }}
                    >
                      STUTTER 手動
                    </button>
                  </div>
                  <div style={{ fontSize: 10, color: C.dimmer, lineHeight: 1.7, marginTop: 10 }}>
                    部屋鳴りは薄い区間ほど深く返る。サチュレーションは強度に連動して駆動量が増える。
                    フランジとスタッターは、慣れが飽和し強度が乗っているときだけ自動発火し、直後は反復へ戻る。
                  </div>
                </div>
              )}
            </div>

            {/* 303 bass */}
            <div style={{ ...panel, padding: 0, marginBottom: 14 }}>
              <button
                onClick={() => setShow303((v) => !v)}
                style={{
                  width: "100%",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  background: "transparent",
                  border: "none",
                  borderBottom: show303 ? `1px solid ${C.line}` : "none",
                  padding: "11px 14px",
                  cursor: "pointer",
                  color: C.dim,
                }}
              >
                <span style={label}>BASS 303 / glide + accent</span>
                <span style={{ fontFamily: MONO, fontSize: 11, color: C.dimmer }}>{show303 ? "閉じる ▲" : "開く ▼"}</span>
              </button>
              {show303 && (
                <div style={{ padding: "14px 14px 12px" }}>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))", gap: "0 22px" }}>
                    <Slider lab="Cutoff" val={b303.cut} min={70} max={900} step={5}
                      onChange={(v) => setB303((p2) => ({ ...p2, cut: v }))} fmt={(v) => `${v} Hz`} />
                    <Slider lab="Resonance" val={b303.res} min={0.5} max={12} step={0.1}
                      onChange={(v) => setB303((p2) => ({ ...p2, res: v }))} fmt={(v) => `Q ${v.toFixed(1)}`} />
                    <Slider lab="Env Mod" val={b303.env} min={0} max={1} step={0.01}
                      onChange={(v) => setB303((p2) => ({ ...p2, env: v }))} fmt={(v) => v.toFixed(2)} />
                    <Slider lab="Decay" val={b303.dec} min={0.05} max={0.9} step={0.01}
                      onChange={(v) => setB303((p2) => ({ ...p2, dec: v }))} fmt={(v) => `${Math.round(v * 1000)} ms`} />
                    <Slider lab="Accent" val={b303.acc} min={0} max={1} step={0.01}
                      onChange={(v) => setB303((p2) => ({ ...p2, acc: v }))} fmt={(v) => v.toFixed(2)} />
                    <Slider lab="Glide" val={b303.glide} min={0.01} max={0.16} step={0.005}
                      onChange={(v) => setB303((p2) => ({ ...p2, glide: v }))} fmt={(v) => `${Math.round(v * 1000)} ms`} />
                  </div>
                  <div style={{ fontSize: 10, color: C.dimmer, lineHeight: 1.7, marginTop: 2 }}>
                    アクセントは音量だけでなく、フィルタの振り幅を広げ、減衰を約6割に縮める。
                    グライドはスライド指定の音の手前を重ねて残すことで起こす。
                    ステップ行列のBASS行で、明るいセルがアクセント。
                  </div>
                </div>
              )}
            </div>

            {/* mixer */}
            <div style={{ ...panel, padding: 0, marginBottom: 14 }}>
              <button
                onClick={() => setShowMixer((v) => !v)}
                style={{
                  width: "100%",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  background: "transparent",
                  border: "none",
                  borderBottom: showMixer ? `1px solid ${C.line}` : "none",
                  padding: "11px 14px",
                  cursor: "pointer",
                  color: C.dim,
                }}
              >
                <span style={label}>ミキサー / channel balance</span>
                <span style={{ fontFamily: MONO, fontSize: 11, color: C.dimmer }}>{showMixer ? "閉じる ▲" : "開く ▼"}</span>
              </button>
              {showMixer && (
                <div style={{ padding: "12px 14px 14px" }}>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(230px,1fr))", gap: "0 22px" }}>
                    {MIX.map((l) => {
                      const v = levels[l];
                      const m = !!mutes[l];
                      const db = v <= 0.0005 ? -Infinity : 20 * Math.log10(v);
                      return (
                        <div key={l} style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 9 }}>
                          <button
                            onClick={() => toggleMute(l)}
                            title="ミュート"
                            style={{
                              width: 20,
                              height: 20,
                              flexShrink: 0,
                              background: m ? C.blue : "transparent",
                              border: `1px solid ${m ? C.blue : C.line}`,
                              color: m ? C.bg : C.dimmer,
                              fontFamily: MONO,
                              fontSize: 9,
                              cursor: "pointer",
                              padding: 0,
                            }}
                          >
                            M
                          </button>
                          <span
                            style={{
                              width: 40,
                              flexShrink: 0,
                              fontFamily: MONO,
                              fontSize: 9,
                              letterSpacing: "0.08em",
                              color: m ? C.dimmer : (l === "fx" ? u.section.type === "build" : u.active[l]) ? C.ink : C.dim,
                            }}
                          >
                            {LAYER_JP[l]}
                          </span>
                          <input
                            type="range"
                            min={0}
                            max={1.2}
                            step={0.01}
                            value={v}
                            onChange={(ev) => setLevel(l, parseFloat(ev.target.value))}
                            style={{ flex: 1, minWidth: 60 }}
                          />
                          <span
                            style={{
                              width: 48,
                              flexShrink: 0,
                              textAlign: "right",
                              fontFamily: MONO,
                              fontSize: 9.5,
                              color: m ? C.dimmer : C.dim,
                              fontVariantNumeric: "tabular-nums",
                            }}
                          >
                            {db === -Infinity ? "-∞" : `${db > 0 ? "+" : ""}${db.toFixed(1)}`} dB
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6 }}>
                    <span style={{ fontSize: 10, color: C.dimmer, lineHeight: 1.6 }}>
                      SUB・BASS・ACIDは低域が重なるため既定値を低く置いている。
                    </span>
                    <button
                      onClick={resetLevels}
                      style={{
                        background: "transparent",
                        border: `1px solid ${C.line}`,
                        color: C.dim,
                        padding: "6px 12px",
                        fontFamily: MONO,
                        fontSize: 10,
                        letterSpacing: "0.14em",
                        cursor: "pointer",
                      }}
                    >
                      初期値
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* step matrix */}
            <div style={{ ...panel, padding: 0 }}>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "11px 14px", borderBottom: `1px solid ${C.line}` }}>
                <span style={label}>ステップ行列 / 16分グリッド</span>
                <span style={{ ...label, color: C.dimmer }}>右端の数字＝そのパターンが不変で続いた小節数</span>
              </div>
              <div style={{ padding: "10px 14px 14px" }}>
                {LAYERS.map((l) => {
                  const on = u.active[l];
                  const ph = u.phase[l] || 0;
                  const row = u.pat ? u.pat[l] : null;
                  return (
                    <div key={l} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3, opacity: on ? 1 : 0.26 }}>
                      <div
                        style={{
                          width: 42,
                          fontFamily: MONO,
                          fontSize: 9,
                          letterSpacing: "0.08em",
                          color: u.flash[l] ? C.amber : on ? C.dim : C.dimmer,
                        }}
                      >
                        {LAYER_JP[l]}
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(16,1fr)", gap: 2, flex: 1 }}>
                        {Array.from({ length: 16 }).map((_, i) => {
                          const v = row ? row[(i + ph) % 16] : 0;
                          const hit = !!v;
                          const acc = v && typeof v === "object" && v.a;
                          const head = u.step === i && playing;
                          return (
                            <div
                              key={i}
                              style={{
                                height: 13,
                                background: hit ? (acc ? C.amber : on ? "#8A6A18" : C.line) : i % 4 === 0 ? "#241F18" : "#1B1712",
                                borderTop: head ? `2px solid ${C.blue}` : "2px solid transparent",
                              }}
                            />
                          );
                        })}
                      </div>
                      <div
                        style={{
                          width: 26,
                          textAlign: "right",
                          fontFamily: MONO,
                          fontSize: 9,
                          color: (u.age[l] || 0) > 8 ? C.amber : C.dimmer,
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        {u.age[l] || 0}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* ---------- right rail ---------- */}
          <div>
            <div style={{ ...panel, marginBottom: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 14 }}>
                <div>
                  <div style={{ ...label, marginBottom: 3 }}>BAR</div>
                  <div style={{ fontFamily: MONO, fontSize: 26, fontVariantNumeric: "tabular-nums", lineHeight: 1 }}>
                    {String(u.bar).padStart(4, "0")}
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ ...label, marginBottom: 3 }}>偏差回数</div>
                  <div style={{ fontFamily: MONO, fontSize: 26, color: C.blue, fontVariantNumeric: "tabular-nums", lineHeight: 1 }}>
                    {String(u.devCount).padStart(4, "0")}
                  </div>
                </div>
              </div>

              <Meter name="Familiarity" jp="慣れ" v={u.familiarity} color={C.amber} />
              <Meter name="Prediction err" jp="誤差" v={u.surprise} color={C.blue} scale={2.2} />
              <Meter name="Interest" jp="興味" v={u.interest} color={C.ink} />
              <Meter name="Energy" jp="強度" v={u.energy} color="#8A8172" />

              <div style={{ borderTop: `1px solid ${C.line}`, marginTop: 4, paddingTop: 11, fontFamily: MONO, fontSize: 10.5, lineHeight: 2 }}>
                <Row k="SECTION" v={`${u.section.type} (${u.section.left}/${u.section.len})`} />
                <Row k="PROCESS" v={u.process} c={C.blue} />
                <Row k="TONALITY" v={`${midiToNote(u.root)} ${u.scaleName}`} />
                <Row k="PAD VOICING" v={u.padActive ? u.padLabel || "—" : "休止"} c={u.padActive ? C.amber : C.dimmer} />
                <Row k="STATE" v={u.freeze > 0 ? `反復固定 ${u.freeze}` : "偏差許容"} c={u.freeze > 0 ? C.amber : C.dim} />
              </div>
            </div>

            <div style={{ ...panel, marginBottom: 14 }}>
              <div style={{ ...label, marginBottom: 12 }}>制御</div>
              <Slider lab="BPM" val={bpm} min={90} max={160} step={1} onChange={setBpm} fmt={(v) => v} />
              <Slider lab="変化欲求" val={appetite} min={0} max={2} step={0.05} onChange={setAppetite} fmt={(v) => v.toFixed(2) + "×"} />
              <Slider
                lab="ダッキング深度"
                val={duckAmt}
                min={0.1}
                max={1}
                step={0.02}
                onChange={setDuckAmt}
                fmt={(v) => Math.round((1 - v) * 100) + "%"}
              />
              <Slider
                lab="低域の音域幅"
                val={spread}
                min={12}
                max={26}
                step={1}
                onChange={setSpread}
                fmt={(v) => `${v} 半音`}
              />
              <div style={{ fontSize: 10, color: C.dimmer, lineHeight: 1.6, marginTop: -8, marginBottom: 14 }}>
                KICK {midiToNote(u.root - 9)} に対し BASS は{" "}
                <span style={{ color: C.amber }}>
                  {midiToNote(u.root + 3)} 〜 {midiToNote(u.root + 3 + spread)}
                </span>{" "}
                に収まる
              </div>
              <Slider lab="音量" val={vol} min={0} max={1} step={0.01} onChange={setVol} fmt={(v) => Math.round(v * 100)} />
              <button
                onClick={toggleLite}
                style={{
                  width: "100%",
                  background: lite ? C.panel2 : "transparent",
                  color: lite ? C.amber : C.dim,
                  border: `1px solid ${lite ? C.amber : C.line}`,
                  padding: "10px 8px",
                  fontFamily: MONO,
                  fontSize: 10.5,
                  letterSpacing: "0.16em",
                  cursor: "pointer",
                }}
              >
                {lite ? "軽量モード ON" : "軽量モード OFF"}
              </button>
              <div style={{ fontSize: 10, color: C.dimmer, lineHeight: 1.6, marginTop: 8 }}>
                リバーブを外し、金属打楽器を帯域ノイズに、発音数を半減。モバイルでの音切れ対策。
              </div>
            </div>

            <div style={{ ...panel, padding: 0 }}>
              <div style={{ ...label, padding: "12px 14px", borderBottom: `1px solid ${C.line}` }}>偏差ログ</div>
              <div style={{ padding: "8px 14px 12px", minHeight: 130 }}>
                {u.log.length === 0 && <div style={{ fontSize: 10.5, color: C.dimmer, paddingTop: 8 }}>反復が十分に固まるまで、偏差は起きない。</div>}
                {u.log.map((l, i) => (
                  <div key={`${l.bar}-${i}`} style={{ marginBottom: 7, opacity: 1 - i * 0.11 }}>
                    <div style={{ fontFamily: MONO, fontSize: 9, color: C.dimmer, letterSpacing: "0.08em" }}>
                      BAR {String(l.bar).padStart(4, "0")} / <span style={{ color: C.blue }}>{l.op}</span>
                    </div>
                    <div style={{ fontSize: 11, color: C.dim, lineHeight: 1.5 }}>{l.text}</div>
                  </div>
                ))}
              </div>
            </div>
            <div style={{ ...panel, padding: 0, marginTop: 14 }}>
              <div style={{ ...label, padding: "12px 14px", borderBottom: `1px solid ${C.line}` }}>診断 / diagnostics</div>
              <div style={{ padding: "10px 14px 13px", fontFamily: MONO, fontSize: 10, lineHeight: 1.9 }}>
                <Row k="TONE" v={(u.diag && u.diag.ver) || "—"} />
                <Row k="CONTEXT" v={(u.diag && u.diag.ctx) || "—"} c={u.diag && u.diag.ctx === "running" ? C.amber : C.blue} />
                <Row k="SAMPLE RATE" v={u.diag && u.diag.sr ? `${u.diag.sr} Hz` : "—"} />
                <Row k="CTX TIME" v={u.diag && u.diag.now != null ? u.diag.now.toFixed(2) : "—"} />
                <Row k="SCHEDULER" v={(u.diag && u.diag.tState) || "—"} c={u.diag && u.diag.tState === "started" ? C.amber : C.blue} />
                <Row k="STEPS FIRED" v={u.diag && u.diag.tSec != null ? String(u.diag.tSec) : "—"} />
                <Row k="LOOKAHEAD" v={u.diag && u.diag.lag != null ? `${(u.diag.lag * 1000).toFixed(0)} ms` : "—"} />
                <Row
                  k="STARVATION"
                  v={u.diag && u.diag.skips != null ? String(u.diag.skips) : "—"}
                  c={u.diag && u.diag.skips > 0 ? C.blue : C.dim}
                />
                <Row k="MODE" v={lite ? "軽量" : "標準"} />
                <Row
                  k="OUTPUT"
                  v={u.diag && typeof u.diag.lvl === "number" && isFinite(u.diag.lvl) ? `${u.diag.lvl.toFixed(1)} dB` : "—"}
                  c={u.diag && typeof u.diag.lvl === "number" && u.diag.lvl > -1 ? C.blue : C.dim}
                />
                <Row k="STEP" v={String(u.step)} />
                {u.diag && u.diag.err && <Row k="ERROR" v={u.diag.err} c={C.blue} />}
              </div>
            </div>
          </div>
        </div>

        <footer style={{ marginTop: 24, paddingTop: 16, borderTop: `1px solid ${C.line}`, fontSize: 11, color: C.dimmer, lineHeight: 1.9 }}>
          反復は予測を安定させ、安定した予測の上でのみ、微小なズレは鋭い予測誤差として知覚される。本機は生成器と並走する聴取シミュレータを持ち、
          慣れの飽和を検知して偏差を注入し、誤差が過大なら反復へ引き戻す。同一性の確認ではなく、同じようで同じでないものを聴き分ける時間を、
          無限に供給し続けるための装置である。
        </footer>
      </div>

      <style>{`@media (max-width: 860px){ .dv-main{ grid-template-columns: minmax(0,1fr) !important; } }`}</style>
    </div>
  );
}

/* ---------- small subcomponents ---------- */
function Row({ k, v, c }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
      <span style={{ color: "#5C554A", letterSpacing: "0.14em", fontSize: 9 }}>{k}</span>
      <span style={{ color: c || "#8A8172", textAlign: "right", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{v}</span>
    </div>
  );
}

function Slider({ lab, val, min, max, step, onChange, fmt }) {
  return (
    <div style={{ marginBottom: 15 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 7 }}>
        <span style={{ fontSize: 9.5, letterSpacing: "0.18em", color: "#8A8172", textTransform: "uppercase" }}>{lab}</span>
        <span style={{ fontFamily: `ui-monospace, Menlo, monospace`, fontSize: 10.5, color: "#EDE6D6", fontVariantNumeric: "tabular-nums" }}>
          {fmt(val)}
        </span>
      </div>
      <input type="range" min={min} max={max} step={step} value={val} onChange={(e) => onChange(parseFloat(e.target.value))} />
    </div>
  );
}
