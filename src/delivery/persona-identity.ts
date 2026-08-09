/**
 * `Destination.identity` names WHICH bot posts a delivery. It already carried hardcoded surface
 * identities (Slack's "copilot"); a panel reply names the agent persona that authored it, so the
 * surface can post it under that persona's own bot instead of the default one.
 *
 * The prefix keeps the two namespaces from ever colliding: no surface identity may be called
 * `persona:…`.
 */
const PERSONA_IDENTITY_PREFIX = "persona:";

export function personaPostIdentity(personaId: string): string {
  return `${PERSONA_IDENTITY_PREFIX}${personaId}`;
}

export function personaIdFromIdentity(identity: string | undefined): string | undefined {
  if (!identity?.startsWith(PERSONA_IDENTITY_PREFIX)) return undefined;
  return identity.slice(PERSONA_IDENTITY_PREFIX.length) || undefined;
}
