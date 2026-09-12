import { useEffect, useState } from 'react';
import type { ImagerySource } from '@rode/protocol';
import { api } from '../api/client.js';

/*
 * The "Background" dropdown on the Watch and Traffic screens. Sources are
 * configured on Settings › Imagery; the selection is a shared preference so
 * every device shows the same thing.
 */

let cached: ImagerySource[] | null = null;
const listeners = new Set<(s: ImagerySource[]) => void>();

async function load(): Promise<void> {
  try {
    const r = await api.get<{ sources: ImagerySource[] }>('/api/imagery');
    cached = r.sources;
    for (const l of listeners) l(r.sources);
  } catch {
    // Offline: whatever we had.
  }
}

/** Tell every open picker the list changed (after saving on the Imagery screen). */
export function refreshImagerySources(): void {
  void load();
}

export function useImagerySources(): ImagerySource[] {
  const [sources, setSources] = useState<ImagerySource[]>(cached ?? []);
  useEffect(() => {
    listeners.add(setSources);
    if (!cached) void load();
    return () => {
      listeners.delete(setSources);
    };
  }, []);
  return sources;
}

export function ImageryPicker(p: {
  sources: ImagerySource[];
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const usable = p.sources.filter((s) => s.enabled);
  if (usable.length === 0) return null;
  return (
    <label className="small imagery-pick">
      <span className="muted">Background</span>{' '}
      <select
        aria-label="Background imagery"
        value={p.value ?? ''}
        onChange={(e) => p.onChange(e.target.value === '' ? null : e.target.value)}
      >
        <option value="">None</option>
        {usable.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
    </label>
  );
}
