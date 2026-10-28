//! Parity vectors for the Solidity PoolMath and EarlyFee ports.
use cosmwasm_std::Uint128;
use launchpad_math::{pool_quote_buy, pool_quote_sell, PoolReserves};
fn u(v: u128) -> Uint128 { Uint128::new(v) }

fn main() {
    const ONE: u128 = 1_000_000_000_000_000_000;
    let mut buys = Vec::new();
    let mut sells = Vec::new();

    // A pool seeded as graduation seeds one: the collected quote against lp_reserve.
    for (q, t) in [(85u128, 273_000_000u128), (1, 1_000), (1_000, 5_000_000)] {
        for fee_bps in [0u16, 30, 100, 1_000] {
            for amt in [1u128, 1_000, ONE / 1_000, ONE, 10 * ONE] {
                let p = PoolReserves { quote: u(q * ONE), tokens: u(t * ONE) };
                match pool_quote_buy(&p, fee_bps, u(amt)) {
                    Ok(r) => buys.push(format!(
                        r#"{{"q":"{}","t":"{}","fee_bps":{fee_bps},"amt":"{amt}","ok":true,"fee":"{}","net":"{}","out":"{}"}}"#,
                        q*ONE, t*ONE, r.fee, r.quote_in_after_fee, r.tokens_out)),
                    Err(_) => buys.push(format!(
                        r#"{{"q":"{}","t":"{}","fee_bps":{fee_bps},"amt":"{amt}","ok":false}}"#, q*ONE, t*ONE)),
                }
                match pool_quote_sell(&p, fee_bps, u(amt)) {
                    Ok(r) => sells.push(format!(
                        r#"{{"q":"{}","t":"{}","fee_bps":{fee_bps},"amt":"{amt}","ok":true,"fee":"{}","out":"{}"}}"#,
                        q*ONE, t*ONE, r.fee, r.inj_out)),
                    Err(_) => sells.push(format!(
                        r#"{{"q":"{}","t":"{}","fee_bps":{fee_bps},"amt":"{amt}","ok":false}}"#, q*ONE, t*ONE)),
                }
            }
        }
    }
    println!(r#"{{"buys":[{}],"sells":[{}]}}"#, buys.join(","), sells.join(","));
}
