import React from "react";

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const ease = (p) => 1 - Math.pow(1 - clamp(p, 0, 1), 3);

export function Points02({ t, duration, segments, Design, heading, points }) {
  const { palette, font, fontHead } = Design;
  const seg = (key) => (segments || []).find((s) => s.key === key);
  const items = points || [];
  return (
    <div style={{ position: "absolute", inset: 0, containerType: "size", background: palette.surface }}>
      <div style={{ position: "absolute", left: "8cqw", top: "12cqh", fontFamily: fontHead, fontSize: "6cqh", fontWeight: 700, color: palette.fg }}>{heading}</div>
      {items.map((it, i) => {
        const s = seg(`points.${i}.say`);
        const start = s ? s.start : (duration * i) / Math.max(1, items.length);
        const p = ease((t - start) / 0.4);
        return (
          <div key={i} style={{ position: "absolute", left: "8cqw", top: `${32 + i * (52 / Math.max(1, items.length))}cqh`, width: "84cqw", fontFamily: font, fontSize: "4.5cqh", color: palette.fg, opacity: p, transform: `translateX(${(1 - p) * 4}cqw)` }}>
            <span style={{ color: palette.primary, marginRight: "1.5cqw" }}>●</span>{it.label}
          </div>
        );
      })}
    </div>
  );
}
