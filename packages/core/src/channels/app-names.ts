/**
 * App titles compared the way a person reads them: NFKC, ignoring case and anything but letters and
 * digits. A title also matches by its head, before a subtitle such as "Todoist: To Do List".
 */
const norm = (s: string) =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
// Store titles add a subtitle ("Todoist: To Do List").
const head = (title: string) => title.split(/:| [-–—|] /)[0]!;

/** Whether a name has letters or digits to compare at all ("🚀" and "!!" do not). */
export const comparable = (name: string): boolean => norm(name) !== "";

/**
 * How a store title relates to a name. "same": the title is the name, or the name followed by a subtitle
 * ("Todoist: To Do List"). "similar": the title only adds its maker, before the name ("Google Gemini" by
 * Google LLC) or after "by" ("Claude by Anthropic"); store names are unique by their exact title, so that
 * is a clash to weigh, not a holder of the name.
 */
export function appNameMatch(
  title: string,
  name: string,
  developer?: unknown,
): "same" | "similar" | undefined {
  const wanted = norm(name);
  if (wanted === "") return undefined;
  const same = (t: string) => norm(t) === wanted || norm(head(t)) === wanted;
  if (same(title)) return "same";
  const maker =
    typeof developer === "string" ? developer.split(/[^\p{L}\p{N}]+/u).find(Boolean) : "";
  if (!maker) return undefined;
  if (
    title.toLowerCase().startsWith(`${maker.toLowerCase()} `) &&
    same(title.slice(maker.length + 1))
  ) {
    return "similar";
  }
  const by = title.toLowerCase().lastIndexOf(" by ");
  if (by > 0 && norm(title.slice(by + 4)).startsWith(norm(maker)) && same(title.slice(0, by))) {
    return "similar";
  }
  return undefined;
}

export type Storefront = { country: string; language: string };

/**
 * The stores to search: the US one, plus those a name in Chinese, Japanese or Korean would be
 * released in, since titles differ by localization ("微信" in China is "WeChat" elsewhere).
 */
export function storefronts(name: string): Storefront[] {
  const found: Storefront[] = [{ country: "us", language: "en" }];
  if (/\p{Script=Han}/u.test(name)) {
    found.push({ country: "cn", language: "zh-CN" }, { country: "tw", language: "zh-TW" });
  }
  // Kanji alone (東京) is Japanese as often as Chinese.
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(name)) {
    found.push({ country: "jp", language: "ja" });
  }
  if (/\p{Script=Hangul}/u.test(name)) found.push({ country: "kr", language: "ko" });
  return found;
}

/** "the US store", "the US, CN and TW stores". */
export function storeNames(stores: Storefront[]): string {
  const codes = stores.map((s) => s.country.toUpperCase());
  const list = codes.length > 1 ? `${codes.slice(0, -1).join(", ")} and ${codes.at(-1)}` : codes[0];
  return `the ${list} ${codes.length > 1 ? "stores" : "store"}`;
}

/** A title's length as a person counts it: one per grapheme, so an emoji or accented letter is one. */
export const titleLength = (title: string): number =>
  [...new Intl.Segmenter().segment(title.trim())].length;
