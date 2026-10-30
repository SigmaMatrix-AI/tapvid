// Walking a board's schema.fields: field at a dotted path, narration segments, media slots.
const INDEX = /^(0|[1-9]\d{0,3})$/;

// The field a dotted path names (`cover`, `steps.2.screen`, `hero.logo`), through object groups
// and object[] items; null when the path leads nowhere.
export function fieldAt(fields, path) {
  const parts = path.split('.');
  let list = fields;
  for (let i = 0; i < parts.length; i++) {
    const f = (list || []).find((x) => x?.key === parts[i]);
    if (!f) return null;
    if (i === parts.length - 1) return f;
    if (f.type === 'object[]') {
      i++;
      if (i === parts.length - 1 || !INDEX.test(parts[i])) return null;
    } else if (f.type !== 'object') return null;
    list = f.fields;
  }
  return null;
}

// A board that speaks its own narration fields, at the top or inside an object[].
export function isSegmented(fields) {
  return (fields || []).some((f) => f?.type === 'narration' || (f?.type === 'object[]' && isSegmented(f.fields)));
}

// [key, line] of every narration line in speaking order: schema order, object[] item by item.
export function boardSegments(fields, data, prefix = '') {
  const out = [];
  for (const f of fields || []) {
    const value = data?.[f.key];
    if (f.type === 'narration' && String(value ?? '').trim()) out.push([`${prefix}${f.key}`, String(value).trim()]);
    else if (f.type === 'object[]' && Array.isArray(value)) {
      value.forEach((item, i) => { if (item && typeof item === 'object') out.push(...boardSegments(f.fields, item, `${prefix}${f.key}.${i}.`)); });
    }
  }
  return out;
}
