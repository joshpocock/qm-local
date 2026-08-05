import { agentRoomsEnabled } from "../../config.ts";
import { ROOM_MAX_ROUNDS, type RoomConfig } from "../../types.ts";
import { sendJson } from "../http.ts";
import { type ApiCtx, type Route } from "./route.ts";

interface RoomBody {
  principalId?: unknown;
  room?: unknown;
}

/**
 * Roster edits are a session mutation, so the principal handling is the one the
 * title/archived/pinned/color patch uses: a capability or portal identity wins, otherwise
 * the body's principalId, and the App refuses any session the viewer cannot already see.
 */
function principalFrom(ctx: ApiCtx): string | null {
  const fromBody = (ctx.body as RoomBody | null)?.principalId;
  const principalId = ctx.capability?.actorId ?? ctx.actor?.p ?? (typeof fromBody === "string" ? fromBody : "");
  return principalId || null;
}

async function putSessionRoom(ctx: ApiCtx): Promise<void> {
  const { res, app } = ctx;
  const b = (ctx.body ?? {}) as RoomBody;
  const principalId = principalFrom(ctx);
  if (!principalId) return sendJson(res, 400, { error: "bad_request", message: "principalId required" });
  if (!("room" in b)) {
    return sendJson(res, 400, { error: "bad_request", message: "room required (null clears the roster)" });
  }

  let room: RoomConfig | null = null;
  if (b.room !== null) {
    const raw = b.room as { personaIds?: unknown; rounds?: unknown } | null;
    if (typeof raw !== "object" || raw === null) {
      return sendJson(res, 400, { error: "bad_request", message: "room must be an object or null" });
    }
    const personaIds = raw.personaIds;
    if (!Array.isArray(personaIds) || personaIds.length < 1 || personaIds.some((id) => typeof id !== "string" || !id)) {
      return sendJson(res, 400, {
        error: "bad_request",
        message: "room.personaIds must be one or more agent ids",
      });
    }
    if (new Set(personaIds as string[]).size !== personaIds.length) {
      return sendJson(res, 400, { error: "bad_request", message: "room.personaIds must be unique" });
    }
    const rounds = raw.rounds;
    if (typeof rounds !== "number" || !Number.isInteger(rounds) || rounds < 1 || rounds > ROOM_MAX_ROUNDS) {
      return sendJson(res, 400, { error: "bad_request", message: `room.rounds must be 1-${ROOM_MAX_ROUNDS}` });
    }
    // Every agent in the roster must be one this principal can already see and use: an
    // archived, disabled, or foreign-scope persona never makes it into a room config.
    const visible = new Map((await app.listVisiblePersonas(principalId)).map((p) => [p.id, p]));
    for (const id of personaIds as string[]) {
      const persona = visible.get(id);
      if (!persona) return sendJson(res, 400, { error: "bad_request", message: `unknown agent: ${id}` });
      if (!persona.enabled)
        return sendJson(res, 400, { error: "bad_request", message: `agent ${persona.name} is disabled` });
    }
    room = { personaIds: personaIds as string[], rounds: rounds as RoomConfig["rounds"] };
  }

  const session = await app.updateSessionRoom(ctx.params.id!, principalId, room);
  if (!session) return sendJson(res, 404, { error: "not_found" });
  return sendJson(res, 200, { session });
}

const ROOM_ROUTES: ReadonlyArray<Route<ApiCtx>> = [
  { method: "PUT", path: "/v1/sessions/:id/room", auth: "source", handle: putSessionRoom },
];

/** Mounted only when QM_AGENT_ROOMS=1; with the flag off the path 404s like any unknown route. */
export function roomRoutes(env?: NodeJS.ProcessEnv): ReadonlyArray<Route<ApiCtx>> {
  return agentRoomsEnabled(env) ? ROOM_ROUTES : [];
}
