# Mainnet runbook

The ordered steps to put Vetta on Injective mainnet, and the things to settle before
starting. Written to be followed rather than interpreted: every step is a command or
a decision, and the checks are scripts rather than judgement.

Run the readiness check first and whenever something changes:

```bash
INJ_PLATFORM_ADDRESS=inj1... node scripts/mainnet-readiness.mjs
```

It exits non-zero while anything mechanical is failing, and lists the decisions it
cannot make for you either way.

---

## Before the day

These are not deploy steps. Each one blocks, and none of them can be done quickly.

### 1. A third-party audit

`docs/AUDIT.md` opens with "Not a third-party audit"; it is an internal review log.
`docs/AUDIT_SCOPE.md` is written for an auditor and names the files and line counts.

The contracts will hold other people's money, with no upgrade path on a launch once
it exists. Everything else in this runbook is hours; this is weeks and costs money,
and it is the item least worth skipping. `app/src/app/risks/page.tsx` says plainly
that no third party has audited them, and that sentence is guarded by a test, so
shipping without one at least does not misrepresent itself.

### 2. The addresses

Three roles, and they should not all be one key:

| Role | What it can do | What it cannot |
|---|---|---|
| **Platform** | Receives the launchpad's share of trading fees and the launch fee | Nothing else; it is a recipient |
| **Factory admin** | Allowlist quotes, set the launch fee, point at new curve code, hand over admin | Touch an existing launch, or its funds |
| **Wasm admin** | Migrate the factory contract itself | Touch an existing launch; curves are deployed with no wasm admin and are immutable |

**The platform address must have transacted on mainnet before it is used.** An
address nobody has sent from is one nobody has proved they hold the key to, and fees
paid to a mistyped address are gone with nothing on screen saying so. The readiness
check refuses until it has history, and `deploy.mjs` refuses separately.

**The wasm admin should be a multisig.** Whoever holds it can migrate the factory,
which changes where future fees go and which curve code new launches run. It cannot
reach an existing launch. A laptop key is the wrong holder for this on mainnet.

### 3. A dedicated RPC, and it must be ARCHIVAL

The app reads `NEXT_PUBLIC_LCD_URL`. Two separate reasons, and the second is the one
that is easy to miss when shopping for an endpoint.

**Rate limits.** The board makes one request per launch and the launch page makes
several more. Get an endpoint with a quota before the traffic arrives rather than
after.

**Retention, which is the bigger problem.** The public sentry nodes keep a rolling
window of **100,000 blocks and prune the rest**. Measured 16 Oct 2026:

| | retained | block time | window |
|---|---|---|---|
| `testnet.sentry.lcd.injective.network` | 100,001 blocks | 0.555s | 15.4 hours |
| `sentry.lcd.injective.network` (mainnet) | 100,012 blocks | 0.598s | **16.6 hours** |

**And the hostname is not a node.** Probing mainnet's block 1 ten times in a row
returned a lowest retained height of ~100,000 blocks on eight requests and **~30,600
on the other two** — it balances across nodes pruned to different depths, so the
honest window is the shallowest, about **5.1 hours**, and identical queries succeed
or fail by luck of routing. Plan against the shallowest; the readiness check reports
both and tells you when they disagree. Ask a paid provider the same question and take
more than one sample.

Everything on the launch page built from transaction search is inside that window:
the candle chart, the trade history, the fill prices and the 24h volume. A launch
older than it answers `height N is not available, lowest height is M` as an HTTP 500
and the page says so honestly ("older than the node that answered keeps") — but a
trading surface whose chart empties out overnight is not a product. The copy stops
short of calling the history gone on purpose: one node's refusal does not prove it,
and on this endpoint a reload often reaches a node that still has it.

Note `BLOCKS_PER_DAY` in `app/src/lib/launchActivity.ts` asks for **132,923** blocks.
A 100,000-block node cannot serve a full day even in principle, so **"24h volume" is
unobtainable on a pruning endpoint** regardless of quota.

So the question to ask a provider is not "what is the rate limit" but **"do you serve
archival transaction search, and from what height"**. An endpoint bought on quota
alone solves the problem that was visible and leaves this one.

Measure the one you buy before pointing the app at it:

```bash
INJ_MAINNET_LCD=https://your-endpoint node scripts/mainnet-readiness.mjs
```

`INJ_MAINNET_LCD` is read only by that check, and only to decide which host to
measure. The app's own endpoint is `NEXT_PUBLIC_LCD_URL` in step 8; setting one is not
setting the other.

### 4. A domain

The product is called Vetta and the site is `injpad.vercel.app`. The storage keys
(`injpad:watchlist`) and the Vercel project name are deliberately NOT renamed with
the brand; renaming them empties every watchlist and breaks the deploy script.

### 5. Terms

They need an entity and a jurisdiction to say anything true. The risks page covers
the mechanical truth in the meantime and is honest without them; a page of
legal-sounding text naming nobody is worse than no page, because it implies a company
stands behind it.

---

## On the day

### 6. Re-derive the curve scale

```bash
node scripts/derive-curve-scale.mjs 5000
```

The opening reserve is chosen so a launch opens at a target market cap in dollars,
and **the dollar figure is a premise about one day's INJ price, not a property of the
constant**. 676 was derived at INJ $7.92 on 11 Oct 2026. Re-measure and re-derive;
do not carry the number forward.

The script prints what the constant produces: where it opens, where it graduates, the
price multiple, and the price impact of several buy sizes. Choose on those, not on
the constant. It refuses rather than guessing if the venues disagree or cannot be
reached, and takes `--price=` when you have one you trust.

### 7. Deploy

```bash
cd /path/to/injective-launchpad
./scripts/build-wasm.sh

INJ_LAUNCH_FEE=0.2 \
INJ_PLATFORM_ADDRESS=inj1... \
INJ_FACTORY_ADMIN=inj1... \
INJ_FACTORY_WASM_ADMIN=inj1... \
NEXT_PUBLIC_NETWORK=mainnet \
node scripts/deploy.mjs
```

The signing key is **not** on that command line. `INJ_MNEMONIC` (or
`INJ_PRIVATE_KEY`, one or the other) lives in `scripts/.env.local` at mode 0600,
which the script enforces, because an interactive shell writes its command line to
`~/.zsh_history` in plaintext and a seed phrase is not a password you can rotate.

`INJ_FACTORY_WASM_ADMIN` was missing from this block until 16 Oct 2026, while section
2 above argued at length that it should be a multisig. It takes a multisig address or
`none` to make the factory immutable, and `deploy.mjs` **refuses on mainnet** when it
is empty rather than quietly handing the upgrade key to the deploy key. So the cost
of the omission was a hard stop partway through a deploy, with a signing key already
loaded, on the one morning nobody wants to be reading source.

Notes that cost time if they are learned on the day:

- **Storing a contract needs an explicit gas limit**, which `deploy.mjs` passes.
  Without it the SDK's simulate runs out of gas on txSize for a 356 KB module and
  reports only `INVALID_ARGUMENT`, naming neither gas nor size.
- `INJ_CURVE_CODE_ID` / `INJ_FACTORY_CODE_ID` **reuse an existing code id after
  verifying its hash**, which is the right move when only one contract changed.
- Keep the printed `NEXT_PUBLIC_FACTORY_ADDRESS` and `NEXT_PUBLIC_CURVE_CODE_IDS`.

### 8. Point the app at it, then REDEPLOY

```bash
vercel env rm NEXT_PUBLIC_FACTORY_ADDRESS production --yes
printf 'inj1...' | vercel env add NEXT_PUBLIC_FACTORY_ADDRESS production
# and NEXT_PUBLIC_CURVE_CODE_IDS, NEXT_PUBLIC_NETWORK, NEXT_PUBLIC_LCD_URL
vercel redeploy <the current production url>
```

**`NEXT_PUBLIC_*` is inlined into the client bundle at build time.** Editing the env
does nothing until something rebuilds, and a push-triggered build that starts seconds
before the edit finishes green, reports Ready, and serves the previous factory. This
happened twice in one evening on testnet. The redeploy is not optional.

The full list the deployed app reads, so none of it is discovered later:

| Variable | Set to | What its absence does |
|---|---|---|
| `NEXT_PUBLIC_FACTORY_ADDRESS` | the printed factory | nothing can be read from chain |
| `NEXT_PUBLIC_CURVE_CODE_IDS` | the printed curve code id | curves are unpinned, so the launch page cannot vouch for the code a launch runs |
| `NEXT_PUBLIC_NETWORK` | `mainnet` | **falls back to testnet**, silently, which is the right default and the wrong answer here |
| `NEXT_PUBLIC_LCD_URL` | the archival endpoint from step 3 | falls back to the public sentry, and `isLcdConfigured()` reports false |
| `NEXT_PUBLIC_SITE_URL` | the domain from step 4 | canonical links, the sitemap and every social preview keep saying `injpad.vercel.app` |
| `BLOB_READ_WRITE_TOKEN` | injected by attaching a Vercel Blob store | the logo drop zone **silently disappears** from the create form, leaving the paste-a-link field, which looks like a design decision |
| `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` | an Upstash store | the upload rate limit is per serverless instance, which the platform multiplies |
| `NEXT_PUBLIC_DEMO` | **absent** | set, every page generates fake launches from the curve maths and says so in a banner. Already removed from this project; confirm rather than assume |

Those last three are server-only and carry no `NEXT_PUBLIC_` prefix deliberately: that
prefix publishes a value into the browser bundle, where a write-capable token cannot be
rotated without a rebuild. `runbook-surface.test.ts` fails if this table and the code
disagree in either direction.

### 9. Verify what is actually live

```bash
node scripts/verify-deployment.mjs https://your-domain
```

It reads the served chunks rather than the env, so it answers "is the live site the
one I think is live" instead of "did I set the variable". It also checks the factory
on chain: admin, platform, launch fee, that the curve code id it instantiates is one
the app pins, and that every allowlisted quote has an opening reserve.

A deployment can report Ready, look perfect, and serve the wrong contract. This is
the only check that catches that.

### 10. Switch on automatic payouts

```bash
grep '^INJ_MNEMONIC=' scripts/.env.keeper.local | cut -d'"' -f2 | gh secret set KEEPER_MNEMONIC
gh variable set NEXT_PUBLIC_FACTORY_ADDRESS --body inj1...
gh variable set NEXT_PUBLIC_NETWORK --body mainnet
gh variable set NEXT_PUBLIC_LCD_URL --body https://...
gh workflow run payout.yml      # prove it before the schedule picks it up
```

Fund the keeper wallet with gas. **It must not be the deploy key**, which is also the
admin and the fee recipient: a leak of the keeper costs its gas and nothing else,
because `claim_fees` pays the addresses stored at launch and the sender chooses
nothing. See `docs/PAYOUT-KEEPER.md`.

### 11. One real launch, end to end

Create a launch, buy, sell, and claim, with real funds and small amounts. The e2e
script does this on testnet; on mainnet do it by hand through the interface, because
what is being checked is the signing path a creator actually uses.

Watch for the two that were found on testnet this way and nowhere else: a page that
keeps showing fees as unclaimed after they were paid, and a create that fails after
signing because nothing checked the balance first. Both are fixed and both are
guarded, which is why they are named here rather than left to be rediscovered.

---

## If something is wrong after launch

- **A launch already created cannot be changed.** Its curve has no upgrade key. This
  is the property the product sells and it cuts both ways.
- **The factory can be migrated** by the wasm admin, affecting future launches only.
- **`RemoveQuote`** stops new launches using a quote asset; existing ones keep
  trading, because their curve and reserve live on their own contract.
- **`SetLaunchFee 0`** turns the creation charge off without a redeploy.
