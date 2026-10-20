import { get } from "../http.js";
import type { Channel, CheckResult } from "../types.js";

const VALID = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/i;

export const github: Channel = {
  id: "github",
  label: "GitHub user/org",
  category: "code",
  async check(name, ctx): Promise<CheckResult> {
    const base = { channel: this.id, label: this.label, url: `https://github.com/${name}` };
    if (!VALID.test(name)) {
      return {
        ...base,
        status: "unavailable",
        note: "GitHub names are letters, digits and single inner hyphens (max 39)",
        url: undefined,
      };
    }
    const headers: Record<string, string> = { accept: "application/vnd.github+json" };
    if (ctx.githubToken) headers.authorization = `Bearer ${ctx.githubToken}`;
    const res = await get(ctx, `https://api.github.com/users/${name}`, { headers });
    if (res.status === 200) {
      const user = (await res.json()) as { login: string; type: string; public_repos: number; updated_at: string };
      return {
        ...base,
        url: `https://github.com/${user.login}`,
        status: "taken",
        note: `${user.type}, ${user.public_repos} public repos, updated ${user.updated_at.slice(0, 10)}`,
        meta: { type: user.type, publicRepos: user.public_repos, updated: user.updated_at },
      };
    }
    if (res.status === 404) {
      return {
        ...base,
        status: "available",
        certainty: "probable",
        note: "suspended, deleted or reserved accounts also look free; confirm on GitHub's sign-up page",
        url: undefined,
      };
    }
    if (res.status === 403 || res.status === 429) {
      return { ...base, status: "unknown", note: "rate limited; set GITHUB_TOKEN or log in with `gh auth login`" };
    }
    return { ...base, status: "unknown", note: `GitHub returned HTTP ${res.status}` };
  },
};
