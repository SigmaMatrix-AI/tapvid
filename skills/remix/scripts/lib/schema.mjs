// A small JSON Schema validator covering the subset the plugin's schemas use: type (single or
// list), enum, const, required, properties, additionalProperties (boolean or schema), items,
// minItems / maxItems, minimum / maximum, minLength / maxLength, pattern, oneOf, anyOf and
// local $ref ("#/$defs/<name>"). No dependencies, so providers and scripts can share it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ASSETS_DIR } from './common.mjs';

const typeOf = (v) => {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
};

const matchesType = (v, t) => {
  const actual = typeOf(v);
  return actual === t || (t === 'number' && actual === 'integer');
};

export function validate(schema, value, root = schema, path = '$') {
  const errors = [];
  const push = (msg) => errors.push(`${path}: ${msg}`);
  if (schema === true || schema === undefined) return errors;
  if (schema === false) return [`${path}: not allowed`];
  if (schema.$ref) {
    const name = schema.$ref.replace(/^#\/\$defs\//, '');
    const target = root.$defs?.[name];
    if (!target) return [`${path}: unknown $ref ${schema.$ref}`];
    return validate(target, value, root, path);
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) {
      push(`expected ${types.join(' | ')}, got ${typeOf(value)}`);
      return errors;
    }
  }
  if (schema.const !== undefined && value !== schema.const) push(`must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) push(`must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`);
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) push(`shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) push(`longer than ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) push(`does not match ${schema.pattern}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) push(`below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) push(`above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) push(`fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) push(`more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, i) => errors.push(...validate(schema.items, item, root, `${path}[${i}]`)));
  }
  if (typeOf(value) === 'object') {
    for (const key of schema.required || []) if (value[key] === undefined) push(`missing required "${key}"`);
    const props = schema.properties || {};
    for (const [key, v] of Object.entries(value)) {
      if (props[key]) errors.push(...validate(props[key], v, root, `${path}.${key}`));
      else if (schema.additionalProperties === false) push(`unexpected property "${key}"`);
      else if (typeof schema.additionalProperties === 'object') {
        errors.push(...validate(schema.additionalProperties, v, root, `${path}.${key}`));
      }
    }
  }
  if (schema.oneOf) {
    const ok = schema.oneOf.filter((s) => validate(s, value, root, path).length === 0).length;
    if (ok !== 1) push(`must match exactly one of ${schema.oneOf.length} alternatives (matched ${ok})`);
  }
  if (schema.anyOf && !schema.anyOf.some((s) => validate(s, value, root, path).length === 0)) {
    push('must match at least one alternative');
  }
  return errors;
}

const cache = new Map();

export function loadSchema(name) {
  if (!cache.has(name)) cache.set(name, JSON.parse(readFileSync(join(ASSETS_DIR, 'schemas', `${name}.json`), 'utf-8')));
  return cache.get(name);
}

// Validate against a named schema under schemas/ ("replica", "capabilities/video.generate", …).
// For a capability schema, `part` picks its "params" or "result" definition.
export function check(name, value, part) {
  const schema = loadSchema(name);
  const target = part ? schema.$defs?.[part] ?? schema.properties?.[part] : schema;
  if (!target) throw new Error(`schema ${name} has no ${part}`);
  return validate(target, value, schema);
}
