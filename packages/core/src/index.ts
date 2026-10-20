export { check, checkMany, type CheckOptions } from "./check.js";
export { channelIds, DEFAULT_TLDS, selectChannels, type Selection } from "./channels/index.js";
export { normalizePypi } from "./channels/pypi.js";
export { readWhois, type WhoisAnswer } from "./whois.js";
export type {
  Category,
  Certainty,
  Channel,
  CheckResult,
  Context,
  Fetch,
  Report,
  Status,
  Whois,
} from "./types.js";
