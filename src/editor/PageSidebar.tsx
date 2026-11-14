import { memo, useEffect, useRef, useState } from 'react';
import { MoreHorizontal, Plus } from 'lucide-react';
import type { Page } from '../lib/types';
import { renderThumbnail } from '../lib/thumbnails';
import { useEditor } from './store';

const thumbCache = new Map<string, { page: Page; url: string }>();

// Render thumbnails one at a time so the editor stays responsive.
let chain: Promise<unknown> = Promise.resolve();
function queueThumb(page: Page): Promise<string> {
  const p = chain.then(() => renderThumbnail(page, 120));
  chain = p.catch(() => {});
  return p;
}

const Thumb = memo(function Thumb({ pageId }: { pageId: string }) {
  const page = useEditor((s) => s.pages[pageId]);
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [url, setUrl] = useState(() => thumbCache.get(pageId)?.url ?? '');

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { rootMargin: '300px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || !page) return;
    const cached = thumbCache.get(pageId);
    if (cached?.page === page) {
      setUrl(cached.url);
      return;
    }
    let cancelled = false;
    const t = setTimeout(
      () => {
        queueThumb(page).then((u) => {
          thumbCache.set(pageId, { page, url: u });
          if (!cancelled) setUrl(u);
        });
      },
      cached ? 600 : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [visible, page, pageId]);

  if (!page) return null;
  return (
    <div ref={ref} className="thumb" style={{ aspectRatio: `${page.width} / ${page.height}` }}>
      {url && <img src={url} alt="" draggable={false} />}
    </div>
  );
});

export function PageSidebar({ onPageMenu, onAddPage }: { onPageMenu: (index: number, anchor: HTMLElement) => void; onAddPage: (anchor: HTMLElement) => void }) {
  const order = useEditor((s) => s.order);
  const current = useEditor((s) => s.currentPage);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-thumb-index="${current}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  return (
    <aside className="page-sidebar" ref={listRef}>
      {order.map((id, i) => (
        <div key={id} className={`thumb-item ${i === current ? 'current' : ''}`} data-thumb-index={i}>
          <button className="thumb-btn" onClick={() => useEditor.getState().scrollToPage(i)} aria-label={`Go to page ${i + 1}`}>
            <Thumb pageId={id} />
          </button>
          <div className="thumb-footer">
            <span>{i + 1}</span>
            <button className="icon-btn tiny" onClick={(e) => onPageMenu(i, e.currentTarget)} aria-label={`Page ${i + 1} options`}>
              <MoreHorizontal size={16} />
            </button>
          </div>
        </div>
      ))}
      <button className="add-page-tile" onClick={(e) => onAddPage(e.currentTarget)}>
        <Plus size={20} />
        <span>Add page</span>
      </button>
    </aside>
  );
}
