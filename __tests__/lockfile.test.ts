import {
  jest,
  describe,
  it,
  expect,
  beforeEach,
  afterEach
} from '@jest/globals'
import * as core from '../__fixtures__/core.js'
import * as github from '../__fixtures__/github.js'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

jest.unstable_mockModule('@actions/core', () => core)
jest.unstable_mockModule('@actions/github', () => github)

const { WorkflowParser } = await import('../src/workflow-parser.js')
const { LockFile } = await import('../src/lockfile.js')

const SHA = 'a'.repeat(40)
const lockContent = `
version: 'v0.0.3'
dependencies:
    'remote-org/my-action@main':
        ref: 'main'
        commit: 'sha1-${SHA}'
        uses:
            - 'actions/cache@${'b'.repeat(40)}'
`

function createParser(files: Record<string, string>) {
  const getContent = jest.fn(
    async (args: { path: string; ref: string }): Promise<unknown> => {
      const content = files[`${args.path}@${args.ref}`]
      if (content === undefined) throw new Error('Not Found')
      return { data: { content: Buffer.from(content).toString('base64') } }
    }
  )
  const octokit = { rest: { repos: { getContent } } }
  const parser = new WorkflowParser('fake-token')
  // @ts-expect-error - Replacing private property for testing
  parser.octokitProvider = {
    getOctokitForRepo: jest.fn().mockResolvedValue(octokit)
  }
  return { parser, getContent }
}

describe('LockFile', () => {
  it('Returns pinned commits and transitive uses', () => {
    const lock = new LockFile(lockContent)
    expect(lock.getCommit('remote-org/my-action@main')).toBe(SHA)
    expect(lock.getCommit('unknown/action@v1')).toBeUndefined()
    expect(lock.getTransitiveUses('remote-org/my-action@main')).toEqual([
      `actions/cache@${'b'.repeat(40)}`
    ])
  })

  it('Ignores malformed commits', () => {
    const lock = new LockFile(
      `dependencies:\n  'a/b@v1':\n    commit: 'nonsense'\n`
    )
    expect(lock.getCommit('a/b@v1')).toBeUndefined()
  })
})

describe('WorkflowParser with lock file and $/ references', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-test-'))
    fs.mkdirSync(path.join(tempDir, '.github', 'workflows'), {
      recursive: true
    })
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  const workflowDir = () => path.join(tempDir, '.github', 'workflows')

  it('Fetches remote actions at the locked commit instead of the moved ref', async () => {
    fs.writeFileSync(
      path.join(workflowDir(), 'ci.yml'),
      `on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: remote-org/my-action@main\n`
    )
    const { parser, getContent } = createParser({
      [`action.yml@${SHA}`]: `runs:\n  using: composite\n  steps:\n    - uses: actions/setup-node@v4\n`
    })
    parser.setLockFile(new LockFile(lockContent))

    const result = await parser.parseWorkflowDirectory(
      workflowDir(),
      [],
      tempDir
    )

    expect(getContent).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'action.yml', ref: SHA })
    )
    expect(result.actionDependencies.some((d) => d.repo === 'setup-node')).toBe(
      true
    )
  })

  it('Falls back to locked transitive uses when the action cannot be fetched', async () => {
    fs.writeFileSync(
      path.join(workflowDir(), 'ci.yml'),
      `on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: remote-org/my-action@main\n`
    )
    const { parser } = createParser({})
    parser.setLockFile(new LockFile(lockContent))

    const result = await parser.parseWorkflowDirectory(
      workflowDir(),
      [],
      tempDir
    )

    const cache = result.actionDependencies.find((d) => d.repo === 'cache')
    expect(cache).toMatchObject({ isTransitive: true, ref: 'b'.repeat(40) })
  })

  it('Uses the callable workflow own lock file for its dependencies', async () => {
    const wfSha = 'c'.repeat(40)
    const innerSha = 'd'.repeat(40)
    fs.writeFileSync(
      path.join(workflowDir(), 'ci.yml'),
      `on: push\njobs:\n  a:\n    uses: remote-org/wf/.github/workflows/w.yml@main\n`
    )
    const { parser, getContent } = createParser({
      [`.github/workflows/w.yml@${wfSha}`]: `on: workflow_call\njobs:\n  b:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: inner/action@v1\n`,
      [`.github/workflows/actions.lock@${wfSha}`]: `dependencies:\n  'inner/action@v1':\n    commit: 'sha1-${innerSha}'\n`,
      [`action.yml@${innerSha}`]: `runs:\n  using: composite\n  steps:\n    - uses: deep/action@v2\n`
    })
    parser.setLockFile(
      new LockFile(
        `dependencies:\n  'remote-org/wf/.github/workflows/w.yml@main':\n    commit: 'sha1-${wfSha}'\n`
      )
    )

    const result = await parser.parseWorkflowDirectory(
      workflowDir(),
      [],
      tempDir
    )

    expect(getContent).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'action.yml', ref: innerSha })
    )
    expect(
      result.actionDependencies.some(
        (d) => d.repo === 'action' && d.owner === 'deep'
      )
    ).toBe(true)
  })

  it('Resolves local $/ references relative to the repository root', async () => {
    fs.mkdirSync(path.join(tempDir, 'my-action'))
    fs.writeFileSync(
      path.join(tempDir, 'my-action', 'action.yml'),
      `runs:\n  using: composite\n  steps:\n    - uses: actions/cache@v4\n`
    )
    fs.writeFileSync(
      path.join(workflowDir(), 'ci.yml'),
      `on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: $/my-action\n`
    )

    const result = await new WorkflowParser().parseWorkflowDirectory(
      workflowDir(),
      [],
      tempDir
    )

    expect(result.actionDependencies.map((d) => d.repo)).toEqual(['cache'])
  })

  it('Resolves $/ references in remote workflows to the same repo and commit', async () => {
    fs.writeFileSync(
      path.join(workflowDir(), 'ci.yml'),
      `on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: remote-org/my-action@main\n`
    )
    const { parser, getContent } = createParser({
      [`action.yml@${SHA}`]: `runs:\n  using: composite\n  steps:\n    - uses: $/sub\n`,
      [`sub/action.yml@${SHA}`]: `runs:\n  using: composite\n  steps:\n    - uses: actions/cache@v4\n`
    })
    parser.setLockFile(new LockFile(lockContent))

    const result = await parser.parseWorkflowDirectory(
      workflowDir(),
      [],
      tempDir
    )

    expect(result.actionDependencies).toContainEqual(
      expect.objectContaining({
        owner: 'remote-org',
        repo: 'my-action',
        ref: SHA,
        actionPath: 'sub',
        isTransitive: true
      })
    )
    expect(getContent).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'sub/action.yml', ref: SHA })
    )
    expect(result.actionDependencies.some((d) => d.repo === 'cache')).toBe(true)
  })
})
