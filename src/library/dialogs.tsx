import { useState } from 'react';
import { ChevronRight, Folder as FolderIcon, Library } from 'lucide-react';
import { Modal, showDialog } from '../ui/overlay';
import { useLibrary, descendantFolderIds } from '../lib/library';
import type { Folder, Paper, PaperSizeKey, Template } from '../lib/types';
import { PAPER_SIZES } from '../lib/types';
import { PAPER_COLORS, TEMPLATE_LABELS, templateGeometry } from '../lib/templates';

function TemplatePreview({ template, paper }: { template: Template; paper: Paper }) {
  const W = 595, H = 793;
  const g = templateGeometry(template, W, H);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="tpl-preview">
      <rect width={W} height={H} fill={PAPER_COLORS[paper]} />
      {g.lines.map((l, i) => (
        <line key={i} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} stroke={l.color} strokeWidth={1} vectorEffect="non-scaling-stroke" />
      ))}
      {g.dots.map((d, i) => (
        <circle key={i} cx={d.x} cy={d.y} r={3.5} fill={d.color} />
      ))}
    </svg>
  );
}

export function openNewNotebookDialog(folderId: string | null, onCreated: (id: string) => void) {
  showDialog((close) => <NewNotebookDialog folderId={folderId} close={close} onCreated={onCreated} />);
}

function NewNotebookDialog({ folderId, close, onCreated }: { folderId: string | null; close: () => void; onCreated: (id: string) => void }) {
  const [title, setTitle] = useState('');
  const [template, setTemplate] = useState<Template>(() => (localStorage.getItem('inkfold.lastTemplate') as Template) || 'lined');
  const [paper, setPaper] = useState<Paper>(() => (localStorage.getItem('inkfold.lastPaper') as Paper) || 'white');
  const [size, setSize] = useState<PaperSizeKey>(() => (localStorage.getItem('inkfold.lastSize') as PaperSizeKey) || 'a4-portrait');
  const create = async () => {
    localStorage.setItem('inkfold.lastTemplate', template);
    localStorage.setItem('inkfold.lastPaper', paper);
    localStorage.setItem('inkfold.lastSize', size);
    const nb = await useLibrary.getState().createNotebook({ title, folderId, template, paper, size });
    close();
    onCreated(nb.id);
  };
  return (
    <Modal title="New notebook" onClose={close} wide>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <input className="text-input" dir="auto" autoFocus placeholder="Untitled Notebook" value={title} onChange={(e) => setTitle(e.target.value)} />
        <div className="field-label">Paper</div>
        <div className="tpl-grid">
          {(Object.keys(TEMPLATE_LABELS) as Template[]).map((t) => (
            <button type="button" key={t} className={`tpl-option ${t === template ? 'active' : ''}`} onClick={() => setTemplate(t)}>
              <TemplatePreview template={t} paper={paper} />
              <span>{TEMPLATE_LABELS[t]}</span>
            </button>
          ))}
        </div>
        <div className="field-row">
          <div className="seg">
            {(['white', 'cream'] as Paper[]).map((p) => (
              <button type="button" key={p} className={p === paper ? 'active' : ''} onClick={() => setPaper(p)}>
                {p === 'white' ? 'White' : 'Cream'}
              </button>
            ))}
          </div>
          <select className="select" value={size} onChange={(e) => setSize(e.target.value as PaperSizeKey)}>
            {(Object.keys(PAPER_SIZES) as PaperSizeKey[]).map((k) => (
              <option key={k} value={k}>
                {PAPER_SIZES[k].label}
              </option>
            ))}
          </select>
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary">
            Create
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Folder picker. `excludeFolder` hides a folder and its subtree (can't move into itself). */
export function pickFolder(title: string, current: string | null, excludeFolder?: string): Promise<string | null | undefined> {
  return new Promise((resolve) =>
    showDialog((close) => (
      <FolderPicker
        title={title}
        current={current}
        exclude={excludeFolder}
        done={(v) => {
          close();
          resolve(v);
        }}
      />
    )),
  );
}

function FolderPicker({ title, current, exclude, done }: { title: string; current: string | null; exclude?: string; done: (v: string | null | undefined) => void }) {
  const folders = useLibrary((s) => s.folders);
  const [sel, setSel] = useState<string | null>(current);
  const hidden = new Set(exclude ? descendantFolderIds(folders, exclude) : []);
  const children = (parent: string | null) =>
    Object.values(folders)
      .filter((f) => f.parentId === parent && !hidden.has(f.id))
      .sort((a, b) => a.name.localeCompare(b.name));
  const renderTree = (parent: string | null, depth: number): React.ReactNode =>
    children(parent).map((f: Folder) => (
      <div key={f.id}>
        <button type="button" className={`picker-row ${sel === f.id ? 'active' : ''}`} style={{ paddingLeft: 12 + depth * 20 }} onClick={() => setSel(f.id)}>
          <FolderIcon size={18} />
          <span dir="auto">{f.name}</span>
        </button>
        {renderTree(f.id, depth + 1)}
      </div>
    ));
  return (
    <Modal title={title} onClose={() => done(undefined)}>
      <div className="picker">
        <button type="button" className={`picker-row ${sel === null ? 'active' : ''}`} onClick={() => setSel(null)}>
          <Library size={18} />
          <span>Library (top level)</span>
        </button>
        {renderTree(null, 1)}
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={() => done(undefined)}>
          Cancel
        </button>
        <button className="btn btn-primary" onClick={() => done(sel)}>
          Move here <ChevronRight size={16} />
        </button>
      </div>
    </Modal>
  );
}
