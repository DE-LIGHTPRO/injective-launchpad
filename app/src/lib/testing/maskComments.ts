/**
 * Blank the comments in a source file so a guard that reads text cannot be satisfied,
 * or broken, by the prose explaining the rule.
 *
 * Both halves of this were learned by getting them wrong on the same day.
 *
 *  - WITHOUT MASKING, a guard fails on a correct file. `key-separation-check` asserted
 *    `NEXT_PUBLIC_NETWORK` was absent from a script and failed on the comment saying
 *    severity must not be read from it.
 *  - MASKING `//` NAIVELY makes a guard vacuous, which is worse. `https://` contains
 *    `//`, so the mask blanks the rest of any line holding a URL - `explorer-host`
 *    passed while two files were mutated back to the broken host, because it had erased
 *    the only lines it was looking at. `(?<!:)` is what prevents that.
 *
 * Newlines survive, so a reported line number still points somewhere.
 *
 * Imperfect by design: a `//` inside a string literal that is not part of a URL still
 * masks its line, which can only ever make this skip a line it should have read. That
 * direction is a missed finding; the other direction is a false one.
 */
export function maskComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(?<!:)\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}
