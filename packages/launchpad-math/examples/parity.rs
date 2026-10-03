//! Prints a table of quotes from the canonical Rust maths.
//!
//! The TypeScript port in `app/src/lib/curve.ts` asserts these exact numbers,
//! so any divergence between the UI's quote and the chain's shows up as a
//! failing test rather than as a user's trade reverting on slippage.
//!
//! Regenerate the committed vectors with:
//!
//!     npm --prefix app run vectors
//!
//! which writes `app/src/lib/curve-vectors.json`. The TypeScript reads that
//! file; it used to hold a copy pasted out of this program's stdout, which
//! meant changing the Rust and forgetting to re-paste left the port asserting
//! stale numbers and still passing. A guard whose currency depends on somebody
//! remembering is not a guard.
//!
//! THE CONFIG IS EMITTED TOO, and that is not decoration. This program and the
//! TypeScript test each used to hardcode their own `CurveConfig`, matching only
//! by coincidence. Change either one and the vectors describe a different curve
//! while every parity assertion keeps passing, because both sides are
//! internally consistent and no longer talking about the same thing.

use cosmwasm_std::Uint128;
use launchpad_math::{price_impact_bps, quote_buy, quote_sell, CurveConfig, CurveState};

fn one() -> Uint128 {
    Uint128::new(1_000_000_000_000_000_000)
}
fn amt(n: u128) -> Uint128 {
    Uint128::new(n) * one()
}

fn main() {
    let cfg = CurveConfig {
        virtual_inj: amt(30),
        virtual_tokens: amt(1_073_000_000),
        curve_supply: amt(800_000_000),
        graduation_target: amt(85),
        fee_bps: 100,
    };

    println!("[");

    let mut rows: Vec<String> = Vec::new();

    // The curve these numbers describe. The TypeScript asserts its own config
    // equals this before trusting a single quote below it.
    rows.push(format!(
        r#"  {{"kind":"config","virtualInj":"{}","virtualTokens":"{}","curveSupply":"{}","graduationTarget":"{}","feeBps":{}}}"#,
        cfg.virtual_inj, cfg.virtual_tokens, cfg.curve_supply, cfg.graduation_target, cfg.fee_bps
    ));

    // Buys from a fresh curve.
    for n in [1u128, 5, 25, 84, 200] {
        let st = CurveState::default();
        let q = quote_buy(&cfg, &st, amt(n)).unwrap();
        let impact = price_impact_bps(&cfg, &st, amt(n)).unwrap();
        rows.push(format!(
            r#"  {{"kind":"buy","from":"fresh","injIn":"{}","fee":"{}","net":"{}","tokensOut":"{}","refund":"{}","graduates":{},"impactBps":{}}}"#,
            amt(n), q.fee, q.inj_in_after_fee, q.tokens_out, q.refund, q.graduates, impact
        ));
    }

    // Buys from a curve already part way along.
    let warm = {
        let mut st = CurveState::default();
        let q = quote_buy(&cfg, &st, amt(40)).unwrap();
        st.inj_collected += q.inj_in_after_fee;
        st.tokens_sold += q.tokens_out;
        st
    };
    rows.push(format!(
        r#"  {{"kind":"state","label":"warm","injCollected":"{}","tokensSold":"{}"}}"#,
        warm.inj_collected, warm.tokens_sold
    ));
    for n in [1u128, 10, 60] {
        let q = quote_buy(&cfg, &warm, amt(n)).unwrap();
        let impact = price_impact_bps(&cfg, &warm, amt(n)).unwrap();
        rows.push(format!(
            r#"  {{"kind":"buy","from":"warm","injIn":"{}","fee":"{}","net":"{}","tokensOut":"{}","refund":"{}","graduates":{},"impactBps":{}}}"#,
            amt(n), q.fee, q.inj_in_after_fee, q.tokens_out, q.refund, q.graduates, impact
        ));
    }

    // Sells back out of the warm state.
    for frac in [1u128, 4, 2] {
        let tokens = warm.tokens_sold / Uint128::new(frac);
        let q = quote_sell(&cfg, &warm, tokens).unwrap();
        rows.push(format!(
            r#"  {{"kind":"sell","from":"warm","tokensIn":"{}","fee":"{}","injOut":"{}"}}"#,
            tokens, q.fee, q.inj_out
        ));
    }

    println!("{}", rows.join(",\n"));
    println!("]");
}
