# Research: Docker Dependency Reporting for GitHub Actions

## Executive Summary

This document provides comprehensive research findings and a detailed implementation
plan for adding Docker container dependency reporting to the
`actions-dependency-submission` GitHub Action. Currently, the action reports GitHub
Actions dependencies but skips Docker container references. This enhancement will
enable security vulnerability tracking for Docker images used in workflows.

## Current State

The action currently:

- ✅ Scans workflow files for GitHub Actions dependencies (`uses:
  owner/repo@version`)
- ✅ Supports composite actions and callable workflows
- ✅ Reports dependencies to GitHub's Dependency Graph using PURL format
  (`pkg:githubactions/owner/repo@version`)
- ❌ **Explicitly skips Docker references** (line 373 in `workflow-parser.ts`:
  `if (uses.startsWith('docker://'))`)

## Docker Usage Patterns in GitHub Actions

GitHub Actions workflows can reference Docker containers in three primary ways:

### Note on Service Containers

GitHub Actions also supports **service containers** via `jobs.<job_id>.services`, which run alongside the job to provide services like databases. While these are Docker containers, they serve a different purpose (providing services rather than executing workflow logic). For completeness, service containers could be considered for Phase 7 (Future Enhancements).

**Service Container Example:**
```yaml
jobs:
  test:
    services:
      postgres:
        image: postgres:14
        env:
          POSTGRES_PASSWORD: postgres
```

For this initial implementation, we will focus on the three main usage patterns below.

### 1. Job-Level Container (`container:` syntax)

Runs an entire job inside a container. Specified at the `jobs.<job_id>.container`
level.

**Syntax:**

```yaml
jobs:
  my-job:
    runs-on: ubuntu-latest
    container:
      image: node:18
      # or with full registry path
      image: ghcr.io/owner/image:tag
      # or with credentials
      image: gcr.io/project/image:tag
      credentials:
        username: ${{ github.actor }}
        password: ${{ secrets.GITHUB_TOKEN }}
```

**Docker Image Reference Formats:**

- Simple name: `node:18` (defaults to Docker Hub)
- With namespace: `library/node:18`
- Full registry path: `ghcr.io/owner/image:tag`
- With digest: `node@sha256:abc123...`
- Combined: `node:18@sha256:abc123...`

**YAML Structure:**

```yaml
jobs:
  <job_id>:
    container:
      image: <string>          # Required: Docker image reference
      credentials:             # Optional: Registry credentials
        username: <string>
        password: <string>
      env:                     # Optional: Environment variables
        <key>: <value>
      ports:                   # Optional: Ports to expose
        - <number>
      volumes:                 # Optional: Volumes to mount
        - <string>
      options: <string>        # Optional: Docker run options
```

**Key Points from GitHub Documentation:**
- The `image` value can be a Docker base image name, registry path, or image with digest
- Supports Docker Hub (default), GitHub Container Registry (ghcr.io), and other registries
- Only works on Linux runners, not Windows or macOS runners
- Default shell inside container is `sh` (can be overridden)

**Reference:**
[GitHub Docs - jobs.<job_id>.container](https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions#jobsjob_idcontainer)

### 2. Step-Level Docker Action (`docker://` syntax)

Runs a single step using a Docker image directly from a registry.

**Syntax:**

```yaml
steps:
  - name: Run in Docker
    uses: docker://alpine:latest
    with:
      args: echo "Hello from Alpine"

  - name: Use private registry
    uses: docker://ghcr.io/owner/image:tag
    with:
      args: ./entrypoint.sh
```

**Docker Image Reference Formats:**

- `docker://alpine:latest`
- `docker://ubuntu:22.04`
- `docker://ghcr.io/owner/repo:tag`
- `docker://gcr.io/project/image@sha256:abc123...`

**Key Points from GitHub Documentation:**
- Can reference public Docker images from Docker Hub or other registries
- Uses the format `docker://<image>:<tag>` or `docker://<registry>/<image>:<tag>`
- Runs in a separate container from the runner
- Can pass arguments using the `with.args` parameter

**Examples from GitHub Docs:**
```yaml
steps:
  # Reference a docker image published on docker hub
  - uses: docker://alpine:3.8
  
  # Reference a docker public registry action
  - uses: docker://gcr.io/cloud-builders/gradle
```

**Reference:**
[GitHub Docs - jobs.<job_id>.steps[*].uses (Docker
section)](https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions#jobsjob_idstepsuses)

### 3. Composite/Docker Actions (`action.yml` with `runs.using: docker`)

Custom actions that run in Docker containers, defined in `action.yml`.

**Important:** Composite actions can also use `docker://` syntax in their steps, which should be parsed recursively.

**Syntax in action.yml:**

```yaml
name: 'My Docker Action'
description: 'Runs in a container'
runs:
  using: 'docker'
  image: 'Dockerfile' # Build from local Dockerfile

  # OR use pre-built image
  # image: 'docker://node:18'
  # image: 'docker://ghcr.io/owner/image:tag'

  args:
    - ${{ inputs.example }}
  entrypoint: 'entrypoint.sh'
```

**Docker Image Reference Formats:**

- `Dockerfile` (relative path to Dockerfile in action repo)
- `docker://image:tag` (pre-built image)
- `docker://registry/owner/image:tag` (full registry path)

**Syntax in action.yml:**

```yaml
name: 'My Docker Action'
description: 'Runs in a container'
runs:
  using: 'docker'               # Required: Must be 'docker'
  image: 'Dockerfile'           # Required: Path to Dockerfile or docker:// image
  
  # Option 1: Build from local Dockerfile
  # image: 'Dockerfile'
  
  # Option 2: Use pre-built image from Docker Hub
  # image: 'docker://node:18'
  
  # Option 3: Use pre-built image from registry
  # image: 'docker://ghcr.io/owner/image:tag'
  
  pre-entrypoint: 'setup.sh'    # Optional: Script before entrypoint
  entrypoint: 'main.sh'          # Optional: Override ENTRYPOINT
  post-entrypoint: 'cleanup.sh'  # Optional: Cleanup script
  args:                          # Optional: Arguments to pass
    - ${{ inputs.example }}
  env:                           # Optional: Environment variables
    MY_VAR: 'value'
```

**Key Points from GitHub Documentation:**
- `runs.using` must be set to `'docker'`
- `runs.image` is required and can be:
  - A local `Dockerfile` (must be named exactly `Dockerfile`)
  - A Docker Hub image: `docker://debian:stretch-slim`
  - A registry image: `docker://gcr.io/project/image:tag`
- The `docker` application will execute this file
- Can override the ENTRYPOINT with `runs.entrypoint`
- Can pass arguments via `runs.args` array

**Examples from GitHub Docs:**
```yaml
# Using a Dockerfile in your repository
runs:
  using: 'docker'
  image: 'Dockerfile'

# Using public Docker registry container
runs:
  using: 'docker'
  image: 'docker://debian:stretch-slim'
```

**References:**

- [GitHub Docs - runs for Docker container
  actions](https://docs.github.com/en/actions/creating-actions/metadata-syntax-for-github-actions#runs-for-docker-container-actions)
- [Example: hello-world-docker-action](https://github.com/actions/hello-world-docker-action/blob/main/action.yml)

## PURL Specification for Docker

The Package URL (PURL) specification defines a standard format for Docker image
references.

### PURL Format

```
pkg:docker/<namespace>/<name>@<version>?<qualifiers>#<subpath>
```

### Components

| Component    | Required | Description                                                                    | Example               |
| ------------ | -------- | ------------------------------------------------------------------------------ | --------------------- |
| `type`       | Yes      | Always `docker` for Docker images                                              | `docker`              |
| `namespace`  | Optional | Registry, organization, or username                                            | `library`, `owner`    |
| `name`       | Yes      | Image name                                                                     | `node`, `alpine`      |
| `version`    | Optional | Tag or SHA256 digest (SHA preferred for immutability)                          | `18`, `sha256:abc...` |
| `qualifiers` | Optional | Additional identifiers (e.g., `repository_url=gcr.io`)                         | Key-value pairs       |
| `subpath`    | Optional | Path within image (rarely used for Docker)                                     | -                     |

### Default Repository

- Default registry: `https://hub.docker.com` (Docker Hub)
- When no registry is specified, Docker Hub is assumed

### Examples from PURL Spec

```
pkg:docker/cassandra@latest
pkg:docker/smartentry/debian@dc437cc87d10
pkg:docker/customer/dockerimage@sha256%3A244fd47e07d10?repository_url=gcr.io
pkg:docker/library/alpine@3.18
```

### GitHub-Specific Examples

```
pkg:docker/node@18
pkg:docker/library/ubuntu@22.04
pkg:docker/github/super-linter@v4?repository_url=ghcr.io
pkg:docker/actions/runner@sha256%3Aabc123...?repository_url=ghcr.io
```

**Reference:**
[PURL Spec - Docker
Definition](https://github.com/package-url/purl-spec/blob/main/types-doc/docker-definition.md)

## Image Reference Parsing

Docker image references can be complex. Here are the patterns we need to handle:

### Formats

1. **Name only**: `alpine` → `library/alpine:latest` on Docker Hub
2. **Name with tag**: `alpine:3.18` → `library/alpine:3.18`
3. **Name with digest**: `alpine@sha256:abc...` → `library/alpine@sha256:abc...`
4. **Name with tag and digest**: `alpine:3.18@sha256:abc...`
5. **With namespace**: `owner/image:tag` → `owner/image:tag`
6. **With registry**: `ghcr.io/owner/image:tag`
7. **Full path**: `gcr.io/project/image:tag@sha256:abc...`

### Parsing Rules

1. **Registry detection**: If reference contains `.` or `:` before first `/`, it's a
   registry
2. **Namespace extraction**: Text between registry and image name
3. **Tag extraction**: Text after `:` (but before `@` if digest present)
4. **Digest extraction**: Text after `@` (usually `sha256:...`)
5. **Implicit library**: For Docker Hub images without namespace, add `library/`

### Parsing Examples

```
alpine:3.18
  → registry: hub.docker.com
  → namespace: library
  → name: alpine
  → tag: 3.18
  → PURL: pkg:docker/library/alpine@3.18

node:18@sha256:abc123
  → registry: hub.docker.com
  → namespace: library
  → name: node
  → tag: 18
  → digest: sha256:abc123
  → PURL: pkg:docker/library/node@sha256%3Aabc123 (also report tag)

ghcr.io/owner/image:v1.0.0
  → registry: ghcr.io
  → namespace: owner
  → name: image
  → tag: v1.0.0
  → PURL: pkg:docker/owner/image@v1.0.0?repository_url=ghcr.io

gcr.io/project-id/image:tag
  → registry: gcr.io
  → namespace: project-id
  → name: image
  → tag: tag
  → PURL: pkg:docker/project-id/image@tag?repository_url=gcr.io
```

## Implementation Plan

### Phase 1: Parser Enhancement

#### 1.1 Add Docker Image Interface

**File**: `src/workflow-parser.ts`

Add a new interface to represent Docker image dependencies:

```typescript
export interface DockerDependency {
  registry: string // e.g., "hub.docker.com", "ghcr.io"
  namespace?: string // e.g., "library", "owner"
  image: string // e.g., "alpine", "node"
  tag?: string // e.g., "latest", "18"
  digest?: string // e.g., "sha256:abc123..."
  originalReference: string // Full original string
  sourcePath?: string // Where this was found
  context?: string // Optional: "container" | "step" | "action" | "service"
}
```

#### 1.2 Create Docker Image Parser Function

**File**: `src/workflow-parser.ts`

```typescript
/**
 * Parses a Docker image reference into components
 */
private parseDockerImage(imageRef: string): DockerDependency | null {
  // Remove docker:// prefix if present
  const cleanRef = imageRef.replace(/^docker:\/\//, '')

  // Complex parsing logic to extract:
  // - registry (if present, otherwise default to hub.docker.com)
  // - namespace (if present, otherwise 'library' for Docker Hub)
  // - image name
  // - tag (if present, otherwise 'latest')
  // - digest (if present)

  // Return DockerDependency object
}
```

#### 1.3 Update `parseUsesString` Method

**Current code** (line 372-375 in `workflow-parser.ts`):

```typescript
// Skip docker actions
if (uses.startsWith('docker://')) {
  return {}
}
```

**New code**:

```typescript
// Parse docker actions
if (uses.startsWith('docker://')) {
  const dockerDep = this.parseDockerImage(uses)
  return {
    isDocker: true,
    dockerDependency: dockerDep
  }
}
```

#### 1.4 Extract Docker Images from Workflows

Add methods to extract Docker images from:

1. **Job-level containers**: Parse `jobs.<job_id>.container.image`
2. **Service containers**: Parse `jobs.<job_id>.services.<service_id>.image`
3. **Step-level Docker actions**: Already handled by `parseUsesString`
4. **Action.yml files**: Parse `runs.image` field when `runs.using === 'docker'`
5. **Composite action steps**: Parse `docker://` references in composite action `uses`

**New method in `WorkflowParser`**:

```typescript
/**
 * Extract Docker dependencies from workflow
 */
private extractDockerDependencies(
  workflow: any,
  dependencies: DockerDependency[],
  sourcePath: string
): void {
  if (!workflow.jobs) return

  for (const jobName in workflow.jobs) {
    const job = workflow.jobs[jobName]
    
    // Extract from job.container.image
    if (job.container?.image) {
      const dockerDep = this.parseDockerImage(job.container.image)
      if (dockerDep) {
        dockerDep.sourcePath = sourcePath
        dockerDep.context = 'container'
        dependencies.push(dockerDep)
      }
    }
    
    // Extract from job.services.<service>.image
    if (job.services) {
      for (const serviceName in job.services) {
        const service = job.services[serviceName]
        if (service.image) {
          const dockerDep = this.parseDockerImage(service.image)
          if (dockerDep) {
            dockerDep.sourcePath = sourcePath
            dockerDep.context = 'service'
            dependencies.push(dockerDep)
          }
        }
      }
    }
  }
}
```

#### 1.5 Parse Dockerfiles for Base Images

When `runs.image` references a `Dockerfile`, parse the Dockerfile to extract base images.

**Recommended Package: `dockerfile-ast`**

Use the [`dockerfile-ast`](https://github.com/rcjsuen/dockerfile-ast) npm package for robust Dockerfile parsing:
- Written in TypeScript with full type support
- Handles multi-stage builds, escaped newlines, comments
- Supports `ARG` and `ENV` variable resolution
- Well-maintained with good test coverage
- License: MIT

**Installation:**
```bash
npm install dockerfile-ast
```

**New method in `WorkflowParser`**:

```typescript
import { DockerfileParser } from 'dockerfile-ast'

/**
 * Parse a Dockerfile to extract base images from FROM instructions
 * 
 * @param dockerfilePath Path to the Dockerfile
 * @param repoRoot Repository root directory
 * @returns Array of Docker dependencies from FROM instructions
 */
private parseDockerfile(
  dockerfilePath: string,
  repoRoot: string
): DockerDependency[] {
  const dependencies: DockerDependency[] = []
  
  try {
    const content = fs.readFileSync(dockerfilePath, 'utf8')
    
    // Parse Dockerfile using dockerfile-ast
    const dockerfile = DockerfileParser.parse(content)
    const instructions = dockerfile.getInstructions()
    
    for (const instruction of instructions) {
      if (instruction.getKeyword() === 'FROM') {
        const args = instruction.getArguments()
        
        // args[0] is the image reference
        // args[1] might be 'AS' keyword
        // args[2] might be the stage name
        const imageRef = args[0]?.getValue() || ''
        
        // Skip scratch and variable references
        if (imageRef === 'scratch' || imageRef.includes('$')) {
          if (imageRef.includes('$')) {
            core.warning(
              `Dockerfile ${path.relative(repoRoot, dockerfilePath)} ` +
              `references variable in FROM: ${imageRef}. ` +
              'Variable substitution is not supported.'
            )
          }
          continue
        }
        
        const dockerDep = this.parseDockerImage(imageRef)
        if (dockerDep) {
          dockerDep.sourcePath = path.relative(repoRoot, dockerfilePath)
          dockerDep.context = 'dockerfile'
          dependencies.push(dockerDep)
          
          core.debug(
            `Extracted base image from Dockerfile: ${imageRef} ` +
            `(stage: ${args.length > 2 ? args[2]?.getValue() : 'unnamed'})`
          )
        }
      }
    }
  } catch (error) {
    core.warning(
      `Failed to parse Dockerfile ${path.relative(repoRoot, dockerfilePath)}: ${error}`
    )
  }
  
  return dependencies
}

/**
 * Handle action.yml files with Dockerfile references
 */
private async extractDockerfileBaseImages(
  actionYmlPath: string,
  repoRoot: string
): Promise<DockerDependency[]> {
  try {
    const content = fs.readFileSync(actionYmlPath, 'utf8')
    const action = yaml.parse(content, { merge: true })
    
    if (action?.runs?.using === 'docker' && action?.runs?.image) {
      const imageRef = action.runs.image
      
      // Check if it's a Dockerfile reference (not docker:// protocol)
      if (!imageRef.startsWith('docker://') && 
          (imageRef === 'Dockerfile' || imageRef.endsWith('/Dockerfile'))) {
        
        // Resolve Dockerfile path relative to action.yml
        const actionDir = path.dirname(actionYmlPath)
        const dockerfilePath = path.join(actionDir, imageRef)
        
        if (fs.existsSync(dockerfilePath)) {
          core.info(`Parsing Dockerfile: ${path.relative(repoRoot, dockerfilePath)}`)
          return this.parseDockerfile(dockerfilePath, repoRoot)
        }
      }
    }
  } catch (error) {
    core.debug(`Failed to extract Dockerfile base images from ${actionYmlPath}: ${error}`)
  }
  
  return []
}
```

**Key Features:**
- Uses `dockerfile-ast` for robust parsing (handles edge cases)
- Parses `FROM` instructions in Dockerfiles
- Handles multi-stage builds (multiple `FROM` statements)
- Skips `FROM scratch` (base layer with no parent)
- Logs warning for variable references like `FROM $BASE_IMAGE` but does not attempt to resolve
- Extracts platform-specific base images (`FROM --platform=...`)
- Reports base images with context `'dockerfile'`
- Preserves stage names from multi-stage builds for debugging

**Example Dockerfile Patterns Handled:**
```dockerfile
# Simple FROM
FROM node:18

# Multi-stage build
FROM node:18 AS build
FROM alpine:3.18 AS runtime

# With platform
FROM --platform=linux/amd64 ubuntu:22.04

# Variables (logs warning, skips)
FROM $BASE_IMAGE

# Scratch (skips)
FROM scratch
```

### Phase 2: PURL Generation

#### 2.1 Add Docker PURL Generator

**File**: `src/dependency-submitter.ts`

Add a new method to create PURL for Docker images:

```typescript
/**
 * Creates a Package URL (purl) for a Docker image
 */
private createDockerPackageUrl(dockerDep: DockerDependency): string {
  // Format: pkg:docker/<namespace>/<name>@<version>?<qualifiers>

  const namespacePart = dockerDep.namespace
    ? `${dockerDep.namespace}/`
    : ''
  const namePart = dockerDep.image

  // Prefer digest over tag for version
  const versionPart = dockerDep.digest
    ? encodeURIComponent(dockerDep.digest) // URL encode sha256:...
    : dockerDep.tag || 'latest'

  let purl = `pkg:docker/${namespacePart}${namePart}@${versionPart}`

  // Add repository_url qualifier for non-Docker Hub registries
  if (
    dockerDep.registry &&
    dockerDep.registry !== 'hub.docker.com' &&
    dockerDep.registry !== 'docker.io'
  ) {
    purl += `?repository_url=${dockerDep.registry}`
  }

  return purl
}
```

#### 2.2 Update Submission Logic

**File**: `src/dependency-submitter.ts`

Extend the `submitDependencies` method to accept both GitHub Actions and Docker
dependencies:

```typescript
async submitDependencies(
  actionDependencies: ResolvedDependency[],
  dockerDependencies?: DockerDependency[]
): Promise<number> {
  // ... existing action dependency code ...

  // Add Docker dependencies to manifests
  if (dockerDependencies) {
    for (const dep of dockerDependencies) {
      const sourcePath = dep.sourcePath || 'docker-images.yml'

      if (!dependenciesBySource.has(sourcePath)) {
        dependenciesBySource.set(sourcePath, [])
      }

      const sourceManifests = dependenciesBySource.get(sourcePath)!
      const purl = this.createDockerPackageUrl(dep)

      sourceManifests.push({
        package_url: purl,
        relationship: DEPENDENCY_RELATIONSHIP.DIRECT,
        scope: DEPENDENCY_SCOPE.RUNTIME
      })

      dependencyCount++

      // If digest is present, also report tag version
      if (dep.digest && dep.tag) {
        // Report both digest (preferred) and tag (for convenience)
        const tagPurl = this.createDockerPackageUrl({
          ...dep,
          digest: undefined // Use tag instead
        })
        sourceManifests.push({
          package_url: tagPurl,
          relationship: DEPENDENCY_RELATIONSHIP.INDIRECT,
          scope: DEPENDENCY_SCOPE.RUNTIME
        })
        dependencyCount++
      }
    }
  }

  // ... rest of submission code ...
}
```

### Phase 3: Integration

#### 3.1 Update Main Entry Point

**File**: `src/main.ts`

Update the main flow to collect and submit Docker dependencies:

```typescript
// Parse workflow files
const parser = new WorkflowParser(token, publicGitHubToken || undefined)
const actionDependencies = await parser.parseWorkflowDirectory(
  workflowDirectory,
  additionalPaths,
  repoRoot
)
const dockerDependencies = await parser.getDockerDependencies() // New method

core.info(`Found ${actionDependencies.length} action dependencies`)
core.info(`Found ${dockerDependencies.length} Docker image dependencies`)

// ... resolve forks for actions ...

// Submit dependencies
const submitter = new DependencySubmitter({
  token,
  repository,
  sha,
  ref,
  reportTransitiveAsDirect
})
const submittedCount = await submitter.submitDependencies(
  resolvedDependencies,
  dockerDependencies
)
```

#### 3.2 Add Configuration Option

**File**: `action.yml`

Add an optional input to enable/disable Docker dependency reporting:

```yaml
inputs:
  # ... existing inputs ...
  report-docker-dependencies:
    description: >
      Whether to report Docker container image dependencies from workflows.
      When true, Docker images referenced in job containers, step-level
      docker:// uses, and action.yml files will be reported to the Dependency
      Graph.
    required: false
    default: 'true'
```

### Phase 4: Testing

#### 4.1 Unit Tests

**File**: `__tests__/workflow-parser.test.ts`

Add comprehensive tests for Docker image parsing:

```typescript
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

  it('Parses image with digest', () => {
    const result = parser.parseDockerImage('node@sha256:abc123')
    expect(result).toEqual({
      registry: 'hub.docker.com',
      namespace: 'library',
      image: 'node',
      digest: 'sha256:abc123',
      originalReference: 'node@sha256:abc123'
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

  // More test cases...
})
```

#### 4.2 Integration Tests

**File**: `__tests__/docker-workflow-parsing.test.ts`

Create test fixtures with Docker references:

```yaml
# __fixtures__/workflows/docker-containers.yml
name: Docker Test
on: push
jobs:
  container-job:
    runs-on: ubuntu-latest
    container:
      image: node:18
    steps:
      - uses: actions/checkout@v4

  docker-step:
    runs-on: ubuntu-latest
    steps:
      - uses: docker://alpine:latest
        with:
          args: echo hello
```

#### 4.3 PURL Generation Tests

**File**: `__tests__/dependency-submitter.test.ts`

Add tests for Docker PURL generation:

```typescript
describe('createDockerPackageUrl', () => {
  it('Creates PURL for Docker Hub image', () => {
    const purl = submitter.createDockerPackageUrl({
      registry: 'hub.docker.com',
      namespace: 'library',
      image: 'alpine',
      tag: '3.18',
      originalReference: 'alpine:3.18'
    })
    expect(purl).toBe('pkg:docker/library/alpine@3.18')
  })

  it('Creates PURL with digest', () => {
    const purl = submitter.createDockerPackageUrl({
      registry: 'hub.docker.com',
      namespace: 'library',
      image: 'node',
      digest: 'sha256:abc123',
      originalReference: 'node@sha256:abc123'
    })
    expect(purl).toBe('pkg:docker/library/node@sha256%3Aabc123')
  })

  it('Creates PURL with repository_url for non-Docker Hub', () => {
    const purl = submitter.createDockerPackageUrl({
      registry: 'ghcr.io',
      namespace: 'owner',
      image: 'image',
      tag: 'v1.0.0',
      originalReference: 'ghcr.io/owner/image:v1.0.0'
    })
    expect(purl).toBe('pkg:docker/owner/image@v1.0.0?repository_url=ghcr.io')
  })
})
```

### Phase 5: Documentation

#### 5.1 Update README.md

Add section explaining Docker dependency reporting:

```markdown
## Docker Container Dependencies

The action automatically detects and reports Docker container images used in your
workflows:

- **Job-level containers**: Images specified in `jobs.<job_id>.container.image`
- **Step-level Docker actions**: Images referenced with `docker://` in step `uses:`
- **Docker container actions**: Images referenced in `action.yml` files

### Example

```yaml
jobs:
  my-job:
    runs-on: ubuntu-latest
    container:
      image: node:18
    steps:
      - uses: docker://alpine:latest
```

This will report:

- `pkg:docker/library/node@18` (job container)
- `pkg:docker/library/alpine@latest` (step Docker action)

### Disabling Docker Dependency Reporting

If you want to report only GitHub Actions dependencies:

```yaml
- uses: jessehouwing/actions-dependency-submission@v1
  with:
    token: ${{ secrets.GITHUB_TOKEN }}
    report-docker-dependencies: false
```

```

#### 5.2 Create Docker Dependencies Guide

**File**: `docs/docker-dependencies.md`

Create comprehensive documentation about Docker dependency reporting:

- How Docker images are detected
- PURL format explanation
- Security benefits
- Examples
- Troubleshooting

## Appendix: Real-World Workflow Examples

This section documents actual workflows from GitHub repositories that use the various Docker patterns. These examples serve as test cases to ensure the parsing logic handles real-world scenarios correctly.

### Example 1: PostgreSQL Service Container with Job Container

**Source**: [actions/example-services](https://github.com/actions/example-services/blob/main/.github/workflows/postgres-service.yml)

```yaml
name: Postgres Service Example
on: [push, pull_request]

jobs:
  container-job:
    runs-on: ubuntu-latest
    container:
      image: node:10.16-jessie  # Job-level container
    services:
      postgres:
        image: postgres:10.8     # Service container
        env:
          POSTGRES_USER: postgres
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: postgres
        ports:
          - 5432:5432
        options: --health-cmd pg_isready --health-interval 10s
    steps:
      - uses: actions/checkout@v1
      - run: npm ci
```

**Expected Dependencies Extracted:**
- `pkg:docker/library/node@10.16-jessie` (job container)
- `pkg:docker/library/postgres@10.8` (service container)

**Parsing Notes:**
- Job-level container with specific tag format (major.minor-variant)
- Service container with environment variables
- Health check options (parsed but not reported as dependency)

---

### Example 2: Docker Container Action with Dockerfile

**Source**: [actions/hello-world-docker-action](https://github.com/actions/hello-world-docker-action)

**action.yml:**
```yaml
name: Hello, World!
description: Greet someone and record the time
inputs:
  who-to-greet:
    description: Who to greet
    required: true
    default: World
runs:
  using: docker
  image: Dockerfile  # References local Dockerfile
```

**Dockerfile:**
```dockerfile
FROM alpine:3.22

WORKDIR /usr/src
COPY entrypoint.sh .

RUN addgroup -S actiongroup && adduser -S actionuser -G actiongroup && \
    chown -R actionuser:actiongroup /usr/src && \
    chmod +x /usr/src/entrypoint.sh

USER actionuser
ENTRYPOINT ["/usr/src/entrypoint.sh"]
```

**Expected Dependencies Extracted:**
- From action.yml: Recognizes `image: Dockerfile` 
- From Dockerfile: `pkg:docker/library/alpine@3.22` (base image)

**Parsing Notes:**
- `runs.using: docker` with `image: Dockerfile` triggers Dockerfile parsing
- Single `FROM` instruction with specific version tag
- Multi-line RUN commands should not interfere with FROM extraction

---

### Example 3: Multi-Stage Dockerfile

**Hypothetical Example** (common pattern in real projects):

```dockerfile
# Build stage
FROM node:18-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Production stage
FROM node:18-alpine AS production
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
CMD ["node", "dist/index.js"]
```

**Expected Dependencies Extracted:**
- `pkg:docker/library/node@18-alpine` (appears twice but should be deduplicated)

**Parsing Notes:**
- Multiple `FROM` instructions with same base image
- Stage names (`AS build`, `AS production`) extracted for debugging
- Should report unique base images only once

---

### Example 4: Platform-Specific Base Image

**Example:**

```dockerfile
FROM --platform=linux/amd64 ubuntu:22.04
RUN apt-get update && apt-get install -y curl
```

**Expected Dependencies Extracted:**
- `pkg:docker/library/ubuntu@22.04`

**Parsing Notes:**
- `--platform` flag should be parsed but not included in dependency
- Standard Ubuntu official image format

---

### Example 5: Variable Reference (Warning Case)

**Example:**

```dockerfile
ARG BASE_IMAGE=node:18
FROM $BASE_IMAGE
```

**Expected Behavior:**
- Log warning: "Dockerfile references variable in FROM: $BASE_IMAGE. Variable substitution is not supported."
- Skip this FROM instruction (no dependency reported)

**Parsing Notes:**
- Variables starting with `$` trigger warning
- `ARG` resolution not attempted in initial implementation

---

### Example 6: Scratch Base (Skip Case)

**Example:**

```dockerfile
FROM scratch
COPY myapp /
ENTRYPOINT ["/myapp"]
```

**Expected Behavior:**
- Skip `FROM scratch` (no dependency reported)

**Parsing Notes:**
- `scratch` is a special Docker keyword for empty base images
- No security vulnerabilities to track for scratch

---

### Example 7: Step-Level Docker Action

**Example workflow:**

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: docker://alpine:3.18
        with:
          args: echo "Hello from Alpine"
```

**Expected Dependencies Extracted:**
- `pkg:docker/library/alpine@3.18`

**Parsing Notes:**
- `docker://` prefix triggers Docker image parsing
- No Dockerfile to parse (pre-built image)

---

### Example 8: GHCR (GitHub Container Registry)

**Example:**

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    container:
      image: ghcr.io/owner/myapp:v1.2.3
```

**Expected Dependencies Extracted:**
- `pkg:docker/owner/myapp@v1.2.3?repository_url=ghcr.io`

**Parsing Notes:**
- Non-Docker Hub registry requires `repository_url` qualifier
- Namespace extracted from path after registry

---

## Validation Test Cases

These real-world examples form the basis for integration tests:

1. **Test Job Containers**: Parse `container.image` field
2. **Test Service Containers**: Parse `services.<id>.image` field  
3. **Test Dockerfile Parsing**: Extract FROM instructions
4. **Test Multi-Stage Builds**: Handle multiple FROM statements
5. **Test Platform Flags**: Ignore --platform in FROM
6. **Test Variable References**: Log warning and skip
7. **Test Scratch**: Skip FROM scratch
8. **Test Docker Protocol**: Parse docker:// in step uses
9. **Test Registry Detection**: Extract registry from image reference
10. **Test Tag Formats**: Handle major, major.minor, major.minor.patch, variants

---

### 1. Parsing Challenges

- **Complex image references**: Need robust parsing for all registry formats
- **Dockerfile references**: When `image: Dockerfile`, parse the Dockerfile to extract
  base images from `FROM` instructions
- **Variable substitution**: Log a warning for cases like `image: ${{ matrix.node-version }}` 
  but do not attempt to resolve the variable

### 2. Registry Resolution

- Default to Docker Hub for images without registry
- Handle common registries: Docker Hub, GHCR, GCR, ECR, etc.
- Consider registry aliases (docker.io vs hub.docker.com)

### 3. Version Handling

- **Digest vs Tag**: Prefer SHA256 digests when available (immutable)
- **Report both**: When both digest and tag are present, report both
- **Tag mutation**: Tags like `latest` can change; document this limitation

### 4. Composite/Docker Actions

- **Dockerfile references**: Parse Dockerfiles to extract base images
- **Pre-built images**: Handle `docker://` references in action.yml
- **Recursive scanning**: Check action.yml files of remote actions

### 5. Security Considerations

- Docker Hub rate limits: No API calls needed for parsing
- Private registries: Document that credentials in workflow don't affect parsing
- Base image tracking: Dockerfile parsing extracts base images for comprehensive dependency tracking

### 6. Configuration

- Make Docker reporting optional (default: enabled)
- Allow filtering specific registries
- Consider excluding patterns (e.g., internal registries)

## Benefits

### Security

1. **Vulnerability tracking**: GitHub Dependency Graph will scan Docker images for
   known vulnerabilities
2. **Security advisories**: Get notified when images have security issues
3. **Supply chain visibility**: Track all Docker images used across workflows

### Compliance

1. **SBOM generation**: Complete software bill of materials including containers
2. **License tracking**: Understand licenses of Docker images used
3. **Audit trail**: Historical record of container image usage

### Operations

1. **Dependency Review**: Block PRs that introduce vulnerable container images
2. **Version tracking**: See which workflows use which image versions
3. **Update management**: Identify workflows using outdated images

## Risks and Mitigation

| Risk                                     | Impact | Mitigation                                   |
| ---------------------------------------- | ------ | -------------------------------------------- |
| Complex parsing errors                   | Medium | Comprehensive test coverage                  |
| False negatives (missed images)          | Medium | Log skipped references, allow user reporting |
| False positives (incorrect parsing)      | Low    | Validate against PURL spec                   |
| Performance impact                       | Low    | No additional API calls needed (Dockerfile parsing is local) |
| Breaking changes to existing users       | High   | Make Docker reporting opt-in initially       |
| Dynamic image references (variables/env) | Medium | Log warning, skip variable-based references  |
| Dockerfile parsing dependency           | Low    | Use well-maintained dockerfile-ast package (MIT license) |

## Timeline Estimate

| Phase            | Effort        | Duration     |
| ---------------- | ------------- | ------------ |
| Phase 1: Parsing (includes Dockerfile parsing) | 3-4 days | Week 1 |
| Phase 2: PURL    | 1-2 days      | Week 1-2     |
| Phase 3: Integration | 1 day     | Week 2       |
| Phase 4: Testing | 2-3 days      | Week 2       |
| Phase 5: Documentation | 1 day    | Week 2       |
| **Total**        | **8-11 days** | **2 weeks**  |

## Success Criteria

1. ✅ Parse all four Docker reference types correctly (container, step, action, service)
2. ✅ Extract base images from Dockerfiles using `dockerfile-ast`
3. ✅ Generate valid PURL format for Docker images
4. ✅ Submit Docker dependencies to GitHub Dependency Graph
5. ✅ No regression in existing GitHub Actions dependency reporting
6. ✅ 90%+ test coverage for new Docker-related code
7. ✅ Comprehensive documentation
8. ✅ No performance degradation

## Future Enhancements

### Phase 6: Advanced Dockerfile Features (Future)

- Enhanced variable resolution (beyond basic warning)
- Support for `ARG` substitution in `FROM` instructions
- Parse `COPY --from=` to understand build dependencies
- Track Dockerfile changes for dependency updates

### Phase 7: Advanced Features (Future)

- Image vulnerability scanning integration
- Image update notifications
- Version pinning recommendations
- Support for OCI image format

## References

### GitHub Documentation

- [Workflow Syntax - container](https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions#jobsjob_idcontainer)
- [Workflow Syntax - docker://](https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions#example-using-a-docker-hub-action)
- [Metadata Syntax - runs for Docker](https://docs.github.com/en/actions/creating-actions/metadata-syntax-for-github-actions#runs-for-docker-container-actions)
- [Dependency Graph API](https://docs.github.com/en/rest/dependency-graph)

### PURL Specification

- [PURL Spec - Main](https://github.com/package-url/purl-spec)
- [PURL Spec - Docker Type](https://github.com/package-url/purl-spec/blob/main/types-doc/docker-definition.md)
- [PURL Spec - Docker JSON Schema](https://packageurl.org/types/docker-definition.json)

### Docker Image Reference Format

- [Docker Image Specification](https://docs.docker.com/engine/reference/commandline/pull/#image-and-tag)
- [OCI Distribution Spec](https://github.com/opencontainers/distribution-spec)
- [Docker Registry HTTP API](https://docs.docker.com/registry/spec/api/)

### NPM Packages

- [dockerfile-ast](https://github.com/rcjsuen/dockerfile-ast) - Dockerfile parser (MIT license)
- [dockerfile-ast on npm](https://www.npmjs.com/package/dockerfile-ast)

## Conclusion

This research demonstrates that adding Docker dependency reporting is:

1. **Feasible**: Clear patterns exist for all three Docker usage types
2. **Valuable**: Enhances security visibility for container dependencies
3. **Spec-compliant**: PURL standard fully supports Docker images
4. **Non-breaking**: Can be added without disrupting existing functionality
5. **Well-scoped**: Implementation can be completed in 2 weeks

The recommended approach is to implement this in phases, starting with basic Docker
image parsing and PURL generation, then enhancing with more advanced features like
Dockerfile parsing in future iterations.

## Appendix: Example Workflow Coverage

### Workflow 1: Mixed Dependencies

```yaml
name: Mixed Dependencies
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    container:
      image: node:18
    steps:
      - uses: actions/checkout@v4 # GitHub Action
      - uses: docker://alpine:latest # Docker step
      - uses: myorg/custom-action@v1 # GitHub Action
```

**Expected Dependencies:**

- `pkg:githubactions/actions/checkout@4.*.*` (GitHub Action)
- `pkg:githubactions/myorg/custom-action@1.*.*` (GitHub Action)
- `pkg:docker/library/node@18` (Job container)
- `pkg:docker/library/alpine@latest` (Step Docker)

### Workflow 2: Private Registry

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    container:
      image: ghcr.io/myorg/builder:v2.1.0
      credentials:
        username: ${{ github.actor }}
        password: ${{ secrets.GITHUB_TOKEN }}
    steps:
      - uses: docker://gcr.io/project/tool:latest
```

**Expected Dependencies:**

- `pkg:docker/myorg/builder@v2.1.0?repository_url=ghcr.io` (Job container)
- `pkg:docker/project/tool@latest?repository_url=gcr.io` (Step Docker)

### Workflow 3: Docker Action with Digest

```yaml
jobs:
  secure:
    runs-on: ubuntu-latest
    steps:
      - uses:
          docker://alpine@sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abcd
```

**Expected Dependencies:**

- `pkg:docker/library/alpine@sha256%3Aabc123def456abc123def456abc123def456abc123def456abc123def456abcd`
  (Step Docker with digest)

---

**Document Version:** 1.0
**Date:** 2026-01-09
**Author:** GitHub Copilot (Research Agent)
