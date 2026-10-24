'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { NETWORK } from '@/lib/config';
import { pollTxOutcome } from '@/lib/txStatus';
import type { TxStage, BroadcastOutcome } from '@/lib/broadcast';

/**
 * One dialog for every transaction this app sends.
 *
 * WHAT IT REPLACES. Each of the four signing surfaces grew its own aftermath: a
 * sentence under the button, in its own words, with its own explorer link, saying
 * some version of "sent. Balances update when the page next reads the chain." That
 * sentence was the most honest thing the old code could say, because the old code
 * genuinely did not know any more than that - it had a hash from a node that had
 * accepted the bytes and it never asked again. The dialog is not a nicer wrapper
 * around that sentence; it exists because the app now follows the transaction to a
 * block and has something further to report.
 *
 * WHAT MAKES THE PROGRESS REAL. Every step below is entered when the corresponding
 * work starts and left when it finishes. The bar fills by STEPS REACHED, never by a
 * timer, and `settling` additionally shows seconds counted from the clock rather than
 * an estimate of how much longer it will be - because nothing here knows that. An
 * animated bar that creeps toward full while the chain has said nothing is a
 * reassurance dressed as a measurement, and it is the exact shape of defect this
 * codebase keeps finding in its own money figures.
 *
 * THE LAST STEP CAN END IN THREE WAYS, not two. Confirmed, refused, or still not
 * visible - and the third is reported as itself, with the hash and an explorer link,
 * never as a failure. A transaction the node accepted and we lost sight of has very
 * probably landed; saying "failed" over one would send a user to re-sign a trade they
 * have already made.
 */

/** The ordered rail. Index in this array IS the progress. */
const STEPS: Array<{ stage: TxStage; title: string; while: string }> = [
  { stage: 'preparing', title: 'Preparing', while: 'Reading your account number and sequence from the chain.' },
  /*
   * A real step with a real line of code behind it, which is the rule this list is
   * written to. Audit F-09: the node runs the transaction here and nothing has been
   * signed yet, so a refusal at this step costs the user nothing, and saying so is the
   * point of showing it rather than folding it into "Preparing".
   */
  { stage: 'simulating', title: 'Checking', while: 'Running it against the chain first, so a failure costs you nothing.' },
  { stage: 'signing', title: 'Your wallet', while: 'Approve the transaction in your wallet to continue.' },
  { stage: 'broadcasting', title: 'Broadcasting', while: 'Sending the signed transaction to Injective.' },
  { stage: 'settling', title: 'Settling', while: 'Waiting for a validator to put it in a block.' },
];

export type TxPhase = TxStage | 'confirmed' | 'failed' | 'unseen';

export interface TxFlowState {
  open: boolean;
  /** What the user asked for, in their words: "Buy PEPE", "Pay out fees". */
  title: string;
  phase: TxPhase;
  txHash: string | null;
  height: number | null;
  /** Set on `failed` only. Already translated; never a raw node string. */
  error: string | null;
  /** The node's own words, shown in a dev build only. */
  detail: string | null;
  /** Seconds counted while settling. Measured, not estimated. */
  waitedSeconds: number;
}

const IDLE: TxFlowState = {
  open: false,
  title: '',
  phase: 'preparing',
  txHash: null,
  height: null,
  error: null,
  detail: null,
  waitedSeconds: 0,
};

export interface TxFlow {
  state: TxFlowState;
  close: () => void;
  /**
   * Runs one transaction start to finish and drives the dialog from it.
   *
   * `send` is handed the stage reporter and must pass it to whichever `broadcast*`
   * it calls. Resolves to whether the transaction CONFIRMED, so a caller can refresh
   * the page on a confirmation and leave it alone otherwise - refreshing after a
   * refusal would repaint the same figures and read as the refusal having been
   * absorbed.
   */
  run: (opts: {
    title: string;
    send: (onStage: (s: TxStage) => void) => Promise<BroadcastOutcome>;
  }) => Promise<boolean>;
}

export function useTxFlow(): TxFlow {
  const [state, setState] = useState<TxFlowState>(IDLE);
  /*
   * Aborts the poll when the dialog closes. Without it a user who dismisses the
   * dialog leaves a loop reading the chain every second for up to forty, and a second
   * trade starts a second loop that can land on the first one's state.
   */
  const abort = useRef<AbortController | null>(null);

  useEffect(() => () => abort.current?.abort(), []);

  const close = useCallback(() => {
    abort.current?.abort();
    setState((s) => ({ ...s, open: false }));
  }, []);

  const run = useCallback<TxFlow['run']>(async ({ title, send }) => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setState({ ...IDLE, open: true, title });

    let outcome: BroadcastOutcome;
    try {
      outcome = await send((stage) => setState((s) => (s.open ? { ...s, phase: stage } : s)));
    } catch (e) {
      /*
       * Every refusal before a block reaches here: the wallet prompt closed, the
       * account not funded, the node refusing the bytes. `broadcast.ts` has already
       * translated it, and `detail` keeps the node's own words for a dev build.
       */
      const err = e as { message?: string; detail?: string };
      setState((s) => ({
        ...s,
        phase: 'failed',
        error: err?.message ?? 'The transaction did not go through.',
        detail: err?.detail ?? null,
      }));
      return false;
    }

    if (outcome.settled) {
      setState((s) => ({ ...s, phase: 'confirmed', txHash: outcome.txHash, height: outcome.height }));
      return true;
    }

    /*
     * THE HAND-OFF. The server stopped waiting; the browser carries on, where waiting
     * is free. The hash is shown from this moment, before the verdict, because it is
     * the one thing already established and it is what a user needs if they want to
     * go and look for themselves.
     */
    setState((s) => ({ ...s, phase: 'settling', txHash: outcome.txHash }));
    const result = await pollTxOutcome(outcome.txHash, {
      signal: controller.signal,
      onTick: (secs) => setState((s) => (s.open ? { ...s, waitedSeconds: secs } : s)),
    });
    if (controller.signal.aborted) return false;

    if (result.kind === 'confirmed') {
      setState((s) => ({ ...s, phase: 'confirmed', height: result.height }));
      return true;
    }
    if (result.kind === 'failed') {
      setState((s) => ({ ...s, phase: 'failed', error: result.message, detail: result.detail }));
      return false;
    }
    /*
     * Ran out of patience. NOT a failure, and the phase is named for what is true:
     * we have not seen it. Returning false keeps the page from refreshing on an
     * unknown, which would be the page asserting the opposite.
     */
    setState((s) => ({ ...s, phase: 'unseen' }));
    return false;
  }, []);

  return { state, close, run };
}

/** The step the rail is lit up to, and whether the run is over. */
function railPosition(phase: TxPhase): { reached: number; done: boolean } {
  if (phase === 'confirmed') return { reached: STEPS.length, done: true };
  // A refusal or a lost sight of stops the rail where it stood: the steps before it
  // genuinely happened, and dimming them would unsay four true things.
  if (phase === 'failed' || phase === 'unseen') return { reached: STEPS.length - 1, done: true };
  return { reached: STEPS.findIndex((s) => s.stage === phase), done: false };
}

export function TxDialog({ flow }: { flow: TxFlow }) {
  const { state, close } = flow;
  const panel = useRef<HTMLDivElement | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const settled = state.phase === 'confirmed' || state.phase === 'failed' || state.phase === 'unseen';

  /*
   * Escape closes, and ONLY once the transaction is out of our hands. Closing mid
   * flight would not cancel anything - the wallet prompt and the chain do not care
   * about this dialog - so it would hide a transaction in progress and leave the user
   * with no way back to its hash.
   */
  useEffect(() => {
    if (!state.open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && settled) close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state.open, settled, close]);

  // Body scroll lock: a dialog over a page that still scrolls behind it reads as an
  // overlay rather than a modal, and on a phone the page moves under the thumb.
  useEffect(() => {
    if (!state.open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [state.open]);

  useEffect(() => {
    if (state.open) panel.current?.focus();
  }, [state.open]);

  if (!mounted || !state.open) return null;

  const { reached, done } = railPosition(state.phase);
  const active = STEPS[Math.min(reached, STEPS.length - 1)];
  const explorer = state.txHash ? `${NETWORK.explorer}/transaction/${state.txHash}` : null;

  /*
   * PORTALLED, because `.card` sets `backdrop-filter` and that makes it a containing
   * block for fixed descendants: a dialog rendered inside the trade panel would have
   * its full-screen backdrop clipped to the panel. The rule is written out at the
   * `.card` declaration in globals.css.
   */
  return createPortal(
    <div className="tx-scrim" onMouseDown={(e) => e.target === e.currentTarget && settled && close()}>
      <div
        className="tx-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tx-dialog-title"
        aria-busy={!done}
        tabIndex={-1}
        ref={panel}
      >
        <div className="tx-head">
          <h2 id="tx-dialog-title">{state.title}</h2>
          <button
            type="button"
            className="tx-close"
            onClick={close}
            disabled={!settled}
            aria-label="Close"
            title={settled ? 'Close' : 'This closes once the transaction is settled'}
          >
            &times;
          </button>
        </div>

        {/*
          The bar's width is `reached / STEPS.length`: a count of work finished. It
          does not move between steps, because nothing measurable happens between
          them, and it never creeps toward full on a timer.
        */}
        <div
          className="tx-bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={STEPS.length}
          aria-valuenow={Math.max(0, reached)}
          data-state={state.phase}
        >
          <i style={{ width: `${(Math.max(0, reached) / STEPS.length) * 100}%` }} />
        </div>

        <ol className="tx-steps">
          {STEPS.map((step, i) => {
            const status = i < reached ? 'done' : i === reached && !done ? 'active' : done && i >= reached ? 'stopped' : 'waiting';
            return (
              <li key={step.stage} data-status={status}>
                <span className="tx-dot" aria-hidden="true" />
                <span className="tx-step-title">{step.title}</span>
              </li>
            );
          })}
        </ol>

        <div className="tx-say">
          {state.phase === 'confirmed' ? (
            <p className="tx-good">
              Confirmed{state.height !== null ? ` in block ${state.height.toLocaleString()}` : ''}.
            </p>
          ) : state.phase === 'failed' ? (
            <p className="tx-bad">{state.error}</p>
          ) : state.phase === 'unseen' ? (
            <p className="tx-wait">
              The network accepted this transaction and it has not appeared in a block
              yet. That is not a refusal: open it on the explorer to see where it got
              to. Do not sign it again.
            </p>
          ) : (
            <p>
              {active.while}
              {state.phase === 'settling' && state.waitedSeconds > 0 ? ` Waited ${state.waitedSeconds}s.` : ''}
            </p>
          )}
        </div>

        {explorer && (
          <div className="tx-hash">
            <code title={state.txHash ?? undefined}>
              {state.txHash!.slice(0, 10)}&hellip;{state.txHash!.slice(-8)}
            </code>
            <a href={explorer} target="_blank" rel="noreferrer">
              View on the explorer
            </a>
          </div>
        )}

        {/* Developer-facing detail is a dev build only: a node's own words read as a
            crash to anyone who did not write the node. */}
        {state.detail && process.env.NODE_ENV !== 'production' && (
          <pre className="tx-detail" tabIndex={0}>
            {state.detail}
          </pre>
        )}

        <div className="tx-foot">
          <button type="button" className="go" onClick={close} disabled={!settled}>
            {settled ? 'Done' : 'Working\u2026'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
