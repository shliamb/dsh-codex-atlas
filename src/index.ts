/**
 * dsh-codex-atlas — Atlas: Spec-Driven Development for DeepSeek Harness.
 *
 * Maintains one shared source of truth per workspace:
 * - `MEMORY.md` — the project map injected into the system prompt;
 * - `SPEC.md` in every module folder — the static local specification;
 * - `JOURNAL.md` — an append-only event log that is never injected into the
 *   prompt and is written only at the end of a session.
 *
 * Four model tools keep the files current (`update_memory`, `update_spec`,
 * `log_session`, `sync_atlas`). The plugin reads and writes local files only:
 * no network calls, no child processes.
 * @module dsh-codex-atlas
 */

import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
// Type-only: brings `ctx.systemPrompt` into the Context interface.
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Stable Cordis plugin name. */
export const name = 'dsh-codex-atlas'

/** Registries the tools and the prompt section mount into. */
export const inject = ['tools', 'systemPrompt']

const MEMORY_FILE = 'MEMORY.md'
const JOURNAL_FILE = 'JOURNAL.md'
const SPEC_FILE = 'SPEC.md'
const BACKUP_DIR = join('.atlas', 'backup')

/** Canonical MEMORY.md section headings, in display order. */
const MEMORY_HEADINGS = {
  overview: '## Обзор',
  modules: '## Модули',
  scenarios: '## Логические цепочки (Scenarios)',
  roadmap: '## Roadmap',
  rules: '## Ограничения (Rules)',
  style: '## Стиль пользователя (User Style)',
} as const

type MemorySection = keyof typeof MEMORY_HEADINGS
const MEMORY_SECTION_KEYS = Object.keys(MEMORY_HEADINGS) as MemorySection[]
const MEMORY_HEADING_VALUES: string[] = Object.values(MEMORY_HEADINGS)

/** Canonical SPEC.md section headings, in display order. */
const SPEC_HEADINGS = {
  purpose: '## Суть работы',
  input: '## Входные данные',
  output: '## Выходные данные',
  logic: '## Логика (Вариации)',
  errors: '## Обработка ошибок',
} as const

type SpecSection = keyof typeof SPEC_HEADINGS
const SPEC_SECTION_KEYS = Object.keys(SPEC_HEADINGS) as SpecSection[]
const SPEC_HEADING_VALUES: string[] = Object.values(SPEC_HEADINGS)

/** Hard cap for the MEMORY.md fragment injected into the system prompt. */
const MAX_MEMORY_PROMPT_CHARS = 6000
/** Scan limits keep `sync_atlas` cheap even in a huge monorepo. */
const MAX_SCAN_ENTRIES = 20000
const MAX_SPECS = 200
const MAX_REPORT_SPECS = 8
const MAX_JOURNAL_MODULE_CHARS = 80
const MAX_JOURNAL_SUMMARY_CHARS = 500
const MAX_MODULE_NAME_CHARS = 120
const MAX_MODULE_SUMMARY_CHARS = 200

/** Directories that never describe project modules. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.atlas', '.cache', '.next', '.nuxt', '.turbo',
  'build', 'dist', 'lib', 'target', 'out', 'bin', 'obj', 'coverage', 'vendor',
])

const MEMORY_TEMPLATE = `# MEMORY.md — Atlas

${MEMORY_HEADINGS.overview}

_Опиши проект в 1–2 предложениях._

${MEMORY_HEADINGS.modules}

_Список модулей: \`- [Название](путь/SPEC.md) — краткое описание\`._

${MEMORY_HEADINGS.scenarios}

_### Название сценария_
_Краткое описание._
_**Шаги:** Шаг 1 (Модуль А -> [SPEC](путь/SPEC.md)) -> Шаг 2 (Модуль Б -> [SPEC](путь/SPEC.md)). Варианты развития._

${MEMORY_HEADINGS.roadmap}

- [ ] _Первые шаги._

${MEMORY_HEADINGS.rules}

- _Что нельзя ломать и трогать._

${MEMORY_HEADINGS.style}

- _Требования к коду, комментариям и диалогу._
`

const JOURNAL_TEMPLATE = `# JOURNAL

<!-- Append-only. Формат: [YYYY-MM-DD HH:MM] [Модуль] Краткое изменение. -->

`

const PROMPT_RULES = `## Atlas (dsh-codex-atlas): Spec-Driven Development

Изучи \`MEMORY.md\`. Следуй сценариям и правилам. Перед изменением кода найди модуль, прочитай его \`SPEC.md\`. Любое изменение логики или форматов данных ОБЯЗАТЕЛЬНО фиксируй в \`SPEC.md\` через \`update_spec\`. В конце сессии вызови \`log_session\`. Файл \`JOURNAL.md\` существует, но читать его без явной необходимости запрещено.

- \`MEMORY.md\` — карта проекта, не журнал: модули, сценарии, Roadmap, ограничения и стиль. Обновляй через \`update_memory\`.
- \`SPEC.md\` — только статика: суть, входы, выходы, логика, ошибки. Никаких журналов.
- \`JOURNAL.md\` — append-only; пишется только в конце сессии.`

const MISSING_MEMORY_INSTRUCTION = `**Атлас не инициализирован: \`MEMORY.md\` отсутствует.** Вызови \`sync_atlas\` с \`action="init"\`, затем заполни карту через \`update_memory\` и создай \`SPEC.md\` для модулей через \`update_spec\`.`

const FOREIGN_MEMORY_INSTRUCTION = `**ВНИМАНИЕ: структура \`MEMORY.md\` не соответствует Atlas.** Остановись. Спроси пользователя: «Я вижу старый файл памяти. Могу ли я просканировать проект, изучить старые файлы и переписать их под новую структуру Atlas?» Если пользователь разрешит — вызови \`sync_atlas\` с \`action="migrate"\` и \`confirm=true\`, просканируй проект и заполни разделы через \`update_memory\`/\`update_spec\`.`

/** State of the workspace Atlas files. */
type MemoryState = 'atlas' | 'missing' | 'foreign'

/** One lossless-JSON tool answer shared by all four tools. */
interface ToolAnswer {
  ok: boolean
  path: string
  message: string
  content: string
}

/** One resolved, workspace-relative SPEC path. */
interface ResolvedSpec {
  abs: string
  rel: string
  title: string
}

/** Workspace paths and parsed contents inspected by `sync_atlas`. */
interface SpecScan {
  paths: string[]
  invalid: string[]
  truncated: boolean
}

/** Section bounds inside a Markdown document. */
interface SectionRange {
  /** Offset of the heading line. */
  start: number
  /** Offset of the next top-level `## ` heading, or the end of the text. */
  end: number
}

const answer = (ok: boolean, path: string, message: string, content = ''): ToolAnswer =>
  ({ ok, path, message, content: content.length > 0 ? content : message })

const fail = (path: string, message: string): ToolAnswer => answer(false, path, message, message)

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function cwdOf(exec: { agent?: Agent }): string | undefined {
  const cwd = exec.agent?.session.header.cwd
  return cwd !== undefined && cwd.length > 0 ? cwd : undefined
}

function memoryPath(cwd: string): string {
  return join(cwd, MEMORY_FILE)
}

function journalPath(cwd: string): string {
  return join(cwd, JOURNAL_FILE)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asMode(value: unknown): 'replace' | 'append' | undefined {
  return value === 'replace' || value === 'append' ? value : undefined
}

function isMemorySection(value: string): value is MemorySection {
  return (MEMORY_SECTION_KEYS as string[]).includes(value)
}

function isSpecSection(value: string): value is SpecSection {
  return (SPEC_SECTION_KEYS as string[]).includes(value)
}

function stamp(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function stampCompact(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}`
}

/** Collapse one field to a single bounded line. */
function lineField(value: string, max: number): string {
  return value
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\t ]+/g, ' ')
    .trim()
    .slice(0, max)
}

/** Collapse one journal field to a single bounded line. */
function journalField(value: string, max: number): string {
  return value
    .replace(/[\r\n]+/g, ' ')
    .replace(/\[/g, '(')
    .replace(/\]/g, ')')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

/* ────────────────────────────── Markdown sections ───────────────────────────── */

function findSection(text: string, heading: string): SectionRange | null {
  const lines = text.split('\n')
  let offset = 0
  let start = -1
  for (const line of lines) {
    if (start === -1) {
      if (line.trimEnd() === heading) start = offset
    } else if (line.startsWith('## ')) {
      return { start, end: offset }
    }
    offset += line.length + 1
  }
  return start === -1 ? null : { start, end: text.length }
}

function setSection(text: string, heading: string, rawBody: string): string {
  const body = rawBody.trim()
  const block = body.length > 0 ? `${heading}\n\n${body}\n` : `${heading}\n`
  const range = findSection(text, heading)
  if (range === null) {
    const base = text.trimEnd()
    return base.length === 0 ? block : `${base}\n\n${block}`
  }
  const before = text.slice(0, range.start).trimEnd()
  const after = text.slice(range.end).trimStart()
  const head = before.length > 0 ? `${before}\n\n` : ''
  const tail = after.length > 0 ? `\n${after}` : ''
  return `${head}${block}${tail}`
}

function appendSection(text: string, heading: string, content: string): string {
  const range = findSection(text, heading)
  const rawExisting = range === null
    ? ''
    : text.slice(range.start + heading.length, range.end).trim()
  // A template placeholder (`_..._`, optionally inside a list item) is meant to
  // be replaced by the first real entry, not kept above it.
  const existing = rawExisting
    .split('\n')
    .filter(line => !/^\s*(?:[-*]\s+(?:\[[ xX]\]\s+)?)?_.*_\s*$/.test(line))
    .join('\n')
    .trim()
  const body = existing.length > 0 ? `${existing}\n\n${content.trim()}` : content.trim()
  return setSection(text, heading, body)
}

function memoryShapeFromText(text: string): 'atlas' | 'foreign' {
  return MEMORY_HEADING_VALUES.every(heading => findSection(text, heading) !== null)
    ? 'atlas'
    : 'foreign'
}

function memoryState(cwd: string): MemoryState {
  const path = memoryPath(cwd)
  if (!existsSync(path)) return 'missing'
  try {
    return memoryShapeFromText(readFileSync(path, 'utf-8'))
  } catch {
    return 'foreign'
  }
}

/** Append the canonical headings to an old file while preserving all of its text. */
function normalizeMemory(text: string): { text: string; added: string[] } {
  const source = text.trim()
  if (source.length === 0) return { text: MEMORY_TEMPLATE, added: [...MEMORY_HEADING_VALUES] }
  let next = /^#\s+\S/m.test(source) ? source : `# MEMORY.md — Atlas\n\n${source}`
  const added: string[] = []
  for (const heading of MEMORY_HEADING_VALUES) {
    if (findSection(next, heading) === null) {
      next = appendSection(next, heading, '_Не описано._')
      added.push(heading)
    }
  }
  return { text: `${next.trimEnd()}\n`, added }
}

/* ──────────────────────────────── Path handling ─────────────────────────────── */

/** Resolve a user-supplied path and reject anything outside the workspace. */
function safeRelative(cwd: string, input: string): { abs: string; rel: string } | null {
  const trimmed = input.trim().replace(/\\/g, '/').replace(/^\.\//, '')
  if (trimmed.length === 0 || trimmed.includes('\0') || isAbsolute(trimmed)) return null
  const abs = resolve(cwd, trimmed)
  const rel = relative(cwd, abs).replace(/\\/g, '/')
  if (rel.length === 0 || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) return null
  return { abs, rel }
}

/** Resolve `module` (a folder, `SPEC.md`, or a non-spec `.md`) to a SPEC.md path. */
function resolveSpecPath(cwd: string, rawModule: string): ResolvedSpec | null {
  const normalized = rawModule.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
  if (normalized.length === 0) return null
  const lower = normalized.toLowerCase()
  let candidate = normalized
  if (lower.endsWith('.md')) {
    if (lower !== SPEC_FILE.toLowerCase() && !lower.endsWith(`/${SPEC_FILE.toLowerCase()}`)) return null
  } else {
    candidate = `${normalized}/${SPEC_FILE}`
  }
  const safe = safeRelative(cwd, candidate)
  if (safe === null) return null
  const segments = safe.rel.split('/')
  if (segments.includes('node_modules') || segments.includes('.git')) return null
  const folder = segments[segments.length - 2]
  return {
    ...safe,
    title: folder !== undefined && folder.length > 0 ? folder : basename(cwd),
  }
}

/** Make a relative path safe to place inside a Markdown link. */
function markdownTarget(path: string): string {
  return /[\s()<>]/.test(path) ? `<${path}>` : path
}

function markdownLabel(value: string): string {
  return lineField(value, MAX_MODULE_NAME_CHARS).replace(/([\\\[\]])/g, '\\$1')
}

/* ──────────────────────────────── File writing ──────────────────────────────── */

function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text, 'utf-8')
}

function ensureJournal(cwd: string): string {
  const path = journalPath(cwd)
  if (!existsSync(path)) writeText(path, JOURNAL_TEMPLATE)
  return path
}

/** Whether the file's last byte is a newline, without reading a growing journal. */
function endsWithNewline(path: string): boolean {
  try {
    const { size } = statSync(path)
    if (size === 0) return true
    const fd = openSync(path, 'r')
    try {
      const last = Buffer.alloc(1)
      readSync(fd, last, 0, 1, size - 1)
      return last[0] === 0x0a
    } finally {
      closeSync(fd)
    }
  } catch {
    return true
  }
}

function appendJournal(cwd: string, moduleName: string, summary: string): { path: string; entry: string } {
  const path = ensureJournal(cwd)
  const entry = `[${stamp()}] [${journalField(moduleName, MAX_JOURNAL_MODULE_CHARS)}] ${journalField(summary, MAX_JOURNAL_SUMMARY_CHARS)}`
  const separator = endsWithNewline(path) ? '' : '\n'
  appendFileSync(path, `${separator}${entry}\n`, 'utf-8')
  return { path, entry }
}

/* ────────────────────────────────── Scanning ────────────────────────────────── */

function scanSpecs(cwd: string): SpecScan {
  const paths: string[] = []
  const invalid: string[] = []
  let visited = 0
  let truncated = false

  const walk = (dir: string): void => {
    if (truncated) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (truncated) return
      visited += 1
      if (visited > MAX_SCAN_ENTRIES) {
        truncated = true
        return
      }
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
        walk(join(dir, entry.name))
        continue
      }
      if (!entry.isFile() || entry.name !== SPEC_FILE) continue
      const abs = join(dir, entry.name)
      const rel = relative(cwd, abs).replace(/\\/g, '/')
      if (paths.length < MAX_SPECS) paths.push(rel)
      else truncated = true
      try {
        if (specShape(readFileSync(abs, 'utf-8')) === 'foreign') invalid.push(rel)
      } catch {
        invalid.push(rel)
      }
    }
  }

  walk(cwd)
  return { paths, invalid, truncated }
}

function specShape(text: string): 'atlas' | 'foreign' {
  return SPEC_HEADING_VALUES.every(heading => findSection(text, heading) !== null)
    ? 'atlas'
    : 'foreign'
}

function atlasReport(cwd: string, state: MemoryState): string {
  const scan = scanSpecs(cwd)
  const lines = [
    `Atlas: ${cwd}`,
    `- MEMORY.md: ${state}`,
    `- JOURNAL.md: ${existsSync(journalPath(cwd)) ? 'present' : 'missing'}`,
    `- SPEC.md: ${scan.paths.length}${scan.truncated ? '+' : ''}${scan.invalid.length > 0 ? ` (invalid: ${scan.invalid.length})` : ''}`,
  ]
  if (scan.paths.length > 0) {
    const shown = scan.paths.slice(0, MAX_REPORT_SPECS)
    lines.push(`- Modules: ${shown.join(', ')}${scan.paths.length > shown.length ? ` (+${scan.paths.length - shown.length})` : ''}`)
  }
  if (scan.invalid.length > 0) {
    const shown = scan.invalid.slice(0, MAX_REPORT_SPECS)
    lines.push(`- Invalid SPEC: ${shown.join(', ')}${scan.invalid.length > shown.length ? ` (+${scan.invalid.length - shown.length})` : ''}`)
  }
  return lines.join('\n')
}

/* ──────────────────────────────── Prompt injection ───────────────────────────── */

function truncateMemory(text: string): string {
  if (text.length <= MAX_MEMORY_PROMPT_CHARS) return text
  let cut = text.slice(0, MAX_MEMORY_PROMPT_CHARS)
  const lastNewline = cut.lastIndexOf('\n')
  if (lastNewline > MAX_MEMORY_PROMPT_CHARS * 0.6) cut = cut.slice(0, lastNewline)
  return `${cut}\n\n[MEMORY.md усечён до ${MAX_MEMORY_PROMPT_CHARS} символов; прочитай файл целиком, если нужно]`
}

function buildPrompt(agent: Agent | undefined): string {
  const cwd = agent?.session.header.cwd
  if (cwd === undefined || cwd.length === 0) return ''
  const state = memoryState(cwd)
  if (state === 'missing') return `${PROMPT_RULES}\n\n${MISSING_MEMORY_INSTRUCTION}`
  if (state === 'foreign') return `${PROMPT_RULES}\n\n${FOREIGN_MEMORY_INSTRUCTION}`
  try {
    return `${PROMPT_RULES}\n\n### MEMORY.md\n\n${truncateMemory(readFileSync(memoryPath(cwd), 'utf-8')).trim()}\n`
  } catch {
    return `${PROMPT_RULES}\n\n${MISSING_MEMORY_INSTRUCTION}`
  }
}

/* ─────────────────────────────────── Tools ──────────────────────────────────── */

const ANSWER_SCHEMA: ToolDefinition['output']['schema'] = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    path: { type: 'string' },
    message: { type: 'string' },
    content: { type: 'string' },
  },
  required: ['ok', 'path', 'message', 'content'],
}

function renderAnswer(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  const v = value as ToolAnswer
  return [{ type: 'text', text: v.content.length > 0 ? v.content : v.message }]
}

const UPDATE_MEMORY_PARAMETERS: ToolDefinition['parameters'] = {
  type: 'object',
  additionalProperties: false,
  properties: {
    section: {
      type: 'string',
      enum: MEMORY_SECTION_KEYS,
      description: 'MEMORY.md section to update.',
    },
    content: { type: 'string', description: 'New section body (Markdown).' },
    mode: {
      type: 'string',
      enum: ['replace', 'append'],
      description: 'replace (default) or append to the section body.',
    },
    module: { type: 'string', description: 'Human-readable module name for a new "Модули" entry.' },
    spec: { type: 'string', description: 'Workspace-relative SPEC.md path (or its module folder).' },
    summary: { type: 'string', description: 'Short description appended to the module link.' },
  },
}

const UPDATE_SPEC_PARAMETERS: ToolDefinition['parameters'] = {
  type: 'object',
  additionalProperties: false,
  properties: {
    module: {
      type: 'string',
      description: 'Workspace-relative module folder or SPEC.md path.',
    },
    section: {
      type: 'string',
      enum: SPEC_SECTION_KEYS,
      description: 'SPEC.md section to update.',
    },
    content: { type: 'string', description: 'New section body (Markdown).' },
    mode: {
      type: 'string',
      enum: ['replace', 'append'],
      description: 'replace (default) or append to the section body.',
    },
  },
  required: ['module'],
}

const LOG_SESSION_PARAMETERS: ToolDefinition['parameters'] = {
  type: 'object',
  additionalProperties: false,
  properties: {
    module: { type: 'string', description: 'Module name, e.g. "auth" or "src/core".' },
    summary: { type: 'string', description: 'What changed — one short line.' },
  },
  required: ['module', 'summary'],
}

const SYNC_ATLAS_PARAMETERS: ToolDefinition['parameters'] = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['check', 'init', 'migrate'],
      description: 'check (default, no writes), init (create missing files), migrate (normalize a foreign MEMORY.md after user confirmation).',
    },
    confirm: {
      type: 'boolean',
      description: 'Required for migrate when MEMORY.md has a foreign structure.',
    },
  },
}

const UPDATE_MEMORY_TOOL: ToolDefinition = {
  name: 'update_memory',
  description:
    'Read or update MEMORY.md, the Atlas project map. No arguments → read. '
    + 'Pass module + spec (+ summary) to append one "Модули" entry. '
    + 'Pass section + content (+ mode) to replace or append one section. '
    + 'Refuses to write while MEMORY.md has a foreign structure: migrate it first via sync_atlas.',
  parameters: UPDATE_MEMORY_PARAMETERS,
  output: { schema: ANSWER_SCHEMA, render: renderAnswer },
  async execute(args, exec) {
    try {
      const cwd = cwdOf(exec)
      if (cwd === undefined) return fail('', 'This session has no working directory.')
      const input = asRecord(args) ?? {}
      const path = memoryPath(cwd)

      const section = asString(input.section)
      const content = asString(input.content)
      const modeInput = asString(input.mode)
      const mode = modeInput === undefined ? 'replace' : asMode(modeInput)
      const moduleName = asString(input.module)
      const spec = asString(input.spec)
      const summary = asString(input.summary)

      const isRead = section === undefined && content === undefined
        && moduleName === undefined && spec === undefined

      if (isRead) {
        if (!existsSync(path)) {
          return fail(path, 'MEMORY.md does not exist. Run sync_atlas with action="init" first.')
        }
        const text = readFileSync(path, 'utf-8')
        const warning = memoryShapeFromText(text) === 'atlas'
          ? ''
          : 'ВНИМАНИЕ: структура MEMORY.md не соответствует Atlas. Сначала согласуй миграцию с пользователем.\n\n'
        return answer(true, path, 'Read MEMORY.md.', `${warning}${text}`)
      }

      const state = memoryState(cwd)
      if (state === 'missing') {
        return fail(path, 'MEMORY.md does not exist. Run sync_atlas with action="init" first.')
      }
      if (state === 'foreign') {
        return fail(path, 'MEMORY.md has a foreign structure. Do not overwrite it: ask the user, then call sync_atlas with action="migrate", confirm=true.')
      }

      if (moduleName !== undefined || spec !== undefined) {
        if (moduleName === undefined || lineField(moduleName, MAX_MODULE_NAME_CHARS).length === 0 || spec === undefined) {
          return fail(path, 'Both `module` and `spec` are required to add a module entry.')
        }
        if (content !== undefined || section !== undefined) {
          return fail(path, 'Use either module/spec or section/content in one call, not both.')
        }
        if (mode === undefined) return fail(path, '`mode` must be "replace" or "append".')
        const resolved = resolveSpecPath(cwd, spec)
        if (resolved === null) {
          return fail(path, '`spec` must be a workspace-relative SPEC.md path (or its module folder).')
        }
        if (!existsSync(resolved.abs)) {
          return fail(path, `SPEC.md not found: ${resolved.rel}. Create it first with update_spec.`)
        }
        const text = readFileSync(path, 'utf-8')
        const cleanSummary = summary === undefined ? '' : lineField(summary, MAX_MODULE_SUMMARY_CHARS)
        const line = `- [${markdownLabel(moduleName)}](${markdownTarget(resolved.rel)})${cleanSummary.length > 0 ? ` — ${cleanSummary}` : ''}`
        const modulesRange = findSection(text, MEMORY_HEADINGS.modules)
        const modulesBody = modulesRange === null ? '' : text.slice(modulesRange.start, modulesRange.end)
        if (modulesBody.includes(`](${resolved.rel})`) || modulesBody.includes(`](<${resolved.rel}>)`)) {
          return answer(true, path, 'Module already listed in MEMORY.md.', `Already listed: ${line}`)
        }
        const next = appendSection(text, MEMORY_HEADINGS.modules, line)
        writeText(path, next)
        return answer(true, path, 'Module entry added to MEMORY.md.', `Added to ${MEMORY_HEADINGS.modules}:\n${line}`)
      }

      if (section === undefined) {
        return fail(path, 'Nothing to update: pass section + content, or module + spec.')
      }
      if (!isMemorySection(section)) {
        return fail(path, `Unknown section: ${section}. Allowed: ${MEMORY_SECTION_KEYS.join(', ')}.`)
      }
      if (mode === undefined) return fail(path, '`mode` must be "replace" or "append".')
      if (content === undefined || content.trim().length === 0) {
        return fail(path, '`content` must not be empty.')
      }

      const text = readFileSync(path, 'utf-8')
      const heading = MEMORY_HEADINGS[section]
      const next = mode === 'append'
        ? appendSection(text, heading, content)
        : setSection(text, heading, content)
      writeText(path, next)
      return answer(true, path, `Updated ${heading}.`, `Updated ${heading} in MEMORY.md.`)
    } catch (error) {
      return fail('', `update_memory failed: ${errorText(error)}`)
    }
  },
}

const UPDATE_SPEC_TOOL: ToolDefinition = {
  name: 'update_spec',
  description:
    'Read or update a module\'s SPEC.md. Pass module (folder or SPEC.md path). '
    + 'With section + content, replace or append one section (creating SPEC.md if missing); '
    + 'without section, read the file. SPEC.md is static: no journals or session logs.',
  parameters: UPDATE_SPEC_PARAMETERS,
  output: { schema: ANSWER_SCHEMA, render: renderAnswer },
  async execute(args, exec) {
    try {
      const cwd = cwdOf(exec)
      if (cwd === undefined) return fail('', 'This session has no working directory.')
      const input = asRecord(args) ?? {}
      const moduleInput = asString(input.module)
      if (moduleInput === undefined || moduleInput.trim().length === 0) {
        return fail('', '`module` is required (a module folder or SPEC.md path).')
      }
      const resolved = resolveSpecPath(cwd, moduleInput)
      if (resolved === null) {
        return fail('', '`module` must point to a workspace-relative SPEC.md or its folder.')
      }
      const section = asString(input.section)
      const content = asString(input.content)
      const modeInput = asString(input.mode)
      const mode = modeInput === undefined ? 'replace' : asMode(modeInput)

      if (section === undefined && content === undefined) {
        if (!existsSync(resolved.abs)) {
          return fail(resolved.abs, `SPEC.md not found: ${resolved.rel}. Pass section + content to create it.`)
        }
        return answer(true, resolved.abs, `Read ${resolved.rel}.`, readFileSync(resolved.abs, 'utf-8'))
      }

      if (section === undefined || content === undefined) {
        return fail(resolved.abs, 'Both `section` and `content` are required to update a SPEC.')
      }
      if (!isSpecSection(section)) {
        return fail(resolved.abs, `Unknown section: ${section}. Allowed: ${SPEC_SECTION_KEYS.join(', ')}.`)
      }
      if (mode === undefined) return fail(resolved.abs, '`mode` must be "replace" or "append".')
      if (content.trim().length === 0) return fail(resolved.abs, '`content` must not be empty.')

      const text = existsSync(resolved.abs)
        ? readFileSync(resolved.abs, 'utf-8')
        : specTemplate(resolved.title)
      const heading = SPEC_HEADINGS[section]
      const next = mode === 'append'
        ? appendSection(text, heading, content)
        : setSection(text, heading, content)
      writeText(resolved.abs, next)
      return answer(true, resolved.abs, `Updated ${heading} in ${resolved.rel}.`, `Updated ${heading} in ${resolved.rel}.`)
    } catch (error) {
      return fail('', `update_spec failed: ${errorText(error)}`)
    }
  },
}

const LOG_SESSION_TOOL: ToolDefinition = {
  name: 'log_session',
  description:
    'Append exactly one line to JOURNAL.md. Call it once at the end of the session. '
    + 'Format: [YYYY-MM-DD HH:MM] [module] summary. JOURNAL.md is append-only and is never read into the prompt.',
  parameters: LOG_SESSION_PARAMETERS,
  output: { schema: ANSWER_SCHEMA, render: renderAnswer },
  async execute(args, exec) {
    try {
      const cwd = cwdOf(exec)
      if (cwd === undefined) return fail('', 'This session has no working directory.')
      const input = asRecord(args) ?? {}
      const moduleName = asString(input.module)
      const summary = asString(input.summary)
      if (moduleName === undefined || journalField(moduleName, MAX_JOURNAL_MODULE_CHARS).length === 0) {
        return fail('', '`module` is required and must not be empty.')
      }
      if (summary === undefined || journalField(summary, MAX_JOURNAL_SUMMARY_CHARS).length === 0) {
        return fail('', '`summary` is required and must not be empty.')
      }
      const result = appendJournal(cwd, moduleName, summary)
      if (exec.agent !== undefined) loggedAgents.add(exec.agent)
      return answer(true, result.path, 'Session logged.', result.entry)
    } catch (error) {
      return fail('', `log_session failed: ${errorText(error)}`)
    }
  },
}

const SYNC_ATLAS_TOOL: ToolDefinition = {
  name: 'sync_atlas',
  description:
    'Check or initialize the Atlas files. action="check" (default) only reports state and never writes. '
    + 'action="init" creates missing MEMORY.md/JOURNAL.md and never overwrites a foreign MEMORY.md. '
    + 'action="migrate" with confirm=true backs up a foreign MEMORY.md and appends the canonical headings while preserving its old text; '
    + 'use it only after the user explicitly allows migration.',
  parameters: SYNC_ATLAS_PARAMETERS,
  output: { schema: ANSWER_SCHEMA, render: renderAnswer },
  async execute(args, exec) {
    try {
      const cwd = cwdOf(exec)
      if (cwd === undefined) return fail('', 'This session has no working directory.')
      const input = asRecord(args) ?? {}
      const actionInput = asString(input.action)
      const action = actionInput === undefined ? 'check' : actionInput
      if (action !== 'check' && action !== 'init' && action !== 'migrate') {
        return fail('', '`action` must be "check", "init", or "migrate".')
      }
      const confirm = input.confirm === true
      const memory = memoryPath(cwd)
      const before = memoryState(cwd)

      if (action === 'check') {
        const report = atlasReport(cwd, before)
        const next = before === 'atlas'
          ? 'Atlas is initialized. Keep MEMORY.md minimal and record logic/format changes in SPEC.md.'
          : before === 'missing'
            ? 'Atlas is not initialized. Call sync_atlas with action="init" to create MEMORY.md and JOURNAL.md.'
            : 'MEMORY.md has a foreign structure. Do not overwrite it silently: ask the user, then call sync_atlas with action="migrate", confirm=true.'
        return answer(before === 'atlas', memory, next, `${report}\n\n${next}`)
      }

      if (action === 'init') {
        if (before === 'foreign') {
          const report = atlasReport(cwd, before)
          return answer(
            false,
            memory,
            'MEMORY.md has a foreign structure; nothing was changed. Ask the user, then call sync_atlas with action="migrate", confirm=true.',
            `${report}\n\nNothing was changed: a foreign MEMORY.md is never overwritten silently.`,
          )
        }
        const created: string[] = []
        if (before === 'missing') {
          writeText(memory, MEMORY_TEMPLATE)
          created.push(MEMORY_FILE)
        }
        const beforeJournal = existsSync(journalPath(cwd))
        ensureJournal(cwd)
        if (!beforeJournal) created.push(JOURNAL_FILE)
        const after = memoryState(cwd)
        const report = atlasReport(cwd, after)
        const createdText = created.length > 0 ? `Created: ${created.join(', ')}.` : 'No files created.'
        return answer(true, memory, createdText, `${createdText}\n\n${report}\n\nFill MEMORY.md via update_memory and create SPEC.md files via update_spec.`)
      }

      // action === 'migrate'
      if (before === 'missing') {
        writeText(memory, MEMORY_TEMPLATE)
        ensureJournal(cwd)
        const after = memoryState(cwd)
        const report = atlasReport(cwd, after)
        return answer(true, memory, 'Atlas initialized.', `Created MEMORY.md and JOURNAL.md.\n\n${report}`)
      }
      if (before === 'atlas') {
        ensureJournal(cwd)
        const report = atlasReport(cwd, 'atlas')
        return answer(true, memory, 'Already Atlas; nothing to migrate.', report)
      }
      if (!confirm) {
        const report = atlasReport(cwd, before)
        return answer(
          false,
          memory,
          'Migration requires explicit user confirmation. Ask the user, then call sync_atlas with action="migrate" and confirm=true.',
          `${report}\n\nNothing was changed.`,
        )
      }

      const oldText = readFileSync(memory, 'utf-8')
      const backupDir = join(cwd, BACKUP_DIR)
      mkdirSync(backupDir, { recursive: true })
      const backup = join(backupDir, `MEMORY-${stampCompact()}.md`)
      copyFileSync(memory, backup)
      const normalized = normalizeMemory(oldText)
      writeText(memory, normalized.text)
      ensureJournal(cwd)
      const backupRel = relative(cwd, backup).replace(/\\/g, '/')
      const added = normalized.added.length > 0
        ? ` Added headings: ${normalized.added.join(', ')}.`
        : ''
      const report = atlasReport(cwd, memoryState(cwd))
      return answer(
        true,
        memory,
        `Migrated MEMORY.md (backup: ${backupRel}).${added}`,
        `Migrated MEMORY.md. Old content is preserved; canonical headings were appended where missing.\nBackup: ${backupRel}${added}\n\n${report}\n\nNow scan the project and organize MEMORY.md via update_memory; create/refresh SPEC.md with update_spec.`,
      )
    } catch (error) {
      return fail('', `sync_atlas failed: ${errorText(error)}`)
    }
  },
}

function specTemplate(title: string): string {
  return `# SPEC: ${title}

${SPEC_HEADINGS.purpose}

_Какую задачу решает модуль._

${SPEC_HEADINGS.input}

_Тип, формат и пример (JSON/текст)._

${SPEC_HEADINGS.output}

_Тип, формат и пример._

${SPEC_HEADINGS.logic}

_Если приходит X — делаем A; если параметр отсутствует — делаем B._

${SPEC_HEADINGS.errors}

_Что делать при сбоях._
`
}

/* ────────────────────────────────── Plugin ──────────────────────────────────── */

/** Agents that already wrote a manual `log_session` entry. */
const loggedAgents = new WeakSet<Agent>()

export function apply(ctx: Context): void {
  ctx.tools.register(UPDATE_MEMORY_TOOL)
  ctx.tools.register(UPDATE_SPEC_TOOL)
  ctx.tools.register(LOG_SESSION_TOOL)
  ctx.tools.register(SYNC_ATLAS_TOOL)

  ctx.systemPrompt.section({
    name: 'dsh-codex-atlas:atlas',
    order: 60,
    text: (context) => {
      try {
        return buildPrompt(context.agent)
      } catch {
        return PROMPT_RULES
      }
    },
  })

  // Safety net: the prompt asks the agent to call log_session, but a session
  // can end without it. Only Atlas projects are touched, and only at dispose.
  ctx.on('agent/disposed', (payload) => {
    try {
      const agent = payload.agent
      const session = agent.session
      const header = session.header
      if (header.origin === 'subagent') return
      if (loggedAgents.has(agent)) return
      const cwd = header.cwd
      if (cwd === undefined || cwd.length === 0) return
      if (memoryState(cwd) !== 'atlas') return
      appendJournal(cwd, 'atlas', `Сессия ${session.id.slice(0, 8)} завершена (автозапись: log_session не вызывался)`)
    } catch (error) {
      ctx.logger.warn(`dsh-codex-atlas: could not append the automatic journal entry: ${errorText(error)}`)
    }
  })
}
