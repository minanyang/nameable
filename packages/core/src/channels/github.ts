import { defineChannel, unexpected } from "../define.js";
import { get } from "../http.js";
import type { Channel } from "../types.js";

// GitHub's sign-up form: alphanumerics and single hyphens, not at either end, at most 39 characters.
const VALID = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/i;

export const github: Channel = defineChannel({
  id: "github",
  label: "GitHub user/org",
  category: "code",
  rules: (name) =>
    VALID.test(name)
      ? undefined
      : "GitHub names are letters, digits and single inner hyphens (max 39)",
  async lookup(name, ctx) {
    const headers: Record<string, string> = { accept: "application/vnd.github+json" };
    if (ctx.githubToken) headers.authorization = `Bearer ${ctx.githubToken}`;
    const res = await get(ctx, `https://api.github.com/users/${name}`, { headers });
    if (res.status === 200) {
      const user = (await res.json()) as {
        login: string;
        type: string;
        public_repos: number;
        updated_at: string;
      };
      return {
        status: "taken",
        url: `https://github.com/${user.login}`,
        note: `${user.type}, ${user.public_repos} public repos, updated ${user.updated_at.slice(0, 10)}`,
        meta: { type: user.type, publicRepos: user.public_repos, updated: user.updated_at },
      };
    }
    if (res.status === 404) {
      return {
        status: "available",
        certainty: "probable",
        note: "suspended, deleted or reserved accounts also look free; confirm on GitHub's sign-up page",
      };
    }
    if (res.status === 403 || res.status === 429) {
      return {
        status: "unknown",
        note: "rate limited; set GITHUB_TOKEN or log in with `gh auth login`",
      };
    }
    return unexpected("GitHub", res);
  },
});
