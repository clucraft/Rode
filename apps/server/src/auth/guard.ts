import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Actor } from '../context.js';

/*
 * Route guards. Phase 5 replaces the body of `requireRole` with real session
 * and token checks; the shape stays the same so routes do not change.
 */

export type Role = Actor['role'];

const RANK: Record<Role, number> = { token: 0, crew: 1, admin: 2 };

export function hasRole(actor: Actor | undefined, needed: Role): boolean {
  if (!actor) return false;
  return RANK[actor.role] >= RANK[needed];
}

/** Placeholder until phase 5: every request is an anonymous crew member. */
export function requireRole(_needed: Role) {
  return (req: FastifyRequest, _reply: FastifyReply, done: () => void): void => {
    req.actor ??= { id: 'anonymous', name: 'anonymous', role: 'admin' };
    done();
  };
}
