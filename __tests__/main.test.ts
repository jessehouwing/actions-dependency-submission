/**
 * Unit tests for the action's main functionality, src/main.ts
 */
import { jest } from '@jest/globals'
import * as core from '../__fixtures__/core.js'
import * as github from '../__fixtures__/github.js'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

type GhCallback = (error: Error | null, stdout: string, stderr: string) => void
const execFile =
  jest.fn<
    (cmd: string, args: string[], opts: unknown, cb: GhCallback) => void
  >()

// Mocks should be declared before the module being tested is imported.
jest.unstable_mockModule('@actions/core', () => core)
jest.unstable_mockModule('@actions/github', () => github)
jest.unstable_mockModule('child_process', () => ({ execFile }))

// The module being tested should be imported dynamically.
const { run } = await import('../src/main.js')

describe('main.ts', () => {
  let tempDir: string
  let originalWorkspace: string | undefined
  let verificationError: Error | null

  beforeEach(() => {
    jest.clearAllMocks()
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'main-test-'))
    originalWorkspace = process.env.GITHUB_WORKSPACE
    process.env.GITHUB_WORKSPACE = tempDir
    verificationError = null
    fs.mkdirSync(path.join(tempDir, '.github', 'workflows'), {
      recursive: true
    })
    fs.writeFileSync(
      path.join(tempDir, '.github', 'workflows', 'actions.lock'),
      'version: v0.0.3\ndependencies: {}\n'
    )
    execFile.mockImplementation((_cmd, args, _opts, cb) => {
      if (args[0] === '--version') cb(null, 'gh version', '')
      else if (args[0] === 'extension' && args[1] === 'list')
        cb(null, 'gh actions-lock\tgithub/gh-actions-lock\tv0.2.0', '')
      else if (args[0] === 'actions-lock' && args[1] === '--verify')
        cb(verificationError, '', verificationError?.message ?? '')
      else cb(new Error(`Unexpected gh command: ${args.join(' ')}`), '', '')
    })

    // Set default inputs
    core.getInput.mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        token: 'test-token',
        repository: 'test-owner/test-repo',
        'workflow-directory': tempDir,
        'fork-organizations': '',
        'fork-regex': ''
      }
      return inputs[name] || ''
    })
  })

  afterEach(() => {
    if (originalWorkspace === undefined) delete process.env.GITHUB_WORKSPACE
    else process.env.GITHUB_WORKSPACE = originalWorkspace
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
    // Reset github context to default values
    github.context.eventName = 'push'
    github.context.sha = 'test-sha-123'
    github.context.ref = 'refs/heads/main'
    github.context.payload = {}
  })

  it('Processes workflow files and submits dependencies', async () => {
    const workflowContent = `
name: Test Workflow
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`
    fs.writeFileSync(path.join(tempDir, 'test.yml'), workflowContent)

    github.mockOctokit.rest.dependencyGraph.createRepositorySnapshot.mockResolvedValueOnce(
      {}
    )

    await run()

    expect(execFile).toHaveBeenCalledWith(
      'gh',
      ['actions-lock', '--verify', '--no-interactive'],
      expect.objectContaining({
        cwd: tempDir,
        env: expect.objectContaining({ GH_TOKEN: 'test-token' })
      }),
      expect.any(Function)
    )
    expect(core.setOutput).toHaveBeenCalledWith('dependency-count', 1)
    expect(
      github.mockOctokit.rest.dependencyGraph.createRepositorySnapshot
    ).toHaveBeenCalledTimes(1)
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('Uses PR head SHA and ref for pull_request events', async () => {
    // Set up pull_request context
    github.context.eventName = 'pull_request'
    github.context.sha = 'merge-commit-sha-456' // This is the merge commit SHA
    github.context.ref = 'refs/pull/123/merge'
    github.context.payload = {
      pull_request: {
        head: {
          sha: 'pr-head-sha-789',
          ref: 'feature-branch'
        }
      }
    }

    const workflowContent = `
name: PR Workflow
on: pull_request
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`
    fs.writeFileSync(path.join(tempDir, 'test.yml'), workflowContent)

    github.mockOctokit.rest.dependencyGraph.createRepositorySnapshot.mockResolvedValueOnce(
      {}
    )

    await run()

    expect(core.setOutput).toHaveBeenCalledWith('dependency-count', 1)
    expect(
      github.mockOctokit.rest.dependencyGraph.createRepositorySnapshot
    ).toHaveBeenCalledTimes(1)

    // Verify that the snapshot was submitted with the PR head SHA, not the merge commit SHA
    const snapshotCall =
      github.mockOctokit.rest.dependencyGraph.createRepositorySnapshot.mock
        .calls[0][0]
    expect(snapshotCall.sha).toBe('pr-head-sha-789')
    expect(snapshotCall.ref).toBe('refs/heads/feature-branch')

    // Verify info logging
    expect(core.info).toHaveBeenCalledWith(
      'Pull request detected, using head SHA: pr-head-sha-789'
    )
    expect(core.info).toHaveBeenCalledWith(
      'Pull request detected, using head ref: refs/heads/feature-branch'
    )
  })

  it('Uses PR head SHA and ref for pull_request_target events', async () => {
    // Set up pull_request_target context
    github.context.eventName = 'pull_request_target'
    github.context.sha = 'default-branch-sha-456'
    github.context.ref = 'refs/heads/main'
    github.context.payload = {
      pull_request: {
        head: {
          sha: 'pr-head-sha-target-789',
          ref: 'external-feature-branch'
        }
      }
    }

    const workflowContent = `
name: PR Target Workflow
on: pull_request_target
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`
    fs.writeFileSync(path.join(tempDir, 'test.yml'), workflowContent)

    github.mockOctokit.rest.dependencyGraph.createRepositorySnapshot.mockResolvedValueOnce(
      {}
    )

    await run()

    // Verify that the snapshot was submitted with the PR head SHA
    const snapshotCall =
      github.mockOctokit.rest.dependencyGraph.createRepositorySnapshot.mock
        .calls[0][0]
    expect(snapshotCall.sha).toBe('pr-head-sha-target-789')
    expect(snapshotCall.ref).toBe('refs/heads/external-feature-branch')
  })

  it('Handles empty workflow directory', async () => {
    await run()

    expect(core.warning).toHaveBeenCalledWith(
      'No action dependencies found in workflow files'
    )
    expect(core.setOutput).toHaveBeenCalledWith('dependency-count', 0)
  })

  it('Processes forked actions with fork organizations', async () => {
    core.getInput.mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        token: 'test-token',
        repository: 'test-owner/test-repo',
        'workflow-directory': tempDir,
        'fork-organizations': 'myorg',
        'fork-regex': ''
      }
      return inputs[name] || ''
    })

    const workflowContent = `
name: Test Workflow
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: myorg/checkout@v4
`
    fs.writeFileSync(path.join(tempDir, 'test.yml'), workflowContent)

    // WorkflowParser's OctokitProvider will try to fetch remote actions
    // Mock the call for checking myorg/checkout (from WorkflowParser trying to fetch remote action)
    github.mockOctokit.rest.repos.get.mockResolvedValueOnce({
      data: {
        fork: false
      }
    })

    // ForkResolver's OctokitProvider getOctokitForRepo check for myorg/checkout
    github.mockOctokit.rest.repos.get.mockResolvedValueOnce({
      data: {
        fork: false
      }
    })

    // ForkResolver getRepoInfo call to get fork info for myorg/checkout
    github.mockOctokit.rest.repos.get.mockResolvedValueOnce({
      data: {
        fork: true,
        parent: {
          owner: { login: 'actions' },
          name: 'checkout'
        }
      }
    })

    github.mockOctokit.rest.dependencyGraph.createRepositorySnapshot.mockResolvedValueOnce(
      {}
    )

    await run()

    expect(core.setOutput).toHaveBeenCalledWith('dependency-count', 2)
    expect(
      github.mockOctokit.rest.dependencyGraph.createRepositorySnapshot
    ).toHaveBeenCalledTimes(1)
  })

  it('Handles invalid fork regex', async () => {
    core.getInput.mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        token: 'test-token',
        repository: 'test-owner/test-repo',
        'workflow-directory': tempDir,
        'fork-organizations': '',
        'fork-regex': 'invalid[regex'
      }
      return inputs[name] || ''
    })

    await run()

    expect(core.setFailed).toHaveBeenCalled()
  })

  it('Sets failed status on error', async () => {
    core.getInput.mockImplementation(() => {
      throw new Error('Input error')
    })

    await run()

    expect(core.setFailed).toHaveBeenCalledWith('Input error')
  })

  it('Fails without submitting dependencies when lock verification fails', async () => {
    verificationError = new Error('verification rejected')

    await run()

    expect(execFile).toHaveBeenCalledWith(
      'gh',
      ['actions-lock', '--verify', '--no-interactive'],
      expect.anything(),
      expect.any(Function)
    )
    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('failed verification')
    )
    expect(
      github.mockOctokit.rest.dependencyGraph.createRepositorySnapshot
    ).not.toHaveBeenCalled()
    expect(core.setOutput).not.toHaveBeenCalled()
  })

  it('Submits same action dependency for each workflow file that uses it', async () => {
    // Create multiple workflow files that use the same action
    const workflowFiles = [
      'check-dist.yml',
      'ci.yml',
      'codeql-analysis.yml',
      'licensed.yml',
      'linter.yml'
    ]

    for (const file of workflowFiles) {
      const workflowContent = `
name: ${file.replace('.yml', '')}
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
`
      fs.writeFileSync(path.join(tempDir, file), workflowContent)
    }

    github.mockOctokit.rest.dependencyGraph.createRepositorySnapshot.mockResolvedValueOnce(
      {}
    )

    await run()

    // Should submit 5 dependencies (one for each file)
    expect(core.setOutput).toHaveBeenCalledWith('dependency-count', 5)
    expect(
      github.mockOctokit.rest.dependencyGraph.createRepositorySnapshot
    ).toHaveBeenCalledTimes(1)

    // Verify that the snapshot includes separate manifests for each file
    const call =
      github.mockOctokit.rest.dependencyGraph.createRepositorySnapshot.mock
        .calls[0][0]
    const manifests = call.manifests

    // Should have 5 manifests, one for each workflow file
    expect(Object.keys(manifests)).toHaveLength(5)
    for (const file of workflowFiles) {
      // Find the manifest key that ends with the file name
      const manifestKey = Object.keys(manifests).find((key) =>
        key.endsWith(file)
      )
      expect(manifestKey).toBeDefined()
      // Each manifest should have one dependency
      expect(Object.keys(manifests[manifestKey!].resolved)).toHaveLength(1)
    }
  })
})
