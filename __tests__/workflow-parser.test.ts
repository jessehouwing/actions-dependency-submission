/**
 * Unit tests for src/workflow-parser.ts
 */
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest
} from '@jest/globals'
import { WorkflowParser } from '../src/workflow-parser.js'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

describe('WorkflowParser', () => {
  let parser: WorkflowParser
  let tempDir: string

  beforeEach(() => {
    parser = new WorkflowParser()
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-test-'))
  })

  afterEach(() => {
    // Clean up temp directory
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  describe('parseUsesString', () => {
    it('Parses standard action reference', () => {
      const result = parser.parseUsesString('actions/checkout@v4')

      expect(result.dependency).toEqual({
        owner: 'actions',
        repo: 'checkout',
        ref: 'v4',
        uses: 'actions/checkout@v4'
      })
    })

    it('Parses action reference with path', () => {
      const result = parser.parseUsesString('actions/checkout/path@v4')

      expect(result.dependency).toEqual({
        owner: 'actions',
        repo: 'checkout',
        ref: 'v4',
        uses: 'actions/checkout/path@v4',
        actionPath: 'path'
      })
    })

    it('Parses action reference with SHA', () => {
      const result = parser.parseUsesString(
        'actions/checkout@abc123def456abc123def456abc123def456abcd'
      )

      expect(result.dependency).toEqual({
        owner: 'actions',
        repo: 'checkout',
        ref: 'abc123def456abc123def456abc123def456abcd',
        uses: 'actions/checkout@abc123def456abc123def456abc123def456abcd'
      })
    })

    it('Identifies local action references', () => {
      expect(parser.parseUsesString('./local-action')).toEqual({
        isLocal: true,
        path: './local-action'
      })
      expect(parser.parseUsesString('../another-action')).toEqual({
        isLocal: true,
        path: '../another-action'
      })
    })

    it('Returns empty for invalid uses string', () => {
      expect(parser.parseUsesString('invalid')).toEqual({})
      expect(parser.parseUsesString('docker://image:tag')).toEqual({})
    })
  })

  describe('parseWorkflowFile', () => {
    it('Extracts dependencies from valid workflow file', async () => {
      const workflowContent = `
name: Test Workflow
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - uses: myorg/custom-action@v1
`
      const workflowFile = path.join(tempDir, 'test.yml')
      fs.writeFileSync(workflowFile, workflowContent)

      const result = await parser.parseWorkflowFile(workflowFile)

      expect(result.dependencies).toHaveLength(3)
      expect(result.dependencies[0]).toMatchObject({
        owner: 'actions',
        repo: 'checkout',
        ref: 'v4',
        uses: 'actions/checkout@v4'
      })
      expect(result.dependencies[0].sourcePath).toBeDefined()
      expect(result.dependencies[1]).toMatchObject({
        owner: 'actions',
        repo: 'setup-node',
        ref: 'v4',
        uses: 'actions/setup-node@v4'
      })
      expect(result.dependencies[1].sourcePath).toBeDefined()
      expect(result.dependencies[2]).toMatchObject({
        owner: 'myorg',
        repo: 'custom-action',
        ref: 'v1',
        uses: 'myorg/custom-action@v1'
      })
      expect(result.dependencies[2].sourcePath).toBeDefined()
    })

    it('Extracts local action references', async () => {
      const workflowContent = `
name: Test Workflow
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ./local-action
      - uses: ../another-action
`
      const workflowFile = path.join(tempDir, 'test.yml')
      fs.writeFileSync(workflowFile, workflowContent)

      const result = await parser.parseWorkflowFile(workflowFile)

      expect(result.dependencies).toHaveLength(1)
      expect(result.localActions).toHaveLength(2)
      expect(result.localActions[0]).toBe('./local-action')
      expect(result.localActions[1]).toBe('../another-action')
    })

    it('Extracts callable workflow references', async () => {
      const workflowContent = `
name: Test Workflow
on: push
jobs:
  call-workflow:
    uses: ./workflows/reusable.yml
    with:
      input: value
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`
      const workflowFile = path.join(tempDir, 'test.yml')
      fs.writeFileSync(workflowFile, workflowContent)

      const result = await parser.parseWorkflowFile(workflowFile)

      expect(result.callableWorkflows).toHaveLength(1)
      expect(result.callableWorkflows[0]).toBe('./workflows/reusable.yml')
    })

    it('Extracts dependencies from composite action', async () => {
      const actionContent = `
name: Test Action
description: Test composite action
runs:
  using: composite
  steps:
    - uses: actions/cache@v3
    - uses: ./another-action
    - shell: bash
      run: echo "test"
`
      const actionFile = path.join(tempDir, 'action.yml')
      fs.writeFileSync(actionFile, actionContent)

      const result = await parser.parseWorkflowFile(actionFile)

      expect(result.dependencies).toHaveLength(1)
      expect(result.dependencies[0]).toMatchObject({
        owner: 'actions',
        repo: 'cache',
        ref: 'v3',
        uses: 'actions/cache@v3'
      })
      expect(result.dependencies[0].sourcePath).toBeDefined()
      expect(result.localActions).toHaveLength(1)
      expect(result.localActions[0]).toBe('./another-action')
    })

    it('Returns empty arrays for invalid workflow file', async () => {
      const invalidContent = 'not valid yaml ['
      const workflowFile = path.join(tempDir, 'invalid.yml')
      fs.writeFileSync(workflowFile, invalidContent)

      const result = await parser.parseWorkflowFile(workflowFile)

      expect(result.dependencies).toEqual([])
      expect(result.localActions).toEqual([])
      expect(result.callableWorkflows).toEqual([])
    })
  })

  describe('parseWorkflowDirectory', () => {
    it('Scans directory and extracts dependencies', async () => {
      // Create workflow files
      const workflow1 = `
name: Workflow 1
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`
      const workflow2 = `
name: Workflow 2
on: pull_request
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
`
      fs.writeFileSync(path.join(tempDir, 'workflow1.yml'), workflow1)
      fs.writeFileSync(path.join(tempDir, 'workflow2.yml'), workflow2)

      const dependencies = await parser.parseWorkflowDirectory(tempDir)

      expect(dependencies).toHaveLength(2)
      expect(dependencies[0]).toMatchObject({
        owner: 'actions',
        repo: 'checkout',
        ref: 'v4',
        uses: 'actions/checkout@v4'
      })
      expect(dependencies[0].sourcePath).toBeDefined()
      expect(dependencies[1]).toMatchObject({
        owner: 'actions',
        repo: 'setup-node',
        ref: 'v4',
        uses: 'actions/setup-node@v4'
      })
      expect(dependencies[1].sourcePath).toBeDefined()
    })

    it('Handles non-existent directory', async () => {
      const dependencies =
        await parser.parseWorkflowDirectory('/non/existent/path')

      expect(dependencies).toEqual([])
    })

    it('Recursively processes local composite actions when repoRoot provided', async () => {
      // Create workflow that references a local action
      const workflow = `
name: Test
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: ../actions/my-action
`
      fs.mkdirSync(path.join(tempDir, '.github', 'workflows'), {
        recursive: true
      })
      fs.writeFileSync(
        path.join(tempDir, '.github', 'workflows', 'test.yml'),
        workflow
      )

      // Create composite action
      const action = `
name: My Action
description: Test action
runs:
  using: composite
  steps:
    - uses: actions/cache@v3
`
      fs.mkdirSync(path.join(tempDir, '.github', 'actions', 'my-action'), {
        recursive: true
      })
      fs.writeFileSync(
        path.join(tempDir, '.github', 'actions', 'my-action', 'action.yml'),
        action
      )

      const dependencies = await parser.parseWorkflowDirectory(
        path.join(tempDir, '.github', 'workflows'),
        [],
        tempDir
      )

      // Should find the dependency from the composite action
      expect(dependencies).toHaveLength(1)
      expect(dependencies[0]).toMatchObject({
        owner: 'actions',
        repo: 'cache',
        ref: 'v3',
        uses: 'actions/cache@v3'
      })
      expect(dependencies[0].sourcePath).toBeDefined()
    })

    it('Scans additional paths for composite actions', async () => {
      // Create workflow directory
      fs.mkdirSync(path.join(tempDir, '.github', 'workflows'), {
        recursive: true
      })
      fs.writeFileSync(
        path.join(tempDir, '.github', 'workflows', 'test.yml'),
        `
name: Test
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`
      )

      // Create composite action in additional path
      fs.mkdirSync(path.join(tempDir, 'custom', 'actions'), {
        recursive: true
      })
      fs.writeFileSync(
        path.join(tempDir, 'custom', 'actions', 'action.yml'),
        `
name: Custom Action
description: Test action
runs:
  using: composite
  steps:
    - uses: actions/cache@v3
`
      )

      const dependencies = await parser.parseWorkflowDirectory(
        path.join(tempDir, '.github', 'workflows'),
        ['custom/actions'],
        tempDir
      )

      // Should find dependencies from both workflow and additional paths
      expect(dependencies).toHaveLength(2)
      expect(
        dependencies.find((d) => d.uses === 'actions/checkout@v4')
      ).toBeDefined()
      expect(
        dependencies.find((d) => d.uses === 'actions/cache@v3')
      ).toBeDefined()
    })

    it('Scans root action.yml file if it is a composite action', async () => {
      // Create workflow directory with a workflow
      fs.mkdirSync(path.join(tempDir, '.github', 'workflows'), {
        recursive: true
      })
      fs.writeFileSync(
        path.join(tempDir, '.github', 'workflows', 'test.yml'),
        `
name: Test
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`
      )

      // Create root action.yml (composite action)
      fs.writeFileSync(
        path.join(tempDir, 'action.yml'),
        `
name: Root Action
description: Root composite action
runs:
  using: composite
  steps:
    - uses: actions/setup-node@v4
    - uses: actions/cache@v3
`
      )

      const dependencies = await parser.parseWorkflowDirectory(
        path.join(tempDir, '.github', 'workflows'),
        [],
        tempDir
      )

      // Should find dependencies from both workflow and root action.yml
      expect(dependencies).toHaveLength(3)
      expect(
        dependencies.find((d) => d.uses === 'actions/checkout@v4')
      ).toBeDefined()
      expect(
        dependencies.find((d) => d.uses === 'actions/setup-node@v4')
      ).toBeDefined()
      expect(
        dependencies.find((d) => d.uses === 'actions/cache@v3')
      ).toBeDefined()
    })

    it('Scans root action.yaml file if it exists', async () => {
      // Create workflow directory
      fs.mkdirSync(path.join(tempDir, '.github', 'workflows'), {
        recursive: true
      })
      fs.writeFileSync(
        path.join(tempDir, '.github', 'workflows', 'test.yml'),
        `
name: Test
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`
      )

      // Create root action.yaml (composite action)
      fs.writeFileSync(
        path.join(tempDir, 'action.yaml'),
        `
name: Root Action
description: Root composite action
runs:
  using: composite
  steps:
    - uses: github/codeql-action/init@v2
`
      )

      const dependencies = await parser.parseWorkflowDirectory(
        path.join(tempDir, '.github', 'workflows'),
        [],
        tempDir
      )

      // Should find dependencies from both workflow and root action.yaml
      expect(dependencies).toHaveLength(2)
      expect(
        dependencies.find((d) => d.uses === 'actions/checkout@v4')
      ).toBeDefined()
      expect(
        dependencies.find((d) => d.uses === 'github/codeql-action/init@v2')
      ).toBeDefined()
    })

    it('Does not scan root action.yml if it is not a composite action', async () => {
      // Create workflow directory
      fs.mkdirSync(path.join(tempDir, '.github', 'workflows'), {
        recursive: true
      })
      fs.writeFileSync(
        path.join(tempDir, '.github', 'workflows', 'test.yml'),
        `
name: Test
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`
      )

      // Create root action.yml (Docker action, not composite)
      fs.writeFileSync(
        path.join(tempDir, 'action.yml'),
        `
name: Root Action
description: Root Docker action
runs:
  using: docker
  image: Dockerfile
`
      )

      const dependencies = await parser.parseWorkflowDirectory(
        path.join(tempDir, '.github', 'workflows'),
        [],
        tempDir
      )

      // Should only find dependency from workflow, not from root action.yml
      expect(dependencies).toHaveLength(1)
      expect(
        dependencies.find((d) => d.uses === 'actions/checkout@v4')
      ).toBeDefined()
    })

    it('Does not scan root action.yml if repoRoot is not provided', async () => {
      // Create root action.yml (composite action)
      fs.writeFileSync(
        path.join(tempDir, 'action.yml'),
        `
name: Root Action
description: Root composite action
runs:
  using: composite
  steps:
    - uses: actions/cache@v3
`
      )

      // Create workflow directory
      fs.mkdirSync(path.join(tempDir, '.github', 'workflows'), {
        recursive: true
      })
      fs.writeFileSync(
        path.join(tempDir, '.github', 'workflows', 'test.yml'),
        `
name: Test
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`
      )

      // Parse without repoRoot
      const dependencies = await parser.parseWorkflowDirectory(
        path.join(tempDir, '.github', 'workflows')
      )

      // Should only find dependency from workflow
      expect(dependencies).toHaveLength(1)
      expect(
        dependencies.find((d) => d.uses === 'actions/checkout@v4')
      ).toBeDefined()
    })
  })

  describe('YAML anchors and aliases', () => {
    it('Parses workflow with YAML anchor reference', async () => {
      const workflowContent = `
name: Test Anchors
on: push

jobs:
  base-job: &base-job
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
  
  test-job: *base-job
`
      const workflowFile = path.join(tempDir, 'anchor-test.yml')
      fs.writeFileSync(workflowFile, workflowContent)

      const result = await parser.parseWorkflowFile(workflowFile)

      expect(result.dependencies).toHaveLength(4)
      const checkoutDeps = result.dependencies.filter(
        (d) => d.uses === 'actions/checkout@v4'
      )
      const nodeDeps = result.dependencies.filter(
        (d) => d.uses === 'actions/setup-node@v4'
      )
      expect(checkoutDeps).toHaveLength(2)
      expect(nodeDeps).toHaveLength(2)
    })

    it('Parses workflow with YAML merge key', async () => {
      const workflowContent = `
name: Test Merge Keys
on: push

jobs:
  base-job: &base-job
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
  
  extended-job:
    <<: *base-job
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: actions/cache@v3
`
      const workflowFile = path.join(tempDir, 'merge-test.yml')
      fs.writeFileSync(workflowFile, workflowContent)

      const result = await parser.parseWorkflowFile(workflowFile)

      expect(result.dependencies).toHaveLength(4)
      expect(result.dependencies[0]).toMatchObject({
        owner: 'actions',
        repo: 'checkout',
        ref: 'v4'
      })
      expect(result.dependencies[1]).toMatchObject({
        owner: 'actions',
        repo: 'setup-node',
        ref: 'v4'
      })
      expect(result.dependencies[2]).toMatchObject({
        owner: 'actions',
        repo: 'checkout',
        ref: 'v4'
      })
      expect(result.dependencies[3]).toMatchObject({
        owner: 'actions',
        repo: 'cache',
        ref: 'v3'
      })
    })

    it('Parses composite action with YAML anchors', async () => {
      const actionContent = `
name: Test Action with Anchors
description: Test composite action with anchors
runs:
  using: composite
  steps: &common-steps
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4

extra-steps: *common-steps
`
      const actionFile = path.join(tempDir, 'action-anchor.yml')
      fs.writeFileSync(actionFile, actionContent)

      const result = await parser.parseWorkflowFile(actionFile)

      expect(result.dependencies).toHaveLength(2)
      expect(result.dependencies[0]).toMatchObject({
        owner: 'actions',
        repo: 'checkout',
        ref: 'v4'
      })
      expect(result.dependencies[1]).toMatchObject({
        owner: 'actions',
        repo: 'setup-node',
        ref: 'v4'
      })
    })

    it('Handles complex nested YAML anchors', async () => {
      const workflowContent = `
name: Complex Anchors
on: push

x-default-steps: &default-steps
  - uses: actions/checkout@v4

x-node-setup: &node-setup
  - uses: actions/setup-node@v4

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - *default-steps
      - *node-setup
      - uses: actions/cache@v3
`
      const workflowFile = path.join(tempDir, 'complex-anchor.yml')
      fs.writeFileSync(workflowFile, workflowContent)

      const result = await parser.parseWorkflowFile(workflowFile)

      expect(result.dependencies.length).toBeGreaterThan(0)
      const uses = result.dependencies.map((d) => d.uses)
      expect(uses).toContain('actions/cache@v3')
    })

    it('Parses workflow with anchored job-level uses', async () => {
      const workflowContent = `
name: Callable Workflow Anchors
on: push

x-common-workflow: &common-workflow
  uses: ./workflows/reusable.yml

jobs:
  job1: *common-workflow
  
  job2:
    <<: *common-workflow
    with:
      param: value
`
      const workflowFile = path.join(tempDir, 'callable-anchor.yml')
      fs.writeFileSync(workflowFile, workflowContent)

      const result = await parser.parseWorkflowFile(workflowFile)

      expect(result.callableWorkflows).toHaveLength(2)
      expect(result.callableWorkflows[0]).toBe('./workflows/reusable.yml')
      expect(result.callableWorkflows[1]).toBe('./workflows/reusable.yml')
    })
  })

  describe('Remote composite actions and callable workflows', () => {
    it('Does not fetch remote actions when no token provided', async () => {
      const workflowContent = `
name: Test Workflow
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`
      const workflowFile = path.join(tempDir, 'test.yml')
      fs.writeFileSync(workflowFile, workflowContent)

      const parserNoToken = new WorkflowParser()
      const dependencies = await parserNoToken.parseWorkflowDirectory(tempDir)

      expect(dependencies).toHaveLength(1)
      expect(dependencies[0]).toMatchObject({
        owner: 'actions',
        repo: 'checkout',
        ref: 'v4'
      })
      expect(dependencies[0].isTransitive).toBeUndefined()
    })

    it('Marks dependencies from remote composite actions as transitive', async () => {
      // Mock Octokit for fetching remote files
      const mockOctokit = {
        rest: {
          repos: {
            getContent: jest.fn().mockResolvedValue({
              data: {
                content: Buffer.from(
                  `
name: My Remote Action
description: A remote composite action
runs:
  using: composite
  steps:
    - uses: actions/setup-node@v4
    - uses: actions/cache@v3
`
                ).toString('base64')
              }
            })
          }
        }
      }

      // Create a parser with mocked octokit
      const parserWithToken = new WorkflowParser('fake-token')
      // @ts-expect-error - Replacing private property for testing
      parserWithToken.octokitProvider = {
        getOctokitForRepo: jest.fn().mockResolvedValue(mockOctokit),
        getOctokit: jest.fn().mockReturnValue(mockOctokit),
        getPublicOctokit: jest.fn().mockReturnValue(undefined),
        getRepoInfo: jest.fn().mockResolvedValue(undefined),
        repoExists: jest.fn().mockResolvedValue(true)
      }

      const workflowContent = `
name: Test Workflow
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: remote-org/my-composite-action@v1
`
      const workflowFile = path.join(tempDir, 'test.yml')
      fs.writeFileSync(workflowFile, workflowContent)

      const dependencies = await parserWithToken.parseWorkflowDirectory(
        tempDir,
        [],
        tempDir
      )

      // Should have the direct dependency plus transitive dependencies
      expect(dependencies.length).toBeGreaterThanOrEqual(1)

      // Find the direct dependency
      const directDep = dependencies.find(
        (d) => d.owner === 'remote-org' && d.repo === 'my-composite-action'
      )
      expect(directDep).toBeDefined()
      expect(directDep?.isTransitive).toBeUndefined()

      // Find the transitive dependencies
      const transitiveDeps = dependencies.filter((d) => d.isTransitive === true)
      expect(transitiveDeps.length).toBeGreaterThanOrEqual(2)

      const setupNodeDep = transitiveDeps.find(
        (d) => d.owner === 'actions' && d.repo === 'setup-node'
      )
      expect(setupNodeDep).toBeDefined()
      expect(setupNodeDep?.isTransitive).toBe(true)
      expect(setupNodeDep?.ref).toBe('v4')

      const cacheDep = transitiveDeps.find(
        (d) => d.owner === 'actions' && d.repo === 'cache'
      )
      expect(cacheDep).toBeDefined()
      expect(cacheDep?.isTransitive).toBe(true)
      expect(cacheDep?.ref).toBe('v3')
    })

    it('Marks dependencies from remote callable workflows as transitive', async () => {
      // Mock Octokit for fetching remote files
      const mockOctokit = {
        rest: {
          repos: {
            getContent: jest.fn().mockResolvedValue({
              data: {
                content: Buffer.from(
                  `
name: Reusable Workflow
on:
  workflow_call:
    inputs:
      param:
        required: false
        type: string
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
`
                ).toString('base64')
              }
            })
          }
        }
      }

      // Create a parser with mocked octokit
      const parserWithToken = new WorkflowParser('fake-token')
      // @ts-expect-error - Replacing private property for testing
      parserWithToken.octokitProvider = {
        getOctokitForRepo: jest.fn().mockResolvedValue(mockOctokit),
        getOctokit: jest.fn().mockReturnValue(mockOctokit),
        getPublicOctokit: jest.fn().mockReturnValue(undefined),
        getRepoInfo: jest.fn().mockResolvedValue(undefined),
        repoExists: jest.fn().mockResolvedValue(true)
      }

      const workflowContent = `
name: Test Workflow
on: push
jobs:
  call-workflow:
    uses: remote-org/my-repo/.github/workflows/reusable.yml@v1
    with:
      param: value
`
      const workflowFile = path.join(tempDir, 'test.yml')
      fs.writeFileSync(workflowFile, workflowContent)

      const dependencies = await parserWithToken.parseWorkflowDirectory(
        tempDir,
        [],
        tempDir
      )

      // Should have the direct dependency plus transitive dependencies
      expect(dependencies.length).toBeGreaterThanOrEqual(1)

      // Find the direct dependency
      const directDep = dependencies.find(
        (d) => d.owner === 'remote-org' && d.repo === 'my-repo'
      )
      expect(directDep).toBeDefined()
      expect(directDep?.isTransitive).toBeUndefined()

      // Find the transitive dependencies
      const transitiveDeps = dependencies.filter((d) => d.isTransitive === true)
      expect(transitiveDeps.length).toBeGreaterThanOrEqual(2)

      const checkoutDep = transitiveDeps.find(
        (d) => d.owner === 'actions' && d.repo === 'checkout'
      )
      expect(checkoutDep).toBeDefined()
      expect(checkoutDep?.isTransitive).toBe(true)
      expect(checkoutDep?.ref).toBe('v4')

      const setupPythonDep = transitiveDeps.find(
        (d) => d.owner === 'actions' && d.repo === 'setup-python'
      )
      expect(setupPythonDep).toBeDefined()
      expect(setupPythonDep?.isTransitive).toBe(true)
      expect(setupPythonDep?.ref).toBe('v5')
    })

    it('Handles remote actions that are not composite', async () => {
      // Mock Octokit for fetching remote files - returns a non-composite action
      const mockOctokit = {
        rest: {
          repos: {
            getContent: jest.fn().mockResolvedValue({
              data: {
                content: Buffer.from(
                  `
name: My Docker Action
description: A Docker action
runs:
  using: docker
  image: Dockerfile
`
                ).toString('base64')
              }
            })
          }
        }
      }

      // Create a parser with mocked octokit
      const parserWithToken = new WorkflowParser('fake-token')
      // @ts-expect-error - Replacing private property for testing
      parserWithToken.octokitProvider = {
        getOctokitForRepo: jest.fn().mockResolvedValue(mockOctokit),
        getOctokit: jest.fn().mockReturnValue(mockOctokit),
        getPublicOctokit: jest.fn().mockReturnValue(undefined),
        getRepoInfo: jest.fn().mockResolvedValue(undefined),
        repoExists: jest.fn().mockResolvedValue(true)
      }

      const workflowContent = `
name: Test Workflow
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: remote-org/my-docker-action@v1
`
      const workflowFile = path.join(tempDir, 'test.yml')
      fs.writeFileSync(workflowFile, workflowContent)

      const dependencies = await parserWithToken.parseWorkflowDirectory(
        tempDir,
        [],
        tempDir
      )

      // Should only have the direct dependency, no transitive
      expect(dependencies).toHaveLength(1)
      expect(dependencies[0]).toMatchObject({
        owner: 'remote-org',
        repo: 'my-docker-action',
        ref: 'v1'
      })
      expect(dependencies[0].isTransitive).toBeUndefined()
    })

    it('Handles errors when fetching remote actions gracefully', async () => {
      // Mock Octokit for fetching remote files - returns an error
      const mockOctokit = {
        rest: {
          repos: {
            getContent: jest.fn().mockRejectedValue(new Error('Not found'))
          }
        }
      }

      // Create a parser with mocked octokit
      const parserWithToken = new WorkflowParser('fake-token')
      // @ts-expect-error - Replacing private property for testing
      parserWithToken.octokitProvider = {
        getOctokitForRepo: jest.fn().mockResolvedValue(mockOctokit),
        getOctokit: jest.fn().mockReturnValue(mockOctokit),
        getPublicOctokit: jest.fn().mockReturnValue(undefined),
        getRepoInfo: jest.fn().mockResolvedValue(undefined),
        repoExists: jest.fn().mockResolvedValue(true)
      }

      const workflowContent = `
name: Test Workflow
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: remote-org/nonexistent-action@v1
`
      const workflowFile = path.join(tempDir, 'test.yml')
      fs.writeFileSync(workflowFile, workflowContent)

      const dependencies = await parserWithToken.parseWorkflowDirectory(
        tempDir,
        [],
        tempDir
      )

      // Should only have the direct dependency, no transitive
      expect(dependencies).toHaveLength(1)
      expect(dependencies[0]).toMatchObject({
        owner: 'remote-org',
        repo: 'nonexistent-action',
        ref: 'v1'
      })
      expect(dependencies[0].isTransitive).toBeUndefined()
    })

    it('Does not process same remote action multiple times', async () => {
      let fetchCount = 0
      // Mock Octokit for fetching remote files
      const mockOctokit = {
        rest: {
          repos: {
            getContent: jest.fn().mockImplementation(() => {
              fetchCount++
              return Promise.resolve({
                data: {
                  content: Buffer.from(
                    `
name: My Remote Action
description: A remote composite action
runs:
  using: composite
  steps:
    - uses: actions/setup-node@v4
`
                  ).toString('base64')
                }
              })
            })
          }
        }
      }

      // Create a parser with mocked octokit
      const parserWithToken = new WorkflowParser('fake-token')
      // @ts-expect-error - Replacing private property for testing
      parserWithToken.octokitProvider = {
        getOctokitForRepo: jest.fn().mockResolvedValue(mockOctokit),
        getOctokit: jest.fn().mockReturnValue(mockOctokit),
        getPublicOctokit: jest.fn().mockReturnValue(undefined),
        getRepoInfo: jest.fn().mockResolvedValue(undefined),
        repoExists: jest.fn().mockResolvedValue(true)
      }

      // Create two workflows that use the same remote action
      const workflow1 = `
name: Test Workflow 1
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: remote-org/my-composite-action@v1
`
      const workflow2 = `
name: Test Workflow 2
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: remote-org/my-composite-action@v1
`
      fs.writeFileSync(path.join(tempDir, 'workflow1.yml'), workflow1)
      fs.writeFileSync(path.join(tempDir, 'workflow2.yml'), workflow2)

      const dependencies = await parserWithToken.parseWorkflowDirectory(
        tempDir,
        [],
        tempDir
      )

      // Should fetch the remote action only once
      expect(fetchCount).toBe(1)

      // Should have two direct dependencies (one per workflow) plus transitive dependencies
      const directDeps = dependencies.filter(
        (d) => d.owner === 'remote-org' && d.repo === 'my-composite-action'
      )
      expect(directDeps).toHaveLength(2)

      // Should have transitive dependencies
      const transitiveDeps = dependencies.filter((d) => d.isTransitive === true)
      expect(transitiveDeps.length).toBeGreaterThanOrEqual(1)
    })

    it('Transitive dependencies reference the calling workflow as manifest', async () => {
      // Mock Octokit for fetching remote files
      const mockOctokit = {
        rest: {
          repos: {
            getContent: jest.fn().mockResolvedValue({
              data: {
                content: Buffer.from(
                  `
name: My Remote Action
description: A remote composite action
runs:
  using: composite
  steps:
    - uses: actions/setup-node@v4
`
                ).toString('base64')
              }
            })
          }
        }
      }

      // Create a parser with mocked octokit
      const parserWithToken = new WorkflowParser('fake-token')
      // @ts-expect-error - Replacing private property for testing
      parserWithToken.octokitProvider = {
        getOctokitForRepo: jest.fn().mockResolvedValue(mockOctokit),
        getOctokit: jest.fn().mockReturnValue(mockOctokit),
        getPublicOctokit: jest.fn().mockReturnValue(undefined),
        getRepoInfo: jest.fn().mockResolvedValue(undefined),
        repoExists: jest.fn().mockResolvedValue(true)
      }

      const workflowContent = `
name: Test Workflow
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: remote-org/my-composite-action@v1
`
      const workflowFile = path.join(tempDir, 'test.yml')
      fs.writeFileSync(workflowFile, workflowContent)

      const dependencies = await parserWithToken.parseWorkflowDirectory(
        tempDir,
        [],
        tempDir
      )

      // Find the transitive dependencies
      const transitiveDeps = dependencies.filter((d) => d.isTransitive === true)
      expect(transitiveDeps.length).toBeGreaterThanOrEqual(1)

      // All transitive dependencies should reference the calling workflow
      for (const dep of transitiveDeps) {
        expect(dep.sourcePath).toBe('test.yml')
      }
    })

    it('Uses the correct ref when fetching remote composite actions', async () => {
      // Mock Octokit to track calls
      const mockGetContent = jest.fn().mockResolvedValue({
        data: {
          content: Buffer.from(
            `
name: My Remote Action
description: A remote composite action
runs:
  using: composite
  steps:
    - uses: actions/setup-node@v4
`
          ).toString('base64')
        }
      })

      const mockOctokit = {
        rest: {
          repos: {
            getContent: mockGetContent
          }
        }
      }

      // Create a parser with mocked octokit
      const parserWithToken = new WorkflowParser('fake-token')
      // @ts-expect-error - Replacing private property for testing
      parserWithToken.octokitProvider = {
        getOctokitForRepo: jest.fn().mockResolvedValue(mockOctokit),
        getOctokit: jest.fn().mockReturnValue(mockOctokit),
        getPublicOctokit: jest.fn().mockReturnValue(undefined),
        getRepoInfo: jest.fn().mockResolvedValue(undefined),
        repoExists: jest.fn().mockResolvedValue(true)
      }

      const workflowContent = `
name: Test Workflow
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: remote-org/my-composite-action@v2.1.0
`
      const workflowFile = path.join(tempDir, 'test.yml')
      fs.writeFileSync(workflowFile, workflowContent)

      await parserWithToken.parseWorkflowDirectory(tempDir, [], tempDir)

      // Verify getContent was called with the correct ref
      expect(mockGetContent).toHaveBeenCalledWith({
        owner: 'remote-org',
        repo: 'my-composite-action',
        path: 'action.yml',
        ref: 'v2.1.0'
      })
    })

    it('Uses the correct ref when fetching remote callable workflows', async () => {
      // Mock Octokit to track calls
      const mockGetContent = jest.fn().mockResolvedValue({
        data: {
          content: Buffer.from(
            `
name: Reusable Workflow
on:
  workflow_call:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`
          ).toString('base64')
        }
      })

      const mockOctokit = {
        rest: {
          repos: {
            getContent: mockGetContent
          }
        }
      }

      // Create a parser with mocked octokit
      const parserWithToken = new WorkflowParser('fake-token')
      // @ts-expect-error - Replacing private property for testing
      parserWithToken.octokitProvider = {
        getOctokitForRepo: jest.fn().mockResolvedValue(mockOctokit),
        getOctokit: jest.fn().mockReturnValue(mockOctokit),
        getPublicOctokit: jest.fn().mockReturnValue(undefined),
        getRepoInfo: jest.fn().mockResolvedValue(undefined),
        repoExists: jest.fn().mockResolvedValue(true)
      }

      const workflowContent = `
name: Test Workflow
on: push
jobs:
  call-workflow:
    uses: remote-org/my-repo/.github/workflows/reusable.yml@main
`
      const workflowFile = path.join(tempDir, 'test.yml')
      fs.writeFileSync(workflowFile, workflowContent)

      await parserWithToken.parseWorkflowDirectory(tempDir, [], tempDir)

      // Verify getContent was called with the correct ref
      expect(mockGetContent).toHaveBeenCalledWith({
        owner: 'remote-org',
        repo: 'my-repo',
        path: '.github/workflows/reusable.yml',
        ref: 'main'
      })
    })

    it('Uses SHA when provided as ref', async () => {
      // Mock Octokit to track calls
      const mockGetContent = jest.fn().mockResolvedValue({
        data: {
          content: Buffer.from(
            `
name: My Remote Action
description: A remote composite action
runs:
  using: composite
  steps:
    - uses: actions/setup-node@v4
`
          ).toString('base64')
        }
      })

      const mockOctokit = {
        rest: {
          repos: {
            getContent: mockGetContent
          }
        }
      }

      // Create a parser with mocked octokit
      const parserWithToken = new WorkflowParser('fake-token')
      // @ts-expect-error - Replacing private property for testing
      parserWithToken.octokitProvider = {
        getOctokitForRepo: jest.fn().mockResolvedValue(mockOctokit),
        getOctokit: jest.fn().mockReturnValue(mockOctokit),
        getPublicOctokit: jest.fn().mockReturnValue(undefined),
        getRepoInfo: jest.fn().mockResolvedValue(undefined),
        repoExists: jest.fn().mockResolvedValue(true)
      }

      const sha = 'abc123def456abc123def456abc123def456abcd'
      const workflowContent = `
name: Test Workflow
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: remote-org/my-composite-action@${sha}
`
      const workflowFile = path.join(tempDir, 'test.yml')
      fs.writeFileSync(workflowFile, workflowContent)

      await parserWithToken.parseWorkflowDirectory(tempDir, [], tempDir)

      // Verify getContent was called with the SHA
      expect(mockGetContent).toHaveBeenCalledWith({
        owner: 'remote-org',
        repo: 'my-composite-action',
        path: 'action.yml',
        ref: sha
      })
    })

    it('Fetches composite actions from subfolders correctly', async () => {
      // Mock Octokit to track calls
      const mockGetContent = jest.fn().mockResolvedValue({
        data: {
          content: Buffer.from(
            `
name: Subfolder Action
description: A remote composite action in a subfolder
runs:
  using: composite
  steps:
    - uses: actions/setup-node@v4
`
          ).toString('base64')
        }
      })

      const mockOctokit = {
        rest: {
          repos: {
            getContent: mockGetContent
          }
        }
      }

      // Create a parser with mocked octokit
      const parserWithToken = new WorkflowParser('fake-token')
      // @ts-expect-error - Replacing private property for testing
      parserWithToken.octokitProvider = {
        getOctokitForRepo: jest.fn().mockResolvedValue(mockOctokit),
        getOctokit: jest.fn().mockReturnValue(mockOctokit),
        getPublicOctokit: jest.fn().mockReturnValue(undefined),
        getRepoInfo: jest.fn().mockResolvedValue(undefined),
        repoExists: jest.fn().mockResolvedValue(true)
      }

      const workflowContent = `
name: Test Workflow
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: remote-org/my-repo/subfolder@v1
`
      const workflowFile = path.join(tempDir, 'test.yml')
      fs.writeFileSync(workflowFile, workflowContent)

      const dependencies = await parserWithToken.parseWorkflowDirectory(
        tempDir,
        [],
        tempDir
      )

      // Verify getContent was called with the correct path
      expect(mockGetContent).toHaveBeenCalledWith({
        owner: 'remote-org',
        repo: 'my-repo',
        path: 'subfolder/action.yml',
        ref: 'v1'
      })

      // Should have the direct dependency plus transitive dependencies
      expect(dependencies.length).toBeGreaterThanOrEqual(1)

      // Find the direct dependency
      const directDep = dependencies.find(
        (d) => d.owner === 'remote-org' && d.repo === 'my-repo'
      )
      expect(directDep).toBeDefined()
      expect(directDep?.actionPath).toBe('subfolder')
      expect(directDep?.isTransitive).toBeUndefined()

      // Find the transitive dependency
      const transitiveDeps = dependencies.filter((d) => d.isTransitive === true)
      expect(transitiveDeps.length).toBeGreaterThanOrEqual(1)
      const setupNodeDep = transitiveDeps.find(
        (d) => d.owner === 'actions' && d.repo === 'setup-node'
      )
      expect(setupNodeDep).toBeDefined()
    })

    it('Handles nested subfolder paths for composite actions', async () => {
      // Mock Octokit to track calls
      const mockGetContent = jest.fn().mockResolvedValue({
        data: {
          content: Buffer.from(
            `
name: Nested Subfolder Action
description: A composite action in a nested subfolder
runs:
  using: composite
  steps:
    - uses: actions/cache@v3
`
          ).toString('base64')
        }
      })

      const mockOctokit = {
        rest: {
          repos: {
            getContent: mockGetContent
          }
        }
      }

      // Create a parser with mocked octokit
      const parserWithToken = new WorkflowParser('fake-token')
      // @ts-expect-error - Replacing private property for testing
      parserWithToken.octokitProvider = {
        getOctokitForRepo: jest.fn().mockResolvedValue(mockOctokit),
        getOctokit: jest.fn().mockReturnValue(mockOctokit),
        getPublicOctokit: jest.fn().mockReturnValue(undefined),
        getRepoInfo: jest.fn().mockResolvedValue(undefined),
        repoExists: jest.fn().mockResolvedValue(true)
      }

      const workflowContent = `
name: Test Workflow
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: remote-org/my-repo/folder/subfolder@v2.0.0
`
      const workflowFile = path.join(tempDir, 'test.yml')
      fs.writeFileSync(workflowFile, workflowContent)

      await parserWithToken.parseWorkflowDirectory(tempDir, [], tempDir)

      // Verify getContent was called with the correct nested path
      expect(mockGetContent).toHaveBeenCalledWith({
        owner: 'remote-org',
        repo: 'my-repo',
        path: 'folder/subfolder/action.yml',
        ref: 'v2.0.0'
      })
    })

    it('Parses subfolder actions correctly in parseUsesString', () => {
      const parserInstance = new WorkflowParser()

      // Test single level subfolder
      const result1 = parserInstance.parseUsesString('owner/repo/subfolder@v1')
      expect(result1.dependency).toEqual({
        owner: 'owner',
        repo: 'repo',
        ref: 'v1',
        uses: 'owner/repo/subfolder@v1',
        actionPath: 'subfolder'
      })

      // Test nested subfolder
      const result2 = parserInstance.parseUsesString(
        'owner/repo/folder/subfolder@v2'
      )
      expect(result2.dependency).toEqual({
        owner: 'owner',
        repo: 'repo',
        ref: 'v2',
        uses: 'owner/repo/folder/subfolder@v2',
        actionPath: 'folder/subfolder'
      })

      // Test without subfolder
      const result3 = parserInstance.parseUsesString('owner/repo@v3')
      expect(result3.dependency).toEqual({
        owner: 'owner',
        repo: 'repo',
        ref: 'v3',
        uses: 'owner/repo@v3',
        actionPath: undefined
      })
    })
  })
})
