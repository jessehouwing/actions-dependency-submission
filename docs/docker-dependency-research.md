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

**Reference:**
[GitHub Docs - jobs.<job_id>.steps[*].uses (Docker
section)](https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions#example-using-a-docker-hub-action)

### 3. Composite/Docker Actions (`action.yml` with `runs.using: docker`)

Custom actions that run in Docker containers, defined in `action.yml`.

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
2. **Step-level Docker actions**: Already handled by `parseUsesString`
3. **Action.yml files**: Parse `runs.image` field when `runs.using === 'docker'`

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
  // Extract from job.container.image
  if (workflow.jobs) {
    for (const jobName in workflow.jobs) {
      const job = workflow.jobs[jobName]
      if (job.container?.image) {
        const dockerDep = this.parseDockerImage(job.container.image)
        if (dockerDep) {
          dockerDep.sourcePath = sourcePath
          dependencies.push(dockerDep)
        }
      }
    }
  }
}
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

## Implementation Considerations

### 1. Parsing Challenges

- **Complex image references**: Need robust parsing for all registry formats
- **Dockerfile references**: When `image: Dockerfile`, we can't determine the base
  image without parsing the Dockerfile
- **Variable substitution**: Handle cases like `image: ${{ matrix.node-version }}`

### 2. Registry Resolution

- Default to Docker Hub for images without registry
- Handle common registries: Docker Hub, GHCR, GCR, ECR, etc.
- Consider registry aliases (docker.io vs hub.docker.com)

### 3. Version Handling

- **Digest vs Tag**: Prefer SHA256 digests when available (immutable)
- **Report both**: When both digest and tag are present, report both
- **Tag mutation**: Tags like `latest` can change; document this limitation

### 4. Composite/Docker Actions

- **Dockerfile references**: Skip or document limitation
- **Pre-built images**: Handle `docker://` references in action.yml
- **Recursive scanning**: Check action.yml files of remote actions

### 5. Security Considerations

- Docker Hub rate limits: No API calls needed for parsing
- Private registries: Document that credentials in workflow don't affect parsing
- Base image tracking: Consider adding Dockerfile parsing in future phase

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
| Performance impact                       | Low    | No additional API calls needed               |
| Breaking changes to existing users       | High   | Make Docker reporting opt-in initially       |
| Dockerfile base image not detected       | Medium | Document limitation, consider future phase   |
| Dynamic image references (variables/env) | Medium | Log warning, skip variable-based references  |

## Timeline Estimate

| Phase            | Effort        | Duration     |
| ---------------- | ------------- | ------------ |
| Phase 1: Parsing | 2-3 days      | Week 1       |
| Phase 2: PURL    | 1-2 days      | Week 1       |
| Phase 3: Integration | 1 day     | Week 2       |
| Phase 4: Testing | 2-3 days      | Week 2       |
| Phase 5: Documentation | 1 day    | Week 2       |
| **Total**        | **7-10 days** | **2 weeks**  |

## Success Criteria

1. ✅ Parse all three Docker reference types correctly
2. ✅ Generate valid PURL format for Docker images
3. ✅ Submit Docker dependencies to GitHub Dependency Graph
4. ✅ No regression in existing GitHub Actions dependency reporting
5. ✅ 90%+ test coverage for new Docker-related code
6. ✅ Comprehensive documentation
7. ✅ No performance degradation

## Future Enhancements

### Phase 6: Dockerfile Parsing (Future)

- Parse Dockerfile to extract base images
- Handle multi-stage builds
- Report transitive dependencies from Dockerfiles

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
