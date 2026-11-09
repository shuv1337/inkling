import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve("deploy/swap-build.sh");
const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();

function fixture(depsChanged: boolean, failure = "") {
  const root = mkdtempSync(join(tmpdir(), "inkling-swap-"));
  const live = join(root, "live"), build = join(root, "build"), backup = join(root, "backup"), bin = join(root, "bin");
  mkdirSync(live); mkdirSync(bin);
  const git = (...args: string[]) => execFileSync(realGit, ["-C", live, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "selfhost");
  git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.com");
  writeFileSync(join(live, ".gitignore"), "node_modules\n.next\n");
  writeFileSync(join(live, "package.json"), '{"version":"1"}');
  writeFileSync(join(live, "page.txt"), "old");
  git("add", "."); git("commit", "-m", "old");
  const old = git("rev-parse", "HEAD");
  writeFileSync(join(live, "page.txt"), "new");
  if (depsChanged) writeFileSync(join(live, "package.json"), '{"version":"2"}');
  git("add", "."); git("commit", "-m", "new");
  const rev = git("rev-parse", "HEAD");
  git("worktree", "add", "--detach", build, rev);
  git("reset", "--hard", old);
  for (const [path, id] of [[live, "old"], [build, "new"]]) {
    mkdirSync(join(path, ".next")); writeFileSync(join(path, ".next", "BUILD_ID"), id);
  }
  mkdirSync(join(live, "node_modules")); writeFileSync(join(live, "node_modules", "version"), "old-deps");
  const stub = (name: string, code: string) => writeFileSync(join(bin, name), `#!/usr/bin/env bash\nset -eu\n${code}\n`, { mode: 0o755 });
  stub("git", `if [[ "$*" == *"merge --ff-only"* && "$FAIL" == merge ]]; then exit 1; fi\nexec "$REAL_GIT" "$@"`);
  stub("npm", `echo npm-ci >> "$LOG"\nmkdir -p node_modules\nprintf new-deps > node_modules/version\n[[ "$FAIL" != npm ]]`);
  stub("mv", `if [[ "$1" == */incoming && "$FAIL" == swap ]]; then exit 1; fi\nexec /usr/bin/mv "$@"`);
  stub("systemctl", `echo "$*" >> "$LOG"\nif [[ "$*" == *status* ]]; then exit 3; fi\nif [[ "$*" == *is-active* && "$FAIL" == health ]]; then exit 1; fi\nif [[ "$*" == *" start "* && "$FAIL" == start && ! -e "$LOG.start-failed" ]]; then touch "$LOG.start-failed"; exit 1; fi`);
  stub("journalctl", `echo logs >> "$LOG"`);
  stub("curl", `if [[ "$FAIL" == gate ]]; then printf 200; else printf 403; fi`);
  const result = spawnSync("bash", [script, live, build, backup], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, REAL_GIT: realGit, FAIL: failure, LOG: join(root, "calls") },
    encoding: "utf8",
  });
  return { root, live, build, backup, result, old, rev, git, calls: readFileSync(join(root, "calls"), "utf8") };
}

test("swap skips npm ci for unchanged dependencies, tolerates status=3, and cleans worktree", () => {
  const f = fixture(false);
  try {
    assert.equal(f.result.status, 0, f.result.stderr);
    assert.equal(f.git("rev-parse", "HEAD"), f.rev);
    assert.equal(readFileSync(join(f.live, ".next/BUILD_ID"), "utf8"), "new");
    assert.equal(readFileSync(join(f.backup, "next/BUILD_ID"), "utf8"), "old");
    assert.ok(!f.calls.includes("npm-ci"));
    assert.ok(f.calls.includes("logs"));
    assert.ok(!existsSync(f.build));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("changed dependencies install once and retain old node_modules for manual rollback", () => {
  const f = fixture(true);
  try {
    assert.equal(f.result.status, 0, f.result.stderr);
    assert.equal(f.calls.split("npm-ci").length - 1, 1);
    assert.equal(readFileSync(join(f.backup, "node_modules/version"), "utf8"), "old-deps");
    assert.equal(readFileSync(join(f.live, "node_modules/version"), "utf8"), "new-deps");
    assert.ok(!existsSync(f.build));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

for (const failure of ["merge", "npm", "swap", "start", "health", "gate"]) {
  test(`failed ${failure} restores source/build/dependencies and restarts without network`, () => {
    const f = fixture(failure === "npm", failure);
    try {
      assert.notEqual(f.result.status, 0);
      assert.equal(f.git("rev-parse", "HEAD"), f.old);
      assert.equal(readFileSync(join(f.live, ".next/BUILD_ID"), "utf8"), "old");
      assert.equal(readFileSync(join(f.live, "node_modules/version"), "utf8"), "old-deps");
      assert.ok(f.calls.includes("--user start gloss.service"));
      assert.equal(f.calls.split("npm-ci").length - 1, failure === "npm" ? 1 : 0);
      assert.ok(!existsSync(f.build));
      if (failure === "start" || failure === "health" || failure === "gate") assert.equal(readFileSync(join(f.backup, "failed-next/BUILD_ID"), "utf8"), "new");
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
}
