import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { apply } from '../lib/index.js'

const roots = []

after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-codex-atlas-'))
  roots.push(dir)
  return dir
}

function setup() {
  const tools = new Map()
  const sections = []
  const handlers = new Map()
  const ctx = {
    tools: {
      register(tool) {
        tools.set(tool.name, tool)
      },
    },
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {}
      },
    },
    on(event, handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
    },
    logger: { warn() {}, info() {}, error() {} },
  }
  apply(ctx)
  return { tools, sections, handlers }
}

function agentFor(cwd, overrides = {}) {
  return {
    session: {
      id: overrides.id ?? 'sess-1',
      header: {
        cwd,
        origin: overrides.origin ?? 'user',
      },
    },
  }
}

function execFor(agent) {
  return { agent }
}

async function call(tools, name, args, exec) {
  const tool = tools.get(name)
  assert.ok(tool, `tool ${name} is registered`)
  return tool.execute(args, exec)
}

async function dispose(handlers, agent) {
  for (const handler of handlers.get('agent/disposed') ?? []) await handler({ agent })
}

function journalText(cwd) {
  return readFileSync(join(cwd, 'JOURNAL.md'), 'utf-8')
}

test('registers the four tools and the Atlas prompt section', () => {
  const { tools, sections } = setup()
  assert.deepEqual(
    [...tools.keys()].sort(),
    ['log_session', 'sync_atlas', 'update_memory', 'update_spec'],
  )
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'dsh-codex-atlas:atlas')

  const cwd = workspace()
  const prompt = sections[0].text({ agent: agentFor(cwd) })
  assert.match(prompt, /Атлас не инициализирован/)
  assert.match(prompt, /sync_atlas/)
  assert.match(prompt, /JOURNAL\.md/)
})

test('sync_atlas init creates canonical MEMORY.md and JOURNAL.md', async () => {
  const { tools } = setup()
  const cwd = workspace()
  const exec = execFor(agentFor(cwd))

  const check = await call(tools, 'sync_atlas', { action: 'check' }, exec)
  assert.equal(check.ok, false)
  assert.equal(existsSync(join(cwd, 'MEMORY.md')), false)

  const init = await call(tools, 'sync_atlas', { action: 'init' }, exec)
  assert.equal(init.ok, true)
  assert.match(init.content, /Created: MEMORY\.md, JOURNAL\.md\./)

  const memory = readFileSync(join(cwd, 'MEMORY.md'), 'utf-8')
  for (const heading of [
    '## Обзор',
    '## Модули',
    '## Логические цепочки (Scenarios)',
    '## Roadmap',
    '## Ограничения (Rules)',
    '## Стиль пользователя (User Style)',
  ]) {
    assert.ok(memory.includes(heading), `MEMORY.md contains ${heading}`)
  }
  assert.ok(journalText(cwd).startsWith('# JOURNAL'))
})

test('update_spec creates a spec and update_memory maps the module', async () => {
  const { tools } = setup()
  const cwd = workspace()
  const exec = execFor(agentFor(cwd))
  await call(tools, 'sync_atlas', { action: 'init' }, exec)

  const spec = await call(tools, 'update_spec', {
    module: 'src/auth',
    section: 'purpose',
    content: 'Проверяет логин и выдаёт JWT.',
  }, exec)
  assert.equal(spec.ok, true)
  const specPath = join(cwd, 'src', 'auth', 'SPEC.md')
  const specText = readFileSync(specPath, 'utf-8')
  assert.match(specText, /^# SPEC: auth/m)
  assert.match(specText, /## Суть работы\n\nПроверяет логин и выдаёт JWT\./)
  assert.match(specText, /## Входные данные/)

  await call(tools, 'update_memory', {
    section: 'scenarios',
    content: '### Вход\n**Шаги:** Login -> [SPEC](src/auth/SPEC.md).',
  }, exec)

  const added = await call(tools, 'update_memory', {
    module: 'Auth',
    spec: 'src/auth',
    summary: 'Логин и JWT',
  }, exec)
  assert.equal(added.ok, true)
  let memory = readFileSync(join(cwd, 'MEMORY.md'), 'utf-8')
  assert.match(memory, /- \[Auth\]\(src\/auth\/SPEC\.md\) — Логин и JWT/)

  const duplicate = await call(tools, 'update_memory', {
    module: 'Auth',
    spec: 'src/auth/SPEC.md',
  }, exec)
  assert.match(duplicate.message, /already listed/i)

  const roadmap = await call(tools, 'update_memory', {
    section: 'roadmap',
    content: '- [x] JWT готов',
    mode: 'append',
  }, exec)
  assert.equal(roadmap.ok, true)
  memory = readFileSync(join(cwd, 'MEMORY.md'), 'utf-8')
  assert.doesNotMatch(memory, /_Первые шаги\._/)
  assert.match(memory, /- \[x\] JWT готов/)

  const readSpec = await call(tools, 'update_spec', { module: 'src/auth' }, exec)
  assert.match(readSpec.content, /Проверяет логин/)

  const readMemory = await call(tools, 'update_memory', {}, exec)
  assert.match(readMemory.content, /## Обзор/)
})

test('update_spec keeps existing sections and rejects unsafe paths', async () => {
  const { tools } = setup()
  const cwd = workspace()
  const exec = execFor(agentFor(cwd))

  const outside = await call(tools, 'update_spec', {
    module: '../outside',
    section: 'purpose',
    content: 'x',
  }, exec)
  assert.equal(outside.ok, false)

  const wrongFile = await call(tools, 'update_spec', {
    module: 'src/auth/README.md',
    section: 'purpose',
    content: 'x',
  }, exec)
  assert.equal(wrongFile.ok, false)

  await call(tools, 'update_spec', {
    module: 'src/auth',
    section: 'purpose',
    content: 'Первая версия.',
  }, exec)
  await call(tools, 'update_spec', {
    module: 'src/auth',
    section: 'errors',
    content: 'Возвращает 401.',
  }, exec)
  const text = readFileSync(join(cwd, 'src', 'auth', 'SPEC.md'), 'utf-8')
  assert.match(text, /Первая версия\./)
  assert.match(text, /Возвращает 401\./)
})

test('update_memory refuses a foreign MEMORY.md and missing SPEC.md', async () => {
  const { tools } = setup()
  const cwd = workspace()
  const exec = execFor(agentFor(cwd))
  writeFileSync(join(cwd, 'MEMORY.md'), '# Old project memory\n\n## Project Map\n', 'utf-8')

  const foreign = await call(tools, 'update_memory', {
    section: 'roadmap',
    content: '- [ ] x',
  }, exec)
  assert.equal(foreign.ok, false)
  assert.match(foreign.message, /foreign structure/i)

  await call(tools, 'sync_atlas', { action: 'init' }, exec)
  assert.match(readFileSync(join(cwd, 'MEMORY.md'), 'utf-8'), /^# Old project memory/)

  const init = await call(tools, 'sync_atlas', { action: 'migrate' }, exec)
  assert.equal(init.ok, false)

  const migrated = await call(tools, 'sync_atlas', { action: 'migrate', confirm: true }, exec)
  assert.equal(migrated.ok, true)
  assert.match(migrated.message, /backup:/)

  const memory = readFileSync(join(cwd, 'MEMORY.md'), 'utf-8')
  assert.match(memory, /## Обзор/)
  assert.match(memory, /Old project memory/)

  const backups = readdirSync(join(cwd, '.atlas', 'backup'))
  assert.equal(backups.length, 1)
  assert.match(readFileSync(join(cwd, '.atlas', 'backup', backups[0]), 'utf-8'), /Old project memory/)

  const missingSpec = await call(tools, 'update_memory', {
    module: 'Ghost',
    spec: 'src/ghost',
  }, exec)
  assert.equal(missingSpec.ok, false)
  assert.match(missingSpec.message, /SPEC\.md not found/)
})

test('log_session appends the exact journal line and marks the agent', async () => {
  const { tools, handlers } = setup()
  const cwd = workspace()
  const agent = agentFor(cwd)
  const exec = execFor(agent)
  await call(tools, 'sync_atlas', { action: 'init' }, exec)

  const result = await call(tools, 'log_session', { module: 'auth', summary: 'Добавлен JWT' }, exec)
  assert.equal(result.ok, true)
  assert.match(result.content, /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] \[auth\] Добавлен JWT$/m)

  const before = journalText(cwd)
  await dispose(handlers, agent)
  assert.equal(journalText(cwd), before, 'manual log is not duplicated at dispose')

  const rendered = tools.get('log_session').output.render({}, result)
  assert.equal(rendered[0].type, 'text')
  assert.match(rendered[0].text, /auth/)
})

test('auto-log fires for a top-level session without log_session', async () => {
  const { tools, handlers } = setup()
  const cwd = workspace()
  await call(tools, 'sync_atlas', { action: 'init' }, execFor(agentFor(cwd)))

  await dispose(handlers, agentFor(cwd, { id: 'auto-1234' }))
  assert.match(journalText(cwd), /\[atlas\] Сессия auto-123/)

  const subagentCwd = workspace()
  await call(tools, 'sync_atlas', { action: 'init' }, execFor(agentFor(subagentCwd)))
  const before = journalText(subagentCwd)
  await dispose(handlers, agentFor(subagentCwd, { origin: 'subagent' }))
  assert.equal(journalText(subagentCwd), before)
})

test('prompt injects MEMORY.md but never JOURNAL.md', async () => {
  const { tools, sections } = setup()
  const cwd = workspace()
  const exec = execFor(agentFor(cwd))
  await call(tools, 'sync_atlas', { action: 'init' }, exec)
  await call(tools, 'update_memory', {
    section: 'overview',
    content: 'УНИКАЛЬНАЯ_СТРОКА_ПАМЯТИ',
  }, exec)
  await call(tools, 'log_session', {
    module: 'atlas',
    summary: 'СЕКРЕТ_ЖУРНАЛА_НЕ_ДОЛЖЕН_ПОПАСТЬ_В_ПРОМПТ',
  }, exec)

  const prompt = sections[0].text({ agent: agentFor(cwd) })
  assert.match(prompt, /УНИКАЛЬНАЯ_СТРОКА_ПАМЯТИ/)
  assert.doesNotMatch(prompt, /СЕКРЕТ_ЖУРНАЛА_НЕ_ДОЛЖЕН_ПОПАСТЬ_В_ПРОМПТ/)
  assert.match(prompt, /читать его без явной необходимости запрещено/)
})

test('prompt stops on a foreign MEMORY.md and asks the user', () => {
  const { sections } = setup()
  const cwd = workspace()
  writeFileSync(join(cwd, 'MEMORY.md'), '# Project Memory\n\n## Project Map\n', 'utf-8')
  const prompt = sections[0].text({ agent: agentFor(cwd) })
  assert.match(prompt, /структура `MEMORY\.md` не соответствует Atlas/)
  assert.match(prompt, /Я вижу старый файл памяти/)
  assert.match(prompt, /confirm=true/)
})

test('sync_atlas check reports specs without writing', async () => {
  const { tools } = setup()
  const cwd = workspace()
  mkdirSync(join(cwd, 'src', 'core'), { recursive: true })
  writeFileSync(join(cwd, 'src', 'core', 'SPEC.md'), '# SPEC: core\n\n## Суть работы\n\nCore.\n', 'utf-8')
  const before = readdirSync(cwd).sort()

  const result = await call(tools, 'sync_atlas', { action: 'check' }, execFor(agentFor(cwd)))
  assert.equal(result.ok, false)
  assert.match(result.content, /MEMORY\.md: missing/)
  assert.match(result.content, /SPEC\.md: 1/)
  assert.match(result.content, /src\/core\/SPEC\.md/)
  assert.deepEqual(readdirSync(cwd).sort(), before)
})
