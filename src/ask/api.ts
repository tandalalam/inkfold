/**
 * Client for the private Inkfold bridge (server/bridge.mjs). The bridge is only
 * reachable on the owner's tailnet, so for everyone else the probe fails and the
 * Ask feature stays hidden.
 */
const DEFAULT_API = 'https://t3-edna-vps.tailc15cef.ts.net:8460/api/';

export function apiBase(): string {
  try {
    return localStorage.getItem('inkfold.askApi') || DEFAULT_API;
  } catch {
    return DEFAULT_API;
  }
}

export interface ThreadInfo {
  id: string;
  title?: string;
  status?: string;
  link?: string;
  busy?: boolean;
}

export interface RemoteAsk {
  askId: string;
  status: 'sending' | 'queued' | 'running' | 'recovering' | 'completed' | 'failed';
  progress: string[];
  answer: string | null;
  error: string | null;
}

export interface AskPayload {
  askId: string;
  question: string;
  detail: 'short' | 'long';
  context: { notebook: string };
  clips: { image: string; page: number | null; document: string; text: string }[];
}

async function call<T>(path: string, init: RequestInit = {}, timeoutMs = 10000): Promise<T> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(new URL(path, apiBase()), { ...init, signal: ctl.signal, cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    return data as T;
  } finally {
    clearTimeout(t);
  }
}

export const askApi = {
  status: () => call<{ ok: boolean; thread: ThreadInfo }>('status', {}, 6000),
  send: (body: AskPayload) =>
    call<{ ask: RemoteAsk; thread: ThreadInfo }>(
      'ask',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
      60000,
    ),
  poll: (ids: string[]) => call<{ asks: RemoteAsk[]; thread: ThreadInfo }>(`asks?ids=${ids.map(encodeURIComponent).join(',')}`),
};
