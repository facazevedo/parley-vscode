import * as vscode from 'vscode';
import { parseFrontmatter } from './outputStyles';

/** Cap a skill's instructions when loaded into context (same cap as rules/styles, but skills can be longer). */
const MAX_SKILL_CHARS = 16000;

/**
 * Agent Skills (Claude-style progressive disclosure): a `.parley/skills/<name>/SKILL.md`
 * defines a skill. Only its `description:` frontmatter is always in the system prompt
 * (a compact roster); the full body is loaded ON DEMAND when the model calls the
 * `load_skill` tool, so many skills cost almost no context until used. The skill's
 * folder can bundle scripts/resources the agent then reads/runs by relative path.
 */

export interface Skill {
  /** Folder name — the value the model passes to load_skill. */
  readonly id: string;
  /** One-liner shown in the always-on roster so the model knows when to load it. */
  readonly description: string;
  /** Full instructions (the SKILL.md body), loaded on demand. */
  readonly instructions: string;
  /** Workspace-relative folder, so the skill can point the agent at its bundled files. */
  readonly dir: string;
}

/** Build a skill from its folder name + SKILL.md contents (pure). Undefined if the body is empty. */
export function skillFromFile(id: string, dir: string, raw: string): Skill | undefined {
  const { description, body } = parseFrontmatter(raw);
  const trimmed = body.trim();
  if (!trimmed) {
    return undefined;
  }
  return {
    id,
    description: description || `The ${id} skill.`,
    instructions: trimmed.slice(0, MAX_SKILL_CHARS),
    dir
  };
}

/** All `.parley/skills/<name>/SKILL.md` across workspace roots (later roots override by id). */
export async function loadSkills(): Promise<Skill[]> {
  const skills: Skill[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const root = vscode.Uri.joinPath(folder.uri, '.parley', 'skills');
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(root);
    } catch {
      continue; // no skills dir in this root
    }
    for (const [name, type] of entries) {
      if (type !== vscode.FileType.Directory) {
        continue;
      }
      try {
        const skillMd = vscode.Uri.joinPath(root, name, 'SKILL.md');
        const raw = Buffer.from(await vscode.workspace.fs.readFile(skillMd)).toString('utf8');
        const skill = skillFromFile(name, `.parley/skills/${name}`, raw);
        if (!skill) {
          continue;
        }
        const existing = skills.findIndex((s) => s.id === skill.id);
        if (existing >= 0) {
          skills[existing] = skill;
        } else {
          skills.push(skill);
        }
      } catch {
        // No SKILL.md or unreadable — skip.
      }
    }
  }
  return skills.sort((a, b) => a.id.localeCompare(b.id));
}
