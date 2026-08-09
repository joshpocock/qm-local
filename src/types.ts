import type { ResolvedSecurityPolicy } from "./security/security-posture.ts";

export type PrincipalType = "internal" | "guest";

export interface Principal {
  id: string;
  type: PrincipalType;
  teamIds?: string[];
  displayName?: string;
}

const SCOPE_KINDS = ["personal", "channel", "team", "org", "group"] as const;
export type ScopeKind = (typeof SCOPE_KINDS)[number];

export type ScopeId = string;

function isScopeKind(s: string): s is ScopeKind {
  return (SCOPE_KINDS as readonly string[]).includes(s);
}

export function scopeId(kind: ScopeKind, ref: string): ScopeId {
  return `${kind}:${ref}`;
}

export function personalScope(principalId: string): ScopeId {
  return scopeId("personal", principalId);
}

export function parseScopeId(id: ScopeId): { kind: ScopeKind | null; ref: string } {
  const sep = id.indexOf(":");
  if (sep < 0) return { kind: null, ref: "" };
  const raw = id.slice(0, sep);
  return { kind: isScopeKind(raw) ? raw : null, ref: id.slice(sep + 1) };
}

export function isManageableCreationScope(id: ScopeId | undefined): boolean {
  if (!id) return false;
  const { kind } = parseScopeId(id);
  return kind === "channel" || kind === "team";
}

export function isSharedScope(id: ScopeId | undefined): boolean {
  if (!id) return false;
  const { kind } = parseScopeId(id);
  return kind === "channel" || kind === "group";
}

export type ConversationKind = "dm" | "channel" | "group";

export interface Conversation {
  kind: ConversationKind;
  threadRef: string;
  channelRef?: string;
  channelName?: string;
  audience: Principal[];
  isPrivate?: boolean;
  isMpim?: boolean;
  publishMembers?: Principal[];
}

export type SessionType = "dm" | "channel" | "group";

/**
 * Roster for an agent room. `room == null` on a session means "behaves exactly as it
 * always has" — every room-only code path is keyed off this being present.
 */
export interface RoomConfig {
  /** persona ids, in the order they speak; a room may hold as many as you like */
  personaIds: string[];
  /** how many times the roster goes round; an integer in 1..ROOM_MAX_ROUNDS */
  rounds: number;
}

/** Upper bound on `RoomConfig.rounds`; valid values are the integers 1..ROOM_MAX_ROUNDS. */
export const ROOM_MAX_ROUNDS = 20;

/**
 * Rounds a room gets when nobody chose a number — a room the client opened with the
 * default, and the room an `@tag` promotes an ordinary session into. One round means
 * everybody on the roster speaks once, which is the least surprising thing a mention
 * can do; the roster owner can raise it afterwards like any other room.
 */
export const ROOM_DEFAULT_ROUNDS = 1;

export interface Session {
  id: string;
  type: SessionType;
  scopeId: ScopeId;
  threadRef: string;
  surface?: string;
  room?: RoomConfig;
  createdAt: number;
  channelName?: string;
  title?: string | null;
  archived?: boolean;
  pinned?: boolean;
  color?: string;
  lastActivityAt?: number;
  hasEntries?: boolean;
  working?: boolean;
  awaitingInput?: boolean;
  backgroundJobs?: number;
  watches?: number;
}

export type EntryType =
  | "user"
  | "assistant"
  | "thinking"
  | "text"
  | "tool_call"
  | "tool_result"
  | "soul"
  | "system"
  | "delivery"
  | "approval_request"
  | "approval_resolved";

export interface SessionEntry {
  sessionId: string;
  seq: number;
  parentSeq: number | null;
  type: EntryType;
  payload: unknown;
  scopeLabel: ScopeId;
  createdAt: number;
}

type LayerMode = "ro" | "rw";

export interface WorkspaceLayer {
  scopeId: ScopeId;
  mountPath: string;
  mode: LayerMode;
}

export interface Resolution {
  layers: WorkspaceLayer[];
  systemPrompt: string;
  egress: EgressPolicy;
  commandPolicy: CommandPolicy;
  securityPolicy: ResolvedSecurityPolicy;
  approvalGrantModes: ApprovalGrantModes;
  orgScopeId: ScopeId;
  grantedHandles: GrantedHandle[];
}

export type Permission = "read" | "write";

export interface Grant {
  ownerScopeId: ScopeId;
  ref: string;
  granteeScopeId: ScopeId;
  permission: Permission;
  grantedBy: string;
}

export interface GrantedHandle {
  handlePath: string;
  ownerScopeId: ScopeId;
  ownerPath: string;
  permission: Permission;
}

export interface RecipientConsent {
  recipientId: string;
  status: "pending" | "accepted" | "declined";
  decidedAt?: number;
}

export interface TriggerBase {
  id: string;
  ownerScopeId: ScopeId;
  owner: string;
  createdBy: string;
  ownerConsentedAt?: number;
  destination?: Destination;
  enabled: boolean;
  createdAt: number;
  lastFiredAt?: number;
  recipientConsent?: RecipientConsent;
}

export interface Destination {
  type: string;
  target: string;
  audienceScopeId?: ScopeId;
  onBehalfOf?: string;
  editRef?: string;
  taskList?: Array<{
    id: string;
    title: string;
    status: "pending" | "in_progress" | "completed" | "skipped" | "failed";
  }>;
  unfurlLinks?: boolean;
  react?: { messageTs: string; emoji: string };
  delete?: { messageTs: string };
  identity?: string;
  debugFooter?: string;
}

export interface CandidateDestination extends Destination {
  key: string;
  label: string;
}

export type BackgroundWakeTrigger = "cron" | "webhook" | "monitor" | (string & {});

export interface DeliveryProvenance {
  trigger: BackgroundWakeTrigger;
  surface: string;
  fireKey: string;
  sourceScopeId: ScopeId;
  sourceThreadRef: string;
  sourceSessionId?: string;
  sourceUserSeq?: number;
  sourceAssistantEntrySeq?: number;
}

export interface CronSchedule {
  cron?: string;
  timezone?: string;
  everyMs?: number;
  firstFireAt?: number;
}

export interface CronFireLogEntry {
  fireKey: string;
  threadRef: string;
  firedAt: number;
  scheduledAt?: number;
  status?: TurnResult["status"];
  note?: string;
  reply?: string;
  sessionId?: string;
}

export interface Cron extends TriggerBase {
  schedule: CronSchedule;
  nextFireAt?: number;
  title?: string;
  archived?: boolean;
  action?: string;
  message?: string;
  createdAt: number;
  runAs?: "owner" | "scopeFloor" | "scopeShared";
  members?: Principal[];
  fireLog?: CronFireLogEntry[];
}

export interface Monitor extends TriggerBase {
  processId: string;
  command: string;
  threadRef: string;
  instructions?: string;
  pattern?: string;
  cursor: number;
  tail?: string;
  expiresAt: number;
  lastError?: string;
}

export interface Delivery {
  id: string;
  destination: Destination;
  text: string;
  attachments?: OutgoingAttachment[];
  provenance?: DeliveryProvenance;
  idempotencyKey: string;
  createdAt: number;
  deliveredAt: number | null;
  shadow?: boolean;
  recipientThreadRef?: string;
  deliverLatencyMs?: number;
  slackApiMs?: number;
}

export interface SurfaceContextQuery {
  conversationTarget?: string;
  channelId?: string;
  channelName?: string;
  count: number;
  viewer?: string;
  before?: string;
  match?: string;
  searchAll?: string;
  viewerToken?: string;
  file?: { ts: string; threadTs?: string; name?: string };
  openGroup?: { participants: string[] };
}

export interface SurfaceContextResult {
  messages: unknown[];
  hasMore?: boolean;
  nextBefore?: string;
  note?: string;
  file?: { blobId: string; name: string; mimetype?: string; sizeBytes: number; author?: string };
  group?: { groupId: string };
}

export interface SurfaceContextRequest {
  id: string;
  source: string;
  createdAt: number;
  status: "pending" | "done" | "failed";
  query: SurfaceContextQuery;
  result?: SurfaceContextResult;
  error?: string;
}

export interface EgressPolicy {
  allowedHosts: string[];
  denyPrivateNetworks?: boolean;
  privateNetworkAllowedHosts?: string[];
  deniedHosts?: string[];
}

export type CommandDecision = "allow" | "deny" | "require_approval";

export interface CommandRule {
  pattern: string;
  decision: CommandDecision;
  reason?: string;
}

type CommandPolicyMode = "denylist" | "allowlist";

export interface CommandPolicy {
  mode: CommandPolicyMode;
  rules: CommandRule[];
}

interface BlobAttachment {
  name: string;
  mimetype: string;
  sizeBytes: number;
  blobId: string;
}

export type IncomingAttachment = BlobAttachment & {
  sourceId?: string;
  author?: string;
};

export type OutgoingAttachment = BlobAttachment & {
  artifactId?: string;
  artifactViewerId?: string;
};

export interface AttachmentMeta {
  name: string;
  mimetype: string;
  sizeBytes: number;
  direction: "in" | "out";
  author?: string;
  artifactId?: string;
}

export interface GatewayContext {
  location?: string;
  details?: Record<string, string>;
  instructions?: string;
  reactionGuidance?: string;
  botName?: string;
}

export interface ConversationTurn {
  role: "user" | "assistant";
  name?: string;
  text: string;
}

export interface OverheardMessage {
  ts: string;
  role: "user" | "self";
  name?: string;
  text: string;
  files?: string[];
  mentions?: Record<string, string>;
}

export type TurnOrigin =
  | { kind: "human"; messageTs?: string; entryTs?: string }
  | { kind: "ambient"; entryTs?: string; live?: boolean }
  | { kind: "automation"; screenData?: string; destination?: Destination; useOwnerKeychain?: boolean }
  | { kind: "direct" };

export interface TurnRequest {
  surface: string;
  scopeVersion?: string;
  deliveryTarget?: string;
  deliveryCandidates?: { target: string; label: string }[];
  actor: ActorAssertion;
  conversation: {
    kind: ConversationKind;
    threadRef: string;
    channelRef?: string;
    channelName?: string;
    audience?: ActorAssertion[];
    isPrivate?: boolean;
    isMpim?: boolean;
    publishMembers?: ActorAssertion[];
  };
  text: string;
  origin?: TurnOrigin;
  triggerTs?: string;
  entryTs?: string;
  gatewayContext?: GatewayContext;
  triggered?: boolean;
  securityScreenData?: string;
  triggerDestination?: Destination;
  ownerKeychainUnion?: boolean;
  unprompted?: boolean;
  liveActor?: boolean;
  conversationHeader?: string;
  priorTurns?: ConversationTurn[];
  overheard?: OverheardMessage[];
  detectContext?: string;
  detectOpener?: string;
  attachments?: IncomingAttachment[];
  inboundNotes?: string[];
  model?: string;
  harness?: string;
  /**
   * Set only by the panel driver: this turn is one persona speaking in a room.
   * `continuation` means the text is the driver's nudge rather than something a human
   * wrote, so it reaches the harness but never lands in the transcript as a user entry.
   * `rosterIds` carries the panel's full membership so the roster block is right even on
   * the very first turn, before the session (and its stored room config) exists.
   * `round`/`rounds` are the panel's budget, so the persona can pace itself toward a
   * conclusion instead of deferring forever; both absent means "say nothing about rounds".
   */
  panel?: {
    persona: { id: string; name: string };
    continuation: boolean;
    rosterIds?: string[];
    round?: number;
    rounds?: number;
  };
  /**
   * A room roster arriving with the message itself — used for the first message of a new
   * room, where there is no session yet for PUT /v1/sessions/:id/room to target. Validated
   * like the route (shape, visibility, enabled) and persisted once the session exists.
   */
  room?: { personaIds: string[]; rounds: number };
  /**
   * Reply in thread: the `seq` of the message in this conversation that this turn answers,
   * as a client would name it — Slack's "reply in thread", pointed at any `user` or
   * `assistant` entry in the thread rather than only at its first message.
   *
   * `App.turn` validates it (the session must exist and hold an entry with that seq, of one
   * of those two types) and REPLACES it with the thread ROOT it resolves to before the
   * orchestrator ever sees it, so everything downstream reads a root and never a raw
   * client-supplied ref. The turn's own `user` entry is then written with
   * `parentSeq` = that root, and the reply threads under the user entry as it always does —
   * `user(root) ← user(reply) ← assistant(answer)`.
   *
   * Absent (the normal case) nothing changes: user entries stay linear.
   */
  replyToSeq?: number;
  thinkingLevel?: string;
  fastMode?: boolean;
  readOnly?: boolean;
  surfaceTools?: boolean;
  addressed?: boolean;
  envelopeWrapped?: boolean;
  displayText?: string;
  turnWallClockMs?: number;
  timezone?: string;
  intakePreambleMs?: number;
  clientSentAt?: number;
  approval?: { requestId: string; approved: boolean; scope?: ApprovalScope };
  proactiveOpener?: boolean;
  spawned?: boolean;
  idempotencyKey?: string;
  async?: boolean;
}

export interface ActorAssertion {
  externalId: string;
  isExternalGuest?: boolean;
  isBot?: boolean;
  teamIds?: string[];
  displayName?: string;
}

export interface PendingApproval {
  requestId: string;
  command: string;
  reason: string;
  matched?: string;
  purpose?: string;
  summary?: string;
  approvalKey?: string;
  grantModes?: ApprovalGrantModes;
  blocksInput?: boolean;
  kind?: "approval";
}

export interface PendingApprovalRecord {
  sessionId: string;
  command: string;
  createdAt?: number;
  reason?: string;
  matched?: string;
  purpose?: string;
  summary?: string;
  approvalKey?: string;
  grantModes?: ApprovalGrantModes;
  request?: TurnRequest;
  blocksInput?: boolean;
  kind?: "approval" | "input";
}

type ApprovalScope = "once" | "session" | "always";

export interface ApprovalGrantModes {
  session: boolean;
  always: boolean;
}

export interface CommandApprovalGrant {
  actorId: string;
  command: string;
  scope: Exclude<ApprovalScope, "once">;
  createdAt: number;
  sessionId?: string;
  approvalKey?: string;
}

export interface TurnResult {
  status: "ok" | "refused" | "failed" | "pending_approval" | "queued" | "silent" | "react";
  sessionId?: string;
  reply?: string;
  reactions?: string[];
  reason?: string;
  refusalKind?: "security_quarantine";
  adminUrl?: string;
  runId?: string;
  steered?: true;
  stopped?: boolean;
  pendingApprovals?: PendingApproval[];
  attachments?: OutgoingAttachment[];
  sourceUserSeq?: number;
  sourceAssistantEntrySeq?: number;
  /**
   * The agent persona that AUTHORED this reply, when the turn was one persona speaking in a
   * room. Never persisted on the run — it is read off the run's own `panel` block on the way
   * out, so a surface that gives each persona its own identity (Slack's per-persona bots) can
   * post the reply as its author rather than as the surface's default identity.
   */
  panelPersona?: { id: string; name: string };
}
