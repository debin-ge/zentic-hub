// Mirrors MAX_EXPLICIT_AGENT_TITLE_CHARS in the Zentic daemon's protocol package
// (packages/protocol/src/agent-title-limits.ts). Hub needs only this one number, so it
// does not depend on that package; keep the two values equal.
export const MAX_EXPLICIT_AGENT_TITLE_CHARS = 200;
