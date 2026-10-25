'use client';

import { useEffect, useState } from 'react';
import { launchStatus, statusLabel, type LaunchRules } from '@/lib/launchRules';

/**
 * What a launch is, in one component used everywhere it is shown.
 *
 * The list and the detail page each derived this from `graduated` alone, so both said
 * "live" on a launch whose start time had not arrived. Two call sites meant fixing one
 * would have left the other, which is how the same label ends up meaning two things on
 * two pages of one product.
 *
 * A client component because the answer depends on the clock: rendered on the server it
 * would be correct at build time and wrong a minute later, and "not open yet" is
 * specifically the state that stops being true while someone is looking at it. It ticks
 * only while pending, so a live or graduated launch costs no timer.
 */
export function StatusChip({
  graduated,
  migrated,
  rules,
}: {
  graduated: boolean;
  /**
   * REQUIRED, and it used to default to false.
   *
   * It is the one input that separates the two states this component exists to tell
   * apart, so defaulting it labels a launch trading against its locked pool
   * "graduated" - and on chain `graduated` without `migrated` cannot happen, since
   * `exec_buy` seeds the pool in the same transaction that fills the curve. A default
   * that is right for the state the chain never reaches is the trap, not the
   * convenience. The board omitted it and avoided the consequence only by rendering
   * its own hardcoded "Pool" tag instead, which is the two-call-sites defect this
   * component was written to remove, re-introduced for one of the four states.
   */
  migrated: boolean;
  rules: LaunchRules;
}) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const status = launchStatus({ graduated, migrated, rules, nowSeconds: now });

  useEffect(() => {
    if (status !== 'pending') return;
    const id = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1_000);
    return () => window.clearInterval(id);
  }, [status]);

  const { text, tone } = statusLabel(status);
  /*
   * `chip-status` adds the dot and the uppercase treatment, and the dot takes
   * `currentColor`, so each tone colours its own without a second mapping here. The
   * tones themselves are unchanged and still come from `statusLabel`: this is how a
   * launch LOOKS, not a second opinion about what it is.
   */
  return <span className={`chip chip-status ${tone}`}>{text}</span>;
}
