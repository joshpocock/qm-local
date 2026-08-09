import type { Destination, OutgoingAttachment } from "../types.ts";
import type { Run, RunStore } from "../runs/run-store.ts";
import type { DeliveryStore } from "./delivery-store.ts";
import type { Task, TaskStore } from "../tasks/task-store.ts";
import { SECURITY_QUARANTINE_REFUSAL_TEXT } from "../../plugins/chassis/src/security-quarantine.ts";
import { resolveTurnOrigin } from "../core/turn-origin.ts";
import { personaPostIdentity } from "./persona-identity.ts";
import { isPanelPass } from "../agents/panel-driver.ts";

export interface RunResultDelivery {
  destination: Destination;
  text: string;
  attachments?: OutgoingAttachment[];
  idempotencyKey: string;
}

export function runResultDelivery(run: Run, taskList: Task[] = []): RunResultDelivery | null {
  const target = run.request.deliveryTarget;
  const surface = run.request.surface;
  if (!target || !surface) return null;
  const editRef = run.deliveryState?.editRef;
  // A panel CONTINUATION turn has no handler waiting on it: the surface submitted one turn and
  // is holding the first persona's reply, while the driver runs the rest in the background. Its
  // reply reaches the surface only through this queue, so it is tagged with its author — a
  // surface that gives each persona its own identity posts it as that persona. The FIRST turn
  // is deliberately left untagged: its handler posts it inline and this copy is pure recovery,
  // which keeps today's recovery semantics byte-for-byte.
  const panelAuthor = run.request.panel?.continuation ? run.request.panel.persona?.id : undefined;
  const destination: Destination = {
    type: surface,
    target,
    ...(editRef ? { editRef } : {}),
    ...(taskList.length ? { taskList: taskList.map(({ id, title, status }) => ({ id, title, status })) } : {}),
    ...(surface === "slack" && panelAuthor ? { identity: personaPostIdentity(panelAuthor) } : {}),
  };
  const idempotencyKey = `run:${run.id}`;
  if (
    surface === "slack" &&
    run.result?.status === "refused" &&
    run.result.refusalKind === "security_quarantine" &&
    run.request.addressed
  ) {
    return { destination, text: SECURITY_QUARANTINE_REFUSAL_TEXT, idempotencyKey };
  }
  // A persona that had nothing to add said nothing, and a surface must not see it either, or a
  // quiet room fills with the word PASS. Quiet arrives in three shapes and all three are the
  // same non-event here: the literal PASS reply (`isPanelPass` trims, so `"PASS\n"` and
  // `" PASS "` are it too — the driver's matcher, never a second copy of the rule), a
  // `status: "silent"` result, and a result carrying no reply text at all. The last two are
  // what a spine-routed Slack panel turn actually produces: the reply never rides back on the
  // result, so a delivery built from it would post nothing useful anyway. Attachments still
  // travel — a persona that uploaded a file was not quiet.
  // A turn that BROKE is not quiet — it keeps the failure notice the branch below posts.
  if (
    run.request.panel &&
    !run.result?.attachments?.length &&
    run.status !== "failed" &&
    run.result?.status !== "failed" &&
    run.result?.status !== "refused" &&
    (run.result?.status === "silent" || isPanelPass(run.result?.reply) || !(run.result?.reply ?? "").trim())
  )
    return null;
  if (run.request.surfaceTools && run.result?.status !== "failed" && !run.result?.attachments?.length) return null;
  if (run.status === "failed") {
    if (resolveTurnOrigin(run.request).kind === "ambient") return null;
    const reason = run.result?.reason ?? "unknown error";
    return { destination, text: `⚠️ I couldn't finish that turn: ${reason}`, idempotencyKey };
  }
  if (run.result?.status === "ok" && (run.result.reply || run.result.attachments?.length)) {
    return {
      destination,
      text: run.result.reply ?? "",
      ...(run.result.attachments?.length ? { attachments: run.result.attachments } : {}),
      idempotencyKey,
    };
  }
  return null;
}

export function wireRunResultDeliveries(runs: RunStore, deliveries: DeliveryStore, tasks?: TaskStore): void {
  runs.onTerminal((run) => {
    void (async () => {
      const taskList = tasks ? await tasks.list({ originRunId: run.id }) : [];
      const delivery = runResultDelivery(run, taskList);
      if (!delivery) return;
      await deliveries.enqueue(delivery);
    })().catch((err) => console.error(`[delivery] failed to enqueue recovery delivery for run ${run.id}:`, err));
  });
}
