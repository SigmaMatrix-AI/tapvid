// In-page side of capture.mjs record, installed with context.addInitScript so it runs before the
// first paint of every document: a drawn cursor (headless Chromium paints none) that follows
// mousemove with a ripple on mousedown, the storyboard's `fake` text swaps (kept up by a
// MutationObserver) and `mask` blurs, plus the flash marker that aligns the action log with the video.

// "/pattern/flags" is a regular expression, anything else a literal string.
export function parseFake(rules = []) {
  return rules.map(({ find, replace }) => {
    if (typeof find !== 'string' || !find || typeof replace !== 'string') throw new Error('fake: each rule needs a non-empty "find" and a "replace" string');
    const m = find.match(/^\/(.+)\/([a-z]*)$/s);
    if (!m) return { text: find, replace };
    const flags = m[2].includes('g') ? m[2] : `${m[2]}g`;
    new RegExp(m[1], flags); // throws on a bad pattern before the browser starts
    return { source: m[1], flags, replace };
  });
}

// Runs in the page (serialised by Playwright): everything it needs comes in `config`.
export function installCapturePage({ fake, mask, cursorId, rippleMs }) {
  const rules = fake.map((r) => (r.text !== undefined ? r : { ...r, re: new RegExp(r.source, r.flags) }));
  const swap = (s) => rules.reduce((acc, r) => (r.re ? acc.replace(r.re, r.replace) : acc.split(r.text).join(r.replace)), s);
  const fixText = (node) => {
    const next = swap(node.nodeValue);
    if (next !== node.nodeValue) node.nodeValue = next;
  };
  const fixValue = (el) => {
    if (el === document.activeElement || el.type === 'password') return;
    const next = swap(el.value);
    if (next !== el.value) el.value = next;
  };
  const fixTree = (root) => {
    if (root.nodeType === Node.TEXT_NODE) return fixText(root);
    if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) fixText(n);
    const fields = root.matches?.('input, textarea') ? [root] : [];
    for (const el of [...fields, ...root.querySelectorAll('input, textarea')]) fixValue(el);
  };
  if (rules.length) {
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'characterData') fixText(r.target);
        else if (r.type === 'attributes') { if (r.target.matches('input, textarea')) fixValue(r.target); }
        else r.addedNodes.forEach(fixTree);
      }
    }).observe(document, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['value'] });
    document.addEventListener('DOMContentLoaded', () => fixTree(document), { once: true });
  }

  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`${mask.length ? `${mask.join(', ')} { filter: blur(12px) !important; }` : ''}
#${cursorId} { position: fixed; left: 0; top: 0; width: 24px; height: 24px; margin: -2px 0 0 -3px; z-index: 2147483647;
  pointer-events: none; display: none; will-change: transform; }
.${cursorId}-ripple { position: fixed; width: 36px; height: 36px; margin: -18px 0 0 -18px; border-radius: 50%; z-index: 2147483646;
  pointer-events: none; background: rgba(40, 120, 255, 0.35); border: 2px solid rgba(40, 120, 255, 0.8);
  animation: ${cursorId}-ripple ${rippleMs}ms ease-out forwards; }
@keyframes ${cursorId}-ripple { from { transform: scale(0.3); opacity: 1; } to { transform: scale(1.4); opacity: 0; } }`);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];

  const cursor = () => {
    let el = document.getElementById(cursorId);
    if (!el && document.documentElement) {
      el = document.createElement('div');
      el.id = cursorId;
      el.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M3 2 L3 19 L7.5 14.8 L10.6 21.6 L13.6 20.3 L10.6 13.6 L16.8 13.6 Z" fill="#111" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>';
      document.documentElement.appendChild(el);
    }
    return el;
  };
  addEventListener('mousemove', (e) => {
    const el = cursor();
    if (!el) return;
    el.style.display = 'block';
    el.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
  }, true);
  addEventListener('mousedown', (e) => {
    if (!document.documentElement) return;
    const ring = document.createElement('div');
    ring.className = `${cursorId}-ripple`;
    ring.style.left = `${e.clientX}px`;
    ring.style.top = `${e.clientY}px`;
    document.documentElement.appendChild(ring);
    setTimeout(() => ring.remove(), rippleMs + 50);
  }, true);
}

// Runs in the page: a full-viewport white marker with a black centre square for at least
// `durationMs` on the black start page; resolves the wall-clock ms at which it entered the
// DOM, from a task like any page update, so it reaches the video the way the page's changes do.
export function flashMarker(durationMs) {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;inset:0;background:#fff;z-index:2147483647;display:flex;align-items:center;justify-content:center';
    el.innerHTML = '<div style="width:33vh;height:33vh;background:#000"></div>';
    let shown = 0;
    const tick = () => {
      if (performance.timeOrigin + performance.now() - shown < durationMs) return requestAnimationFrame(tick);
      el.remove();
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(shown)));
    };
    setTimeout(() => {
      document.body.appendChild(el);
      shown = performance.timeOrigin + performance.now();
      requestAnimationFrame(tick);
    }, 0);
  });
}

// Runs in the page: smooth scroll of `target` (an element, scrolled to the middle of its nearest
// scrollable ancestor) or of the page to `y`, eased in and out over `ms`; resolves when done.
export function smoothScroll(el, { y, ms }) {
  const scrollable = (n) => {
    for (let p = n?.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
      const o = getComputedStyle(p).overflowY;
      if ((o === 'auto' || o === 'scroll') && p.scrollHeight > p.clientHeight) return p;
    }
    return document.scrollingElement || document.documentElement;
  };
  const box = scrollable(el);
  const isPage = box === document.scrollingElement || box === document.documentElement;
  const view = isPage ? innerHeight : box.clientHeight;
  const from = box.scrollTop;
  let to = y;
  if (el) {
    const r = el.getBoundingClientRect();
    const top = isPage ? 0 : box.getBoundingClientRect().top;
    to = from + (r.top - top) - (view - r.height) / 2;
  }
  to = Math.max(0, Math.min(box.scrollHeight - view, to));
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
  return new Promise((resolve) => {
    const t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / ms);
      box.scrollTop = from + (to - from) * ease(k);
      if (k < 1) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
}
