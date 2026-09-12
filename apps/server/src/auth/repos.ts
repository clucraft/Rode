import type { Statement } from 'better-sqlite3';
import type { Db } from '../db/database.js';

/* Auth tables. Same statement-cache pattern as db/repos.ts. */

abstract class Repo {
  private readonly cache = new Map<string, Statement>();
  constructor(protected readonly db: Db) {}
  protected stmt(sql: string): Statement {
    let st = this.cache.get(sql);
    if (!st) {
      st = this.db.prepare(sql);
      this.cache.set(sql, st);
    }
    return st;
  }
}

export type Role = 'admin' | 'crew';

export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  role: Role;
  password_hash: string;
  totp_secret: string | null;
  totp_enabled: number;
  recovery_codes: string;
  disabled: number;
  created_at: number;
  updated_at: number;
}

export interface UserPublic {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  totpEnabled: boolean;
  disabled: boolean;
  createdAt: number;
}

export function toPublic(u: UserRow): UserPublic {
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    role: u.role,
    totpEnabled: u.totp_enabled === 1,
    disabled: u.disabled === 1,
    createdAt: u.created_at,
  };
}

export class UsersRepo extends Repo {
  count(): number {
    return (this.stmt('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  }
  byUsername(username: string): UserRow | undefined {
    return this.stmt('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
  }
  byId(id: string): UserRow | undefined {
    return this.stmt('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  }
  all(): UserRow[] {
    return this.stmt('SELECT * FROM users ORDER BY created_at ASC').all() as UserRow[];
  }
  insert(
    u: { id: string; username: string; displayName: string; role: Role; passwordHash: string },
    now: number,
  ): void {
    this.stmt(
      'INSERT INTO users (id, username, display_name, role, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(u.id, u.username, u.displayName, u.role, u.passwordHash, now, now);
  }
  update(
    id: string,
    patch: {
      displayName?: string | undefined;
      role?: Role | undefined;
      disabled?: boolean | undefined;
    },
    now: number,
  ): boolean {
    const u = this.byId(id);
    if (!u) return false;
    this.stmt(
      'UPDATE users SET display_name = ?, role = ?, disabled = ?, updated_at = ? WHERE id = ?',
    ).run(
      patch.displayName ?? u.display_name,
      patch.role ?? u.role,
      (patch.disabled ?? u.disabled === 1) ? 1 : 0,
      now,
      id,
    );
    return true;
  }
  setPassword(id: string, passwordHash: string, now: number): void {
    this.stmt('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(
      passwordHash,
      now,
      id,
    );
  }
  setTotp(
    id: string,
    secret: string | null,
    enabled: boolean,
    recoveryHashes: string[],
    now: number,
  ): void {
    this.stmt(
      'UPDATE users SET totp_secret = ?, totp_enabled = ?, recovery_codes = ?, updated_at = ? WHERE id = ?',
    ).run(secret, enabled ? 1 : 0, JSON.stringify(recoveryHashes), now, id);
  }
  consumeRecoveryCode(id: string, hash: string, now: number): boolean {
    const u = this.byId(id);
    if (!u) return false;
    const codes = JSON.parse(u.recovery_codes) as string[];
    const idx = codes.indexOf(hash);
    if (idx === -1) return false;
    codes.splice(idx, 1);
    this.stmt('UPDATE users SET recovery_codes = ?, updated_at = ? WHERE id = ?').run(
      JSON.stringify(codes),
      now,
      id,
    );
    return true;
  }
  delete(id: string): boolean {
    return this.stmt('DELETE FROM users WHERE id = ?').run(id).changes > 0;
  }
  adminCount(): number {
    return (
      this.stmt("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").get() as {
        n: number;
      }
    ).n;
  }
}

export interface SessionRow {
  id_hash: string;
  public_id: string;
  user_id: string;
  csrf_token: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  ip: string | null;
  user_agent: string | null;
  revoked_at: number | null;
}

export interface DeviceView {
  id: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
}

export class AuthSessionsRepo extends Repo {
  insert(s: Omit<SessionRow, 'revoked_at'>): void {
    this.stmt(
      'INSERT INTO auth_sessions (id_hash, public_id, user_id, csrf_token, created_at, last_seen_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      s.id_hash,
      s.public_id,
      s.user_id,
      s.csrf_token,
      s.created_at,
      s.last_seen_at,
      s.expires_at,
      s.ip,
      s.user_agent,
    );
  }
  byHash(idHash: string): SessionRow | undefined {
    return this.stmt('SELECT * FROM auth_sessions WHERE id_hash = ?').get(idHash) as
      SessionRow | undefined;
  }
  touch(idHash: string, lastSeenAt: number, ip: string | null): void {
    this.stmt(
      'UPDATE auth_sessions SET last_seen_at = ?, ip = COALESCE(?, ip) WHERE id_hash = ?',
    ).run(lastSeenAt, ip, idHash);
  }
  revoke(idHash: string, now: number): void {
    this.stmt('UPDATE auth_sessions SET revoked_at = ? WHERE id_hash = ?').run(now, idHash);
  }
  revokeByPublicId(userId: string, publicId: string, now: number): boolean {
    return (
      this.stmt(
        'UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND public_id = ? AND revoked_at IS NULL',
      ).run(now, userId, publicId).changes > 0
    );
  }
  revokeAllForUser(userId: string, now: number, exceptHash: string | null = null): number {
    return this.stmt(
      'UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND (? IS NULL OR id_hash <> ?)',
    ).run(now, userId, exceptHash, exceptHash).changes;
  }
  activeForUser(userId: string, now: number): SessionRow[] {
    return this.stmt(
      'SELECT * FROM auth_sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY last_seen_at DESC',
    ).all(userId, now) as SessionRow[];
  }
  purgeExpired(now: number): number {
    return this.stmt('DELETE FROM auth_sessions WHERE expires_at < ? OR revoked_at < ?').run(
      now,
      now - 7 * 86_400_000,
    ).changes;
  }
}

export interface TokenRow {
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  scope: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

export class ApiTokensRepo extends Repo {
  insert(
    t: { id: string; userId: string; name: string; tokenHash: string; scope: string },
    now: number,
  ): void {
    this.stmt(
      'INSERT INTO api_tokens (id, user_id, name, token_hash, scope, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(t.id, t.userId, t.name, t.tokenHash, t.scope, now);
  }
  byHash(hash: string): TokenRow | undefined {
    return this.stmt('SELECT * FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL').get(
      hash,
    ) as TokenRow | undefined;
  }
  touch(id: string, now: number): void {
    this.stmt('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(now, id);
  }
  all(): TokenRow[] {
    return this.stmt(
      'SELECT * FROM api_tokens WHERE revoked_at IS NULL ORDER BY created_at ASC',
    ).all() as TokenRow[];
  }
  revoke(id: string, now: number): boolean {
    return (
      this.stmt('UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(
        now,
        id,
      ).changes > 0
    );
  }
}

export class LoginAttemptsRepo extends Repo {
  record(
    at: number,
    username: string,
    ip: string | null,
    success: boolean,
    reason: string | null,
  ): void {
    this.stmt(
      'INSERT INTO login_attempts (at, username, ip, success, reason) VALUES (?, ?, ?, ?, ?)',
    ).run(at, username, ip, success ? 1 : 0, reason);
  }
  /** Consecutive failures for a username since the last success, within the window. */
  recentFailures(username: string, since: number): number {
    return (
      this.stmt(
        'SELECT COUNT(*) AS n FROM login_attempts WHERE username = ? AND at > ? AND success = 0 AND at > COALESCE((SELECT MAX(at) FROM login_attempts WHERE username = ? AND success = 1), 0)',
      ).get(username, since, username) as { n: number }
    ).n;
  }
  recentFailuresByIp(ip: string, since: number): number {
    return (
      this.stmt(
        'SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ? AND at > ? AND success = 0',
      ).get(ip, since) as { n: number }
    ).n;
  }
  purge(before: number): number {
    return this.stmt('DELETE FROM login_attempts WHERE at < ?').run(before).changes;
  }
}

export interface AuthRepos {
  users: UsersRepo;
  sessions: AuthSessionsRepo;
  tokens: ApiTokensRepo;
  attempts: LoginAttemptsRepo;
}

export function createAuthRepos(db: Db): AuthRepos {
  return {
    users: new UsersRepo(db),
    sessions: new AuthSessionsRepo(db),
    tokens: new ApiTokensRepo(db),
    attempts: new LoginAttemptsRepo(db),
  };
}
