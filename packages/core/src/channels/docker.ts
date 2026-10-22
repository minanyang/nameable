import { defineChannel } from "../define.js";
import { get } from "../http.js";
import type { Channel } from "../types.js";

const API = "https://hub.docker.com/v2";

// docs.docker.com/accounts/create-account: a Docker ID is 4 to 30 letters and numbers, stored in
// lowercase. Users and organizations share one namespace ("Docker IDs and organization namespaces must
// be unique").
const VALID = /^[a-z0-9]{4,30}$/i;

export const docker: Channel = defineChannel({
  id: "docker",
  label: "Docker Hub",
  category: "package",
  // Official images (hello-world, rocket.chat) and Docker's own namespaces (ai, mcp) break the Docker ID
  // rule, so it applies only once nobody holds the name.
  rules: (name) =>
    /^[a-z0-9][a-z0-9._-]{0,254}$/i.test(name)
      ? undefined
      : "Docker Hub names are letters, digits, . _ and -",
  refuses: (name) =>
    VALID.test(name) ? undefined : "new Docker IDs are 4 to 30 letters and digits",
  async lookup(raw, ctx) {
    const name = raw.toLowerCase();
    // Each endpoint answers for its own kind and redirects (308) to the other for the other kind, so
    // the redirect is itself proof the name is held. One held account answers 404 on /users but still
    // redirects from /orgs and owns repositories, so all three are asked.
    const [user, org, repos, official] = await Promise.all([
      get(ctx, `${API}/users/${name}/`, { redirect: "manual" }),
      get(ctx, `${API}/orgs/${name}/`, { redirect: "manual" }),
      get(ctx, `${API}/namespaces/${name}/repositories/?page_size=1`),
      get(ctx, `${API}/repositories/library/${name}/`),
    ]);
    // A 200 counts only with the account in it, so a captive portal's page proves nothing.
    const account = async (res: Response, key: string) =>
      res.status === 308 ||
      (res.status === 200 &&
        typeof ((await res.json()) as Record<string, unknown> | null)?.[key] === "string");
    const [isUser, isOrg] = await Promise.all([account(user, "username"), account(org, "orgname")]);
    const held = (res: Response) => (res === user ? isUser : isOrg);
    const count = repos.status === 200 ? await repoCount(repos) : undefined;

    // Any one signal of a holder is proof enough, even if another request failed.
    if (held(user) || held(org) || (count ?? 0) > 0) {
      const kind =
        isUser && user.status === 200
          ? "user"
          : isOrg && org.status === 200
            ? "organization"
            : "account";
      const page = kind !== "account";
      return {
        status: "taken",
        url: page ? `https://hub.docker.com/u/${name}` : `${API}/namespaces/${name}/repositories/`,
        // A hidden account has no page on the site; the API listing of its repositories is the evidence.
        note: `${count === undefined ? `Docker ${kind}` : `Docker ${kind}, ${plural(count)}`}${page ? "" : "; it has no profile page, the link lists its repositories"}`,
        meta: { kind, repositories: count },
      };
    }
    const image =
      official.status === 200 &&
      ((await official.json()) as { namespace?: unknown } | null)?.namespace === "library";
    if (image) {
      return {
        status: "taken",
        url: `https://hub.docker.com/_/${name}`,
        note: `an official image; \`docker pull ${name}\` already gets it`,
        meta: { kind: "official image" },
      };
    }
    // Anything else, including a 200 that did not hold an account or image, leaves it unknown.
    if (user.status !== 404 || org.status !== 404 || count !== 0 || official.status !== 404) {
      const statuses = [user, org, repos, official].map((r) => r.status).join("/");
      return { status: "unknown", note: `Docker Hub returned HTTP ${statuses}` };
    }
    return {
      status: "available",
      certainty: "probable",
      note: "no user or organization; deactivated or reserved Docker IDs also look free",
    };
  },
});

async function repoCount(res: Response): Promise<number | undefined> {
  const { count } = ((await res.json()) ?? {}) as { count?: unknown };
  return typeof count === "number" ? count : undefined;
}

const plural = (n: number) => `${n} public ${n === 1 ? "repository" : "repositories"}`;
