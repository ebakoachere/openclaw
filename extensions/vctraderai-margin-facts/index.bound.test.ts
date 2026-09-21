import { describe, expect, it } from "vitest";
import { PLATFORM_MARGIN_ROUND_TRIP_MS, VCTRADERAI_MARGIN_FACTS_BOUND_MS } from "./index.js";

/**
 * P3e — the plugin's abort bound must stay ABOVE the platform's ceiling.
 *
 * THE FAILURE THIS PREVENTS IS NOT A TIMEOUT, IT IS A TIMEOUT WITH NOTHING TO
 * SAY. The platform bounds the terminal round trip at 25 s and REPORTS that it
 * waited; if this plugin aborts first, the platform's answer is discarded in
 * flight and the trader gets a failure with no duration attached and no
 * explanation the agent can pass on.
 *
 * P3d raised the platform bound 20 -> 25 and left 5 s of headroom against the
 * plugin's 30 s. Nothing in either repository asserted the ordering, so the
 * next lift on either side would have inverted it silently. That is what this
 * file exists for: the numbers are NAMED, in both directions, on both sides.
 *
 * The platform half of this pair lives in propfirm_manager at
 * `tests/openclaw/test_p3e_plugin_bound_exceeds_platform.py`, which reads
 * `_MARGIN_ROUND_TRIP_SECONDS` from `web_api/risk_tools/service.py` and
 * asserts the same inequality. Two repositories, one invariant, and neither
 * can move alone without something going red.
 */
describe("P3e: the plugin bound outlives the platform bound", () => {
  it("aborts strictly later than the platform's own ceiling", () => {
    expect(VCTRADERAI_MARGIN_FACTS_BOUND_MS).toBeGreaterThan(PLATFORM_MARGIN_ROUND_TRIP_MS);
  });

  it("keeps a margin worth having, not a rounding error", () => {
    // 5 s was what P3d left and it was not enough to notice an inversion
    // coming. 10 s is the headroom this change restores; a future lift that
    // eats it should have to say so here.
    const headroomMs = VCTRADERAI_MARGIN_FACTS_BOUND_MS - PLATFORM_MARGIN_ROUND_TRIP_MS;
    expect(headroomMs).toBeGreaterThanOrEqual(10_000);
  });

  it("pins both numbers, so a silent edit to either is a failing test", () => {
    // Asserted as literals ON PURPOSE. A test that only compared the two
    // constants would still pass if BOTH were changed together by someone who
    // had not read why the ordering matters -- which is exactly how P3d's
    // headroom halved without anyone noticing.
    expect(VCTRADERAI_MARGIN_FACTS_BOUND_MS).toBe(35_000);
    expect(PLATFORM_MARGIN_ROUND_TRIP_MS).toBe(25_000);
  });
});
