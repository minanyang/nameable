/**
 * App titles compared the way a person reads them: NFKC, ignoring case and anything but letters and
 * digits. A title also matches by its head, before a subtitle such as "Todoist: To Do List".
 */
const norm = (s: string) =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
const head = (title: string) => title.split(/:| [-–—|] /)[0]!;

export function sameAppName(title: string, name: string): boolean {
  const wanted = norm(name);
  return wanted !== "" && (norm(title) === wanted || norm(head(title)) === wanted);
}

/** A title's length as a person counts it: one per grapheme, so an emoji or accented letter is one. */
export const titleLength = (title: string): number =>
  [...new Intl.Segmenter().segment(title.trim())].length;
