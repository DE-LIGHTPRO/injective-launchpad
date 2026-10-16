/**
 * Find the environment variables a source file reads. Used by the guards that assert
 * `.env.example` and the mainnet runbook document the configuration surface.
 *
 * ONE IMPLEMENTATION, because two scanners disagreeing is how the thing they guard
 * goes unguarded. `env-surface.test.ts` and `runbook-surface.test.ts` both call this.
 *
 * IT MUST SEE COMPUTED ACCESS. A scanner matching only `process.env.NAME` is blind to
 * `process.env[`INJ_${label.toUpperCase()}_CODE_ID`]`, which is how `deploy.mjs` reads
 * INJ_CURVE_CODE_ID and INJ_FACTORY_CODE_ID. That blind spot let both variables stay
 * out of `scripts/.env.example` while the guard written to catch exactly that passed,
 * and it nearly made me report them as documented-but-dead when the runbook names
 * them. A guard's blind spot is indistinguishable from compliance.
 *
 * An interpolated name cannot be resolved statically, so it is returned as a PATTERN
 * and callers match candidate names against it rather than pretending to know them.
 */

export interface EnvReads {
  /** Names read literally: `process.env.FOO` or `process.env['FOO']`. */
  names: Set<string>;
  /**
   * Patterns for interpolated reads, e.g. `INJ_${x}_CODE_ID` becomes `^INJ_.+_CODE_ID$`.
   * A name matching one of these is read, even though which one cannot be known here.
   */
  patterns: RegExp[];
}

/** Set by the toolchain, not by an operator, so not part of the surface. */
const NOT_CONFIGURATION = new Set(['NODE_ENV']);

export function scanEnvReads(source: string): EnvReads {
  const names = new Set<string>();
  const patterns: RegExp[] = [];

  for (const m of source.matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
    if (!NOT_CONFIGURATION.has(m[1])) names.add(m[1]);
  }
  for (const m of source.matchAll(/process\.env\[\s*(['"])([A-Z0-9_]+)\1\s*\]/g)) {
    if (!NOT_CONFIGURATION.has(m[2])) names.add(m[2]);
  }
  for (const m of source.matchAll(/process\.env\[\s*`([^`]+)`\s*\]/g)) {
    const literal = m[1];
    if (!literal.includes('${')) {
      if (!NOT_CONFIGURATION.has(literal)) names.add(literal);
      continue;
    }
    // `INJ_${label.toUpperCase()}_CODE_ID` -> /^INJ_.+_CODE_ID$/
    const body = literal
      .split(/\$\{[^}]*\}/)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.+');
    patterns.push(new RegExp(`^${body}$`));
  }

  return { names, patterns };
}

/** Whether a variable name is read, by literal match or by an interpolated pattern. */
export function isRead(name: string, reads: EnvReads): boolean {
  return reads.names.has(name) || reads.patterns.some((p) => p.test(name));
}

export function mergeReads(all: EnvReads[]): EnvReads {
  return {
    names: new Set(all.flatMap((r) => [...r.names])),
    patterns: all.flatMap((r) => r.patterns),
  };
}
