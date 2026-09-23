import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { restoreSidebarWidth } from './Resizer';
import { restoreReadingSize } from './readingSize';
import { installZoomRouting } from './zoomTarget';
import './styles.css';

// Before the first render, so the sidebar never paints at the default width
// and then jumps to the remembered one.
restoreSidebarWidth();
restoreReadingSize();
installZoomRouting();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
