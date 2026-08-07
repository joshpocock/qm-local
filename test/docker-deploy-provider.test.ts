import { test } from "node:test";
import assert from "node:assert/strict";
import { createDockerDeployProvider } from "../src/deploy/docker-deploy-provider.ts";
import type { Deployment, DeploymentVersion } from "../src/deploy/deploy-store.ts";
import type { DockerExec } from "../src/sandbox/docker-exec.ts";

const SNAPSHOT = "/data/deployments/snap-1";

function fakeDocker(fail?: { on: string; stderr?: string }) {
  const calls: string[][] = [];
  const exec: DockerExec = async (args) => {
    calls.push([...args]);
    const code = fail && args[0] === fail.on ? 1 : 0;
    return { code, stdout: "", stderr: code ? (fail?.stderr ?? "boom") : "" };
  };
  const find = (verb: string): string[] | undefined => calls.find((c) => c[0] === verb);
  return { calls, exec, find };
}

const deployment = { id: "abcdef012345678", name: "crm" } as unknown as Deployment;
const version = { snapshotDir: SNAPSHOT, entrypoint: "node server.js" } as unknown as DeploymentVersion;
const NAME = "agent-deploy-abcdef012345";

// ---------------------------------------------------------------------------
// Containerised core — the deployment target this repo actually runs
// ---------------------------------------------------------------------------

test("files go in over docker cp, never a bind the host daemon cannot resolve", async () => {
  const d = fakeDocker();
  const provider = createDockerDeployProvider({ exec: d.exec, inContainer: true, self: "core-1" });
  await provider.apply(deployment, version);

  const create = d.find("create");
  assert.ok(create, "the container is created before it is started");
  assert.equal(
    create.some((a) => a.startsWith(SNAPSHOT)),
    false,
    "the snapshot dir is never handed to the daemon as a bind — it does not exist on the host",
  );
  // The trailing `/.` matters: `-w /app` creates /app, so copying the directory itself would
  // nest it as /app/<snapshot-id>/ and the entrypoint would not find its own files.
  assert.deepEqual(d.find("cp"), ["cp", `${SNAPSHOT}/.`, `${NAME}:/app`]);
  assert.ok(d.find("start"), "and only then is it started");
});

test("the copy happens between create and start, or the app races its own files", async () => {
  const d = fakeDocker();
  const provider = createDockerDeployProvider({ exec: d.exec, inContainer: true, self: "core-1" });
  await provider.apply(deployment, version);

  const verbs = d.calls.map((c) => c[0]);
  assert.ok(verbs.indexOf("create") < verbs.indexOf("cp"), "cp after create");
  assert.ok(verbs.indexOf("cp") < verbs.indexOf("start"), "start after cp");
});

test("the endpoint is the container name, which is the only address core can dial", async () => {
  const d = fakeDocker();
  const provider = createDockerDeployProvider({ exec: d.exec, inContainer: true, self: "core-1" });
  const endpoint = await provider.apply(deployment, version);

  assert.deepEqual(endpoint, { host: NAME, port: 8080 });
  assert.equal(
    d.find("create")?.includes("-p"),
    false,
    "no host publish: that port would land on the host's loopback, not core's",
  );
});

test("core joins the deploy network so the name resolves", async () => {
  const d = fakeDocker();
  const provider = createDockerDeployProvider({ exec: d.exec, inContainer: true, self: "core-1" });
  await provider.apply(deployment, version);

  assert.deepEqual(d.calls[1], ["network", "connect", "agent-deploynet", "core-1"]);
});

test("an already-attached core is the steady state, not an error", async () => {
  const d = fakeDocker({ on: "network", stderr: "endpoint with name core-1 already exists in network" });
  const provider = createDockerDeployProvider({ exec: d.exec, inContainer: true, self: "core-1" });
  await assert.doesNotReject(() => provider.apply(deployment, version));
});

test("a failed copy takes the half-built container with it", async () => {
  const d = fakeDocker({ on: "cp" });
  const provider = createDockerDeployProvider({ exec: d.exec, inContainer: true, self: "core-1" });
  await assert.rejects(() => provider.apply(deployment, version), /deploy file copy failed/);
  assert.ok(
    d.calls.some((c) => c[0] === "rm" && c.includes(NAME)),
    "the container is removed rather than left behind holding a name and a port",
  );
  assert.equal(
    d.calls.some((c) => c[0] === "start"),
    false,
    "and it is never started with an empty /app",
  );
});

// ---------------------------------------------------------------------------
// Core on the host — the dev loop, where the old behaviour is still right
// ---------------------------------------------------------------------------

test("on the host the snapshot is bind-mounted read-only and the port is published", async () => {
  const d = fakeDocker();
  const provider = createDockerDeployProvider({ exec: d.exec, inContainer: false, basePort: 9200 });
  const endpoint = await provider.apply(deployment, version);

  const create = d.find("create");
  assert.ok(create?.includes(`${SNAPSHOT}:/app:ro`), "the daemon shares the filesystem here, so a bind is correct");
  assert.ok(create?.includes(`127.0.0.1:9200:8080`));
  assert.deepEqual(endpoint, { host: "127.0.0.1", port: 9200 });
  assert.equal(
    d.calls.some((c) => c[0] === "cp"),
    false,
    "no copy needed",
  );
});

test("on the host core does not touch the deploy network's membership", async () => {
  const d = fakeDocker();
  const provider = createDockerDeployProvider({ exec: d.exec, inContainer: false });
  await provider.apply(deployment, version);

  assert.equal(
    d.calls.some((c) => c[0] === "network" && c[1] === "connect"),
    false,
  );
});

// ---------------------------------------------------------------------------
// Unchanged in both modes
// ---------------------------------------------------------------------------

test("the entrypoint and env still ride on the container", async () => {
  const d = fakeDocker();
  const provider = createDockerDeployProvider({ exec: d.exec, inContainer: true, self: "core-1" });
  await provider.apply(
    deployment,
    { ...version, env: { API_KEY: "k" } } as unknown as DeploymentVersion,
  );

  const create = d.find("create")!;
  assert.deepEqual(create.slice(-3), ["sh", "-c", "node server.js"]);
  assert.ok(create.includes("API_KEY=k"));
  assert.ok(create.includes("PORT=8080"));
  assert.deepEqual(create.slice(create.indexOf("-w"), create.indexOf("-w") + 2), ["-w", "/app"]);
});

test("destroy removes the container and returns its port to the pool", async () => {
  const d = fakeDocker();
  const provider = createDockerDeployProvider({ exec: d.exec, inContainer: false, basePort: 9200 });
  await provider.apply(deployment, version);
  await provider.destroy(deployment);

  assert.ok(d.calls.some((c) => c[0] === "rm" && c.includes(NAME)));
  const second = await provider.apply({ ...deployment, id: "999999999999999" } as Deployment, version);
  assert.deepEqual(second, { host: "127.0.0.1", port: 9200 }, "the freed port is reused");
});
