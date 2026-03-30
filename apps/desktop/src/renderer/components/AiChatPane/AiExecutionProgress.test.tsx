import React from "react";
import { describe, expect, test } from "bun:test";
import { Button } from "antd";
import type { MouseEventHandler, ReactElement, ReactNode } from "react";
import { AiExecutionProgressCard } from "./AiExecutionProgress";

const collectText = (node: ReactNode): string => {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (!node || typeof node === "boolean") {
    return "";
  }
  if (Array.isArray(node)) {
    return node.map((item) => collectText(item)).join("");
  }
  if (React.isValidElement(node)) {
    return collectText((node.props as { children?: ReactNode }).children);
  }
  return "";
};

const findElements = (
  node: ReactNode,
  predicate: (element: ReactElement<Record<string, unknown>>) => boolean
): Array<ReactElement<Record<string, unknown>>> => {
  const matches: Array<ReactElement<Record<string, unknown>>> = [];

  const visit = (current: ReactNode): void => {
    if (!React.isValidElement(current)) {
      if (Array.isArray(current)) {
        current.forEach(visit);
      }
      return;
    }

    if (predicate(current as ReactElement<Record<string, unknown>>)) {
      matches.push(current as ReactElement<Record<string, unknown>>);
    }

    React.Children.forEach((current.props as { children?: ReactNode }).children, visit);
  };

  visit(node);
  return matches;
};

describe("AiExecutionProgressCard", () => {
  test("shows failed header and exposes resume actions", () => {
    let retried = false;
    let edited = false;

    const element = AiExecutionProgressCard({
      progress: {
        planSummary: "排查磁盘",
        steps: [
          { step: 1, status: "success", output: "ok" },
          { step: 2, status: "failed", error: "权限不足" },
          { step: 3, status: "pending" },
        ],
        currentStep: 2,
        completed: true,
      },
      retrySourceStep: 2,
      canResume: true,
      onRetry: () => {
        retried = true;
      },
      onEditRetryPlan: () => {
        edited = true;
      },
    });

    expect(collectText(element)).toContain("执行失败");
    expect(collectText(element)).toContain("重试步骤 2 及后续");
    expect(collectText(element)).toContain("编辑后重试");

    const buttons = findElements(
      element,
      (current) => current.type === Button
    );

    expect(buttons).toHaveLength(2);

    (buttons[0]?.props.onClick as MouseEventHandler<HTMLButtonElement> | undefined)?.({} as never);
    (buttons[1]?.props.onClick as MouseEventHandler<HTMLButtonElement> | undefined)?.({} as never);

    expect(retried).toBe(true);
    expect(edited).toBe(true);
  });

  test("does not render resume actions for successful completion", () => {
    const element = AiExecutionProgressCard({
      progress: {
        planSummary: "排查磁盘",
        steps: [{ step: 1, status: "success", output: "ok" }],
        currentStep: 1,
        completed: true,
      },
      canResume: false,
    });

    expect(collectText(element)).toContain("执行完成");
    expect(collectText(element)).not.toContain("编辑后继续");
    expect(
      findElements(element, (current) => current.type === Button)
    ).toHaveLength(0);
  });

  test("shows timeout decision actions and triggers callbacks", () => {
    let analyzed = false;
    let continued = false;
    let stopped = false;

    const element = AiExecutionProgressCard({
      progress: {
        planSummary: "启动服务",
        steps: [{ step: 1, status: "running", output: "starting..." }],
        currentStep: 1,
        completed: false,
      },
      phase: "collecting",
      timeoutPromptStep: 1,
      timeoutPromptKind: "idle",
      onAnalyzeCurrentOutput: () => {
        analyzed = true;
      },
      onContinueWaiting: () => {
        continued = true;
      },
      onStopWaiting: () => {
        stopped = true;
      },
    });

    expect(collectText(element)).toContain("长时间无新输出");
    expect(collectText(element)).toContain("分析当前输出");
    expect(collectText(element)).toContain("继续等待");
    expect(collectText(element)).toContain("终止执行");

    const buttons = findElements(
      element,
      (current) => current.type === Button
    );

    expect(buttons).toHaveLength(3);

    (buttons[0]?.props.onClick as MouseEventHandler<HTMLButtonElement> | undefined)?.({} as never);
    (buttons[1]?.props.onClick as MouseEventHandler<HTMLButtonElement> | undefined)?.({} as never);
    (buttons[2]?.props.onClick as MouseEventHandler<HTMLButtonElement> | undefined)?.({} as never);

    expect(analyzed).toBe(true);
    expect(continued).toBe(true);
    expect(stopped).toBe(true);
  });

  test("shows runtime timeout copy", () => {
    const element = AiExecutionProgressCard({
      progress: {
        planSummary: "长任务",
        steps: [{ step: 1, status: "running", output: "working..." }],
        currentStep: 1,
        completed: false,
      },
      timeoutPromptStep: 1,
      timeoutPromptKind: "runtime",
      onContinueWaiting: () => undefined,
    });

    expect(collectText(element)).toContain("执行时间过长");
    expect(collectText(element)).toContain("继续等待");
  });
});
