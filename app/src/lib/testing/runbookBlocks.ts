/**
 * Locate the mainnet runbook's deploy command, for the guards that measure it.
 *
 * WHY THIS IS ONE FUNCTION AND NOT TWO COPIES. `runbook-surface.test.ts` and
 * `derived-constant-wiring.test.ts` both sliced the command out with
 *
 *   RUNBOOK.slice(RUNBOOK.indexOf('### 7. Deploy'))
 *
 * and both broke the moment step 7 was split into a governance upload and an
 * instantiate, because the anchor was the heading's wording rather than the thing
 * being measured. Two copies meant fixing it twice and a third guard inheriting the
 * same brittleness by copying whichever it found first.
 *
 * The worse half is how that anchor fails. `indexOf` returns -1 for a missing
 * needle, so `slice(0, -1)` yields the whole document, and a guard asking "does the
 * command name INJ_FACTORY_WASM_ADMIN" would then be asking it of a file that
 * discusses every variable at length. One of the two callers happened to assert a
 * minimum length and failed loudly; the other would have passed while measuring
 * nothing. A guard that cannot tell "the step was renamed" from "everything is
 * documented" is the fixture, not the code it guards.
 */
const BASH_FENCE = /```bash\n([\s\S]*?)```/g;

/** Every fenced bash block in the document, in order. */
export function bashBlocks(runbook: string): string[] {
  return [...runbook.matchAll(BASH_FENCE)].map((m) => m[1]);
}

/**
 * The one command block that runs `deploy.mjs`.
 *
 * Throws rather than returning null or an empty string. A caller that gets "" back
 * asks its questions of nothing and passes, which is the failure this exists to
 * remove; and exactly one block may run the script, because two give an operator a
 * choice between them with no way to tell which is current.
 */
export function deployCommand(runbook: string): string {
  const running = bashBlocks(runbook).filter((b) => b.includes('node scripts/deploy.mjs'));
  if (running.length !== 1) {
    throw new Error(
      `${running.length} command blocks in docs/MAINNET-RUNBOOK.md run deploy.mjs; exactly one must. ` +
        'If the deploy step was renamed or split, this function is what finds it, not the heading.',
    );
  }
  return running[0];
}
