import { writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  AgentSideConnection,
  PROTOCOL_VERSION,
  RequestError,
  ndJsonStream,
} from "@zed-industries/agent-client-protocol";

const scenario = process.argv[2] ?? "happy";
const resultFile = process.argv[3];
const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
let connection;
let promptCancelled;
let sessionCwd = "";

const save = (value) => {
  if (resultFile) writeFileSync(resultFile, JSON.stringify({ pid: process.pid, ...value }));
};

connection = new AgentSideConnection(
  () => ({
    async initialize(params) {
      if (
        params.protocolVersion !== PROTOCOL_VERSION ||
        params.clientCapabilities?.fs?.readTextFile !== false ||
        params.clientCapabilities?.fs?.writeTextFile !== false ||
        params.clientCapabilities?.terminal !== false
      ) {
        throw RequestError.invalidParams({ reason: "unsafe client capabilities" });
      }
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: { promptCapabilities: { image: true } },
      };
    },
    async authenticate() {},
    async newSession(params) {
      sessionCwd = params.cwd;
      if (
        !isAbsolute(params.cwd) ||
        params.mcpServers.length !== 0 ||
        process.env.HOME !== params.cwd ||
        process.env.CORE_SIGNING_SECRET ||
        process.env.DATABASE_URL
      ) {
        throw RequestError.invalidParams({ reason: "unsafe session or child environment" });
      }
      save({ stage: "session" });
      if (scenario === "auth") throw RequestError.authRequired({ reason: "token missing" });
      return { sessionId: `fake-${process.pid}` };
    },
    async prompt(params) {
      if (scenario === "exit") {
        process.stderr.write("fake ACP process failure\n");
        process.exit(17);
      }
      if (scenario === "hang") {
        return await new Promise((resolve) => {
          promptCancelled = () => resolve({ stopReason: "cancelled" });
        });
      }
      await connection.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello " } },
      });
      let readError;
      let terminalError;
      try {
        await connection.readTextFile({ sessionId: params.sessionId, path: `${sessionCwd}/blocked.txt` });
      } catch (error) {
        readError = error;
      }
      try {
        await connection.createTerminal({ sessionId: params.sessionId, command: "blocked" });
      } catch (error) {
        terminalError = error;
      }
      const permission = await connection.requestPermission({
        sessionId: params.sessionId,
        toolCall: { toolCallId: "tool-1", title: "Run native tool", status: "pending" },
        options: [
          { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      });
      await connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tool-1",
          title: "Run native tool",
          kind: "execute",
          status: "in_progress",
        },
      });
      await connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-1",
          status: "completed",
        },
      });
      await connection.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "brief thought" } },
      });
      await connection.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ACP" } },
      });
      save({
        stage: "prompt",
        permission,
        prompt: params.prompt,
        readError,
        terminalError,
      });
      return { stopReason: "end_turn" };
    },
    async cancel() {
      promptCancelled?.();
    },
  }),
  stream,
);
