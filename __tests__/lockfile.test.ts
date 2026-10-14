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
const { LockFile, loadVerifiedLockFile } = await import('../src/lockfile.js')

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

const covered = (content: string) =>
  new LockFile(
    `${content}\nworkflows:\n  'ci.yml': []\n  '.github/workflows/ci.yml': []\n`
  )

describe('LockFile', () => {
  it('Returns pinned commits and transitive uses', () => {
    const lock = new LockFile(lockContent)
    expect(lock.getCommit('remote-org/my-action@main')).toBe(SHA)
    expect(lock.getCommit('unknown/action@v1')).toBeUndefined()
    expect(lock.getTransitiveUses('remote-org/my-action@main')).toEqual([
      `actions/cache@${'b'.repeat(40)}`
    ])
  })

  it('Rejects entries with a malformed commit', () => {
    expect(
      () =>
        new LockFile(
          `version: v0.0.3\ndependencies:\n  'a/b@v1':\n    commit: 'nonsense'\n`
        )
    ).toThrow('invalid commit')
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
    parser.setLockFile(covered(lockContent))

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
    parser.setLockFile(covered(lockContent))

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
      [`.github/workflows/actions.lock@${wfSha}`]: `version: v0.0.3\nworkflows:\n  '.github/workflows/w.yml': []\ndependencies:\n  'inner/action@v1':\n    commit: 'sha1-${innerSha}'\n`,
      [`action.yml@${innerSha}`]: `runs:\n  using: composite\n  steps:\n    - uses: deep/action@v2\n`
    })
    parser.setLockFile(
      covered(
        `version: v0.0.3\ndependencies:\n  'remote-org/wf/.github/workflows/w.yml@main':\n    commit: 'sha1-${wfSha}'\n`
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
    parser.setLockFile(covered(lockContent))

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

describe('lock resolution edge cases', () => {
  let tempDir: string
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-edge-'))
  })
  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  const write = (content: string) =>
    fs.writeFileSync(path.join(tempDir, 'ci.yml'), content)

  it('Normalizes action and workflow subpaths for lock lookups', () => {
    const lock = new LockFile(lockContent)
    expect(lock.getCommit('remote-org/my-action/sub/dir@main')).toBe(SHA)
    expect(
      lock.getTransitiveUses('remote-org/my-action/x.yml@main')
    ).toHaveLength(1)
  })

  it('Processes sibling $/ actions separately', async () => {
    write(
      `on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: remote-org/my-action@main\n`
    )
    const { parser } = createParser({
      [`action.yml@${SHA}`]: `runs:\n  using: composite\n  steps:\n    - uses: $/one\n    - uses: $/two\n`,
      [`one/action.yml@${SHA}`]: `runs:\n  using: composite\n  steps:\n    - uses: dep/one@v1\n`,
      [`two/action.yml@${SHA}`]: `runs:\n  using: composite\n  steps:\n    - uses: dep/two@v1\n`
    })
    parser.setLockFile(covered(lockContent))
    const result = await parser.parseWorkflowDirectory(tempDir, [], tempDir)
    const repos = result.actionDependencies.map((d) => d.owner + '/' + d.repo)
    expect(repos).toContain('dep/one')
    expect(repos).toContain('dep/two')
  })

  it('Recovers the full locked graph when actions cannot be fetched', async () => {
    write(
      `on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: a/a@v1\n`
    )
    const { parser } = createParser({})
    parser.setLockFile(
      covered(
        `version: v0.0.3\ndependencies:\n  'a/a@v1':\n    uses: ['b/b@v1']\n  'b/b@v1':\n    uses: ['c/c@v1']\n  'c/c@v1':\n    commit: 'sha1-${SHA}'\n`
      )
    )
    const result = await parser.parseWorkflowDirectory(tempDir, [], tempDir)
    const repos = result.actionDependencies.map((d) => d.repo)
    expect(repos).toEqual(expect.arrayContaining(['b', 'c']))
  })

  it('Resolves $/ in a callable workflow to its locked commit, not the moved ref', async () => {
    const wfSha = 'c'.repeat(40)
    write(
      `on: push\njobs:\n  a:\n    uses: remote-org/wf/.github/workflows/w.yml@main\n`
    )
    const { parser, getContent } = createParser({
      [`.github/workflows/w.yml@${wfSha}`]: `on: workflow_call\njobs:\n  b:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: $/sub\n`,
      [`.github/workflows/actions.lock@${wfSha}`]: `version: v0.0.3\ndependencies: {}\n`,
      [`sub/action.yml@${wfSha}`]: `runs:\n  using: composite\n  steps:\n    - uses: deep/x@v1\n`
    })
    parser.setLockFile(
      covered(
        `version: v0.0.3\ndependencies:\n  'remote-org/wf@main':\n    commit: 'sha1-${wfSha}'\n`
      )
    )
    const result = await parser.parseWorkflowDirectory(tempDir, [], tempDir)
    expect(getContent).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'sub/action.yml', ref: wfSha })
    )
    expect(result.actionDependencies.some((d) => d.owner === 'deep')).toBe(true)
  })
})
describe('pinned refs and lock scoping', () => {
  let tempDir: string
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-pin-'))
  })
  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('Reports the locked commit as the ref of direct and transitive dependencies', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'ci.yml'),
      `on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: remote-org/my-action@main\n`
    )
    const { parser } = createParser({
      [`action.yml@${SHA}`]: `runs:\n  using: composite\n  steps:\n    - uses: actions/cache@v4\n`
    })
    parser.setLockFile(
      covered(
        lockContent +
          `    'actions/cache@v4':\n        commit: 'sha1-${'e'.repeat(40)}'\n`
      )
    )
    const result = await parser.parseWorkflowDirectory(tempDir, [], tempDir)
    const direct = result.actionDependencies.find((d) => d.repo === 'my-action')
    const cache = result.actionDependencies.find((d) => d.repo === 'cache')
    expect(direct).toMatchObject({
      ref: SHA,
      uses: 'remote-org/my-action@main'
    })
    expect(cache?.ref).toBe('e'.repeat(40))
  })

  it('Resolves a remote callable workflow by ref when its own lock does not cover it', async () => {
    const wfSha = 'c'.repeat(40)
    fs.writeFileSync(
      path.join(tempDir, 'ci.yml'),
      `on: push\njobs:\n  a:\n    uses: remote-org/wf/.github/workflows/w.yml@main\n`
    )
    const { parser, getContent } = createParser({
      [`.github/workflows/w.yml@${wfSha}`]: `on: workflow_call\njobs:\n  b:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: inner/action@v1\n`,
      [`.github/workflows/actions.lock@${wfSha}`]: `version: v0.0.3\nworkflows:\n  '.github/workflows/other.yml': []\ndependencies:\n  'inner/action@v1':\n    commit: 'sha1-${'d'.repeat(40)}'\n`,
      [`action.yml@${'f'.repeat(40)}`]: `runs:\n  using: composite\n  steps: []\n`
    })
    parser.setLockFile(
      covered(
        `version: v0.0.3\ndependencies:\n  'remote-org/wf@main':\n    commit: 'sha1-${wfSha}'\n  'inner/action@v1':\n    commit: 'sha1-${'f'.repeat(40)}'\n`
      )
    )
    await parser.parseWorkflowDirectory(tempDir, [], tempDir)
    const refs = getContent.mock.calls.map((call) => call[0].ref)
    expect(refs).toContain('v1')
    expect(refs).not.toContain('f'.repeat(40))
    expect(refs).not.toContain('d'.repeat(40))
  })

  it('Inspects the same symbolic ref separately when locks pin different commits', async () => {
    const sha1 = '1'.repeat(40)
    const sha2 = '2'.repeat(40)
    const wf = () =>
      `on: workflow_call\njobs:\n  b:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: shared/action@main\n`
    fs.writeFileSync(
      path.join(tempDir, 'ci.yml'),
      `on: push\njobs:\n  a:\n    uses: o/one/.github/workflows/w.yml@main\n  b:\n    uses: o/two/.github/workflows/w.yml@main\n`
    )
    const lockFor = (sha: string) =>
      `version: v0.0.3\nworkflows:\n  '.github/workflows/w.yml': []\ndependencies:\n  'shared/action@main':\n    commit: 'sha1-${sha}'\n`
    const { parser, getContent } = createParser({
      [`.github/workflows/w.yml@${'a'.repeat(40)}`]: wf(),
      [`.github/workflows/w.yml@${'b'.repeat(40)}`]: wf(),
      [`.github/workflows/actions.lock@${'a'.repeat(40)}`]: lockFor(sha1),
      [`.github/workflows/actions.lock@${'b'.repeat(40)}`]: lockFor(sha2),
      [`action.yml@${sha1}`]: `runs:\n  using: composite\n  steps: []\n`,
      [`action.yml@${sha2}`]: `runs:\n  using: composite\n  steps: []\n`
    })
    parser.setLockFile(
      covered(
        `version: v0.0.3\ndependencies:\n  'o/one@main':\n    commit: 'sha1-${'a'.repeat(40)}'\n  'o/two@main':\n    commit: 'sha1-${'b'.repeat(40)}'\n`
      )
    )
    await parser.parseWorkflowDirectory(tempDir, [], tempDir)
    const refs = getContent.mock.calls.map((c) => c[0].ref)
    expect(refs).toContain(sha1)
    expect(refs).toContain(sha2)
  })
})
describe('callable workflow locks without a repository lock', () => {
  it('Does not fetch the remote workflow lock when no lock is active', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-none-'))
    fs.writeFileSync(
      path.join(tempDir, 'ci.yml'),
      `on: push\njobs:\n  a:\n    uses: remote-org/wf/.github/workflows/w.yml@main\n`
    )
    const { parser, getContent } = createParser({
      '.github/workflows/w.yml@main': `on: workflow_call\njobs:\n  b:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: inner/action@v1\n`
    })
    await parser.parseWorkflowDirectory(tempDir, [], tempDir)
    const paths = getContent.mock.calls.map((c) => c[0].path)
    expect(paths).not.toContain('.github/workflows/actions.lock')
    fs.rmSync(tempDir, { recursive: true, force: true })
  })
})
describe('scoping and immutable parents', () => {
  let tempDir: string
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-scope-'))
  })
  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('Does not pin dependencies of workflows the lock does not cover', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'other.yml'),
      `on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: remote-org/my-action@main\n`
    )
    const { parser } = createParser({})
    parser.setLockFile(covered(lockContent))
    const result = await parser.parseWorkflowDirectory(tempDir, [], tempDir)
    expect(
      result.actionDependencies.find((d) => d.repo === 'my-action')?.ref
    ).toBe('main')
  })

  it('Resolves an unlocked symbolic parent ref to a commit before reading $/ children', async () => {
    const commit = '9'.repeat(40)
    fs.writeFileSync(
      path.join(tempDir, 'ci.yml'),
      `on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: remote-org/my-action@main\n`
    )
    const files: Record<string, string> = {
      'action.yml@main': `runs:\n  using: composite\n  steps:\n    - uses: $/sub\n`,
      [`action.yml@${commit}`]: `runs:\n  using: composite\n  steps:\n    - uses: $/sub\n`,
      [`sub/action.yml@${commit}`]: `runs:\n  using: composite\n  steps:\n    - uses: actions/cache@v4\n`
    }
    const getContent = jest.fn(
      async (args: { path: string; ref: string }): Promise<unknown> => {
        const content = files[`${args.path}@${args.ref}`]
        if (content === undefined) throw new Error('Not Found')
        return { data: { content: Buffer.from(content).toString('base64') } }
      }
    )
    const getCommit = jest.fn(async () => ({ data: { sha: commit } }))
    const parser = new WorkflowParser('fake-token')
    // @ts-expect-error - Replacing private property for testing
    parser.octokitProvider = {
      getOctokitForRepo: jest
        .fn()
        .mockResolvedValue({ rest: { repos: { getContent, getCommit } } })
    }
    const result = await parser.parseWorkflowDirectory(tempDir, [], tempDir)
    expect(getContent).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'sub/action.yml', ref: commit })
    )
    expect(result.actionDependencies.some((d) => d.repo === 'cache')).toBe(true)
  })
})
describe('loadVerifiedLockFile', () => {
  it('Returns undefined without a lock file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nolock-'))
    expect(await loadVerifiedLockFile(dir, 'token')).toBeUndefined()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('Warns and uses the unverified lock file when gh is not installed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nogh-'))
    fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, '.github', 'workflows', 'actions.lock'),
      lockContent
    )
    const originalPath = process.env.PATH
    const originalWinPath = process.env.Path
    process.env.PATH = dir
    process.env.Path = dir
    try {
      expect(await loadVerifiedLockFile(dir, 'token')).toBeDefined()
    } finally {
      process.env.PATH = originalPath
      if (originalWinPath !== undefined) process.env.Path = originalWinPath
      fs.rmSync(dir, { recursive: true, force: true })
    }
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('GitHub CLI (gh) was not found')
    )
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('could not be verified')
    )
  })
})

describe('path containment and detector version', () => {
  it('Rejects $/ paths escaping the repository, including sibling prefixes', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'esc-'))
    const repo = path.join(base, 'repo')
    fs.mkdirSync(path.join(base, 'repo-secrets'))
    fs.mkdirSync(path.join(repo, 'wf'), { recursive: true })
    fs.writeFileSync(
      path.join(base, 'repo-secrets', 'action.yml'),
      `runs:\n  using: composite\n  steps:\n    - uses: evil/x@v1\n`
    )
    fs.writeFileSync(
      path.join(repo, 'wf', 'ci.yml'),
      `on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: $/../repo-secrets\n`
    )
    const result = await new WorkflowParser().parseWorkflowDirectory(
      path.join(repo, 'wf'),
      [],
      repo
    )
    expect(result.actionDependencies).toHaveLength(0)
    fs.rmSync(base, { recursive: true, force: true })
  })

  it('Keeps DETECTOR_VERSION in sync with package.json', async () => {
    const { DETECTOR_VERSION } = await import('../src/dependency-submitter.js')
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
    expect(DETECTOR_VERSION).toBe(pkg.version)
  })
})

describe('locked and unlocked usages of the same file', () => {
  let tempDir: string
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-both-'))
    fs.mkdirSync(path.join(tempDir, 'extra'))
    fs.mkdirSync(path.join(tempDir, 'local'))
    fs.writeFileSync(
      path.join(tempDir, 'ci.yml'),
      `on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ./local\n`
    )
    fs.writeFileSync(
      path.join(tempDir, 'other.yml'),
      `on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ./local\n`
    )
    fs.writeFileSync(
      path.join(tempDir, 'local', 'action.yml'),
      `runs:\n  using: composite\n  steps:\n    - uses: remote-org/my-action@main\n      shell: bash\n`
    )
  })
  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('Reports a local composite action under both the locked and unlocked workflow', async () => {
    const { parser } = createParser({})
    parser.setLockFile(covered(lockContent))
    const result = await parser.parseWorkflowDirectory(tempDir, [], tempDir)
    const refs = result.actionDependencies
      .filter((d) => d.repo === 'my-action')
      .map((d) => d.ref)
    expect(refs).toContain(SHA)
    expect(refs).toContain('main')
    expect(result.actionDependencies.find((d) => d.ref === SHA)?.locked).toBe(
      true
    )
  })

  it('Also scans additional paths without the lock', async () => {
    fs.rmSync(path.join(tempDir, 'other.yml'))
    const { parser } = createParser({})
    parser.setLockFile(covered(lockContent))
    const result = await parser.parseWorkflowDirectory(
      tempDir,
      ['local'],
      tempDir
    )
    const refs = result.actionDependencies
      .filter((d) => d.repo === 'my-action')
      .map((d) => d.ref)
    expect(refs).toContain(SHA)
    expect(refs).toContain('main')
  })
})

describe('remote lock file failures', () => {
  it('Fails when a callable workflow ships a malformed lock file', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-bad-'))
    const wfSha = 'c'.repeat(40)
    fs.writeFileSync(
      path.join(tempDir, 'ci.yml'),
      `on: push\njobs:\n  a:\n    uses: remote-org/wf/.github/workflows/w.yml@main\n`
    )
    const { parser } = createParser({
      [`.github/workflows/w.yml@${wfSha}`]: `on: workflow_call\njobs:\n  b:\n    runs-on: ubuntu-latest\n    steps: []\n`,
      [`.github/workflows/actions.lock@${wfSha}`]: `dependencies: {}\n`
    })
    parser.setLockFile(
      covered(
        `version: v0.0.3\ndependencies:\n  'remote-org/wf@main':\n    commit: 'sha1-${wfSha}'\n`
      )
    )
    await expect(
      parser.parseWorkflowDirectory(tempDir, [], tempDir)
    ).rejects.toThrow('Malformed')
    fs.rmSync(tempDir, { recursive: true, force: true })
  })
})
