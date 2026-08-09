import { mentionPattern } from "../agents/panel-driver.ts";
import { SLACK_MENTION_RE, personaBotForUserId, type SlackBotIdentity } from "./message-gating.ts";

/**
 * Slack and the panel driver name agents differently: Slack writes `<@U07BOT>`, the driver
 * reads `@Scout`. Both translations live here so the two grammars only ever meet in one file.
 *
 * The `@Name` side is NOT re-implemented — it is `panelPattern`'s own regex re-flagged for a
 * global replace, so "@Scoutmaster does not summon Scout" holds identically on both sides.
 */

/**
 * INBOUND: `<@U07BOT>` → `@Scout` for every persona-bound sibling bot, so `panelAddressed` and
 * `tagJoiners` see the roster the human actually addressed and in the order they addressed it.
 * A mention of a human, of a third-party bot or of the persona-less default qm bot is left
 * exactly as it arrived.
 */
export function translateInboundMentions(
  text: string,
  lookup: (botUserId: string) => SlackBotIdentity | undefined = personaBotForUserId,
): string {
  if (!text.includes("<@")) return text;
  return text.replace(SLACK_MENTION_RE, (raw, id: string) => {
    const bot = lookup(id);
    return bot?.personaName ? `@${bot.personaName}` : raw;
  });
}

/**
 * OUTBOUND: `@Critic` → `<@U07CRITIC>` in a persona's reply, so Slack renders a real mention
 * pill and the thread reads as a conversation rather than a wall of plain text.
 *
 * Only names belonging to a persona bot RUNNING in this process are rewritten, and never the
 * speaker's own name — a persona that says "@Scout" about itself is talking about itself, and
 * `panelMentions` ignores self-mentions for the same reason.
 */
export function translateOutboundMentions(
  text: string,
  bots: readonly SlackBotIdentity[],
  selfPersonaName?: string,
): string {
  if (!text || !text.includes("@")) return text;
  const self = selfPersonaName?.toLowerCase();
  let out = text;
  for (const bot of bots) {
    if (!bot.personaName || !bot.botUserId) continue;
    if (self !== undefined && bot.personaName.toLowerCase() === self) continue;
    out = out.replace(new RegExp(mentionPattern(bot.personaName).source, "gi"), `<@${bot.botUserId}>`);
  }
  return out;
}
