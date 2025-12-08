import * as core from '@actions/core'
import { getOctokit } from '@actions/github'
import type { ResolvedDependency } from './fork-resolver.js'

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
      isTransitive && !reportTransitiveAsDirect ? 'indirect' : 'direct'

    // When a SHA was resolved to a version, report both:
    // - The SHA as a direct dependency (or indirect if transitive and not reporting as direct)
    // - The version as an indirect dependency
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
        scope: 'runtime'
      })
      count++

      // Add version as indirect
      const versionPurl = this.createPackageUrl(owner, repo, ref, actionPath)
      manifests.push({
        package_url: versionPurl,
        relationship: 'indirect',
        scope: 'runtime'
      })
      count++
    } else {
      // No SHA resolution - add the dependency based on configuration
      const purl = this.createPackageUrl(owner, repo, ref, actionPath)
      manifests.push({
        package_url: purl,
        relationship: effectiveRelationship,
        scope: 'runtime'
      })
      count++
    }

    return count
  }

  /**
   * Submits dependencies to GitHub
   *
   * @param dependencies Array of resolved dependencies
   * @returns Number of dependencies submitted
   */
  async submitDependencies(
    dependencies: ResolvedDependency[]
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
                `    - ${dep.package_url} (${dep.relationship || 'direct'}, ${dep.scope || 'runtime'})`
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
   * Converts a version reference to wildcard format
   *
   * @param ref Version/ref (e.g., v1, v1.2, v1.2.3)
   * @returns Version with wildcards (e.g., v1.*.*, v1.2.*, v1.2.3)
   */
  private convertToWildcardVersion(ref: string): string {
    // Match semver-like version patterns: v1, v1.2, v1.2.3
    const versionMatch = ref.match(/^v(\d+)(?:\.(\d+))?(?:\.(\d+))?$/)

    if (!versionMatch) {
      // Not a semver version reference, return as-is
      return ref
    }

    const [, major, minor, patch] = versionMatch

    // Build version with wildcards for missing parts
    if (patch !== undefined) {
      // v1.2.3 - all parts present
      return ref
    } else if (minor !== undefined) {
      // v1.2 - missing patch
      return `v${major}.${minor}.*`
    } else {
      // v1 - missing minor and patch
      return `v${major}.*.*`
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
}
