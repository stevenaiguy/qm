import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { installPrincipalLinks } from "../src/directory/person.ts";
import { createPrincipalLinkService } from "../src/identity/principal-links.ts";
import { createUserRoster } from "../src/identity/user-roster.ts";
import { createPostgresUserStore, type UserStore } from "../src/identity/user-store.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { testAdvisoryLock, testDatabaseUrl } from "./support/test-database.ts";

const url = testDatabaseUrl();
const store = (): UserStore => createPostgresUserStore(url);
const unique = (name: string) => `${name}-${randomUUID().slice(0, 8)}@example.com`;

test("a person joins the roster once, folded to one row, and the first arrival sticks across instances", async () => {
  const pat = unique("pat");
  const backing = store();
  let writes = 0;
  const roster = createUserRoster({
    ...backing,
    fillFirstSeen: (people) => {
      writes++;
      return backing.fillFirstSeen(people);
    },
  });
  await roster.list();
  await roster.note(pat.toUpperCase(), "turn");
  await roster.note(pat, "turn");
  await roster.note(pat, "admin");
  assert.equal(writes, 1, "later notes for someone already on the roster cost no write");
  const row = (await roster.get(pat))!;
  assert.deepEqual([row.id, row.source], [pat, "turn"]);
  assert.equal(typeof row.firstSeenAt, "number");

  const other = createUserRoster({
    ...backing,
    fillFirstSeen: (people) => {
      writes++;
      return backing.fillFirstSeen(people);
    },
  });
  await other.note(pat, "admin");
  await other.note(pat, "turn");
  assert.equal(writes, 2, "a cold instance spends one write on a known person, then none");
  assert.equal((await other.get(pat))!.source, "turn", "another instance keeps the first arrival");
});

test("offboarding sets offboarded_at once; reactivation clears it; both reach other instances", async () => {
  const leaver = unique("leaver");
  const writer = createUserRoster(store());
  const reader = createUserRoster(store());
  await reader.list();
  const first = await writer.markOffboarded(leaver, "admin-alice");
  assert.equal(first.offboardedBy, "admin-alice");
  assert.equal(typeof first.offboardedAt, "number");
  const retry = await writer.markOffboarded(leaver.toUpperCase(), "admin-bob");
  assert.deepEqual([retry.offboardedAt, retry.offboardedBy], [first.offboardedAt, "admin-alice"]);

  await reader.note(leaver, "turn");
  const seen = (await createUserRoster(store()).get(leaver))!;
  assert.deepEqual([seen.offboardedBy, seen.source], ["admin-alice", "turn"], "a first arrival keeps the offboarding");

  const back = await reader.markReactivated(leaver);
  assert.deepEqual([back?.offboardedAt, back?.source], [undefined, "turn"]);
  assert.equal((await createUserRoster(store()).get(leaver))!.offboardedAt, undefined);
  const stranger = unique("stranger");
  assert.equal(await writer.markReactivated(stranger), null);
  assert.equal(await writer.get(stranger), null, "reactivating a stranger adds no row");
});

test("recording fills only gaps and never moves a first arrival", async () => {
  const sam = unique("sam");
  const left = unique("left");
  const ann = unique("ann");
  const roster = createUserRoster(store());
  await roster.markOffboarded(left, "admin-alice");
  const people = [
    { id: sam, source: "admin" as const, at: 200 },
    { id: left, source: "turn" as const, at: 100 },
    { id: ann.toUpperCase(), source: "invite" as const, at: 50 },
  ];
  assert.equal(await roster.record(people), 3);
  assert.deepEqual(
    [(await roster.get(left))!.offboardedBy, (await roster.get(left))!.firstSeenAt],
    ["admin-alice", 100],
  );
  assert.equal((await roster.get(ann))!.id, ann);
  const again = createUserRoster(store());
  await again.list();
  const late = { id: unique("late"), source: "admin" as const, at: 400 };
  assert.equal(await again.record([...people, late]), 1, "a later pass records only the person the roster missed");
  assert.equal(await again.record([...people, late]), 0);
});

test("linking merges the sign-in's row into its user, and later writes for it land on that user", async () => {
  const sam = unique("sam");
  const slack = `U-${randomUUID().slice(0, 8)}`;
  const backing = store();
  const links = createPrincipalLinkService(backing, testAdvisoryLock());
  const roster = createUserRoster(backing, { principalLinks: links });
  const db = createPgPool(url);
  const rowIds = async () =>
    (await db.q("SELECT id FROM users WHERE id = ANY($1)", [[sam, slack]])).map((r) => r.id as string).sort();
  await roster.record([
    { id: sam, source: "admin", at: 200 },
    { id: slack, source: "turn", at: 150 },
  ]);
  await backing.markOffboarded(slack, "admin-bob", 10);
  await backing.markOffboarded(sam, "admin-alice", 20);
  assert.deepEqual(await rowIds(), [sam, slack].sort(), "before the link they are two users");

  installPrincipalLinks(links);
  try {
    await links.link({ principalId: slack, canonicalId: sam, evidence: "qa", linkedBy: "admin-alice" });
    assert.deepEqual(await rowIds(), [sam], "the sign-in's row is merged away");
    const merged = (await createUserRoster(store()).get(sam))!;
    assert.deepEqual(
      [merged.firstSeenAt, merged.source, merged.offboardedAt, merged.offboardedBy],
      [150, "turn", 10, "admin-bob"],
      "earliest arrival and earliest offboarding win",
    );
    assert.equal((await roster.get(slack))?.id, sam, "the sign-in reads as its user");

    await backing.fillFirstSeen([{ id: slack, source: "turn", at: 1 }]);
    await backing.markOffboarded(slack, "admin-carol", 5);
    assert.deepEqual(await rowIds(), [sam], "writes under the sign-in resolve to the user, even from a stale cache");
    assert.equal((await roster.markReactivated(slack))?.offboardedAt, undefined);
    assert.equal((await createUserRoster(store()).get(sam))!.offboardedAt, undefined);

    const ghost = unique("ghost");
    const other = `U-${randomUUID().slice(0, 8)}`;
    await links.link({ principalId: other, canonicalId: ghost, evidence: "qa", linkedBy: "admin-alice" });
    assert.ok(
      (await db.q("SELECT 1 FROM users WHERE id = $1", [ghost])).length,
      "linking to someone new creates their user",
    );
    assert.equal(
      (await createUserRoster(store()).list()).some((u) => u.id === ghost),
      false,
      "but a user nobody has met is not listed",
    );

    await links.unlink(slack);
    assert.deepEqual(await rowIds(), [sam], "unlinking keeps the merged row with the user");
    await assert.rejects(
      db.query("DELETE FROM users WHERE id = $1", [ghost]),
      /foreign key/,
      "a user with links cannot be deleted out from under them",
    );
  } finally {
    installPrincipalLinks(null);
  }
});
