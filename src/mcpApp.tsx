import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App as McpApp } from '@modelcontextprotocol/ext-apps';
import '@xyflow/react/dist/style.css';
import './styles.css';
import App from './App';
import { openPayload, type ComparePayload } from './spec/links';
import { useSim } from './sim/store';

/**
 * MCP Apps entry: the full Bottleneck app, rendered inline by MCP hosts (Claude, ChatGPT, …).
 * The `show_architecture` tool's structured result is opened as a sandbox or comparison and
 * starts playing immediately.
 */
const bridge = new McpApp({ name: 'Hindcast', version: '0.1.0' });

bridge.ontoolresult = (result) => {
  const p = result.structuredContent as { spec?: unknown; compare?: ComparePayload } | undefined;
  if (!p) return;
  if (openPayload(p)) useSim.getState().setRunning(true);
};
bridge.onhostcontextchanged = (ctx) => {
  const theme = (ctx as { theme?: string }).theme;
  if (theme === 'light') useSim.getState().setSetting('theme', 'reference');
};
bridge.connect();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
