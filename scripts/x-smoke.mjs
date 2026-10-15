/**
 * One live post, when the network allows it. A failure skips; it is not a test.
 *   node --env-file-if-exists=.env.local --import tsx scripts/x-smoke.mjs
 */
import { fetchXPost } from "../lib/x-post.ts";

const id = process.argv[2] || "2110385721391366263";

const result = await fetchXPost(`https://x.com/i/status/${id}`, { signal: AbortSignal.timeout(20_000) });
if (!result.ok) {
  console.log(`skipped: ${result.error}`);
  process.exit(0);
}
console.log(`${result.article.id} ${result.article.title} — ${result.article.author ?? "unknown"} (${result.article.blocks.length} blocks)`);
process.exit(0);
