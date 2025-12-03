/**
 * Unit tests for the action's main functionality, src/main.ts
 */
import { jest } from '@jest/globals'
import * as core from '../__fixtures__/core.js'
import * as github from '../__fixtures__/github.js'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// Mocks should be declared before the module being tested is imported.
jest.unstable_mockModule('@actions/core', () => core)
jest.unstable_mockModule('@actions/github', () => github)

// The module being tested should be imported dynamically.
const { run } = await import('../src/main.js')

describe('main.ts', () => {
  let tempDir: string

  beforeEach(() => {
    jest.clearAllMocks()
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'main-test-'))

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
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
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

    expect(core.setOutput).toHaveBeenCalledWith('dependency-count', 1)
    expect(
      github.mockOctokit.rest.dependencyGraph.createRepositorySnapshot
    ).toHaveBeenCalledTimes(1)
    expect(core.setFailed).not.toHaveBeenCalled()
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
