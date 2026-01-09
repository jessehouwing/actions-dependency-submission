# Docker Dependency Reporting - Specification Summary

**Issue**: Research: reporting docker dependencies
**Date**: 2026-01-09
**Status**: Research Complete - Ready for Implementation

## Quick Summary

Docker container dependencies can be successfully added to the actions-dependency-submission action using the PURL (Package URL) standard. This will enable vulnerability tracking for Docker images used in GitHub Actions workflows.

## Three Docker Usage Patterns to Support

**Note:** Service containers (`jobs.<job_id>.services`) are also supported as they use the same Docker image format.

### 1. Job-Level Container (`container:` at job level)
```yaml
jobs:
  my-job:
    container:
      image: node:18
```
→ Reports: `pkg:docker/library/node@18`

### 2. Step-Level Docker Action (`docker://` in uses)
```yaml
steps:
  - uses: docker://alpine:latest
```
→ Reports: `pkg:docker/library/alpine@latest`

### 3. Docker Container Actions (action.yml with runs.image)

**Option A: Pre-built image**
```yaml
# action.yml
runs:
  using: 'docker'
  image: 'docker://node:18'
```
→ Reports: `pkg:docker/library/node@18`

**Option B: Local Dockerfile**
```yaml
# action.yml
runs:
  using: 'docker'
  image: 'Dockerfile'
```
```dockerfile
# Dockerfile
FROM alpine:3.22
```
→ Reports: `pkg:docker/library/alpine@3.22` (extracted from Dockerfile)

### 4. Service Containers (services at job level)
```yaml
jobs:
  test:
    services:
      postgres:
        image: postgres:14
```
→ Reports: `pkg:docker/library/postgres@14`

## PURL Format for Docker

**Standard**: `pkg:docker/<namespace>/<name>@<version>?<qualifiers>`

**Examples**:
- Docker Hub: `pkg:docker/library/alpine@3.18`
- With digest: `pkg:docker/library/node@sha256%3Aabc123...`
- GHCR: `pkg:docker/owner/image@v1.0.0?repository_url=ghcr.io`
- GCR: `pkg:docker/project/image@tag?repository_url=gcr.io`

**Reference**: [PURL Docker Specification](https://github.com/package-url/purl-spec/blob/main/types-doc/docker-definition.md)

## Implementation Approach

### Phase 1: Parser Enhancement (3-4 days)
- Add `DockerDependency` interface
- Create Docker image reference parser
- Update `parseUsesString()` to handle `docker://`
- Extract images from `job.container.image` fields
- Extract images from `job.services` fields
- Extract images from `action.yml` files
- **Parse Dockerfiles using `dockerfile-ast` npm package**
- Handle multi-stage builds, platform flags, variable warnings

### Phase 2: PURL Generation (1-2 days)
- Create `createDockerPackageUrl()` method
- Handle registry detection (Docker Hub default)
- Handle namespace resolution (`library/` for Docker Hub)
- URL-encode digests for PURL format

### Phase 3: Integration (1 day)
- Update `main.ts` to collect Docker dependencies
- Add `report-docker-dependencies` configuration option
- Integrate with existing submission flow

### Phase 4: Testing (2-3 days)
- Unit tests for image parsing
- Unit tests for Dockerfile parsing with `dockerfile-ast`
- Unit tests for PURL generation
- Integration tests with workflow fixtures
- Validation against real-world examples (8+ workflows)
- Test coverage for edge cases

### Phase 5: Documentation (1 day)
- Update README with Docker examples
- Create detailed Docker dependencies guide
- Document configuration options
- Add troubleshooting section

**Total Estimate**: 8-11 days over 2 weeks

## Key Benefits

### Security
✅ **Vulnerability Tracking**: GitHub Dependency Graph scans Docker images
✅ **Security Advisories**: Notifications for vulnerable images
✅ **Supply Chain Visibility**: Complete dependency view

### Compliance
✅ **SBOM**: Complete software bill of materials
✅ **License Tracking**: Understand container licenses
✅ **Audit Trail**: Historical dependency records

### Operations
✅ **Dependency Review**: Block PRs with vulnerable images
✅ **Version Tracking**: See which workflows use which images
✅ **Update Management**: Identify outdated images

## Configuration

New optional input in `action.yml`:

```yaml
inputs:
  report-docker-dependencies:
    description: >
      Whether to report Docker container image dependencies from workflows.
      When true, Docker images referenced in job containers, step-level
      docker:// uses, and action.yml files will be reported to the
      Dependency Graph.
    required: false
    default: 'true'
```

## Example Usage

```yaml
- uses: jessehouwing/actions-dependency-submission@v1
  with:
    token: ${{ secrets.GITHUB_TOKEN }}
    report-docker-dependencies: true
```

This will scan and report:
- ✅ GitHub Actions dependencies (existing)
- ✅ Job-level container images (new)
- ✅ Step-level Docker actions (new)
- ✅ Docker container actions from action.yml (new)

## Risks and Mitigation

| Risk | Mitigation |
|------|------------|
| Complex parsing errors | Comprehensive test coverage |
| Dockerfile base images not detected | Document limitation, consider future phase |
| Dynamic references (variables) | Log warning, skip variable-based references |
| Breaking changes | Make opt-in initially (default: true but configurable) |

## Success Criteria

1. ✅ Parse all three Docker reference types correctly
2. ✅ Generate valid PURL format for Docker images
3. ✅ Submit to GitHub Dependency Graph successfully
4. ✅ No regression in existing functionality
5. ✅ 90%+ test coverage for new code
6. ✅ Comprehensive documentation

## Future Enhancements

### Phase 6: Dockerfile Parsing (Future)
- Parse Dockerfile to extract `FROM` base images
- Handle multi-stage builds
- Report transitive Docker dependencies

### Advanced Features (Future)
- Image vulnerability scanning integration
- Automated update notifications
- Version pinning recommendations
- OCI image format support

## References

**Full Research Document**: See `docs/docker-dependency-research.md` for complete details

**GitHub Documentation**:
- [Workflow Syntax - container](https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions#jobsjob_idcontainer)
- [Workflow Syntax - docker://](https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions#example-using-a-docker-hub-action)
- [Metadata Syntax - runs](https://docs.github.com/en/actions/creating-actions/metadata-syntax-for-github-actions#runs-for-docker-container-actions)

**PURL Specification**:
- [PURL Main Spec](https://github.com/package-url/purl-spec)
- [Docker Type Definition](https://github.com/package-url/purl-spec/blob/main/types-doc/docker-definition.md)

## Conclusion

✅ **Feasible**: Clear implementation path for all Docker usage patterns
✅ **Valuable**: Significant security and compliance benefits
✅ **Spec-Compliant**: Full PURL standard support
✅ **Non-Breaking**: Can be added without disrupting existing functionality
✅ **Well-Scoped**: Realistic 2-week timeline

**Recommendation**: Proceed with implementation using the phased approach outlined above.

---

**Next Steps**: Awaiting approval to begin implementation. Once approved, implementation can begin with Phase 1 (Parser Enhancement).
