/**
 * Every field the CosmWasm contracts carry has a decision recorded on the EVM side.
 *
 * WHY THIS EXISTS. The Solidity port dropped `fee_sell_bps` entirely, and nothing
 * caught it: 30 contract tests passed, the parity vectors passed, and the build was
 * clean. The vectors only exercise the MATH, and the sell fee is applied at the
 * CONTRACT layer, so the whole corpus was blind to it. It surfaced because the app's
 * `CurveConfig` type happened to require a field the contracts did not have, which is
 * luck rather than a process.
 *
 * This is the process. Read the Rust structs, read the Solidity, and require that
 * every field is either present or listed below with a reason. A port is a promise
 * that two implementations agree, and the fields are the smallest unit of that
 * promise that can be checked mechanically.
 *
 * IT DOES NOT CHECK BEHAVIOUR. A field present in both can still be used
 * differently; that is what the parity vectors and the lifecycle tests are for. What
 * this catches is the whole field going missing, which is the failure that produced
 * the sell-fee defect and which nothing else here can see.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const RUST = join(ROOT, 'contracts', 'curve', 'src', 'state.rs');
const SOL = join(ROOT, 'evm', 'src', 'Curve.sol');

/**
 * Fields the EVM port deliberately does not have, each with the reason.
 *
 * A field may only be here because of something true about the EVM, never because
 * porting it was inconvenient. Anything in this list is a difference a user could
 * notice, so each one is a decision somebody has to be able to defend.
 */
const ACCOUNTED_FOR: Record<string, string> = {
  denom: 'the token is an ERC-20 at an address, not a tokenfactory denom string',
  quote_denom: 'the quote is always native INJ, arriving as msg.value',
  curve: 'the nested CurveConfigStored, present as six immutables and curveParams()',
  opened_at: 'named TRADE_START, set from the launch params or the creating block',
  rules:
    'the cap is MAX_PER_WALLET and the ledger purchasedFromCurve; the Rust struct also holds tradeStart, which is TRADE_START here',
};

function rustFields(struct: string): string[] {
  const src = readFileSync(RUST, 'utf8');
  const m = new RegExp(`pub struct ${struct}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(src);
  assert.ok(m, `${struct} is not in state.rs, so this guard measures nothing`);
  return [...m[1].matchAll(/^\s*pub (\w+):/gm)].map((x) => x[1]);
}

function camel(s: string): string {
  const [head, ...rest] = s.split('_');
  return head + rest.map((w) => w[0].toUpperCase() + w.slice(1)).join('');
}

function solidityHas(name: string): boolean {
  const src = readFileSync(SOL, 'utf8');
  const forms = [name, camel(name), name.toUpperCase(), camel(name).replace(/^./, (c) => c.toUpperCase())];
  return forms.some((f) => new RegExp(`\\b_?${f}\\b`).test(src));
}

for (const struct of ['Config', 'State', 'CurveConfigStored']) {
  test(`every ${struct} field is present in the port or accounted for`, () => {
    const fields = rustFields(struct);
    assert.ok(fields.length >= 5, `${struct} yielded ${fields.length} fields; the parser is broken`);

    const unexplained = fields.filter((f) => !solidityHas(f) && !(f in ACCOUNTED_FOR));
    assert.deepEqual(
      unexplained,
      [],
      `these ${struct} fields are in the CosmWasm contracts and nowhere in the Solidity, ` +
        `and nowhere in ACCOUNTED_FOR either. Port them, or record why not.`,
    );
  });
}

test('the sell fee specifically, because it is the one that was dropped', () => {
  assert.ok(
    rustFields('CurveConfigStored').includes('fee_sell_bps'),
    'the Rust lost its sell fee, so this guard no longer means anything',
  );
  assert.ok(solidityHas('fee_sell_bps'), 'the Solidity lost its sell fee again');
});

test('nothing is excused without a reason', () => {
  // An empty string would pass the lookup above and explain nothing.
  for (const [field, why] of Object.entries(ACCOUNTED_FOR)) {
    assert.ok(why.length > 20, `${field} is excused with no real reason: "${why}"`);
  }
});

test('the per-wallet cap exists on both sides, not just in the Rust', () => {
  /*
   * This replaced a guard that checked the create form did NOT offer a cap on EVM,
   * which was right while the contracts had none. They have one now, so the check
   * that matters is the opposite: that the field is really there, enforced on buys
   * and freed on sells, rather than stored and ignored.
   */
  const sol = readFileSync(SOL, 'utf8');
  assert.match(sol, /uint256 public immutable MAX_PER_WALLET/, 'the cap is gone');
  assert.match(sol, /mapping\(address => uint256\) public purchasedFromCurve/, 'the ledger is gone');
  assert.match(sol, /revert OverWalletCap/, 'the cap is stored but never enforced');
  assert.match(
    sol,
    /purchasedFromCurve\[msg\.sender\] = already > tokensIn/,
    'selling no longer frees allowance, so the cap counts lifetime purchases',
  );
});
