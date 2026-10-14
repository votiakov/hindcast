import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import './styles.css';
import App from './App';
import { loadNativeEngine } from './backtest/native';

// the compiled replay engine loads in the background; replays use the TypeScript one until it has
void loadNativeEngine();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
