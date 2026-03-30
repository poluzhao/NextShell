import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, mock, test } from "bun:test";
import {
  DEFAULT_APP_PREFERENCES,
  type AiConversation,
  type CommandExecutionResult,
  type AppPreferences,
} from "../../../../../../packages/core/src/index";

const { AiService } = await import("./ai-service");
const { AiExecutionCoordinator } = await import("./ai-execution-coordinator");
const { SessionService } = await import("../session-service");

const createPreferences = (enabled = false, persistHistory = true): AppPreferences => ({
  ...DEFAULT_APP_PREFERENCES,
  transfer: { ...DEFAULT_APP_PREFERENCES.transfer },
  remoteEdit: { ...DEFAULT_APP_PREFERENCES.remoteEdit },
  commandCenter: { ...DEFAULT_APP_PREFERENCES.commandCenter },
  terminal: {
    ...DEFAULT_APP_PREFERENCES.terminal,
    localShell: { ...DEFAULT_APP_PREFERENCES.terminal.localShell },
  },
  ssh: { ...DEFAULT_APP_PREFERENCES.ssh },
  backup: { ...DEFAULT_APP_PREFERENCES.backup },
  window: { ...DEFAULT_APP_PREFERENCES.window },
  traceroute: { ...DEFAULT_APP_PREFERENCES.traceroute },
  audit: { ...DEFAULT_APP_PREFERENCES.audit },
  ai: {
    enabled,
    persistHistory,
    activeProviderId: enabled ? "provider-1" : undefined,
    providers: enabled
      ? [{
          id: "provider-1",
          type: "openai",
          name: "test-provider",
          baseUrl: "https://example.com/v1",
          model: "gpt-test",
          apiKeyRef: "secret://ai-provider-provider-1",
          enabled: true,
        }]
      : [],
    systemPromptOverride: undefined,
    executionTimeoutSec: 1,
    providerRequestTimeoutSec: 9,
    providerMaxRetries: 2,
  },
});

const createConversation = (): AiConversation => ({
  id: "conv-1",
  title: "test",
  messages: [],
  sessionId: "session-1",
  connectionId: "connection-1",
  createdAt: "2026-03-17T00:00:00.000Z",
  updatedAt: "2026-03-17T00:00:00.000Z",
});

const createDataDir = (): string => {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nextshell-ai-service-"));
};

const createSender = (id: number) => {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  return {
    id,
    sent,
    send: (channel: string, payload: unknown) => {
      sent.push({ channel, payload });
    },
    isDestroyed: () => false,
  };
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const decodeShellBytes = (encoded: string): string => {
  return encoded.replace(/\\([0-7]{3})/g, (_match, octal: string) => {
    return String.fromCharCode(Number.parseInt(octal, 8));
  });
};

const extractSessionExecMarkers = (wrappedCommand: string): {
  startSentinel: string;
  endPrefix: string;
  endSuffix: string;
} => {
  const match = wrappedCommand.match(/printf '%b' '([^']+)';.*printf '%b%s%b' '([^']+)' "\$__ns_ai_exit" '([^']+)'/);
  if (!match) {
    throw new Error(`无法从包装命令中提取哨兵：${wrappedCommand}`);
  }
  return {
    startSentinel: decodeShellBytes(match[1]!),
    endPrefix: decodeShellBytes(match[2]!),
    endSuffix: decodeShellBytes(match[3]!),
  };
};

const createSessionServiceForTest = () => {
  const activeSessions = new Map();
  const service = new SessionService({
    connections: {} as never,
    activeSessions: activeSessions as never,
    getConnectionOrThrow: () => ({}) as never,
    ensureConnection: async () => {
      throw new Error("not used");
    },
    closeConnectionIfIdle: async () => undefined,
    appendAuditLogIfEnabled: () => undefined,
    sendSessionStatus: () => undefined,
    sessionDataDispatcher: { push: () => undefined } as never,
    systemMonitorDispatcher: { ack: () => undefined, clear: () => undefined } as never,
    processMonitorDispatcher: { ack: () => undefined, clear: () => undefined } as never,
    networkMonitorDispatcher: { ack: () => undefined, clear: () => undefined } as never,
    ensureSystemMonitorRuntime: async () => ({}) as never,
    warmupSftp: async () => undefined,
    persistAuthOverride: async () => undefined,
  });

  return { service, activeSessions };
};

const createCommandResult = (command: string, stdout = "", exitCode = 0) => ({
  connectionId: "connection-1",
  command,
  stdout,
  stderr: "",
  exitCode,
  executedAt: "2026-03-17T00:00:00.000Z",
});

const createService = (overrides: Partial<ConstructorParameters<typeof AiService>[0]> = {}) => {
  const dataDir = overrides.dataDir ?? createDataDir();
  const execCommand = overrides.execCommand ?? (async (_connectionId: string, cmd: string) => createCommandResult(cmd));
  return new AiService({
    execCommand,
    execInSession: overrides.execInSession ?? (async (_sessionId: string, cmd: string, options) => execCommand("connection-1", cmd, options)),
    vault: overrides.vault ?? ({
      readCredential: async () => undefined,
      storeCredential: async () => "secret://ignored",
      deleteCredential: async () => undefined,
    } as never),
    getPreferences: overrides.getPreferences ?? (() => createPreferences(false)),
    dataDir,
    saveTextFile: overrides.saveTextFile ?? (async (_sender, input) => {
      const filePath = path.join(dataDir, input.defaultPath);
      fs.writeFileSync(filePath, input.content, "utf-8");
      return { ok: true as const, filePath };
    }),
    appendAuditLog: overrides.appendAuditLog ?? (() => undefined),
  });
};

describe("AiService.executePlan", () => {
  test("executes each step exactly once and sanitizes analysis input", async () => {
    const executedCommands: string[] = [];
    const sender = createSender(1);
    const service = createService({
      execCommand: async (_connectionId, cmd) => {
        executedCommands.push(cmd);
        return createCommandResult(cmd, "__NEXTSHELL_EXIT__0\nOPENAI_API_KEY=sk-test-abcdef123456");
      },
    });

    const conversation = createConversation();
    await (service as unknown as {
      executePlan: (
        sender: ReturnType<typeof createSender>,
        conv: AiConversation,
        plan: { steps: Array<{ step: number; command: string; description: string; risky: boolean }>; summary: string },
        connectionId: string
      ) => Promise<void>;
    }).executePlan(
      sender,
      conversation,
      {
        summary: "run one command",
        steps: [{ step: 1, command: "echo test", description: "test", risky: false }],
      },
      "connection-1"
    );

    expect(executedCommands).toHaveLength(1);
    expect(conversation.messages).toHaveLength(1);
    expect(conversation.messages[0]?.type).toBe("execution_result");
    expect(conversation.messages[0]?.content).not.toContain("sk-test-abcdef123456");
    expect(conversation.messages[0]?.content).toContain("OPENAI_API_KEY=");
  });

  test("stops at failed step when command exits with non-zero code and emits retryable error progress", async () => {
    const executedCommands: string[] = [];
    const sender = createSender(1);
    const service = createService({
      execCommand: async (_connectionId, cmd) => {
        executedCommands.push(cmd);
        if (executedCommands.length === 1) {
          return createCommandResult(cmd, "__NEXTSHELL_EXIT__2\npermission denied", 2);
        }
        return createCommandResult(cmd, "__NEXTSHELL_EXIT__0\nok");
      },
    });

    const conversation = createConversation();
    await (service as unknown as {
      executePlan: (
        sender: ReturnType<typeof createSender>,
        conv: AiConversation,
        plan: { steps: Array<{ step: number; command: string; description: string; risky: boolean }>; summary: string },
        connectionId: string
      ) => Promise<void>;
    }).executePlan(
      sender,
      conversation,
      {
        summary: "two steps",
        steps: [
          { step: 1, command: "sudo cat /root/secret", description: "读取受限文件", risky: true },
          { step: 2, command: "echo should-not-run", description: "不应继续执行", risky: false },
        ],
      },
      "connection-1"
    );

    expect(executedCommands).toHaveLength(1);

    const progressPayloads = sender.sent
      .map((entry) => entry.payload)
      .filter((payload): payload is { type?: string; step?: number; error?: string } => (
        typeof payload === "object" && payload !== null && "type" in payload
      ));

    expect(progressPayloads.some((payload) => payload.type === "error" && payload.step === 1)).toBe(true);
    expect(progressPayloads.some((payload) => payload.type === "all_done")).toBe(false);
  });

  test("stops remaining steps after abort is requested", async () => {
    let execCount = 0;
    let releaseFirstStep: (() => void) | undefined;
    const sender = createSender(1);
    const service = createService({
      execCommand: async (_connectionId, _cmd, options) => {
        execCount += 1;
        return await new Promise((resolve, reject) => {
          const onAbort = () => {
            reject(options?.signal?.reason ?? new Error("aborted"));
          };
          options?.signal?.addEventListener("abort", onAbort, { once: true });
          releaseFirstStep = () => {
            options?.signal?.removeEventListener("abort", onAbort);
            resolve(createCommandResult("echo step", "__NEXTSHELL_EXIT__0\nok"));
          };
        });
      },
    });

    const conversation = createConversation();
    conversation.ownerClientId = "client-1";
    (service as unknown as { conversations: Map<string, AiConversation> }).conversations.set("conv-1", conversation);
    const running = (service as unknown as {
      executePlan: (
        sender: ReturnType<typeof createSender>,
        conv: AiConversation,
        plan: { steps: Array<{ step: number; command: string; description: string; risky: boolean }>; summary: string },
        connectionId: string
      ) => Promise<void>;
    }).executePlan(
      sender,
      conversation,
      {
        summary: "two steps",
        steps: [
          { step: 1, command: "sleep 10", description: "wait", risky: false },
          { step: 2, command: "echo done", description: "done", risky: false },
        ],
      },
      "connection-1"
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    service.abort(sender as never, { conversationId: "conv-1", clientId: "client-1" });
    releaseFirstStep?.();
    await running;

    expect(execCount).toBe(1);
  });

  test("still asks AI to analyze failed command output while keeping retry context", async () => {
    const sender = createSender(1);
    const service = createService({
      vault: {
        readCredential: async () => "sk-test",
        storeCredential: async () => "secret://ignored",
        deleteCredential: async () => undefined,
      } as never,
      getPreferences: () => createPreferences(true),
      execInSession: async (_sessionId, _cmd, options) => {
        return await new Promise<CommandExecutionResult>((resolve, reject) => {
          const onAbort = () => {
            reject(options?.signal?.reason ?? new Error("aborted"));
          };
          options?.signal?.addEventListener("abort", onAbort, { once: true });
          options?.onOutput?.("bash: tcpdump: command not found\n");
          setTimeout(() => resolve(createCommandResult("tcpdump -i any", "__NEXTSHELL_EXIT__127\n")), 50);
        });
      },
    });

    const streamChat = mock(async (_messages, onToken) => {
      onToken("tcpdump ");
      onToken("未安装");
      return "分析结果：目标机器未安装 tcpdump，建议先检查是否存在等价抓包工具，或生成安装/替代方案计划。";
    });
    (service as unknown as { router: { getAdapter: () => { streamChat: typeof streamChat } } }).router.getAdapter = () => ({
      streamChat,
    });

    const conversation = createConversation();
    await (service as unknown as {
      executePlan: (
        sender: ReturnType<typeof createSender>,
        conv: AiConversation,
        plan: { steps: Array<{ step: number; command: string; description: string; risky: boolean }>; summary: string },
        connectionId: string
      ) => Promise<void>;
    }).executePlan(
      sender,
      conversation,
      {
        summary: "抓包排查",
        steps: [{ step: 1, command: "tcpdump -i any", description: "抓包", risky: true }],
      },
      "connection-1"
    );

    expect(conversation.messages.some((msg) => msg.type === "execution_result" && msg.content.includes("tcpdump"))).toBe(true);
    expect(conversation.messages.at(-1)?.type).toBe("assistant_reply");
    expect(conversation.messages.at(-1)?.content).toContain("未安装 tcpdump");

    const allDonePayload = sender.sent.find((entry) => (entry.payload as { type?: string })?.type === "all_done");
    expect(allDonePayload).toBe(undefined);
    const preservedDonePayload = sender.sent.find((entry) => (
      (entry.payload as { type?: string; preserveExecutionState?: boolean })?.type === "done"
      && (entry.payload as { preserveExecutionState?: boolean }).preserveExecutionState === true
    ));
    expect(Boolean(preservedDonePayload)).toBe(true);
  });
});

describe("AiExecutionCoordinator startup probe", () => {
  test("emits probing progress before a long-running session command finishes", async () => {
    const progressEvents: Array<{ type: string; status?: string; output?: string }> = [];
    let resolveCommand: ((value: CommandExecutionResult) => void) | undefined;

    const coordinator = new AiExecutionCoordinator({
      execCommand: async () => createCommandResult("echo fallback", "__NEXTSHELL_EXIT__0\nok"),
      execInSession: async (_sessionId, _command, options) => {
        options?.onOutput?.("starting service...\n");
        await new Promise((resolve) => setTimeout(resolve, 5));
        options?.onOutput?.("starting service...\nlistening on 0.0.0.0:8080\n");
        return await new Promise<CommandExecutionResult>((resolve) => {
          resolveCommand = resolve;
        });
      },
      appendAuditLog: () => undefined,
      isAbortError: () => false,
      startupProbeMs: 10,
    });

    const running = coordinator.executePlan({
      conversationId: "conv-1",
      connectionId: "connection-1",
      sessionId: "session-1",
      plan: {
        summary: "start service",
        steps: [{ step: 1, command: "npm run dev", description: "启动服务", risky: false }],
      },
      timeoutMs: 500,
      signal: new AbortController().signal,
      ensureNotAborted: () => undefined,
      onProgress: (event) => {
        progressEvents.push({
          type: event.type,
          status: event.status,
          output: event.output,
        });
      },
      onStepCompleted: () => undefined,
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    resolveCommand?.(createCommandResult("npm run dev", "__NEXTSHELL_EXIT__0\nserver ready\n"));
    const result = await running;

    expect(result.status).toBe("completed");
    expect(progressEvents.some((event) => event.type === "step_probe" && event.status === "running")).toBe(true);
    expect(progressEvents.some((event) => event.type === "step_probe" && event.status === "success")).toBe(true);
  });

  test("aborts early when probing output shows a fatal startup error", async () => {
    const progressEvents: Array<{ type: string; status?: string; error?: string }> = [];

    const coordinator = new AiExecutionCoordinator({
      execCommand: async () => createCommandResult("echo fallback", "__NEXTSHELL_EXIT__0\nok"),
      execInSession: async (_sessionId, _command, options) => {
        return await new Promise<CommandExecutionResult>((resolve, reject) => {
          const onAbort = () => {
            reject(options?.signal?.reason ?? new Error("aborted"));
          };
          options?.signal?.addEventListener("abort", onAbort, { once: true });
          options?.onOutput?.("bash: deploy-tool: command not found\n");
          setTimeout(() => resolve(createCommandResult("deploy-tool", "__NEXTSHELL_EXIT__127\n")), 100);
        });
      },
      appendAuditLog: () => undefined,
      isAbortError: () => false,
      startupProbeMs: 20,
    });

    const result = await coordinator.executePlan({
      conversationId: "conv-1",
      connectionId: "connection-1",
      sessionId: "session-1",
      plan: {
        summary: "run deploy",
        steps: [{ step: 1, command: "deploy-tool", description: "发布", risky: true }],
      },
      timeoutMs: 500,
      signal: new AbortController().signal,
      ensureNotAborted: () => undefined,
      onProgress: (event) => {
        progressEvents.push({
          type: event.type,
          status: event.status,
          error: event.error,
        });
      },
      onStepCompleted: () => undefined,
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("命令不存在");
    expect(progressEvents.some((event) => event.type === "error" && event.error?.includes("命令不存在"))).toBe(true);
  });
});

describe("SessionService AI execution timeouts", () => {
  test("does not interrupt a long-running command while output keeps arriving", async () => {
    const { service, activeSessions } = createSessionServiceForTest();
    let wrappedCommand = "";

    activeSessions.set("session-1", {
      kind: "remote",
      descriptor: {
        id: "session-1",
        target: "ssh",
        connectionId: "connection-1",
        title: "test",
        status: "connected",
        type: "shell",
        createdAt: "2026-03-19T00:00:00.000Z",
        reconnectable: true,
      },
      channel: {
        write: (data: string | Buffer) => {
          wrappedCommand = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
        },
      },
      sender: createSender(99),
      connectionId: "connection-1",
      terminalEncoding: "utf-8",
      backspaceMode: "auto",
      deleteMode: "auto",
    } as never);

    const running = service.execCommandInSession("session-1", "long-running", {
      startupTimeoutMs: 20,
      idleTimeoutMs: 40,
    });

    await delay(0);
    const { startSentinel, endPrefix, endSuffix } = extractSessionExecMarkers(wrappedCommand);

    (service as unknown as { emitSessionOutput: (sessionId: string, chunk: string) => void })
      .emitSessionOutput("session-1", `${startSentinel}starting...\n`);
    await delay(20);
    (service as unknown as { emitSessionOutput: (sessionId: string, chunk: string) => void })
      .emitSessionOutput("session-1", "still running...\n");
    await delay(20);
    (service as unknown as { emitSessionOutput: (sessionId: string, chunk: string) => void })
      .emitSessionOutput("session-1", "progress update...\n");
    await delay(20);
    (service as unknown as { emitSessionOutput: (sessionId: string, chunk: string) => void })
      .emitSessionOutput("session-1", `done\n${endPrefix}0${endSuffix}`);

    const result = await running;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("progress update");
  });

  test("prompts on startup timeout and continues waiting when user chooses continue", async () => {
    const { service, activeSessions } = createSessionServiceForTest();
    let wrappedCommand = "";
    const timeoutPrompts: Array<"startup" | "idle" | "runtime"> = [];

    activeSessions.set("session-1", {
      kind: "remote",
      descriptor: {
        id: "session-1",
        target: "ssh",
        connectionId: "connection-1",
        title: "test",
        status: "connected",
        type: "shell",
        createdAt: "2026-03-19T00:00:00.000Z",
        reconnectable: true,
      },
      channel: {
        write: (data: string | Buffer) => {
          wrappedCommand = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
        },
      },
      sender: createSender(99),
      connectionId: "connection-1",
      terminalEncoding: "utf-8",
      backspaceMode: "auto",
      deleteMode: "auto",
    } as never);

    const running = service.execCommandInSession("session-1", "slow-start", {
      startupTimeoutMs: 20,
      idleTimeoutMs: 40,
      onTimeoutPrompt: async (kind) => {
        timeoutPrompts.push(kind);
        return "continue";
      },
    });

    await delay(0);
    const { startSentinel, endPrefix, endSuffix } = extractSessionExecMarkers(wrappedCommand);

    await delay(25);
    (service as unknown as { emitSessionOutput: (sessionId: string, chunk: string) => void })
      .emitSessionOutput("session-1", `${startSentinel}starting...\n`);
    await delay(10);
    (service as unknown as { emitSessionOutput: (sessionId: string, chunk: string) => void })
      .emitSessionOutput("session-1", `ready\n${endPrefix}0${endSuffix}`);

    const result = await running;
    expect(timeoutPrompts).toEqual(["startup"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("starting...");
  });

  test("does not emit duplicate startup timeout prompts while waiting for decision", async () => {
    const { service, activeSessions } = createSessionServiceForTest();
    let wrappedCommand = "";
    const timeoutPrompts: Array<"startup" | "idle" | "runtime"> = [];
    let resolveDecision: ((value: "continue" | "abort") => void) | undefined;

    activeSessions.set("session-1", {
      kind: "remote",
      descriptor: {
        id: "session-1",
        target: "ssh",
        connectionId: "connection-1",
        title: "test",
        status: "connected",
        type: "shell",
        createdAt: "2026-03-19T00:00:00.000Z",
        reconnectable: true,
      },
      channel: {
        write: (data: string | Buffer) => {
          wrappedCommand = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
        },
      },
      sender: createSender(99),
      connectionId: "connection-1",
      terminalEncoding: "utf-8",
      backspaceMode: "auto",
      deleteMode: "auto",
    } as never);

    const running = service.execCommandInSession("session-1", "slow-start-once", {
      startupTimeoutMs: 20,
      idleTimeoutMs: 200,
      onTimeoutPrompt: (kind) => {
        timeoutPrompts.push(kind);
        return new Promise<"continue" | "abort">((resolve) => {
          resolveDecision = resolve;
        });
      },
    });

    await delay(0);
    const { startSentinel, endPrefix, endSuffix } = extractSessionExecMarkers(wrappedCommand);

    await delay(70);
    expect(timeoutPrompts).toEqual(["startup"]);

    resolveDecision?.("continue");
    await delay(5);

    (service as unknown as { emitSessionOutput: (sessionId: string, chunk: string) => void })
      .emitSessionOutput("session-1", `${startSentinel}starting...\n`);
    await delay(5);
    (service as unknown as { emitSessionOutput: (sessionId: string, chunk: string) => void })
      .emitSessionOutput("session-1", `ready\n${endPrefix}0${endSuffix}`);

    const result = await running;
    expect(result.exitCode).toBe(0);
    expect(timeoutPrompts).toEqual(["startup"]);
  });

  test("prompts on idle timeout and aborts when user chooses abort", async () => {
    const { service, activeSessions } = createSessionServiceForTest();
    let wrappedCommand = "";
    const timeoutPrompts: Array<"startup" | "idle" | "runtime"> = [];

    activeSessions.set("session-1", {
      kind: "remote",
      descriptor: {
        id: "session-1",
        target: "ssh",
        connectionId: "connection-1",
        title: "test",
        status: "connected",
        type: "shell",
        createdAt: "2026-03-19T00:00:00.000Z",
        reconnectable: true,
      },
      channel: {
        write: (data: string | Buffer) => {
          wrappedCommand = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
        },
      },
      sender: createSender(99),
      connectionId: "connection-1",
      terminalEncoding: "utf-8",
      backspaceMode: "auto",
      deleteMode: "auto",
    } as never);

    const running = service.execCommandInSession("session-1", "idle-then-abort", {
      startupTimeoutMs: 20,
      idleTimeoutMs: 20,
      onTimeoutPrompt: async (kind) => {
        timeoutPrompts.push(kind);
        return "abort";
      },
    });

    await delay(0);
    const { startSentinel } = extractSessionExecMarkers(wrappedCommand);

    (service as unknown as { emitSessionOutput: (sessionId: string, chunk: string) => void })
      .emitSessionOutput("session-1", `${startSentinel}starting...\n`);

    await expect(running).rejects.toThrow("远端命令空闲超时");
    expect(timeoutPrompts).toEqual(["idle"]);
  });

  test("prompts on runtime timeout and continues waiting when user chooses continue", async () => {
    const { service, activeSessions } = createSessionServiceForTest();
    let wrappedCommand = "";
    const timeoutPrompts: Array<"startup" | "idle" | "runtime"> = [];

    activeSessions.set("session-1", {
      kind: "remote",
      descriptor: {
        id: "session-1",
        target: "ssh",
        connectionId: "connection-1",
        title: "test",
        status: "connected",
        type: "shell",
        createdAt: "2026-03-19T00:00:00.000Z",
        reconnectable: true,
      },
      channel: {
        write: (data: string | Buffer) => {
          wrappedCommand = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
        },
      },
      sender: createSender(99),
      connectionId: "connection-1",
      terminalEncoding: "utf-8",
      backspaceMode: "auto",
      deleteMode: "auto",
    } as never);

    const running = service.execCommandInSession("session-1", "runtime-continue", {
      timeoutMs: 20,
      startupTimeoutMs: 100,
      idleTimeoutMs: 100,
      onTimeoutPrompt: async (kind) => {
        timeoutPrompts.push(kind);
        return "continue";
      },
    });

    await delay(0);
    const { startSentinel, endPrefix, endSuffix } = extractSessionExecMarkers(wrappedCommand);

    (service as unknown as { emitSessionOutput: (sessionId: string, chunk: string) => void })
      .emitSessionOutput("session-1", `${startSentinel}still-running...\n`);

    await delay(25);
    (service as unknown as { emitSessionOutput: (sessionId: string, chunk: string) => void })
      .emitSessionOutput("session-1", `done\n${endPrefix}0${endSuffix}`);

    const result = await running;
    expect(timeoutPrompts).toEqual(["runtime"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("still-running");
  });

  test("prompts on runtime timeout and aborts when user chooses abort", async () => {
    const { service, activeSessions } = createSessionServiceForTest();
    let wrappedCommand = "";
    const timeoutPrompts: Array<"startup" | "idle" | "runtime"> = [];

    activeSessions.set("session-1", {
      kind: "remote",
      descriptor: {
        id: "session-1",
        target: "ssh",
        connectionId: "connection-1",
        title: "test",
        status: "connected",
        type: "shell",
        createdAt: "2026-03-19T00:00:00.000Z",
        reconnectable: true,
      },
      channel: {
        write: (data: string | Buffer) => {
          wrappedCommand = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
        },
      },
      sender: createSender(99),
      connectionId: "connection-1",
      terminalEncoding: "utf-8",
      backspaceMode: "auto",
      deleteMode: "auto",
    } as never);

    const running = service.execCommandInSession("session-1", "runtime-abort", {
      timeoutMs: 20,
      startupTimeoutMs: 100,
      idleTimeoutMs: 100,
      onTimeoutPrompt: async (kind) => {
        timeoutPrompts.push(kind);
        return "abort";
      },
    });

    await delay(0);
    const { startSentinel } = extractSessionExecMarkers(wrappedCommand);

    (service as unknown as { emitSessionOutput: (sessionId: string, chunk: string) => void })
      .emitSessionOutput("session-1", `${startSentinel}still-running...\n`);

    await expect(running).rejects.toThrow("远端命令执行超时");
    expect(timeoutPrompts).toEqual(["runtime"]);
  });

  test("handles fragmented sentinels and keeps long-running preview bounded", async () => {
    const { service, activeSessions } = createSessionServiceForTest();
    let wrappedCommand = "";
    let maxPreviewLength = 0;

    activeSessions.set("session-1", {
      kind: "remote",
      descriptor: {
        id: "session-1",
        target: "ssh",
        connectionId: "connection-1",
        title: "test",
        status: "connected",
        type: "shell",
        createdAt: "2026-03-19T00:00:00.000Z",
        reconnectable: true,
      },
      channel: {
        write: (data: string | Buffer) => {
          wrappedCommand = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
        },
      },
      sender: createSender(99),
      connectionId: "connection-1",
      terminalEncoding: "utf-8",
      backspaceMode: "auto",
      deleteMode: "auto",
    } as never);

    const running = service.execCommandInSession("session-1", "stream-many-lines", {
      startupTimeoutMs: 50,
      idleTimeoutMs: 50,
      onOutput: (output) => {
        maxPreviewLength = Math.max(maxPreviewLength, output.length);
      },
    });

    await delay(0);
    const { startSentinel, endPrefix, endSuffix } = extractSessionExecMarkers(wrappedCommand);

    const emitOutput = (chunk: string): void => {
      (service as unknown as { emitSessionOutput: (sessionId: string, chunk: string) => void })
        .emitSessionOutput("session-1", chunk);
    };

    emitOutput(startSentinel.slice(0, 8));
    emitOutput(startSentinel.slice(8));

    for (let index = 0; index < 400; index++) {
      emitOutput(`line-${index}-${"x".repeat(40)}\n`);
    }

    emitOutput(endPrefix.slice(0, 10));
    emitOutput(`${endPrefix.slice(10)}0`);
    emitOutput(endSuffix);

    const result = await running;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("line-0-");
    expect(result.stdout).toContain("line-399-");
    expect(maxPreviewLength <= 8000).toBe(true);
  });
});

describe("AiService.approve", () => {
  test("keeps current execution after continue timeout decision so follow-up analysis still works", async () => {
    const sender = createSender(1);
    const service = createService({
      vault: {
        readCredential: async () => "sk-test",
        storeCredential: async () => "secret://ignored",
        deleteCredential: async () => undefined,
      } as never,
      getPreferences: () => createPreferences(true),
    });

    const conversation = createConversation();
    conversation.ownerClientId = "client-1";
    (service as unknown as { conversations: Map<string, AiConversation> }).conversations.set("conv-1", conversation);
    (service as unknown as {
      taskContexts: Map<string, {
        aborted: boolean;
        executionController: AbortController;
        currentExecution?: { step: number; command: string; output: string };
        timeoutPrompt?: { step: number; kind: "startup" | "idle" | "runtime"; resolve: (action: "continue" | "abort") => void };
      }>;
    }).taskContexts.set("conv-1", {
      aborted: false,
      executionController: new AbortController(),
      currentExecution: {
        step: 1,
        command: "tail -f /var/log/app.log",
        output: "processing request...\n",
      },
      timeoutPrompt: {
        step: 1,
        kind: "idle",
        resolve: () => undefined,
      },
    });

    const streamChat = mock(async (_messages, onToken) => {
      onToken("继续");
      onToken("观察");
      return "当前输出仍在推进，建议继续观察后续日志信号。";
    });
    (service as unknown as { router: { getAdapter: () => { streamChat: typeof streamChat } } }).router.getAdapter = () => ({
      streamChat,
    });

    service.resolveTimeout(sender as never, {
      conversationId: "conv-1",
      clientId: "client-1",
      action: "continue",
    });

    const result = await service.analyzeCurrentExecution(sender as never, {
      conversationId: "conv-1",
      clientId: "client-1",
    });

    expect(result.ok).toBe(true);
    await delay(0);
    expect(conversation.messages.at(-1)?.content).toContain("继续观察");
  });

  test("analyzes current execution output without interrupting the running task", async () => {
    const sender = createSender(1);
    const service = createService({
      vault: {
        readCredential: async () => "sk-test",
        storeCredential: async () => "secret://ignored",
        deleteCredential: async () => undefined,
      } as never,
      getPreferences: () => createPreferences(true),
    });

    const conversation = createConversation();
    conversation.ownerClientId = "client-1";
    (service as unknown as { conversations: Map<string, AiConversation> }).conversations.set("conv-1", conversation);
    (service as unknown as {
      taskContexts: Map<string, {
        aborted: boolean;
        executionController: AbortController;
        currentExecution: { step: number; command: string; output: string };
      }>;
    }).taskContexts.set("conv-1", {
      aborted: false,
      executionController: new AbortController(),
      currentExecution: {
        step: 1,
        command: "tail -f /var/log/app.log",
        output: "processing request...\nprocessing request...\n",
      },
    });

    const streamChat = mock(async (_messages, onToken) => {
      onToken("当前");
      onToken("输出正常");
      return "当前输出显示服务仍在持续处理请求，暂未看到明确报错，建议继续观察是否出现 error、timeout 或连接中断信号。";
    });
    (service as unknown as { router: { getAdapter: () => { streamChat: typeof streamChat } } }).router.getAdapter = () => ({
      streamChat,
    });

    const result = await service.analyzeCurrentExecution(sender as never, {
      conversationId: "conv-1",
      clientId: "client-1",
    });
    expect(result.ok).toBe(true);

    await delay(0);

    expect(conversation.messages.at(-1)?.type).toBe("assistant_reply");
    expect(conversation.messages.at(-1)?.content).toContain("继续观察");
    const tokenEvents = sender.sent.filter((entry) => (
      (entry.payload as { type?: string; preserveExecutionState?: boolean })?.type === "token"
      && (entry.payload as { preserveExecutionState?: boolean }).preserveExecutionState === true
    ));
    expect(tokenEvents.length).toBeGreaterThan(0);
    const doneEvent = sender.sent.find((entry) => (
      (entry.payload as { type?: string; preserveExecutionState?: boolean })?.type === "done"
      && (entry.payload as { preserveExecutionState?: boolean }).preserveExecutionState === true
    ));
    expect(Boolean(doneEvent)).toBe(true);
  });

  test("rejects forbidden edited plans before execution", async () => {
    const execCommand = mock(async () => ({
      ...createCommandResult("should-not-run"),
    }));

    const service = createService({
      execCommand,
    });

    const conversation = createConversation();
    conversation.ownerClientId = "client-1";
    (service as unknown as { conversations: Map<string, AiConversation> }).conversations.set("conv-1", conversation);

    await expect(
      service.approve(createSender(1) as never, {
        conversationId: "conv-1",
        clientId: "client-1",
        plan: {
          summary: "bad",
          steps: [{ step: 1, command: "rm -rf /", description: "bad", risky: false }],
        },
      })
    ).rejects.toThrow("禁止执行会删除根目录的 rm -rf / 命令");

    expect(execCommand).not.toHaveBeenCalled();
  });
});

describe("AiService.testProvider", () => {
  test("returns capability validation errors instead of throwing", async () => {
    const service = createService();

    const result = await service.testProvider({
      type: "openai",
      baseUrl: "https://api.openai.com/v1/chat/completions",
      model: "gpt-4o",
      apiKey: "sk-test",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("OpenAI Base URL 不应包含 /chat/completions");
  });
});

describe("AiService window isolation", () => {
  test("routes history and stream events only to the owning sender", async () => {
    const dataDir = createDataDir();
    const sender1 = createSender(1);
    const sender2 = createSender(2);
    const service = createService({
      vault: {
        readCredential: async () => "sk-test",
        storeCredential: async () => "secret://ignored",
        deleteCredential: async () => undefined,
      } as never,
      getPreferences: () => createPreferences(true),
      dataDir,
    });

    const streamChat = mock(async (_messages, onToken) => {
      onToken("你");
      onToken("好");
      return "执行完成";
    });
    (service as unknown as { router: { getAdapter: () => { streamChat: typeof streamChat } } }).router.getAdapter = () => ({
      streamChat,
    } as never);

    const result = await service.chat(sender1 as never, {
      message: "帮我看看",
      connectionId: "11111111-1111-1111-1111-111111111111",
      sessionId: "22222222-2222-2222-2222-222222222222",
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const visibleToSender1 = service.history(sender1 as never, {
      connectionId: "11111111-1111-1111-1111-111111111111",
    });
    const visibleToSender2 = service.history(sender2 as never, {
      connectionId: "11111111-1111-1111-1111-111111111111",
    });

    expect(result.conversationId).toBe(visibleToSender1[0]?.id);
    expect(visibleToSender1).toHaveLength(1);
    expect(visibleToSender2).toHaveLength(0);
    expect(sender1.sent.length).toBeGreaterThan(0);
    expect(sender2.sent).toHaveLength(0);
  });

  test("rejects chat and approve requests from a different client", async () => {
    const sender1 = createSender(1);
    const sender2 = createSender(2);
    const service = createService({
      vault: {
        readCredential: async () => "sk-test",
        storeCredential: async () => "secret://ignored",
        deleteCredential: async () => undefined,
      } as never,
      getPreferences: () => createPreferences(true),
      dataDir: createDataDir(),
    });

    const streamChat = mock(async () => "执行完成");
    (service as unknown as { router: { getAdapter: () => { streamChat: typeof streamChat } } }).router.getAdapter = () => ({
      streamChat,
    } as never);

    const created = await service.chat(sender1 as never, {
      message: "帮我看看",
      connectionId: "11111111-1111-1111-1111-111111111111",
      sessionId: "22222222-2222-2222-2222-222222222222",
      clientId: "client-1",
    });

    await expect(
      service.chat(sender2 as never, {
        conversationId: created.conversationId,
        message: "继续",
        connectionId: "11111111-1111-1111-1111-111111111111",
        sessionId: "22222222-2222-2222-2222-222222222222",
        clientId: "client-2",
      })
    ).rejects.toThrow("当前窗口无权访问该 AI 对话");

    await expect(
      service.approve(sender2 as never, {
        conversationId: created.conversationId,
        clientId: "client-2",
      })
    ).rejects.toThrow("当前窗口无权访问该 AI 对话");

    expect(() => service.abort(sender2 as never, {
      conversationId: created.conversationId,
      clientId: "client-2",
    })).toThrow("当前窗口无权访问该 AI 对话");
  });

  test("keeps persisted history isolated by client id after first claim", () => {
    const dataDir = createDataDir();
    const historyFile = path.join(dataDir, "ai-conversations.json");
    fs.writeFileSync(historyFile, JSON.stringify([
      {
        id: "conv-persisted",
        title: "persisted",
        messages: [],
        connectionId: "33333333-3333-3333-3333-333333333333",
        sessionId: "44444444-4444-4444-4444-444444444444",
        createdAt: "2026-03-17T00:00:00.000Z",
        updatedAt: "2026-03-17T00:00:00.000Z",
      },
    ]), "utf-8");

    const service = createService({ dataDir });
    const sender1 = createSender(1);
    const sender2 = createSender(2);

    const claimed = service.history(sender1 as never, {
      connectionId: "33333333-3333-3333-3333-333333333333",
      clientId: "client-1",
    });
    const hidden = service.history(sender2 as never, {
      connectionId: "33333333-3333-3333-3333-333333333333",
      clientId: "client-2",
    });

    expect(claimed).toHaveLength(1);
    expect(hidden).toHaveLength(0);
  });
});

describe("AiService provider runtime options", () => {
  test("passes timeout and retry settings into model streaming", async () => {
    const sender = createSender(1);
    let receivedOptions: { timeoutMs?: number; maxRetries?: number } | undefined;
    const service = createService({
      vault: {
        readCredential: async () => "sk-test",
        storeCredential: async () => "secret://ignored",
        deleteCredential: async () => undefined,
      } as never,
      getPreferences: () => createPreferences(true),
      dataDir: createDataDir(),
    });

    const streamChat = mock(async (_messages, _onToken, options) => {
      receivedOptions = {
        timeoutMs: options?.timeoutMs,
        maxRetries: options?.maxRetries,
      };
      return "执行完成";
    });
    (service as unknown as { router: { getAdapter: () => { streamChat: typeof streamChat } } }).router.getAdapter = () => ({
      streamChat,
    } as never);

    await service.chat(sender as never, {
      message: "帮我看看",
      connectionId: "11111111-1111-1111-1111-111111111111",
      sessionId: "22222222-2222-2222-2222-222222222222",
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(receivedOptions?.timeoutMs).toBe(9000);
    expect(receivedOptions?.maxRetries).toBe(2);
  });
});

describe("AiService persistence", () => {
  test("loads persisted history for the matching connection", async () => {
    const dataDir = createDataDir();
    const historyFile = path.join(dataDir, "ai-conversations.json");
    fs.writeFileSync(historyFile, JSON.stringify([
      {
        id: "conv-persisted",
        title: "persisted",
        messages: [
          {
            id: "msg-1",
            role: "assistant",
            content: "历史消息",
            timestamp: "2026-03-17T00:00:00.000Z",
          },
        ],
        connectionId: "33333333-3333-3333-3333-333333333333",
        sessionId: "44444444-4444-4444-4444-444444444444",
        createdAt: "2026-03-17T00:00:00.000Z",
        updatedAt: "2026-03-17T00:00:00.000Z",
      },
    ]), "utf-8");

    const service = createService({ dataDir });

    const history = service.history(createSender(1) as never, {
      connectionId: "33333333-3333-3333-3333-333333333333",
    });

    expect(history).toHaveLength(1);
    expect(history[0]?.id).toBe("conv-persisted");
    expect(history[0]?.messages[0]?.type).toBe("assistant_reply");
  });

  test("does not write history file when persistence is disabled", async () => {
    const dataDir = createDataDir();
    const historyFile = path.join(dataDir, "ai-conversations.json");
    const service = createService({
      dataDir,
      getPreferences: () => createPreferences(false, false),
    });

    (
      service as unknown as {
        conversations: Map<string, AiConversation>;
        queuePersist: () => void;
        persistQueue: Promise<void>;
      }
    ).conversations.set("conv-1", {
      ...createConversation(),
      messages: [{
        id: "msg-1",
        role: "user",
        type: "user_prompt",
        content: "hello",
        timestamp: "2026-03-17T00:00:00.000Z",
      }],
    });

    (
      service as unknown as {
        queuePersist: () => void;
        persistQueue: Promise<void>;
      }
    ).queuePersist();
    await (
      service as unknown as {
        persistQueue: Promise<void>;
      }
    ).persistQueue;

    expect(fs.existsSync(historyFile)).toBe(false);
  });

  test("clears persisted history files on demand", async () => {
    const dataDir = createDataDir();
    const historyFile = path.join(dataDir, "ai-conversations.json");
    const tempHistoryFile = `${historyFile}.tmp`;
    fs.writeFileSync(historyFile, "[]", "utf-8");
    fs.writeFileSync(tempHistoryFile, "[]", "utf-8");

    const service = createService({ dataDir });

    (
      service as unknown as {
        clearPersistedHistory: () => void;
        persistQueue: Promise<void>;
      }
    ).clearPersistedHistory();
    await (
      service as unknown as {
        persistQueue: Promise<void>;
      }
    ).persistQueue;

    expect(fs.existsSync(historyFile)).toBe(false);
    expect(fs.existsSync(tempHistoryFile)).toBe(false);
  });

  test("exports a conversation as text with execution details", async () => {
    const sender = createSender(1);
    let exportedContent = "";
    const service = createService({
      saveTextFile: async (_sender, input) => {
        exportedContent = input.content;
        return { ok: true as const, filePath: `/tmp/${input.defaultPath}` };
      },
    });

    (
      service as unknown as {
        conversations: Map<string, AiConversation>;
      }
    ).conversations.set("conv-1", {
      ...createConversation(),
      ownerClientId: "client-1",
      title: "检查 nginx 状态",
      messages: [
        {
          id: "msg-user",
          role: "user",
          type: "user_prompt",
          content: "帮我检查 nginx",
          timestamp: "2026-03-17T00:00:00.000Z",
        },
        {
          id: "msg-plan",
          role: "assistant",
          type: "assistant_reply",
          content: "我会先检查服务状态。",
          timestamp: "2026-03-17T00:01:00.000Z",
          plan: {
            summary: "检查 nginx 服务",
            steps: [{
              step: 1,
              command: "systemctl status nginx --no-pager",
              description: "查看 nginx 服务状态",
              risky: false,
            }],
          },
        },
        {
          id: "msg-exec",
          role: "system",
          type: "execution_result",
          content: "刚才执行了命令：`systemctl status nginx --no-pager`\n\n退出码：0\n\n输出：\n```\nactive (running)\n```",
          timestamp: "2026-03-17T00:02:00.000Z",
        },
      ],
    });

    const result = await service.exportConversation(sender as never, {
      conversationId: "conv-1",
      clientId: "client-1",
    });

    expect(result.ok).toBe(true);
    expect(exportedContent).toContain("NextShell AI 对话导出");
    expect(exportedContent).toContain("一、会话概览");
    expect(exportedContent).toContain("二、消息统计");
    expect(exportedContent).toContain("三、执行记录摘要");
    expect(exportedContent).toContain("四、详细时间线");
    expect(exportedContent).toContain("用户消息：1");
    expect(exportedContent).toContain("执行结果：1");
    expect(exportedContent).toContain("检查 nginx 状态");
    expect(exportedContent).toContain("帮我检查 nginx");
    expect(exportedContent).toContain("systemctl status nginx --no-pager");
    expect(exportedContent).toContain("active (running)");
  });
});
