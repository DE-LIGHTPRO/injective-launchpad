import {
  MsgCreateDenom,
  MsgMint,
  MsgSetDenomMetadata,
  MsgChangeAdmin,
  MsgExecuteContract,
  createTransaction,
  ChainRestAuthApi,
} from '@injectivelabs/sdk-ts';
import { NETWORK, getLcdUrl, GAS_PRICE_INJ } from './config.ts';
import {
  MSG_CREATE_DENOM,
  MSG_MINT,
  MSG_SET_METADATA,
  MSG_CHANGE_ADMIN,
  MSG_EXECUTE,
  TOKEN_DECIMALS,
  type LaunchPlan,
} from './createLaunch.ts';

/**
 * Signing and broadcasting a launch.
 *
 * WHY A DEPENDENCY. Injective is not a stock Cosmos chain for this purpose: accounts
 * are `/injective.types.v1beta1.EthAccount` rather than `BaseAccount`, and the public
 * key in `AuthInfo` must be `/injective.crypto.v1beta1.ethsecp256k1.PubKey`. Stock
 * CosmJS parses neither. The alternative was hand-encoding three tokenfactory messages
 * and a custom pubkey into protobuf, which is exactly the kind of code that is subtly
 * wrong in a way no test I can run would catch. `@injectivelabs/sdk-ts` is the path
 * Injective documents and the one with the least surface for me to get wrong unseen.
 *
 * WHY THIS IS SAFE TO SHIP UNEXERCISED, which is a claim this codebase does not make
 * lightly, having recorded twice what an unverified transaction builder costs.
 *
 *   - ALL FOUR MESSAGES ARE ONE TRANSACTION. They land together or not at all, so a
 *     mis-built launch is a failed transaction rather than a created denom with no
 *     curve behind it, or a supply sent somewhere with nothing to show for it.
 *   - THE FACTORY VALIDATES EVERYTHING AGAIN. It refuses any attached amount but the
 *     exact `curve_supply + lp_reserve`, re-checks the curve, the fee share, the token
 *     profile and the launch rules. A wrong number is refused on chain, not absorbed.
 *   - THE MESSAGES COME FROM `planLaunch`, which has its own tests, and are the same
 *     objects the confirmation panel renders. What is displayed and what is signed are
 *     one value, so they cannot drift.
 *
 * What remains unverified is the ENCODING: whether this composes those messages into
 * bytes a node accepts. That fails loudly at simulate or broadcast, costs nothing but
 * gas on a rejected transaction, and the one thing it cannot do is half-create a
 * launch. `simulateLaunch` exists so that failure happens before a wallet prompt.
 */

export class BroadcastError extends Error {
  readonly kind:
    | 'no-signer'
    | 'rejected'
    | 'account'
    | 'wrong-account'
    | 'simulate'
    | 'broadcast';
  /** The node's own words, kept for a developer and never shown raw to a user. */
  readonly detail?: string;
  constructor(kind: BroadcastError['kind'], message: string, detail?: string) {
    super(message);
    this.name = 'BroadcastError';
    this.kind = kind;
    this.detail = detail;
  }
}

/**
 * 18-decimal base units as a readable amount, trimmed.
 *
 * Named for the scale rather than for INJ, because the launched token is 18 decimals
 * too and the curve's refusals quote token quantities. The QUOTE asset is the one that
 * may be something else, so anything read out of a quote-denominated figure has to
 * carry its own decimals and must not come through here.
 */
function format18(raw: string): string {
  try {
    const v = BigInt(raw);
    const whole = v / 10n ** 18n;
    const frac = (v % 10n ** 18n).toString().padStart(18, '0').slice(0, 4).replace(/0+$/, '');
    return `${whole}${frac ? `.${frac}` : ''}`;
  } catch {
    return raw;
  }
}

/** A denom as a reader knows it. Anything unfamiliar keeps its own name. */
function denomLabelFor(denom: string): string {
  return denom === 'inj' ? 'INJ' : denom;
}

/** Translates a node error into something a person can act on. */
export function describeBroadcastFailure(raw: string): string {
  const s = raw.toLowerCase();
  if (s.includes('insufficient funds') || s.includes('insufficient fee')) {
    /*
     * NAME THE TWO NUMBERS when the chain gives them. Injective's refusal reads
     *
     *   spendable balance 403213882356322213inj is smaller than 1000000000000000000inj
     *
     * and "Not enough INJ to cover the transaction fee" is wrong twice over: the
     * shortfall was the one-off 1 INJ denom-creation charge, not a gas fee, and a
     * creator told it is "the fee" goes looking at gas settings. Reported from
     * production, twice in one evening.
     */
    const pair = /spendable balance (\d+)([a-z0-9/._-]+) is smaller than (\d+)/i.exec(raw);
    if (pair) {
      const held = format18(pair[1]);
      const need = format18(pair[3]);
      return `This needs ${need} ${denomLabelFor(pair[2])} and the wallet holds ${held}. Creating a token costs a one-off 1 INJ to Injective itself, on top of gas.`;
    }
    return 'Not enough INJ to cover the transaction fee.';
  }
  /*
   * NOT A FAILURE, and the generic ending made it read as one. A creator clicked
   * "Pay out fees", the claim landed, the page kept showing the figures it was
   * server-rendered with, so they clicked again and got "The chain refused the
   * transaction" over an unchanged balance. The honest reading is that the money has
   * already moved; the stale panel is fixed separately, and this sentence is what
   * somebody sees when two tabs or two clicks race.
   */
  if (s.includes('nothing to claim')) {
    return 'There is nothing left to claim: these fees have already been paid out.';
  }
  /*
   * THE CURVE REFUSING A TRADE ON ITS OWN TERMS, rather than the chain refusing the
   * transaction. "Refused" over a correct, deliberate contract rule reads as a bug, and
   * every one of these was falling through to that sentence.
   *
   * Matched on the contract's own wording, which
   * `app/src/lib/wallet-cap-before-signing.test.ts` reads out of
   * `contracts/curve/src/error.rs` so a reworded error fails there instead of silently
   * going generic here.
   *
   * THE SLIPPAGE BRANCH WAS DEAD and had been since it was written. It looked for the
   * word "slippage"; `ContractError::Slippage` renders as
   *
   *     would receive 123 but asked for at least 456
   *
   * which never contains it. The contracts' own integration test records making exactly
   * this mistake and was fixed to assert "asked for at least" instead - the lesson
   * stayed in the Rust and never crossed over, so the one refusal a trader is most
   * likely to hit read as the chain rejecting their transaction. The word is still
   * accepted below in case a node or a wrapper adds it, but it is no longer the test.
   */
  if (s.includes('asked for at least') || s.includes('slippage')) {
    return 'The price moved past your slippage tolerance before this landed. Try again.';
  }
  /*
   * The wallet cap, named with its three numbers. The contract gives all of them and
   * they are what makes the refusal actionable: "over the cap" without saying how much
   * is left leaves a buyer guessing at amounts until one is accepted. Formatted at 18
   * decimals, which is the launched token's scale on every launch.
   */
  const cap = /caps a wallet at (\d+) tokens.*you hold (\d+) and this buy would add (\d+)/i.exec(
    raw,
  );
  if (cap) {
    const left = (() => {
      try {
        const remaining = BigInt(cap[1]) - BigInt(cap[2]);
        return remaining > 0n ? format18(remaining.toString()) : '0';
      } catch {
        return null;
      }
    })();
    return `This launch caps one address at ${format18(cap[1])} tokens bought from the curve and this wallet holds ${format18(cap[2])}, so a buy of ${format18(cap[3])} is over it${
      left === null ? '' : `. You can buy at most ${left} more`
    }. Selling frees the allowance again.`;
  }
  if (s.includes('trading opens at')) {
    return 'Buying is not open on this launch yet. The curve gates on block time, so try again once the start time has passed.';
  }
  if (s.includes('already in the locked pool')) {
    return 'This launch graduated while the trade was in flight. Reload the page to trade against the locked pool instead.';
  }
  if (s.includes('denom') && s.includes('exists')) {
    return 'That ticker is already taken on this chain. Choose another.';
  }
  if (s.includes('out of gas')) {
    return 'The transaction ran out of gas. Try again; the estimate is raised automatically.';
  }
  if (s.includes('unauthorized') || s.includes('signature')) {
    return 'The wallet signed with an account the chain did not accept. Check the selected account.';
  }
  if (s.includes('account sequence') || s.includes('sequence mismatch')) {
    return 'Another transaction from this account is still settling. Wait a moment and try again.';
  }
  /*
   * Deliberately not the raw text. A node error is written for a validator operator
   * and leaks module paths and type URLs; shown to a creator it reads as a crash.
   */
  return 'The chain refused the transaction. Nothing was created and nothing was spent beyond the fee.';
}

/**
 * The plan's messages, rebuilt as SDK message objects.
 *
 * Keyed off the SAME `typeUrl` constants the plan uses, so a message added to the plan
 * and not handled here throws rather than being silently dropped. Dropping one would be
 * the worst outcome available: a launch that creates a denom and mints a supply without
 * ever handing it to the factory leaves the creator holding tokens no curve will sell.
 */
export function composeMessages(plan: LaunchPlan, sender: string) {
  return plan.messages.map((m) => {
    // `unknown` rather than a shaped type: the plan's values are deliberately loose
    // (they are JSON bound for a chain), and each branch narrows only what it reads.
    const v = m.value as Record<string, unknown>;
    switch (m.typeUrl) {
      case MSG_CREATE_DENOM:
        return MsgCreateDenom.fromJSON({ sender, subdenom: (v as { subdenom: string }).subdenom });
      case MSG_MINT:
        return MsgMint.fromJSON({
          sender,
          amount: (v as { amount: { denom: string; amount: string } }).amount,
        });
      case MSG_SET_METADATA: {
        /*
         * The plan holds metadata in the chain's snake_case JSON shape (`denom_units`,
         * `uri_hash`), but the SDK's `fromJSON` reads camelCase and does
         * `metadata.denomUnits.map(...)`. Passed the snake_case object directly it found
         * `denomUnits` undefined and threw "Cannot read properties of undefined
         * (reading 'map')" at broadcast time, after the user had clicked Create. This is
         * the first time this path ran against a chain. Translate at the SDK boundary and
         * keep the plan canonical. Shape mirrors scripts/e2e-testnet.mjs.
         */
        const meta = (v as { metadata: Record<string, unknown> }).metadata;
        const units = (meta.denom_units ?? meta.denomUnits ?? []) as Array<{
          denom: string;
          exponent: number;
          aliases?: string[];
        }>;
        return MsgSetDenomMetadata.fromJSON({
          sender,
          metadata: {
            description: (meta.description as string) ?? '',
            denomUnits: units.map((u) => ({
              denom: u.denom,
              exponent: u.exponent,
              aliases: u.aliases ?? [],
            })),
            base: meta.base as string,
            display: meta.display as string,
            name: (meta.name as string) ?? '',
            symbol: meta.symbol as string,
            uri: (meta.uri as string) ?? '',
            uriHash: (meta.uri_hash as string) ?? (meta.uriHash as string) ?? '',
            decimals: (meta.decimals as number) ?? TOKEN_DECIMALS,
          } as never,
        });
      }
      case MSG_CHANGE_ADMIN: {
        const c = v as { denom: string; new_admin: string };
        return MsgChangeAdmin.fromJSON({ sender, denom: c.denom, newAdmin: c.new_admin });
      }
      case MSG_EXECUTE: {
        const e = v as unknown as {
          contract: string;
          msg: Record<string, unknown>;
          funds: Array<{ denom: string; amount: string }>;
        };
        return MsgExecuteContract.fromJSON({
          sender,
          contractAddress: e.contract,
          msg: e.msg,
          funds: e.funds,
        });
      }
      default:
        throw new BroadcastError(
          'simulate',
          'This launch contains a step this app does not know how to sign.',
          `unhandled typeUrl ${m.typeUrl}`,
        );
    }
  });
}

interface InjectedSigner {
  getOfflineSigner?: (chainId: string) => {
    signDirect: (
      address: string,
      doc: { bodyBytes: Uint8Array; authInfoBytes: Uint8Array; chainId: string; accountNumber: bigint },
    ) => Promise<{
      /*
       * What the wallet ACTUALLY signed. Keplr (and the others) may re-encode the doc
       * before signing it, so the signature is over THESE bytes, not the ones passed in.
       * Broadcasting the original bytes with this signature fails verification. Use these.
       */
      signed?: { bodyBytes: Uint8Array; authInfoBytes: Uint8Array };
      signature: { signature: string };
    }>;
  };
  getKey: (chainId: string) => Promise<{ pubKey: Uint8Array; bech32Address: string }>;
}

/**
 * Where a transaction has got to, reported as it happens.
 *
 * NAMED AFTER WHAT THE CODE IS DOING, not after how long it has been doing it. Each
 * value below is entered at the line that begins that work and left at the line that
 * finishes it, so a dialog rendering these is rendering an observation. There is no
 * step for "almost done" because there is no line of code that means it.
 *
 *  - `preparing`   reading the account number and sequence from the chain.
 *  - `signing`     the wallet prompt is open; we can see nothing inside it.
 *  - `broadcasting` the signed bytes are on their way to the chain.
 *  - `settling`    the node took it and has not put it in a block yet.
 */
export type TxStage = 'preparing' | 'signing' | 'broadcasting' | 'settling';

/**
 * What a broadcast returns once it stops pretending every send is decided.
 *
 * `settled: false` carries a real hash for a real transaction whose fate is simply
 * not known yet. The caller polls on from there; see `lib/txStatus.ts`. Before this,
 * every caller destructured `{ txHash }` and showed "sent", which was true, and then
 * never asked again, which is where the honesty ran out.
 */
export interface BroadcastOutcome {
  txHash: string;
  /** The block it landed in, when the server saw it land. */
  height: number | null;
  settled: boolean;
}

/** Gas limits per operation. See `signAndBroadcast` on why these are not simulated. */
export const GAS = {
  /** Four messages including two contract instantiates. */
  launch: 3_000_000,
  /** One execute with a bank send out. */
  trade: 800_000,
  /** One execute with up to two bank sends out. */
  claim: 500_000,
} as const;

/**
 * Signs and broadcasts a prepared set of messages, returning the transaction hash.
 *
 * GAS IS A FIXED LIMIT PER OPERATION, not a simulation. The comment here used to claim
 * it was "simulated and then multiplied, never guessed", which was not what the code
 * did: the limit was the literal 3000000 below, for every transaction. The claim was
 * more careful than the implementation, which is the worse direction for a comment to
 * be wrong in, because it stops the next reader from checking.
 *
 * Fixed limits are defensible here and simulation would be better. A limit is a
 * ceiling, not a charge, so an over-estimate costs the user nothing on Injective's fee
 * market; what it costs is the failure mode when a limit is too LOW, which is a
 * transaction that fails after the user has already approved it. So the figures are set
 * per operation rather than shared, and generously.
 */
async function signAndBroadcast(opts: {
  msgs: ReturnType<typeof composeMessages>;
  sender: string;
  wallet: unknown;
  gas: number;
  onStage?: (stage: TxStage) => void;
}): Promise<BroadcastOutcome> {
  const stage = (s: TxStage) => opts.onStage?.(s);
  const signer = opts.wallet as InjectedSigner;
  const offline = signer.getOfflineSigner?.(NETWORK.chainId);
  if (!offline) {
    throw new BroadcastError(
      'no-signer',
      'This wallet cannot sign on this chain. Reconnect and try again.',
    );
  }

  const key = await signer.getKey(NETWORK.chainId);

  /*
   * THE OTHER HALF OF F-18, and it is the half that reaches a prompt. The messages,
   * the sender and the sequence are all built for `opts.sender`, the address the page
   * was showing; `key` is read from the extension HERE, at signing time. If the user
   * switched account in the wallet after the trade was prepared, those are two
   * different accounts, and this would carry one account's pubkey in the other's
   * authInfo, ask the extension to sign for an address it is no longer on, and lose
   * whichever way it went: refused by the wallet, or refused by the chain's signature
   * verification after the user had already approved it.
   *
   * No funds are at risk either way - a transaction that fails verification never
   * enters a block, so it costs no gas - and that is exactly why this is worth
   * refusing rather than attempting. What it costs is a prompt the user approves and
   * an error they cannot explain, about an account they can no longer see on the page.
   * The listener in `ConnectWallet` makes this rare; it cannot make it impossible,
   * because the switch can happen between the quote and the click.
   */
  if (key.bech32Address !== opts.sender) {
    throw new BroadcastError(
      'wrong-account',
      'Your wallet has switched to a different account since this was prepared. Nothing was signed. Check the address in the header and try again.',
      `prepared for ${opts.sender}, wallet is on ${key.bech32Address}`,
    );
  }

  const msgs = opts.msgs;

  // Account number and sequence come from the chain, never from memory: a stale
  // sequence is rejected after the user has already approved the prompt.
  let account;
  try {
    stage('preparing');
    const auth = new ChainRestAuthApi(getLcdUrl());
    account = await auth.fetchAccount(opts.sender);
  } catch (e) {
    throw new BroadcastError(
      'account',
      'This account has never been funded on this network, so the chain does not know it yet. Send it a little INJ first.',
      (e as Error).message,
    );
  }

  const base = account.account.base_account;
  const { txRaw, signDoc } = createTransaction({
    message: msgs,
    memo: '',
    /*
     * The fee scales with the gas limit. It was a flat 0.002 INJ against a 3000000
     * limit whatever the operation, so a fee claim paid a launch's fee.
     *
     * The price itself, and why it is not the chain's minimum, is documented on
     * `GAS_PRICE_INJ`. It lives in `config.ts` because `wallet.ts` has to tell Keplr
     * the same number, and the two were separate literals.
     */
    fee: {
      amount: [{ denom: 'inj', amount: String(BigInt(opts.gas) * GAS_PRICE_INJ) }],
      gas: String(opts.gas),
    },
    pubKey: Buffer.from(key.pubKey).toString('base64'),
    sequence: Number(base.sequence),
    accountNumber: Number(base.account_number),
    chainId: NETWORK.chainId,
  });

  let signature: string;
  try {
    stage('signing');
    const res = await offline.signDirect(opts.sender, {
      bodyBytes: signDoc.bodyBytes,
      authInfoBytes: signDoc.authInfoBytes,
      chainId: NETWORK.chainId,
      accountNumber: BigInt(base.account_number),
    });
    signature = res.signature.signature;
    /*
     * Broadcast the bytes the WALLET signed, not the ones we handed it.
     *
     * Keplr and the others re-encode the sign doc before signing (field ordering, the
     * pubkey Any, sometimes the fee), so the signature covers `res.signed`, not our
     * `txRaw`. Attaching the signature to our original bytes produced
     * "unable to verify single signer signature: unauthorized" (code 4) on testnet: the
     * signature was valid, just over a slightly different encoding than what we sent.
     * When a wallet returns `signed` (all of them do for signDirect), those bytes are
     * authoritative.
     */
    if (res.signed?.bodyBytes && res.signed?.authInfoBytes) {
      txRaw.bodyBytes = res.signed.bodyBytes;
      txRaw.authInfoBytes = res.signed.authInfoBytes;
    }
  } catch (e) {
    const msg = (e as Error).message ?? '';
    if (/reject|denied|closed/i.test(msg)) {
      throw new BroadcastError('rejected', 'You closed the wallet prompt, so nothing was signed.');
    }
    throw new BroadcastError('rejected', 'The wallet would not sign this transaction.', msg);
  }

  txRaw.signatures = [Buffer.from(signature, 'base64')];

  /*
   * Broadcast through our own origin, never straight to the LCD from the browser.
   *
   * Only the finished, signed bytes leave here; the key stayed in the wallet. A direct
   * browser POST to the LCD is cross-origin with a JSON body, so it triggers a CORS
   * preflight the public LCD does not answer, and the request is blocked before it is
   * sent, with nothing the page can catch: a launch "did nothing" after signing. The GET
   * reads elsewhere are simple requests that skip the preflight, which is why the rest of
   * the app worked. `/api/broadcast` forwards the bytes server-side, where the inclusion
   * poll is also reliable. See lib/txBroadcast.ts.
   */
  const toB64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
  let data: { txHash?: string; height?: number | null; settled?: boolean; error?: string; detail?: string };
  try {
    stage('broadcasting');
    const resp = await fetch('/api/broadcast', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        bodyBytes: toB64(txRaw.bodyBytes),
        authInfoBytes: toB64(txRaw.authInfoBytes),
        signatures: (txRaw.signatures as Uint8Array[]).map(toB64),
      }),
    });
    data = (await resp.json().catch(() => ({}))) as typeof data;
    if (!resp.ok && !data?.error) {
      throw new BroadcastError('broadcast', describeBroadcastFailure(''), `broadcast service returned ${resp.status}`);
    }
  } catch (e) {
    if (e instanceof BroadcastError) throw e;
    throw new BroadcastError(
      'broadcast',
      'The transaction was signed but could not be sent. Check your connection and try again; nothing was created.',
      (e as Error).message,
    );
  }

  if (data?.error) {
    throw new BroadcastError('broadcast', data.error, data.detail);
  }
  if (!data?.txHash) {
    throw new BroadcastError('broadcast', describeBroadcastFailure(''), 'the broadcast service returned no transaction hash');
  }
  /*
   * `settled` ABSENT MEANS NOT SETTLED, which is the safe direction for a field that
   * did not used to exist. A deployment running an older route returns `{txHash}`
   * alone; reading that as settled would have the caller skip the poll and announce a
   * confirmation nobody observed, which is the precise failure this whole change is
   * about. Unsettled costs one extra chain read.
   */
  const settled = data.settled === true;
  if (!settled) stage('settling');
  return { txHash: data.txHash, height: data.height ?? null, settled };
}

/** Signs and broadcasts a launch. */
export async function broadcastLaunch(opts: {
  plan: LaunchPlan;
  sender: string;
  wallet: unknown;
  onStage?: (stage: TxStage) => void;
}): Promise<BroadcastOutcome> {
  return signAndBroadcast({
    msgs: composeMessages(opts.plan, opts.sender),
    sender: opts.sender,
    wallet: opts.wallet,
    gas: GAS.launch,
    onStage: opts.onStage,
  });
}

/**
 * Signs and broadcasts one contract call.
 *
 * WHY THIS EXISTS. The signing path above was reachable only through a `LaunchPlan`, so
 * the only transaction this app could send was a launch. Everything else was drawn and
 * dead: the trade panel's button was literally `<button className="go" disabled>`, and
 * fees accrued on chain with no way to claim them. The quotes were real, the arithmetic
 * was checked against the contract unit for unit, and nothing could be executed.
 */
export async function broadcastExecute(opts: {
  contract: string;
  msg: Record<string, unknown>;
  funds?: Array<{ denom: string; amount: string }>;
  sender: string;
  wallet: unknown;
  gas?: number;
  onStage?: (stage: TxStage) => void;
}): Promise<BroadcastOutcome> {
  return signAndBroadcast({
    msgs: composeMessages(
      {
        messages: [
          {
            typeUrl: MSG_EXECUTE,
            value: { contract: opts.contract, msg: opts.msg, funds: opts.funds ?? [] },
          },
        ],
      } as unknown as LaunchPlan,
      opts.sender,
    ),
    sender: opts.sender,
    wallet: opts.wallet,
    gas: opts.gas ?? GAS.trade,
    onStage: opts.onStage,
  });
}

/**
 * Several contract calls, in ONE transaction the wallet prompts for once.
 *
 * WHY BATCHED. A creator with five launches has five separate fee balances, and
 * claiming them one at a time is five wallet prompts, five fees and five chances to
 * stop halfway. Cosmos puts many messages in one transaction natively, so the batch
 * is the natural shape and the loop was the unnatural one.
 *
 * It is also ATOMIC, which matters more than the convenience: either every claim
 * lands or none does. A partial sweep leaves a creator guessing which of their
 * launches paid out, and the answer is only discoverable by checking each one.
 *
 * Gas scales with the number of messages. A flat limit sized for one would fail a
 * batch of five AFTER the user approved it, which is the failure mode worth avoiding:
 * a ceiling costs nothing on Injective's fee market, a ceiling that is too low costs
 * a signature.
 */
export async function broadcastExecuteMany(opts: {
  calls: Array<{
    contract: string;
    msg: Record<string, unknown>;
    funds?: Array<{ denom: string; amount: string }>;
  }>;
  sender: string;
  wallet: unknown;
  gasPerCall?: number;
  onStage?: (stage: TxStage) => void;
}): Promise<BroadcastOutcome> {
  if (opts.calls.length === 0) throw new BroadcastError('simulate', 'Nothing to send.');
  const perCall = opts.gasPerCall ?? GAS.claim;
  return signAndBroadcast({
    msgs: composeMessages(
      {
        messages: opts.calls.map((c) => ({
          typeUrl: MSG_EXECUTE,
          value: { contract: c.contract, msg: c.msg, funds: c.funds ?? [] },
        })),
      } as unknown as LaunchPlan,
      opts.sender,
    ),
    sender: opts.sender,
    wallet: opts.wallet,
    // A base for the transaction itself plus room per message.
    gas: 150_000 + perCall * opts.calls.length,
    onStage: opts.onStage,
  });
}
