import { useEffect, useState } from 'react';
import type { HealthResponse } from '@rode/protocol';

/**
 * Phase 0 placeholder. The real Watch screen arrives in phase 6; this exists
 * so the build, dev proxy and health wiring are exercised from day one.
 */
export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/healthz')
      .then((r) =>
        r.ok ? (r.json() as Promise<HealthResponse>) : Promise.reject(new Error(r.statusText)),
      )
      .then((h) => {
        if (!cancelled) setHealth(h);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="shell">
      <h1>Rode</h1>
      <p className="tagline">Anchor watch and boat monitor</p>
      <p className="status" aria-live="polite">
        {health ? `server ${health.version} · up ${Math.round(health.uptimeMs / 1000)} s` : null}
        {error ? `server unreachable: ${error}` : null}
        {!health && !error ? 'connecting…' : null}
      </p>
    </main>
  );
}
