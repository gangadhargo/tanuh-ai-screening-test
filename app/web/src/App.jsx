import { useEffect, useState } from 'react';
import { pickText } from '@screening/engine';
import { fetchWorkflowXml, listWorkflows } from './api.js';
import { Runner } from './runner.jsx';
import { parseValidatedWorkflow } from './workflow.js';

export function App() {
  const [state, setState] = useState({ t: 'loading' });

  async function loadList() {
    setState({ t: 'loading' });
    try {
      setState({ t: 'list', items: await listWorkflows() });
    } catch {
      setState({ t: 'error', message: 'Could not load the screening list. Check the connection and try again.' });
    }
  }

  useEffect(() => {
    void loadList();
  }, []);

  async function open(id) {
    setState({ t: 'loading' });
    try {
      // Fetch once per encounter, then validate and render locally.
      const workflow = parseValidatedWorkflow(await fetchWorkflowXml(id));
      setState({ t: 'running', workflow });
    } catch {
      setState({ t: 'error', message: 'Could not open this screening. Check the connection and try again.' });
    }
  }

  if (state.t === 'loading') {
    return <main className="page center"><div className="spinner" aria-hidden="true" /><p>Loading…</p></main>;
  }

  if (state.t === 'error') {
    return (
      <main className="page center" role="alert">
        <p>{state.message}</p>
        <button type="button" className="primary" onClick={() => void loadList()}>Try again</button>
      </main>
    );
  }

  if (state.t === 'running') {
    return <main className="page"><Runner workflow={state.workflow} onExit={() => void loadList()} /></main>;
  }

  return (
    <main className="page">
      <header className="home-header">
        <h1>Screenings</h1>
        <p className="help">Choose the screening to run with this person.</p>
      </header>
      {state.items.length === 0 && <p role="alert">No screenings are available right now.</p>}
      <ul className="workflow-list">
        {state.items.map((workflow) => (
          <li key={workflow.id}>
            <button type="button" className="workflow-card" onClick={() => void open(workflow.id)}>
              <span className="workflow-title">{pickText(workflow.title)}</span>
              {workflow.description && <span className="workflow-desc">{pickText(workflow.description)}</span>}
              <span className="workflow-meta">v{workflow.version} · {workflow.availableLanguages.join(', ')}</span>
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}
