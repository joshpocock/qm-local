#!/usr/bin/env node
// qm-local: cross-platform replacement for local-sandbox-build.sh, so building
// the local sandbox runtime does not require bash. Same output, same tags.
//
//   node scripts/local-sandbox-build.mjs
//
// Honors LOCAL_SANDBOX_IMAGE for the output tag. If FLY_SANDBOX_APP_NAME is set
// and flyctl is on PATH, the base is built on Fly's remote amd64 builder and
// pulled, matching the shell script; otherwise it builds locally.
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE_TAG = "qm-sandbox-base:dev";
const LOCAL_TAG = process.env.LOCAL_SANDBOX_IMAGE?.trim() || "qm-sandbox-local:latest";
const PLATFORM = "linux/amd64";

function run(command, args, what) {
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: "inherit", shell: false });
  if (result.error?.code === "ENOENT") fail(`${command} is not installed or not on PATH (needed to ${what})`);
  if (result.status !== 0) fail(`${what} failed (${command} exited ${result.status ?? result.signal})`);
}

function has(command) {
  const probe = process.platform === "win32" ? ["where", [command]] : ["/bin/sh", ["-c", `command -v ${command}`]];
  return spawnSync(probe[0], probe[1], { stdio: "ignore", shell: false }).status === 0;
}

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

const fingerprintSrc = `
const { computeSandboxImageFingerprint } = await import("./src/sandbox/local-sandbox.ts");
const fp = await computeSandboxImageFingerprint(process.cwd());
if (!fp) { console.error("cannot compute sandbox image fingerprint (missing sources)"); process.exit(1); }
console.log(fp);
`;
const fingerprintRun = spawnSync(process.execPath, ["--input-type=module", "-e", fingerprintSrc], {
  cwd: repoRoot,
  encoding: "utf8",
  shell: false,
});
if (fingerprintRun.status !== 0) {
  fail(`could not compute the sandbox image fingerprint:\n${fingerprintRun.stderr?.trim() ?? ""}`);
}
const fingerprint = fingerprintRun.stdout.trim();

const flyApp = process.env.FLY_SANDBOX_APP_NAME?.trim();
if (flyApp && has("flyctl")) {
  const baseRef = `registry.fly.io/${flyApp}:dev`;
  console.log(`==> building ${baseRef} from fly/Dockerfile on Fly's remote amd64 builder`);
  run(
    "flyctl",
    ["deploy", "--build-only", "--push", "--remote-only", "--image-label", "dev",
      "--app", flyApp, "-c", "fly/fly.toml", "--dockerfile", "fly/Dockerfile", ".", "--yes"],
    "build the sandbox base on Fly",
  );
  run("flyctl", ["auth", "docker"], "authenticate docker against the Fly registry");
  run("docker", ["pull", "--platform", PLATFORM, baseRef], "pull the sandbox base image");
  run("docker", ["tag", baseRef, BASE_TAG], "tag the sandbox base image");
} else {
  console.log(`==> building ${BASE_TAG} from fly/Dockerfile (${PLATFORM})`);
  run("docker", ["build", "--platform", PLATFORM, "-f", "fly/Dockerfile", "-t", BASE_TAG, "."],
    "build the sandbox base image");
}

console.log(`==> building ${LOCAL_TAG} from local/Dockerfile (fingerprint ${fingerprint})`);
run(
  "docker",
  ["build", "--platform", PLATFORM, "-f", "local/Dockerfile", "--build-arg", `BASE=${BASE_TAG}`,
    "--label", `qm.sandbox-fingerprint=${fingerprint}`, "-t", LOCAL_TAG, "."],
  "build the local sandbox image",
);

console.log(`==> done: ${LOCAL_TAG}`);
