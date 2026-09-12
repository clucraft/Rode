import { randomUUID } from 'node:crypto';
import type { Bus } from '../bus.js';
import type { EventsRepo } from '../db/repos.js';
import type { Logger } from '../logger.js';
import {
  generateRecoveryCodes,
  generateTotpSecret,
  hashPassword,
  normaliseRecoveryCode,
  otpauthUrl,
  passwordStrength,
  randomToken,
  sha256,
  verifyPassword,
  verifyTotp,
  type PasswordStrength,
} from './crypto.js';
import {
  toPublic,
  type AuthRepos,
  type DeviceView,
  type Role,
  type SessionRow,
  type UserPublic,
  type UserRow,
} from './repos.js';

/*
 * Authentication and account management.
 *
 * - No seeded credentials: `needsSetup()` is true until the first admin is
 *   created through the wizard, and the guard refuses everything else.
 * - Sessions are server-side rows; the cookie holds a random id whose hash
 *   is the primary key. Sliding idle expiry with an absolute cap.
 * - Lockout: per-username and per-IP failure counts over a window. Every
 *   attempt goes to the event log.
 * - TOTP is optional; recovery codes are single-use and stored hashed.
 */

export const SESSION_IDLE_MS = 30 * 86_400_000;
export const SESSION_ABSOLUTE_MS = 90 * 86_400_000;
/** Touch last_seen at most this often to keep writes down. */
const TOUCH_INTERVAL_MS = 60_000;

const LOCKOUT_WINDOW_MS = 15 * 60_000;
const LOCKOUT_USER_FAILURES = 5;
const LOCKOUT_IP_FAILURES = 25;

export interface AuthContext {
  ip: string | null;
  userAgent: string | null;
}

export interface SessionHandle {
  /** Value for the cookie. */
  cookie: string;
  csrfToken: string;
  publicId: string;
  expiresAt: number;
}

export interface Resolved {
  user: UserRow;
  session: SessionRow;
}

export type LoginResult =
  | { ok: true; session: SessionHandle; user: UserPublic }
  | { ok: false; reason: 'needs-totp' }
  | { ok: false; reason: 'invalid' | 'locked' | 'disabled'; retryAfterS?: number };

export interface AuthServiceOptions {
  repos: AuthRepos;
  events: EventsRepo;
  bus: Bus;
  log: Logger;
  issuer: () => string;
  now?: () => number;
}

export class AuthService {
  private readonly now: () => number;
  /** TOTP secrets awaiting verification, by user id. Never persisted until enabled. */
  private readonly pendingTotp = new Map<string, string>();

  constructor(private readonly opts: AuthServiceOptions) {
    this.now = opts.now ?? Date.now;
  }

  private log(
    type: string,
    data: Record<string, unknown>,
    severity: 'info' | 'warning' = 'info',
  ): void {
    const at = this.now();
    const seq = this.opts.events.append(type, data, severity, at);
    this.opts.bus.emit('log:event', {
      record: { seq, at, sessionId: null, type, severity, data: { at, type, ...data } },
    });
  }

  needsSetup(): boolean {
    return this.opts.repos.users.count() === 0;
  }

  strength(password: string, inputs: string[] = []): PasswordStrength {
    return passwordStrength(password, inputs);
  }

  // ---------------------------------------------------------------- setup

  async setup(
    input: { username: string; password: string; displayName: string },
    ctx: AuthContext,
  ): Promise<{ user: UserPublic; session: SessionHandle }> {
    if (!this.needsSetup()) throw new AuthError('setup-done', 'Setup has already been completed.');
    const strength = this.strength(input.password, [input.username, input.displayName]);
    if (!strength.acceptable) throw new AuthError('weak-password', strength.problems.join(' '));
    const user = await this.createUser({ ...input, role: 'admin' }, 'setup');
    const session = this.createSession(user.id, ctx);
    this.log('setup-completed', { userId: user.id, username: user.username, ip: ctx.ip });
    return { user: toPublic(user), session };
  }

  // ---------------------------------------------------------------- login

  async login(
    input: {
      username: string;
      password: string;
      totp?: string | undefined;
      recoveryCode?: string | undefined;
    },
    ctx: AuthContext,
  ): Promise<LoginResult> {
    const now = this.now();
    const username = input.username.trim();
    const { attempts, users } = this.opts.repos;

    const since = now - LOCKOUT_WINDOW_MS;
    const userFailures = attempts.recentFailures(username, since);
    const ipFailures = ctx.ip ? attempts.recentFailuresByIp(ctx.ip, since) : 0;
    if (userFailures >= LOCKOUT_USER_FAILURES || ipFailures >= LOCKOUT_IP_FAILURES) {
      attempts.record(now, username, ctx.ip, false, 'locked');
      this.log('login-locked', { username, ip: ctx.ip, userFailures, ipFailures }, 'warning');
      return { ok: false, reason: 'locked', retryAfterS: Math.ceil(LOCKOUT_WINDOW_MS / 1000) };
    }

    const user = users.byUsername(username);
    // Verify against a dummy hash when the user does not exist so timing
    // does not reveal which usernames are real.
    const ok = user
      ? await verifyPassword(user.password_hash, input.password)
      : await verifyPassword(DUMMY_HASH, input.password);
    if (!user || !ok) {
      attempts.record(now, username, ctx.ip, false, 'bad-credentials');
      this.log('login-failed', { username, ip: ctx.ip, reason: 'bad-credentials' }, 'warning');
      return { ok: false, reason: 'invalid' };
    }
    if (user.disabled === 1) {
      attempts.record(now, username, ctx.ip, false, 'disabled');
      this.log('login-failed', { username, ip: ctx.ip, reason: 'disabled' }, 'warning');
      return { ok: false, reason: 'disabled' };
    }
    if (user.totp_enabled === 1 && user.totp_secret) {
      if (input.recoveryCode) {
        const hash = sha256(normaliseRecoveryCode(input.recoveryCode));
        if (!users.consumeRecoveryCode(user.id, hash, now)) {
          attempts.record(now, username, ctx.ip, false, 'bad-recovery-code');
          this.log(
            'login-failed',
            { username, ip: ctx.ip, reason: 'bad-recovery-code' },
            'warning',
          );
          return { ok: false, reason: 'invalid' };
        }
        this.log('recovery-code-used', { userId: user.id, username, ip: ctx.ip }, 'warning');
      } else if (!input.totp) {
        return { ok: false, reason: 'needs-totp' };
      } else if (!verifyTotp(user.totp_secret, input.totp, now)) {
        attempts.record(now, username, ctx.ip, false, 'bad-totp');
        this.log('login-failed', { username, ip: ctx.ip, reason: 'bad-totp' }, 'warning');
        return { ok: false, reason: 'invalid' };
      }
    }
    attempts.record(now, username, ctx.ip, true, null);
    const session = this.createSession(user.id, ctx);
    this.log('login', { userId: user.id, username, ip: ctx.ip, userAgent: ctx.userAgent });
    return { ok: true, session, user: toPublic(user) };
  }

  // ---------------------------------------------------------------- sessions

  createSession(userId: string, ctx: AuthContext): SessionHandle {
    const now = this.now();
    const cookie = randomToken(32);
    const csrfToken = randomToken(24);
    const publicId = randomToken(9);
    const expiresAt = now + SESSION_ABSOLUTE_MS;
    this.opts.repos.sessions.insert({
      id_hash: sha256(cookie),
      public_id: publicId,
      user_id: userId,
      csrf_token: csrfToken,
      created_at: now,
      last_seen_at: now,
      expires_at: expiresAt,
      ip: ctx.ip,
      user_agent: ctx.userAgent?.slice(0, 200) ?? null,
    });
    return { cookie, csrfToken, publicId, expiresAt };
  }

  /** Validate a cookie value; applies sliding idle expiry and the absolute cap. */
  resolveSession(cookie: string | undefined, ip: string | null): Resolved | null {
    if (!cookie) return null;
    const now = this.now();
    const s = this.opts.repos.sessions.byHash(sha256(cookie));
    if (s?.revoked_at !== null) return null;
    if (now > s.expires_at || now - s.last_seen_at > SESSION_IDLE_MS) return null;
    const user = this.opts.repos.users.byId(s.user_id);
    if (!user || user.disabled === 1) return null;
    if (now - s.last_seen_at > TOUCH_INTERVAL_MS) {
      this.opts.repos.sessions.touch(s.id_hash, now, ip);
      s.last_seen_at = now;
    }
    return { user, session: s };
  }

  logout(cookie: string | undefined): void {
    if (!cookie) return;
    const hash = sha256(cookie);
    const s = this.opts.repos.sessions.byHash(hash);
    if (!s) return;
    this.opts.repos.sessions.revoke(hash, this.now());
    this.log('logout', { userId: s.user_id });
  }

  devices(userId: string, currentHash: string): DeviceView[] {
    return this.opts.repos.sessions.activeForUser(userId, this.now()).map((s) => ({
      id: s.public_id,
      createdAt: s.created_at,
      lastSeenAt: s.last_seen_at,
      expiresAt: s.expires_at,
      ip: s.ip,
      userAgent: s.user_agent,
      current: s.id_hash === currentHash,
    }));
  }

  revokeDevice(userId: string, publicId: string): boolean {
    const ok = this.opts.repos.sessions.revokeByPublicId(userId, publicId, this.now());
    if (ok) this.log('session-revoked', { userId, publicId });
    return ok;
  }

  revokeOtherDevices(userId: string, currentHash: string): number {
    const n = this.opts.repos.sessions.revokeAllForUser(userId, this.now(), currentHash);
    if (n > 0) this.log('sessions-revoked', { userId, count: n });
    return n;
  }

  // ---------------------------------------------------------------- passwords

  async changePassword(
    user: UserRow,
    currentPassword: string,
    newPassword: string,
    currentHash: string,
  ): Promise<void> {
    if (!(await verifyPassword(user.password_hash, currentPassword))) {
      throw new AuthError('invalid', 'Current password is wrong.');
    }
    await this.setPassword(user, newPassword, currentHash, 'self');
  }

  async setPassword(
    user: UserRow,
    newPassword: string,
    keepHash: string | null,
    by: string,
  ): Promise<void> {
    const strength = this.strength(newPassword, [user.username, user.display_name]);
    if (!strength.acceptable) throw new AuthError('weak-password', strength.problems.join(' '));
    this.opts.repos.users.setPassword(user.id, await hashPassword(newPassword), this.now());
    // Every other device is signed out: a changed password should end sessions an attacker may hold.
    this.opts.repos.sessions.revokeAllForUser(user.id, this.now(), keepHash);
    this.log('password-changed', { userId: user.id, by });
  }

  // ---------------------------------------------------------------- TOTP

  totpSetup(user: UserRow): { secret: string; url: string } {
    const secret = generateTotpSecret();
    this.pendingTotp.set(user.id, secret);
    return { secret, url: otpauthUrl(this.opts.issuer(), user.username, secret) };
  }

  totpEnable(user: UserRow, code: string): string[] {
    const secret = this.pendingTotp.get(user.id);
    if (!secret) throw new AuthError('no-pending-totp', 'Start two-factor setup first.');
    if (!verifyTotp(secret, code, this.now()))
      throw new AuthError('invalid', 'That code did not match. Check the phone clock.');
    const codes = generateRecoveryCodes();
    this.opts.repos.users.setTotp(
      user.id,
      secret,
      true,
      codes.map((c) => sha256(normaliseRecoveryCode(c))),
      this.now(),
    );
    this.pendingTotp.delete(user.id);
    this.log('totp-enabled', { userId: user.id });
    return codes;
  }

  async totpDisable(user: UserRow, password: string): Promise<void> {
    if (!(await verifyPassword(user.password_hash, password)))
      throw new AuthError('invalid', 'Password is wrong.');
    this.opts.repos.users.setTotp(user.id, null, false, [], this.now());
    this.log('totp-disabled', { userId: user.id }, 'warning');
  }

  regenerateRecoveryCodes(user: UserRow): string[] {
    if (user.totp_enabled !== 1 || !user.totp_secret)
      throw new AuthError('no-totp', 'Two-factor is not enabled.');
    const codes = generateRecoveryCodes();
    this.opts.repos.users.setTotp(
      user.id,
      user.totp_secret,
      true,
      codes.map((c) => sha256(normaliseRecoveryCode(c))),
      this.now(),
    );
    this.log('recovery-codes-regenerated', { userId: user.id });
    return codes;
  }

  // ---------------------------------------------------------------- users (admin)

  async createUser(
    input: { username: string; password: string; displayName: string; role: Role },
    by: string,
  ): Promise<UserRow> {
    const username = input.username.trim();
    if (!/^[a-z0-9._-]{2,32}$/i.test(username)) {
      throw new AuthError(
        'invalid-username',
        'Usernames are 2–32 letters, digits, dots, dashes or underscores.',
      );
    }
    if (this.opts.repos.users.byUsername(username))
      throw new AuthError('exists', 'That username is taken.');
    const strength = this.strength(input.password, [username, input.displayName]);
    if (!strength.acceptable) throw new AuthError('weak-password', strength.problems.join(' '));
    const id = randomUUID();
    this.opts.repos.users.insert(
      {
        id,
        username,
        displayName: input.displayName.trim() || username,
        role: input.role,
        passwordHash: await hashPassword(input.password),
      },
      this.now(),
    );
    this.log('user-created', { userId: id, username, role: input.role, by });
    const user = this.opts.repos.users.byId(id);
    if (!user) throw new Error('user vanished after insert');
    return user;
  }

  updateUser(
    id: string,
    patch: {
      displayName?: string | undefined;
      role?: Role | undefined;
      disabled?: boolean | undefined;
    },
    by: string,
  ): UserPublic {
    const user = this.opts.repos.users.byId(id);
    if (!user) throw new AuthError('not-found', 'No such user.');
    const demoting = (patch.role === 'crew' && user.role === 'admin') || patch.disabled === true;
    if (demoting && user.role === 'admin' && this.opts.repos.users.adminCount() <= 1) {
      throw new AuthError('last-admin', 'There must be at least one enabled admin.');
    }
    this.opts.repos.users.update(id, patch, this.now());
    if (patch.disabled) this.opts.repos.sessions.revokeAllForUser(id, this.now());
    this.log('user-updated', { userId: id, patch, by });
    const updated = this.opts.repos.users.byId(id);
    if (!updated) throw new AuthError('not-found', 'No such user.');
    return toPublic(updated);
  }

  deleteUser(id: string, by: string): void {
    const user = this.opts.repos.users.byId(id);
    if (!user) throw new AuthError('not-found', 'No such user.');
    if (user.role === 'admin' && this.opts.repos.users.adminCount() <= 1) {
      throw new AuthError('last-admin', 'There must be at least one enabled admin.');
    }
    this.opts.repos.users.delete(id);
    this.log('user-deleted', { userId: id, username: user.username, by }, 'warning');
  }

  listUsers(): UserPublic[] {
    return this.opts.repos.users.all().map(toPublic);
  }

  userById(id: string): UserRow | undefined {
    return this.opts.repos.users.byId(id);
  }

  // ---------------------------------------------------------------- API tokens

  createToken(userId: string, name: string): { id: string; token: string } {
    const id = randomUUID();
    const token = `rode_${randomToken(32)}`;
    this.opts.repos.tokens.insert(
      {
        id,
        userId,
        name: name.trim().slice(0, 60) || 'token',
        tokenHash: sha256(token),
        scope: 'read',
      },
      this.now(),
    );
    this.log('token-created', { tokenId: id, name, userId });
    return { id, token };
  }

  resolveToken(bearer: string): { id: string; name: string; scope: string } | null {
    if (!bearer.startsWith('rode_')) return null;
    const t = this.opts.repos.tokens.byHash(sha256(bearer));
    if (!t) return null;
    const now = this.now();
    if (t.last_used_at === null || now - t.last_used_at > TOUCH_INTERVAL_MS)
      this.opts.repos.tokens.touch(t.id, now);
    return { id: t.id, name: t.name, scope: t.scope };
  }

  listTokens(): {
    id: string;
    name: string;
    scope: string;
    createdAt: number;
    lastUsedAt: number | null;
  }[] {
    return this.opts.repos.tokens.all().map((t) => ({
      id: t.id,
      name: t.name,
      scope: t.scope,
      createdAt: t.created_at,
      lastUsedAt: t.last_used_at,
    }));
  }

  revokeToken(id: string, by: string): boolean {
    const ok = this.opts.repos.tokens.revoke(id, this.now());
    if (ok) this.log('token-revoked', { tokenId: id, by });
    return ok;
  }

  /** Periodic cleanup of expired sessions and old attempts. */
  housekeeping(): void {
    const now = this.now();
    this.opts.repos.sessions.purgeExpired(now);
    this.opts.repos.attempts.purge(now - 30 * 86_400_000);
  }
}

export class AuthError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** A real argon2id hash of a random string, so failed lookups cost the same as failed passwords. */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$8bE4o2iK1Y7bF6vQ0R9m5rXQ6uJ7oV0S3l9Wp1nH2Yk';
