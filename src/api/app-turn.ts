import {
  ROOM_DEFAULT_ROUNDS,
  ROOM_MAX_ROUNDS,
  type Conversation,
  type Principal,
  type RoomConfig,
  type Session,
  type TurnRequest,
  type TurnResult,
} from "../types.ts";
import { agentRoomsEnabled, orgId as orgIdOf } from "../config.ts";
import {
  panelAddressed,
  panelMembersFrom,
  requestedPanelRounds,
  runPanel,
  type PanelMember,
  type PanelState,
  type PanelTurnOutcome,
  type PanelTurnSpec,
} from "../agents/panel-driver.ts";
import { scopeId } from "../types.ts";
import { isHalt, routeWake, type Wake } from "../wake/wake.ts";
import type { OrchestratorInput } from "../core/orchestrator.ts";
import { resolveTurnOrigin } from "../core/turn-origin.ts";
import { isTerminal, leaseLapsed } from "../runs/run-store.ts";
import { turnModelOptions, validateWebTurnModelOptions, webTurnRuntimeModelRefusal } from "../core/turn-options.ts";
import { isProjectGroupRef, projectIdFromGroupRef } from "../projects/project-store.ts";
import { resolveThreadRootSeq } from "../sessions/session-store.ts";
import {
  defaultModelForHarness,
  isHarnessId,
  modelProviderAvailabilityFor,
  modelServiceable,
} from "../model/pi-models.ts";
import { selectableCatalogForHarness, selectableModelCatalog } from "../model/model-catalog.ts";
import { resolveRuntimeChoiceDurable } from "../harness/harness-router.ts";
import { errMessage } from "../util/errors.ts";

import type { App, AppDeps } from "./app-types.ts";
import { STALE_LEASE_GRACE_MS } from "./app-types.ts";
import { visiblePersonasFor } from "./app-agents.ts";
import { unscreenedNotice } from "../security/security-posture.ts";
import type { AppHelpers } from "./app-helpers.ts";
import type { AmbientHelpers } from "./app-ambient.ts";

type TurnMethods = Pick<
  App,
  | "turn"
  | "getApproval"
  | "subscribeSessionStates"
  | "listSessionApprovals"
  | "pendingApprovalForThread"
  | "getRun"
  | "activeRunForThread"
  | "signalRun"
  | "replayOrphanedRunSignals"
>;

export function createTurnMethods(deps: AppDeps, h: AppHelpers, ambient: AmbientHelpers): TurnMethods {
  const {
    withAdminLink,
    drive,
    approvalRecordIsCurrent,
    approvalVisibleToViewer,
    pendingApprovalForSession,
    pendingApprovalResultForThread,
    mayUseSharedScope,
    viewerMayUseRun,
    sessionsForViewer,
    replayOrphanedRunSignals,
  } = h;
  const { shouldRouteToSpine, markTriggerHandled, addressedWakeText } = ambient;

  /**
   * Panels in flight, keyed by thread. A fresh human message flips `abort` so the driver stops
   * after the persona turn it is already running and the human gets the floor back.
   */
  const activePanels = new Map<string, PanelState>();

  /**
   * A room config arriving on the request itself (the first message of a freshly minted room —
   * the session doesn't exist yet, so `PUT /v1/sessions/:id/room` had nothing to attach it to).
   * Shape and visibility rules are the ones the room route enforces; anything off is a refusal
   * so the client hears about it instead of silently getting a one-agent conversation.
   */
  /**
   * The one rule for `rounds` on a client-supplied room, wherever it arrives: an integer in
   * `1..ROOM_MAX_ROUNDS`, the same bound core enforces on a stored `RoomConfig`.
   */
  const validRounds = (rounds: unknown): rounds is number =>
    typeof rounds === "number" && Number.isInteger(rounds) && rounds >= 1 && rounds <= ROOM_MAX_ROUNDS;
  const ROUNDS_ERROR = `room.rounds must be 1-${ROOM_MAX_ROUNDS}`;

  async function roomFromRequest(
    raw: NonNullable<TurnRequest["room"]>,
    principalId: string,
  ): Promise<{ room: RoomConfig } | { error: string }> {
    const personaIds = raw.personaIds;
    if (
      !Array.isArray(personaIds) ||
      personaIds.length < 1 ||
      personaIds.some((id) => typeof id !== "string" || !id) ||
      new Set(personaIds).size !== personaIds.length
    ) {
      return { error: "room.personaIds must be one or more unique agent ids" };
    }
    const rounds = raw.rounds;
    if (!validRounds(rounds)) return { error: ROUNDS_ERROR };
    const visible = new Map((await visiblePersonasFor(deps, h, principalId)).map((p) => [p.id, p] as const));
    for (const id of personaIds) {
      const persona = visible.get(id);
      if (!persona) return { error: `unknown agent: ${id}` };
      if (!persona.enabled) return { error: `agent ${persona.name} is disabled` };
    }
    return { room: { personaIds, rounds } };
  }

  /**
   * Agents this human message `@tagged` that the actor can see but the room does not hold yet —
   * Slack's "mention someone to invite them", in the order they were tagged. Tags are resolved
   * against the actor's *visible* personas rather than the roster, so a name nobody visible
   * answers to still matches nothing, and a disabled or archived agent still joins nothing
   * (`panelMembersFrom` drops both, and `visiblePersonasFor` never lists archived at all).
   *
   * A candidate whose name a room member already answers to is skipped: the tag is already
   * spoken for by the person in the room, and a same-named outsider must not be dragged in
   * behind it. Two visible strangers sharing a name resolve to the nearer scope, once.
   *
   * There is deliberately no size check here: core caps a room's `rounds` (ROOM_MAX_ROUNDS) but
   * never its roster — `panelMembersFrom` takes every member it is given, and `panelTurnCeiling`
   * bounds the panel by construction — so joins are unlimited for the same reason rosters are.
   */
  async function tagJoiners(
    text: string | undefined,
    roomIds: readonly string[],
    roomMembers: readonly PanelMember[],
    principalId: string,
  ): Promise<PanelMember[]> {
    if (!(text ?? "").includes("@")) return [];
    const inRoom = new Set(roomIds);
    const spokenFor = new Set(roomMembers.map((m) => m.name.toLowerCase()));
    let candidates: PanelMember[];
    try {
      candidates = panelMembersFrom(await visiblePersonasFor(deps, h, principalId)).filter(
        (p) => !inRoom.has(p.id) && !spokenFor.has(p.name.toLowerCase()),
      );
    } catch (err) {
      // Resolving who is visible is not worth failing a human's message over: no join, and the
      // message runs exactly as it does today.
      console.error(`[panel] resolving @tag joins failed: ${errMessage(err)}`);
      return [];
    }
    const joiners: PanelMember[] = [];
    for (const candidate of panelAddressed(text, candidates)) {
      const key = candidate.name.toLowerCase();
      if (spokenFor.has(key)) continue;
      spokenFor.add(key);
      joiners.push(candidate);
    }
    return joiners;
  }

  /**
   * Turns a client's `replyToSeq` into the thread ROOT this turn's message hangs off, or a
   * refusal saying why it could not. Slack semantics: replying to any message in a thread
   * extends that thread, so the ref is resolved to its root here rather than stored raw —
   * a client naming the fifth message of a thread must not nest a thread inside it.
   *
   * Everything is refused rather than quietly ignored, because a reply that silently lands
   * outside the thread it was aimed at is worse than one that never sent: the human sees
   * their message in the wrong place and has no way to tell it went wrong.
   */
  async function resolveReplyRoot(
    replyToSeq: number,
    threadRef: string,
  ): Promise<{ rootSeq: number } | { error: string }> {
    if (!Number.isInteger(replyToSeq) || replyToSeq < 0) {
      return { error: "replyToSeq must be the seq of a message in this conversation" };
    }
    const session = await deps.sessions.getByThread(threadRef);
    if (!session) return { error: "there is no conversation to reply into yet" };
    const entries = await deps.sessions.getEntries(session.id);
    const ref = entries.find((entry) => entry.seq === replyToSeq);
    if (!ref) return { error: "that message isn't in this conversation" };
    if (ref.type !== "user" && ref.type !== "assistant") {
      return { error: "you can only reply to a message" };
    }
    const rootSeq = resolveThreadRootSeq(entries, replyToSeq);
    if (rootSeq === undefined) return { error: "that message isn't part of a thread" };
    return { rootSeq };
  }

  /**
   * The personas that already spoke in a thread — a reply in a thread with no `@tag` goes to
   * THEM, not to the whole room (Slack semantics: answering inside a thread continues that
   * conversation; it does not summon everyone). Membership = assistant entries whose
   * `parentSeq` chain reaches the same root the reply resolves to. Empty when the thread has
   * no persona-attributed replies (e.g. the org default agent answered), which the caller
   * treats as "no restriction".
   */
  async function threadPersonaIds(threadRef: string, replyToSeq: number): Promise<Set<string>> {
    const out = new Set<string>();
    try {
      const session = await deps.sessions.getByThread(threadRef);
      if (!session) return out;
      const entries = await deps.sessions.getEntries(session.id);
      const rootSeq = resolveThreadRootSeq(entries, replyToSeq);
      if (rootSeq === undefined) return out;
      for (const entry of entries) {
        if (entry.type !== "assistant" || entry.seq === undefined) continue;
        if (resolveThreadRootSeq(entries, entry.seq) !== rootSeq) continue;
        const persona = (entry.payload as { persona?: { id?: string } } | null)?.persona;
        if (persona?.id) out.add(persona.id);
      }
    } catch {
      // Best-effort: an unreadable log costs the restriction, never the turn.
    }
    return out;
  }

  /**
   * Writes the "Scout was added to the room" line into the session log, so a join an `@tag`
   * made is visible where it happened rather than only in the audit trail. A `system` entry
   * is what core already uses for this class of event (file-transfer notices, turn failures),
   * which means every surface that renders a transcript renders this for free.
   *
   * It lands BEFORE the message that caused it, because the roster changes before the message
   * is handled and the human's own `user` entry is not written until the first persona turn
   * runs. Best-effort throughout: a session already leased by a run in flight, or a store that
   * refuses the write, costs the note and never the message.
   */
  async function noteRoomJoin(session: Session, joiners: readonly PanelMember[]): Promise<void> {
    if (!joiners.length) return;
    const names = joiners.map((m) => m.name);
    const subject = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
    try {
      const { lease } = await deps.sessions.acquireLease(session.id, "turn");
      if (!lease) {
        console.error(`[panel] session=${session.id} could not lease to record an @tag join`);
        return;
      }
      try {
        await deps.sessions.append(lease, {
          type: "system",
          payload: {
            kind: "agent_room_join",
            personas: joiners.map((m) => ({ id: m.id, name: m.name })),
            text: `${subject} ${names.length === 1 ? "was" : "were"} added to the room`,
          },
          scopeLabel: session.scopeId,
        });
      } finally {
        await deps.sessions.releaseLease(lease);
      }
    } catch (err) {
      console.error(`[panel] session=${session.id} recording an @tag join failed: ${errMessage(err)}`);
    }
  }

  /**
   * An ordinary session — no room — whose newest human message `@tags` agents the actor can
   * see becomes a room holding exactly those agents, and the message then runs as an ordinary
   * room panel. This is the same "mention someone to invite them" move `tagJoiners` makes
   * inside a room, extended to the sessions that do not have one yet: the alternative is that
   * `@Scout` in a 1:1 chat silently addresses nobody.
   *
   * A plain session has no persona of its own (personas exist only as room members), so the
   * roster is the tagged agents and nothing else. Returns undefined when the message tagged
   * nobody visible, which leaves the turn to run exactly as it does today.
   */
  async function roomFromTags(
    text: string | undefined,
    principalId: string,
  ): Promise<{ room: RoomConfig; joiners: PanelMember[] } | undefined> {
    const joiners = await tagJoiners(text, [], [], principalId);
    if (!joiners.length) return undefined;
    // "@Critic @Scout debate this 3 times" in a plain chat sets the promoted room's budget the
    // same way it does on Slack: a stated count wins (clamped to ROOM_MAX_ROUNDS inside the
    // parser), silence means the default single round. PASS still ends it early.
    const rounds = requestedPanelRounds(text) ?? ROOM_DEFAULT_ROUNDS;
    return { room: { personaIds: joiners.map((m) => m.id), rounds }, joiners };
  }

  /**
   * Runs a bounded panel for a room. Returns null when the roster has no usable agents left,
   * which means "fall through and take this turn the ordinary way". When `persist` is set the
   * config came in on the request, so it is written to the session as soon as the first persona
   * turn has created it.
   */
  async function runRoomPanel(
    req: TurnRequest,
    threadRef: string,
    room: RoomConfig,
    principalId: string,
    persist?: RoomConfig,
  ): Promise<TurnResult | null> {
    const running = activePanels.get(threadRef);
    if (running) running.abort = true;

    const roomMembers = panelMembersFrom(await Promise.all(room.personaIds.map((id) => deps.personas.get(id))));
    // Tagging a visible agent the room does not hold ADDS it to the room, appended after the
    // members already there. The enlarged roster is written to the session BEFORE the panel
    // runs, so a turn that fails halfway cannot cost the room the membership it just gained.
    const joined = await tagJoiners(req.text, room.personaIds, roomMembers, principalId);
    // A request-borne config is only written when the session still has none, so a roster
    // edited meanwhile is never clobbered. A roster enlarged by a join is written regardless:
    // the join IS the roster change.
    let persistOverwrites = false;
    if (joined.length) {
      const enlarged: RoomConfig = { ...room, personaIds: [...room.personaIds, ...joined.map((m) => m.id)] };
      let stored = false;
      try {
        const session = await deps.sessions.getByThread(threadRef);
        if (session) {
          await deps.sessions.setRoom(session.id, enlarged);
          stored = true;
          // A roster change is a roster change however it was made: an @tag join is audited
          // exactly like the PUT that edits a room, so the trail never depends on which
          // surface someone happened to use.
          deps.auditLog.record({
            at: Date.now(),
            principalId,
            action: "agent_room_join",
            resource: session.id,
            scopeLabel: session.scopeId,
          });
          await noteRoomJoin(session, joined);
        }
      } catch (err) {
        console.error(`[panel] thread=${threadRef} persisting joined roster failed: ${errMessage(err)}`);
      }
      // No session yet (the first message of a request-borne room) or the write did not land:
      // the enlarged config rides `persist`, which is retried once the first turn has run.
      persist = stored ? undefined : enlarged;
      persistOverwrites = !stored;
    }
    const members = joined.length ? [...roomMembers, ...joined] : roomMembers;
    if (!members.length) return null;
    // The room's roster is what every persona turn is told about; it changes with a message only
    // when that message tagged somebody into the room.
    const rosterIds = members.map((m) => m.id);
    // Addressing the room with `@Name` picks who answers THIS message, in the order tagged —
    // including whoever just joined on this very message. Tags matching nobody visible match
    // nothing, so a message that tags only strangers falls back to the whole roster, exactly
    // like a message with no tags at all. Whoever speaks may still invite anyone else in the
    // (now possibly larger) room with a mention of their own.
    const addressed = panelAddressed(req.text, members);
    let speaking = addressed.length ? addressed : members;
    // A reply inside a thread, tagging nobody, continues that thread's conversation: only the
    // personas already in the thread answer. An explicit `@tag` still overrides (handled
    // above), and a thread with no persona replies falls back to the whole roster.
    if (!addressed.length && req.replyToSeq !== undefined) {
      const prior = await threadPersonaIds(threadRef, req.replyToSeq);
      const inThread = members.filter((m) => prior.has(m.id));
      if (inThread.length) speaking = inThread;
    }

    const persistIfNeeded = async (): Promise<void> => {
      if (!persist) return;
      try {
        const session = await deps.sessions.getByThread(threadRef);
        if (session && (persistOverwrites || !session.room)) await deps.sessions.setRoom(session.id, persist);
      } catch (err) {
        console.error(`[panel] thread=${threadRef} persisting room config failed: ${errMessage(err)}`);
      }
    };

    const state: PanelState = { abort: false };
    activePanels.set(threadRef, state);
    const wantAsync = req.async === true;

    let settled = false;
    let resolveFirst!: (r: TurnResult) => void;
    const firstResult = new Promise<TurnResult>((resolve) => {
      resolveFirst = (r) => {
        if (settled) return;
        settled = true;
        resolve(r);
      };
    });

    const personaRequest = (spec: PanelTurnSpec, async: boolean): TurnRequest => {
      const next: TurnRequest = {
        ...req,
        text: spec.text,
        panel: {
          persona: spec.persona,
          continuation: spec.continuation,
          rosterIds,
          round: spec.round,
          rounds: spec.rounds,
        },
        harness: spec.harness,
        model: spec.model,
        async,
        // Every persona turn is its own run; sharing the human's key would collapse them into one.
        ...(req.idempotencyKey ? { idempotencyKey: `${req.idempotencyKey}:panel-${spec.index}` } : {}),
      };
      delete next.room;
      if (spec.continuation) {
        // The human's payload rides along with the first turn only.
        delete next.attachments;
        delete next.overheard;
        delete next.priorTurns;
        delete next.inboundNotes;
        delete next.displayText;
      }
      return next;
    };

    // The driver reads `status` as well as `reply`: a Slack panel turn is spine-routed and
    // comes back `silent` with no reply at all, which is a quiet turn, not a missing one.
    const run = async (spec: PanelTurnSpec): Promise<PanelTurnOutcome> => {
      if (spec.index === 0 && wantAsync) {
        // Async callers get the first persona's run id straight away; the rest of the panel
        // continues in the background off the same driver loop.
        const queued = await methods.turn(personaRequest(spec, true));
        resolveFirst(queued);
        if (queued.status !== "queued" || !queued.runId) {
          state.abort = true;
          return {};
        }
        try {
          return await drive(queued.runId);
        } finally {
          await persistIfNeeded();
        }
      }
      let result: TurnResult;
      try {
        result = await methods.turn(personaRequest(spec, false));
      } catch (err) {
        // The turn may still have created the session (and written the persona's error entry)
        // before crashing, so the roster is persisted either way: a failed first speaker must
        // not cost the room its config.
        if (spec.index === 0) await persistIfNeeded();
        throw err;
      }
      if (spec.index === 0) {
        resolveFirst(result);
        if (result.status === "refused" || result.status === "failed") state.abort = true;
        await persistIfNeeded();
      }
      return result;
    };

    const panel = runPanel({ members: speaking, invitable: members, rounds: room.rounds, text: req.text, state, run })
      .catch((err) => {
        console.error(`[panel] thread=${threadRef} ${errMessage(err)}`);
      })
      .finally(() => {
        if (activePanels.get(threadRef) === state) activePanels.delete(threadRef);
        resolveFirst({ status: "failed", reason: "the room produced no turns" });
      });

    if (!wantAsync) await panel;
    return firstResult;
  }

  const methods: TurnMethods = {
    async turn(req: TurnRequest): Promise<TurnResult> {
      await deps.identity.refresh();
      const actor: Principal = deps.identity.resolve(req.actor);
      let projectAudience: Principal[] | undefined;
      let projectName: string | undefined;
      let projectVersion: string | undefined;
      let sessionParticipantIds: string[] | undefined;
      const conversationRef = req.conversation.channelRef;
      const projectGroup = req.conversation.kind === "group" && !!conversationRef && isProjectGroupRef(conversationRef);
      const projectId = projectGroup ? projectIdFromGroupRef(conversationRef) : null;

      if (projectGroup) {
        if (!deps.identity.isInternal(actor)) {
          return { status: "refused", reason: "you're not a member of that context" };
        }
        if (!projectId) return { status: "refused", reason: "you're not a member of that context" };
        const project = await deps.projects?.get(projectId);
        if (
          !project ||
          project.orgId !== orgIdOf() ||
          !deps.identity.isInternal(deps.identity.classify(project.ownerId))
        ) {
          return { status: "refused", reason: "you're not a member of that context" };
        }
        const activeMemberIds = project.memberIds.filter((memberId) =>
          deps.identity.isInternal(deps.identity.classify(memberId)),
        );
        if (!activeMemberIds.includes(actor.id))
          return { status: "refused", reason: "you're not a member of that context" };
        projectAudience = await Promise.all(
          activeMemberIds.map(async (memberId) => {
            if (memberId === actor.id) return actor;
            const principal = deps.identity.classify(memberId);
            const member = await deps.directory.get(memberId).catch(() => null);
            return member?.displayName ? { ...principal, displayName: member.displayName } : principal;
          }),
        );
        projectName = project.name;
        projectVersion = String(project.updatedAt);
        sessionParticipantIds = [...activeMemberIds];
      } else if (req.surface === "web" && req.conversation.kind !== "dm") {
        if (!conversationRef || !(await mayUseSharedScope(req.conversation.kind, conversationRef, actor))) {
          return { status: "refused", reason: "you're not a member of that context" };
        }
      }

      async function withCurrentProjectRoster<T>(fn: () => Promise<T>): Promise<T | null> {
        if (!projectId || !deps.projects) return fn();
        if (!conversationRef || !projectVersion) return null;
        return (await deps.projects.withVersion(conversationRef, projectVersion, fn)) ?? null;
      }

      if (req.surface === "web") {
        const threadRef = req.conversation.threadRef;
        const existing = await deps.sessions.getByThread(threadRef);
        if (existing) {
          const claimed =
            req.conversation.kind === "dm"
              ? scopeId("personal", actor.id)
              : scopeId(req.conversation.kind, req.conversation.channelRef ?? threadRef);
          if (existing.scopeId !== claimed) {
            return { status: "refused", reason: "that conversation lives in a different context" };
          }
        } else if (threadRef.startsWith("web:") && !threadRef.startsWith(`web:${actor.id}:`)) {
          return { status: "refused", reason: "you can only start a new conversation on your own thread" };
        }
        const org = scopeId("org", orgIdOf());
        const targetScope =
          req.conversation.kind === "dm"
            ? scopeId("personal", actor.id)
            : scopeId(req.conversation.kind, req.conversation.channelRef ?? threadRef);
        const fallbackHarness = isHarnessId(deps.harnessId) ? deps.harnessId : "pi";
        const runtimeFallback = deps.runtimeFallback ?? {
          harnessId: fallbackHarness,
          modelId: defaultModelForHarness(fallbackHarness),
        };
        let orgRuntime;
        let configuredRuntime;
        let runtime;
        try {
          orgRuntime = await resolveRuntimeChoiceDurable(deps.config, org, org, runtimeFallback);
          configuredRuntime =
            targetScope === org
              ? orgRuntime
              : await resolveRuntimeChoiceDurable(deps.config, org, targetScope, runtimeFallback);
          runtime =
            req.harness || req.model
              ? await resolveRuntimeChoiceDurable(deps.config, org, targetScope, runtimeFallback, {
                  ...(req.harness && isHarnessId(req.harness) ? { harnessId: req.harness } : {}),
                  ...(req.model ? { modelId: req.model } : {}),
                })
              : configuredRuntime;
        } catch (error) {
          return { status: "refused", reason: errMessage(error) };
        }
        if (req.harness && !isHarnessId(req.harness)) {
          return { status: "refused", reason: `runtime ${req.harness} is not approved` };
        }
        const configuredKeys = deps.providerKeys ??
          deps.modelProviders ?? { anthropic: false, openai: false, openrouter: false };
        let providers = deps.modelProviders;
        if (deps.modelCredentials) {
          providers = modelProviderAvailabilityFor(
            runtime.harnessId,
            configuredKeys,
            await deps.modelCredentials.availability(),
          );
        } else if (deps.providerKeys) {
          providers = modelProviderAvailabilityFor(runtime.harnessId, configuredKeys);
        }
        if (providers && !modelServiceable(runtime.modelId, providers)) {
          return {
            status: "refused",
            reason: "that model isn't available on this deployment (its provider isn't configured)",
          };
        }
        const configuredWebuiModels = await deps.config.getWebuiModelsDurable(org);
        let enabledWebuiModels: string[] | null = null;
        if (configuredWebuiModels?.length) {
          enabledWebuiModels = [...new Set([...configuredWebuiModels, orgRuntime.modelId])];
        } else if (providers?.openrouter) {
          enabledWebuiModels = [
            ...new Set([
              ...selectableCatalogForHarness(
                await selectableModelCatalog(deps.modelCredentialFetch),
                runtime.harnessId,
              ).map((model) => model.id),
              ...(orgRuntime.harnessId === runtime.harnessId ? [orgRuntime.modelId] : []),
            ]),
          ];
        }
        const invalidModelOption =
          validateWebTurnModelOptions(req, enabledWebuiModels, providers) ??
          webTurnRuntimeModelRefusal(runtime.modelId, orgRuntime.modelId, configuredWebuiModels);
        if (invalidModelOption) return { status: "refused", reason: invalidModelOption };
      }

      const rawAudience = req.conversation.audience ?? [req.actor];
      const audience: Principal[] =
        projectAudience ??
        rawAudience.map((a) => {
          const p = deps.identity.classify(a.externalId, a.isExternalGuest);
          if (p.id === actor.id) return actor;
          return a.displayName ? { ...p, displayName: a.displayName } : p;
        });
      if (!audience.some((p) => p.id === actor.id)) audience.push(actor);

      const publishMembers =
        projectAudience ??
        req.conversation.publishMembers?.map((a) => deps.identity.classify(a.externalId, a.isExternalGuest));

      const conversation: Conversation = {
        kind: req.conversation.kind,
        threadRef: req.conversation.threadRef,
        ...(req.conversation.channelRef ? { channelRef: req.conversation.channelRef } : {}),
        ...(projectName || req.conversation.channelName
          ? { channelName: projectName ?? req.conversation.channelName }
          : {}),
        audience,
        ...(req.conversation.isPrivate !== undefined ? { isPrivate: req.conversation.isPrivate } : {}),
        ...(req.conversation.isMpim !== undefined ? { isMpim: req.conversation.isMpim } : {}),
        ...(publishMembers ? { publishMembers } : {}),
      };

      const origin = resolveTurnOrigin(req);

      // Reply in thread. Resolved before anything is enqueued so a bad ref costs the turn
      // rather than landing a message in the wrong place, and resolved to a root so the
      // orchestrator (and the stored run request it replays from) only ever holds a root.
      // Persona turns come back through here carrying the same ref; resolving a root
      // resolves to itself, so the whole panel agrees on one thread.
      let replyRootSeq: number | undefined;
      if (req.replyToSeq !== undefined) {
        const resolved = await resolveReplyRoot(req.replyToSeq, conversation.threadRef);
        if ("error" in resolved) return { status: "refused", reason: resolved.error };
        replyRootSeq = resolved.rootSeq;
      }

      const input = {
        surface: req.surface,
        ...(req.deliveryTarget ? { deliveryTarget: req.deliveryTarget } : {}),
        ...(req.deliveryCandidates?.length ? { deliveryCandidates: req.deliveryCandidates } : {}),
        actor,
        conversation,
        origin,
        text: req.text,
        ...(req.gatewayContext ? { gatewayContext: req.gatewayContext } : {}),
        ...(req.proactiveOpener ? { proactiveOpener: true } : {}),
        ...(req.conversationHeader ? { conversationHeader: req.conversationHeader } : {}),
        ...(req.priorTurns?.length ? { priorTurns: req.priorTurns } : {}),
        ...(req.overheard?.length ? { overheard: req.overheard } : {}),
        ...(req.detectContext ? { detectContext: req.detectContext } : {}),
        ...(req.detectOpener ? { detectOpener: req.detectOpener } : {}),
        ...(req.attachments?.length ? { attachments: req.attachments } : {}),
        ...(req.inboundNotes?.length ? { inboundNotes: req.inboundNotes } : {}),
        ...(req.harness ? { harness: req.harness } : {}),
        ...(req.model ? { model: req.model } : {}),
        ...(req.panel ? { panel: req.panel } : {}),
        ...(replyRootSeq !== undefined ? { replyToSeq: replyRootSeq } : {}),
        ...turnModelOptions(req),
        ...(req.readOnly ? { readOnly: true } : {}),
        ...(req.surfaceTools ? { surfaceTools: true } : {}),
        ...(req.envelopeWrapped ? { envelopeWrapped: true } : {}),
        ...(typeof req.displayText === "string" && req.displayText ? { displayText: req.displayText } : {}),
        ...(req.addressed || origin.kind === "human" ? { addressed: true } : {}),
        ...(typeof req.turnWallClockMs === "number" ? { turnWallClockMs: req.turnWallClockMs } : {}),
        ...(typeof req.timezone === "string" && req.timezone ? { timezone: req.timezone } : {}),
        ...(typeof req.intakePreambleMs === "number" ? { intakePreambleMs: req.intakePreambleMs } : {}),
        ...(typeof req.clientSentAt === "number" ? { clientSentAt: req.clientSentAt } : {}),
        ...(req.approval ? { approval: req.approval } : {}),
        ...(sessionParticipantIds ? { sessionParticipantIds } : {}),
        ...(projectVersion ? { scopeVersion: projectVersion } : {}),
      };

      if (projectGroup && req.approval) {
        const [approval, approvalSession] = await Promise.all([
          deps.approvals?.get(req.approval.requestId),
          deps.sessions.getByThread(conversation.threadRef),
        ]);
        if (
          !approval ||
          approval.sessionId !== approvalSession?.id ||
          !approvalSession ||
          !(await approvalRecordIsCurrent(approval, approvalSession)) ||
          !(await approvalVisibleToViewer(approvalSession, actor.id, approval))
        ) {
          return { status: "refused", reason: "approval isn't visible in your project tenure" };
        }
      }
      const blocked = await pendingApprovalResultForThread(conversation.threadRef, projectGroup ? actor.id : undefined);
      let request = input;
      if (blocked) {
        const pendingList = blocked.pendingApprovals ?? [];
        const matches = (id?: string): boolean => !!id && pendingList.some((p) => p.requestId === id);
        if (!matches(req.approval?.requestId)) return blocked;
      }

      let dedupKey: string | undefined;
      if (req.idempotencyKey) {
        dedupKey =
          projectVersion === undefined ? req.idempotencyKey : `${req.idempotencyKey}:project-${projectVersion}`;
      }

      if (origin.kind === "human" && !req.approval) deps.reaperPoke?.();

      if (
        req.surface !== "web" &&
        deps.signals &&
        (origin.kind === "human" || origin.kind === "ambient") &&
        !req.approval &&
        !req.spawned &&
        !req.idempotencyKey
      ) {
        const live = await deps.runs.activeForThread(conversation.threadRef);
        const liveOriginKind = live ? resolveTurnOrigin(live.request).kind : undefined;
        const personIntoAutomation =
          liveOriginKind === "automation" &&
          (origin.kind === "human" || (origin.kind === "ambient" && origin.live === true)) &&
          !(origin.kind === "human" && isHalt(req.text));
        if (live && !isTerminal(live.status) && !personIntoAutomation) {
          const steerText =
            origin.kind === "ambient" ? `${actor.displayName?.trim() || actor.id}: ${req.text}` : req.text;
          let injectedText = steerText;
          if (origin.kind === "ambient") {
            const session = await deps.sessions.getByThread(conversation.threadRef);
            const decision = await deps.orchestrator.screenSecuritySteer({
              payload: steerText,
              actor,
              conversation,
              ...(session ? { sessionId: session.id } : {}),
            });
            if (decision === "block")
              return req.async ? { status: "queued", runId: live.id, steered: true } : drive(live.id);
            if (decision === "unscreened") injectedText = `${unscreenedNotice("mid-turn message")}\n${steerText}`;
          }
          const wake: Wake = {
            situation: origin.kind === "ambient" ? "ambientUpdate" : "addressed",
            ts: String(req.clientSentAt ?? Date.now()),
            text: injectedText,
            halt: origin.kind === "human" && isHalt(req.text),
          };
          const route = routeWake(wake, true, resolveTurnOrigin(live.request).kind === "ambient");
          if (route.kind === "steer" || route.kind === "drop") {
            const steerTs = origin.kind === "human" ? (origin.messageTs ?? origin.entryTs) : origin.entryTs;
            const routedRunId = await withCurrentProjectRoster(async () => {
              if (route.kind === "steer")
                await deps.signals!.send(live.id, {
                  kind: route.signal,
                  ...(route.text ? { text: route.text } : {}),
                  ...(steerTs ? { ts: steerTs } : {}),
                  ...(route.signal === "steer" ? { request: req } : {}),
                });
              return live.id;
            });
            if (!routedRunId)
              return { status: "refused", reason: "project membership changed; retry from the current project" };
            if (route.kind === "steer") {
              const after = await deps.runs.get(live.id);
              if (!after || isTerminal(after.status)) {
                const own = (await replayOrphanedRunSignals(live.id)).find(
                  (d) => d.signal.text === route.text && d.signal.ts === steerTs,
                );
                if (own?.replayRunId)
                  return req.async ? { status: "queued", runId: own.replayRunId } : drive(own.replayRunId);
              }
            }
            return req.async ? { status: "queued", runId: routedRunId, steered: true } : drive(routedRunId);
          }
        }
      }

      const spineRouted = !req.approval && shouldRouteToSpine(request as OrchestratorInput);
      if (spineRouted) {
        request = { ...input, surfaceTools: true };
        if (origin.kind !== "ambient")
          request = {
            ...request,
            text: await addressedWakeText(input as OrchestratorInput),
            displayText: input.text,
            envelopeWrapped: true,
          };
      }

      if (spineRouted && origin.kind === "human" && !req.spawned && !req.idempotencyKey && origin.messageTs) {
        const container = conversation.channelRef ?? conversation.threadRef;
        const ambientRef = `${req.surface}:${container}:ambient:${origin.messageTs}`;
        const ambientSession = await deps.sessions.getByThread(ambientRef);
        if (ambientSession) {
          const liveAmbient = await deps.runs.activeForThread(ambientRef);
          if (liveAmbient && !isTerminal(liveAmbient.status)) {
            const routedRunId = await withCurrentProjectRoster(async () => {
              if (deps.signals)
                await deps.signals.send(liveAmbient.id, {
                  kind: "steer",
                  text: req.text,
                  ts: origin.messageTs,
                  request: req,
                });
              return liveAmbient.id;
            });
            if (!routedRunId)
              return { status: "refused", reason: "project membership changed; retry from the current project" };
            const after = await deps.runs.get(liveAmbient.id);
            if (!after || isTerminal(after.status)) {
              const own = (await replayOrphanedRunSignals(liveAmbient.id)).find(
                (d) => d.signal.text === req.text && d.signal.ts === origin.messageTs,
              );
              if (own?.replayRunId)
                return req.async ? { status: "queued", runId: own.replayRunId } : drive(own.replayRunId);
            }
            // Deliberately NOT flagged `steered`. Unlike the mid-turn branch above, this run's owner
            // is the UNPROMPTED ambient handler, which stays silent on a refusal or failure
            // (bystander restraint) and whose recovery copy is suppressed for the same reason. The
            // addressed caller is the only one that would ever report that, so standing it down
            // would trade a duplicate reply for silence on a message someone actually addressed.
            return req.async ? { status: "queued", runId: routedRunId } : drive(routedRunId);
          }
        }
      }

      const known = await deps.sessions.getByThread(conversation.threadRef);

      // A human message into a room does not run a turn of its own: it is handed to the first
      // persona, and the driver takes the floor from there. Persona turns come back through
      // here carrying `panel`, which is what keeps this from recursing. A roster may also ride
      // in on the request itself — the first message of a brand-new room, before any session
      // exists to PUT it onto.
      const personTyped = origin.kind === "human" || origin.kind === "direct";
      if (agentRoomsEnabled() && !req.panel && !req.approval && personTyped) {
        let roomCfg = known?.room;
        let persist: RoomConfig | undefined;
        if (req.room) {
          if (!roomCfg) {
            const validated = await roomFromRequest(req.room, actor.id);
            if ("error" in validated) return { status: "refused", reason: validated.error };
            roomCfg = validated.room;
            persist = validated.room;
          } else if (req.room.rounds !== undefined) {
            // A room persisted on the session owns its ROSTER — the request cannot rewrite who is
            // in the room, and `tagJoiners` remains the only way to enlarge it. But `rounds` is a
            // per-dispatch budget, not membership, and the surface dispatching this message is the
            // one that knows the operator's current setting. Slack's panel rounds are an admin
            // choice that has to take effect in threads that already ran a panel, and without this
            // the first panel in a thread would freeze the number forever.
            //
            // Web-UI turns into an existing room carry no `room` at all (the client only sends one
            // for the first message of a brand-new room, before a session exists to hold it), so
            // the persisted rounds still win there — see the regression test in `panel-driver`.
            if (!validRounds(req.room.rounds)) return { status: "refused", reason: ROUNDS_ERROR };
            roomCfg = { ...roomCfg, rounds: req.room.rounds };
            // Deliberately NOT persisted: the stored room keeps the rounds its owner chose, and
            // every dispatch re-reads the surface's own setting.
          }
        }
        if (!roomCfg) {
          // No room yet, but this message tagged agents the actor can see: the tag promotes the
          // session to a room holding them, and the message runs as that room's first panel.
          const promoted = await roomFromTags(req.text, actor.id);
          if (promoted) {
            roomCfg = promoted.room;
            // Write the roster now when there is a session to write it to, so a turn that fails
            // halfway cannot cost the room the membership the tag just gave it — the same
            // ordering `runRoomPanel` uses for a join into an existing room. With no session yet
            // (the very first message of a brand-new conversation) the config rides `persist`,
            // which `runRoomPanel` retries once the first turn has created one; there is also
            // nothing to add anybody TO in that case, so no join note is written.
            let stored = false;
            if (known) {
              try {
                await deps.sessions.setRoom(known.id, promoted.room);
                stored = true;
                deps.auditLog.record({
                  at: Date.now(),
                  principalId: actor.id,
                  action: "agent_room_join",
                  resource: known.id,
                  scopeLabel: known.scopeId,
                });
                await noteRoomJoin(known, promoted.joiners);
              } catch (err) {
                console.error(
                  `[panel] thread=${conversation.threadRef} promoting to a room failed: ${errMessage(err)}`,
                );
              }
            }
            if (!stored) persist = promoted.room;
          }
        }
        if (roomCfg) {
          const panelled = await runRoomPanel(req, conversation.threadRef, roomCfg, actor.id, persist);
          if (panelled) return panelled;
        }
      }

      const participants = known ? await deps.sessions.participantsOf(known.id) : [];
      const enqueue = () =>
        deps.runs.enqueue({
          sessionId: conversation.threadRef,
          request,
          maxAttempts: deps.maxAttempts,
          ...(dedupKey ? { dedupKey } : {}),
        });
      const enqueued = await withCurrentProjectRoster(enqueue);
      if (!enqueued) return { status: "refused", reason: "project membership changed; retry from the current project" };
      const { run, deduped } = enqueued;
      if (!deduped) {
        deps.sessionStateBus?.emit({
          threadRef: conversation.threadRef,
          ...(known ? { sessionId: known.id } : {}),
          state: "working",
          at: Date.now(),
          participants: participants.length ? participants : [req.actor.externalId],
        });
      }
      if (spineRouted && !deduped) markTriggerHandled(input as OrchestratorInput);
      if (spineRouted) deps.engaged?.engage(conversation.threadRef);
      if (deduped && run.result && isTerminal(run.status)) return withAdminLink(run.result);
      if (req.async) return { status: "queued", runId: run.id };
      return drive(run.id);
    },

    subscribeSessionStates(cb) {
      return deps.sessionStateBus?.subscribe(cb) ?? (() => {});
    },

    async getApproval(requestId, viewer) {
      const record = await deps.approvals?.get(requestId);
      if (!record || !(await approvalRecordIsCurrent(record))) return null;
      if (viewer) {
        const session = await deps.sessions.get(record.sessionId);
        if (!session || !(await approvalVisibleToViewer(session, viewer, record))) return null;
      }
      return { requestId, ...record };
    },

    async listSessionApprovals(sessionId, viewer) {
      const mine = await sessionsForViewer(viewer);
      if (!mine.some((s) => s.id === sessionId)) return [];
      return pendingApprovalForSession(sessionId, { blockingOnly: false, viewer });
    },

    pendingApprovalForThread(threadRef, viewer) {
      return pendingApprovalResultForThread(threadRef, viewer);
    },

    async getRun(runId, viewer) {
      const run = await deps.runs.get(runId);
      if (!run) return null;
      if (viewer && !(await viewerMayUseRun(run, viewer))) return null;
      const partial = deps.turnStream?.snapshot(runId);
      const firstBlock = deps.turnStream?.firstBlock(runId);
      const surfacePosted = deps.turnStream?.surfacePosted(runId) ?? false;
      const alive = deps.turnStream?.alive(runId) ?? false;
      const replying = deps.turnStream?.replying(runId) ?? false;
      const replyComplete = deps.turnStream?.isReplyDone(runId) ?? false;
      const activity = await deps.runActivity?.list(runId);
      const tasks = await deps.tasks?.list({ originRunId: runId });
      const stale =
        run.status === "pending" ? run.attempts > 0 : !alive && leaseLapsed(run, Date.now() - STALE_LEASE_GRACE_MS);
      return {
        status: run.status,
        result: run.result ? await withAdminLink(run.result) : run.result,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        ...(partial ? { partial } : {}),
        ...(firstBlock
          ? { firstBlock: firstBlock.text, ...(firstBlock.closed ? { firstBlockClosed: true } : {}) }
          : {}),
        ...(surfacePosted ? { surfacePosted: true } : {}),
        ...(alive ? { alive: true } : {}),
        ...(stale ? { stale: true } : {}),
        ...(replying ? { replying: true } : {}),
        ...(replyComplete ? { replyComplete: true } : {}),
        ...(tasks?.length ? { tasks: tasks.map(({ id, title, status }) => ({ id, title, status })) } : {}),
        ...(activity && activity.length ? { activity } : {}),
      };
    },

    async activeRunForThread(threadRef, viewer) {
      const run = await deps.runs.activeForThread(threadRef);
      return run && (!viewer || (await viewerMayUseRun(run, viewer))) ? { runId: run.id } : null;
    },

    async signalRun(runId, signal, viewer) {
      if (!deps.signals) return { accepted: false, reason: "signals_unavailable" };
      const run = await deps.runs.get(runId);
      if (!run) return { accepted: false, reason: "not_found" };
      if (viewer && !(await viewerMayUseRun(run, viewer))) return { accepted: false, reason: "not_found" };
      if (isTerminal(run.status)) return { accepted: false, reason: "terminal" };
      if (signal.kind === "steer" && !signal.text?.trim()) {
        return { accepted: false, reason: "text_required" };
      }
      await deps.signals.send(runId, signal);
      const after = await deps.runs.get(runId);
      if (!after || isTerminal(after.status)) {
        await replayOrphanedRunSignals(runId);
        if (signal.kind !== "steer") return { accepted: false, reason: "terminal" };
        // The steer was stored before the run went terminal, so its text is replayed as
        // a fresh turn (by this drain, the onTerminal hook, or the orphan sweeper —
        // whoever drains first). Tell the caller so it attaches to the fresh run
        // instead of treating the message as lost.
        return { accepted: false, reason: "terminal", replayed: true };
      }
      return { accepted: true };
    },

    replayOrphanedRunSignals(runId) {
      return replayOrphanedRunSignals(runId).then(() => undefined);
    },
  };
  return methods;
}
