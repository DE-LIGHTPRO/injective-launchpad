# Release checklist

Production (`injpad.vercel.app`) deploys from `main` and currently points at an
**old testnet factory** (`inj1gfkv0e…jz0mpf`) with three live launches. Those launches
run the old contracts: graduation sends liquidity to an address, curves have a wasm
admin, and creators keep their denom's mint key.

The new app checks every launch on chain and **disables trading** on any curve whose code
id is not pinned, that has an upgrade key, or whose mint key is held by someone other than
the curve. Merged as-is, it would correctly mark all three old launches unsafe. So the
order matters.

## Order

1. **Testnet contracts** (your machine, throwaway key in `scripts/.env.local`, `chmod 600`):
   ```bash
   bash scripts/build-wasm.sh
   node scripts/deploy.mjs          # set INJ_PLATFORM_ADDRESS first
   npm --prefix scripts run e2e     # 8 asserted steps, about 3 INJ
   ```
   Keep the printed `NEXT_PUBLIC_FACTORY_ADDRESS` and `NEXT_PUBLIC_CURVE_CODE_IDS`.
   Allowlist any extra quote with its symbol, e.g.
   `{"set_quote":{"denom":"peggy0x…","decimals":6,"symbol":"USDT"}}`, or it shows as hex.
   If step 3 of the e2e fails on the denom authority, stop: Injective did not accept the
   factory's mint-key handover (see `docs/AUDIT.md` "To verify on testnet").
2. **Vercel environment** (Project → Settings → Environment Variables, Production and
   Preview):
   - `NEXT_PUBLIC_FACTORY_ADDRESS` = the new factory
   - `NEXT_PUBLIC_CURVE_CODE_IDS` = the new curve code id
   - remove `NEXT_PUBLIC_DEMO` if it is set
   - optional now, required before mainnet: `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`
3. **Check the preview** of PR #1 against the new factory: create a launch from the
   browser with a wallet, buy, sell. This is the first time the browser signing path
   runs against a chain.
4. **Merge PR #1.** Production redeploys from `main`.
5. **Old launches.** They stay on chain and keep working through the old factory. The new
   site will not list them (it reads the new factory). Tell the three creators, and do
   not route anyone to the old factory again.

## Before mainnet

- Third-party audit (`docs/AUDIT_SCOPE.md`), and fix anything it finds.
- Multisig for `INJ_FACTORY_ADMIN` and `INJ_FACTORY_WASM_ADMIN`.
- CSP nonce middleware to drop `'unsafe-inline'` scripts.
- Domain for Vetta; set `NEXT_PUBLIC_SITE_URL`.
- GitHub Actions working again (currently no runner is assigned, almost certainly a
  billing or minutes limit), so CI guards every merge.
