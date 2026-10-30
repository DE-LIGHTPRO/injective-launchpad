/**
 * Executing a trade on the EVM side, from the message shape the UI already speaks.
 *
 * THE COSMWASM MESSAGE IS THE INTERFACE, and that is what keeps this small. The trade
 * panel builds `{ buy: { min_tokens_out } }` with the payment in `funds`, and the
 * claim page builds `{ claim_fees: {} }`. Those shapes describe the INTENT, not the
 * transport, so translating them here means the panel, the claim page and the create
 * form all work on EVM without a line changing in any of them.
 *
 * A SELL NEEDS AN APPROVAL AND A BUY DOES NOT, which is the one real asymmetry the
 * translation has to introduce. On CosmWasm both sides attach funds to the message
 * and neither can be spent without the trade happening in the same transaction. ERC-20
 * has no attachment: the curve must be allowed to pull the tokens first. So a sell is
 * two transactions where a buy is one, and the user is told that rather than left
 * wondering why their wallet opened twice.
 *
 * The approval is for EXACTLY the amount being sold, never unlimited. An infinite
 * allowance outlives the trade and is what a later compromise of the curve would
 * inherit.
 */
import { parseEventLogs, type Address, type Hash, type PublicClient } from 'viem';

import { getFactoryAddress } from '../config.ts';
import { CURVE_ABI, ERC20_ABI, FACTORY_ABI } from './abi.ts';
import { evmChain, evmClient } from './read.ts';
import { walletClient } from './wallet.ts';
import { tokenAddressOf } from './denom.ts';

export type EvmStage = 'simulating' | 'approving' | 'signing' | 'broadcasting' | 'settling';

export interface EvmExecuteResult {
  hash: Hash;
  /** The block it landed in. Known here, because the receipt was awaited. */
  height: number;
  /** Set when the call created a launch, so the caller can route to it. */
  curve?: Address;
  token?: Address;
}

interface ExecuteOpts {
  contract: string;
  msg: Record<string, unknown>;
  funds?: Array<{ denom: string; amount: string }>;
  sender: string;
  onStage?: (stage: EvmStage) => void;
}

function amountFrom(funds: ExecuteOpts['funds']): bigint {
  const first = funds?.[0];
  return first ? BigInt(first.amount) : 0n;
}

async function waitFor(hash: Hash, onStage?: (s: EvmStage) => void) {
  onStage?.('settling');
  const receipt = await evmClient().waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    throw new Error('The chain refused the transaction. Nothing was created and nothing was spent beyond the fee.');
  }
  return receipt;
}

/**
 * Simulate, then sign, then wait. Every write on this backend goes through here.
 *
 * THE SIMULATION IS THE HALF THAT WAS MISSING, and its absence was visible on the
 * screen rather than in the code. `TxDialog` draws a five-step rail whose second step
 * is "Checking - running it against the chain first, so a failure costs you nothing",
 * and its own comment says the list is written to one rule: every step is a real step
 * with a real line of code behind it. On the EVM path there was no such line. The
 * stage was never reported, so the rail stood there promising a free pre-flight that
 * did not happen, and a buy that the curve would refuse - slippage, a wallet cap,
 * trading not open yet - cost the user gas to find out. The CosmWasm path has
 * simulated since audit F-09 and this is the same guarantee, restored.
 *
 * `simulateContract` IS AN `eth_call`: free, no signature, and it decodes the
 * contract's own custom error, which is what makes `describeEvmFailure` able to name
 * the rule that refused rather than printing calldata at somebody.
 *
 * THE SIMULATED CALL IS THE CALL THAT IS SENT. viem's `simulateContract` hands back a
 * `request`, and that object is what goes to `writeContract`. Rebuilding the arguments
 * for the write would let the thing that was checked and the thing that was signed
 * differ, which is the shape of defect this project keeps recording - a v3 quote that
 * built a v2 transaction, a plan that was shown and a message that was sent.
 *
 * ONE HELPER FOR ALL FOUR WRITES, deliberately. Buy, sell, the sell's approval and
 * createLaunch were four copies of sign-then-wait, and adding the simulation to three
 * of them would be the "guard scoped to one branch" failure: the fourth would keep the
 * old behaviour and nothing would say so.
 */
async function signAndSettle(
  call: Parameters<PublicClient['simulateContract']>[0],
  onStage?: (s: EvmStage) => void,
  signingStage: EvmStage = 'signing',
) {
  onStage?.('simulating');
  const { client: wallet } = await walletClient();
  const { request } = await evmClient().simulateContract(call);
  onStage?.(signingStage);
  const hash = await wallet.writeContract(request as never);
  onStage?.('broadcasting');
  return waitFor(hash, onStage);
}

export async function executeEvm(opts: ExecuteOpts): Promise<EvmExecuteResult> {
  const { account } = await walletClient();
  const curve = opts.contract as Address;

  /*
   * THE WALLET'S ACCOUNT HAS TO BE THE ONE THE PANEL QUOTED.
   *
   * `opts.sender` is the address the page read balances for, computed the slippage
   * floor against and showed in the confirmation. If the user switched account in
   * the extension between opening the panel and pressing the button, signing with
   * whatever the wallet is on now spends a different account's funds against a
   * quote made for another one - the F-18 defect at the one moment it costs money.
   * Compared case-insensitively because only one side is checksummed.
   */
  if (opts.sender && opts.sender.toLowerCase() !== account.toLowerCase()) {
    throw new Error(
      'The wallet is on a different account than this page was reading. Reload, then try again.',
    );
  }

  if ('buy' in opts.msg) {
    const m = opts.msg.buy as { min_tokens_out?: string };
    const r = await signAndSettle(
      {
        address: curve,
        abi: CURVE_ABI,
        functionName: 'buy',
        /*
         * The zero recipient means "the sender", which is what the contract reads it
         * as. Passed explicitly rather than left out: the argument is not optional in
         * the ABI, and a recipient someone else chose is not a default worth having.
         */
        args: [BigInt(m.min_tokens_out ?? '0'), '0x0000000000000000000000000000000000000000'],
        value: amountFrom(opts.funds),
        account,
        chain: evmChain(),
      } as never,
      opts.onStage,
    );
    return { hash: r.transactionHash, height: Number(r.blockNumber) };
  }

  if ('sell' in opts.msg) {
    const m = opts.msg.sell as { min_inj_out?: string };
    const tokensIn = amountFrom(opts.funds);
    const token = tokenAddressOf(opts.funds?.[0]?.denom ?? '') as Address | null;
    if (!token) throw new Error('No token address on the sell, so nothing could be approved.');

    /*
     * Only approve what is missing. A wallet that already has a sufficient allowance
     * should not be asked again: a second popup for no reason is how people learn to
     * click through them.
     */
    const allowance = await evmClient().readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [account, curve],
    });

    if (allowance < tokensIn) {
      await signAndSettle(
        {
          address: token,
          abi: ERC20_ABI,
          functionName: 'approve',
          // Exactly the amount, never maxUint256.
          args: [curve, tokensIn],
          account,
          chain: evmChain(),
        } as never,
        opts.onStage,
        'approving',
      );
    }

    /*
     * SIMULATED AFTER THE APPROVAL HAS LANDED, which is why this is a second call
     * rather than both being checked up front. `sell` pulls the tokens, so simulating
     * it before the allowance exists reverts on the allowance - a refusal that says
     * nothing about whether the sale itself is sound, reported to the user as though
     * it did.
     */
    const r = await signAndSettle(
      {
        address: curve,
        abi: CURVE_ABI,
        functionName: 'sell',
        args: [tokensIn, BigInt(m.min_inj_out ?? '0')],
        account,
        chain: evmChain(),
      } as never,
      opts.onStage,
    );
    return { hash: r.transactionHash, height: Number(r.blockNumber) };
  }

  if ('claim_fees' in opts.msg) {
    const r = await signAndSettle(
      {
        address: curve,
        abi: CURVE_ABI,
        functionName: 'claimFees',
        args: [],
        account,
        chain: evmChain(),
      } as never,
      opts.onStage,
    );
    return { hash: r.transactionHash, height: Number(r.blockNumber) };
  }

  throw new Error(`No EVM translation for this message: ${Object.keys(opts.msg).join(', ')}`);
}

/**
 * Thrown when a batch of calls landed only in part.
 *
 * ON THE EVM BACKEND A BATCH IS NOT ATOMIC, and this type exists so that cannot be
 * glossed over. CosmWasm puts every `claim_fees` of a multi-launch claim into one
 * transaction: it lands whole or not at all, which is what lets the claim page zero
 * every row the moment it confirms. Here each call is its own transaction, so a
 * failure on the third leaves the first two claimed and the money actually moved.
 *
 * Reporting that as a plain failure would tell a creator nothing happened when two
 * claims did, and reporting it as a success would zero rows that still owe. So it
 * carries which ones landed, and the caller says so.
 */
export class EvmPartialBatchError extends Error {
  readonly landed: number;
  readonly total: number;
  constructor(landed: number, total: number, cause: string) {
    super(
      `${landed} of ${total} transactions landed before this one failed, and those have taken effect. ` +
        `Reload the page to see what is still owed. The chain said: ${cause}`,
    );
    this.name = 'EvmPartialBatchError';
    this.landed = landed;
    this.total = total;
  }
}

/**
 * Several calls, one transaction each, in order.
 *
 * SEQUENTIAL, NOT CONCURRENT, and not for politeness: transactions from one account
 * carry consecutive nonces, and firing them together leaves the wallet to order
 * them. Some wallets queue them correctly, some open overlapping prompts and some
 * drop one, and the symptom is a claim that silently misses a launch.
 *
 * The stage callback reports progress as `signing` per call rather than inventing a
 * stage name the dialog does not know, so the user sees the wallet open n times and
 * the dialog stays truthful about what it is waiting for.
 */
export async function executeManyEvm(
  calls: Array<{ contract: string; msg: Record<string, unknown>; funds?: ExecuteOpts['funds'] }>,
  sender: string,
  onStage?: (s: EvmStage) => void,
  /*
   * The per-call executor, injected so the batch SEMANTICS can be exercised without a
   * wallet or a chain. What matters here - that the calls run in order, that a failure
   * after the first is reported as partial, and that a failure on the first is not -
   * is decided entirely by this loop, and `executeEvm` needs an EIP-1193 provider that
   * no test has. Defaulted, so every caller gets the real one.
   */
  send: (o: ExecuteOpts) => Promise<EvmExecuteResult> = executeEvm,
): Promise<EvmExecuteResult> {
  if (calls.length === 0) throw new Error('Nothing to send.');
  let last: EvmExecuteResult | null = null;
  for (let i = 0; i < calls.length; i++) {
    try {
      last = await send({ ...calls[i], sender, onStage });
    } catch (e) {
      /*
       * A FAILURE ON THE FIRST CALL IS NOT PARTIAL. Nothing landed, so the user's own
       * error - a closed wallet prompt, an insufficient balance - is what they should
       * read, and dressing it up as "0 of 3 landed" would hide the cause behind
       * arithmetic.
       */
      if (i === 0) throw e;
      throw new EvmPartialBatchError(i, calls.length, (e as Error).message);
    }
  }
  // Unreachable: the loop ran at least once and either assigned or threw. Kept so the
  // return type needs no assertion, which is the thing that keeps compiling after a
  // shape changes.
  if (!last) throw new Error('Nothing to send.');
  return last;
}

export interface EvmCreateParams {
  name: string;
  symbol: string;
  virtualInj: bigint;
  graduationTarget: bigint;
  feeBps: bigint;
  feeSellBps: bigint;
  earlyFeeStartBps: bigint;
  earlyFeeSecs: bigint;
  tradeStart: bigint;
  maxPerWallet: bigint;
  rewardRoute: 0 | 1;
}

/**
 * Create a launch, and read back WHICH launch from the receipt.
 *
 * The addresses come out of the emitted event rather than from a follow-up read of
 * `launchCount() - 1`. Two creations in the same block would make that read name
 * somebody else's launch, and the person who just paid would be sent to it.
 */
export async function createLaunchEvm(
  p: EvmCreateParams,
  sender: string,
  launchFee: bigint,
  onStage?: (s: EvmStage) => void,
): Promise<EvmExecuteResult> {
  const { account } = await walletClient();
  // Same reason as `executeEvm`: the fee and the parameters were shown for one
  // account, so another one must not pay them.
  if (sender && sender.toLowerCase() !== account.toLowerCase()) {
    throw new Error(
      'The wallet is on a different account than this page was reading. Reload, then try again.',
    );
  }
  /*
   * SIMULATED LIKE EVERY OTHER WRITE, through the same helper. A creation refused on
   * chain costs the launch fee's gas and tells the creator nothing; the factory's own
   * refusals (a cap at or above the curve supply, a fee over the ceiling, an
   * unreachable graduation target) all surface here for free instead.
   */
  const receipt = await signAndSettle({
    address: getFactoryAddress() as Address,
    abi: FACTORY_ABI,
    functionName: 'createLaunch',
    /*
     * Written out rather than spread. viem checks a struct argument structurally
     * against the ABI, and an interface that merely looks right collapses the
     * inferred type to `never` with no indication which field is wrong. Named here,
     * a mismatch points at the field.
     */
    args: [
      {
        name: p.name,
        symbol: p.symbol,
        virtualInj: p.virtualInj,
        graduationTarget: p.graduationTarget,
        feeBps: p.feeBps,
        feeSellBps: p.feeSellBps,
        earlyFeeStartBps: p.earlyFeeStartBps,
        earlyFeeSecs: p.earlyFeeSecs,
        tradeStart: p.tradeStart,
        maxPerWallet: p.maxPerWallet,
        rewardRoute: p.rewardRoute,
      },
    ],
    value: launchFee,
    account,
    chain: evmChain(),
  } as never, onStage);

  const logs = parseEventLogs({ abi: FACTORY_ABI, logs: receipt.logs, eventName: 'LaunchCreated' });
  const created = logs[0]?.args as { curve?: Address; token?: Address } | undefined;
  return {
    hash: receipt.transactionHash,
    height: Number(receipt.blockNumber),
    curve: created?.curve,
    token: created?.token,
  };
}
