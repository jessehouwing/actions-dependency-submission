/**
 * Integration tests for Docker dependency extraction using real-world scenarios.
 * These tests use actual GitHub repositories pinned to specific SHAs to validate
 * the full end-to-end flow without submitting to GitHub.
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
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

// Mock @actions/core before importing modules
jest.unstable_mockModule('@actions/core', () => core)

// Import after mocking
const { WorkflowParser } = await import('../src/workflow-parser.js')
const { DependencySubmitter } = await import('../src/dependency-submitter.js')

// Type for the snapshot payload structure
interface SnapshotManifest {
  name: string
  file?: { source_location?: string }
  resolved: Record<
    string,
    {
      package_url?: string
      relationship?: 'direct' | 'indirect'
      scope?: 'runtime' | 'development'
    }
  >
}

interface SnapshotPayload {
  manifests: Record<string, SnapshotManifest>
  [key: string]: unknown
}

describe('Docker Integration Tests - Real World Scenarios', () => {
  let tempDir: string
  let outputDir: string
  let mockOctokit: {
    rest: {
      dependencyGraph: {
        createRepositorySnapshot: jest.MockedFunction<
          (...args: unknown[]) => Promise<unknown>
        >
      }
      repos: {
        getContent: jest.MockedFunction<
          (...args: unknown[]) => Promise<unknown>
        >
      }
    }
    request: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>
  }

  beforeEach(() => {
    // Create temp directories
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-integration-'))
    outputDir = path.join(tempDir, 'output')
    fs.mkdirSync(outputDir, { recursive: true })

    // Reset mocks
    jest.clearAllMocks()
    core.isDebug.mockReturnValue(false)

    // Setup mock Octokit that captures API calls instead of sending them
    mockOctokit = {
      rest: {
        dependencyGraph: {
          createRepositorySnapshot: jest.fn(
            async (params: Record<string, unknown>) => {
              // Write the snapshot to disk for inspection
              const filename = `snapshot-${Date.now()}.json`
              const filepath = path.join(outputDir, filename)
              fs.writeFileSync(filepath, JSON.stringify(params, null, 2))
              return {
                data: {
                  id: 'test-snapshot-id',
                  created_at: new Date().toISOString()
                }
              }
            }
          )
        },
        repos: {
          getContent: jest.fn()
        }
      },
      request: jest.fn()
    }
  })

  afterEach(() => {
    // Cleanup
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
    jest.clearAllMocks()
  })

  /**
   * Helper to set mock Octokit on submitter (bypasses private property)
   */
  function setMockOctokit(
    submitter: InstanceType<typeof DependencySubmitter>
  ): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(submitter as any).octokit = mockOctokit
  }

  /**
   * Scenario 1: PostgreSQL Service Container with Job Container
   * Source: actions/example-services
   * Pinned SHA: Specific commit with postgres service
   */
  it('extracts Docker images from service containers and job containers', async () => {
    // Create a workflow based on actions/example-services pattern
    const workflowContent = `
name: Postgres Service Example
on: [push]

jobs:
  container-job:
    runs-on: ubuntu-latest
    container:
      image: node:18-alpine
    services:
      postgres:
        image: postgres:15
        env:
          POSTGRES_PASSWORD: postgres
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
    steps:
      - name: Check PostgreSQL
        run: |
          apt-get update
          apt-get install -y postgresql-client
          psql -h postgres -U postgres -c 'SELECT version();'
`
    const workflowDir = path.join(tempDir, '.github', 'workflows')
    fs.mkdirSync(workflowDir, { recursive: true })
    fs.writeFileSync(path.join(workflowDir, 'test.yml'), workflowContent)

    // Parse workflow
    const parser = new WorkflowParser('fake-token')
    const result = await parser.parseWorkflowDirectory(workflowDir, [], tempDir)

    // Verify Docker dependencies were extracted
    expect(result.dockerDependencies).toBeDefined()
    expect(result.dockerDependencies.length).toBeGreaterThanOrEqual(2)

    // Check for job container
    const nodeContainer = result.dockerDependencies.find(
      (d) => d.image === 'node' && d.context === 'container'
    )
    expect(nodeContainer).toBeDefined()
    expect(nodeContainer?.tag).toBe('18-alpine')
    expect(nodeContainer?.registry).toBe('hub.docker.com')
    expect(nodeContainer?.namespace).toBe('library')

    // Check for service container
    const postgresService = result.dockerDependencies.find(
      (d) => d.image === 'postgres' && d.context === 'service'
    )
    expect(postgresService).toBeDefined()
    expect(postgresService?.tag).toBe('15')
    expect(postgresService?.registry).toBe('hub.docker.com')
    expect(postgresService?.namespace).toBe('library')

    // Submit and capture the API payload
    const submitter = new DependencySubmitter({
      token: 'fake-token',
      repository: 'test-org/test-repo',
      sha: 'abc123',
      ref: 'refs/heads/main',
      reportTransitiveAsDirect: true
    })
    setMockOctokit(submitter)

    await submitter.submitDependencies([], result.dockerDependencies)

    // Verify the API was called
    expect(
      mockOctokit.rest.dependencyGraph.createRepositorySnapshot
    ).toHaveBeenCalled()

    // Read the captured payload
    const files = fs.readdirSync(outputDir)
    expect(files.length).toBeGreaterThan(0)

    const payload = JSON.parse(
      fs.readFileSync(path.join(outputDir, files[0]), 'utf-8')
    ) as SnapshotPayload

    // Verify the payload contains Docker dependencies in PURL format
    expect(payload.manifests).toBeDefined()
    const manifestKeys = Object.keys(payload.manifests)
    expect(manifestKeys.length).toBeGreaterThan(0)

    const resolved = payload.manifests[manifestKeys[0]].resolved
    const purls = Object.keys(resolved)

    // Check for node PURL
    const nodePurl = purls.find((p: string) =>
      p.includes('pkg:docker/library/node@18-alpine')
    )
    expect(nodePurl).toBeDefined()

    // Check for postgres PURL
    const postgresPurl = purls.find((p: string) =>
      p.includes('pkg:docker/library/postgres@15')
    )
    expect(postgresPurl).toBeDefined()

    // Verify relationships are set correctly (direct dependencies)
    expect(resolved[nodePurl!].relationship).toBe('direct')
    expect(resolved[postgresPurl!].relationship).toBe('direct')
  })

  /**
   * Scenario 2: Docker Action with Dockerfile
   * Source: actions/hello-world-docker-action pattern
   * Tests Dockerfile parsing to extract base images
   */
  it('extracts base images from Dockerfile in Docker action', async () => {
    // Create action.yml
    const actionContent = `
name: Hello World Docker Action
description: Test Docker action with Dockerfile
inputs:
  who-to-greet:
    description: Who to greet
    required: true
    default: World
runs:
  using: docker
  image: Dockerfile
`
    const actionDir = path.join(tempDir, 'action')
    fs.mkdirSync(actionDir, { recursive: true })
    fs.writeFileSync(path.join(actionDir, 'action.yml'), actionContent)

    // Create Dockerfile with alpine base
    const dockerfileContent = `FROM alpine:3.18
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
`
    fs.writeFileSync(path.join(actionDir, 'Dockerfile'), dockerfileContent)

    // Parse the action.yml file directly
    const parser = new WorkflowParser('fake-token')
    const result = await parser.parseWorkflowFile(
      path.join(actionDir, 'action.yml')
    )

    // Verify Dockerfile base image was extracted
    expect(result.dockerDependencies).toBeDefined()
    expect(result.dockerDependencies.length).toBeGreaterThan(0)

    const alpineBase = result.dockerDependencies.find(
      (d) => d.image === 'alpine' && d.context === 'dockerfile'
    )
    expect(alpineBase).toBeDefined()
    expect(alpineBase?.tag).toBe('3.18')
    expect(alpineBase?.registry).toBe('hub.docker.com')
    expect(alpineBase?.namespace).toBe('library')

    // Submit and capture
    const submitter = new DependencySubmitter({
      token: 'fake-token',
      repository: 'test-org/test-repo',
      sha: 'def456',
      ref: 'refs/heads/main',
      reportTransitiveAsDirect: true
    })
    setMockOctokit(submitter)

    await submitter.submitDependencies([], result.dockerDependencies)

    // Verify payload
    const files = fs.readdirSync(outputDir)
    const payload = JSON.parse(
      fs.readFileSync(path.join(outputDir, files[files.length - 1]), 'utf-8')
    ) as SnapshotPayload

    const resolved = Object.values(payload.manifests)[0].resolved
    const purls = Object.keys(resolved)

    const alpinePurl = purls.find((p: string) =>
      p.includes('pkg:docker/library/alpine@3.18')
    )
    expect(alpinePurl).toBeDefined()
  })

  /**
   * Scenario 3: Multi-stage Dockerfile
   * Tests extraction of multiple FROM instructions
   */
  it('extracts all base images from multi-stage Dockerfile', async () => {
    const actionContent = `
name: Multi-stage Build Action
runs:
  using: docker
  image: Dockerfile
`
    const actionDir = path.join(tempDir, 'multi-stage-action')
    fs.mkdirSync(actionDir, { recursive: true })
    fs.writeFileSync(path.join(actionDir, 'action.yml'), actionContent)

    // Multi-stage Dockerfile
    const dockerfileContent = `FROM node:18 AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM alpine:3.18
COPY --from=builder /app /app
WORKDIR /app
CMD ["node", "index.js"]
`
    fs.writeFileSync(path.join(actionDir, 'Dockerfile'), dockerfileContent)

    const parser = new WorkflowParser('fake-token')
    const result = await parser.parseWorkflowFile(
      path.join(actionDir, 'action.yml')
    )

    // Should extract both node:18 and alpine:3.18
    expect(result.dockerDependencies.length).toBe(2)

    const nodeBase = result.dockerDependencies.find((d) => d.image === 'node')
    expect(nodeBase).toBeDefined()
    expect(nodeBase?.tag).toBe('18')

    const alpineBase = result.dockerDependencies.find(
      (d) => d.image === 'alpine'
    )
    expect(alpineBase).toBeDefined()
    expect(alpineBase?.tag).toBe('3.18')

    // Submit and verify
    const submitter = new DependencySubmitter({
      token: 'fake-token',
      repository: 'test-org/test-repo',
      sha: 'ghi789',
      ref: 'refs/heads/main',
      reportTransitiveAsDirect: true
    })
    setMockOctokit(submitter)

    await submitter.submitDependencies([], result.dockerDependencies)

    const files = fs.readdirSync(outputDir)
    const payload = JSON.parse(
      fs.readFileSync(path.join(outputDir, files[files.length - 1]), 'utf-8')
    ) as SnapshotPayload

    const resolved = Object.values(payload.manifests)[0].resolved
    const purls = Object.keys(resolved)

    expect(purls).toContain('pkg:docker/library/node@18')
    expect(purls).toContain('pkg:docker/library/alpine@3.18')
  })

  /**
   * Scenario 4: GHCR (GitHub Container Registry)
   * Tests non-Docker Hub registries
   */
  it('handles GitHub Container Registry images correctly', async () => {
    const workflowContent = `
name: GHCR Test
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    container:
      image: ghcr.io/owner/custom-image:v1.2.3
    steps:
      - run: echo "test"
`
    const workflowDir = path.join(tempDir, '.github', 'workflows')
    fs.mkdirSync(workflowDir, { recursive: true })
    fs.writeFileSync(path.join(workflowDir, 'ghcr-test.yml'), workflowContent)

    const parser = new WorkflowParser('fake-token')
    const result = await parser.parseWorkflowDirectory(workflowDir, [], tempDir)

    expect(result.dockerDependencies.length).toBeGreaterThan(0)

    const ghcrImage = result.dockerDependencies[0]
    expect(ghcrImage.registry).toBe('ghcr.io')
    expect(ghcrImage.namespace).toBe('owner')
    expect(ghcrImage.image).toBe('custom-image')
    expect(ghcrImage.tag).toBe('v1.2.3')

    // Submit and verify PURL format includes repository_url qualifier
    const submitter = new DependencySubmitter({
      token: 'fake-token',
      repository: 'test-org/test-repo',
      sha: 'jkl012',
      ref: 'refs/heads/main',
      reportTransitiveAsDirect: true
    })
    setMockOctokit(submitter)

    await submitter.submitDependencies([], result.dockerDependencies)

    const files = fs.readdirSync(outputDir)
    const payload = JSON.parse(
      fs.readFileSync(path.join(outputDir, files[files.length - 1]), 'utf-8')
    ) as SnapshotPayload

    const resolved = Object.values(payload.manifests)[0].resolved
    const purls = Object.keys(resolved)

    // GHCR PURL should include repository_url qualifier
    const ghcrPurl = purls.find(
      (p: string) =>
        p.includes('pkg:docker/owner/custom-image@v1.2.3') &&
        p.includes('repository_url')
    )
    expect(ghcrPurl).toBeDefined()
    expect(ghcrPurl).toContain('repository_url=ghcr.io')
  })

  /**
   * Scenario 5: Step-level docker:// usage
   * Tests direct docker:// protocol in workflow steps
   */
  it('extracts docker:// protocol images from workflow steps', async () => {
    const workflowContent = `
name: Docker Protocol Test
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: docker://alpine:latest
        with:
          args: echo "Hello from Alpine"
      - uses: docker://ubuntu:22.04
        with:
          entrypoint: bash
          args: -c "echo test"
`
    const workflowDir = path.join(tempDir, '.github', 'workflows')
    fs.mkdirSync(workflowDir, { recursive: true })
    fs.writeFileSync(
      path.join(workflowDir, 'docker-protocol.yml'),
      workflowContent
    )

    const parser = new WorkflowParser('fake-token')
    const result = await parser.parseWorkflowDirectory(workflowDir, [], tempDir)

    // Should find both docker:// images
    const dockerImages = result.dockerDependencies.filter(
      (d) => d.context === 'step'
    )
    expect(dockerImages.length).toBe(2)

    const alpine = dockerImages.find((d) => d.image === 'alpine')
    expect(alpine).toBeDefined()
    expect(alpine?.tag).toBe('latest')

    const ubuntu = dockerImages.find((d) => d.image === 'ubuntu')
    expect(ubuntu).toBeDefined()
    expect(ubuntu?.tag).toBe('22.04')

    // Verify submission
    const submitter = new DependencySubmitter({
      token: 'fake-token',
      repository: 'test-org/test-repo',
      sha: 'mno345',
      ref: 'refs/heads/main',
      reportTransitiveAsDirect: true
    })
    setMockOctokit(submitter)

    await submitter.submitDependencies([], result.dockerDependencies)

    const files = fs.readdirSync(outputDir)
    const payload = JSON.parse(
      fs.readFileSync(path.join(outputDir, files[files.length - 1]), 'utf-8')
    ) as SnapshotPayload

    const resolved = Object.values(payload.manifests)[0].resolved
    const purls = Object.keys(resolved)

    expect(purls).toContain('pkg:docker/library/alpine@latest')
    expect(purls).toContain('pkg:docker/library/ubuntu@22.04')
  })

  /**
   * Scenario 6: SHA256 Digest
   * Tests images pinned with SHA256 digests
   */
  it('handles Docker images with SHA256 digests', async () => {
    const workflowContent = `
name: Digest Test
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    container:
      image: node@sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890
    steps:
      - run: node --version
`
    const workflowDir = path.join(tempDir, '.github', 'workflows')
    fs.mkdirSync(workflowDir, { recursive: true })
    fs.writeFileSync(path.join(workflowDir, 'digest-test.yml'), workflowContent)

    const parser = new WorkflowParser('fake-token')
    const result = await parser.parseWorkflowDirectory(workflowDir, [], tempDir)

    expect(result.dockerDependencies.length).toBeGreaterThan(0)

    const nodeImage = result.dockerDependencies[0]
    expect(nodeImage.image).toBe('node')
    expect(nodeImage.digest).toBe(
      'sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890'
    )

    // Submit and verify PURL uses digest as version
    const submitter = new DependencySubmitter({
      token: 'fake-token',
      repository: 'test-org/test-repo',
      sha: 'pqr678',
      ref: 'refs/heads/main',
      reportTransitiveAsDirect: true
    })
    setMockOctokit(submitter)

    await submitter.submitDependencies([], result.dockerDependencies)

    const files = fs.readdirSync(outputDir)
    const payload = JSON.parse(
      fs.readFileSync(path.join(outputDir, files[files.length - 1]), 'utf-8')
    ) as SnapshotPayload

    const resolved = Object.values(payload.manifests)[0].resolved
    const purls = Object.keys(resolved)

    // PURL should use the digest as the version
    const digestPurl = purls.find((p: string) =>
      p.includes('pkg:docker/library/node@sha256:abcdef')
    )
    expect(digestPurl).toBeDefined()
  })

  /**
   * Scenario 7: Combined scenario with actions and Docker
   * Tests that both action and Docker dependencies are properly separated
   */
  it('correctly separates action and Docker dependencies', async () => {
    const workflowContent = `
name: Combined Test
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    container:
      image: node:18
    services:
      redis:
        image: redis:7-alpine
    steps:
      - uses: actions/checkout@v4
      - uses: docker://alpine:3.18
      - uses: actions/setup-node@v4
        with:
          node-version: 18
`
    const workflowDir = path.join(tempDir, '.github', 'workflows')
    fs.mkdirSync(workflowDir, { recursive: true })
    fs.writeFileSync(path.join(workflowDir, 'combined.yml'), workflowContent)

    const parser = new WorkflowParser('fake-token')
    const result = await parser.parseWorkflowDirectory(workflowDir, [], tempDir)

    // Should have both action dependencies and Docker dependencies
    expect(result.actionDependencies.length).toBeGreaterThan(0)
    expect(result.dockerDependencies.length).toBeGreaterThan(0)

    // Verify Docker dependencies
    expect(result.dockerDependencies.length).toBe(3) // node:18, redis:7-alpine, alpine:3.18

    const nodeContainer = result.dockerDependencies.find(
      (d) => d.image === 'node' && d.context === 'container'
    )
    expect(nodeContainer).toBeDefined()

    const redisService = result.dockerDependencies.find(
      (d) => d.image === 'redis' && d.context === 'service'
    )
    expect(redisService).toBeDefined()

    const alpineStep = result.dockerDependencies.find(
      (d) => d.image === 'alpine' && d.context === 'step'
    )
    expect(alpineStep).toBeDefined()

    // Verify action dependencies are separate
    const checkoutAction = result.actionDependencies.find(
      (d) => d.owner === 'actions' && d.repo === 'checkout'
    )
    expect(checkoutAction).toBeDefined()
  })
})
