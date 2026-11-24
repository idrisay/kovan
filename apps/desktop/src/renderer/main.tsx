import './renamedKeys';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary, installErrorReporting } from './ErrorBoundary';
import { restoreSidebarWidth } from './Resizer';
import { restoreReadingSize } from './readingSize';
import { installZoomRouting } from './zoomTarget';
import './styles.css';

// Before the first render, so the sidebar never paints at the default width
// and then jumps to the remembered one.
restoreSidebarWidth();
restoreReadingSize();
installZoomRouting();
installErrorReporting();

// The title bar and shortcut labels differ on Linux; see platform.ts.
document.documentElement.dataset['platform'] = window.kovan.platform;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* The last resort: a pane's own boundary should catch first. */}
    <ErrorBoundary where="the window" whole>
      <App />
    </ErrorBoundary>
  </StrictMode>
);
