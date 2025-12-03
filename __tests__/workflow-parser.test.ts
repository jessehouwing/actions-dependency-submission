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
      expect(result.dependencies[0]).toEqual({
        owner: 'actions',
        repo: 'checkout',
        ref: 'v4',
        uses: 'actions/checkout@v4'
      })
      expect(result.dependencies[1]).toEqual({
        owner: 'actions',
        repo: 'setup-node',
        ref: 'v4',
        uses: 'actions/setup-node@v4'
      })
      expect(result.dependencies[2]).toEqual({
        owner: 'myorg',
        repo: 'custom-action',
        ref: 'v1',
        uses: 'myorg/custom-action@v1'
      })
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
      expect(result.dependencies[0]).toEqual({
        owner: 'actions',
        repo: 'cache',
        ref: 'v3',
        uses: 'actions/cache@v3'
      })
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
      expect(dependencies[0]).toEqual({
        owner: 'actions',
        repo: 'checkout',
        ref: 'v4',
        uses: 'actions/checkout@v4'
      })
      expect(dependencies[1]).toEqual({
        owner: 'actions',
        repo: 'setup-node',
        ref: 'v4',
        uses: 'actions/setup-node@v4'
      })
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
      expect(dependencies[0]).toEqual({
        owner: 'actions',
        repo: 'cache',
        ref: 'v3',
        uses: 'actions/cache@v3'
      })
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
})
