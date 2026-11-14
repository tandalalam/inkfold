import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import { useEditor } from './editor/store';
import { useLibrary } from './lib/library';

// Handle for automated tests and debugging from the console.
(window as unknown as Record<string, unknown>).__inkfold = { useEditor, useLibrary };

// Block Safari's page-level pinch zoom; the editor implements its own zoom.
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
}

createRoot(document.getElementById('root')!).render(<App />);
