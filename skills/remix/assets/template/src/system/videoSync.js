// Engineered playback driver for every <video> inside a scene — the ONE copy of the
// host-clock/video contract, shared by both build modes:
//
//   - project mode: player.js imports it and drives it from useClock, so bundled
//     scenes (per-scene scene.html AND the whole-project index.html) get it for free;
//   - transpile mode: asset_injection.py inlines this file (stripping the `export`)
//     into the <script> it appends to any scene.html that carries a <video>.
//
// The host (SceneIframePlayer / the renderer) drives window.scenePlayer with
// play/pause/seekTo; the videos are slaves with no clock of their own. The naive
// slave ("re-seek on every host call") shipped four real failure modes, each of
// which this engine exists to close:
//
//   1. Seek storms on long-GOP sources: every currentTime write aborts the seek in
//      flight, so under rapid corrections the decoder never presents a frame. Here a
//      seek is only issued past a deadband (TOL) and never while one is in flight —
//      the newest target is parked and applied on 'seeked', so the last seek always
//      wins without aborting the current one.
//   2. Non-1x playback: the host implements 0.5x/2x by calling pause()+seekTo() every
//      animation frame, which froze the video outright. The engine detects that
//      cadence (scrub-follow), keeps the video PLAYING at the estimated rate, and
//      also exposes an explicit setRate(r) for hosts that know the rate.
//   3. A src swap mid-playback (the iOS blob rehost calls load()) silently resets the
//      element to t=0 paused; the 'emptied'→'loadedmetadata' pair realigns and
//      resumes it.
//   4. A rejected play() (autoplay policy) previously froze the video forever; the
//      engine retries muted (the enhancement clips are encoded -an, so muting loses
//      nothing) and a watchdog resumes any video found paused while it should run.
//   5. A video that JOINS mid-playback (each project-mode scene cut mounts a fresh
//      element) starts a load-latency behind the host, inside the old deadband, so
//      it stayed desynced for the whole scene — fatal when the scene audio is the
//      speaker's own voice. Steady playback therefore corrects past RUN_TOL — but
//      rate-limited and led by the element's measured seek latency, because a naive
//      correct-on-sight loop is its own failure mode: when one seek takes longer
//      than the tolerance (slow decoder, uncached range fetches), every correction
//      recreates the gap it closes and the video jump-cuts forever ("shaking").
//      Between corrections a playbackRate servo bleeds off sub-tolerance drift
//      smoothly, so small errors never need a visible seek at all.
//   6. A looping slot (a GIF-like loop, <video data-loop="1">) shorter than its scene would park
//      on its last frame. Once its duration is known it maps scene time to t % duration, drifts
//      are measured the short way round the loop, and the element loops natively while playing,
//      so it never "ends".
//
// No imports, no module state: transpile inlining depends on this file being a single
// self-contained function declaration.
export function createVideoSync(getTime) {
  var TOL = 0.4;            // scrub-follow deadband: don't fight the host's own seek storm
  var RUN_TOL = 0.15;       // steady playback: correct past this (rate-limited, latency-led)
  var PAUSED_TOL = 0.01;    // paused/renderer seeks stay frame-accurate: under half a 30 fps frame, or every
                            // other captured frame keeps the previous picture
  var END_TOL = 0.01;
  var FRAME_NUDGE = 0.004; // renderer seek target past the frame boundary (see align)
  var SERVO_TOL = 0.06;     // drift the rate servo leaves alone (A/V sync threshold)
  var SERVO_GAIN = 0.5;     // rate correction per second of drift…
  var SERVO_MAX = 0.12;     // …capped so catch-up is never a visible speed change
  var SERVO_GRACE_MS = 1000; // four watchdog ticks for small startup drift to settle before seeking
  var FIX_MIN_GAP_MS = 600; // min wall-clock between corrective seeks on one element
  var LEAD_MAX = 0.25;      // cap on the measured-seek-latency lead
  var JUMP_TOL = 1;         // host-time jump that reads as an explicit seek, not drift
  var SCRUB_GAP_MS = 250;   // max gap between host seeks that still reads as scrubbing
  var SCRUB_MIN_SEEKS = 3;
  var SCRUB_HOLD_MS = 300;  // how long scrub-follow survives after the last seek
  var WATCHDOG_MS = 250;
  var RATE_MIN = 0.25, RATE_MAX = 4;

  var hostPlaying = false;
  var rate = 1;             // applied to video.playbackRate
  var rateDeclared = false; // true once the host called setRate — estimation stops
  var rateEst = 0;          // EMA of scrub cadence, host-seconds per wall-second
  var scrubUntil = 0;       // wall-clock deadline while scrub-follow is active
  var wasScrubbing = false;
  var lastSeekWall = 0, lastSeekT = 0, seekRun = 0;
  var lastTickWall = 0;
  var lastHostT = 0;        // host time at the previous alignAll — jump detection
  var watchdog = null;

  function nowMs() { return Date.now(); }
  // The renderer (capture.mjs) seeks every frame faster than SCRUB_GAP_MS; without this flag that reads as
  // scrubbing, the video free-runs between captures and the captured picture stalls and jumps.
  function frameAccurate() { return typeof window !== 'undefined' && window.__tapvidFrameAccurate === true; }
  function scrubbing() { return !frameAccurate() && nowMs() < scrubUntil; }
  function shouldRun() { return hostPlaying || scrubbing(); }

  function tryPlay(v) {
    if (Math.abs(v.playbackRate - rate) > 0.01) v.playbackRate = rate;
    var p = v.play();
    if (p && p.catch) p.catch(function () {
      v.muted = true;
      var q = v.play();
      if (q && q.catch) q.catch(function () {});
    });
  }

  // Desired playbackRate for this instant: the host rate, nudged (capped ±SERVO_MAX)
  // to bleed off sub-TOL drift while genuinely playing. Inside the deadband nothing
  // is corrected, so a video could otherwise run a constant lip-sync error — the
  // servo converges it below SERVO_TOL without a jump-seek's visible hiccup.
  function servoRate(v, t) {
    if (!hostPlaying || scrubbing() || v.seeking) return rate;
    var drift = driftOf(v, t); // positive = video behind the host clock
    if (Math.abs(drift) <= SERVO_TOL) return rate;
    var adj = Math.max(-SERVO_MAX, Math.min(SERVO_MAX, drift * SERVO_GAIN));
    return rate * (1 + adj);
  }

  // During a scene transition the outgoing scene stays mounted beside the incoming one.
  // projectPlayer marks each scene wrapper with data-time-offset (the outgoing scene's start
  // lead over the incoming one), so a video plays at its own scene's local time instead of
  // the incoming scene's. tapvid: a <video data-offset="s"> also starts s seconds into its clip.
  function timeOffset(v) {
    var el = v.closest ? v.closest('[data-time-offset]') : null;
    var o = el ? parseFloat(el.getAttribute('data-time-offset')) : 0;
    var own = v.getAttribute ? parseFloat(v.getAttribute('data-offset')) : 0;
    return (isFinite(o) ? o : 0) + (isFinite(own) ? own : 0);
  }

  function looping(v) { return !!v.getAttribute && v.getAttribute('data-loop') === '1'; }

  // Host-ahead drift of video v at (loop-mapped) time t; for a loop, the short way round, so the
  // wrap from the last frame to the first reads as a few ms, not a whole loop.
  function driftOf(v, t) {
    var drift = t - v.currentTime;
    var d = v.duration;
    if (looping(v) && d > 0 && isFinite(d)) drift -= d * Math.round(drift / d);
    return drift;
  }

  function align(v, t) {
    t = t + timeOffset(v);
    var d = v.duration;
    if (!d || !isFinite(d) || d <= 0) {
      v.addEventListener('loadedmetadata', function () { align(v, getTime()); }, { once: true });
      if (v.preload === 'none') v.load();
      return;
    }
    var loop = looping(v);
    if (loop) t = ((t % d) + d) % d;
    else if (t >= d) {
      // Clip shorter than the scene: park on the last frame, never restart.
      if (!v.paused) v.pause();
      if (!v.seeking && Math.abs(v.currentTime - d) > END_TOL) v.currentTime = d;
      return;
    }
    if (v.seeking) { v.__tapvidPendingSeek = true; }
    else if (!shouldRun()) {
      // Rendering: a seek that lands exactly on a frame boundary often shows the frame before it (measured: 9 of
      // 30 captures one frame stale); aiming FRAME_NUDGE past the boundary lands on the frame that starts at t.
      if (frameAccurate()) t += FRAME_NUDGE;
      if (Math.abs(v.currentTime - t) > PAUSED_TOL) v.currentTime = Math.max(0, t);
    } else {
      // Steady playback corrects past RUN_TOL; scrub-follow keeps the wide TOL
      // (the host is already seeking every frame). A steady correction is rate-
      // limited per element and, when the video is BEHIND, aims past the target by
      // the element's measured seek latency — so a slow decoder converges in a few
      // seeks instead of recreating the gap forever. The servo covers the rest.
      var steady = hostPlaying && !scrubbing();
      var drift = driftOf(v, t);
      // Seeking while the decoder is starved restarts range fetch/decode work,
      // which can keep an otherwise playable clip permanently behind the clock.
      // Let it buffer first; the watchdog/playing event will correct afterwards.
      var buffered = v.readyState == null || v.readyState >= 3;
      var w = nowMs();
      if (!steady || Math.abs(drift) <= RUN_TOL || !buffered) v.__tapvidDriftSince = null;
      else if (v.__tapvidDriftSince == null) v.__tapvidDriftSince = w;
      var settled = !steady || Math.abs(drift) > TOL
        || (v.__tapvidDriftSince != null && w - v.__tapvidDriftSince >= SERVO_GRACE_MS);
      if (buffered && settled && Math.abs(drift) > (steady ? RUN_TOL : TOL)) {
        if (!steady || !v.__tapvidFixWall || w - v.__tapvidFixWall >= FIX_MIN_GAP_MS) {
          v.__tapvidFixWall = w;
          v.__tapvidDriftSince = null;
          v.__tapvidSeekBegan = w;
          var lead = (steady && drift > 0) ? Math.min(LEAD_MAX, (v.__tapvidSeekLatMs || 0) / 1000) : 0;
          v.currentTime = loop ? (t + lead) % d : Math.max(0, t + lead);
        }
      }
    }
    if (shouldRun()) {
      if (v.paused) tryPlay(v);
      var want = servoRate(v, t);
      if (Math.abs(v.playbackRate - want) > 0.005) v.playbackRate = want;
    } else if (!v.paused) {
      v.pause();
    }
  }

  function ensure(v) {
    if (v.__tapvidSynced) return;
    v.__tapvidSynced = true;
    v.loop = looping(v);
    v.autoplay = false;
    // Fetch ahead even while the page sits paused in a background preload slot:
    // the browser default ('metadata') leaves the element frameless until the
    // scene is promoted, which shows as a black video band at the cut/seek.
    if (v.preload !== 'auto') v.preload = 'auto';
    v.volume = 0.15;
    v.pause();
    // Lossless last-seek-wins: a target that arrived mid-seek is applied when the
    // in-flight seek completes, instead of aborting it (the seek-storm fix).
    v.addEventListener('seeked', function () {
      if (v.__tapvidSeekBegan) {
        v.__tapvidSeekLatMs = nowMs() - v.__tapvidSeekBegan;
        v.__tapvidSeekBegan = 0;
      }
      if (v.__tapvidPendingSeek) { v.__tapvidPendingSeek = false; align(v, getTime()); }
    });
    // Late-join catch-up: a fresh element (every project-mode scene cut mounts one)
    // engages playback a fetch/decode-latency behind the host. Route it through
    // align so the correction inherits the rate limit + latency lead.
    v.addEventListener('playing', function () { align(v, getTime()); });
    // A src swap (el.load() after a blob rehost) resets the element to 0/paused.
    v.addEventListener('emptied', function () { v.__tapvidRealign = true; });
    v.addEventListener('loadedmetadata', function () {
      if (v.__tapvidRealign) { v.__tapvidRealign = false; align(v, getTime()); }
    });
    align(v, getTime());
  }

  function alignAll() {
    var t = getTime();
    var list = document.querySelectorAll('video');
    for (var i = 0; i < list.length; i++) { ensure(list[i]); align(list[i], t); }
    lastHostT = t;
  }

  function endScrubIfExpired() {
    if (wasScrubbing && !scrubbing()) {
      wasScrubbing = false;
      seekRun = 0;
      rateEst = 0;
      if (!rateDeclared) rate = 1;
      alignAll(); // apply the real host state (pause videos if the host is paused)
    }
  }

  return {
    play: function () {
      hostPlaying = true;
      scrubUntil = 0;
      wasScrubbing = false;
      seekRun = 0;
      if (!rateDeclared) { rate = 1; rateEst = 0; }
      alignAll();
    },
    pause: function () {
      hostPlaying = false;
      // During scrub-follow the host "pauses" every frame; honoring it would freeze
      // the video the scrub is driving. The real pause lands when the scrub expires.
      if (!scrubbing()) alignAll();
    },
    seek: function () {
      var t = getTime();
      var w = nowMs();
      // An explicit jump (progress-bar click, chip jump) must land NOW: the
      // corrective-seek rate limit exists to pace drift corrections, not to
      // swallow a command the host just issued. Small host-seek deltas (the
      // scrub cadence, sub-second nudges) keep the limiter.
      if (Math.abs(t - lastHostT) > JUMP_TOL) {
        var vids = document.querySelectorAll('video');
        for (var j = 0; j < vids.length; j++) { vids[j].__tapvidFixWall = 0; }
      }
      var dt = t - lastSeekT, dw = w - lastSeekWall;
      if (dw > 0 && dw < SCRUB_GAP_MS && dt > 0) {
        seekRun += 1;
        var r = (dt * 1000) / dw;
        if (r > RATE_MIN * 0.8 && r < RATE_MAX * 1.2) {
          rateEst = rateEst ? rateEst * 0.7 + r * 0.3 : r;
        }
        if (seekRun >= SCRUB_MIN_SEEKS && !hostPlaying) {
          scrubUntil = w + SCRUB_HOLD_MS;
          wasScrubbing = true;
          if (!rateDeclared && rateEst) {
            rate = Math.max(RATE_MIN, Math.min(RATE_MAX, rateEst));
          }
        }
      } else {
        seekRun = 0;
        rateEst = 0;
        if (!rateDeclared && !scrubbing()) rate = 1;
      }
      lastSeekT = t;
      lastSeekWall = w;
      alignAll();
    },
    setRate: function (r) {
      if (!(r > 0) || !isFinite(r)) return;
      rateDeclared = true;
      rate = Math.max(RATE_MIN, Math.min(RATE_MAX, r));
      alignAll();
    },
    // Optional per-frame nudge from a host rAF loop — throttled; the watchdog is the
    // guaranteed cadence, this just picks up late-mounted videos faster.
    tick: function () {
      var w = nowMs();
      endScrubIfExpired();
      if (w - lastTickWall < 100) return;
      lastTickWall = w;
      alignAll();
    },
    start: function () {
      alignAll();
      if (watchdog == null) {
        watchdog = setInterval(function () { endScrubIfExpired(); alignAll(); }, WATCHDOG_MS);
      }
    },
    dispose: function () {
      if (watchdog != null) { clearInterval(watchdog); watchdog = null; }
    },
  };
}
