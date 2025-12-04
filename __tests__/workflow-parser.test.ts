/**
 * Unit tests for src/workflow-parser.ts
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
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
        uses: 'actions/checkout/path@v4'
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
})
