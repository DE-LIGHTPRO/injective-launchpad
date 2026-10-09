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
  migrated = false,
  rules,
}: {
  graduated: boolean;
  migrated?: boolean;
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
  return <span className={`chip ${tone}`}>{text}</span>;
}
