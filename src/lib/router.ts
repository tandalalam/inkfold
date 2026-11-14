import { useSyncExternalStore } from 'react';

export type Route = { name: 'library'; folderId: string | null } | { name: 'notebook'; id: string };

function parse(hash: string): Route {
  const m = hash.match(/^#\/(f|nb)\/([^/?#]+)/);
  if (m?.[1] === 'nb') return { name: 'notebook', id: decodeURIComponent(m[2]) };
  if (m?.[1] === 'f') return { name: 'library', folderId: decodeURIComponent(m[2]) };
  return { name: 'library', folderId: null };
}

let current = parse(location.hash);
const listeners = new Set<() => void>();
window.addEventListener('hashchange', () => {
  current = parse(location.hash);
  listeners.forEach((l) => l());
});

export function useRoute(): Route {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => current,
  );
}

export function navigate(route: Route, replace = false) {
  const hash = route.name === 'notebook' ? `#/nb/${encodeURIComponent(route.id)}` : route.folderId ? `#/f/${encodeURIComponent(route.folderId)}` : '#/';
  if (replace) history.replaceState(null, '', hash);
  else history.pushState(null, '', hash);
  current = parse(hash);
  listeners.forEach((l) => l());
}
