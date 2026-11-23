import { useEffect, useState } from 'react';

type Render = (src: string) => string;
let renderer: Render | null = null;
let loading: Promise<Render> | null = null;

function loadRenderer(): Promise<Render> {
  if (renderer) return Promise.resolve(renderer);
  loading ??= import('./rich').then((m) => (renderer = m.renderRich));
  return loading;
}

/** Markdown + LaTeX (KaTeX). Shows plain text until the renderer has loaded. */
export function Rich({ text, className = '' }: { text: string; className?: string }) {
  const [render, setRender] = useState<Render | null>(() => renderer);
  useEffect(() => {
    if (!render) void loadRenderer().then((r) => setRender(() => r));
  }, [render]);
  if (!render) return <div className={`rich plain ${className}`}>{text}</div>;
  let html: string;
  try {
    html = render(text);
  } catch {
    return <div className={`rich plain ${className}`}>{text}</div>;
  }
  return <div className={`rich ${className}`} dir="auto" dangerouslySetInnerHTML={{ __html: html }} />;
}
