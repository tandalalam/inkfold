import { useEffect, useLayoutEffect, useRef } from 'react';
import { ClipboardCopy, ExternalLink, Loader2, RotateCw, Send, Sparkles, Trash2, X } from 'lucide-react';
import type { AskRecord } from '../lib/types';
import { navigate } from '../lib/router';
import { toast } from '../ui/overlay';
import { useAsk, sendAsk, retryAsk, deleteAsk, removeTrayClip, revealClip, isPending, probeAsk } from './store';
import { Rich } from './Rich';

const QUICK = ['What is this?', 'Explain step by step', 'Why does this hold?', 'Give a small example', 'Is my note correct?'];

function timeLabel(t: number) {
  const d = new Date(t);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function Status({ a }: { a: AskRecord }) {
  const busy = useAsk((s) => s.thread?.busy);
  if (a.status === 'completed') return a.answer ? <Rich text={a.answer} className="answer" /> : <p className="ask-muted">(empty reply)</p>;
  if (a.status === 'failed')
    return (
      <div className="ask-error">
        <span>{a.error || 'Something went wrong.'}</span>
        <button className="btn small" onClick={() => void retryAsk(a.id)}>
          <RotateCw size={14} /> Retry
        </button>
      </div>
    );
  const label =
    a.status === 'sending'
      ? 'Sending…'
      : a.status === 'queued' || (a.status !== 'running' && busy)
        ? 'Queued: the thread is finishing another task'
        : a.status === 'recovering'
          ? 'Reconnecting…'
          : 'Thinking…';
  const last = a.progress?.[a.progress.length - 1];
  return (
    <div className="ask-pending">
      <div className="ask-muted">
        <Loader2 size={14} className="spin" /> {label}
      </div>
      {last && <Rich text={last} className="progress" />}
    </div>
  );
}

function AskCard({ a, notebookId, focused }: { a: AskRecord; notebookId: string; focused: boolean }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [focused]);
  const here = a.notebookId === notebookId;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(a.answer ?? '');
      toast('Answer copied');
    } catch {
      toast('Could not copy', true);
    }
  };
  return (
    <article ref={ref} className={`ask-card ${focused ? 'focused' : ''}`} data-ask-id={a.id}>
      {a.clips.length > 0 && (
        <div className="clip-row">
          {a.clips.map((c, i) => (
            <button
              key={i}
              className="clip-thumb"
              title={`Page ${c.pageIndex + 1}`}
              onClick={() => (here ? revealClip(c) : navigate({ name: 'notebook', id: a.notebookId }))}
            >
              <img src={c.thumb} alt={`Selection ${i + 1}`} />
              <span className="clip-n">{i + 1}</span>
            </button>
          ))}
        </div>
      )}
      {!here && <div className="ask-from">From “{a.notebookTitle}”</div>}
      {a.question && (
        <p className="ask-q" dir="auto">
          {a.question}
        </p>
      )}
      <Status a={a} />
      <footer className="ask-foot">
        <span>
          {timeLabel(a.createdAt)}
          {a.detail === 'long' ? ' · detailed' : ''}
        </span>
        <span className="spacer" />
        {a.status === 'completed' && (
          <button className="icon-btn small" onClick={copy} aria-label="Copy answer">
            <ClipboardCopy size={15} />
          </button>
        )}
        {!isPending(a) && (
          <button className="icon-btn small" onClick={() => deleteAsk(a.id)} aria-label="Remove from list">
            <Trash2 size={15} />
          </button>
        )}
      </footer>
    </article>
  );
}

function Composer() {
  const tray = useAsk((s) => s.tray);
  const draft = useAsk((s) => s.draft);
  const detail = useAsk((s) => s.detail);
  const set = useAsk((s) => s.set);
  const area = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(160, el.scrollHeight) + 'px';
  }, [draft]);
  const canSend = draft.trim().length > 0 || tray.length > 0;
  return (
    <div className="ask-composer">
      {tray.length > 0 ? (
        <div className="tray">
          {tray.map((c, i) => (
            <div key={i} className="tray-clip">
              <img src={c.thumb} alt={`Selection ${i + 1}`} />
              <span className="clip-n">{i + 1}</span>
              <button className="tray-x" onClick={() => removeTrayClip(i)} aria-label={`Remove selection ${i + 1}`}>
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="composer-hint">
          Circle anything with the lasso, then tap <Sparkles size={13} /> Ask to attach it. Circle more to ask about several at once.
        </p>
      )}
      <textarea
        ref={area}
        className="ask-input"
        dir="auto"
        rows={2}
        placeholder={tray.length ? 'Ask about the selection… (you can write with the Pencil here)' : 'Ask a question…'}
        value={draft}
        onChange={(e) => set({ draft: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canSend) {
            e.preventDefault();
            void sendAsk();
          }
        }}
      />
      <div className="quick-row">
        {QUICK.map((q) => (
          <button key={q} className="chip" onClick={() => set({ draft: draft.trim() ? `${draft.trim()} ${q}` : q })}>
            {q}
          </button>
        ))}
      </div>
      <div className="composer-actions">
        <div className="seg small">
          <button className={detail === 'short' ? 'active' : ''} onClick={() => set({ detail: 'short' })}>
            Brief
          </button>
          <button className={detail === 'long' ? 'active' : ''} onClick={() => set({ detail: 'long' })}>
            Detailed
          </button>
        </div>
        <span className="spacer" />
        <button className="btn btn-primary send-btn" disabled={!canSend} onClick={() => void sendAsk()}>
          <Send size={16} /> Send
        </button>
      </div>
    </div>
  );
}

export function AskPanel({ notebookId }: { notebookId: string }) {
  const asks = useAsk((s) => s.asks);
  const thread = useAsk((s) => s.thread);
  const focusId = useAsk((s) => s.focusId);
  const scope = useAsk((s) => s.scope);
  const set = useAsk((s) => s.set);
  const list = scope === 'notebook' ? asks.filter((a) => a.notebookId === notebookId) : asks;
  const listRef = useRef<HTMLDivElement>(null);
  const count = list.length;
  useEffect(() => {
    void probeAsk(true);
  }, []);
  // New asks appear at the bottom: keep it in view.
  useEffect(() => {
    const el = listRef.current;
    if (el && !focusId) el.scrollTop = el.scrollHeight;
  }, [count]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <aside className="ask-panel" aria-label="Ask">
      <header className="ask-head">
        <Sparkles size={18} className="ask-icon" />
        <div className="ask-title">
          <b>Ask</b>
          <span title={thread?.title}>{thread?.title ?? 'Research thread'}</span>
        </div>
        {thread?.busy && <span className="busy-pill">busy</span>}
        {thread?.link && (
          <a className="icon-btn" href={thread.link} target="_blank" rel="noopener noreferrer" aria-label="Open the thread in T3">
            <ExternalLink size={17} />
          </a>
        )}
        <button className="icon-btn" onClick={() => set({ panelOpen: false })} aria-label="Close">
          <X size={19} />
        </button>
      </header>
      <div className="ask-scope">
        <div className="seg small">
          <button className={scope === 'notebook' ? 'active' : ''} onClick={() => set({ scope: 'notebook' })}>
            This notebook
          </button>
          <button className={scope === 'all' ? 'active' : ''} onClick={() => set({ scope: 'all' })}>
            All
          </button>
        </div>
      </div>
      <div className="ask-list" ref={listRef}>
        {list.length === 0 && (
          <div className="ask-empty">
            <Sparkles size={26} />
            <p>
              Questions go to your thread <b>{thread?.title ?? ''}</b>, so it remembers the whole conversation. Answers show up here, with math
              typeset.
            </p>
          </div>
        )}
        {list.map((a) => (
          <AskCard key={a.id} a={a} notebookId={notebookId} focused={a.id === focusId} />
        ))}
      </div>
      <Composer />
    </aside>
  );
}
