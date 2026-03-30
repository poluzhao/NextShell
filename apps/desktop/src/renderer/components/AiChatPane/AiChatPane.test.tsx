import { describe, expect, test } from "bun:test";
import type { AiExecutionPlan } from "@nextshell/core";
import { shouldShowPlanCard } from "./AiChatPane";

describe("shouldShowPlanCard", () => {
  test("returns true when there is a pending plan even if execution progress may still exist elsewhere", () => {
    const plan: AiExecutionPlan = {
      summary: "安装或替代 tcpdump",
      steps: [{ step: 1, command: "which tcpdump || which tshark", description: "检查可用抓包工具", risky: false }],
    };

    expect(shouldShowPlanCard(plan)).toBe(true);
  });

  test("returns false when there is no pending plan", () => {
    expect(shouldShowPlanCard(undefined)).toBe(false);
  });
});
