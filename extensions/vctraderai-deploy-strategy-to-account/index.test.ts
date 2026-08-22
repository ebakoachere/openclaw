import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, {
  DEPLOY_STRATEGY_TO_ACCOUNT_TOOL_NAME,
  runDeployStrategyToAccount,
} from "./index.js";

const WORKSPACE_ID = "11111111-2222-3333-4444-555555555555";

function captureFetch(): {
  fetchImpl: typeof globalThis.fetch;
  request: () => Request | undefined;
} {
  let seen: Request | undefined;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen = new Request(input, init);
    return new Response(JSON.stringify({ staged_action_id: "staged-1" }), { status: 201 });
  }) as typeof globalThis.fetch;
  return { fetchImpl, request: () => seen };
}

describe("vctraderai-deploy-strategy-to-account", () => {
  const originalWorkspace = process.env.PFM_WORKSPACE_ID;
  const originalToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  beforeEach(() => {
    process.env.PFM_WORKSPACE_ID = WORKSPACE_ID;
    process.env.OPENCLAW_GATEWAY_TOKEN = "gateway-token-001";
  });
  afterEach(() => {
    if (originalWorkspace === undefined) {
      delete process.env.PFM_WORKSPACE_ID;
    } else {
      process.env.PFM_WORKSPACE_ID = originalWorkspace;
    }
    if (originalToken === undefined) {
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
    } else {
      process.env.OPENCLAW_GATEWAY_TOKEN = originalToken;
    }
  });

  it("registers deploy_strategy_to_account", () => {
    const captured = createCapturedPluginRegistration({
      id: "vctraderai-deploy-strategy-to-account",
    });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({ name: DEPLOY_STRATEGY_TO_ACCOUNT_TOOL_NAME });
  });

  // ---------------------------------------------------------------------
  // Description truth. Everything below this line asserts what the MODEL is
  // told, not what the code does. The suite was fully green while all three
  // of these sentences were false, because nothing in it had ever read
  // `description` at all: the tests exercised the staging transport and the
  // refusal paths, which were correct, and never the prose the model plans
  // against. A tool that lies is worse than a missing one, so the prose is
  // now pinned like any other contract.
  // ---------------------------------------------------------------------

  function registerAndDescribe(): {
    description: string;
    params: Record<string, { description?: string }>;
  } {
    const captured = createCapturedPluginRegistration({
      id: "vctraderai-deploy-strategy-to-account",
    });
    plugin.register(captured.api);
    // `AnyAgentTool` declares `description` optional, so a cast that demands it
    // does not overlap and TS2352s. Widen to the real shape and default here --
    // an empty description would otherwise pass a `not.toMatch` vacuously, which
    // is the failure mode these guards exist to prevent.
    const tool = captured.tools[0] as {
      description?: string;
      parameters?: { properties?: Record<string, { description?: string }> };
    };
    const description = tool.description ?? "";
    expect(description.length, "the tool registered no description").toBeGreaterThan(40);
    return { description, params: tool.parameters?.properties ?? {} };
  }

  it("does not claim list_current_deployments can detect a duplicate deployment", () => {
    const { description } = registerAndDescribe();
    // WAS FALSE: "Call list_live_accounts_for_deployment and
    // list_current_deployments first so you propose against a real account and
    // do not duplicate a deployment that already exists."
    // The Apply-time duplicate is TargetAlreadyAttachedError, raised from a
    // SELECT over strategy_registry.strategy_deployments keyed on
    // (workspace, strategy, version, target_kind, target_id). Meanwhile
    // list_current_deployments reads live.trader_deployments, whose row shape
    // has NO strategy_id and NO version_id, so it structurally cannot hold the
    // triple the check compares. The model would see an empty result, conclude
    // no duplicate exists, and stage a second deployment that Apply 400s.
    expect(description).not.toMatch(/list_current_deployments/);
    expect(description).not.toMatch(/do not duplicate/i);
    // The honest replacement: there IS no pre-check on this surface.
    expect(description).toMatch(/CANNOT pre-check/i);
    expect(description).toMatch(/already-attached/i);
  });

  it("names the tool and field that actually supply strategy_id and version_id", () => {
    const { description } = registerAndDescribe();
    // list_strategies rows carry strategy_id + current_version_id.
    // get_strategy returns identity and a `source_versions` list that selects
    // version_label/source_kind/entry_function/is_active and NO version_id, so
    // it cannot supply this parameter.
    expect(description).toMatch(/list_strategies/);
    expect(description).toMatch(/current_version_id/);
    // The Apply-side refusals a model would otherwise walk into.
    expect(description).toMatch(/lifecycle_stage is 'live'/);
    expect(description).toMatch(/runtime_tag is 'nautilus'/);
  });

  it("warns that no readable account id is a valid account_id", () => {
    const { params } = registerAndDescribe();
    const accountId = params.account_id?.description ?? "";
    // WAS FALSE: "Target account id. Source it from
    // list_live_accounts_for_deployment."
    // staged_apply.py passes account_id VERBATIM as target_id, and
    // trg_strategy_deployments_polymorphic_fk accepts only a
    // workspace_direct_broker_accounts id or a workspace_phase_links id.
    // list_live_accounts_for_deployment returns live.accounts.live_account_id,
    // an independent gen_random_uuid() space, so following the old sentence
    // staged a T3 live-money card that died inside the Apply transaction AFTER
    // the human's step-up - and the agent could not self-correct, because no
    // tool it can call returns a usable id.
    expect(accountId).not.toMatch(/Source it from list_live_accounts_for_deployment/);
    expect(accountId).toMatch(/workspace_direct_broker_accounts/);
    expect(accountId).toMatch(/workspace_phase_links/);
    expect(accountId).toMatch(/live_account_id/);
    expect(accountId).toMatch(/deploy-targets/);
  });

  it("describes risk_cap_override_pct as recorded, never as enforced", () => {
    const { params } = registerAndDescribe();
    const riskCap = params.risk_cap_override_pct?.description ?? "";
    // WAS FALSE: "Optional per-deployment risk cap override, as a percentage.
    // Omit to inherit the account's configured risk." - which reads as "supply
    // it and the deployment is capped".
    // The value is persisted to strategy_registry.strategy_deployments and
    // echoed in render payloads, and that is all. _GOVERNED_DEPLOYMENTS_SQL
    // (the resolver that arms a deployment) does not select the column, no
    // engine code consumes it, and RiskCapOverrideAboveTemplateMaxError is
    // exported but never raised in product code. The harm was a false safety
    // claim presented to the human at the step-up they rely on.
    expect(riskCap).not.toMatch(/risk cap override/i);
    expect(riskCap).toMatch(/NOT ENFORCED/);
    expect(riskCap).toMatch(/identical whether you set it or omit it/i);
  });

  it("stages through the propose chokepoint and never calls a deploy route", async () => {
    const { fetchImpl, request } = captureFetch();

    await runDeployStrategyToAccount(
      {
        strategy_id: "strat-1",
        version_id: "ver-1",
        account_id: "acct-1",
        deployment_mode: "live",
      },
      { fetchImpl, threadId: "thread-42" },
    );

    const seen = request();
    expect(seen?.method).toBe("POST");
    // The propose chokepoint, NOT a deployment endpoint. If this ever points at
    // a deploy route the tool has stopped being propose-only.
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/openclaw/stage");
    expect(seen?.headers.get("authorization")).toBe("Bearer gateway-token-001");
    expect(seen?.headers.get("x-openclaw-thread")).toBe("thread-42");
  });

  it("stages the exact param keys the apply adapter reads", async () => {
    const { fetchImpl, request } = captureFetch();

    await runDeployStrategyToAccount(
      {
        strategy_id: " strat-1 ",
        version_id: " ver-1 ",
        account_id: " acct-1 ",
        deployment_mode: "confirm",
        risk_cap_override_pct: 2.5,
        idempotency_key: "idem-9",
      },
      { fetchImpl },
    );

    // _build_deploy_strategy_to_account_kwargs reads version_id, NOT
    // strategy_version_id. A rename here applies a deployment with a null version.
    await expect(request()?.json()).resolves.toEqual({
      tool_name: "deploy_strategy_to_account",
      workspace_id: WORKSPACE_ID,
      params: {
        strategy_id: "strat-1",
        version_id: "ver-1",
        account_id: "acct-1",
        deployment_mode: "confirm",
        risk_cap_override_pct: 2.5,
        idempotency_key: "idem-9",
      },
      summary: "Deploy strategy strat-1 version ver-1 to account acct-1 (confirm)",
    });
  });

  it("defaults deployment_mode to paper rather than to live", async () => {
    const { fetchImpl, request } = captureFetch();

    await runDeployStrategyToAccount(
      { strategy_id: "s", version_id: "v", account_id: "a" },
      { fetchImpl },
    );

    const body = (await request()?.json()) as { params: { deployment_mode: string } };
    expect(body.params.deployment_mode).toBe("paper");
  });

  it("tells the caller the proposal is not a deployment", async () => {
    const { fetchImpl } = captureFetch();

    const result = (await runDeployStrategyToAccount(
      { strategy_id: "s", version_id: "v", account_id: "a" },
      { fetchImpl },
    )) as { requires_apply: boolean; confirm_tier: string; message: string };

    expect(result.requires_apply).toBe(true);
    expect(result.confirm_tier).toBe("T3");
    expect(result.message).toMatch(/nothing is deployed/i);
  });

  it.each([
    ["strategy_id", { strategy_id: "  ", version_id: "v", account_id: "a" }],
    ["version_id", { strategy_id: "s", version_id: "", account_id: "a" }],
    ["account_id", { strategy_id: "s", version_id: "v", account_id: "   " }],
  ])("refuses a blank %s before opening a request", async (field, params) => {
    const fetchImpl = (async () => {
      throw new Error("must not be called");
    }) as typeof globalThis.fetch;

    await expect(
      runDeployStrategyToAccount(params as Parameters<typeof runDeployStrategyToAccount>[0], {
        fetchImpl,
      }),
    ).rejects.toThrow(field);
  });

  it("refuses an unknown deployment_mode instead of silently using paper", async () => {
    const fetchImpl = (async () => {
      throw new Error("must not be called");
    }) as typeof globalThis.fetch;

    await expect(
      runDeployStrategyToAccount(
        {
          strategy_id: "s",
          version_id: "v",
          account_id: "a",
          deployment_mode: "yolo" as never,
        },
        { fetchImpl },
      ),
    ).rejects.toThrow("deployment_mode");
  });

  it.each([0, -1, 101, Number.NaN])(
    "refuses an out-of-range risk_cap_override_pct: %s",
    async (cap) => {
      const fetchImpl = (async () => {
        throw new Error("must not be called");
      }) as typeof globalThis.fetch;

      await expect(
        runDeployStrategyToAccount(
          { strategy_id: "s", version_id: "v", account_id: "a", risk_cap_override_pct: cap },
          { fetchImpl },
        ),
      ).rejects.toThrow("risk_cap_override_pct");
    },
  );

  it("omits optional keys entirely rather than staging explicit nulls", async () => {
    const { fetchImpl, request } = captureFetch();

    await runDeployStrategyToAccount(
      { strategy_id: "s", version_id: "v", account_id: "a" },
      { fetchImpl },
    );

    const body = (await request()?.json()) as { params: Record<string, unknown> };
    expect(Object.keys(body.params).toSorted()).toEqual([
      "account_id",
      "deployment_mode",
      "strategy_id",
      "version_id",
    ]);
  });
});
