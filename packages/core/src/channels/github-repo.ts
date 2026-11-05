import { defineChannel, unexpected } from "../define.js";
import { get } from "../http.js";
import type { Channel } from "../types.js";

// GitHub's new-repository form keeps letters, digits, `.`, `-` and `_`, turns anything else into a hyphen,
// and takes at most 100 characters; `.` and `..` are refused.
const VALID = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;

/** Search ranks a repository named exactly the query near the top, so its first page holds the clashes. */
const PER_PAGE = 100;
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

type Repo = {
  name: string;
  full_name: string;
  html_url: string;
  description: string | null;
  stargazers_count: number;
  pushed_at: string;
  archived: boolean;
};

export const githubRepo: Channel = defineChannel({
  id: "github-repo",
  label: "GitHub repository",
  category: "code",
  rules: (name) =>
    VALID.test(name)
      ? undefined
      : "GitHub repository names are letters, digits, '.', '-' and '_' (max 100)",
  async lookup(name, ctx) {
    const headers: Record<string, string> = { accept: "application/vnd.github+json" };
    if (ctx.githubToken) headers.authorization = `Bearer ${ctx.githubToken}`;
    // Quoted, so that a name such as `NOT` or `OR` is a search term, not an operator.
    const q = encodeURIComponent(`"${name}" in:name`);
    const res = await get(
      ctx,
      `https://api.github.com/search/repositories?q=${q}&per_page=${PER_PAGE}`,
      { headers },
    );
    if (res.status === 401) {
      return {
        status: "unknown",
        note: "GitHub rejected the token (HTTP 401); check GITHUB_TOKEN",
      };
    }
    if (res.status === 403 || res.status === 429) {
      return {
        status: "unknown",
        note: "rate limited; set GITHUB_TOKEN or log in with `gh auth login`",
      };
    }
    if (res.status !== 200) return unexpected("GitHub", res);
    const body = (await res.json()) as {
      incomplete_results?: boolean;
      items?: Repo[];
    } | null;
    if (!Array.isArray(body?.items)) {
      return { status: "unknown", note: "GitHub returned something other than search results" };
    }
    const wanted = name.toLowerCase();
    const now = ctx.now?.() ?? Date.now();
    const active = (r: Repo) => !r.archived && now - Date.parse(r.pushed_at) < YEAR_MS;
    // Repositories pushed to in the last year first, then the most starred.
    const same = body.items
      .filter((r) => r.name.toLowerCase() === wanted)
      .sort(
        (a, b) => Number(active(b)) - Number(active(a)) || b.stargazers_count - a.stargazers_count,
      );
    if (!same.length) {
      if (body.incomplete_results) {
        return { status: "unknown", note: "GitHub's search timed out before it finished" };
      }
      return {
        status: "available",
        certainty: "probable",
        note: "no repository is named exactly this among GitHub's first 100 matches; forks are not searched",
      };
    }
    const [lead] = same as [Repo];
    const describe = (r: Repo) =>
      `${r.full_name} (★${r.stargazers_count}, ${r.archived ? "archived" : `pushed ${r.pushed_at.slice(0, 10)}`})`;
    const more = same.length > 1 ? ` and ${same.length - 1} more` : "";
    return {
      status: "taken",
      url: lead.html_url,
      note: `clash, not a block: ${describe(lead)}${more}; repository names are unique only within an account`,
      meta: {
        repositories: same.slice(0, 10).map((r) => ({
          name: r.full_name,
          description: r.description,
          stars: r.stargazers_count,
          pushed: r.pushed_at,
          archived: r.archived,
        })),
        count: same.length,
      },
    };
  },
});
