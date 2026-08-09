import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeRepoUrl } from "../src/skills/pack-fetcher.ts";

test("a browser branch URL becomes a clonable repo URL plus its ref", () => {
  assert.deepEqual(normalizeRepoUrl("https://github.com/mattpocock/skills/tree/main"), {
    url: "https://github.com/mattpocock/skills",
    ref: "main",
  });
});

test("a subdirectory in the browsing URL is kept as the subdir", () => {
  assert.deepEqual(normalizeRepoUrl("https://github.com/acme/packs/tree/v2/skills/writing"), {
    url: "https://github.com/acme/packs",
    ref: "v2",
    subdir: "skills/writing",
  });
});

test("blob URLs normalize the same way as tree URLs", () => {
  const out = normalizeRepoUrl("https://gitlab.com/acme/packs/blob/release/README.md");
  assert.equal(out.url, "https://gitlab.com/acme/packs");
  assert.equal(out.ref, "release");
});

test("a plain repo URL is left alone", () => {
  assert.deepEqual(normalizeRepoUrl("https://github.com/mattpocock/skills"), {
    url: "https://github.com/mattpocock/skills",
  });
});

test("non-http remotes are never rewritten", () => {
  assert.deepEqual(normalizeRepoUrl("git@github.com:acme/packs.git"), { url: "git@github.com:acme/packs.git" });
});

test("a path that merely contains the word tree is not treated as a branch page", () => {
  assert.deepEqual(normalizeRepoUrl("https://github.com/acme/tree"), { url: "https://github.com/acme/tree" });
});
