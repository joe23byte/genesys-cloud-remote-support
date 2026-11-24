/**
 * sessionStorage with an in-memory fallback. Inside the Genesys Cloud iframe, storage
 * is partitioned or may be blocked (e.g. sandbox without allow-same-origin); the app
 * then still works for the lifetime of the page.
 */
const memory = new Map<string, string>();

function storage(): Storage | null {
  try {
    const s = window.sessionStorage;
    const probe = '__rs_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

export function getItem(key: string): string | null {
  const s = storage();
  return s ? s.getItem(key) : (memory.get(key) ?? null);
}

export function setItem(key: string, value: string): void {
  const s = storage();
  if (s) s.setItem(key, value);
  else memory.set(key, value);
}

export function removeItem(key: string): void {
  const s = storage();
  if (s) s.removeItem(key);
  memory.delete(key);
}

export const isPersistentStorageAvailable = () => storage() !== null;
