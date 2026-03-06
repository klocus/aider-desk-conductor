import type { AgentProfile, Extension, ExtensionContext, ToolDefinition } from '@aiderdesk/extensions';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';

interface AgentConfigEntry {
  id: string;
  name: string;
  instructionsFile?: string;
  instructionsFileByMode?: Record<string, string>;
  overrides: Record<string, unknown>;
  overridesByMode?: Record<string, Record<string, unknown>>;
  subagent: {
    enabled: boolean;
    contextMemory: string;
    systemPrompt: string;
    invocationMode: string;
    color: string;
    description: string;
  };
}

interface AgentsConfig {
  defaults: Record<string, unknown>;
  agents: AgentConfigEntry[];
}

type DelegationMode = 'subtask' | 'subagent';

interface AgentDefaults {
  provider: string;
  model: string;
  maxIterations: number;
  minTimeBetweenToolCalls: number;
  enabledServers: string[];
  toolApprovals: Record<string, unknown>;
  toolSettings: Record<string, unknown>;
  includeContextFiles: boolean;
  includeRepoMap: boolean;
  usePowerTools: boolean;
  useAiderTools: boolean;
  useTodoTools: boolean;
  useSubagents: boolean;
  useTaskTools: boolean;
  useMemoryTools: boolean;
  useSkillsTools: boolean;
  useExtensionTools: boolean;
  autoApprove: boolean;
}

interface ConductorConfig {
  delegationMode: DelegationMode;
  defaults: AgentDefaults;
}

function resolveSpecDir(ctx: ExtensionContext): string {
  const taskContext = ctx.getTaskContext()!;
  let taskId = taskContext.data.id;
  let parentId = taskContext.data.parentId;

  while (parentId) {
    const parentTask = ctx.getProjectContext().getTask(parentId);
    if (!parentTask) break;
    taskId = parentTask.data.id;
    parentId = parentTask.data.parentId;
  }

  return path.join(ctx.getProjectDir(), '.aider-desk', 'tasks', taskId);
}

function loadAgents(extensionDir: string, configDefaults: AgentDefaults, delegationMode: string): AgentProfile[] {
  const agentsDir = path.join(extensionDir, 'agents');
  const configPath = path.join(agentsDir, 'index.json');

  const raw = fs.readFileSync(configPath, 'utf-8');
  const config: AgentsConfig = JSON.parse(raw);

  return config.agents.map(entry => {
    const instructionsFile = entry.instructionsFileByMode?.[delegationMode] ?? entry.instructionsFile ?? 'missing.md';
    const mdPath = path.join(agentsDir, instructionsFile);
    let instructions = '';
    try {
      instructions = fs.readFileSync(mdPath, 'utf-8').trim();
      instructions = applyModePlaceholders(instructions, delegationMode);
    } catch {
      instructions = `(Missing instructions file: ${instructionsFile})`;
    }

    const mergedOverrides = {
      ...entry.overrides,
      ...(entry.overridesByMode?.[delegationMode] || {})
    };

    return {
      ...configDefaults,
      ...mergedOverrides,
      id: entry.id,
      name: entry.name,
      customInstructions: instructions,
      subagent: entry.subagent
    } as AgentProfile;
  });
}

const DELEGATE_TOOLS: Record<string, string> = {
  subtask: 'delegate-to-agent',
  subagent: 'subagents---run_task'
};

function applyModePlaceholders(instructions: string, mode: string): string {
  const tool = DELEGATE_TOOLS[mode] ?? mode;
  return instructions.replaceAll('{{DELEGATE_TOOL}}', tool);
}

function loadConfig(extensionDir: string): ConductorConfig {
  const configPath = path.join(extensionDir, 'config.json');
  const raw = fs.readFileSync(configPath, 'utf-8');
  return JSON.parse(raw);
}

export default class ConductorExtension implements Extension {
  static metadata = {
    name: 'Conductor',
    version: '0.1.0',
    description: 'Spec-driven development and agent orchestration inspired by the Augment Intent workflow',
    author: 'Paweł Klockiewicz',
    capabilities: ['agents', 'tools']
  };

  private agents: AgentProfile[] = [];
  private config!: ConductorConfig;
  private extensionDir = '';

  async onLoad(context: ExtensionContext): Promise<void> {
    this.extensionDir = path.resolve(__dirname);
    try {
      this.config = loadConfig(this.extensionDir);
      this.agents = loadAgents(this.extensionDir, this.config.defaults, this.config.delegationMode);
      context.log(
        `Conductor loaded — mode: ${this.config.delegationMode}, ${this.agents.length} agents: ${this.agents.map(a => a.id).join(', ')}`,
        'info'
      );
    } catch (e: any) {
      context.log(`Conductor extension failed to load: ${e.message}`, 'error');
    }
  }

  getAgents(_context: ExtensionContext): AgentProfile[] {
    return this.agents;
  }

  async onAgentProfileUpdated(
    _context: ExtensionContext,
    agentId: string,
    updatedProfile: AgentProfile
  ): Promise<AgentProfile> {
    const idx = this.agents.findIndex(a => a.id === agentId);
    if (idx !== -1) {
      this.agents[idx] = updatedProfile;
    }
    return updatedProfile;
  }

  async onImportantReminders(
    event: any,
    _context: ExtensionContext
  ): Promise<any> {
    try {
      const remindersPath = path.join(this.extensionDir, 'reminders.json');
      const remindersJson = JSON.parse(fs.readFileSync(remindersPath, 'utf-8'));
      
      let reminders = [];
      if (event.profile.id === 'conductor' && remindersJson.conductor) {
        reminders = remindersJson.conductor;
      } else if (remindersJson.subagent) {
        reminders = remindersJson.subagent;
      }
      
      if (reminders.length > 0) {
        const customReminders = `\n<ThisIsImportant>\n${reminders.map((r: string) => `<Reminder>\n${r}\n</Reminder>`).join('\n')}\n</ThisIsImportant>`;
        
        if (event.profile.id === 'conductor') {
          event.remindersContent = customReminders;
        } else {
          event.remindersContent += customReminders;
        }
      }
    } catch (e) {
      _context.log(`[Conductor] Failed to load reminders: ${e}`, 'warn');
    }

    return event;
  }

  getTools(_context: ExtensionContext, _mode: string, agentProfile: AgentProfile): ToolDefinition[] {
    const tools: ToolDefinition[] = [];
    const isWorkflowAgent = Boolean(agentProfile?.id && this.agents.some(a => a.id === agentProfile.id));

    if (isWorkflowAgent) {
      tools.push({
        name: 'update-spec',
        description:
          'Create or update the SPEC.md file with the latest requirements, task breakdowns, and status. This is the central source of truth for the current work.',
        inputSchema: z.object({
          content: z.string().describe('The full markdown content for the SPEC.md file')
        }),
        async execute(input, _signal, ctx) {
          const taskContext = ctx.getTaskContext();
          if (!taskContext) {
            return { isError: true, content: [{ type: 'text' as const, text: 'No active task context' }] };
          }

          const specDir = resolveSpecDir(ctx);
          fs.mkdirSync(specDir, { recursive: true });
          const specPath = path.join(specDir, 'SPEC.md');
          fs.writeFileSync(specPath, (input as any).content, 'utf-8');

          try {
            await taskContext.addFile(specPath, false);
          } catch {
            // File may already be in context
          }

          return { content: [{ type: 'text' as const, text: `SPEC.md updated at ${specPath}` }] };
        }
      });

      tools.push({
        name: 'read-spec',
        description: 'Read the current SPEC.md file contents. Returns empty string if no spec exists yet.',
        inputSchema: z.object({}),
        async execute(_input, _signal, ctx) {
          const taskContext = ctx.getTaskContext();
          if (!taskContext) {
            return { isError: true, content: [{ type: 'text' as const, text: 'No active task context' }] };
          }

          const specPath = path.join(resolveSpecDir(ctx), 'SPEC.md');
          let content = '';
          try {
            content = fs.readFileSync(specPath, 'utf-8');
          } catch {
            content = '(No SPEC.md exists yet)';
          }

          return { content: [{ type: 'text' as const, text: content }] };
        }
      });
    }

    // conductor-only tool: delegate-to-agent (subtask mode only)
    // In subagent mode the native subagents---run_task tool is used instead,
    // which properly blocks the conductor until the specialist finishes.
    if (agentProfile?.id === 'conductor' && this.config.delegationMode === 'subtask') {
      const specialistIds = this.agents.filter(a => a.id !== 'conductor').map(a => a.id);

      tools.push({
        name: 'delegate-to-agent',
        description: `Delegate a task to a specialist subagent. Creates a visible subtask under the current task and runs the subagent inside it, so all work is tracked in the subtask. Available agents: ${specialistIds.join(', ')}`,
        inputSchema: z.object({
          agentId: z.string().describe(`The specialist agent ID to delegate to. One of: ${specialistIds.join(', ')}`),
          taskName: z.string().describe('Short descriptive name for the subtask (e.g., "Create CatComponent")'),
          taskDescription: z
            .string()
            .describe(
              'Detailed task description including: what to do, which files/areas to work on, acceptance criteria, and verification commands. The subagent only sees this text — include ALL necessary context.'
            )
        }),
        execute: async (input, _signal, ctx) => {
          const { agentId, taskName, taskDescription } = input as any;
          const taskContext = ctx.getTaskContext();
          if (!taskContext) {
            return { isError: true, content: [{ type: 'text' as const, text: 'No active task context' }] };
          }

          const profiles = ctx.getProjectContext().getAgentProfiles();
          const profile = profiles.find((p: AgentProfile) => p.id === agentId);

          if (!profile) {
            return {
              isError: true,
              content: [
                { type: 'text' as const, text: `Agent "${agentId}" not found. Available: ${specialistIds.join(', ')}` }
              ]
            };
          }

          ctx.log(`[Conductor] Delegating to ${profile.name} (subtask): ${taskDescription.slice(0, 100)}...`, 'info');

          return this.delegateViaSubtask(ctx, taskContext, profile, taskName, taskDescription);
        }
      });
    }

    return tools;
  }

  /**
   * Subtask mode: creates a child task, sets agent profile, runs via runPrompt.
   * Messages persist in the subtask's context manager.
   */
  private async delegateViaSubtask(
    ctx: ExtensionContext,
    taskContext: ReturnType<ExtensionContext['getTaskContext']> & {},
    profile: AgentProfile,
    taskName: string,
    taskDescription: string
  ) {
    try {
      const parentId = taskContext.data.id;
      const newTask = await ctx.getProjectContext().createTask({
        parentId,
        name: taskName,
        autoApprove: this.config.defaults.autoApprove,
        activate: false,
        sendEvent: true
      });

      const subtaskContext = ctx.getProjectContext().getTask(newTask.id);
      if (!subtaskContext) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Subtask "${taskName}" created (id: ${newTask.id}) but could not get its context.`
            }
          ]
        };
      }

      await subtaskContext.updateTask({ agentProfileId: profile.id });
      await subtaskContext.runPrompt(taskDescription, 'agent');

      let resultSummary = '';
      try {
        const RESULT_MARKER = '<!-- RESULT -->';
        const messages = await subtaskContext.getContextMessages();
        const markedText = [...messages]
          .filter(m => m.role === 'assistant')
          .map(m =>
            (m as any).content
              .filter((p: any) => p.type === 'text')
              .map((p: any) => p.text as string)
              .join('\n')
              .trim()
          )
          .find(t => t.startsWith(RESULT_MARKER));
        if (markedText) {
          // Strip the marker line itself before passing to conductor
          resultSummary = `\n\n--- Subtask Result ---\n${markedText.slice(RESULT_MARKER.length).trimStart()}`;
        } else {
          // Fallback: pick the longest assistant message
          ctx.log(`[Conductor] No ${RESULT_MARKER} marker found in subtask — falling back to longest message`, 'warn');
          const allTexts = [...messages]
            .filter(m => m.role === 'assistant')
            .map(m =>
              (m as any).content
                .filter((p: any) => p.type === 'text')
                .map((p: any) => p.text as string)
                .join('\n')
                .trim()
            )
            .filter(t => t.length > 0);
          const longest = allTexts.reduce((best, t) => (t.length > best.length ? t : best), '');
          if (longest) resultSummary = `\n\n--- Subtask Result ---\n${longest}`;
        }

        await subtaskContext.updateTask({
          state: 'completed',
          completedAt: new Date().toISOString()
        });
      } catch (e: any) {
        ctx.log(`[Conductor] Failed to extract subtask results or update status: ${e.message}`, 'warn');
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: `Subtask "${taskName}" (id: ${newTask.id}) completed by ${profile.name}.${resultSummary}`
          }
        ]
      };
    } catch (e: any) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: `Error delegating to ${profile.name}: ${e.message}` }]
      };
    }
  }
}
