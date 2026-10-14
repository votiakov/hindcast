import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import './styles.css';
import App from './App';
import { loadEngine } from './backtest/native';
import { engineFailed } from './engineFailed';

// every number the app shows comes from the engine (WebAssembly): it loads before the first render
const root = createRoot(document.getElementById('root')!);
loadEngine().then(
  () =>
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    ),
  (e: unknown) => root.render(engineFailed(e)),
);
