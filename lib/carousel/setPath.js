// Immutable set by dotted path: setPath(obj, "logo.size", 80)
export function setPath(obj, path, value) {
  const out = structuredClone(obj);
  const keys = path.split(".");
  let o = out;
  keys.slice(0, -1).forEach((k) => { if (typeof o[k] !== "object" || o[k] === null) o[k] = {}; o = o[k]; });
  o[keys.at(-1)] = value;
  return out;
}
