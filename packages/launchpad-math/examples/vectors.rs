//! Emit parity vectors for the Solidity port.
//!
//!   cargo run -p launchpad-math --example vectors > evm/test/vectors.json
//!
//! THE RUST IS THE SPEC, so the EVM port is checked against values this produces
//! rather than against expectations written alongside the Solidity. A port verified
//! only against its own author's arithmetic restates the author's misunderstanding.
//!
//! The grid is chosen to hit the branches that matter: the partial fill that empties
//! the curve, fees at zero and at the cap, a sell larger than the collected balance,
//! and amounts small enough that a rounding direction decides the answer.
use cosmwasm_std::Uint128;
use launchpad_math::{quote_buy, quote_sell, CurveConfig, CurveState};

fn u(v: u128) -> Uint128 {
    Uint128::new(v)
}

fn main() {
    const ONE: u128 = 1_000_000_000_000_000_000;

    // THE SHAPE A REAL LAUNCH USES, taken from the Rust's own tests rather than
    // invented. A guessed config fails `validate` with UnreachableGraduation and
    // every vector comes back as an error, which looks like a working generator
    // producing an empty corpus.
    let base = CurveConfig {
        virtual_inj: u(30 * ONE),
        virtual_tokens: u(1_073_000_000 * ONE),
        curve_supply: u(800_000_000 * ONE),
        graduation_target: u(85 * ONE),
        fee_bps: 100,
    };

    let mut out = Vec::new();

    for fee_bps in [0u16, 100, 1_000] {
        // Near curve_supply on purpose: that is the partial-fill branch.
        for sold in [0u128, 1_000 * ONE, 400_000_000 * ONE, 799_999_000 * ONE] {
            for collected in [0u128, ONE, 80 * ONE] {
                for inj_in in [1u128, 1_000, ONE / 1_000, ONE, 50 * ONE, 10_000 * ONE] {
                    let cfg = CurveConfig { fee_bps, ..base.clone() };
                    let st = CurveState {
                        inj_collected: u(collected),
                        tokens_sold: u(sold),
                        graduated: false,
                    };
                    let r = match quote_buy(&cfg, &st, u(inj_in)) {
                        Ok(q) => format!(
                            r#"{{"kind":"buy","fee_bps":{fee_bps},"sold":"{sold}","collected":"{collected}","amount":"{inj_in}","ok":true,"fee":"{}","net":"{}","out":"{}","refund":"{}","graduates":{}}}"#,
                            q.fee, q.inj_in_after_fee, q.tokens_out, q.refund, q.graduates
                        ),
                        Err(_) => format!(
                            r#"{{"kind":"buy","fee_bps":{fee_bps},"sold":"{sold}","collected":"{collected}","amount":"{inj_in}","ok":false}}"#
                        ),
                    };
                    out.push(r);
                }

                for tokens_in in [1u128, 1_000, ONE, 1_000 * ONE] {
                    let cfg = CurveConfig { fee_bps, ..base.clone() };
                    let st = CurveState {
                        inj_collected: u(collected),
                        tokens_sold: u(sold),
                        graduated: false,
                    };
                    let r = match quote_sell(&cfg, &st, u(tokens_in)) {
                        Ok(q) => format!(
                            r#"{{"kind":"sell","fee_bps":{fee_bps},"sold":"{sold}","collected":"{collected}","amount":"{tokens_in}","ok":true,"fee":"{}","out":"{}"}}"#,
                            q.fee, q.inj_out
                        ),
                        Err(_) => format!(
                            r#"{{"kind":"sell","fee_bps":{fee_bps},"sold":"{sold}","collected":"{collected}","amount":"{tokens_in}","ok":false}}"#
                        ),
                    };
                    out.push(r);
                }
            }
        }
    }

    println!("[\n  {}\n]", out.join(",\n  "));
}
