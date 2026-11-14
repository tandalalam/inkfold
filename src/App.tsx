import { useEffect } from 'react';
import { useLibrary } from './lib/library';
import { useRoute } from './lib/router';
import { requestPersistence } from './lib/db';
import { LibraryView } from './library/LibraryView';
import { EditorView } from './editor/EditorView';
import { OverlayRoot } from './ui/overlay';

export function App() {
  const loaded = useLibrary((s) => s.loaded);
  const route = useRoute();

  useEffect(() => {
    useLibrary.getState().load();
    requestPersistence();
  }, []);

  return (
    <>
      {!loaded ? (
        <div className="splash">Loading…</div>
      ) : route.name === 'notebook' ? (
        <EditorView key={route.id} notebookId={route.id} />
      ) : (
        <LibraryView folderId={route.folderId} />
      )}
      <OverlayRoot />
    </>
  );
}
