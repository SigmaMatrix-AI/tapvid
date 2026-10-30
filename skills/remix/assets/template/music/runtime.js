// Score runtime for code-composed BGM (copied from ugc-video; the `ugc` helper name is kept so scores port unchanged). Loaded in a headless Chromium page
// after Tone.js; scripts/music-compose.mjs then loads a score file and calls __render.
//
// A score file calls score({...}):
//
//   score({
//     bpm: 96, beatsPerBar: 4,
//     instruments: ['harp', 'cellos'],      // VSCO 2 CE samplers to load (template/music/instruments.json)
//     oneShots: ['crash'],                  // VSCO one-shot hits
//     compose({ Tone, ugc, transport, seconds, bars }) {
//       const harp = ugc.sampler('harp');
//       ugc.progression(['C:maj7', 'A:m7', 'F:maj7', 'G:7'], { bars: 1, octave: 3 }).forEach(({ time, notes }) =>
//         harp.triggerAttackRelease(notes, '1m', time));
//     },
//   });
//
// Everything is scheduled on the transport before rendering; Tone.Offline renders
// exactly `seconds` of audio, so the result is deterministic and exactly as long as the film.
(function () {
  var def = null;
  window.score = function (d) { def = d; };
  window.__scoreMeta = function () {
    return def && { bpm: def.bpm, beatsPerBar: def.beatsPerBar || 4, instruments: def.instruments || [], oneShots: def.oneShots || [] };
  };

  var CHORDS = {
    maj: [0, 4, 7], m: [0, 3, 7], dim: [0, 3, 6], aug: [0, 4, 8], sus2: [0, 2, 7], sus4: [0, 5, 7],
    maj7: [0, 4, 7, 11], m7: [0, 3, 7, 10], '7': [0, 4, 7, 10], m9: [0, 3, 7, 10, 14], maj9: [0, 4, 7, 11, 14],
    add9: [0, 4, 7, 14], '6': [0, 4, 7, 9], m6: [0, 3, 7, 9],
  };

  function makeUgc(Tone, loaded) {
    var bus = new Tone.Gain(1);
    var comp = new Tone.Compressor({ threshold: -18, ratio: 3, attack: 0.01, release: 0.2 });
    var limiter = new Tone.Limiter(-1);
    bus.chain(comp, limiter, Tone.getDestination());
    var reverb = new Tone.Reverb({ decay: 3.2, wet: 1 });
    var reverbSend = new Tone.Gain(0.25).connect(reverb);
    reverb.connect(bus);

    function out(node, wet) {
      node.connect(bus);
      if (wet !== 0) { var s = new Tone.Gain(wet == null ? 1 : wet); node.connect(s); s.connect(reverbSend); }
      return node;
    }
    var ugc = {
      bus: bus,
      out: out,
      // VSCO sampler (preloaded before compose); volume in dB, wet = reverb send (0..1).
      sampler: function (name, opts) {
        var s = loaded.instruments[name];
        if (!s) throw new Error('instrument not declared in score.instruments: ' + name);
        opts = opts || {};
        s.volume.value = opts.volume != null ? opts.volume : -6;
        if (opts.release != null) s.release = opts.release;
        return out(s, opts.wet);
      },
      oneShot: function (name, opts) {
        var p = loaded.oneShots[name];
        if (!p) throw new Error('one-shot not declared in score.oneShots: ' + name);
        opts = opts || {};
        p.volume.value = opts.volume != null ? opts.volume : -6;
        return out(p, opts.wet);
      },
      synth: {
        pad: function (o) { o = o || {}; return out(new Tone.PolySynth(Tone.Synth, { oscillator: { type: 'fattriangle', count: 3, spread: 18 },
          envelope: { attack: 0.8, decay: 0.3, sustain: 0.8, release: 2 }, volume: o.volume || -18 }), o.wet != null ? o.wet : 0.8); },
        keys: function (o) { o = o || {}; return out(new Tone.PolySynth(Tone.FMSynth, { harmonicity: 2, modulationIndex: 3,
          envelope: { attack: 0.005, decay: 0.6, sustain: 0.2, release: 1.2 }, volume: o.volume || -16 }), o.wet != null ? o.wet : 0.5); },
        pluck: function (o) { o = o || {}; return out(new Tone.PolySynth(Tone.Synth, { oscillator: { type: 'triangle' },
          envelope: { attack: 0.002, decay: 0.25, sustain: 0, release: 0.3 }, volume: o.volume || -14 }), o.wet != null ? o.wet : 0.4); },
        lead: function (o) { o = o || {}; return out(new Tone.MonoSynth({ oscillator: { type: 'sawtooth' }, filter: { Q: 1, type: 'lowpass' },
          filterEnvelope: { attack: 0.01, decay: 0.2, sustain: 0.4, baseFrequency: 800, octaves: 2.5 },
          envelope: { attack: 0.01, decay: 0.2, sustain: 0.5, release: 0.4 }, volume: o.volume || -18 }), o.wet != null ? o.wet : 0.3); },
        bass: function (o) { o = o || {}; return out(new Tone.MonoSynth({ oscillator: { type: o.wave || 'sine' },
          envelope: { attack: 0.01, decay: 0.2, sustain: 0.7, release: 0.3 }, volume: o.volume || -10 }), 0); },
        subBass: function (o) { o = o || {}; return out(new Tone.Synth({ oscillator: { type: 'sine' },
          envelope: { attack: 0.01, decay: 0.1, sustain: 0.9, release: 0.3 }, volume: o.volume || -8 }), 0); },
      },
      drums: function (o) {
        o = o || {};
        return {
          kick: out(new Tone.MembraneSynth({ pitchDecay: 0.04, octaves: 6, volume: o.kick != null ? o.kick : -6 }), 0),
          snare: out(new Tone.NoiseSynth({ noise: { type: 'pink' }, envelope: { attack: 0.001, decay: 0.16, sustain: 0 },
            volume: o.snare != null ? o.snare : -16 }), 0.2),
          clap: out(new Tone.NoiseSynth({ noise: { type: 'white' }, envelope: { attack: 0.001, decay: 0.09, sustain: 0 },
            volume: o.clap != null ? o.clap : -18 }), 0.3),
          hat: out(new Tone.MetalSynth({ envelope: { attack: 0.001, decay: 0.05, release: 0.01 }, harmonicity: 5.1,
            modulationIndex: 32, resonance: 4000, octaves: 1.5, volume: o.hat != null ? o.hat : -30 }), 0),
        };
      },
      // 'C:maj7' at octave -> ['C3','E3','G3','B3'].
      chord: function (name, octave) {
        var parts = name.split(':'), root = Tone.Frequency(parts[0] + (octave == null ? 3 : octave)).toMidi();
        var iv = CHORDS[parts[1] || 'maj'];
        if (!iv) throw new Error('unknown chord quality: ' + name);
        return iv.map(function (i) { return Tone.Frequency(root + i, 'midi').toNote(); });
      },
      // Repeats a progression over `totalBars`; returns [{ bar, time, name, notes, root }].
      progression: function (names, opts) {
        opts = opts || {};
        var per = opts.bars || 1, total = opts.totalBars || ugc.bars, out = [];
        for (var bar = 0, i = 0; bar < total; bar += per, i++) {
          var name = names[i % names.length];
          out.push({ bar: bar, time: bar + ':0:0', name: name, notes: ugc.chord(name, opts.octave),
            root: name.split(':')[0] + ((opts.octave == null ? 3 : opts.octave) - 1) });
        }
        return out;
      },
      at: function (bar, beat, sixteenth) { return bar + ':' + (beat || 0) + ':' + (sixteenth || 0); },
    };
    return ugc;
  }

  function wav(buf) {
    var ch = [buf.getChannelData(0), buf.getChannelData(buf.numberOfChannels > 1 ? 1 : 0)], len = buf.length, sr = buf.sampleRate;
    var dv = new DataView(new ArrayBuffer(44 + len * 4));
    function w(o, s) { for (var i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); }
    w(0, 'RIFF'); dv.setUint32(4, 36 + len * 4, true); w(8, 'WAVEfmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
    dv.setUint16(22, 2, true); dv.setUint32(24, sr, true); dv.setUint32(28, sr * 4, true); dv.setUint16(32, 4, true);
    dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, len * 4, true);
    for (var i = 0; i < len; i++) for (var c = 0; c < 2; c++) {
      dv.setInt16(44 + (i * 2 + c) * 2, Math.max(-1, Math.min(1, ch[c][i])) * 0x7fff, true);
    }
    var bytes = new Uint8Array(dv.buffer), s = '';
    for (var k = 0; k < bytes.length; k += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(k, k + 0x8000));
    return btoa(s);
  }

  window.__render = async function (opts) {
    if (!def) throw new Error('score file did not call score({...})');
    var Tone = window.Tone, seconds = opts.seconds;
    var buf = await Tone.Offline(async function (ctx) {
      var transport = ctx.transport;
      transport.bpm.value = def.bpm;
      transport.timeSignature = def.beatsPerBar || 4;
      var barSec = (60 / def.bpm) * (def.beatsPerBar || 4);
      // Buffers must be loaded before anything is scheduled on them.
      var loaded = { instruments: {}, oneShots: {} };
      Object.keys(opts.samples.instruments).forEach(function (name) {
        var s = opts.samples.instruments[name];
        loaded.instruments[name] = new Tone.Sampler({ urls: s.urls, release: s.release });
      });
      Object.keys(opts.samples.oneShots).forEach(function (name) {
        loaded.oneShots[name] = new Tone.Player(opts.samples.oneShots[name]);
      });
      await Tone.loaded();
      var ugc = makeUgc(Tone, loaded);
      ugc.bars = Math.ceil(seconds / barSec);
      ugc.seconds = seconds;
      await def.compose({ Tone: Tone, ugc: ugc, transport: transport, seconds: seconds, bars: ugc.bars, cues: opts.cues || [] });
      await Tone.loaded();
      transport.start(0);
    }, seconds, 2, 44100);
    return wav(buf.get());
  };
})();
