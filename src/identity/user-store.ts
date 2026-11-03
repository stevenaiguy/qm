import type { PoolClient } from "pg";
import { createPgPool, withPgTransaction, type PgMigrationDefinition } from "../persistence/pg-pool.ts";
import { DIRECTORY_MIGRATIONS } from "../directory/postgres-directory-store.ts";
import { SESSION_MIGRATIONS } from "../sessions/session-schema.ts";
import { msOf } from "../sessions/items.ts";

export type UserSource = "turn" | "invite" | "admin";

export interface UserRecord {
  id: string;
  firstSeenAt?: number;
  source?: UserSource;
  offboardedAt?: number;
  offboardedBy?: string;
}

export interface UserLink {
  principalId: string;
  canonicalId: string;
  evidence: string;
  linkedBy: string;
  createdAt: number;
}

export interface UserLinkStore {
  links(): Promise<UserLink[]>;
  link(link: UserLink): Promise<UserLink>;
  unlink(aliasId: string): Promise<UserLink | null>;
}

export interface UserStore extends UserLinkStore {
  all(): Promise<UserRecord[]>;
  fillFirstSeen(people: readonly { id: string; source: UserSource; at: number }[]): Promise<UserRecord[]>;
  markOffboarded(id: string, by: string, at: number): Promise<UserRecord>;
  clearOffboarded(id: string): Promise<UserRecord | null>;
}

const fold = (expr: string): string =>
  `CASE WHEN position('@' IN btrim(${expr})) > 0 THEN lower(btrim(${expr})) ELSE btrim(${expr}) END`;

export const USER_MIGRATIONS: PgMigrationDefinition[] = [
  {
    id: "users/0001",
    statements: [
      `CREATE TABLE IF NOT EXISTS users(
        id            TEXT PRIMARY KEY CHECK (id <> ''),
        first_seen_at TIMESTAMPTZ,
        source        TEXT CHECK (source IN ('turn', 'invite', 'admin')),
        offboarded_at TIMESTAMPTZ,
        offboarded_by TEXT,
        CHECK ((first_seen_at IS NULL) = (source IS NULL)),
        CHECK ((offboarded_at IS NULL) = (offboarded_by IS NULL))
      )`,
      `CREATE TABLE IF NOT EXISTS user_links(
        alias_id   TEXT PRIMARY KEY CHECK (alias_id <> ''),
        user_id    TEXT NOT NULL REFERENCES users(id),
        evidence   TEXT NOT NULL,
        linked_by  TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        CHECK (alias_id <> user_id)
      )`,
      `CREATE INDEX IF NOT EXISTS user_links_user_id ON user_links(user_id)`,
    ],
  },
  {
    id: "users/0002-copy-principal-links",
    statements: [
      `DO $$
       BEGIN
         IF to_regclass('principal_links') IS NULL THEN RETURN; END IF;
         INSERT INTO users(id)
           SELECT DISTINCT ${fold("json->>'canonicalId'")} FROM principal_links
          WHERE coalesce(btrim(json->>'canonicalId'), '') <> ''
         ON CONFLICT (id) DO NOTHING;
         INSERT INTO user_links(alias_id, user_id, evidence, linked_by, created_at)
           SELECT ${fold("id")}, ${fold("json->>'canonicalId'")}, coalesce(json->>'evidence', ''),
                  coalesce(json->>'linkedBy', ''), to_timestamp(coalesce((json->>'createdAt')::double precision, 0) / 1000)
             FROM principal_links
            WHERE coalesce(btrim(json->>'canonicalId'), '') <> ''
              AND ${fold("id")} <> ${fold("json->>'canonicalId'")}
         ON CONFLICT (alias_id) DO NOTHING;
       END $$`,
    ],
  },
  {
    id: "users/0003-turn-backfill",
    statements: [
      `INSERT INTO users AS u(id, first_seen_at, source)
       SELECT coalesce(l.user_id, a.author), MIN(a.at), 'turn'
         FROM (SELECT ${fold("e.author")} AS author, e.created_at AS at
                 FROM items e
                 JOIN sessions s ON s.id = e.session_id
                WHERE e.tenant_id = qm_tenant_id()
                  AND e.author IS NOT NULL AND e.author NOT LIKE 'system:%'
                  AND e.kind IN ('UserMessage', 'SteeringMessage')
                  AND NOT (e.body @> '{"overheard":true}')
                  AND s.origin = 'conversation' AND s.parent_session_id IS NULL) a
         LEFT JOIN user_links l ON l.alias_id = a.author
        WHERE a.author <> ''
        GROUP BY 1
       ON CONFLICT (id) DO UPDATE SET first_seen_at = EXCLUDED.first_seen_at, source = EXCLUDED.source
         WHERE u.first_seen_at IS NULL`,
    ],
  },
];

const COLUMNS = `id, ${msOf("first_seen_at")} AS first_seen_at, source, ${msOf("offboarded_at")} AS offboarded_at, offboarded_by`;
const LINK_COLUMNS = `alias_id, user_id, evidence, linked_by, ${msOf("created_at")} AS created_at`;
const ts = (param: string): string => `to_timestamp(${param}::double precision / 1000)`;
const resolved = (param: string): string =>
  `coalesce((SELECT user_id FROM user_links WHERE alias_id = ${param}), ${param})`;

function toRecord(r: Record<string, unknown>): UserRecord {
  return {
    id: r.id as string,
    ...(r.first_seen_at != null ? { firstSeenAt: Number(r.first_seen_at), source: r.source as UserSource } : {}),
    ...(r.offboarded_at != null
      ? { offboardedAt: Number(r.offboarded_at), offboardedBy: r.offboarded_by as string }
      : {}),
  };
}

function toLink(r: Record<string, unknown>): UserLink {
  return {
    principalId: r.alias_id as string,
    canonicalId: r.user_id as string,
    evidence: r.evidence as string,
    linkedBy: r.linked_by as string,
    createdAt: Number(r.created_at),
  };
}

async function linkInTransaction(client: PoolClient, link: UserLink): Promise<UserLink> {
  await client.query(`LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE`);
  const existing = await client.query(`SELECT ${LINK_COLUMNS} FROM user_links WHERE alias_id = $1`, [link.principalId]);
  if (existing.rows[0]) return toLink(existing.rows[0]);
  await client.query(`INSERT INTO users(id) VALUES ($1) ON CONFLICT (id) DO NOTHING`, [link.canonicalId]);
  await client.query(
    `UPDATE users c SET
       first_seen_at = least(c.first_seen_at, a.first_seen_at),
       source = CASE WHEN a.first_seen_at < c.first_seen_at OR c.first_seen_at IS NULL THEN a.source ELSE c.source END,
       offboarded_at = least(c.offboarded_at, a.offboarded_at),
       offboarded_by = CASE WHEN a.offboarded_at < c.offboarded_at OR c.offboarded_at IS NULL
                            THEN a.offboarded_by ELSE c.offboarded_by END
     FROM users a WHERE c.id = $1 AND a.id = $2`,
    [link.canonicalId, link.principalId],
  );
  await client.query(`DELETE FROM users WHERE id = $1`, [link.principalId]);
  const inserted = await client.query(
    `INSERT INTO user_links(alias_id, user_id, evidence, linked_by, created_at) VALUES ($1, $2, $3, $4, ${ts("$5")})
     RETURNING ${LINK_COLUMNS}`,
    [link.principalId, link.canonicalId, link.evidence, link.linkedBy, link.createdAt],
  );
  return toLink(inserted.rows[0]);
}

export function createPostgresUserStore(connectionString: string): UserStore {
  const pg = createPgPool(connectionString, [...DIRECTORY_MIGRATIONS, ...SESSION_MIGRATIONS, ...USER_MIGRATIONS]);
  const { q } = pg;
  return {
    async all() {
      return (await q(`SELECT ${COLUMNS} FROM users`)).map(toRecord);
    },
    async fillFirstSeen(people) {
      if (!people.length) return [];
      const rows = await q(
        `INSERT INTO users AS u(id, first_seen_at, source)
         SELECT DISTINCT ON (id) id, ${ts("at")}, source
           FROM (SELECT coalesce(l.user_id, t.id) AS id, t.at, t.source
                   FROM unnest($1::text[], $2::bigint[], $3::text[]) AS t(id, at, source)
                   LEFT JOIN user_links l ON l.alias_id = t.id) r
          ORDER BY id, at
         ON CONFLICT (id) DO UPDATE SET first_seen_at = EXCLUDED.first_seen_at, source = EXCLUDED.source
           WHERE u.first_seen_at IS NULL
         RETURNING ${COLUMNS}`,
        [people.map((p) => p.id), people.map((p) => p.at), people.map((p) => p.source)],
      );
      return rows.map(toRecord);
    },
    async markOffboarded(id, by, at) {
      const rows = await q(
        `INSERT INTO users AS u(id, offboarded_at, offboarded_by) VALUES (${resolved("$1")}, ${ts("$3")}, $2)
         ON CONFLICT (id) DO UPDATE SET offboarded_at = coalesce(u.offboarded_at, EXCLUDED.offboarded_at),
           offboarded_by = CASE WHEN u.offboarded_at IS NULL THEN EXCLUDED.offboarded_by ELSE u.offboarded_by END
         RETURNING ${COLUMNS}`,
        [id, by, at],
      );
      return toRecord(rows[0]!);
    },
    async clearOffboarded(id) {
      const rows = await q(
        `UPDATE users SET offboarded_at = NULL, offboarded_by = NULL WHERE id = ${resolved("$1")} RETURNING ${COLUMNS}`,
        [id],
      );
      return rows[0] ? toRecord(rows[0]) : null;
    },
    async links() {
      return (await q(`SELECT ${LINK_COLUMNS} FROM user_links`)).map(toLink);
    },
    async link(link) {
      return withPgTransaction(await pg.pool(), (client) => linkInTransaction(client, link));
    },
    async unlink(aliasId) {
      const rows = await q(`DELETE FROM user_links WHERE alias_id = $1 RETURNING ${LINK_COLUMNS}`, [aliasId]);
      return rows[0] ? toLink(rows[0]) : null;
    },
  };
}
