import crypto from "node:crypto";
import type { AiExecutionPlan, CommandExecutionResult } from "@nextshell/core";
import type { AiProgressEvent } from "@nextshell/shared";
import { sanitizeAiOutput, stripAnsi, truncateOutput } from "./output-capture";

export interface AiExecutionCoordinatorDeps {
  execCommand: (
    connectionId: string,
    cmd: string,
    options?: { signal?: AbortSignal; timeoutMs?: number; skipAudit?: boolean }
  ) => Promise<CommandExecutionResult>;
  execInSession?: (
    sessionId: string,
    cmd: string,
    options?: {
      signal?: AbortSignal;
      timeoutMs?: number;
      startupTimeoutMs?: number;
      idleTimeoutMs?: number;
      onOutput?: (output: string) => void;
      onTimeoutPrompt?: (kind: "startup" | "idle" | "runtime") => Promise<"continue" | "abort">;
    }
  ) => Promise<CommandExecutionResult>;
  appendAuditLog: (payload: {
    action: string;
    level: "info" | "warn" | "error";
    connectionId?: string;
    message: string;
    metadata?: Record<string, unknown>;
  }) => void;
  isAbortError: (error: unknown) => boolean;
  startupProbeMs?: number;
}

export interface AiExecutionStepResult {
  step: AiExecutionPlan["steps"][number];
  exitCode: number | null;
  output: string;
  sanitizedOutput: string;
  truncated: ReturnType<typeof truncateOutput>;
  error?: string;
}

export interface ExecuteAiPlanParams {
  conversationId: string;
  connectionId: string;
  sessionId?: string;
  plan: AiExecutionPlan;
  timeoutMs: number;
  startupTimeoutMs?: number;
  idleTimeoutMs?: number;
  signal: AbortSignal;
  ensureNotAborted: () => void;
  onProgress: (event: AiProgressEvent) => void;
  onStepOutputPreview?: (payload: { step: number; command: string; output: string }) => void;
  onTimeoutPrompt?: (payload: { step: number; timeoutKind: "startup" | "idle" | "runtime" }) => Promise<"continue" | "abort">;
  onStepCompleted: (result: AiExecutionStepResult) => void;
}

export interface ExecuteAiPlanResult {
  runId: string;
  status: "completed" | "failed" | "aborted";
  error?: string;
}

interface AiExecutionAuditContext {
  runId: string;
  conversationId: string;
  connectionId: string;
  planSummary: string;
}

interface StepStartupProbe {
  handleOutput: (output: string) => void;
  dispose: () => void;
  getLatestOutput: () => string;
}

const DEFAULT_STARTUP_PROBE_MS = 1500;
const STARTUP_PROBE_OUTPUT_LIMIT = 800;
const STARTUP_FATAL_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  { pattern: /command not found/i, message: "命令不存在，已停止执行，可手动重试" },
  { pattern: /permission denied/i, message: "权限不足，已停止执行，可手动重试" },
  { pattern: /operation not permitted/i, message: "操作被拒绝，已停止执行，可手动重试" },
  { pattern: /no such file or directory/i, message: "目标文件或目录不存在，已停止执行，可手动重试" },
  { pattern: /not a directory/i, message: "目标路径不是目录，已停止执行，可手动重试" },
  { pattern: /session not found/i, message: "终端会话不存在，已停止执行，可手动重试" },
  { pattern: /终端会话已关闭|无法继续执行 AI 命令/, message: "终端会话已关闭，已停止执行，可手动重试" },
];

/** 将字符串安全包裹为 shell 单引号参数 */
const escapeShellArg = (arg: string): string => {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
};

export class AiExecutionCoordinator {
  constructor(private readonly deps: AiExecutionCoordinatorDeps) {}

  async executePlan(params: ExecuteAiPlanParams): Promise<ExecuteAiPlanResult> {
    const auditContext: AiExecutionAuditContext = {
      runId: crypto.randomUUID(),
      conversationId: params.conversationId,
      connectionId: params.connectionId,
      planSummary: params.plan.summary,
    };

    this.appendRunAudit(auditContext, "started", "info", {
      stepCount: params.plan.steps.length,
      executionTimeoutMs: params.timeoutMs,
    });

    try {
      for (const step of params.plan.steps) {
        const stepStartedAt = Date.now();
        const stepSignal = new AbortController();
        const forwardAbort = () => {
          stepSignal.abort(
            params.signal.reason ?? new DOMException("The operation was aborted.", "AbortError")
          );
        };
        if (params.signal.aborted) {
          forwardAbort();
        } else {
          params.signal.addEventListener("abort", forwardAbort, { once: true });
        }
        const startupProbe = params.sessionId
          ? this.createStartupProbe({
              conversationId: params.conversationId,
              stepNumber: step.step,
              onProgress: params.onProgress,
              abortStep: (reason) => {
                if (!stepSignal.signal.aborted) {
                  stepSignal.abort(reason);
                }
              },
            })
          : undefined;

        params.ensureNotAborted();
        this.appendStepAudit(auditContext, step, "started", "info");
        params.onProgress({
          conversationId: params.conversationId,
          type: "step_start",
          step: step.step,
          command: step.command,
          status: "running",
        });
        params.onStepOutputPreview?.({
          step: step.step,
          command: step.command,
          output: "",
        });

        try {
          const result = await this.executeStepCommand(step.command, {
            connectionId: params.connectionId,
            sessionId: params.sessionId,
            signal: stepSignal.signal,
            timeoutMs: params.timeoutMs,
            startupTimeoutMs: params.startupTimeoutMs,
            idleTimeoutMs: params.idleTimeoutMs,
            onOutput: (output) => {
              startupProbe?.handleOutput(output);
              params.onStepOutputPreview?.({
                step: step.step,
                command: step.command,
                output,
              });
            },
            onTimeoutPrompt: params.onTimeoutPrompt
              ? async (kind) => {
                  params.onProgress({
                    conversationId: params.conversationId,
                    type: "timeout_prompt",
                    step: step.step,
                    timeoutKind: kind,
                    status: "running",
                  });
                  return await params.onTimeoutPrompt!({
                    step: step.step,
                    timeoutKind: kind,
                  });
                }
              : undefined,
          });
          startupProbe?.dispose();

          params.ensureNotAborted();
          const executionResult = this.normalizeStepResult(step, result);
          const failedByExitCode = executionResult.exitCode !== 0 && executionResult.exitCode !== null;
          params.onProgress({
            conversationId: params.conversationId,
            type: "step_output",
            step: step.step,
            output: executionResult.output,
            status: failedByExitCode ? "failed" : "success",
          });
          params.onProgress({
            conversationId: params.conversationId,
            type: "step_done",
            step: step.step,
            status: failedByExitCode ? "failed" : "success",
            output: executionResult.output,
          });

          if (failedByExitCode) {
            const errorMsg = `命令退出码 ${executionResult.exitCode}，执行已停止，可手动重试`;
            params.onStepCompleted({
              ...executionResult,
              error: errorMsg,
            });
            this.appendStepAudit(auditContext, step, "failed", "error", {
              exitCode: executionResult.exitCode,
              durationMs: Date.now() - stepStartedAt,
              outputChars: executionResult.output.length,
              outputWasTruncated: executionResult.truncated.wasTruncated,
              error: errorMsg,
            });
            this.appendRunAudit(auditContext, "failed", "error", {
              stepCount: params.plan.steps.length,
              error: errorMsg,
            });
            params.onProgress({
              conversationId: params.conversationId,
              type: "error",
              step: step.step,
              error: errorMsg,
              status: "failed",
            });
            return { runId: auditContext.runId, status: "failed", error: errorMsg };
          }

          params.onStepCompleted(executionResult);
          this.appendStepAudit(auditContext, step, "completed", "info", {
            exitCode: executionResult.exitCode,
            durationMs: Date.now() - stepStartedAt,
            outputChars: executionResult.output.length,
            outputWasTruncated: executionResult.truncated.wasTruncated,
          });
        } catch (error) {
          startupProbe?.dispose();
          if (this.deps.isAbortError(error) || params.signal.aborted) {
            this.appendStepAudit(auditContext, step, "aborted", "warn", {
              durationMs: Date.now() - stepStartedAt,
            });
            this.appendRunAudit(auditContext, "aborted", "warn", {
              stepCount: params.plan.steps.length,
            });
            return { runId: auditContext.runId, status: "aborted" };
          }

          const errorMsg = error instanceof Error ? error.message : String(error);
          params.onStepCompleted(
            this.buildFailedStepResult(step, startupProbe?.getLatestOutput() ?? "", errorMsg)
          );
          this.appendStepAudit(auditContext, step, "failed", "error", {
            durationMs: Date.now() - stepStartedAt,
            error: errorMsg,
          });
          this.appendRunAudit(auditContext, "failed", "error", {
            stepCount: params.plan.steps.length,
            error: errorMsg,
          });
          params.onProgress({
            conversationId: params.conversationId,
            type: "error",
            step: step.step,
            error: errorMsg,
            status: "failed",
          });
          return { runId: auditContext.runId, status: "failed", error: errorMsg };
        } finally {
          params.signal.removeEventListener("abort", forwardAbort);
        }
      }

      this.appendRunAudit(auditContext, "completed", "info", {
        stepCount: params.plan.steps.length,
      });
      return { runId: auditContext.runId, status: "completed" };
    } catch (error) {
      if (this.deps.isAbortError(error) || params.signal.aborted) {
        this.appendRunAudit(auditContext, "aborted", "warn", {
          stepCount: params.plan.steps.length,
        });
        return { runId: auditContext.runId, status: "aborted" };
      }

      const errorMsg = error instanceof Error ? error.message : String(error);
      this.appendRunAudit(auditContext, "failed", "error", {
        stepCount: params.plan.steps.length,
        error: errorMsg,
      });
      return { runId: auditContext.runId, status: "failed", error: errorMsg };
    }
  }

  private normalizeStepResult(
    step: AiExecutionPlan["steps"][number],
    result: CommandExecutionResult
  ): AiExecutionStepResult {
    const stdoutLines = result.stdout.split("\n");
    const EXIT_MARKER = "__NEXTSHELL_EXIT__";
    let markerIdx = -1;
    for (let index = stdoutLines.length - 1; index >= 0; index--) {
      if (stdoutLines[index]!.startsWith(EXIT_MARKER)) {
        markerIdx = index;
        break;
      }
    }

    let exitCode: number | null = null;
    if (markerIdx >= 0) {
      const code = parseInt(stdoutLines[markerIdx]!.slice(EXIT_MARKER.length), 10);
      exitCode = Number.isFinite(code) ? code : null;
      stdoutLines.splice(markerIdx, 1);
    }

    const cleanStdout = stdoutLines.join("\n");
    const cleanStderr = (result.stderr ?? "")
      .split("\n")
      .filter((line) => !line.includes("cannot set terminal process group") && !line.includes("no job control"))
      .join("\n")
      .trim();
    const mergedOutput = cleanStdout + (cleanStderr ? `\n${cleanStderr}` : "");
    const truncated = truncateOutput(mergedOutput);
    const displayOutput = mergedOutput.length > 2000
      ? mergedOutput.slice(0, 1000)
        + `\n... [省略 ${mergedOutput.length - 2000} 字符] ...\n`
        + mergedOutput.slice(-1000)
      : mergedOutput;

    return {
      step,
      exitCode,
      output: displayOutput,
      sanitizedOutput: sanitizeAiOutput(truncated.text),
      truncated,
    };
  }

  private executeHiddenCommand(
    connectionId: string,
    command: string,
    params: Pick<ExecuteAiPlanParams, "signal" | "timeoutMs">
  ): Promise<CommandExecutionResult> {
    const EXIT_MARKER = "__NEXTSHELL_EXIT__";
    const innerCmd = `${command}; echo "${EXIT_MARKER}$?"`;
    const wrappedCmd = `bash -lic ${escapeShellArg(innerCmd)}`;
    return this.deps.execCommand(connectionId, wrappedCmd, {
      signal: params.signal,
      timeoutMs: params.timeoutMs,
      skipAudit: true,
    });
  }

  private async executeStepCommand(
    command: string,
    params: Pick<
      ExecuteAiPlanParams,
      "connectionId" | "sessionId" | "signal" | "timeoutMs" | "startupTimeoutMs" | "idleTimeoutMs"
    > & {
      onOutput?: (output: string) => void;
      onTimeoutPrompt?: (kind: "startup" | "idle" | "runtime") => Promise<"continue" | "abort">;
    }
  ): Promise<CommandExecutionResult> {
    if (!params.sessionId || !this.deps.execInSession) {
      return this.executeHiddenCommand(params.connectionId, command, params);
    }

    try {
      return await this.deps.execInSession(params.sessionId, command, {
        signal: params.signal,
        timeoutMs: params.timeoutMs,
        startupTimeoutMs: params.startupTimeoutMs,
        idleTimeoutMs: params.idleTimeoutMs,
        onOutput: params.onOutput,
        onTimeoutPrompt: params.onTimeoutPrompt,
      });
    } catch (error) {
      if (!this.shouldFallbackToHiddenExecution(error)) {
        throw error;
      }
      return this.executeHiddenCommand(params.connectionId, command, params);
    }
  }

  private createStartupProbe(params: {
    conversationId: string;
    stepNumber: number;
    onProgress: ExecuteAiPlanParams["onProgress"];
    abortStep: (reason: Error) => void;
  }): StepStartupProbe {
    const probeWindowMs = this.deps.startupProbeMs ?? DEFAULT_STARTUP_PROBE_MS;
    let latestOutput = "";
    let emittedRunning = false;
    let settled = false;

    const timerId = setTimeout(() => {
      if (settled || !latestOutput) {
        settled = true;
        return;
      }
      settled = true;
      params.onProgress({
        conversationId: params.conversationId,
        type: "step_probe",
        step: params.stepNumber,
        status: "success",
        output: this.formatProbeOutput(latestOutput),
      });
    }, probeWindowMs);

    return {
      handleOutput: (output) => {
        if (settled) {
          return;
        }
        latestOutput = output;
        const cleaned = stripAnsi(output).trim();
        if (!cleaned) {
          return;
        }

        if (!emittedRunning) {
          emittedRunning = true;
          params.onProgress({
            conversationId: params.conversationId,
            type: "step_probe",
            step: params.stepNumber,
            status: "running",
            output: this.formatProbeOutput(cleaned),
          });
        }

        const fatalMessage = this.detectStartupFatalError(cleaned);
        if (fatalMessage) {
          settled = true;
          clearTimeout(timerId);
          params.abortStep(new Error(fatalMessage));
        }
      },
      dispose: () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timerId);
      },
      getLatestOutput: () => latestOutput,
    };
  }

  private detectStartupFatalError(output: string): string | undefined {
    for (const entry of STARTUP_FATAL_PATTERNS) {
      if (entry.pattern.test(output)) {
        return entry.message;
      }
    }
    return undefined;
  }

  private formatProbeOutput(output: string): string {
    const cleaned = stripAnsi(output).trim();
    if (!cleaned) {
      return "";
    }
    return sanitizeAiOutput(truncateOutput(cleaned, STARTUP_PROBE_OUTPUT_LIMIT).text);
  }

  private buildFailedStepResult(
    step: AiExecutionPlan["steps"][number],
    rawOutput: string,
    error: string
  ): AiExecutionStepResult {
    const cleanedOutput = stripAnsi(rawOutput).trim();
    const mergedOutput = cleanedOutput
      ? cleanedOutput.includes(error)
        ? cleanedOutput
        : `${cleanedOutput}\n${error}`
      : error;
    const truncated = truncateOutput(mergedOutput);
    const displayOutput = mergedOutput.length > 2000
      ? mergedOutput.slice(0, 1000)
        + `\n... [省略 ${mergedOutput.length - 2000} 字符] ...\n`
        + mergedOutput.slice(-1000)
      : mergedOutput;

    return {
      step,
      exitCode: null,
      output: displayOutput,
      sanitizedOutput: sanitizeAiOutput(truncated.text),
      truncated,
      error,
    };
  }

  private shouldFallbackToHiddenExecution(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message === "Session not found" || message === "AI 仅支持在远端终端会话中执行命令";
  }

  private appendRunAudit(
    context: AiExecutionAuditContext,
    phase: "started" | "completed" | "failed" | "aborted",
    level: "info" | "warn" | "error",
    metadata?: Record<string, unknown>
  ): void {
    this.deps.appendAuditLog({
      action: "ai.execution.run",
      level,
      connectionId: context.connectionId,
      message: `AI execution ${phase}`,
      metadata: {
        runId: context.runId,
        conversationId: context.conversationId,
        planSummary: context.planSummary,
        ...metadata,
      },
    });
  }

  private appendStepAudit(
    context: AiExecutionAuditContext,
    step: { step: number; command: string; description: string },
    phase: "started" | "completed" | "failed" | "aborted",
    level: "info" | "warn" | "error",
    metadata?: Record<string, unknown>
  ): void {
    this.deps.appendAuditLog({
      action: "ai.execution.step",
      level,
      connectionId: context.connectionId,
      message: `AI execution step ${phase}`,
      metadata: {
        runId: context.runId,
        conversationId: context.conversationId,
        planSummary: context.planSummary,
        step: step.step,
        command: step.command,
        description: step.description,
        ...metadata,
      },
    });
  }
}
