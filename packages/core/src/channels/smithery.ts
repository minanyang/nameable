import { defineChannel, unexpected } from "../define.js";
import { get } from "../http.js";
import type { Channel } from "../types.js";

const API = "https://api.smithery.ai";

// "Namespace names must be lowercase alphanumeric with hyphens, and are globally unique across Smithery."
// (smithery.ai/docs/concepts/namespaces). A server is `namespace` or `namespace/slug`.
const VALID = /^[a-z0-9-]+$/;

type ServerList = {
  servers: { qualifiedName: string; displayName?: string }[];
  pagination: { totalCount: number };
};

const isServerList = (x: unknown): x is ServerList => {
  const list = x as ServerList | null;
  return (
    Array.isArray(list?.servers) &&
    list.servers.every((s) => typeof s?.qualifiedName === "string") &&
    typeof list.pagination?.totalCount === "number"
  );
};

export const smithery: Channel = defineChannel({
  id: "smithery",
  label: "Smithery",
  category: "agent",
  rules: (name) =>
    VALID.test(name) ? undefined : "Smithery namespaces are lowercase letters, digits and hyphens",
  async lookup(name, ctx) {
    // The documented `namespace` filter matches the whole namespace, ignoring case.
    const res = await get(ctx, `${API}/servers?namespace=${name}&pageSize=1`);
    if (res.status !== 200) return unexpected("Smithery", res);
    const list: unknown = await res.json();
    if (!isServerList(list))
      return { status: "unknown", note: "Smithery returned an unexpected list" };
    const [first] = list.servers;
    const total = list.pagination.totalCount;
    if (first) {
      return {
        status: "taken",
        url: `https://smithery.ai/servers/${first.qualifiedName}`,
        note: `${total} ${total === 1 ? "server" : "servers"} in this namespace, such as ${first.displayName ?? first.qualifiedName}`,
        meta: { servers: total },
      };
    }
    return {
      status: "available",
      certainty: "probable",
      note: "no public servers; a namespace with none, or with only unlisted ones, also looks free",
    };
  },
});
