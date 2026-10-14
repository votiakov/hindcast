/** what the app shows when the engine (WebAssembly) cannot load: nothing else can run without it */
export function engineFailed(e: unknown) {
  return (
    <div style={{ fontFamily: 'ui-monospace, monospace', padding: 24, lineHeight: 1.5, color: '#c8d0d8', background: '#0b0e11', height: '100%', boxSizing: 'border-box' }}>
      <div>The Hindcast engine did not load: {e instanceof Error ? e.message : String(e)}</div>
      <div style={{ opacity: 0.7 }}>It runs as WebAssembly; a browser or host that blocks WebAssembly cannot run the app.</div>
    </div>
  );
}
