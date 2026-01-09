# Docker Dependency Reporting - Research Summary

**Issue:** Research: reporting docker dependencies  
**Status:** ✅ Complete - Ready for Implementation  
**Date:** January 9, 2026

---

## Executive Summary

This research establishes a comprehensive plan for adding Docker container dependency reporting to the `actions-dependency-submission` GitHub Action. The implementation is **feasible**, **spec-compliant**, and **non-breaking**.

## Key Findings

### ✅ Docker Usage Patterns Identified

GitHub Actions can reference Docker containers in **four** ways:

1. **Job-Level Containers** (`jobs.<job_id>.container.image`)
2. **Step-Level Docker Actions** (`uses: docker://image:tag`)
3. **Docker Container Actions** (`action.yml` with `runs.using: docker`)
4. **Service Containers** (`jobs.<job_id>.services.<service>.image`)

All four patterns use compatible Docker image reference formats and can be reported using the same PURL structure.

### ✅ PURL Standard Support

Docker images are supported by the Package URL (PURL) specification:

**Format:** `pkg:docker/<namespace>/<name>@<version>?<qualifiers>`

**Examples:**
- `pkg:docker/library/alpine@3.18` (Docker Hub)
- `pkg:docker/library/node@sha256%3Aabc123...` (with digest)
- `pkg:docker/owner/image@v1.0.0?repository_url=ghcr.io` (GHCR)

**Reference:** [PURL Docker Specification](https://github.com/package-url/purl-spec/blob/main/types-doc/docker-definition.md)

### ✅ Official GitHub Documentation Reviewed

All patterns have been validated against official GitHub documentation:

- ✅ [Workflow Syntax - container](https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions#jobsjob_idcontainer)
- ✅ [Workflow Syntax - docker://](https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions#jobsjob_idstepsuses)
- ✅ [Metadata Syntax - Docker actions](https://docs.github.com/en/actions/creating-actions/metadata-syntax-for-github-actions#runs-for-docker-container-actions)
- ✅ [Workflow Syntax - services](https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions#jobsjob_idservices)

## Implementation Plan

### Estimated Timeline: 7-10 days (2 weeks)

| Phase | Tasks | Duration |
|-------|-------|----------|
| **Phase 1: Parser Enhancement** | Add Docker parsing logic | 2-3 days |
| **Phase 2: PURL Generation** | Generate Docker PURLs | 1-2 days |
| **Phase 3: Integration** | Connect to main flow | 1 day |
| **Phase 4: Testing** | Comprehensive test coverage | 2-3 days |
| **Phase 5: Documentation** | User-facing docs | 1 day |

### Key Components to Implement

**1. Docker Image Parser** (`src/workflow-parser.ts`)
- Parse Docker image references (registry, namespace, image, tag, digest)
- Handle Docker Hub defaults (`library/` namespace)
- Support multiple registries (Docker Hub, GHCR, GCR, ECR)

**2. PURL Generator** (`src/dependency-submitter.ts`)
- Create PURL format: `pkg:docker/<namespace>/<name>@<version>?<qualifiers>`
- URL-encode digests (`sha256:...` → `sha256%3A...`)
- Add `repository_url` qualifier for non-Docker Hub registries

**3. Workflow Extractor** (`src/workflow-parser.ts`)
- Extract from `job.container.image`
- Extract from `job.services.<service>.image`
- Parse `docker://` in step `uses:`
- Parse `runs.image` in action.yml files

**4. Configuration Option** (`action.yml`)
```yaml
inputs:
  report-docker-dependencies:
    description: 'Report Docker container dependencies'
    required: false
    default: 'true'
```

## Benefits

### Security
- ✅ Vulnerability tracking via GitHub Dependency Graph
- ✅ Security advisories for Docker images
- ✅ Supply chain visibility

### Compliance
- ✅ Complete SBOM (Software Bill of Materials)
- ✅ License tracking for containers
- ✅ Audit trail

### Operations
- ✅ Dependency Review integration (block vulnerable images)
- ✅ Version tracking across workflows
- ✅ Update management

## Example Workflow Coverage

### Before (Current State)
```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    container:
      image: node:18                      # ❌ Not reported
    services:
      postgres:
        image: postgres:14                 # ❌ Not reported
    steps:
      - uses: actions/checkout@v4          # ✅ Reported
      - uses: docker://alpine:latest       # ❌ Not reported
```

### After (With Implementation)
```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    container:
      image: node:18                      # ✅ pkg:docker/library/node@18
    services:
      postgres:
        image: postgres:14                 # ✅ pkg:docker/library/postgres@14
    steps:
      - uses: actions/checkout@v4          # ✅ pkg:githubactions/actions/checkout@4.*.*
      - uses: docker://alpine:latest       # ✅ pkg:docker/library/alpine@latest
```

## Documentation Deliverables

### ✅ Created Documentation Files

1. **`docs/docker-dependency-research.md`** (996 lines)
   - Complete research findings
   - PURL specification details
   - Implementation phases with code examples
   - Test strategy
   - Risk assessment
   - Future enhancements

2. **`docs/docker-dependency-spec-summary.md`** (200 lines)
   - Executive summary
   - Quick reference guide
   - Implementation timeline
   - Success criteria

3. **This README** (Quick reference for issue)

## Success Criteria

All criteria are expected to be met:

- ✅ Parse all four Docker reference types correctly
- ✅ Generate valid PURL format for Docker images
- ✅ Submit Docker dependencies to GitHub Dependency Graph
- ✅ No regression in existing GitHub Actions dependency reporting
- ✅ 90%+ test coverage for new Docker-related code
- ✅ Comprehensive documentation
- ✅ No performance degradation

## Risks & Mitigation

| Risk | Impact | Mitigation |
|------|--------|------------|
| Complex parsing errors | Medium | Comprehensive test coverage with edge cases |
| Dockerfile base images not detected | Medium | Document limitation, future phase |
| Dynamic references (variables) | Medium | Log warning, skip variable-based refs |
| Performance impact | Low | No additional API calls needed |
| Breaking changes | High | Make opt-in (default: true but configurable) |

## Future Enhancements (Phase 6+)

- **Dockerfile Parsing**: Extract `FROM` base images
- **Multi-stage Builds**: Handle complex Dockerfiles
- **Image Scanning**: Integrate vulnerability scanning
- **Update Notifications**: Alert on outdated images
- **OCI Format**: Support OCI image specification

## Recommendations

1. **Proceed with Implementation**: All research validates feasibility
2. **Phased Rollout**: Implement in 5 phases as outlined
3. **Default Enabled**: Make Docker reporting default behavior (configurable)
4. **Test Coverage**: Ensure 90%+ coverage for Docker code
5. **Documentation**: Update README with Docker examples

## Next Steps

1. **Review & Approve** this research
2. **Create Implementation Issues** for each phase
3. **Assign Development Resources**
4. **Begin Phase 1: Parser Enhancement**

## References

### Official Documentation
- [GitHub Actions Workflow Syntax](https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions)
- [GitHub Actions Metadata Syntax](https://docs.github.com/en/actions/creating-actions/metadata-syntax-for-github-actions)
- [PURL Specification](https://github.com/package-url/purl-spec)
- [Docker PURL Definition](https://github.com/package-url/purl-spec/blob/main/types-doc/docker-definition.md)

### Research Documents
- **Full Research**: `docs/docker-dependency-research.md`
- **Summary**: `docs/docker-dependency-spec-summary.md`

---

**Research Completed By:** GitHub Copilot (AI Research Agent)  
**Date:** January 9, 2026  
**Repository:** jessehouwing/actions-dependency-submission  
**Branch:** copilot/research-report-docker-dependencies

**Commits:**
- `8d49977` - Update research docs with official GitHub documentation details
- `cd4e78d` - Add comprehensive Docker dependency research and implementation plan
- `7b5e709` - Initial plan

---

## Conclusion

Docker dependency reporting for GitHub Actions workflows is:

✅ **Feasible** - Clear implementation path  
✅ **Valuable** - Significant security benefits  
✅ **Spec-Compliant** - Full PURL standard support  
✅ **Non-Breaking** - Additive feature with configuration  
✅ **Well-Scoped** - Realistic 2-week implementation  

**Status: Ready for Implementation** 🚀
