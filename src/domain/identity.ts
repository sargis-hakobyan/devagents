import { AppError } from './errors.js';

/** Application identity stays independent of the mechanism used to sign in. */
export type UserIdentity = { id: string; name: string; role: 'admin' };

export interface UserDirectory {
  loginUser(id: string): UserIdentity | undefined | Promise<UserIdentity | undefined>;
}

/** Trusted caller supplied to application authorization after authentication. */
export type Actor = { kind: 'user'; userId: string } | { kind: 'operator' };

/** Each current runner owns one workspace. The operator manages that installation. */
export class WorkspaceAccess {
  private constructor(readonly ownerId: string) {}

  static local(): WorkspaceAccess { return new WorkspaceAccess('local'); }

  static shared(ownerId: string | undefined): WorkspaceAccess {
    if (!ownerId || ownerId === 'local') throw new AppError('missing_workspace_owner', 'Shared workspaces require an explicit owner');
    return new WorkspaceAccess(ownerId);
  }

  authorize(actor: Actor): void {
    if (actor.kind === 'user' && actor.userId !== this.ownerId) {
      throw new AppError('workspace_forbidden', 'This workspace belongs to another user', 403);
    }
  }
}
