/** Object-key order is not event identity; array order and string bytes are. */
export function stableJson(value: unknown): string {
  let normalized: unknown;
  try { normalized = JSON.parse(JSON.stringify(value)); }
  catch { throw new Error('事件数据格式无效'); }
  return JSON.stringify(normalized, (_key, item: unknown) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
    }
    return item;
  });
}
