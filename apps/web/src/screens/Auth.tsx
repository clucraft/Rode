import { useEffect, useState } from 'react';
import { api, errorMessage } from '../api/client.js';
import { refreshAuth } from '../api/auth.js';

/*
 * Setup wizard (first run) and sign-in. Both are deliberately plain: a
 * single card, a couple of fields, errors that say what to do.
 */

interface Strength {
  score: number;
  warning: string;
  suggestions: string[];
  crackTime: string;
  acceptable: boolean;
  problems: string[];
}

function usePasswordStrength(password: string, inputs: string[]): Strength | null {
  const [s, setS] = useState<Strength | null>(null);
  useEffect(() => {
    if (password.length === 0) {
      setS(null);
      return;
    }
    const h = window.setTimeout(() => {
      api
        .post<Strength>('/api/auth/password-strength', { password, inputs })
        .then(setS)
        .catch(() => setS(null));
    }, 250);
    return () => window.clearTimeout(h);
  }, [password, inputs.join('|')]);
  return s;
}

export function StrengthMeter({ s }: { s: Strength | null }) {
  if (!s) return null;
  const pct = ((s.score + 1) / 5) * 100;
  return (
    <div aria-live="polite">
      <div className="strength" aria-hidden="true">
        <div style={{ width: `${pct}%`, background: s.acceptable ? 'var(--ok)' : 'var(--crit)' }} />
      </div>
      <p className="small muted">
        {s.acceptable ? `Good. Roughly ${s.crackTime} to crack offline.` : s.problems.join(' ')}{' '}
        {s.warning ? ` ${s.warning}.` : ''}
        {s.suggestions.length > 0 && !s.acceptable ? ` ${s.suggestions[0]}` : ''}
      </p>
    </div>
  );
}

export function Setup() {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const strength = usePasswordStrength(password, [username, displayName]);

  const submit = async (e: { preventDefault(): void }) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api.post('/api/setup', { username, password, displayName });
      await refreshAuth();
    } catch (ex) {
      setErr(errorMessage(ex));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-shell">
      <form className="auth-card stack" onSubmit={submit}>
        <div>
          <h1>Rode</h1>
          <p className="muted">
            First run. Create the admin account for this boat. There are no default credentials.
          </p>
        </div>
        <div className="field">
          <label htmlFor="su-user">Username</label>
          <input
            id="su-user"
            type="text"
            autoComplete="username"
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="su-name">Display name</label>
          <input
            id="su-name"
            type="text"
            autoComplete="name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="su-pass">Password</label>
          <input
            id="su-pass"
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <span className="why">
            At least 10 characters. A few words you will remember beat symbols you will not.
          </span>
          <StrengthMeter s={strength} />
        </div>
        {err ? (
          <p className="error" role="alert">
            {err}
          </p>
        ) : null}
        <button type="submit" className="btn primary big" disabled={busy || !username || !password}>
          Create admin account
        </button>
      </form>
    </div>
  );
}

export function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [needsTotp, setNeedsTotp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: { preventDefault(): void }) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const body: Record<string, string> = { username, password };
      if (needsTotp && totp) {
        if (useRecovery) body.recoveryCode = totp;
        else body.totp = totp;
      }
      await api.post('/api/auth/login', body);
      await refreshAuth();
    } catch (ex) {
      const msg = errorMessage(ex);
      if (msg.includes('two-factor')) setNeedsTotp(true);
      else setErr(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-shell">
      <form className="auth-card stack" onSubmit={submit}>
        <div>
          <h1>Rode</h1>
          <p className="muted">Sign in to the boat.</p>
        </div>
        <div className="field">
          <label htmlFor="li-user">Username</label>
          <input
            id="li-user"
            type="text"
            autoComplete="username"
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="li-pass">Password</label>
          <input
            id="li-pass"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {needsTotp ? (
          <div className="field">
            <label htmlFor="li-totp">{useRecovery ? 'Recovery code' : 'Two-factor code'}</label>
            <input
              id="li-totp"
              type="text"
              inputMode={useRecovery ? 'text' : 'numeric'}
              autoComplete="one-time-code"
              required
              value={totp}
              onChange={(e) => setTotp(e.target.value)}
              autoFocus
            />
            <button
              type="button"
              className="btn quiet small"
              onClick={() => setUseRecovery((v) => !v)}
            >
              {useRecovery ? 'Use the authenticator instead' : 'Use a recovery code instead'}
            </button>
          </div>
        ) : null}
        {err ? (
          <p className="error" role="alert">
            {err}
          </p>
        ) : null}
        <button type="submit" className="btn primary big" disabled={busy}>
          Sign in
        </button>
      </form>
    </div>
  );
}
