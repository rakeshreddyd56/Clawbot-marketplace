import type { ReactNode } from 'react';
import { TopNav } from './nav';

export function ConsoleShell(props: { title: string; subtitle: string; children: ReactNode; rail?: ReactNode }) {
  return (
    <main id="main-content">
      <header className="header">
        <div>
          <h1 className="page-title">{props.title}</h1>
          <p className="page-subtitle">{props.subtitle}</p>
        </div>
        <TopNav />
      </header>
      <section className="console-layout">
        <div className="console-main">{props.children}</div>
        {props.rail ? (
          <aside className="console-rail" aria-label="Evidence panel">
            {props.rail}
          </aside>
        ) : null}
      </section>
    </main>
  );
}
