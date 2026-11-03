import { personKey } from "../directory/person.ts";
import { createTtlRefresh } from "../util/async.ts";
import { reportFailure } from "../util/errors.ts";
import type { UserRecord, UserSource, UserStore } from "./user-store.ts";

export interface SeenPerson {
  id: string;
  source: UserSource;
  at: number;
}

export interface UserRoster {
  list(): Promise<UserRecord[]>;
  get(id: string): Promise<UserRecord | null>;
  note(id: string, source: UserSource): Promise<void>;
  record(people: readonly SeenPerson[]): Promise<number>;
  markOffboarded(id: string, by: string): Promise<UserRecord>;
  markReactivated(id: string): Promise<UserRecord | null>;
}

export function createUserRoster(
  store: Omit<UserStore, "links" | "link" | "unlink">,
  opts: { principalLinks?: { refresh(force?: boolean): Promise<void> } } = {},
): UserRoster {
  const users = new Map<string, UserRecord>();
  const known = new Set<string>();
  const remember = (record: UserRecord): UserRecord => {
    users.set(record.id, record);
    return record;
  };
  const refresh = createTtlRefresh(10_000, async () => {
    await opts.principalLinks?.refresh();
    const records = await store.all();
    users.clear();
    for (const r of records) users.set(r.id, r);
  });
  const seen = (id: string) => known.has(personKey(id)) || users.get(personKey(id))?.firstSeenAt !== undefined;

  async function record(input: readonly SeenPerson[]): Promise<number> {
    const first = new Map<string, SeenPerson>();
    for (const person of input) {
      const id = personKey(person.id);
      if (!id || seen(id)) continue;
      const prior = first.get(id);
      if (!prior || person.at < prior.at) first.set(id, { ...person, id });
    }
    const added = await store.fillFirstSeen([...first.values()]);
    for (const r of added) remember(r);
    for (const id of first.keys()) known.add(id);
    return added.length;
  }

  return {
    async list() {
      await refresh();
      return [...users.values()].filter((u) => u.firstSeenAt !== undefined || u.offboardedAt !== undefined);
    },
    async get(id) {
      await refresh();
      return users.get(personKey(id)) ?? null;
    },
    async note(id, source) {
      if (seen(id)) return;
      await record([{ id, source, at: Date.now() }]).catch((err: unknown) =>
        reportFailure("users: record person", err),
      );
    },
    record,
    async markOffboarded(id, by) {
      return remember(await store.markOffboarded(personKey(id), by, Date.now()));
    },
    async markReactivated(id) {
      const cleared = await store.clearOffboarded(personKey(id));
      return cleared ? remember(cleared) : null;
    },
  };
}
