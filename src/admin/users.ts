import type { AdminGrant } from "./admin-grant-store.ts";
import { adminStatusFromGrants, type AdminStatus } from "./admin-service.ts";
import { forEachAttributedTurn, type AttributionInput } from "./attribution.ts";
import { canonicalPerson, personKey } from "../directory/person.ts";
import { isTeammate, type ExternalMember } from "../identity/external-members.ts";
import type { UserRoster, SeenPerson } from "../identity/user-roster.ts";

export interface AdminUserRow {
  principalId: string;
  sessionCount: number;
  turnCount: number;
  lastSeenAt: number | null;
  admin: AdminStatus;
}

export interface UsersInput extends AttributionInput {
  grants: readonly AdminGrant[];
  people: readonly string[];
}

export function computeUsers(input: UsersInput): AdminUserRow[] {
  const { grants, people } = input;

  const sessionsByUser = new Map<string, Set<string>>();
  const turnsByUser = new Map<string, number>();
  const lastSeenByUser = new Map<string, number>();
  const bumpLastSeen = (principalId: string, t: number) => {
    if (t > (lastSeenByUser.get(principalId) ?? 0)) lastSeenByUser.set(principalId, t);
  };

  forEachAttributedTurn(input, {
    onWindow(sessionId, w) {
      const principalId = personKey(w.principalId);
      const set = sessionsByUser.get(principalId);
      if (set) set.add(sessionId);
      else sessionsByUser.set(principalId, new Set([sessionId]));
      bumpLastSeen(principalId, w.validFrom);
    },
    onTurn(w, turn) {
      const principalId = personKey(w.principalId);
      turnsByUser.set(principalId, (turnsByUser.get(principalId) ?? 0) + turn.turns);
      bumpLastSeen(principalId, turn.lastAt);
    },
  });

  const ids = new Map(people.map((p) => [personKey(p), canonicalPerson(p)]));
  return [...ids]
    .map(([key, principalId]) => ({
      principalId,
      sessionCount: sessionsByUser.get(key)?.size ?? 0,
      turnCount: turnsByUser.get(key) ?? 0,
      lastSeenAt: lastSeenByUser.get(key) ?? null,
      admin: adminStatusFromGrants(grants, principalId),
    }))
    .sort((a, b) => Number(b.admin.isAdmin) - Number(a.admin.isAdmin) || (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0));
}

export async function reconcileUsers(deps: {
  users: UserRoster;
  grants: () => Promise<readonly AdminGrant[]>;
  externals: () => Promise<readonly ExternalMember[]>;
}): Promise<number> {
  const now = Date.now();
  return deps.users.record([
    ...(await deps.grants()).map((g): SeenPerson => ({
      id: g.principalId,
      source: "admin",
      at: g.createdAt || now,
    })),
    ...(await deps.externals())
      .filter(isTeammate)
      .map((m): SeenPerson => ({ id: m.email, source: "invite", at: m.createdAt })),
  ]);
}
