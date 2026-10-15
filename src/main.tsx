import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import './styles.css';
import App from './App';
import { loadEngine } from './backtest/native';
import { engineFailed } from './engineFailed';
import { Crashed } from './ui/Crashed';

// every number the app shows comes from the engine (WebAssembly): it loads before the first render
const root = createRoot(document.getElementById('root')!);
loadEngine().then(
  () =>
    root.render(
      <StrictMode>
        <Crashed>
          <App />
        </Crashed>
      </StrictMode>,
    ),
  (e: unknown) => root.render(engineFailed(e)),
);
