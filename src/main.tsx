import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './ui/App';
import {useStudio} from './state/store';
import './ui/styles.css';

// Dev affordance: drive the studio from the console — window.studio.getState().
if (import.meta.env.DEV) (window as unknown as {studio?: unknown}).studio = useStudio;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
