import { html, nothing, render, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import { ref } from "lit/directives/ref.js";
import { repeat } from "lit/directives/repeat.js";
import {
  Archive,
  Binoculars,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  Cog,
  EllipsisVertical,
  Folder,
  Hash,
  Link,
  Lock,
  MessageSquare,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Repeat,
  SquareTerminal,
  User,
  Users,
  X,
} from "lucide";
import { channelRoundsScopeFor, openChannelRoundsDialog } from "./channel-rounds";
import { defaultRoomNameFor, noteRoom, type RoomConfig } from "./room-state";
import { ensureRoomPersonas, openEditRoomDialog, roomRosterDots } from "./rooms";
import {
  api,
  attachPendingApprovals,
  fetchTranscript,
  isContinuable,
  entriesToMessages,
  regenerateTitle,
  sharedContextLabel,
  slackThreadUrl,
  TAIL_TURNS,
  type TranscriptPage,
  updateSession,
  updateSessionRoom,
  type PendingApproval,
  type CoreProject,
  type CoreSession,
} from "./core-bridge";
import { sessionLink, UI_BASE } from "./deep-link";
import {
  activityOf,
  chatBrowseStatusMatches,
  bumpActivity,
  groupProjectSessions,
  groupSlackChannels,
  isPrivateSlackChannel,
  isPrivateSlackRow,
  isRoomSession,
  recencyGroup,
  recentProjectSeeds,
  reconcileSessions,
  rowIndicators,
  splitPinned,
  slackChannelIdOf,
  splitRooms,
  splitSlack,
  surfaceOf,
  withPendingSession,
  withoutUnsentPending,
  type RecentItem,
  type ChatBrowseStatus,
  type SlackListItem,
} from "./session-list";

// Re-exported so existing callers (chat.ts, contexts.ts) keep importing it from "./sessions";
// session-list.ts is the single source of truth to avoid an import cycle (sessions.ts already
// imports from session-list.ts).
export { surfaceOf };
import { hideTooltip, showTooltip } from "./tooltip";
import { errMessage } from "../../chassis/src/errors";
import { copyText, fieldSelect, icon, relTime } from "./ui";
import { listPageTpl, listSectionHead } from "./list-page";
import {
  contextsState,
  ensureContexts,
  openProjectDetail,
  personalScopeId,
  renameProject,
  scopeChip,
} from "./contexts";
import { groupDmLabel, groupDmText } from "./group-dm-label";
import { transcriptModel } from "./model-options";
import { appState, closeSidebarOnNarrowView, renderSidebarTop, showMainEmpty, startNewRoom, switchView } from "./shell";
import { allConversations, mainConversation } from "./conversations";
import type { Conversation } from "./conv-types";
import {
  addBlankPane,
  beginSessionDrag,
  endSessionDrag,
  notifySessionsChanged,
  sessionInCanvas,
  splitInterceptsOpen,
  splitState,
} from "./split";
import { liveTurnThreadRef } from "./working-dot";

export const sessionsState = {
  list: [] as CoreSession[],
  loaded: false,
  openMenuId: null as string | null,
  renamingId: null as string | null,
  openingKey: null as string | null,
  collapsedProjectScopes: new Set<string>(),
  // Same in-memory, default-expanded collapse store as projects, keyed by Slack channel id.
  collapsedSlackChannels: new Set<string>(),
};

let sessionsLoading = false;
let sessionsNotice = "";
let sessionRefreshSeq = 0;
let recentContextsRequest: Promise<void> | null = null;
const RECENT_CONTEXT_MAX_AGE_MS = 30_000;
let renameDraft = "";
const refreshingTitleIds = new Set<string>();
let showArchived = false;

let chatsPageScope: string | null = null;
let chatsPageQuery = "";
let chatsPageStatus: ChatBrowseStatus = "active";
let chatsPageSurface: "all" | "web" | "slack" = "all";
let chatsPageHost: HTMLElement | null = null;

export function resetSessionsState(): void {
  sessionsState.list = [];
  sessionsState.loaded = false;
  sessionsState.openMenuId = null;
  sessionsState.renamingId = null;
  sessionsState.openingKey = null;
  sessionsState.collapsedProjectScopes.clear();
  sessionsState.collapsedSlackChannels.clear();
  renameDraft = "";
  refreshingTitleIds.clear();
  showArchived = false;
  chatsPageScope = null;
  chatsPageQuery = "";
  chatsPageStatus = "active";
  chatsPageSurface = "all";
  chatsPageHost = null;
  recentContextsRequest = null;
}

function projectSeedsForRecents() {
  return recentProjectSeeds(contextsState.list);
}

function recentItemActivity(item: RecentItem): number {
  if (item.kind === "session") return activityOf(item.session);
  if (item.sessions[0]) return activityOf(item.sessions[0]);
  const context = contextsState.list.find((candidate) => candidate.scopeId === item.scopeId);
  return context?.lastActivityAt ?? context?.project?.createdAt ?? context?.project?.updatedAt ?? 0;
}

function recentItemsFor(sessions: readonly CoreSession[]): RecentItem[] {
  return groupProjectSessions(sessions, projectSeedsForRecents()).sort(
    (a, b) => recentItemActivity(b) - recentItemActivity(a),
  );
}

function loadRecentContexts(force = false): void {
  const fresh = contextsState.loaded && Date.now() - contextsState.loadedAt < RECENT_CONTEXT_MAX_AGE_MS;
  if (recentContextsRequest || (!force && fresh)) return;
  const request = ensureContexts(force || !fresh).then(() => {
    renderList();
  });
  recentContextsRequest = request;
  void request.finally(() => {
    if (recentContextsRequest === request) recentContextsRequest = null;
  });
}

function listWhen(ms: number): string {
  if (Date.now() - ms < 6 * 86_400_000) return relTime(ms);
  return new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });
}

export function sessionSlackUrl(s: Pick<CoreSession, "threadRef">): string | null {
  return slackThreadUrl(appState.me?.slackWorkspaceUrl ?? null, s.threadRef);
}

function projectName(scopeId: string): string | null {
  return projectOf(scopeId)?.name ?? null;
}

function projectOf(scopeId: string): CoreProject | null {
  return contextsState.list.find((context) => context.scopeId === scopeId)?.project ?? null;
}

function projectMenuKey(scopeId: string): string {
  return `project:${scopeId}`;
}

export function defaultSessionTitle(s: CoreSession): string {
  // A room is named after its roster until someone names it, in a project or not — the
  // roster is what the row is about, and every room surface reads the name from here.
  if (s.room?.personaIds.length) return defaultRoomNameFor(s.room);
  const project = projectName(s.scopeId);
  if (project) return project;
  const surface = surfaceOf(s);
  if (surface === "web") return "Web chat";
  if (s.type === "channel") return channelLabel(s) ?? "Channel";
  if (s.type === "group") return groupDmText(s.channelName) ?? s.channelName?.trim() ?? "Group DM";
  return slackDmCounterpart(s) ?? "Direct message";
}

function channelLabel(s: CoreSession): string | null {
  return s.channelName && s.channelName.trim() ? `#${s.channelName.replace(/^#/, "")}` : null;
}

/**
 * Who a Slack DM is with. A DM row is the one Slack row whose name is a person: the surface
 * records the counterpart in `channelName` (the field a channel's `#name` already travels in),
 * and it beats a generated title because "Set up Slack keychain, pick voice" is what was said,
 * not who said it — Slack's own sidebar names this row after the other side and so does this.
 * No `#`: it is not a room.
 */
function slackDmCounterpart(s: CoreSession): string | null {
  if (s.type !== "dm" || surfaceOf(s) !== "slack") return null;
  const name = s.channelName?.trim().replace(/^[#@]/, "").trim();
  return name ? name : null;
}

export function groupDmTitle(s: CoreSession): TemplateResult | string {
  const counterpart = slackDmCounterpart(s);
  if (counterpart) return counterpart;
  if (s.title && s.title.trim()) return s.title;
  if (projectName(s.scopeId)) return defaultSessionTitle(s);
  if (s.type !== "group") return defaultSessionTitle(s);
  const label = groupDmLabel(s.channelName);
  if (!label) return defaultSessionTitle(s);
  return html`<span class="group-dm-title" title=${label.text}>
    <span class="group-dm-count">${label.count}</span>
    <span class="group-dm-names">${label.text}</span>
  </span>`;
}

export function sessionTitle(s: CoreSession): string {
  const counterpart = slackDmCounterpart(s);
  if (counterpart) return counterpart;
  return s.title && s.title.trim() ? s.title : defaultSessionTitle(s);
}

export function slackLogo(size = 13): TemplateResult {
  return html`<svg
    class="slack-logo"
    width=${size}
    height=${size}
    viewBox="0 0 122.8 122.8"
    fill="currentColor"
    aria-hidden="true"
    focusable="false"
  >
    <path
      d="M25.8 77.6c0 7.1-5.8 12.9-12.9 12.9S0 84.7 0 77.6s5.8-12.9 12.9-12.9h12.9v12.9zm6.5 0c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9v32.3c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V77.6z"
    />
    <path
      d="M45.2 25.8c-7.1 0-12.9-5.8-12.9-12.9S38.1 0 45.2 0s12.9 5.8 12.9 12.9v12.9H45.2zm0 6.5c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H12.9C5.8 58.1 0 52.3 0 45.2s5.8-12.9 12.9-12.9h32.3z"
    />
    <path
      d="M97 45.2c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9-5.8 12.9-12.9 12.9H97V45.2zm-6.5 0c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V12.9C64.7 5.8 70.5 0 77.6 0s12.9 5.8 12.9 12.9v32.3z"
    />
    <path
      d="M77.6 97c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9-12.9-5.8-12.9-12.9V97h12.9zm0-6.5c-7.1 0-12.9-5.8-12.9-12.9s5.8-12.9 12.9-12.9h32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H77.6z"
    />
  </svg>`;
}

/**
 * Every session the viewer has, newest first. There is deliberately no surface filter: web
 * and Slack conversations each have their own home in the list, and the machine-made ones
 * (cron fires, credential drops) carry no participant so they never reach a sidebar in the
 * first place. Cron runs belong to the Crons page, which shows them per-cron.
 */
function visibleSessions(): CoreSession[] {
  return [...sessionsState.list].sort((a, b) => activityOf(b) - activityOf(a));
}

export function renderList(): void {
  if (!appState.listEl) return;
  const visible = visibleSessions();
  const active = visible.filter((s) => !s.archived);
  const archived = visible.filter((s) => s.archived);
  const { pinned, rest } = splitPinned(active);
  // Rooms are their own surface, so they come out before chats are grouped by project and
  // recency — a room never nests under a project heading.
  const { rooms, rest: afterRooms } = splitRooms(rest);
  // Slack is its own surface too, with its own sidebar home — it never nests under a
  // project heading or a date bucket, and it shows regardless of the "Web only" toggle.
  const { slack, rest: chats } = splitSlack(afterRooms);
  const activeItems = recentItemsFor(chats);
  const archivedItems: RecentItem[] = archived.map((session) => ({ kind: "session", session }));
  armMidnightRefresh();
  render(
    html`
      ${
        pinned.length
          ? html`
              <div class="recents-group pinned-head">${icon(Pin, 11)}<span>Pinned</span></div>
              ${repeat(
                pinned,
                (session) => session.threadRef,
                (session) => sessionRow(session),
              )}
            `
          : nothing
      }
      ${
        rooms.length
          ? html`
              <div class="recents-group rooms-head">
                ${icon(Users, 11)}<span>Rooms</span>
                <button
                  class="recent-project-new-chat rooms-head-new"
                  type="button"
                  title="New room"
                  aria-label="New room"
                  @click=${startNewRoom}
                >
                  ${icon(Plus, 14)}
                </button>
              </div>
              ${repeat(
                rooms,
                (session) => session.threadRef,
                (session) => sessionRow(session),
              )}
            `
          : nothing
      }
      ${
        slack.length
          ? html`
              <div class="recents-group slack-head">${slackLogo(11)}<span>Slack</span></div>
              ${repeat(
                groupSlackChannels(slack),
                (item) => (item.kind === "channel" ? `slack-channel:${item.channelId}` : item.session.threadRef),
                (item) => (item.kind === "channel" ? slackChannelGroup(item) : sessionRow(item.session)),
              )}
            `
          : nothing
      }
      ${groupedRows(activeItems)}
      ${
        archived.length
          ? html`
              <button class="archived-toggle ${showArchived ? "open" : ""}" @click=${toggleShowArchived}>
                ${icon(showArchived ? ChevronDown : ChevronRight, 14)} ${icon(Archive, 14)}
                <span>Archived</span>
                <span class="archived-count">${archived.length}</span>
              </button>
              ${showArchived ? groupedRows(archivedItems) : nothing}
            `
          : nothing
      }
      ${sessionsNotice ? html`<div class="empty" style="padding:16px">${sessionsNotice}</div>` : ""}
      ${sessionsLoading && visible.length === 0 ? html`<div class="empty" style="padding:16px">Loading conversations...</div>` : ""}
      ${
        !sessionsLoading && !sessionsNotice && visible.length === 0
          ? html`<div class="empty" style="padding:16px">
              ${sessionsState.list.length ? "Other conversations hidden." : "No conversations yet."}
            </div>`
          : ""
      }
    `,
    appState.listEl,
  );
  if (sessionsState.openMenuId) {
    requestAnimationFrame(() => placeSessionMenu(appState.listEl?.querySelector(".session-menu-popover") ?? undefined));
  }
  notifySessionsChanged();
}

function recentItem(item: RecentItem): TemplateResult {
  if (item.kind === "session") return sessionRow(item.session);
  const collapsed = sessionsState.collapsedProjectScopes.has(item.scopeId);
  let glyph = Folder;
  if (item.groupKind === "personal") glyph = User;
  else if (item.groupKind === "channel") glyph = Hash;
  else if (item.groupKind === "group") glyph = Users;
  let fallbackName = "Project";
  if (item.groupKind === "channel") fallbackName = "Channel";
  else if (item.groupKind === "group") fallbackName = "Group DM";
  const name = item.name ?? fallbackName;
  const childrenId = `recent-${item.scopeId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const menuKey = projectMenuKey(item.scopeId);
  const menuOpen = sessionsState.openMenuId === menuKey;
  return html`
    <section class="recent-project ${item.sessions.some(isActiveRow) ? "active" : ""}" aria-label=${`${name} project`}>
      ${
        sessionsState.renamingId === menuKey
          ? projectRenameRow(item)
          : html`<div class="recent-project-head">
              <button
                class="recent-project-toggle"
                type="button"
                aria-expanded=${collapsed ? "false" : "true"}
                aria-controls=${childrenId}
                @click=${() => toggleRecentProject(item.scopeId)}
              >
                ${icon(collapsed ? ChevronRight : ChevronDown, 13)} ${icon(glyph, 14)}
                <span class="recent-project-name">${name.replace(/^#/, "")}</span>
              </button>
              <div class="session-menu recent-project-menu ${menuOpen ? "menu-open" : ""}">
                <span class="recent-project-count">${item.sessions.length}</span>
                <button
                  class="session-menu-btn"
                  data-menu-id=${menuKey}
                  type="button"
                  title="Project options"
                  aria-label=${`Options for ${name}`}
                  aria-haspopup="menu"
                  aria-expanded=${menuOpen ? "true" : "false"}
                  @click=${(e: Event) => toggleSessionMenu(e, menuKey)}
                >
                  ${icon(EllipsisVertical, 17)}
                </button>
                ${menuOpen ? projectMenuPopover(item) : nothing}
              </div>
              <button
                class="recent-project-new-chat"
                type="button"
                aria-label=${`New chat in ${name}`}
                title=${`New chat in ${name}`}
                @click=${(event: Event) => startProjectChat(event, item.scopeId, item.name)}
              >
                ${icon(Plus, 14)}
              </button>
            </div>`
      }
      <div class="recent-project-children" id=${childrenId} ?hidden=${collapsed}>
        ${repeat(
          item.sessions,
          (session) => session.threadRef,
          (session) => sessionRow(session, "project"),
        )}
      </div>
    </section>
  `;
}

/**
 * A Slack channel heading with its threads nested underneath.
 *
 * The channel is the room; the threads inside it are where the context lives — so the
 * sidebar mirrors Slack's own shape instead of flattening five threads of one channel into
 * five near-identical rows. Deliberately reuses the project group's markup, and therefore
 * its indent rail, collapse chevron and count chip: this is the same "heading with children"
 * affordance, and giving it a second look would be a lie about how it behaves. It differs in
 * two ways only — a Slack glyph in place of the folder, and no way to start a conversation,
 * because a thread is started in Slack.
 */
/** The `#name` (or bare channel id, if nothing has resolved a name yet) a channel heading shows — the one piece of `SlackListItem` shape both the sidebar and the Chats page's Slack section read the same way. */
function slackChannelName(item: Extract<SlackListItem, { kind: "channel" }>): string {
  return item.name ? `#${item.name}` : item.channelId;
}

/**
 * The lock chip on a private Slack channel heading. Visually identical to `privateMark`'s
 * row-level chip, but kept separate from it: `privateMark` is keyed off `isPrivateSlackRow`
 * (a DM/group participant fact carried on the session itself), while a channel's privacy
 * comes from the `/api/contexts` join (`isPrivateSlackChannel`) instead — a channel session's
 * `type` is always `"channel"`, so `isPrivateSlackRow` would never fire for one anyway. Shared
 * by both the sidebar's `slackChannelGroup` and the Chats page's channel heading, so "what
 * makes a channel heading say private" lives in exactly one place.
 */
function channelPrivateMark(channelId: string): TemplateResult | typeof nothing {
  if (!isPrivateSlackChannel(channelId, contextsState.list)) return nothing;
  return html`<span class="private-chip" title="Private channel">${icon(Lock, 10)}<span>Private</span></span>`;
}

/**
 * The channel row's kebab, and the one thing in it.
 *
 * The debate-rounds ceiling is a fact about the CHANNEL, but until now the only door to it
 * was inside an open thread — which taught people it was a per-thread setting. It belongs on
 * the row that represents the channel, in the same kebab a project row and a room row already
 * carry. `scopeId` is `channelRoundsScopeFor`'s answer over the threads mirrored under this
 * heading, i.e. exactly the scope the in-conversation control writes to.
 */
function channelMenuPopover(item: Extract<SlackListItem, { kind: "channel" }>, scopeId: string): TemplateResult {
  return html`
    <div class="session-menu-popover" role="menu" ${ref(placeSessionMenu)} @click=${(e: Event) => e.stopPropagation()}>
      <button
        class="session-menu-option session-menu-channel-rounds"
        type="button"
        role="menuitem"
        @click=${() => {
          sessionsState.openMenuId = null;
          renderList();
          openChannelRoundsDialog(scopeId, slackChannelName(item));
        }}
      >
        ${icon(Repeat, 15)}<span>Debate rounds…</span>
      </button>
    </div>
  `;
}

function slackChannelGroup(item: Extract<SlackListItem, { kind: "channel" }>): TemplateResult {
  const collapsed = sessionsState.collapsedSlackChannels.has(item.channelId);
  const name = slackChannelName(item);
  const childrenId = `slack-channel-${item.channelId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  // Null for a channel whose threads carry no policy scope — the same channels whose open
  // conversations show no rounds control either. No scope, no kebab: the row never offers a
  // setting that has nowhere to be stored.
  const scopeId = channelRoundsScopeFor(item.sessions);
  const menuKey = `slack-channel:${item.channelId}`;
  const menuOpen = sessionsState.openMenuId === menuKey;
  return html`
    <section
      class="recent-project slack-channel ${item.sessions.some(isActiveRow) ? "active" : ""}"
      aria-label=${`${name} channel`}
    >
      <div class="recent-project-head">
        <button
          class="recent-project-toggle"
          type="button"
          aria-expanded=${collapsed ? "false" : "true"}
          aria-controls=${childrenId}
          @click=${() => toggleSlackChannel(item.channelId)}
        >
          ${icon(collapsed ? ChevronRight : ChevronDown, 13)} ${slackLogo(12)}
          <span class="recent-project-name">${name}</span>
          ${channelPrivateMark(item.channelId)}
        </button>
        ${
          scopeId
            ? html`<div class="session-menu recent-project-menu ${menuOpen ? "menu-open" : ""}">
                <span class="recent-project-count">${item.sessions.length}</span>
                <button
                  class="session-menu-btn"
                  data-menu-id=${menuKey}
                  type="button"
                  title="Channel options"
                  aria-label=${`Options for ${name}`}
                  aria-haspopup="menu"
                  aria-expanded=${menuOpen ? "true" : "false"}
                  @click=${(e: Event) => toggleSessionMenu(e, menuKey)}
                >
                  ${icon(EllipsisVertical, 17)}
                </button>
                ${menuOpen ? channelMenuPopover(item, scopeId) : nothing}
              </div>`
            : html`<span class="recent-project-count">${item.sessions.length}</span>`
        }
      </div>
      <div class="recent-project-children" id=${childrenId} ?hidden=${collapsed}>
        ${repeat(
          item.sessions,
          (session) => session.threadRef,
          (session) => sessionRow(session, "channel"),
        )}
      </div>
    </section>
  `;
}

function toggleSlackChannel(channelId: string): void {
  if (sessionsState.collapsedSlackChannels.has(channelId)) sessionsState.collapsedSlackChannels.delete(channelId);
  else sessionsState.collapsedSlackChannels.add(channelId);
  renderList();
}

/**
 * The Chats page's own collapse toggle. It shares `collapsedSlackChannels` with the sidebar —
 * so a channel collapsed on one surface starts collapsed on the other the next time it draws
 * — but repaints only the Chats page, exactly as the sidebar's `toggleSlackChannel` repaints
 * only the sidebar. Neither surface needs to reach across and repaint the other: whichever one
 * the person is looking at repaints itself, and the shared store keeps them agreeing once both
 * have had a turn to draw.
 */
function toggleChatsPageSlackChannel(channelId: string): void {
  if (sessionsState.collapsedSlackChannels.has(channelId)) sessionsState.collapsedSlackChannels.delete(channelId);
  else sessionsState.collapsedSlackChannels.add(channelId);
  drawChatsPage();
}

function toggleRecentProject(scopeId: string): void {
  if (sessionsState.collapsedProjectScopes.has(scopeId)) sessionsState.collapsedProjectScopes.delete(scopeId);
  else sessionsState.collapsedProjectScopes.add(scopeId);
  renderList();
}

function startProjectChat(event: Event, scopeId: string, name: string | null): void {
  event.stopPropagation();
  closeSidebarOnNarrowView();
  sessionsState.collapsedProjectScopes.delete(scopeId);
  if (addBlankPane(scopeId)) return;
  addPendingSession(mainConversation().newChat({ scopeId, name }), scopeId, name);
}

function projectMenuPopover(item: Extract<RecentItem, { kind: "project" }>): TemplateResult {
  const owned = projectOf(item.scopeId)?.ownerId === appState.me?.user;
  return html`
    <div class="session-menu-popover" role="menu" ${ref(placeSessionMenu)} @click=${(e: Event) => e.stopPropagation()}>
      <button
        class="session-menu-option"
        type="button"
        role="menuitem"
        @click=${() => openProjectFromMenu(item.scopeId)}
      >
        ${icon(Folder, 15)}<span>View project</span>
      </button>
      ${
        owned
          ? html`<button
              class="session-menu-option"
              type="button"
              role="menuitem"
              @click=${() => beginRename(projectMenuKey(item.scopeId), item.name ?? "")}
            >
              ${icon(Pencil, 15)}<span>Rename</span>
            </button>`
          : nothing
      }
    </div>
  `;
}

function openProjectFromMenu(scopeId: string): void {
  sessionsState.openMenuId = null;
  openProjectDetail(scopeId);
}

function projectRenameRow(item: Extract<RecentItem, { kind: "project" }>): TemplateResult {
  const menuKey = projectMenuKey(item.scopeId);
  return html`<div class="recent-project-head renaming">
    ${renameInput(menuKey, "Rename project", () => commitProjectRename(item))}
  </div>`;
}

async function commitProjectRename(item: Extract<RecentItem, { kind: "project" }>): Promise<void> {
  if (sessionsState.renamingId !== projectMenuKey(item.scopeId)) return;
  const next = renameDraft.trim();
  sessionsState.renamingId = null;
  renameDraft = "";
  renderList();
  const project = projectOf(item.scopeId);
  if (!project || !next || next === project.name) return;
  await renameProject(project, next);
  renderList();
}

export async function renderChatsPage(): Promise<void> {
  if (appState.currentView !== "chats") return;
  await ensureContexts();
  drawChatsPage();
  await refreshSessions({ showLoading: sessionsState.list.length === 0, silent: sessionsState.list.length > 0 });
  if (appState.currentView === "chats") drawChatsPage();
}

export function drawChatsPage(): void {
  if (appState.currentView !== "chats" || !appState.mainEl || splitState.active) return;
  mainConversation().state.host = null;
  if (!chatsPageHost || chatsPageHost.parentElement !== appState.mainEl) {
    chatsPageHost = document.createElement("div");
    chatsPageHost.className = "pane chats-page";
    appState.mainEl.replaceChildren(chatsPageHost);
  }
  const q = chatsPageQuery.trim().toLowerCase();
  const filtered = [...sessionsState.list]
    .filter((s) => chatBrowseStatusMatches(s, chatsPageStatus))
    .filter((s) => chatsPageSurface === "all" || surfaceOf(s) === chatsPageSurface)
    .filter((s) => (chatsPageScope ? s.scopeId === chatsPageScope : true))
    .filter((s) => !q || chatMatches(s, q))
    .sort((a, b) => activityOf(b) - activityOf(a));
  // Rooms and Slack each get their own section ahead of ordinary chats, same as the sidebar —
  // split after every filter above so status/surface/scope/search apply to every section
  // alike, and skip a section's heading entirely when the filters leave it empty. A filtered
  // channel with no matching threads simply never reaches `groupSlackChannels`, so it renders
  // nothing rather than an empty heading.
  const { rooms, rest: afterRooms } = splitRooms(filtered);
  const { slack, rest: chats } = splitSlack(afterRooms);
  const rows = [
    ...(rooms.length ? [listSectionHead("Rooms", Users), ...rooms.map((s) => chatPageRow(s))] : []),
    ...(slack.length
      ? [
          slackSectionHead(),
          ...groupSlackChannels(slack).map((item) =>
            item.kind === "channel" ? chatsPageSlackChannel(item) : chatPageRow(item.session),
          ),
        ]
      : []),
    ...(chats.length ? [listSectionHead("Chats", MessageSquare), ...chats.map((s) => chatPageRow(s))] : []),
  ];
  let empty = "No conversations yet — start a new chat.";
  if (sessionsLoading && sessionsState.list.length === 0) empty = "Loading conversations…";
  else if (chatsPageScope || q || chatsPageStatus !== "active" || chatsPageSurface !== "all") {
    empty = "No conversations match.";
  }
  render(
    listPageTpl({
      title: "Chats",
      scope: chatsPageScope,
      onScope: (s) => {
        chatsPageScope = s;
        drawChatsPage();
      },
      onRefresh: () => void renderChatsPage(),
      action: { label: "New chat", onClick: () => mainConversation().newChat() },
      search: {
        value: chatsPageQuery,
        placeholder: "Search chats…",
        onInput: (v) => {
          chatsPageQuery = v;
          drawChatsPage();
        },
      },
      filters: html`<div class="chat-filters">
        <div class="resource-tabs" role="tablist" aria-label="Conversation status">
          ${(
            [
              ["active", "Active"],
              ["waiting", "Waiting"],
              ["archived", "Archived"],
            ] as const
          ).map(
            ([value, label]) =>
              html`<button
                role="tab"
                type="button"
                aria-selected=${chatsPageStatus === value}
                class=${chatsPageStatus === value ? "active" : ""}
                @click=${() => {
                  chatsPageStatus = value;
                  drawChatsPage();
                }}
              >
                ${label}<span
                  >${sessionsState.list.filter((session) => chatBrowseStatusMatches(session, value)).length}</span
                >
              </button>`,
          )}
        </div>
        <label class="list-select"
          ><span>Surface</span>${fieldSelect({
            compact: true,
            value: chatsPageSurface,
            onChange: (value) => {
              chatsPageSurface = value as typeof chatsPageSurface;
              drawChatsPage();
            },
            options: [
              html`<option value="all">All surfaces</option>`,
              html`<option value="web">Web</option>`,
              html`<option value="slack">Slack</option>`,
            ],
          })}</label
        >
      </div>`,
      rows,
      empty,
    }),
    chatsPageHost,
  );
}

function chatMatches(s: CoreSession, q: string): boolean {
  const context = sharedContextLabel(s.scopeId, s.channelName ?? null) ?? "Personal";
  return [sessionTitle(s), s.channelName ?? "", context].join(" ").toLowerCase().includes(q);
}

/** The Chats page's "Slack" section heading — same glyph and label as the sidebar's, laid out as a `list-section-head` so the two "Rooms"/"Chats" headings either side of it read as one family. */
function slackSectionHead(): TemplateResult {
  return html`<div class="list-section-head">${slackLogo(13)}<span>Slack</span></div>`;
}

/**
 * A channel heading for the Chats page's Slack section: the channel is the room, its threads
 * are nested underneath, exactly the shape `slackChannelGroup` draws in the sidebar — same
 * `groupSlackChannels` data, same name fallback, same private-channel chip, same
 * `collapsedSlackChannels` store (so expanding a channel here expands it in the sidebar too).
 * It differs only in layout: the Chats page's wider `list-row` idiom instead of the sidebar's
 * narrow rail, because the two panes have different CSS to begin with.
 */
function chatsPageSlackChannel(item: Extract<SlackListItem, { kind: "channel" }>): TemplateResult {
  const collapsed = sessionsState.collapsedSlackChannels.has(item.channelId);
  const name = slackChannelName(item);
  const childrenId = `chats-slack-channel-${item.channelId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  return html`
    <div class="chat-slack-channel">
      <button
        class="chat-slack-channel-head"
        type="button"
        aria-expanded=${collapsed ? "false" : "true"}
        aria-controls=${childrenId}
        @click=${() => toggleChatsPageSlackChannel(item.channelId)}
      >
        ${icon(collapsed ? ChevronRight : ChevronDown, 13)} ${slackLogo(13)}
        <span class="chat-slack-channel-name">${name}</span>
        ${channelPrivateMark(item.channelId)}
        <span class="chat-slack-channel-count">${item.sessions.length}</span>
      </button>
      <div class="chat-slack-channel-children" id=${childrenId} ?hidden=${collapsed}>
        ${item.sessions.map((s) => chatPageRow(s))}
      </div>
    </div>
  `;
}

export const syncWorkingPulse = (el?: Element): void => {
  if (!(el instanceof HTMLElement)) return;
  const pin = (): void => {
    for (const a of el.getAnimations()) a.startTime = 0;
  };
  if (el.getAnimations().length > 0) pin();
  else requestAnimationFrame(pin);
};

function liveThreads(): ReadonlySet<string> {
  const live = new Set<string>();
  for (const conv of allConversations()) {
    const ref = liveTurnThreadRef({
      mountedThreadRef: conv.state.threadRef,
      isStreaming: Boolean(conv.state.agent?.state.isStreaming),
      pendingSend: conv.state.pendingSend,
    });
    if (ref) live.add(ref);
  }
  return live;
}

function sessionWorking(s: CoreSession): boolean {
  return rowIndicators(s, liveThreads()).working;
}

function statusMarks(s: CoreSession): TemplateResult {
  const ind = rowIndicators(s, liveThreads());
  return html`${ind.working ? html`<span class="working-dot" ${ref(syncWorkingPulse)} title="Agent is working" aria-label="Agent is working"></span>` : nothing}${
    ind.awaiting
      ? html`<span class="awaiting-dot" title="Waiting for your reply" aria-label="Waiting for your reply"></span>`
      : nothing
  }${
    ind.background
      ? html`<span
          class="bg-chip"
          role="button"
          tabindex="0"
          aria-label="${ind.background.label} — click to inspect"
          @mouseenter=${(e: Event) =>
            showTooltip(e.currentTarget as Element, `${ind.background!.label} — click to inspect`)}
          @mouseleave=${(e: Event) => hideTooltip(e.currentTarget as Element)}
          @focus=${(e: Event) => showTooltip(e.currentTarget as Element, `${ind.background!.label} — click to inspect`)}
          @blur=${(e: Event) => hideTooltip(e.currentTarget as Element)}
          @click=${(e: Event) => openBackgroundInspector(e, s)}
          @keydown=${(e: KeyboardEvent) => (e.key === "Enter" || e.key === " ") && openBackgroundInspector(e, s)}
          >${ind.background.jobs > 0 ? icon(Cog, 11) : nothing}${
            ind.background.watches > 0 ? icon(Binoculars, 11) : nothing
          }</span
        >`
      : nothing
  }`;
}

function openBackgroundInspector(e: Event, s: CoreSession): void {
  e.stopPropagation();
  e.preventDefault();
  mainConversation().requestBackgroundPanel(s.id || null, s.threadRef);
  void openSession(s);
}

function isActiveRow(s: CoreSession): boolean {
  if (splitState.active) return Boolean(s.id) && sessionInCanvas(s.id);
  if (sessionsState.openingKey) return Boolean(s.id) && s.id === sessionsState.openingKey;
  const main = mainConversation().state;
  // Leaving the Chats view tears the mounted conversation down (sessionId/threadRef go
  // null) so the transcript pane doesn't linger on another view, but `remembered*` survives
  // that teardown — fall back to it so the now-persistent sidebar keeps highlighting "your"
  // chat while it's visible alongside Files, Crons, etc.
  const sessionId = main.sessionId ?? main.rememberedSessionId;
  const threadRef = main.threadRef ?? main.rememberedThreadRef;
  return Boolean((sessionId && s.id === sessionId) || (threadRef && s.threadRef === threadRef));
}

function chatPageRow(s: CoreSession): TemplateResult {
  const active = isActiveRow(s);
  const readOnly = !isContinuable(s, appState.me?.user ?? "");
  return html`
    <div
      class="list-row chat-row ${active ? "active" : ""} ${s.color ? "colored" : ""}"
      style=${s.color ? `--session-color:${s.color}` : nothing}
    >
      <button class="chat-row-open" type="button" @click=${() => void openSession(s)}>
        <span class="list-row-title">${statusMarks(s)}${groupDmTitle(s)}</span>
        <span class="list-row-meta">
          ${scopeChip(s.scopeId, s.channelName ?? null)}
          ${surfaceOf(s) === "slack" ? html`<span class="surface surface-slack">${slackLogo(13)}</span>` : nothing}
          ${readOnly ? html`<span class="ro-lock" title="Read-only">${icon(Lock, 12)}</span>` : nothing}
          <span class="list-row-date">${listWhen(activityOf(s))}</span>
        </span>
      </button>
      ${
        s.id
          ? html`<span class="chat-row-actions">
              <button
                class="icon-btn"
                type="button"
                title="Copy link"
                aria-label=${`Copy link to ${sessionTitle(s)}`}
                @click=${() => void copyText(sessionLink(location.origin, UI_BASE, s.id))}
              >
                ${icon(Link, 14)}
              </button>
              <button
                class="icon-btn"
                type="button"
                title=${s.pinned ? "Unpin" : "Pin"}
                aria-label=${`${s.pinned ? "Unpin" : "Pin"} ${sessionTitle(s)}`}
                @click=${() => {
                  setPinned(s, !s.pinned);
                  drawChatsPage();
                }}
              >
                ${s.pinned ? icon(PinOff, 14) : icon(Pin, 14)}
              </button>
              <button
                class="icon-btn"
                type="button"
                title=${s.archived ? "Unarchive" : "Archive"}
                aria-label=${`${s.archived ? "Unarchive" : "Archive"} ${sessionTitle(s)}`}
                @click=${() => {
                  setArchived(s, !s.archived);
                  drawChatsPage();
                }}
              >
                ${s.archived ? icon(ArchiveRestore, 14) : icon(Archive, 14)}
              </button>
            </span>`
          : nothing
      }
    </div>
  `;
}

export function addPendingSession(threadRef: string, scopeId: string | null, channelName: string | null): void {
  const scope = scopeId ?? personalScopeId();
  let type: CoreSession["type"] = "dm";
  if (scope?.startsWith("group:")) type = "group";
  else if (scope?.startsWith("channel:")) type = "channel";
  const pending: CoreSession = {
    id: "",
    type,
    scopeId: scope ?? "",
    threadRef,
    createdAt: Date.now(),
    title: null,
    channelName,
    archived: false,
  };
  sessionsState.list = withPendingSession(sessionsState.list, pending);
  renderList();
}

/**
 * Stamps the roster and name a brand-new room just picked onto its not-yet-saved sidebar
 * row, so it files under Rooms with its name from the moment it is created rather than
 * sitting in Chats as "Web chat" until the first message creates the session. The server
 * copy overwrites this the moment it exists.
 */
export function notePendingRoom(threadRef: string, room: RoomConfig, title: string): void {
  sessionsState.list = sessionsState.list.map((s) => (s.threadRef === threadRef ? { ...s, room, title } : s));
  renderList();
}

export function dropPendingSession(threadRef: string): void {
  sessionsState.list = withoutUnsentPending(sessionsState.list, threadRef);
  renderList();
}

export function bumpSessionActivity(threadRef: string): void {
  sessionsState.list = bumpActivity(sessionsState.list, threadRef, Date.now());
  renderList();
}

function groupedRows(list: RecentItem[]): TemplateResult {
  const now = Date.now();
  const items: { key: string; tpl: TemplateResult }[] = [];
  let group: string | null = null;
  for (const item of list) {
    const dateless = item.kind === "project" && item.sessions.length === 0;
    const g = recencyGroup(recentItemActivity(item), now);
    if (!dateless && g !== group) {
      group = g;
      items.push({ key: `group:${g}`, tpl: html`<div class="recents-group">${g}</div>` });
    }
    const key = item.kind === "session" ? item.session.threadRef : `project:${item.scopeId}`;
    items.push({ key, tpl: recentItem(item) });
  }
  return html`${repeat(
    items,
    (it) => it.key,
    (it) => it.tpl,
  )}`;
}

let midnightTimer: number | undefined;
function armMidnightRefresh(): void {
  if (midnightTimer !== undefined) window.clearTimeout(midnightTimer);
  const d = new Date();
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  midnightTimer = window.setTimeout(
    () => {
      midnightTimer = undefined;
      renderList();
    },
    Math.max(1_000, next - Date.now()),
  );
}

function surfaceGlyph(s: CoreSession): TemplateResult | typeof nothing {
  const surface = surfaceOf(s);
  if (surface === "slack") return html`<span class="surface-glyph">${slackLogo(12)}</span>`;
  if (surface === "core") return html`<span class="surface-glyph">${icon(SquareTerminal, 12)}</span>`;
  return nothing;
}

/** The "Private" prefix on a Slack DM row (see `isPrivateSlackRow` for why only those). */
function privateMark(s: CoreSession): TemplateResult | typeof nothing {
  if (!isPrivateSlackRow(s)) return nothing;
  return html`<span class="private-chip" title="Private conversation">${icon(Lock, 10)}<span>Private</span></span>`;
}

function rowContext(s: CoreSession): string | null {
  let label = sharedContextLabel(s.scopeId, s.channelName ?? null);
  if (surfaceOf(s) === "slack") {
    // A DM's `channelName` is the counterpart already shown as the title — never a `#room`.
    if (s.type === "dm") label = null;
    else label = s.type === "group" ? groupDmText(s.channelName) : channelLabel(s);
  }
  return label && label !== sessionTitle(s) ? label : null;
}

/**
 * How a row sits in the list. `"project"` and `"channel"` are both nested — same indent
 * rail, same suppressed context label, because the heading above already says it — but only
 * a project child renames itself: an untitled web chat under a project reads better as "New
 * chat" than as the project's own name, whereas a Slack thread's title is derived from its
 * root message and is the whole point of the row.
 */
type RowNesting = "flat" | "project" | "channel";

function sessionRow(s: CoreSession, nesting: RowNesting = "flat"): TemplateResult {
  const saved = Boolean(s.id);
  if (saved && sessionsState.renamingId === s.id) return renameRow(s);
  const active = isActiveRow(s);
  const menuOpen = saved && sessionsState.openMenuId === s.id;
  const refreshingTitle = saved && refreshingTitleIds.has(s.id);
  const nested = nesting !== "flat";
  const untitledProjectChild = nesting === "project" && !s.title?.trim();
  let title = sessionTitle(s);
  if (untitledProjectChild) title = surfaceOf(s) === "web" ? "Web chat" : "New chat";
  const readOnly = !isContinuable(s, appState.me?.user ?? "");
  const surface = surfaceOf(s);
  const room = isRoomSession(s);
  const context = nested ? null : rowContext(s);
  const working = sessionWorking(s);
  let titleContent: string | TemplateResult = groupDmTitle(s);
  if (refreshingTitle) {
    titleContent = html`<span class="sheen-label title-sheen thinking-sheen" data-sheen=${title}>${title}</span>`;
  } else if (untitledProjectChild) {
    titleContent = title;
  }
  const ariaLabel = [
    title,
    room ? "room" : null,
    surface !== "web" ? surface : null,
    isPrivateSlackRow(s) ? "private" : null,
    context,
    working ? "agent is working" : null,
    s.awaitingInput ? "waiting for your reply" : null,
    readOnly ? "read-only" : null,
    s.pinned ? "pinned" : null,
    relTime(activityOf(s)),
  ]
    .filter(Boolean)
    .join(", ");
  return html`
    <div
      class="session-row ${active ? "active" : ""} ${menuOpen ? "menu-open" : ""} ${readOnly ? "read-only" : ""} ${refreshingTitle ? "title-refreshing" : ""} ${working ? "working" : ""} ${s.awaitingInput ? "awaiting-input" : ""} ${nested ? "project-child" : ""} ${room ? "room-row" : ""} ${s.color ? "colored" : ""}"
      style=${s.color ? `--session-color:${s.color}` : nothing}
    >
      <button
        class="session"
        aria-busy=${refreshingTitle ? "true" : "false"}
        aria-label=${ariaLabel}
        draggable=${saved ? "true" : "false"}
        @dragstart=${(e: DragEvent) => onSessionDragStart(e, s)}
        @dragend=${() => endSessionDrag()}
        @click=${() => openSession(s)}
        @dblclick=${(e: Event) => {
          if (!saved) return;
          e.preventDefault();
          startRename(s);
        }}
      >
        <div class="title" aria-live="polite">
          ${statusMarks(s)}${surfaceGlyph(s)}${privateMark(s)}${roomRosterDots(s.room)}${readOnly ? html`<span class="ro-lock" title="Read-only">${icon(Lock, 12)}</span>` : nothing}<span
            class="tl"
            >${titleContent}</span
          >${context ? html`<span class="row-context" title=${context}>${context}</span>` : nothing}
        </div>
      </button>
      ${
        saved
          ? html`<div class="session-menu">
              <button
                class="session-menu-btn session-archive-btn"
                type="button"
                title=${s.archived ? "Unarchive" : "Archive"}
                aria-label=${`${s.archived ? "Unarchive" : "Archive"} ${sessionTitle(s)}`}
                @click=${(e: Event) => {
                  e.stopPropagation();
                  setArchived(s, !s.archived);
                }}
              >
                ${s.archived ? icon(ArchiveRestore, 15) : icon(Archive, 15)}
              </button>
              <button
                class="session-menu-btn"
                data-menu-id=${s.id}
                type="button"
                title="Conversation options"
                aria-haspopup="menu"
                aria-expanded=${menuOpen ? "true" : "false"}
                @click=${(e: Event) => toggleSessionMenu(e, s.id)}
              >
                ${icon(EllipsisVertical, 17)}
              </button>
              ${menuOpen ? sessionMenuPopover(s) : nothing}
            </div>`
          : nothing
      }
    </div>
  `;
}

function onSessionDragStart(e: DragEvent, s: CoreSession): void {
  if (!s.id) {
    e.preventDefault();
    return;
  }
  e.dataTransfer?.setData("application/x-webui-session", s.id);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  beginSessionDrag(s);
}

const placeSessionMenu = (el?: Element): void => {
  if (!(el instanceof HTMLElement)) return;
  el.classList.remove("drop-up");
  const margin = 8;
  const scrollport = el.closest(".list")?.getBoundingClientRect();
  const bottomLimit = Math.min(window.innerHeight, scrollport?.bottom ?? Infinity) - margin;
  const topLimit = Math.max(0, scrollport?.top ?? 0) + margin;
  const rect = el.getBoundingClientRect();
  const anchorTop = el.parentElement?.getBoundingClientRect().top ?? rect.top;
  if (rect.bottom > bottomLimit && anchorTop - 4 - rect.height >= topLimit) {
    el.classList.add("drop-up");
  }
};

function sessionMenuPopover(s: CoreSession): TemplateResult {
  const archived = Boolean(s.archived);
  const pinned = Boolean(s.pinned);
  const refreshingTitle = refreshingTitleIds.has(s.id);
  return html`
    <div class="session-menu-popover" role="menu" ${ref(placeSessionMenu)} @click=${(e: Event) => e.stopPropagation()}>
      <button class="session-menu-option" type="button" role="menuitem" @click=${() => void copySessionLink(s)}>
        ${icon(Link, 15)}<span>Copy link</span>
      </button>
      <button class="session-menu-option" type="button" role="menuitem" @click=${() => setPinned(s, !pinned)}>
        ${pinned ? icon(PinOff, 15) : icon(Pin, 15)}<span>${pinned ? "Unpin" : "Pin"}</span>
      </button>
      <button class="session-menu-option" type="button" role="menuitem" @click=${() => startRename(s)}>
        ${icon(Pencil, 15)}<span>Rename</span>
      </button>
      ${
        isRoomSession(s)
          ? html`<button
              class="session-menu-option session-menu-edit-room"
              type="button"
              role="menuitem"
              @click=${() => startRoomEdit(s)}
            >
              ${icon(Users, 15)}<span>Edit room</span>
            </button>`
          : nothing
      }
      ${
        autoTitleable(s)
          ? html`<button
              class="session-menu-option"
              type="button"
              role="menuitem"
              ?disabled=${refreshingTitle}
              @click=${() => void refreshSessionTitle(s)}
            >
              ${icon(RefreshCw, 15)}<span>${refreshingTitle ? "Refreshing title" : "Refresh title"}</span>
            </button>`
          : nothing
      }
      <button class="session-menu-option" type="button" role="menuitem" @click=${() => setArchived(s, !archived)}>
        ${archived ? icon(ArchiveRestore, 15) : icon(Archive, 15)}<span>${archived ? "Unarchive" : "Archive"}</span>
      </button>
      ${sessionColorRow(s)}
    </div>
  `;
}

const SESSION_COLORS = ["#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#a855f7", "#ec4899"] as const;

function sessionColorRow(s: CoreSession): TemplateResult {
  const current = s.color?.toLowerCase() ?? null;
  const isPreset = SESSION_COLORS.includes(current as (typeof SESSION_COLORS)[number]);
  return html`
    <div class="session-menu-colors" role="group" aria-label="Row color">
      ${SESSION_COLORS.map(
        (c) => html`
          <button
            class="color-swatch ${current === c ? "selected" : ""}"
            type="button"
            style=${`--swatch:${c}`}
            title=${`Color row ${c}`}
            aria-label=${`Color row ${c}`}
            aria-pressed=${current === c ? "true" : "false"}
            @click=${() => setColor(s, current === c ? null : c)}
          ></button>
        `,
      )}
      <label class="color-swatch custom ${current && !isPreset ? "selected" : ""}" title="Custom color (RGB picker)">
        <input
          type="color"
          aria-label="Custom row color"
          value=${current ?? "#6366f1"}
          @click=${(e: Event) => e.stopPropagation()}
          @input=${(e: InputEvent) => previewColor(s, (e.currentTarget as HTMLInputElement).value)}
          @change=${(e: Event) => setColor(s, (e.currentTarget as HTMLInputElement).value)}
        />
      </label>
      ${
        current
          ? html`<button
              class="color-swatch clear"
              type="button"
              title="Clear color"
              aria-label="Clear row color"
              @click=${() => setColor(s, null)}
            >
              ${icon(X, 12)}
            </button>`
          : nothing
      }
    </div>
  `;
}

function renameRow(s: CoreSession): TemplateResult {
  return html`<div class="session-row renaming">
    ${renameInput(s.id, "Rename conversation", () => commitRename(s))}
  </div>`;
}

function renameInput(menuKey: string, ariaLabel: string, commit: () => Promise<void>): TemplateResult {
  return html`
    <input
      class="session-rename-input"
      aria-label=${ariaLabel}
      .value=${live(renameDraft)}
      @input=${(e: InputEvent) => {
        renameDraft = (e.currentTarget as HTMLInputElement).value;
      }}
      @keydown=${(e: KeyboardEvent) => {
        if (e.key === "Enter") {
          e.preventDefault();
          void commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancelRename(menuKey);
        }
      }}
      @blur=${() => void commit()}
      @click=${(e: Event) => e.stopPropagation()}
    />
  `;
}

function toggleShowArchived(): void {
  showArchived = !showArchived;
  renderList();
}

async function copySessionLink(s: CoreSession): Promise<void> {
  sessionsState.openMenuId = null;
  renderList();
  await copyText(sessionLink(location.origin, UI_BASE, s.id));
}

function toggleSessionMenu(e: Event, id: string): void {
  e.stopPropagation();
  sessionsState.openMenuId = sessionsState.openMenuId === id ? null : id;
  renderList();
}

function startRename(s: CoreSession): void {
  beginRename(s.id, sessionTitle(s));
}

function beginRename(key: string, draft: string): void {
  sessionsState.openMenuId = null;
  sessionsState.renamingId = key;
  renameDraft = draft;
  renderList();
  requestAnimationFrame(() => {
    const input = appState.listEl?.querySelector<HTMLInputElement>(".session-rename-input");
    if (!input) return;
    input.focus();
    input.select();
  });
}

function focusSessionMenuButton(menuKey: string): void {
  requestAnimationFrame(() => {
    const buttons = appState.listEl?.querySelectorAll<HTMLButtonElement>(".session-menu-btn") ?? [];
    [...buttons].find((button) => button.dataset.menuId === menuKey)?.focus();
  });
}

function cancelRename(menuKey: string): void {
  sessionsState.renamingId = null;
  renameDraft = "";
  renderList();
  focusSessionMenuButton(menuKey);
}

export function closeOpenSessionMenu(): boolean {
  const menuKey = sessionsState.openMenuId;
  if (!menuKey) return false;
  sessionsState.openMenuId = null;
  renderList();
  focusSessionMenuButton(menuKey);
  return true;
}

async function commitRename(s: CoreSession): Promise<void> {
  if (sessionsState.renamingId !== s.id) return;
  const next = renameDraft.trim();
  sessionsState.renamingId = null;
  renameDraft = "";
  renderList();
  const resolved = (s.title ?? "").trim();
  if (next === resolved) return;
  const desired = !next || next === defaultSessionTitle(s) ? null : next;
  if (desired === null && !resolved) return;
  await persistSessionPatch(s.id, { title: desired });
}

function setArchived(s: CoreSession, archived: boolean): void {
  sessionsState.openMenuId = null;
  void persistSessionPatch(s.id, { archived });
}

function setPinned(s: CoreSession, pinned: boolean): void {
  sessionsState.openMenuId = null;
  void persistSessionPatch(s.id, { pinned });
}

/**
 * Edits a room that already exists, from the very dialog that created it — pre-filled with
 * the room's own name, roster and round count.
 *
 * Persisting is the whole job: core re-reads the session's stored `room` on every dispatch
 * (see the panel branch in app-turn.ts), so a saved change simply takes effect on the next
 * message sent into the room. Nothing already said moves — an agent dropped from the roster
 * keeps every turn it took, it just stops being asked for new ones.
 */
export function startRoomEdit(s: CoreSession): void {
  sessionsState.openMenuId = null;
  renderList();
  const room = s.room;
  if (!room?.personaIds.length || !s.id) return;
  openEditRoomDialog({ name: (s.title ?? "").trim(), personaIds: room.personaIds, rounds: room.rounds }, (config, name) =>
    void saveRoomEdit(s, config, name),
  );
}

async function saveRoomEdit(s: CoreSession, config: RoomConfig, name: string): Promise<void> {
  try {
    const { session } = await updateSessionRoom(s.id, config);
    applyResolvedSession(session);
  } catch (e) {
    await refreshSessions({ silent: true });
    sessionsNotice = errMessage(e, "Failed to save the room.");
    renderList();
    return;
  }
  // The mounted thread reads its roster from here, not from the session list, so the header
  // and the composer would keep drawing the old one until a reload without this.
  noteRoom(s.threadRef ?? null, config);
  renderList();
  // Same rule rename commits under: a name matching what the roster derives is not a title
  // worth storing, so an unnamed room stays unnamed and keeps tracking its members.
  const desired = !name || name === defaultRoomNameFor(config) ? null : name;
  if (desired !== ((s.title ?? "").trim() || null)) await persistSessionPatch(s.id, { title: desired });
  for (const conv of allConversations()) if (conv.state.threadRef === s.threadRef) conv.redraw();
}

function previewColor(s: CoreSession, color: string): void {
  sessionsState.list = sessionsState.list.map((x) => (x.id === s.id ? { ...x, color } : x));
  renderList();
}

function setColor(s: CoreSession, color: string | null): void {
  void persistSessionPatch(s.id, { color });
}

function applyResolvedSession(updated: CoreSession): void {
  sessionsState.list = sessionsState.list.map((s) =>
    s.id === updated.id
      ? {
          ...s,
          ...updated,
          title: updated.title ?? null,
          archived: Boolean(updated.archived),
          pinned: Boolean(updated.pinned),
          color: updated.color ?? null,
        }
      : s,
  );
}

/**
 * A room is never retitled from what was said in it. The room *is* its name — the operator
 * picked it (or it derives from the roster), and a title generated off the transcript is how
 * a room ends up called "PASS". Rename stays available; only the derive-it-for-me path is
 * withheld, and the button that offers it is hidden for the same reason.
 */
function autoTitleable(s: CoreSession): boolean {
  return !s.room;
}

async function refreshSessionTitle(s: CoreSession): Promise<void> {
  sessionsState.openMenuId = null;
  if (!autoTitleable(s)) {
    renderList();
    return;
  }
  if (refreshingTitleIds.has(s.id)) {
    renderList();
    return;
  }
  refreshingTitleIds.add(s.id);
  renderList();
  try {
    const refreshed = await regenerateTitle(s.id);
    if (refreshed.title && !(s.title && s.title.trim())) {
      sessionsState.list = sessionsState.list.map((row) =>
        row.id === s.id ? { ...row, title: refreshed.title } : row,
      );
    }
    renderList();
  } catch {
    void 0;
  } finally {
    await refreshSessions({ silent: true });
    refreshingTitleIds.delete(s.id);
    renderList();
  }
}

async function persistSessionPatch(
  id: string,
  patch: { title?: string | null; archived?: boolean; pinned?: boolean; color?: string | null },
): Promise<void> {
  sessionsState.list = sessionsState.list.map((s) => (s.id === id ? { ...s, ...patch } : s));
  renderList();
  try {
    const { session } = await updateSession(id, patch);
    applyResolvedSession(session);
    renderList();
  } catch {
    await refreshSessions({ silent: true });
  }
}

let listSettled: (() => void) | null = null;
const listReady = new Promise<void>((resolve) => (listSettled = resolve));

export function sessionsReady(): Promise<void> {
  return sessionsState.loaded ? Promise.resolve() : listReady;
}

export async function refreshSessions(
  opts: { showLoading?: boolean; silent?: boolean; refreshContexts?: boolean } = {},
): Promise<boolean> {
  loadRecentContexts(opts.refreshContexts === true);
  const seq = ++sessionRefreshSeq;
  if (opts.showLoading) {
    sessionsLoading = true;
    sessionsNotice = "";
    renderList();
  }
  try {
    const r = await api<{ sessions: CoreSession[] }>("/api/sessions");
    if (seq !== sessionRefreshSeq) return false;
    let sawRoom = false;
    for (const session of r.sessions ?? []) {
      noteRoom(session.threadRef, session.room ?? null);
      if (session.room) sawRoom = true;
    }
    // Room rows are drawn from the persona cache, which is empty on the first paint after a
    // reload — so warm it and draw again, or the sidebar keeps the nameless, glyphless
    // version it rendered before /api/agents landed.
    if (sawRoom) void ensureRoomPersonas().then(() => renderList());
    sessionsState.list = reconcileSessions(r.sessions ?? [], sessionsState.list);
    sessionsState.loaded = true;
    sessionsNotice = "";
    return true;
  } catch (e) {
    if (seq !== sessionRefreshSeq) return false;
    if (!opts.silent) sessionsNotice = errMessage(e, "Failed to load conversations.");
    return false;
  } finally {
    listSettled?.();
    listSettled = null;
    if (seq === sessionRefreshSeq) {
      sessionsLoading = false;
      renderList();
    }
  }
}

export async function openSession(s: CoreSession, entriesPrefetch?: Promise<TranscriptPage | null>): Promise<void> {
  // The sidebar list is visible from any view now, so a row click may land while some other
  // view is showing — route back to Chats first (as addBlankPane already does for the "new
  // chat" split entry point) so there's somewhere for the transcript to mount.
  if (appState.currentView !== "chats") switchView("chats");
  if (splitInterceptsOpen(s)) return;
  closeSidebarOnNarrowView();
  if (projectName(s.scopeId) && sessionsState.collapsedProjectScopes.delete(s.scopeId)) renderList();
  // Same courtesy for a Slack channel: a thread opened from a deep link or the Chats page
  // should be visible in the sidebar it just became the active row of.
  const channelId = slackChannelIdOf(s.threadRef);
  if (channelId && sessionsState.collapsedSlackChannels.delete(channelId)) renderList();
  return openSessionInto(mainConversation(), s, entriesPrefetch);
}

export async function openSessionInto(
  conv: Conversation,
  s: CoreSession,
  entriesPrefetch?: Promise<TranscriptPage | null>,
): Promise<void> {
  const tracked = conv === mainConversation();
  if (!s.id) {
    if (conv.state.threadRef !== s.threadRef) {
      conv.mountContinuable(s.threadRef, null, s.scopeId || null, [], s.channelName ?? null);
      renderList();
    }
    return;
  }
  if (s.id === conv.state.sessionId) return;

  void refreshSessions({ silent: true });

  const opening = s.id;
  if (tracked) {
    sessionsState.openingKey = opening;
    renderList();
  }
  const skeletonTimer = window.setTimeout(() => {
    if (!tracked || sessionsState.openingKey === opening) conv.mountLoadingPane();
  }, 140);

  const fetchEntries = (): Promise<TranscriptPage | null> =>
    fetchTranscript(s.id, { tailTurns: TAIL_TURNS }).catch(() => null);
  const continuable = isContinuable(s, appState.me?.user ?? "");
  const [entriesRes, approvalsRes] = await Promise.all([
    entriesPrefetch ? entriesPrefetch.then((r) => r ?? fetchEntries()) : fetchEntries(),
    continuable
      ? api<{ approvals: PendingApproval[] }>(`/api/sessions/${encodeURIComponent(s.id)}/approvals`).catch(() => null)
      : Promise.resolve(null),
  ]);
  window.clearTimeout(skeletonTimer);

  if (tracked) {
    if (sessionsState.openingKey !== opening) return;
    sessionsState.openingKey = null;
  }

  if (!entriesRes) {
    if (tracked) showMainEmpty("Couldn't load this conversation. Check your connection and click it again.");
    renderList();
    return;
  }

  const messages = entriesToMessages(entriesRes.entries ?? [], transcriptModel());
  const earlier = entriesRes.earlierEntries ?? 0;
  const anchorSeq = entriesRes.entries?.[0]?.seq ?? null;
  if (continuable) {
    attachPendingApprovals(messages, approvalsRes?.approvals ?? [], transcriptModel());
    conv.mountContinuable(s.threadRef, s.id, s.scopeId, messages, s.channelName ?? null);
    conv.setTranscriptWindow(anchorSeq, earlier);
  } else {
    conv.mountReadOnly(s, messages, earlier, anchorSeq);
  }
  renderList();
}
