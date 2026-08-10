import { existsSync } from "node:fs";
import { hostname } from "node:os";
import type { Deployment, DeploymentVersion } from "./deploy-store.ts";
import type { DeployEndpoint, DeployProvider } from "./deploy-provider.ts";
import { spawnDockerExec, type DockerExec } from "../sandbox/docker-exec.ts";

const NETWORK = "agent-deploynet";
const APP_PORT = 8080;

/**
 * Whether core is itself running in a container, talking to the host's docker daemon through
 * a mounted socket. It changes two things about how an app is deployed, both of them the same
 * mistake in different clothes — assuming the daemon shares core's filesystem and its loopback:
 *
 * - a `-v /data/…:/app` bind is resolved by the DAEMON, against the HOST's filesystem, where
 *   core's `/data` volume does not exist. Docker then creates the missing path silently, so
 *   the app boots with an empty `/app` and dies on its own entrypoint. Files go in over
 *   `docker cp` instead, which the client reads and streams, so core-local paths work.
 * - a `-p 127.0.0.1:<port>` publish lands on the HOST's loopback, which is not core's, so the
 *   endpoint core stores is one it can never dial. On a shared network the container is
 *   reachable by name instead, exactly as `LOCAL_SANDBOX_SHARED_NETWORK` does for sandboxes.
 *
 * On the host dev loop none of that applies and the published port is the only way in, so the
 * original behaviour is kept.
 */
const IN_CONTAINER = existsSync("/.dockerenv");

export interface DockerDeployProviderOptions {
  image?: string;
  docker?: string;
  basePort?: number;
  /** Test seam: overrides the containerised-core detection. */
  inContainer?: boolean;
  /** Test seam: stands in for the docker CLI. */
  exec?: DockerExec;
  /** Test seam: the container name core would connect to the deploy network. */
  self?: string;
}

export function createDockerDeployProvider(opts: DockerDeployProviderOptions = {}): DeployProvider {
  const docker = opts.docker ?? "docker";
  const image = opts.image ?? "node:24-alpine";
  let nextPort = opts.basePort ?? 9200;
  const ports = new Map<string, number>();
  const freed: number[] = [];
  const allocPort = (n: string): number => {
    const existing = ports.get(n);
    if (existing !== undefined) return existing;
    const port = freed.pop() ?? nextPort++;
    ports.set(n, port);
    return port;
  };
  const freePort = (n: string): void => {
    const p = ports.get(n);
    if (p !== undefined) {
      freed.push(p);
      ports.delete(n);
    }
  };

  const dexec = opts.exec ?? spawnDockerExec(docker);
  const inContainer = opts.inContainer ?? IN_CONTAINER;

  const name = (d: Deployment) => `agent-deploy-${d.id.slice(0, 12)}`;

  /**
   * Puts core on the deploy network so it can reach apps by container name. Deliberately the
   * other direction from the obvious fix — putting the apps on core's network would also let
   * them reach the database and everything else that lives there; this way an app can only
   * see core, which already authenticates every route.
   *
   * Idempotent: docker errors when the container is already attached, and that is the steady
   * state after the first deploy.
   */
  async function joinDeployNetwork(): Promise<void> {
    const self = (opts.self ?? hostname()).trim();
    if (!self) return;
    const r = await dexec(["network", "connect", NETWORK, self]);
    if (r.code !== 0 && !/already exists|already connected/i.test(r.stderr)) {
      throw new Error(`could not put core on ${NETWORK}: ${r.stderr.trim()}`);
    }
  }

  return {
    profile: { managedScaleToZero: false },

    async apply(d: Deployment, version: DeploymentVersion): Promise<DeployEndpoint> {
      await dexec(["network", "create", NETWORK]);
      if (inContainer) await joinDeployNetwork();
      await dexec(["rm", "-f", name(d)]);
      const hostPort = allocPort(name(d));
      const envArgs = Object.entries(version.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
      const created = await dexec([
        // Created, not run: the app's files have to be in place before its entrypoint gets a
        // chance to look for them.
        "create",
        "--name",
        name(d),
        "--network",
        NETWORK,
        // Survive a host reboot without a manual restart. `destroy()` uses `rm -f`, which removes
        // the container regardless of policy, so a deliberate teardown is unaffected; only an
        // unplanned stop (reboot, daemon restart) is auto-recovered.
        "--restart",
        "unless-stopped",
        "--memory",
        "512m",
        "--cpus",
        "1",
        "--pids-limit",
        "256",
        ...(inContainer ? [] : ["-p", `127.0.0.1:${hostPort}:${APP_PORT}`]),
        ...(inContainer ? [] : ["-v", `${version.snapshotDir}:/app:ro`]),
        "-w",
        "/app",
        "-e",
        `PORT=${APP_PORT}`,
        ...envArgs,
        image,
        "sh",
        "-c",
        version.entrypoint,
      ]);
      if (created.code !== 0) {
        freePort(name(d));
        throw new Error(`deploy create failed: ${created.stderr.trim()}`);
      }

      if (inContainer) {
        // The trailing `/.` is load-bearing: `-w /app` already created `/app`, so naming the
        // snapshot directory alone would copy it INTO that directory and the entrypoint would
        // be looking at `/app/<snapshot-id>/server.js`. `/.` means "this directory's contents".
        //
        // Unlike the bind mount this leaves the files writable by the app; the isolation that
        // matters (memory, cpu, pids, its own network) is unchanged, and a snapshot is a copy,
        // so writing to it cannot corrupt the stored version.
        const copied = await dexec(["cp", `${version.snapshotDir}/.`, `${name(d)}:/app`]);
        if (copied.code !== 0) {
          await dexec(["rm", "-f", name(d)]);
          freePort(name(d));
          throw new Error(`deploy file copy failed: ${copied.stderr.trim()}`);
        }
      }

      const started = await dexec(["start", name(d)]);
      if (started.code !== 0) {
        await dexec(["rm", "-f", name(d)]);
        freePort(name(d));
        throw new Error(`deploy start failed: ${started.stderr.trim()}`);
      }
      return inContainer ? { host: name(d), port: APP_PORT } : { host: "127.0.0.1", port: hostPort };
    },

    async destroy(d: Deployment): Promise<void> {
      await dexec(["rm", "-f", name(d)]);
      freePort(name(d));
    },
  };
}
