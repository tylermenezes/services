export function dedupe(arr: Iterable<string>): string[] {
  return [...new Set(arr)];
}