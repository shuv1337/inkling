/**
 * Push a shelf row and pull it back, then pull again from the returned clock.
 * Requires DATABASE_URL and a migrated database. `npm run db:roundtrip`.
 */
import assert from "node:assert/strict";
import { articleDoc, closeDb, db, pullRows, pushRows } from "../lib/db";

const user = "roundtrip-test";

const doc = {
  id: "a1",
  title: "Round trip",
  blocks: [{ id: "b1", type: "p", runs: [{ text: "Hello from local Postgres." }] }],
};

async function main() {
  const sql = db();
  await sql.query("delete from articles where user_id = $1", [user]);
  await sql.query("delete from highlights where user_id = $1", [user]);
  await sql.query("delete from covers where user_id = $1", [user]);

  await pushRows(user, {
    articles: [{ id: "a1", article_id: "a1", data: { title: "Round trip", words: 4 }, deleted: false, doc }],
    highlights: [{ id: "h1", article_id: "a1", data: { id: "h1", articleId: "a1", quote: "Hello" }, deleted: false }],
  });

  const stored = await articleDoc(user, "a1");
  assert.equal((stored as { title?: string } | null)?.title, "Round trip");

  const pulled = await pullRows(user, "1970-01-01T00:00:00.000Z");
  assert.equal(pulled.changes.articles.length, 1);
  assert.equal((pulled.changes.articles[0]?.data as { title?: string }).title, "Round trip");
  assert.equal(pulled.changes.highlights.length, 1);
  assert.equal(pulled.changes.glosses.length, 0);

  const again = await pullRows(user, pulled.now);
  assert.equal(again.changes.articles.length, 0);
  assert.equal(again.changes.highlights.length, 0);

  await sql.query(
    "insert into covers (user_id, id, jpeg) values ($1, $2, $3) on conflict (user_id, id) do update set jpeg = excluded.jpeg",
    [user, "a1", "aGVsbG8="]
  );
  await pushRows(user, { articles: [{ id: "a1", article_id: "a1", data: {}, deleted: true }] });
  const covers = await sql.query("select id from covers where user_id = $1", [user]);
  assert.equal(covers.length, 0);

  await sql.query("delete from articles where user_id = $1", [user]);
  await sql.query("delete from highlights where user_id = $1", [user]);
  console.log("sync round-trip ok");
}

main()
  .then(() => closeDb())
  .catch(async (err: unknown) => {
    console.error(err);
    await closeDb();
    process.exit(1);
  });
