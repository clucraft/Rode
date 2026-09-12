import { useCallback, useEffect, useState } from 'react';
import type { ImagerySource, ImagerySourceInput, ImageryStatus } from '@rode/protocol';
import { api, errorMessage } from '../api/client.js';
import { useAuth } from '../api/auth.js';
import { usePrefs } from '../api/store.js';
import { refreshImagerySources } from '../components/ImageryPicker.jsx';
import { ConfirmDialog } from '../components/common.js';
import { fmtDuration } from '../lib/format.js';
import { Panel } from './Settings.jsx';

/*
 * Settings › Imagery. Up to five raster sources for the polar view's
 * background: MBTiles files on the box, or online satellite tiles the
 * server fetches and keeps. Nothing here changes what alarms; it changes
 * what the picture behind the circle looks like.
 */

interface Preset extends ImagerySourceInput {
  note: string;
}

interface Listing {
  sources: ImagerySource[];
  max: number;
  presets: Preset[];
}

type Draft = ImagerySourceInput & { id?: string | undefined };

export function Imagery() {
  const { user } = useAuth();
  const admin = user?.role === 'admin';
  const [prefs, setPrefs] = usePrefs();
  const [listing, setListing] = useState<Listing | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [files, setFiles] = useState<{ dir: string; files: { name: string; bytes: number }[] }>({
    dir: '',
    files: [],
  });
  const [status, setStatus] = useState<Record<string, ImageryStatus>>({});
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [removing, setRemoving] = useState<number | null>(null);

  const load = useCallback(async () => {
    const l = await api.get<Listing>('/api/imagery');
    setListing(l);
    setDrafts(l.sources.map((s) => ({ ...s })));
    setDirty(false);
    if (admin) {
      try {
        setFiles(await api.get<typeof files>('/api/imagery/files'));
      } catch {
        // crew cannot list files; fine
      }
    }
    const st: Record<string, ImageryStatus> = {};
    await Promise.all(
      l.sources.map(async (s) => {
        try {
          st[s.id] = await api.get<ImageryStatus>(`/api/imagery/${s.id}/status`);
        } catch {
          // shown as unknown
        }
      }),
    );
    setStatus(st);
  }, [admin]);

  useEffect(() => {
    load().catch((e: unknown) => setErr(errorMessage(e)));
  }, [load]);

  // Poll while a prefetch is running.
  const running = Object.values(status).some((s) => s.prefetch?.running);
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => {
      for (const s of listing?.sources ?? []) {
        if (status[s.id]?.prefetch?.running) {
          api
            .get<ImageryStatus>(`/api/imagery/${s.id}/status`)
            .then((st) => setStatus((prev) => ({ ...prev, [s.id]: st })))
            .catch(() => undefined);
        }
      }
    }, 2000);
    return () => window.clearInterval(t);
  }, [running, listing, status]);

  const update = (i: number, patch: Partial<Draft>) => {
    setDrafts((ds) => ds.map((d, j) => (j === i ? { ...d, ...patch } : d)));
    setDirty(true);
    setSaved(false);
  };

  const addPreset = (preset: Preset) => {
    const { note: _note, ...input } = preset;
    setDrafts((ds) => [...ds, { ...input }]);
    setDirty(true);
  };
  const addMbtiles = () => {
    setDrafts((ds) => [
      ...ds,
      {
        name: files.files[0]?.name.replace(/\.mbtiles$/i, '') ?? 'Local imagery',
        kind: 'mbtiles',
        path: files.files[0]?.name ?? '',
        minZoom: 0,
        maxZoom: 19,
        enabled: true,
      },
    ]);
    setDirty(true);
  };

  const save = async () => {
    setErr(null);
    try {
      const l = await api.put<Listing>('/api/imagery', drafts);
      setListing(l);
      setDrafts(l.sources.map((s) => ({ ...s })));
      setDirty(false);
      setSaved(true);
      refreshImagerySources();
      await load();
    } catch (e) {
      setErr(errorMessage(e));
    }
  };

  const prefetch = async (id: string) => {
    setErr(null);
    try {
      await api.post(`/api/imagery/${id}/prefetch`, { radius: 1500, minZoom: 13, maxZoom: 19 });
      const st = await api.get<ImageryStatus>(`/api/imagery/${id}/status`);
      setStatus((prev) => ({ ...prev, [id]: st }));
    } catch (e) {
      setErr(errorMessage(e));
    }
  };

  const max = listing?.max ?? 5;
  const full = drafts.length >= max;

  return (
    <Panel title="Imagery">
      <p className="muted small">
        Satellite or chart imagery drawn under the anchor view, so the circle sits on the actual
        reef and sand. Two kinds: an <strong>MBTiles</strong> file copied onto the box (works with
        no internet at all), or an <strong>online</strong> source the server fetches around the boat
        and keeps on disk, so what you have looked at stays available when the link drops. Up to{' '}
        {max} sources; pick the one to show from the Background menu on the Watch and Traffic
        screens.
      </p>
      <p className="muted small">
        Online sources are subject to their providers&apos; terms; Rode only fetches the tiles you
        look at or prefetch.
      </p>
      {err ? (
        <p className="error" role="alert">
          {err}
        </p>
      ) : null}

      {listing && listing.sources.length > 0 ? (
        <div className="field">
          <label htmlFor="img-active">Shown on Watch and Traffic</label>
          <select
            id="img-active"
            value={prefs.imagerySource ?? ''}
            onChange={(e) =>
              setPrefs({ imagerySource: e.target.value === '' ? null : e.target.value })
            }
          >
            <option value="">None (plain polar view)</option>
            {listing.sources
              .filter((s) => s.enabled)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </select>
        </div>
      ) : null}

      <ul className="imagery-list">
        {drafts.map((d, i) => {
          const st = d.id ? status[d.id] : undefined;
          return (
            <li key={d.id ?? `new-${String(i)}`} className="imagery-item">
              <div className="row">
                <div className="field" style={{ flex: 2 }}>
                  <label htmlFor={`im-name-${String(i)}`}>Name</label>
                  <input
                    id={`im-name-${String(i)}`}
                    type="text"
                    value={d.name}
                    disabled={!admin}
                    onChange={(e) => update(i, { name: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label>Kind</label>
                  <span className="pill">{d.kind === 'mbtiles' ? 'MBTiles file' : 'online'}</span>
                </div>
                <label className="checkbox" style={{ alignSelf: 'end' }}>
                  <input
                    type="checkbox"
                    checked={d.enabled}
                    disabled={!admin}
                    onChange={(e) => update(i, { enabled: e.target.checked })}
                  />{' '}
                  Enabled
                </label>
              </div>

              {d.kind === 'mbtiles' ? (
                <div className="field">
                  <label htmlFor={`im-path-${String(i)}`}>
                    File (in {files.dir || 'the MBTiles directory'})
                  </label>
                  {files.files.length > 0 ? (
                    <select
                      id={`im-path-${String(i)}`}
                      value={d.path ?? ''}
                      disabled={!admin}
                      onChange={(e) => update(i, { path: e.target.value })}
                    >
                      {!files.files.some((f) => f.name === d.path) ? (
                        <option value={d.path ?? ''}>
                          {d.path === undefined || d.path === '' ? '— choose —' : d.path}
                        </option>
                      ) : null}
                      {files.files.map((f) => (
                        <option key={f.name} value={f.name}>
                          {f.name} ({fmtBytes(f.bytes)})
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      id={`im-path-${String(i)}`}
                      type="text"
                      value={d.path ?? ''}
                      disabled={!admin}
                      placeholder="anchorage.mbtiles"
                      onChange={(e) => update(i, { path: e.target.value })}
                    />
                  )}
                </div>
              ) : (
                <>
                  <div className="field">
                    <label htmlFor={`im-url-${String(i)}`}>URL template</label>
                    <input
                      id={`im-url-${String(i)}`}
                      type="text"
                      value={d.urlTemplate ?? ''}
                      disabled={!admin}
                      spellCheck={false}
                      onChange={(e) => update(i, { urlTemplate: e.target.value })}
                    />
                    <span className="small muted">
                      {'{z}/{x}/{y}'} or {'{q}'} (quadkey); {'{s}'} picks one of the subdomains.
                    </span>
                  </div>
                  <div className="row">
                    <div className="field">
                      <label htmlFor={`im-sub-${String(i)}`}>Subdomains</label>
                      <input
                        id={`im-sub-${String(i)}`}
                        type="text"
                        value={d.subdomains ?? ''}
                        disabled={!admin}
                        onChange={(e) => update(i, { subdomains: e.target.value })}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor={`im-attr-${String(i)}`}>Attribution</label>
                      <input
                        id={`im-attr-${String(i)}`}
                        type="text"
                        value={d.attribution ?? ''}
                        disabled={!admin}
                        onChange={(e) => update(i, { attribution: e.target.value })}
                      />
                    </div>
                  </div>
                </>
              )}
              <div className="row">
                <div className="field">
                  <label htmlFor={`im-minz-${String(i)}`}>Min zoom</label>
                  <input
                    id={`im-minz-${String(i)}`}
                    type="number"
                    min={0}
                    max={22}
                    value={d.minZoom}
                    disabled={!admin}
                    onChange={(e) => update(i, { minZoom: Number(e.target.value) })}
                  />
                </div>
                <div className="field">
                  <label htmlFor={`im-maxz-${String(i)}`}>Max zoom</label>
                  <input
                    id={`im-maxz-${String(i)}`}
                    type="number"
                    min={0}
                    max={22}
                    value={d.maxZoom}
                    disabled={!admin}
                    onChange={(e) => update(i, { maxZoom: Number(e.target.value) })}
                  />
                </div>
              </div>

              {st ? (
                <p className={`small ${st.ok ? 'muted' : 'error'}`}>
                  {st.ok ? '✓ ' : '✗ '}
                  {st.message}
                  {st.zoomRange
                    ? ` · zoom ${String(st.zoomRange[0])}–${String(st.zoomRange[1])}`
                    : ''}
                  {st.prefetch ? (
                    <>
                      {' · '}
                      {st.prefetch.running
                        ? `caching ${String(st.prefetch.done)}/${String(st.prefetch.total)}…`
                        : `cached ${String(st.prefetch.done - st.prefetch.failed)}/${String(st.prefetch.total)} in ${fmtDuration(Date.now() - st.prefetch.startedAt)}${st.prefetch.failed > 0 ? ` (${String(st.prefetch.failed)} failed)` : ''}`}
                    </>
                  ) : null}
                </p>
              ) : d.id ? null : (
                <p className="small muted">Save to check this source.</p>
              )}

              {admin ? (
                <div className="btn-row">
                  {d.kind === 'xyz' && d.id ? (
                    <button
                      type="button"
                      className="btn"
                      disabled={dirty || st?.prefetch?.running}
                      title={dirty ? 'Save first' : 'Download 1.5 km around the boat at zoom 13–19'}
                      onClick={() => d.id && void prefetch(d.id)}
                    >
                      Cache around the boat
                    </button>
                  ) : null}
                  <button type="button" className="btn quiet" onClick={() => setRemoving(i)}>
                    Remove
                  </button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      {admin ? (
        <>
          <div className="btn-row">
            {listing?.presets.map((p) => (
              <button
                key={p.name}
                type="button"
                className="btn"
                disabled={full}
                title={p.note}
                onClick={() => addPreset(p)}
              >
                + {p.name}
              </button>
            ))}
            <button type="button" className="btn" disabled={full} onClick={addMbtiles}>
              + MBTiles file
            </button>
          </div>
          {full ? <p className="small muted">Limit of {max} sources reached.</p> : null}
          <p className="small muted">
            To add an MBTiles file, copy a <em>raster</em> .mbtiles (jpg/png/webp tiles; vector .pbf
            files will not draw) into <code>{files.dir || '/data/mbtiles'}</code> on the box, e.g.{' '}
            <code>docker cp anchorage.mbtiles rode:/data/mbtiles/</code>, then reload this page.
          </p>
          <div className="btn-row">
            <button
              type="button"
              className="btn primary"
              disabled={!dirty}
              onClick={() => void save()}
            >
              Save sources
            </button>
            {saved && !dirty ? <span className="small muted">Saved.</span> : null}
          </div>
        </>
      ) : (
        <p className="small muted">Admins can add or change sources.</p>
      )}

      {removing !== null ? (
        <ConfirmDialog
          title="Remove this source?"
          body={
            <p>
              {drafts[removing]?.kind === 'xyz'
                ? 'Its cached tiles are deleted from the box when you save.'
                : 'The file itself is not deleted.'}
            </p>
          }
          confirmLabel="Remove"
          danger
          onConfirm={() => {
            setDrafts((ds) => ds.filter((_, j) => j !== removing));
            setDirty(true);
            setRemoving(null);
            return Promise.resolve();
          }}
          onClose={() => setRemoving(null)}
        />
      ) : null}
    </Panel>
  );
}

function fmtBytes(n: number): string {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
