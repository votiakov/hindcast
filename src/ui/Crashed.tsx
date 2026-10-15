import { Component, type ReactNode } from 'react';

/** a render error anywhere would otherwise leave a blank page: say what broke and offer a way back */
export class Crashed extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error('[hindcast] view crashed', error);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const reopen = (hash: string) => {
      location.hash = hash;
      location.reload();
    };
    return (
      <div className="crashed">
        <div className="crashed-title">This view crashed</div>
        <pre className="crashed-msg">{String(error.message || error)}</pre>
        <p>Your saved designs and lesson progress are kept in this browser. Reload this view, or go back to Live.</p>
        <div className="crashed-actions">
          <button className="btn primary" onClick={() => location.reload()}>
            Reload
          </button>
          <button className="btn" onClick={() => reopen('#live')}>
            Open Live
          </button>
        </div>
      </div>
    );
  }
}
