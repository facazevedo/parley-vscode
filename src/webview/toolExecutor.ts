import { createHash } from 'crypto';
import { exec } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ChatMode, ParleySettings } from '../config/settings';
import type { CommandDependencies } from '../commands/common';
import { isSensitiveFile } from '../context/sensitiveFileFilter';
import type { CheckpointStore } from '../diff/checkpoints';
import { applyMultiEdit, applySnippetEdit, type MultiEditItem } from '../diff/editMatch';
import { decodeText } from '../diff/fileFormat';
import { formatUnifiedDiff } from '../diff/lineDiff';
import { reviewProposedEdit } from '../diff/reviewEdit';
import { showProposedDiff } from '../diff/showDiff';
import { dbg } from '../debug/debug';
import type { BrowserManager } from '../browser/browserManager';
import { runHookEvent } from '../hooks/hooks';
import type { McpManager } from '../mcp/McpManager';
import { runSubagentTask } from '../agents/subagent';
import { clampMiddle } from '../parley/clampText';
import { isCommandAllowed, isSimpleCommand } from '../parley/commandSafety';
import { redactSecrets, summarizeFindings } from '../context/secretScanner';
import { isMcpTool } from '../mcp/naming';
import type { ParleyProvider } from '../parley/ParleyProvider';
import { estimateCostUsd } from '../parley/pricing';
import { resolveThinking, type ThinkingLevel } from '../parley/thinking';
import { SUBAGENT_TOOLS, assertInsideWorkspace, resolveAcrossRoots, runAgentTool } from '../parley/tools';
import type { ToolCall } from '../parley/types';
import { rememberFact } from '../context/projectMemory';
import { wrapUntrusted } from '../parley/untrusted';
import { webSearch } from '../web/webSearch';
import type { TranscriptRecorder } from './transcriptRecorder';

/** Everything the tool executor needs from its hosting chat panel. */
export interface ToolExecutorHost {
  readonly checkpoints: CheckpointStore;
  readonly mcp: McpManager;
  readonly browser: BrowserManager;
  readonly state: vscode.Memento;
  readonly recorder: TranscriptRecorder;
  readonly diffProvider: CommandDependencies['diffProvider'];
  getSettings(): ParleySettings;
  getMode(): ChatMode;
  getAbortSignal(): AbortSignal | undefined;
  /** Provider + current model/thinking/speed selection, for nested subagent loops. */
  getSubagentParams(): {
    provider: ParleyProvider;
    agentId: string;
    thinking: ThinkingLevel;
    speed: 'standard' | 'fast';
  };
  /** The current turn's snapshot of `.parley/agents` custom subagent types. */
  getSubagentTypes(): readonly { id: string; description: string; prompt: string; model?: string }[];
  /** Add nested-loop usage to the session counters (same sink as the turn runner's). */
  applyUsage(totalTokens: number, costUsd: number): { sessionTokens: number; sessionCostUsd: number };
  /** Show a generated image inline in the chat (for the generate_image tool). */
  showImage(dataUri: string, label: string): void;
  /** Capture the screen as a base64 PNG (for the capture_screen tool); undefined if no backend. */
  captureScreen(): Promise<string | undefined>;
  post(message: Record<string, unknown>): void;
}

/**
 * Executes the agent's tool calls — file edits (with staleness guard, tiered
 * matching, review cards, checkpoints, post-edit diagnostics), shell commands
 * (with the allowlist), plan updates, web search, and MCP passthrough.
 * Decomposition 3/4: extracted from ChatPanel; the panel delegates to `run()`.
 */
export class ToolExecutor {
  // Proposed file changes from a chat-mode reply, awaiting an inline Apply click.
  private readonly pendingChanges = new Map<
    string,
    { uri: vscode.Uri; rel: string; original: string; proposedText: string; deleteFile?: boolean }
  >();
  private changeSeq = 0;
  // Images produced by tools (capture_screen) awaiting injection into the turn as
  // an image message the model can see — drained by the turn runner each round.
  private pendingImages: string[] = [];
  // Ask-mode approvals: proposed-change cards whose tool call awaits an Apply/Reject click.
  private approvalSeq = 0;
  private readonly pendingApprovals = new Map<
    string,
    { resolve: (finalText: string | undefined) => void; rel: string; original: string; proposedText: string }
  >();
  // Content hashes of files the agent has read this conversation — staleness detection
  // for write_file (don't clobber unseen changes) and better edit_file errors.
  private readonly fileReadHashes = new Map<string, string>();
  // Reads performed by a SUBAGENT: tracked for staleness/touched-files, but kept
  // OUT of the write-clobber guard — the parent never saw those contents, only the
  // subagent's distilled report, so they must not authorize a parent overwrite.
  private readonly subagentReadHashes = new Map<string, string>();
  private commandChannel?: vscode.OutputChannel;

  public constructor(private readonly host: ToolExecutorHost) {}

  /** Ids of interactive cards (chat-mode Apply cards + ask-mode approvals) still pending. */
  public pendingIds(): string[] {
    return [...this.pendingChanges.keys(), ...this.pendingApprovals.keys()];
  }

  /** Clear per-conversation state on new/opened/forked conversations. */
  public resetConversationState(): void {
    this.pendingChanges.clear();
    this.fileReadHashes.clear();
    this.subagentReadHashes.clear();
    this.pendingImages = [];
  }

  /** Drain tool-produced images (capture_screen) for injection into the turn. */
  public drainImages(): string[] {
    const images = this.pendingImages;
    this.pendingImages = [];
    return images;
  }

  /** Absolute paths of files the agent has read/edited this conversation (for glob-scoped rules). */
  public touchedFiles(): string[] {
    return [...new Set([...this.fileReadHashes.keys(), ...this.subagentReadHashes.keys()])];
  }

  /** Tool runner for agent mode: read tools delegate to the read-only runner; writes/commands need UI + checkpoints. */
  public async run(call: ToolCall, opts?: { subagent?: boolean }): Promise<string> {
    // Lifecycle hooks (parley.hooks): PreToolUse may block; PostToolUse may append feedback.
    const hooks = this.host.getSettings().hooks;
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const pre = await runHookEvent(
      hooks,
      'PreToolUse',
      { tool: call.name, arguments: safeParseArgs(call.arguments) },
      { cwd, log: (m) => dbg('hooks', m) }
    );
    if (pre.blocked) {
      return `Error: blocked by a PreToolUse hook${pre.feedback ? ` — ${pre.feedback}` : ''}. Adjust your approach accordingly.`;
    }
    // Scan tool output (e.g. a file the agent read, or command output) for credentials
    // before it reaches the model/gateway — see the setting parley.secretScanning.
    const result = this.applySecretPolicy(await this.dispatch(call, opts));
    const post = await runHookEvent(
      hooks,
      'PostToolUse',
      { tool: call.name, arguments: safeParseArgs(call.arguments), result: result.slice(0, 4000) },
      { cwd, log: (m) => dbg('hooks', m) }
    );
    return post.feedback ? `${result}\n\n[PostToolUse hook feedback — address this]\n${post.feedback}` : result;
  }

  /** Redact (or warn about) secrets in a tool result per the parley.secretScanning setting. */
  private applySecretPolicy(text: string): string {
    const mode = this.host.getSettings().secretScanning;
    if (mode === 'off') {
      return text;
    }
    const { text: redacted, findings } = redactSecrets(text);
    if (findings.length === 0) {
      return text;
    }
    const summary = summarizeFindings(findings);
    dbg('secret', `${mode} in tool result: ${summary}`);
    if (mode === 'warn') {
      return `${text}\n\n[Parley: ${summary} detected in this output and sent as-is (secretScanning=warn).]`;
    }
    return `${redacted}\n\n[Parley redacted ${summary} from this output before sending.]`;
  }

  private async dispatch(call: ToolCall, opts?: { subagent?: boolean }): Promise<string> {
    if (isMcpTool(call.name)) {
      return this.host.mcp.callTool(call.name, call.arguments);
    }
    if (call.name === 'read_file') {
      const result = await runAgentTool(call);
      await this.recordReadFromArgs(call.arguments, opts?.subagent);
      return result;
    }
    if (call.name === 'write_file') {
      return this.toolWriteFile(call);
    }
    if (call.name === 'edit_file') {
      return this.toolEditFile(call);
    }
    if (call.name === 'multi_edit') {
      return this.toolMultiEdit(call);
    }
    if (call.name === 'run_command') {
      return this.toolRunCommand(call);
    }
    if (call.name === 'remember') {
      return this.toolRemember(call);
    }
    if (call.name === 'generate_image') {
      return this.toolGenerateImage(call);
    }
    if (call.name === 'capture_screen') {
      return this.toolCaptureScreen();
    }
    if (call.name === 'update_plan') {
      return this.toolUpdatePlan(call);
    }
    if (call.name === 'web_search') {
      return this.toolWebSearch(call);
    }
    if (call.name.startsWith('browser_')) {
      return this.toolBrowser(call);
    }
    if (call.name === 'run_subagent') {
      return this.toolSubagent(call);
    }
    if (call.name === 'run_subagents') {
      return this.toolSubagents(call);
    }
    return runAgentTool(call);
  }

  /**
   * Nested read-only investigation with a fresh context. Nested tool calls are
   * whitelisted to SUBAGENT_TOOLS and routed back through run(), so PreToolUse/
   * PostToolUse hooks and read tracking apply to subagent activity too.
   */
  private async toolSubagent(call: ToolCall): Promise<string> {
    let task = '';
    let agentName = '';
    try {
      const parsed = JSON.parse(call.arguments || '{}') as { task?: unknown; agent?: unknown };
      task = String(parsed.task ?? '').trim();
      agentName = String(parsed.agent ?? '').trim();
    } catch {
      return 'Error: arguments were not valid JSON.';
    }
    if (!task) {
      return 'Error: task is required.';
    }
    return this.runOneSubagent(task, agentName);
  }

  /** Run several subagents concurrently and return their reports, labeled and aggregated. */
  private async toolSubagents(call: ToolCall): Promise<string> {
    let tasks: Array<{ task: string; agent: string }> = [];
    try {
      const parsed = JSON.parse(call.arguments || '{}') as { tasks?: unknown };
      if (Array.isArray(parsed.tasks)) {
        tasks = parsed.tasks
          .map((t) => {
            const o = (t ?? {}) as { task?: unknown; agent?: unknown };
            return { task: String(o.task ?? '').trim(), agent: String(o.agent ?? '').trim() };
          })
          .filter((t) => t.task);
      }
    } catch {
      return 'Error: arguments were not valid JSON.';
    }
    if (tasks.length === 0) {
      return 'Error: provide a non-empty "tasks" array, each item with a self-contained "task".';
    }
    // Cap fan-out so a runaway call can't spawn dozens of concurrent model loops.
    const MAX_PARALLEL = 5;
    const capped = tasks.slice(0, MAX_PARALLEL);
    const reports = await Promise.all(
      capped.map((t, i) =>
        this.runOneSubagent(t.task, t.agent).catch(
          (e) => `Error: subagent ${i + 1} failed — ${e instanceof Error ? e.message : 'unknown'}`
        )
      )
    );
    const overflow =
      tasks.length > MAX_PARALLEL
        ? `\n\n(Note: ${tasks.length - MAX_PARALLEL} extra task(s) were dropped — max ${MAX_PARALLEL} per call.)`
        : '';
    return (
      capped.map((t, i) => `## Subagent ${i + 1}: ${t.task.slice(0, 80)}\n${reports[i]}`).join('\n\n---\n\n') + overflow
    );
  }

  /** One nested read-only investigation with a fresh context; returns its report text. */
  private async runOneSubagent(task: string, agentName: string): Promise<string> {
    const p = this.host.getSubagentParams();
    const types = this.host.getSubagentTypes();
    const type = agentName ? types.find((t) => t.id.toLowerCase() === agentName.toLowerCase()) : undefined;
    // Unknown type: run the default investigator anyway (no wasted round) and tell the model.
    const unknownNote =
      agentName && !type
        ? `Note: unknown agent type "${agentName}" — ran the default investigator. Available: ${
            types.map((t) => t.id).join(', ') || 'none'
          }.\n\n`
        : '';
    const agentId = type?.model?.trim() || p.agentId;
    const allowed = new Set(SUBAGENT_TOOLS.map((t) => t.function.name));
    dbg('subagent', `start${type ? ` [${type.id}]` : ''}: ${task.slice(0, 120)}`);
    const report = await runSubagentTask({
      task,
      provider: p.provider,
      agentId,
      thinking: resolveThinking(p.thinking),
      speed: p.speed,
      tools: SUBAGENT_TOOLS,
      role: type ? { id: type.id, prompt: type.prompt } : undefined,
      runTool: (nested) =>
        allowed.has(nested.name)
          ? this.run(nested, { subagent: true })
          : Promise.resolve(`Error: ${nested.name} is not available to subagents (read-only tools only).`),
      signal: this.host.getAbortSignal(),
      onStep: (action) =>
        this.host.post({ type: 'toolEvent', name: 'subagent_step', args: JSON.stringify({ action }) }),
      onUsage: (usage) => {
        // Subagent tokens/cost hit the same session counters as the parent loop
        // (attributed to the model that actually ran).
        this.host.applyUsage(usage.total, estimateCostUsd(agentId, usage) ?? 0);
      }
    });
    dbg('subagent', `done: ${report.length} chars`);
    return unknownNote + report;
  }

  /** Route a browser_* call to the shared BrowserManager (local Playwright). */
  private async toolBrowser(call: ToolCall): Promise<string> {
    let a: { url?: string; selector?: string; text?: string; errors_only?: boolean } = {};
    try {
      a = JSON.parse(call.arguments || '{}');
    } catch {
      return 'Error: arguments were not valid JSON.';
    }
    const b = this.host.browser;
    switch (call.name) {
      case 'browser_navigate':
        return b.navigate(String(a.url ?? ''));
      case 'browser_read':
        // Rendered page text is untrusted — frame it as data, not instructions.
        return wrapUntrusted('rendered web page', await b.read(a.selector ? String(a.selector) : undefined));
      case 'browser_console':
        return wrapUntrusted('browser console output', await b.consoleOutput(a.errors_only === true));
      case 'browser_click':
        return a.selector ? b.click(String(a.selector)) : 'Error: selector is required.';
      case 'browser_type':
        return a.selector ? b.type(String(a.selector), String(a.text ?? '')) : 'Error: selector is required.';
      case 'browser_screenshot':
        return b.screenshot();
      default:
        return `Error: unknown browser tool "${call.name}".`;
    }
  }

  private async toolWebSearch(call: ToolCall): Promise<string> {
    let query = '';
    try {
      query = String(JSON.parse(call.arguments || '{}').query ?? '');
    } catch {
      return 'Error: arguments were not valid JSON.';
    }
    const s = this.host.getSettings();
    const results = await webSearch(query, {
      provider: s.webSearchProvider,
      apiKey: s.webSearchApiKey,
      googleCx: s.webSearchGoogleCx
    });
    return wrapUntrusted('web search results', results);
  }

  /** Capture the screen and show it inline in the chat (for "screenshot my screen" requests). */
  private async toolCaptureScreen(): Promise<string> {
    let base64: string | undefined;
    try {
      base64 = await this.host.captureScreen();
    } catch (error) {
      return `Error: screen capture failed (${error instanceof Error ? error.message.split('\n')[0] : 'unknown'}).`;
    }
    if (!base64) {
      return 'Error: screen capture is unavailable here (needs the built-in Windows backend or nut.js). Tell the user they can also run the /screenshot command or click the 📷 button.';
    }
    const dataUri = `data:image/png;base64,${base64}`;
    this.host.showImage(dataUri, 'screenshot');
    // Queue it so the turn runner feeds it to the model as an image on the next
    // round — the model can then actually SEE and analyze the screen.
    this.pendingImages.push(dataUri);
    return 'Captured the screen and displayed it. The screenshot image is being attached to the conversation now — you WILL see it on your next turn, so continue and analyze it (do not claim you cannot see it).';
  }

  /** Generate an image from a prompt and show it inline in the chat. */
  private async toolGenerateImage(call: ToolCall): Promise<string> {
    let prompt = '';
    let size = '1024x1024';
    try {
      const a = JSON.parse(call.arguments || '{}') as { prompt?: unknown; size?: unknown };
      prompt = String(a.prompt ?? '').trim();
      if (typeof a.size === 'string' && ['1024x1024', '1536x1024', '1024x1536', 'auto'].includes(a.size)) {
        size = a.size;
      }
    } catch {
      return 'Error: arguments were not valid JSON.';
    }
    if (!prompt) {
      return 'Error: prompt is required — describe the image to generate.';
    }
    try {
      const result = await this.host
        .getSubagentParams()
        .provider.generateImage(
          { prompt, size, quality: 'auto', model: 'openai/gpt-image-1' },
          this.host.getAbortSignal()
        );
      this.host.showImage(`data:${result.mimeType};base64,${result.base64}`, prompt.slice(0, 80));
      return `Generated the image and displayed it in the chat (${size}). Do NOT try to describe or embed it further — the user can see it.`;
    } catch (error) {
      if (this.host.getAbortSignal()?.aborted) {
        return 'Image generation was stopped.';
      }
      const msg = error instanceof Error ? error.message.split('\n')[0].slice(0, 200) : 'unknown error';
      return `Error: could not generate the image (${msg}). The gateway may not offer an image model on your account.`;
    }
  }

  /** Persist a durable project fact to `.parley/memory.md` (injected into future turns). */
  private async toolRemember(call: ToolCall): Promise<string> {
    let fact = '';
    try {
      fact = String((JSON.parse(call.arguments || '{}') as { fact?: unknown }).fact ?? '').trim();
    } catch {
      return 'Error: arguments were not valid JSON.';
    }
    if (!fact) {
      return 'Error: fact is required — one concise, durable sentence.';
    }
    const result = await rememberFact(fact);
    switch (result) {
      case 'added':
        return `Remembered: "${fact}" (saved to .parley/memory.md — included in future conversations).`;
      case 'duplicate':
        return 'Already remembered — no change.';
      case 'no-workspace':
        return 'Error: no workspace folder open — nowhere to store project memory.';
      default:
        return 'Error: could not write .parley/memory.md.';
    }
  }

  /** Render the agent's task checklist in the chat (Claude-Code / Codex style). */
  private toolUpdatePlan(call: ToolCall): string {
    let steps: Array<{ step?: string; status?: string }> = [];
    try {
      steps = (JSON.parse(call.arguments || '{}').steps ?? []) as Array<{ step?: string; status?: string }>;
    } catch {
      return 'Error: arguments were not valid JSON.';
    }
    const clean = steps
      .filter((s) => s && typeof s.step === 'string')
      .map((s) => ({
        step: String(s.step).slice(0, 200),
        status: s.status === 'done' || s.status === 'in_progress' ? s.status : 'pending'
      }));
    this.host.post({ type: 'plan', steps: clean });
    this.host.recorder.append({
      kind: 'plan',
      steps: clean.map((s) => ({ text: s.step, status: s.status })),
      at: new Date().toISOString()
    });
    const done = clean.filter((s) => s.status === 'done').length;
    return `Plan updated (${done}/${clean.length} done).`;
  }

  // ---------- file staleness tracking ----------

  private static hashContent(text: string): string {
    // EOL-insensitive: normalize CRLF→LF first so our own line-ending round-trip
    // (writing a CRLF file back as CRLF) never reads back as a "changed on disk".
    return createHash('sha1').update(text.replace(/\r\n/g, '\n')).digest('hex');
  }

  /** Read a workspace file as text, honoring its encoding (UTF-8/UTF-16LE + BOM). */
  private static async readText(uri: vscode.Uri): Promise<string> {
    return decodeText(await vscode.workspace.fs.readFile(uri)).text;
  }

  /** Remember the on-disk content of a file the agent has just read (or we just wrote). */
  private recordFileState(fsPath: string, content: string): void {
    this.fileReadHashes.set(fsPath, ToolExecutor.hashContent(content));
  }

  /**
   * After a read_file tool call: hash the file so later writes can detect outside
   * changes. Subagent reads go to a separate map (subagentReadHashes) so they still
   * feed staleness/touched-files but do NOT authorize a parent write_file overwrite —
   * the parent only ever saw the subagent's report, not the file itself.
   */
  private async recordReadFromArgs(argsJson: string, subagent?: boolean): Promise<void> {
    try {
      const rel = String((JSON.parse(argsJson || '{}') as { path?: string }).path ?? '').replace(/^[/\\]+/, '');
      if (!rel) {
        return;
      }
      const uri = await resolveAcrossRoots(rel);
      if (!uri) {
        return;
      }
      const content = await ToolExecutor.readText(uri);
      const target = subagent ? this.subagentReadHashes : this.fileReadHashes;
      target.set(uri.fsPath, ToolExecutor.hashContent(content));
    } catch {
      // Unreadable/absent — nothing to record.
    }
  }

  /** Note appended to edit errors when the file changed on disk after the agent's last read. */
  private staleNote(fsPath: string, currentContent: string): string {
    const recorded = this.fileReadHashes.get(fsPath);
    if (recorded && recorded !== ToolExecutor.hashContent(currentContent)) {
      return ' Note: the file has CHANGED on disk since you last read it (edited by the user or a tool) — trust the content shown below over your memory.';
    }
    return '';
  }

  private async toolWriteFile(call: ToolCall): Promise<string> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) {
      return 'Error: no workspace folder is open.';
    }
    let args: { path?: string; content?: string };
    try {
      args = JSON.parse(call.arguments || '{}');
    } catch {
      return 'Error: arguments were not valid JSON.';
    }
    const rel = String(args.path ?? '').replace(/^[/\\]+/, '');
    const content = String(args.content ?? '');
    if (!rel) {
      return 'Error: path is required.';
    }
    if (isSensitiveFile(rel)) {
      return 'Error: refusing to write a sensitive file.';
    }

    const uri = await resolveAcrossRoots(rel);
    if (!uri) {
      return 'Error: path is outside the workspace.';
    }
    // Canonical-path guard: an in-tree symlink/junction must not let a write escape
    // the root (resolveAcrossRoots only checks the path lexically).
    if (!(await assertInsideWorkspace(uri, vscode.workspace.getWorkspaceFolder?.(uri)?.uri ?? root))) {
      return 'Error: path is outside the workspace.';
    }
    let original = '';
    let fileExists = true;
    try {
      original = await ToolExecutor.readText(uri);
    } catch {
      original = '';
      fileExists = false;
    }
    // Overwriting an existing, non-empty file requires a fresh view of it — otherwise the
    // agent could clobber content it has never seen (e.g. the user edited it mid-conversation).
    // Instead of a bare refusal, the CURRENT content is read into the reply (and its hash
    // recorded), so the model can re-issue the write in ONE round with full knowledge.
    if (fileExists && original.length > 0) {
      const recorded = this.fileReadHashes.get(uri.fsPath);
      if (!recorded || recorded !== ToolExecutor.hashContent(original)) {
        this.recordFileState(uri.fsPath, original);
        const reason = recorded
          ? `${rel} has CHANGED on disk since you last read it (edited by the user or a tool)`
          : `${rel} already exists but you have not read it in this conversation`;
        return (
          `Error: ${reason} — the write was NOT applied to avoid clobbering unseen content.\n` +
          `Here is the CURRENT content (auto-read for you; its state is now recorded, so a corrected re-issue will succeed):\n` +
          `${numberedExcerpt(original)}\n` +
          `Re-issue write_file with the full intended contents based on the above — or use edit_file for a targeted change.`
        );
      }
    }
    const proposedText = content.endsWith('\n') ? content : `${content}\n`;
    return this.applyProposedEdit(uri, rel, original, proposedText);
  }

  /** Surgical edit: replace a unique snippet, then go through the same review/apply flow. */
  private async toolEditFile(call: ToolCall): Promise<string> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) {
      return 'Error: no workspace folder is open.';
    }
    let args: { path?: string; old_text?: string; new_text?: string };
    try {
      args = JSON.parse(call.arguments || '{}');
    } catch {
      return 'Error: arguments were not valid JSON.';
    }
    const rel = String(args.path ?? '').replace(/^[/\\]+/, '');
    const oldText = String(args.old_text ?? '');
    const newText = String(args.new_text ?? '');
    if (!rel) {
      return 'Error: path is required.';
    }
    if (!oldText) {
      return 'Error: old_text is required.';
    }
    if (isSensitiveFile(rel)) {
      return 'Error: refusing to edit a sensitive file.';
    }

    const uri = await resolveAcrossRoots(rel);
    if (!uri) {
      return 'Error: path is outside the workspace.';
    }
    // Canonical-path guard: an in-tree symlink/junction must not let a write escape
    // the root (resolveAcrossRoots only checks the path lexically).
    if (!(await assertInsideWorkspace(uri, vscode.workspace.getWorkspaceFolder?.(uri)?.uri ?? root))) {
      return 'Error: path is outside the workspace.';
    }
    let original: string;
    try {
      original = await ToolExecutor.readText(uri);
    } catch {
      return `Error: could not read "${rel}" — does it exist? Use write_file to create new files.`;
    }

    // Tiered matching: exact → trimmed lines → collapsed whitespace; a failed match
    // returns the closest real region so the model can repair old_text in one round.
    const match = applySnippetEdit(original, oldText, newText);
    if (match.kind === 'ambiguous') {
      return (
        `Error: old_text matches ${match.startLines.length} places in ${rel}` +
        ` (starting at lines ${match.startLines.slice(0, 8).join(', ')}).` +
        ' Include more surrounding context so it is unique.'
      );
    }
    if (match.kind === 'notfound') {
      const stale = this.staleNote(uri.fsPath, original);
      if (match.hint) {
        return (
          `Error: old_text was not found in ${rel}.${stale}` +
          ` Closest match is lines ${match.hint.startLine}-${match.hint.endLine}` +
          ` (${Math.round(match.hint.similarity * 100)}% of lines match) — the file actually contains:\n` +
          `${match.hint.excerpt}\n` +
          'Copy old_text EXACTLY from the lines above (watch punctuation and small wording differences), then retry edit_file.'
        );
      }
      return `Error: old_text was not found in ${rel}.${stale} Re-read the file with read_file and copy an exact snippet.`;
    }
    return this.applyProposedEdit(uri, rel, original, match.newText);
  }

  /** Apply several edits to one file atomically (all-or-nothing), then one review/checkpoint. */
  private async toolMultiEdit(call: ToolCall): Promise<string> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) {
      return 'Error: no workspace folder is open.';
    }
    let args: { path?: string; edits?: Array<{ old_text?: string; new_text?: string }> };
    try {
      args = JSON.parse(call.arguments || '{}');
    } catch {
      return 'Error: arguments were not valid JSON.';
    }
    const rel = String(args.path ?? '').replace(/^[/\\]+/, '');
    if (!rel) {
      return 'Error: path is required.';
    }
    if (!Array.isArray(args.edits) || args.edits.length === 0) {
      return 'Error: edits must be a non-empty array of { old_text, new_text }.';
    }
    if (isSensitiveFile(rel)) {
      return 'Error: refusing to edit a sensitive file.';
    }
    const edits: MultiEditItem[] = args.edits.map((e) => ({
      oldText: String(e?.old_text ?? ''),
      newText: String(e?.new_text ?? '')
    }));

    const uri = await resolveAcrossRoots(rel);
    if (!uri) {
      return 'Error: path is outside the workspace.';
    }
    // Canonical-path guard: an in-tree symlink/junction must not let a write escape
    // the root (resolveAcrossRoots only checks the path lexically).
    if (!(await assertInsideWorkspace(uri, vscode.workspace.getWorkspaceFolder?.(uri)?.uri ?? root))) {
      return 'Error: path is outside the workspace.';
    }
    let original: string;
    try {
      original = await ToolExecutor.readText(uri);
    } catch {
      return `Error: could not read "${rel}" — does it exist? Use write_file to create new files.`;
    }

    const result = applyMultiEdit(original, edits);
    if (result.kind === 'error') {
      const which = result.index >= 0 ? ` (edit #${result.index + 1} of ${edits.length})` : '';
      const stale = result.index >= 0 ? this.staleNote(uri.fsPath, original) : '';
      // The hint is scanned against the in-memory text after the earlier edits in the batch
      // have been applied — say so for edit #2+ so the agent doesn't distrust it vs. the file on disk.
      const hintBasis = result.index > 0 ? ' (after applying the earlier edits in this batch)' : '';
      const hint = result.hint
        ? ` Closest match is lines ${result.hint.startLine}-${result.hint.endLine}${hintBasis}` +
          ` (${Math.round(result.hint.similarity * 100)}% of lines match) — the text at that point contains:\n${result.hint.excerpt}\n` +
          'Copy old_text EXACTLY from the lines above, then retry.'
        : '';
      return `Error: ${result.message}${which} No edits were applied (this tool is all-or-nothing).${stale}${hint}`;
    }
    return this.applyProposedEdit(uri, rel, original, result.newText);
  }

  /** Apply a proposed file change: auto in edit/auto/full modes, diff-approval otherwise. Always checkpointed. */
  private async applyProposedEdit(
    uri: vscode.Uri,
    rel: string,
    original: string,
    proposedText: string
  ): Promise<string> {
    const preDiagnostics = ToolExecutor.diagnosticsKeySet(uri);
    const mode = this.host.getMode();
    if (mode === 'edit' || mode === 'auto' || mode === 'full') {
      await this.host.checkpoints.applyWithCheckpoint(uri, proposedText, `edit ${rel}`);
      this.recordFileState(uri.fsPath, proposedText);
      this.postFileEdit(rel, original, proposedText);
      return `Applied edit to ${rel} (auto).${await this.newProblemsAfterEdit(uri, preDiagnostics)}`;
    }

    // Ask mode: open the native diff for full context and render an in-chat approval
    // card (Apply / Choose hunks… / Reject). The tool call awaits the click — no
    // blocking modal, so the rest of the chat (and steering) stays usable.
    await showProposedDiff(
      { filePath: uri.fsPath, originalText: original, proposedText, title: `Agent edit: ${rel}` },
      this.host.diffProvider
    );
    const id = `apr${this.approvalSeq++}`;
    const diff = formatUnifiedDiff(original, proposedText);
    const MAX_ROWS = 500;
    const rows = diff.rows.length > MAX_ROWS ? diff.rows.slice(0, MAX_ROWS) : diff.rows;
    const isNew = original.length === 0;
    this.host.post({
      type: 'proposedChange',
      id,
      path: rel,
      isNew,
      approval: true,
      added: diff.added,
      removed: diff.removed,
      rows,
      truncated: diff.rows.length > MAX_ROWS
    });
    this.host.recorder.append({
      kind: 'fileEdit',
      id,
      path: rel,
      added: diff.added,
      removed: diff.removed,
      rows,
      truncated: diff.rows.length > MAX_ROWS,
      status: 'proposed',
      isNew,
      at: new Date().toISOString()
    });
    this.host.post({ type: 'status', text: `Waiting for your review of ${rel}…` });

    const finalText = await new Promise<string | undefined>((resolve) => {
      this.pendingApprovals.set(id, { resolve, rel, original, proposedText });
      this.host.getAbortSignal()?.addEventListener(
        'abort',
        () => {
          if (this.pendingApprovals.delete(id)) {
            resolve(undefined);
          }
        },
        { once: true }
      );
    });

    if (finalText === undefined) {
      this.host.post({ type: 'changeResolved', id, status: 'dismissed' });
      this.resolveTranscriptChange(id, 'dismissed');
      return `User rejected the edit to ${rel}.`;
    }
    await this.host.checkpoints.applyWithCheckpoint(uri, finalText, `edit ${rel}`);
    this.recordFileState(uri.fsPath, finalText);
    this.host.post({ type: 'changeResolved', id, status: 'applied' });
    this.resolveTranscriptChange(id, 'applied');
    return `Applied edit to ${rel}.${await this.newProblemsAfterEdit(uri, preDiagnostics)}`;
  }

  // ---------- ask-mode approval clicks (routed from the webview via the panel) ----------

  /** Apply click on an approval card. Returns false when the id isn't a pending approval. */
  public approveApproval(id: string): boolean {
    const approval = this.pendingApprovals.get(id);
    if (!approval) {
      return false;
    }
    this.pendingApprovals.delete(id);
    approval.resolve(approval.proposedText);
    return true;
  }

  /** Reject click on an approval card. Returns false when the id isn't a pending approval. */
  public rejectApproval(id: string): boolean {
    const approval = this.pendingApprovals.get(id);
    if (!approval) {
      return false;
    }
    this.pendingApprovals.delete(id);
    approval.resolve(undefined);
    return true;
  }

  /** "Choose hunks…" on an approval card: fall back to the per-hunk review dialog. */
  public async reviewApproval(id: string): Promise<void> {
    const approval = this.pendingApprovals.get(id);
    if (approval) {
      this.pendingApprovals.delete(id);
      const finalText = await reviewProposedEdit(approval.rel, approval.original, approval.proposedText);
      approval.resolve(finalText);
    }
  }

  // ---------- post-edit diagnostics feedback (the editor tells the agent what it broke) ----------

  /** Line-independent keys of a file's current diagnostics (errors + warnings). */
  private static diagnosticsKeySet(uri: vscode.Uri): Set<string> {
    const keys = new Set<string>();
    for (const d of vscode.languages.getDiagnostics(uri)) {
      if (d.severity <= vscode.DiagnosticSeverity.Warning) {
        keys.add(ToolExecutor.diagnosticKey(d));
      }
    }
    return keys;
  }

  /** Keyed by severity+source+message (not line) so pre-existing problems that merely shift lines don't count as new. */
  private static diagnosticKey(d: vscode.Diagnostic): string {
    return `${d.severity}|${d.source ?? ''}|${d.message}`;
  }

  /**
   * After an applied edit, give language servers a moment to re-analyze, then report
   * any NEW errors/warnings back to the model — Claude-Code-style self-correction.
   * Opening the document (without showing it) makes language servers analyze files
   * that aren't open in any editor.
   */
  private async newProblemsAfterEdit(uri: vscode.Uri, before: Set<string>): Promise<string> {
    if (this.host.getAbortSignal()?.aborted) {
      return '';
    }
    try {
      await vscode.workspace.openTextDocument(uri);
    } catch {
      return '';
    }
    await waitMs(1500, this.host.getAbortSignal());
    const fresh = vscode.languages
      .getDiagnostics(uri)
      .filter((d) => d.severity <= vscode.DiagnosticSeverity.Warning)
      .filter((d) => !before.has(ToolExecutor.diagnosticKey(d)));
    if (fresh.length === 0) {
      return '';
    }
    fresh.sort((a, b) => a.severity - b.severity || a.range.start.line - b.range.start.line);
    const label = (d: vscode.Diagnostic): string =>
      d.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning';
    const shown = fresh
      .slice(0, 8)
      .map(
        (d) =>
          `- L${d.range.start.line + 1} ${label(d)}: ${d.message.split('\n')[0].slice(0, 200)}${d.source ? ` [${d.source}]` : ''}`
      );
    const more = fresh.length > 8 ? `\n(+${fresh.length - 8} more)` : '';
    dbg('tool', 'post-edit diagnostics', { file: uri.fsPath, fresh: fresh.length });
    return `\n\n⚠ This edit introduced ${fresh.length} new problem(s) according to the editor's diagnostics:\n${shown.join('\n')}${more}\nFix these before moving on (or explain why they are expected).`;
  }

  /** Show a Claude-Code-style inline diff card in the chat for an applied edit. */
  private postFileEdit(rel: string, original: string, applied: string): void {
    const diff = formatUnifiedDiff(original, applied);
    if (diff.added === 0 && diff.removed === 0) {
      return;
    }
    const MAX_ROWS = 500;
    const rows = diff.rows.length > MAX_ROWS ? diff.rows.slice(0, MAX_ROWS) : diff.rows;
    const truncated = diff.rows.length > MAX_ROWS;
    this.host.post({ type: 'fileEdit', path: rel, added: diff.added, removed: diff.removed, rows, truncated });
    this.host.recorder.append({
      kind: 'fileEdit',
      path: rel,
      added: diff.added,
      removed: diff.removed,
      rows,
      truncated,
      status: 'applied',
      isNew: original.length === 0,
      at: new Date().toISOString()
    });
  }

  /** Render an interactive "Apply" card for a chat-mode proposed file change (Cursor-style). */
  public postProposedChange(change: {
    filePath: string;
    originalText: string;
    proposedText: string;
    deleteFile?: boolean;
  }): void {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    // Containment: a chat-mode `File:`/diff block can name an absolute or `..` path;
    // never surface an Apply card that would write outside the workspace.
    if (root) {
      const relCheck = path.relative(root.fsPath, change.filePath);
      if (relCheck === '' || relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
        dbg('edit', `refused out-of-workspace proposed change: ${change.filePath}`);
        return;
      }
    }
    const uri = vscode.Uri.file(change.filePath);
    const rel = root ? path.relative(root.fsPath, change.filePath).replace(/\\/g, '/') : change.filePath;
    const id = `chg${this.changeSeq++}`;
    this.pendingChanges.set(id, {
      uri,
      rel,
      original: change.originalText,
      proposedText: change.proposedText,
      deleteFile: change.deleteFile
    });
    const diff = formatUnifiedDiff(change.originalText, change.proposedText);
    const MAX_ROWS = 500;
    const rows = diff.rows.length > MAX_ROWS ? diff.rows.slice(0, MAX_ROWS) : diff.rows;
    const truncated = diff.rows.length > MAX_ROWS;
    const isNew = change.originalText.length === 0;
    this.host.post({
      type: 'proposedChange',
      id,
      path: rel,
      isNew,
      added: diff.added,
      removed: diff.removed,
      rows,
      truncated
    });
    this.host.recorder.append({
      kind: 'fileEdit',
      id,
      path: rel,
      added: diff.added,
      removed: diff.removed,
      rows,
      truncated,
      status: 'proposed',
      isNew,
      at: new Date().toISOString()
    });
  }

  /** Update a proposed-change transcript entry's status (e.g. after Apply/Dismiss) and re-sync disk. */
  private resolveTranscriptChange(id: string, status: 'applied' | 'dismissed' | 'error'): void {
    const entry = this.host.recorder.entries.find((e) => e.kind === 'fileEdit' && e.id === id);
    if (entry && entry.kind === 'fileEdit') {
      entry.status = status;
      this.host.recorder.syncFile();
    }
  }

  /** Dismiss click on a chat-mode Apply card. */
  public dismissPendingChange(id: string): void {
    this.pendingChanges.delete(id);
    this.host.post({ type: 'changeResolved', id, status: 'dismissed' });
    this.resolveTranscriptChange(id, 'dismissed');
  }

  /** Apply a pending proposed change when the user clicks its inline Apply button. */
  public async applyPendingChange(id: string): Promise<void> {
    const change = this.pendingChanges.get(id);
    if (!change) {
      // No longer pending (already resolved, or the extension reloaded and lost it) —
      // resolve the card anyway so no dead Apply button lingers in the webview.
      this.host.post({ type: 'changeResolved', id, status: 'dismissed' });
      return;
    }
    this.pendingChanges.delete(id);
    if (isSensitiveFile(change.rel)) {
      this.host.post({ type: 'changeResolved', id, status: 'error' });
      this.resolveTranscriptChange(id, 'error');
      await vscode.window.showErrorMessage(`Parley refused to write a sensitive file: ${change.rel}.`);
      return;
    }
    try {
      // The inline Apply click is the confirmation, so apply directly (still checkpointed/revertible).
      // The card already shows the diff, so we just flip it to "Applied" via changeResolved.
      if (change.deleteFile) {
        await this.host.checkpoints.deleteWithCheckpoint(change.uri, `delete ${change.rel}`);
        this.fileReadHashes.delete(change.uri.fsPath);
      } else {
        await this.host.checkpoints.applyWithCheckpoint(change.uri, change.proposedText, `edit ${change.rel}`);
        this.recordFileState(change.uri.fsPath, change.proposedText);
      }
      this.host.post({ type: 'changeResolved', id, status: 'applied' });
      this.resolveTranscriptChange(id, 'applied');
      await this.host.recorder.autosave();
    } catch (error) {
      this.host.post({ type: 'changeResolved', id, status: 'error' });
      this.resolveTranscriptChange(id, 'error');
      await vscode.window.showErrorMessage(
        `Parley could not apply ${change.rel}: ${error instanceof Error ? error.message : 'error'}`
      );
    }
  }

  private async toolRunCommand(call: ToolCall): Promise<string> {
    let args: { command?: string };
    try {
      args = JSON.parse(call.arguments || '{}');
    } catch {
      return 'Error: arguments were not valid JSON.';
    }
    const command = String(args.command ?? '').trim();
    if (!command) {
      return 'Error: command is required.';
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    const mode = this.host.getMode();
    // Full-access mode runs commands without prompting; every other mode confirms —
    // unless the command matches a workspace allowlist rule the user approved earlier.
    if (mode !== 'full' && isCommandAllowed(command, this.allowedCommands())) {
      dbg('tool', 'run_command auto-approved by allowlist', command.slice(0, 120));
    } else if (mode !== 'full') {
      const ALWAYS = 'Always Allow';
      // Only simple, substitution-free commands can be remembered — a compound
      // command's prefix would silently approve an unrelated tail next time.
      const canRemember = isSimpleCommand(command);
      const detail = canRemember
        ? `"${ALWAYS}" also approves future commands that start with this text (this workspace only; ` +
          'review with "Parley: Manage Allowed Commands").'
        : 'This command chains steps or uses command substitution, so it can only be run once — it will not be added to the allowlist.';
      const answer = await vscode.window.showWarningMessage(
        `Parley agent wants to run a command in ${folder?.name ?? 'the workspace'}:\n\n${command}\n\n${detail}`,
        { modal: true },
        ...(canRemember ? ['Run', ALWAYS, 'Skip'] : ['Run', 'Skip'])
      );
      if (answer === ALWAYS) {
        const rules = this.allowedCommands();
        if (!rules.includes(command)) {
          await this.host.state.update('parley.allowedCommands', [...rules, command]);
        }
      } else if (answer !== 'Run') {
        return 'User declined to run the command.';
      }
    }
    const output = await runShellCommand(
      command,
      folder?.uri.fsPath,
      this.host.getSettings().commandTimeoutSeconds * 1000,
      this.host.getAbortSignal()
    );
    // Mirror the command + its full output to a visible channel (Claude-Code/Cursor-style),
    // while still returning the captured output to the model.
    const channel = this.agentChannel();
    channel.appendLine(`$ ${command}`);
    channel.appendLine(output);
    channel.appendLine('');
    channel.show(true);
    return output;
  }

  private agentChannel(): vscode.OutputChannel {
    if (!this.commandChannel) {
      this.commandChannel = vscode.window.createOutputChannel('Parley Agent');
    }
    return this.commandChannel;
  }

  // ---------- command allowlist (workspace-scoped) ----------

  private allowedCommands(): string[] {
    const rules = this.host.state.get<string[]>('parley.allowedCommands', []);
    return Array.isArray(rules) ? rules.filter((r) => typeof r === 'string' && r.trim().length > 0) : [];
  }

  /** Review/remove the workspace's approved agent commands ("Parley: Manage Allowed Commands"). */
  public async manageAllowedCommands(): Promise<void> {
    const rules = this.allowedCommands();
    if (rules.length === 0) {
      await vscode.window.showInformationMessage(
        'Parley: no allowed commands yet. Approve one with "Always Allow" when the agent asks to run a command.'
      );
      return;
    }
    const picks = await vscode.window.showQuickPick(
      rules.map((rule) => ({ label: rule, picked: true })),
      {
        canPickMany: true,
        title: 'Parley: allowed agent commands (uncheck to remove)',
        placeHolder:
          'Checked commands (and anything starting with them + more arguments) run without asking in this workspace'
      }
    );
    if (!picks) {
      return;
    }
    const keep = picks.map((p) => p.label);
    await this.host.state.update('parley.allowedCommands', keep);
    const removed = rules.length - keep.length;
    await vscode.window.showInformationMessage(
      removed > 0
        ? `Parley: removed ${removed} allowed command${removed === 1 ? '' : 's'} (${keep.length} kept).`
        : `Parley: keeping all ${keep.length} allowed command${keep.length === 1 ? '' : 's'}.`
    );
  }
}

/** Best-effort parse of tool-call JSON args for hook payloads. */
function safeParseArgs(argsJson: string): unknown {
  try {
    return JSON.parse(argsJson || '{}');
  } catch {
    return argsJson;
  }
}

/** Line-numbered excerpt of a file for auto-informed staleness replies (capped to stay compact). */
function numberedExcerpt(text: string, maxLines = 200, maxChars = 8000): string {
  const lines = text.split('\n');
  const shown = lines.slice(0, maxLines);
  const width = String(shown.length).length;
  let body = shown.map((line, i) => `${String(i + 1).padStart(width)} | ${line}`).join('\n');
  if (body.length > maxChars) {
    body = `${body.slice(0, maxChars)}\n[… excerpt truncated — call read_file for the rest]`;
  } else if (lines.length > maxLines) {
    body += `\n[… ${lines.length - maxLines} more lines — call read_file with start_line=${maxLines + 1} for the rest]`;
  }
  return body;
}

/** Abort-aware pause that RESOLVES (never rejects) when the signal fires — for best-effort waits. */
function waitMs(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Run a shell command in cwd, returning combined stdout/stderr (clamped head+tail). User-approved per call.
 *  Passing the turn's AbortSignal lets Stop actually kill the child process. */
export function runShellCommand(
  command: string,
  cwd: string | undefined,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<string> {
  return new Promise((resolve) => {
    exec(
      command,
      { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true, signal },
      (error, stdout, stderr) => {
        if (error && (error as { name?: string }).name === 'AbortError') {
          resolve('Command was stopped by the user.');
          return;
        }
        const out = `${stdout ?? ''}${stderr ? `\n[stderr]\n${stderr}` : ''}`.trim();
        // Keep head + tail with an explicit marker — for command output the tail
        // (the actual error) matters most, so never cut it off silently.
        const body = clampMiddle(out, 16000);
        // exec kills on timeout with SIGTERM and sets error.killed — tell the model so it can retry/split.
        if (error && (error as { killed?: boolean }).killed && (error as { signal?: string }).signal) {
          const secs = Math.round(timeoutMs / 1000);
          resolve(
            `[Command exceeded the ${secs}s timeout and was terminated. If it legitimately needs longer (e.g. a big install/build), raise "parley.commandTimeoutSeconds" or split it into smaller steps.]` +
              (body ? `\n\nPartial output:\n${body}` : '')
          );
          return;
        }
        if (error && !out) {
          resolve(`Command failed: ${error.message}`);
        } else {
          resolve(body || '(no output)');
        }
      }
    );
  });
}
