import React from "react";

// Source of the generic low-tier board (references/specs/video-clone-tiers.spec.md §3.2); quick.mjs fills in
// the board name and LAYOUT per scene. The scene is the original's layout rebuilt as layers, back to
// front, then the on-screen texts on top.
// LAYOUT.layers: one per region — the prop that fills it (a video for avatar / pixel / screen, a React
// element for code), box [x, y, w, h] in % of the canvas, the corner shape, and `cut`: the prop of the
// clip's cutout when only the people of this layer are drawn over the layers behind them.
// LAYOUT.texts: box in % of the canvas, in / out as fractions of the scene, the entrance, the palette
// key of its colour, a plate behind it, and how many lines the original used.
const LAYOUT = __LAYOUT__;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
// Pops settle in 0.15 s with a slight overshoot; fades take 0.2 s; every text leaves in 0.12 s.
const POP_S = 0.15;
const FADE_S = 0.2;
const OUT_S = 0.12;
const outBack = (p) => {
  const q = clamp(p, 0, 1) - 1;
  return 1 + 2.70158 * q * q * q + 1.70158 * q * q;
};
// Line height and the average glyph width at weight 800, in em, used to fit a text into its box without
// measuring it (0.56 let "Follow and comment" wrap in a box the original fits it on one line).
const LINE_EM = 1.15;
const GLYPH_EM = 0.62;

const RADIUS = { rect: 0, round: "3cqw", circle: "50%" };

const fill = (el) => (el ? React.cloneElement(el, { style: { width: "100%", height: "100%", objectFit: "cover", display: "block" } }) : null);

function Text({ text, spec, t, duration, Design }) {
  const start = spec.in * duration;
  const end = spec.out * duration;
  if (!text || t < start || t >= end) return null;
  const local = t - start;
  const leave = clamp((end - t) / OUT_S, 0, 1);
  const enter = spec.enter === "pop" ? clamp(local / POP_S, 0, 1) : spec.enter === "fade" ? clamp(local / FADE_S, 0, 1) : 1;
  const scale = spec.enter === "pop" ? 0.6 + 0.4 * outBack(local / POP_S) : 1;
  const [x, y, w, h] = spec.box;
  // Explicit line breaks set the lines; otherwise the text wraps into as many lines as the original's.
  const rows = text.split("\n");
  const lines = Math.max(1, spec.lines || 1, rows.length);
  const perLine = Math.max(1, rows.length > 1 ? Math.max(...rows.map((r) => r.length)) : Math.ceil(text.length / lines));
  const size = `min(${(h / (lines * LINE_EM)).toFixed(2)}cqh, ${(w / (perLine * GLYPH_EM)).toFixed(2)}cqw)`;
  const { palette, font } = Design;
  return (
    <div data-part="Heading" style={{ position: "absolute", left: `${x}cqw`, top: `${y}cqh`, width: `${w}cqw`, height: `${h}cqh`,
      display: "flex", alignItems: "center", justifyContent: "center", opacity: Math.min(enter, leave), transform: `scale(${scale})` }}>
      <div style={{ fontFamily: font, fontWeight: 800, fontSize: size, lineHeight: LINE_EM, textAlign: "center", whiteSpace: "pre-line",
        color: palette[spec.color] || palette.fg, background: spec.plate ? palette.plate : "none",
        padding: spec.plate ? "0.4cqh 1.2cqw" : 0, borderRadius: "0.8cqh", textShadow: spec.plate ? "none" : `0 0.3cqh 1cqh ${palette.shadow}` }}>
        {text}
      </div>
    </div>
  );
}

export function __NAME__({ t, duration, Design, texts, ...media }) {
  const items = texts || [];
  return (
    <div style={{ position: "absolute", inset: 0, containerType: "size", overflow: "hidden", background: Design.palette[LAYOUT.background] || Design.palette.bg }}>
      {LAYOUT.layers.map((layer) => {
        const [x, y, w, h] = layer.box;
        // A cutout layer shows only its people; before the cutout exists it shows the whole clip.
        const content = (layer.cut && media[layer.cut]) || media[layer.key];
        return (
          <div key={layer.key} style={{ position: "absolute", left: `${x}cqw`, top: `${y}cqh`, width: `${w}cqw`, height: `${h}cqh`,
            overflow: "hidden", borderRadius: RADIUS[layer.shape] }}>
            {layer.code ? content : fill(content)}
          </div>
        );
      })}
      {LAYOUT.texts.map((spec, i) => <Text key={i} text={items[i]} spec={spec} t={t} duration={duration} Design={Design} />)}
    </div>
  );
}
