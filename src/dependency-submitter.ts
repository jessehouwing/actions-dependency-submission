import * as core from '@actions/core'
import { getOctokit } from '@actions/github'
import type { ResolvedDependency } from './fork-resolver.js'
import type { DockerDependency } from './workflow-parser.js'

/**
 * Constants for dependency relationships and scopes
 */
const DEPENDENCY_RELATIONSHIP = {
  DIRECT: 'direct',
  INDIRECT: 'indirect'
} as const

const DEPENDENCY_SCOPE = {
  RUNTIME: undefined
} as const

/**
 * Configuration for dependency submission
 */
export interface DependencySubmitterConfig {
  token: string
  repository: string
  sha: string
  ref: string
  reportTransitiveAsDirect?: boolean
}

/**
 * Submits dependencies to GitHub's Dependency Graph
 */
export class DependencySubmitter {
  private octokit: ReturnType<typeof getOctokit>
  private config: DependencySubmitterConfig

  constructor(config: DependencySubmitterConfig) {
    this.config = config
    this.octokit = getOctokit(config.token)
  }

  /**
   * Adds dependency entries for a repository, handling SHA resolution if applicable
   *
   * @param owner Repository owner
   * @param repo Repository name
   * @param ref Version/ref
   * @param originalSha Original SHA if resolved to version
   * @param manifests Array to add dependency entries to
   * @param isTransitive Whether this is a transitive/indirect dependency (e.g., resolved from a fork)
   * @param actionPath Optional path within the repository (for actions in subfolders)
   * @returns Number of dependencies added
   */
  private addDependencyEntries(
    owner: string,
    repo: string,
    ref: string,
    originalSha: string | undefined,
    manifests: {
      package_url?: string
      relationship?: 'direct' | 'indirect'
      scope?: 'runtime' | 'development'
    }[],
    isTransitive: boolean = false,
    actionPath?: string
  ): number {
    let count = 0

    // Determine the effective relationship based on configuration
    const reportTransitiveAsDirect =
      this.config.reportTransitiveAsDirect !== false
    const effectiveRelationship =
      isTransitive && !reportTransitiveAsDirect
        ? DEPENDENCY_RELATIONSHIP.INDIRECT
        : DEPENDENCY_RELATIONSHIP.DIRECT

    // When a SHA was resolved to a version, report both:
    // - The SHA with the effective relationship (direct or indirect based on configuration)
    // - The version with the same relationship when reportTransitiveAsDirect is true, otherwise indirect
    if (originalSha) {
      // Add SHA
      const shaPurl = this.createPackageUrl(
        owner,
        repo,
        originalSha,
        actionPath
      )
      manifests.push({
        package_url: shaPurl,
        relationship: effectiveRelationship,
        scope: DEPENDENCY_SCOPE.RUNTIME
      })
      count++

      // Add version - use same relationship as SHA when reporting transitive as direct
      const versionPurl = this.createPackageUrl(owner, repo, ref, actionPath)
      manifests.push({
        package_url: versionPurl,
        relationship: reportTransitiveAsDirect
          ? effectiveRelationship
          : DEPENDENCY_RELATIONSHIP.INDIRECT,
        scope: DEPENDENCY_SCOPE.RUNTIME
      })
      count++
    } else {
      // No SHA resolution - add the dependency based on configuration
      const purl = this.createPackageUrl(owner, repo, ref, actionPath)
      manifests.push({
        package_url: purl,
        relationship: effectiveRelationship,
        scope: DEPENDENCY_SCOPE.RUNTIME
      })
      count++
    }

    return count
  }

  /**
   * Submits dependencies to GitHub
   *
   * @param dependencies Array of resolved dependencies
   * @param dockerDependencies Array of Docker dependencies
   * @returns Number of dependencies submitted
   */
  async submitDependencies(
    dependencies: ResolvedDependency[],
    dockerDependencies: DockerDependency[] = []
  ): Promise<number> {
    const [owner, repo] = this.config.repository.split('/')

    // Group dependencies by source path
    const dependenciesBySource = new Map<
      string,
      {
        package_url?: string
        relationship?: 'direct' | 'indirect'
        scope?: 'runtime' | 'development'
      }[]
    >()

    let dependencyCount = 0

    // Build dependency manifests grouped by source file
    for (const dep of dependencies) {
      const sourcePath = dep.sourcePath || 'github-actions.yml'

      if (!dependenciesBySource.has(sourcePath)) {
        dependenciesBySource.set(sourcePath, [])
      }

      const sourceManifests = dependenciesBySource.get(sourcePath)!

      // Add dependency entries for the forked repository
      // Use isTransitive flag if set, otherwise default to false (direct)
      dependencyCount += this.addDependencyEntries(
        dep.owner,
        dep.repo,
        dep.ref,
        dep.originalSha,
        sourceManifests,
        dep.isTransitive || false,
        dep.actionPath
      )

      if (dep.originalSha) {
        core.info(
          `Resolved SHA ${dep.originalSha} to version ${dep.ref} for ${dep.owner}/${dep.repo} - reporting both`
        )
      }

      // Also add the original repository if it exists
      if (dep.original) {
        dependencyCount += this.addDependencyEntries(
          dep.original.owner,
          dep.original.repo,
          dep.ref,
          dep.originalSha,
          sourceManifests,
          true, // Mark original repo dependencies as transitive/indirect
          dep.actionPath
        )

        core.info(
          `Submitting both ${dep.owner}/${dep.repo} and original ${dep.original.owner}/${dep.original.repo}`
        )
      }
    }

    // Add Docker dependencies
    for (const dockerDep of dockerDependencies) {
      const sourcePath = dockerDep.sourcePath || 'github-actions.yml'

      if (!dependenciesBySource.has(sourcePath)) {
        dependenciesBySource.set(sourcePath, [])
      }

      const sourceManifests = dependenciesBySource.get(sourcePath)!

      // Docker dependencies from this repository are direct
      // Docker dependencies from remote repositories (transitive) are indirect
      const isTransitive = dockerDep.isTransitive || false

      // Determine the effective relationship based on configuration
      const reportTransitiveAsDirect =
        this.config.reportTransitiveAsDirect !== false
      const effectiveRelationship =
        isTransitive && !reportTransitiveAsDirect
          ? DEPENDENCY_RELATIONSHIP.INDIRECT
          : DEPENDENCY_RELATIONSHIP.DIRECT

      const purl = this.createDockerPackageUrl(dockerDep)
      sourceManifests.push({
        package_url: purl,
        relationship: effectiveRelationship,
        scope: DEPENDENCY_SCOPE.RUNTIME
      })
      dependencyCount++

      core.debug(`Added Docker dependency: ${purl} (${effectiveRelationship})`)
    }

    // Convert grouped dependencies to manifest format
    const manifests: Record<
      string,
      {
        name: string
        file?: {
          source_location?: string
        }
        resolved: Record<
          string,
          {
            package_url?: string
            relationship?: 'direct' | 'indirect'
            scope?: 'runtime' | 'development'
          }
        >
      }
    > = {}

    for (const [sourcePath, deps] of dependenciesBySource.entries()) {
      // Convert array to record keyed by package_url
      const resolved: Record<
        string,
        {
          package_url?: string
          relationship?: 'direct' | 'indirect'
          scope?: 'runtime' | 'development'
        }
      > = {}

      for (const dep of deps) {
        if (dep.package_url) {
          resolved[dep.package_url] = dep
        }
      }

      manifests[sourcePath] = {
        name: sourcePath,
        file: {
          source_location: sourcePath
        },
        resolved
      }
    }

    try {
      core.info(`Submitting ${dependencyCount} dependencies to GitHub`)

      // Log all dependencies being submitted when debug logging is enabled
      if (core.isDebug()) {
        core.debug('Dependencies being submitted:')
        for (const [sourcePath, deps] of dependenciesBySource.entries()) {
          core.debug(`  From ${sourcePath}:`)
          for (const dep of deps) {
            if (dep.package_url) {
              core.debug(
                `    - ${dep.package_url} (${dep.relationship || DEPENDENCY_RELATIONSHIP.DIRECT}, ${dep.scope || DEPENDENCY_SCOPE.RUNTIME})`
              )
            }
          }
        }
      }

      await this.octokit.rest.dependencyGraph.createRepositorySnapshot({
        owner,
        repo,
        version: 0,
        job: {
          correlator: `${this.config.repository}-${this.config.sha}`,
          id: this.config.sha
        },
        sha: this.config.sha,
        ref: this.config.ref,
        detector: {
          name: 'actions-dependency-submission',
          version: '1.0.0',
          url: 'https://github.com/jessehouwing/actions-dependency-submission'
        },
        scanned: new Date().toISOString(),
        manifests
      })
      core.info('Dependencies submitted successfully')
    } catch (error) {
      if (error instanceof Error) {
        core.error(`Failed to submit dependencies: ${error.message}`)
        throw error
      }
      throw new Error('Failed to submit dependencies')
    }

    return dependencyCount
  }

  /**
   * Converts a version reference to wildcard format and removes 'v' prefix
   *
   * @param ref Version/ref (e.g., v1, v1.2, v1.2.3)
   * @returns Version with wildcards and without 'v' prefix (e.g., 1.*.*, 1.2.*, 1.2.3)
   */
  private convertToWildcardVersion(ref: string): string {
    // Match semver-like version patterns: v1, v1.2, v1.2.3
    const versionMatch = ref.match(/^v(\d+)(?:\.(\d+))?(?:\.(\d+))?$/)

    if (!versionMatch) {
      // Not a semver version reference, return as-is
      return ref
    }

    const [, major, minor, patch] = versionMatch

    // Build version with wildcards for missing parts (without 'v' prefix)
    if (patch !== undefined) {
      // v1.2.3 - all parts present
      return `${major}.${minor}.${patch}`
    } else if (minor !== undefined) {
      // v1.2 - missing patch
      return `${major}.${minor}.*`
    } else {
      // v1 - missing minor and patch
      return `${major}.*.*`
    }
  }

  /**
   * Creates a Package URL (purl) for a GitHub Action
   *
   * @param owner Repository owner
   * @param repo Repository name
   * @param ref Version/ref
   * @param actionPath Optional path within the repository (for actions in subfolders)
   * @returns Package URL string
   */
  private createPackageUrl(
    owner: string,
    repo: string,
    ref: string,
    actionPath?: string
  ): string {
    // Convert version to wildcard format if applicable
    const version = this.convertToWildcardVersion(ref)
    // Build the repository path (repo or repo/path for subfolder actions)
    const repoPath = actionPath ? `${repo}/${actionPath}` : repo
    // Package URL format for GitHub Actions
    return `pkg:githubactions/${owner}/${repoPath}@${version}`
  }

  /**
   * Creates a Package URL (purl) for a Docker image
   * Follows the PURL specification: https://github.com/package-url/purl-spec/blob/main/PURL-TYPES.rst#docker
   *
   * @param dockerDep Docker dependency object
   * @returns Package URL string
   */
  private createDockerPackageUrl(dockerDep: DockerDependency): string {
    // Build the namespace/name part
    // For Docker Hub library images: pkg:docker/library/alpine@3.18
    // For Docker Hub user images: pkg:docker/username/image@tag
    // For other registries: pkg:docker/namespace/image@tag?repository_url=registry.com

    const namespacePart = dockerDep.namespace ? `${dockerDep.namespace}/` : ''
    const basePurl = `pkg:docker/${namespacePart}${dockerDep.image}`

    // Use digest if available, otherwise tag
    const version = dockerDep.digest || dockerDep.tag || 'latest'

    // Add version
    let purl = `${basePurl}@${version}`

    // Add repository_url qualifier for non-Docker Hub registries
    if (dockerDep.registry && dockerDep.registry !== 'hub.docker.com') {
      purl += `?repository_url=${encodeURIComponent(dockerDep.registry)}`
    }

    return purl
  }
}
