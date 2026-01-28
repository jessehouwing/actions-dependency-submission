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
import * as core from '../__fixtures__/core.js'
import * as github from '../__fixtures__/github.js'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// Mock @actions/core and @actions/github before importing WorkflowParser
jest.unstable_mockModule('@actions/core', () => core)
jest.unstable_mockModule('@actions/github', () => github)

// Import after mocking
const { WorkflowParser } = await import('../src/workflow-parser.js')

describe('WorkflowParser', () => {
  let parser: WorkflowParser
  let tempDir: string

  beforeEach(() => {
    jest.clearAllMocks()
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
    })

    it('Parses docker:// references', () => {
      const result = parser.parseUsesString('docker://alpine:latest')
      expect(result.dockerDependency).toBeDefined()
      expect(result.dockerDependency).toMatchObject({
        registry: 'hub.docker.com',
        namespace: 'library',
        image: 'alpine',
        tag: 'latest',
        originalReference: 'docker://alpine:latest'
      })
    })
  })

  describe('parseDockerImage', () => {
    it('Parses simple Docker Hub image', () => {
      const result = parser.parseDockerImage('alpine:3.18')
      expect(result).toEqual({
        registry: 'hub.docker.com',
        namespace: 'library',
        image: 'alpine',
        tag: '3.18',
        originalReference: 'alpine:3.18'
      })
    })

    it('Parses image with namespace', () => {
      const result = parser.parseDockerImage('library/node:18')
      expect(result).toEqual({
        registry: 'hub.docker.com',
        namespace: 'library',
        image: 'node',
        tag: '18',
        originalReference: 'library/node:18'
      })
    })

    it('Parses image without tag (defaults to latest)', () => {
      const result = parser.parseDockerImage('alpine')
      expect(result).toEqual({
        registry: 'hub.docker.com',
        namespace: 'library',
        image: 'alpine',
        tag: 'latest',
        originalReference: 'alpine'
      })
    })

    it('Parses image with digest', () => {
      const result = parser.parseDockerImage('node@sha256:abc123def456')
      expect(result).toEqual({
        registry: 'hub.docker.com',
        namespace: 'library',
        image: 'node',
        digest: 'sha256:abc123def456',
        originalReference: 'node@sha256:abc123def456'
      })
    })

    it('Parses image with tag and digest', () => {
      const result = parser.parseDockerImage('node:18@sha256:abc123def456')
      expect(result).toEqual({
        registry: 'hub.docker.com',
        namespace: 'library',
        image: 'node',
        tag: '18',
        digest: 'sha256:abc123def456',
        originalReference: 'node:18@sha256:abc123def456'
      })
    })

    it('Parses GHCR image', () => {
      const result = parser.parseDockerImage('ghcr.io/owner/image:v1.0.0')
      expect(result).toEqual({
        registry: 'ghcr.io',
        namespace: 'owner',
        image: 'image',
        tag: 'v1.0.0',
        originalReference: 'ghcr.io/owner/image:v1.0.0'
      })
    })

    it('Parses GCR image', () => {
      const result = parser.parseDockerImage('gcr.io/project-id/image:tag')
      expect(result).toEqual({
        registry: 'gcr.io',
        namespace: 'project-id',
        image: 'image',
        tag: 'tag',
        originalReference: 'gcr.io/project-id/image:tag'
      })
    })

    it('Parses docker:// prefix', () => {
      const result = parser.parseDockerImage('docker://alpine:3.18')
      expect(result).toEqual({
        registry: 'hub.docker.com',
        namespace: 'library',
        image: 'alpine',
        tag: '3.18',
        originalReference: 'docker://alpine:3.18'
      })
    })

    it('Returns null for empty string', () => {
      const result = parser.parseDockerImage('')
      expect(result).toBeNull()
    })

    it('Returns null for whitespace only', () => {
      const result = parser.parseDockerImage('   ')
      expect(result).toBeNull()
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
      expect(result.dockerDependencies).toEqual([])
    })

    it('Extracts Docker images from job container', async () => {
      const workflowContent = `
name: Test Workflow
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    container:
      image: node:18-alpine
    steps:
      - uses: actions/checkout@v4
`
      const workflowFile = path.join(tempDir, 'test.yml')
      fs.writeFileSync(workflowFile, workflowContent)

      const result = await parser.parseWorkflowFile(workflowFile)

      expect(result.dockerDependencies).toHaveLength(1)
      expect(result.dockerDependencies[0]).toMatchObject({
        registry: 'hub.docker.com',
        namespace: 'library',
        image: 'node',
        tag: '18-alpine',
        context: 'container'
      })
      expect(result.dockerDependencies[0].sourcePath).toBeDefined()
    })

    it('Extracts Docker images from service containers', async () => {
      const workflowContent = `
name: Test Workflow
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:14
      redis:
        image: redis:7-alpine
    steps:
      - uses: actions/checkout@v4
`
      const workflowFile = path.join(tempDir, 'test.yml')
      fs.writeFileSync(workflowFile, workflowContent)

      const result = await parser.parseWorkflowFile(workflowFile)

      expect(result.dockerDependencies).toHaveLength(2)
      expect(result.dockerDependencies[0]).toMatchObject({
        registry: 'hub.docker.com',
        namespace: 'library',
        image: 'postgres',
        tag: '14',
        context: 'service'
      })
      expect(result.dockerDependencies[1]).toMatchObject({
        registry: 'hub.docker.com',
        namespace: 'library',
        image: 'redis',
        tag: '7-alpine',
        context: 'service'
      })
    })

    it('Extracts Docker images from step uses with docker://', async () => {
      const workflowContent = `
name: Test Workflow
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: docker://alpine:3.18
      - uses: docker://ghcr.io/owner/image:v1.0.0
`
      const workflowFile = path.join(tempDir, 'test.yml')
      fs.writeFileSync(workflowFile, workflowContent)

      const result = await parser.parseWorkflowFile(workflowFile)

      expect(result.dockerDependencies).toHaveLength(2)
      expect(result.dockerDependencies[0]).toMatchObject({
        registry: 'hub.docker.com',
        namespace: 'library',
        image: 'alpine',
        tag: '3.18',
        context: 'step'
      })
      expect(result.dockerDependencies[1]).toMatchObject({
        registry: 'ghcr.io',
        namespace: 'owner',
        image: 'image',
        tag: 'v1.0.0',
        context: 'step'
      })
    })

    it('Extracts Docker images from Docker-based action.yml', async () => {
      const actionContent = `
name: My Docker Action
description: Test docker action
runs:
  using: docker
  image: docker://node:18
`
      const actionFile = path.join(tempDir, 'action.yml')
      fs.writeFileSync(actionFile, actionContent)

      const result = await parser.parseWorkflowFile(actionFile)

      expect(result.dockerDependencies).toHaveLength(1)
      expect(result.dockerDependencies[0]).toMatchObject({
        registry: 'hub.docker.com',
        namespace: 'library',
        image: 'node',
        tag: '18',
        context: 'action'
      })
    })

    it('Parses Dockerfile from action.yml and extracts base images', async () => {
      // Create a Dockerfile
      const dockerfileContent = `FROM node:18
RUN npm install
COPY . .
`
      const dockerfilePath = path.join(tempDir, 'Dockerfile')
      fs.writeFileSync(dockerfilePath, dockerfileContent)

      // Create action.yml that references the Dockerfile
      const actionContent = `
name: My Docker Action
description: Test docker action
runs:
  using: docker
  image: Dockerfile
`
      const actionFile = path.join(tempDir, 'action.yml')
      fs.writeFileSync(actionFile, actionContent)

      const result = await parser.parseWorkflowFile(actionFile)

      expect(result.dockerDependencies).toHaveLength(1)
      expect(result.dockerDependencies[0]).toMatchObject({
        registry: 'hub.docker.com',
        namespace: 'library',
        image: 'node',
        tag: '18',
        context: 'dockerfile'
      })
    })

    it('Parses Dockerfile with multi-stage builds', async () => {
      const dockerfileContent = `FROM node:18 AS builder
WORKDIR /app
RUN npm install

FROM alpine:3.18
COPY --from=builder /app /app
`
      const dockerfilePath = path.join(tempDir, 'Dockerfile')
      fs.writeFileSync(dockerfilePath, dockerfileContent)

      const actionContent = `
name: My Docker Action
runs:
  using: docker
  image: Dockerfile
`
      const actionFile = path.join(tempDir, 'action.yml')
      fs.writeFileSync(actionFile, actionContent)

      const result = await parser.parseWorkflowFile(actionFile)

      expect(result.dockerDependencies).toHaveLength(2)
      expect(result.dockerDependencies[0]).toMatchObject({
        image: 'node',
        tag: '18',
        context: 'dockerfile'
      })
      expect(result.dockerDependencies[1]).toMatchObject({
        image: 'alpine',
        tag: '3.18',
        context: 'dockerfile'
      })
    })

    it('Skips FROM scratch in Dockerfile', async () => {
      const dockerfileContent = `FROM scratch
COPY app /app
`
      const dockerfilePath = path.join(tempDir, 'Dockerfile')
      fs.writeFileSync(dockerfilePath, dockerfileContent)

      const actionContent = `
name: My Docker Action
runs:
  using: docker
  image: Dockerfile
`
      const actionFile = path.join(tempDir, 'action.yml')
      fs.writeFileSync(actionFile, actionContent)

      const result = await parser.parseWorkflowFile(actionFile)

      expect(result.dockerDependencies).toHaveLength(0)
    })

    it('Logs warning for Dockerfile with variable references', async () => {
      const dockerfileContent = `ARG BASE_IMAGE=node:18
FROM \${BASE_IMAGE}
RUN npm install
`
      const dockerfilePath = path.join(tempDir, 'Dockerfile')
      fs.writeFileSync(dockerfilePath, dockerfileContent)

      const actionContent = `
name: My Docker Action
runs:
  using: docker
  image: Dockerfile
`
      const actionFile = path.join(tempDir, 'action.yml')
      fs.writeFileSync(actionFile, actionContent)

      const result = await parser.parseWorkflowFile(actionFile)

      expect(result.dockerDependencies).toHaveLength(0)
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining('variable reference in FROM')
      )
    })

    it('Logs warning when Dockerfile not found', async () => {
      const actionContent = `
name: My Docker Action
runs:
  using: docker
  image: Dockerfile
`
      const actionFile = path.join(tempDir, 'action.yml')
      fs.writeFileSync(actionFile, actionContent)

      const result = await parser.parseWorkflowFile(actionFile)

      expect(result.dockerDependencies).toHaveLength(0)
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining('Dockerfile not found')
      )
    })

    it('Extracts all Docker dependencies together', async () => {
      const workflowContent = `
name: Test Workflow
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    container:
      image: node:20
    services:
      postgres:
        image: postgres:15
    steps:
      - uses: actions/checkout@v4
      - uses: docker://alpine:latest
`
      const workflowFile = path.join(tempDir, 'test.yml')
      fs.writeFileSync(workflowFile, workflowContent)

      const result = await parser.parseWorkflowFile(workflowFile)

      expect(result.dependencies).toHaveLength(1)
      expect(result.dockerDependencies).toHaveLength(3)
      expect(result.dockerDependencies[0].context).toBe('container')
      expect(result.dockerDependencies[1].context).toBe('service')
      expect(result.dockerDependencies[2].context).toBe('step')
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

      const result = await parser.parseWorkflowDirectory(tempDir)

      expect(result.actionDependencies).toHaveLength(2)
      expect(result.actionDependencies[0]).toMatchObject({
        owner: 'actions',
        repo: 'checkout',
        ref: 'v4',
        uses: 'actions/checkout@v4'
      })
      expect(result.actionDependencies[0].sourcePath).toBeDefined()
      expect(result.actionDependencies[1]).toMatchObject({
        owner: 'actions',
        repo: 'setup-node',
        ref: 'v4',
        uses: 'actions/setup-node@v4'
      })
      expect(result.actionDependencies[1].sourcePath).toBeDefined()
    })

    it('Handles non-existent directory', async () => {
      const result = await parser.parseWorkflowDirectory('/non/existent/path')

      expect(result.actionDependencies).toEqual([])
      expect(result.dockerDependencies).toEqual([])
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

      const result = await parser.parseWorkflowDirectory(
        path.join(tempDir, '.github', 'workflows'),
        [],
        tempDir
      )

      // Should find the dependency from the composite action
      expect(result.actionDependencies).toHaveLength(1)
      expect(result.actionDependencies[0]).toMatchObject({
        owner: 'actions',
        repo: 'cache',
        ref: 'v3',
        uses: 'actions/cache@v3'
      })
      expect(result.actionDependencies[0].sourcePath).toBeDefined()
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

      const result = await parser.parseWorkflowDirectory(
        path.join(tempDir, '.github', 'workflows'),
        ['custom/actions'],
        tempDir
      )

      // Should find dependencies from both workflow and additional paths
      expect(result.actionDependencies).toHaveLength(2)
      expect(
        result.actionDependencies.find((d) => d.uses === 'actions/checkout@v4')
      ).toBeDefined()
      expect(
        result.actionDependencies.find((d) => d.uses === 'actions/cache@v3')
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

      const result = await parser.parseWorkflowDirectory(
        path.join(tempDir, '.github', 'workflows'),
        [],
        tempDir
      )

      // Should find dependencies from both workflow and root action.yml
      expect(result.actionDependencies).toHaveLength(3)
      expect(
        result.actionDependencies.find((d) => d.uses === 'actions/checkout@v4')
      ).toBeDefined()
      expect(
        result.actionDependencies.find(
          (d) => d.uses === 'actions/setup-node@v4'
        )
      ).toBeDefined()
      expect(
        result.actionDependencies.find((d) => d.uses === 'actions/cache@v3')
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

      const result = await parser.parseWorkflowDirectory(
        path.join(tempDir, '.github', 'workflows'),
        [],
        tempDir
      )

      // Should find dependencies from both workflow and root action.yaml
      expect(result.actionDependencies).toHaveLength(2)
      expect(
        result.actionDependencies.find((d) => d.uses === 'actions/checkout@v4')
      ).toBeDefined()
      expect(
        result.actionDependencies.find(
          (d) => d.uses === 'github/codeql-action/init@v2'
        )
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

      const result = await parser.parseWorkflowDirectory(
        path.join(tempDir, '.github', 'workflows'),
        [],
        tempDir
      )

      // Should only find dependency from workflow, not from root action.yml
      expect(result.actionDependencies).toHaveLength(1)
      expect(
        result.actionDependencies.find((d) => d.uses === 'actions/checkout@v4')
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
      const result = await parser.parseWorkflowDirectory(
        path.join(tempDir, '.github', 'workflows')
      )

      // Should only find dependency from workflow
      expect(result.actionDependencies).toHaveLength(1)
      expect(
        result.actionDependencies.find((d) => d.uses === 'actions/checkout@v4')
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
      const result = await parserNoToken.parseWorkflowDirectory(tempDir)

      expect(result.actionDependencies).toHaveLength(1)
      expect(result.actionDependencies[0]).toMatchObject({
        owner: 'actions',
        repo: 'checkout',
        ref: 'v4'
      })
      expect(result.actionDependencies[0].isTransitive).toBeUndefined()
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

      const result = await parserWithToken.parseWorkflowDirectory(
        tempDir,
        [],
        tempDir
      )

      // Should have the direct dependency plus transitive dependencies
      expect(result.actionDependencies.length).toBeGreaterThanOrEqual(1)

      // Find the direct dependency
      const directDep = result.actionDependencies.find(
        (d) => d.owner === 'remote-org' && d.repo === 'my-composite-action'
      )
      expect(directDep).toBeDefined()
      expect(directDep?.isTransitive).toBeUndefined()

      // Find the transitive dependencies
      const transitiveDeps = result.actionDependencies.filter(
        (d) => d.isTransitive === true
      )
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

      const result = await parserWithToken.parseWorkflowDirectory(
        tempDir,
        [],
        tempDir
      )

      // Should have the direct dependency plus transitive dependencies
      expect(result.actionDependencies.length).toBeGreaterThanOrEqual(1)

      // Find the direct dependency
      const directDep = result.actionDependencies.find(
        (d) => d.owner === 'remote-org' && d.repo === 'my-repo'
      )
      expect(directDep).toBeDefined()
      expect(directDep?.isTransitive).toBeUndefined()

      // Find the transitive dependencies
      const transitiveDeps = result.actionDependencies.filter(
        (d) => d.isTransitive === true
      )
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

      const result = await parserWithToken.parseWorkflowDirectory(
        tempDir,
        [],
        tempDir
      )

      // Should only have the direct dependency, no transitive
      expect(result.actionDependencies).toHaveLength(1)
      expect(result.actionDependencies[0]).toMatchObject({
        owner: 'remote-org',
        repo: 'my-docker-action',
        ref: 'v1'
      })
      expect(result.actionDependencies[0].isTransitive).toBeUndefined()
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

      const result = await parserWithToken.parseWorkflowDirectory(
        tempDir,
        [],
        tempDir
      )

      // Should only have the direct dependency, no transitive
      expect(result.actionDependencies).toHaveLength(1)
      expect(result.actionDependencies[0]).toMatchObject({
        owner: 'remote-org',
        repo: 'nonexistent-action',
        ref: 'v1'
      })
      expect(result.actionDependencies[0].isTransitive).toBeUndefined()
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

      const result = await parserWithToken.parseWorkflowDirectory(
        tempDir,
        [],
        tempDir
      )

      // Should fetch the remote action once, plus fetch nested actions once each
      // remote-org/my-composite-action@v1 (1) + actions/setup-node@v4 (1) = 2 total
      expect(fetchCount).toBe(2)

      // Should have two direct dependencies (one per workflow) plus transitive dependencies
      const directDeps = result.actionDependencies.filter(
        (d) => d.owner === 'remote-org' && d.repo === 'my-composite-action'
      )
      expect(directDeps).toHaveLength(2)

      // Should have transitive dependencies
      const transitiveDeps = result.actionDependencies.filter(
        (d) => d.isTransitive === true
      )
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

      const result = await parserWithToken.parseWorkflowDirectory(
        tempDir,
        [],
        tempDir
      )

      // Find the transitive dependencies
      const transitiveDeps = result.actionDependencies.filter(
        (d) => d.isTransitive === true
      )
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

      const result = await parserWithToken.parseWorkflowDirectory(
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
      expect(result.actionDependencies.length).toBeGreaterThanOrEqual(1)

      // Find the direct dependency
      const directDep = result.actionDependencies.find(
        (d) => d.owner === 'remote-org' && d.repo === 'my-repo'
      )
      expect(directDep).toBeDefined()
      expect(directDep?.actionPath).toBe('subfolder')
      expect(directDep?.isTransitive).toBeUndefined()

      // Find the transitive dependency
      const transitiveDeps = result.actionDependencies.filter(
        (d) => d.isTransitive === true
      )
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

    it('Recursively processes nested remote composite actions', async () => {
      // Mock Octokit to handle multiple levels of composite actions
      const mockGetContent = jest.fn().mockImplementation(({ owner, repo }) => {
        if (owner === 'top-org' && repo === 'level-1-action') {
          // First level composite action uses another composite action
          return Promise.resolve({
            data: {
              content: Buffer.from(
                `
name: Level 1 Composite Action
description: A composite action that uses another composite action
runs:
  using: composite
  steps:
    - uses: nested-org/level-2-action@v1
    - uses: actions/checkout@v4
`
              ).toString('base64')
            }
          })
        } else if (owner === 'nested-org' && repo === 'level-2-action') {
          // Second level composite action
          return Promise.resolve({
            data: {
              content: Buffer.from(
                `
name: Level 2 Composite Action
description: A nested composite action
runs:
  using: composite
  steps:
    - uses: actions/setup-node@v4
    - uses: actions/cache@v3
`
              ).toString('base64')
            }
          })
        } else {
          // For actions/checkout, actions/setup-node, actions/cache - return non-composite
          return Promise.resolve({
            data: {
              content: Buffer.from(
                `
name: Standard Action
description: Not a composite action
runs:
  using: node20
  main: dist/index.js
`
              ).toString('base64')
            }
          })
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
      - uses: top-org/level-1-action@v1
`
      const workflowFile = path.join(tempDir, 'test.yml')
      fs.writeFileSync(workflowFile, workflowContent)

      const result = await parserWithToken.parseWorkflowDirectory(
        tempDir,
        [],
        tempDir
      )

      // Should have the top-level action
      const topLevelDep = result.actionDependencies.find(
        (d) => d.owner === 'top-org' && d.repo === 'level-1-action'
      )
      expect(topLevelDep).toBeDefined()
      expect(topLevelDep?.isTransitive).toBeUndefined()

      // Should have dependencies from level 1 (marked as transitive)
      // This includes nested-org/level-2-action and actions/checkout,
      // plus any nested processing of those actions
      const level1DirectDeps = result.actionDependencies.filter(
        (d) =>
          d.isTransitive === true &&
          ((d.owner === 'nested-org' && d.repo === 'level-2-action') ||
            (d.owner === 'actions' && d.repo === 'checkout'))
      )
      expect(level1DirectDeps.length).toBeGreaterThanOrEqual(2)

      // Should have dependencies from level 2 (also marked as transitive)
      const setupNodeDep = result.actionDependencies.find(
        (d) =>
          d.owner === 'actions' &&
          d.repo === 'setup-node' &&
          d.isTransitive === true
      )
      expect(setupNodeDep).toBeDefined()
      expect(setupNodeDep?.ref).toBe('v4')

      const cacheDep = result.actionDependencies.find(
        (d) =>
          d.owner === 'actions' && d.repo === 'cache' && d.isTransitive === true
      )
      expect(cacheDep).toBeDefined()
      expect(cacheDep?.ref).toBe('v3')

      // Verify that nested actions were fetched
      expect(mockGetContent).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'top-org',
          repo: 'level-1-action'
        })
      )
      expect(mockGetContent).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'nested-org',
          repo: 'level-2-action'
        })
      )
    })

    it('Recursively processes nested remote callable workflows', async () => {
      // Mock Octokit to handle multiple levels of callable workflows
      const mockGetContent = jest
        .fn()
        .mockImplementation(({ owner, repo, path }) => {
          if (
            owner === 'top-org' &&
            repo === 'top-repo' &&
            path === '.github/workflows/level1.yml'
          ) {
            // First level callable workflow uses another callable workflow
            return Promise.resolve({
              data: {
                content: Buffer.from(
                  `name: Level 1 Workflow
on:
  workflow_call:
jobs:
  call-nested:
    uses: nested-org/nested-repo/.github/workflows/level2.yml@v1
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4`
                ).toString('base64')
              }
            })
          } else if (
            owner === 'nested-org' &&
            repo === 'nested-repo' &&
            path === '.github/workflows/level2.yml'
          ) {
            // Second level callable workflow
            return Promise.resolve({
              data: {
                content: Buffer.from(
                  `name: Level 2 Workflow
on:
  workflow_call:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-python@v5`
                ).toString('base64')
              }
            })
          } else if (path === 'action.yml' || path === 'action.yaml') {
            // For actions/checkout, actions/setup-python - return non-composite
            return Promise.resolve({
              data: {
                content: Buffer.from(
                  `name: Standard Action
description: Not a composite action
runs:
  using: node20
  main: dist/index.js`
                ).toString('base64')
              }
            })
          }
          return Promise.reject(new Error('Not found'))
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
    uses: top-org/top-repo/.github/workflows/level1.yml@v1
`
      const workflowFile = path.join(tempDir, 'test.yml')
      fs.writeFileSync(workflowFile, workflowContent)

      const result = await parserWithToken.parseWorkflowDirectory(
        tempDir,
        [],
        tempDir
      )

      // Should have the top-level workflow
      const topLevelDep = result.actionDependencies.find(
        (d) => d.owner === 'top-org' && d.repo === 'top-repo'
      )
      expect(topLevelDep).toBeDefined()
      expect(topLevelDep?.isTransitive).toBeUndefined()

      // Should have the nested workflow from level 1
      const nestedWorkflowDep = result.actionDependencies.find(
        (d) =>
          d.owner === 'nested-org' &&
          d.repo === 'nested-repo' &&
          d.isTransitive === true
      )
      expect(nestedWorkflowDep).toBeDefined()

      // Should have actions from level 1
      const checkoutDep = result.actionDependencies.find(
        (d) =>
          d.owner === 'actions' &&
          d.repo === 'checkout' &&
          d.isTransitive === true
      )
      expect(checkoutDep).toBeDefined()
      expect(checkoutDep?.ref).toBe('v4')

      // Should have actions from level 2
      const setupPythonDep = result.actionDependencies.find(
        (d) =>
          d.owner === 'actions' &&
          d.repo === 'setup-python' &&
          d.isTransitive === true
      )
      expect(setupPythonDep).toBeDefined()
      expect(setupPythonDep?.ref).toBe('v5')

      // Verify that nested workflows were fetched
      expect(mockGetContent).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'top-org',
          repo: 'top-repo',
          path: '.github/workflows/level1.yml'
        })
      )
      expect(mockGetContent).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'nested-org',
          repo: 'nested-repo',
          path: '.github/workflows/level2.yml'
        })
      )
    })
  })
})
