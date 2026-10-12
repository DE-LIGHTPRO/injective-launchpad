# Automatic fee payouts

Fees accrue on each launch's curve contract and are paid out by `claim_fees`, which
sends the creator's share and the launchpad's share to the addresses stored when the
launch was created. `scripts/payout-keeper.mjs` calls it for every launch that is
owed something, so creators are paid without doing anything.

## Why this is a scheduled script and not a contract feature

**A CosmWasm contract cannot schedule itself.** There is no on-chain timer on
Injective. A contract only ever runs because somebody sent it a message, so "every
fifteen minutes" has to come from outside the chain. There are two honest ways to
pay out automatically:

| | |
|---|---|
| **Inside every trade** | No scheduler needed. But every trader pays the gas for somebody else's payout on every buy and sell, and a recipient that cannot receive (a blocked address, a contract that reverts) breaks trading for everyone on that launch. |
| **A keeper on a schedule** | Traders pay nothing extra. Payouts are as frequent as the schedule. Costs the keeper gas, and a keeper that stops running means fees sit accrued until it starts again. |

The keeper is the better trade here: fees sitting accrued for an extra fifteen
minutes is a delay, while a payout that can break a trade is an outage. The money is
never at risk in either case, because it is held by the curve contract and owed to
addresses that cannot be changed.

## Why anyone is allowed to trigger a payout

`claim_fees` checks no sender, and that is deliberate.

**It cannot be redirected.** The contract pays the creator and the platform at the
addresses stored at launch. Whoever sends the message chooses nothing except to pay
the gas. The worst a stranger can do is pay for your transfer.

If only the creator could claim, the launchpad's 30% would sit behind that creator's
willingness to act, and a creator who lost their key would strand both shares for
good. Permissionless claiming is also exactly what lets this keeper exist: it is an
ordinary wallet with gas and no special standing.

The same property makes the keeper safe to run unattended. A compromised keeper key
wastes its own gas; the money still lands where it was always going to land.

## Running it

```bash
# what it would pay, sending nothing
node scripts/payout-keeper.mjs --dry-run

# sweep once
node scripts/payout-keeper.mjs
```

It needs `INJ_MNEMONIC` in `scripts/.env.local` (chmod 600) and the app's
`NEXT_PUBLIC_FACTORY_ADDRESS`. **Give it its own wallet holding gas and nothing
else**: it needs no permissions, so there is no reason for it to hold anything worth
taking.

### Every fifteen minutes

With cron:

```bash
*/15 * * * * cd /path/to/injective-launchpad && /usr/bin/node scripts/payout-keeper.mjs >> /var/log/vetta-payout.log 2>&1
```

It exits non-zero only when a launch could not be paid, so a scheduler's own alerting
fires on a real problem rather than on a quiet run with nothing to do. A run with
nothing owed does nothing and exits 0, so running it more often than necessary is
harmless.

## What it does, and what it deliberately does not

- Reads every launch's state first and **skips the ones owing nothing**. A
  `claim_fees` with nothing owed is refused, and in a batched transaction that single
  refusal reverts every other claim with it. Filtering first is what makes a repeat
  run a no-op rather than a failure.
- Claims **up to 20 launches per transaction**, because a batch is one fee and one
  atomic result, and because gas grows with the batch: a transaction over the block
  limit pays for the attempt and lands nothing.
- **Falls back to one transaction each** when a batch fails. More gas, but one launch
  in a strange state must not quietly stop every other creator from being paid, every
  fifteen minutes, until somebody notices.
- Reads at most 100 launches. Past that this needs paging, and the log will show
  fewer launches than the board does.

## The button stays

The launch page still has "Pay out fees". The keeper makes it unnecessary, not
useless: a creator who wants their money now should not have to wait for a schedule
they cannot see, and the button is also the fallback for a keeper that is not
running. Both call the same contract message and pay the same addresses.
