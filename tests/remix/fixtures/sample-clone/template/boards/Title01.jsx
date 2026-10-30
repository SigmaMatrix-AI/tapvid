import React from "react";

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const ease = (p) => 1 - Math.pow(1 - clamp(p, 0, 1), 3);

export function Title01({ t, duration, Design, kicker, title, cover }) {
  const { palette, fontHead } = Design;
  const p = ease(t / (duration * 0.3));
  return (
    <div style={{ position: "absolute", inset: 0, containerType: "size", background: palette.bg, overflow: "hidden" }}>
      <div style={{ position: "absolute", left: "52cqw", top: "12cqh", width: "42cqw", height: "76cqh", borderRadius: "2cqh", overflow: "hidden", transform: `scale(${1.06 - 0.06 * p})` }}>
        {cover ? React.cloneElement(cover, { style: { width: "100%", height: "100%", objectFit: "cover" } }) : null}
      </div>
      <div style={{ position: "absolute", left: "6cqw", top: "34cqh", width: "42cqw", fontFamily: fontHead, color: palette.fg, opacity: p }}>
        <div style={{ fontSize: "3cqh", color: palette.accent, letterSpacing: "0.2em" }}>{kicker}</div>
        {(title || []).map((line, i) => (
          <div key={i} style={{ fontSize: "8cqh", fontWeight: 700, lineHeight: 1.1, textWrap: "balance" }}>{line}</div>
        ))}
      </div>
    </div>
  );
}
