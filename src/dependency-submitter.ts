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

      // When a SHA was resolved to a version, report both:
      // - The SHA as a direct dependency
      // - The version as an indirect dependency
      if (dep.originalSha) {
        // Add SHA as direct
        const shaPurl = this.createPackageUrl(
          dep.owner,
          dep.repo,
          dep.originalSha
        )
        sourceManifests.push({
          package_url: shaPurl,
          relationship: 'direct',
          scope: 'runtime'
        })
        dependencyCount++

        // Add version as indirect
        const versionPurl = this.createPackageUrl(dep.owner, dep.repo, dep.ref)
        sourceManifests.push({
          package_url: versionPurl,
          relationship: 'indirect',
          scope: 'runtime'
        })
        dependencyCount++

        core.info(
          `Resolved SHA ${dep.originalSha} to version ${dep.ref} for ${dep.owner}/${dep.repo} - reporting both`
        )
      } else {
        // No SHA resolution - add the dependency as direct
        const purl = this.createPackageUrl(dep.owner, dep.repo, dep.ref)
        sourceManifests.push({
          package_url: purl,
          relationship: 'direct',
          scope: 'runtime'
        })
        dependencyCount++
      }

      // Also add the original repository if it exists
      if (dep.original) {
        // If we have an originalSha, add both SHA and version for the original too
        if (dep.originalSha) {
          // Add SHA as direct
          const originalShaPurl = this.createPackageUrl(
            dep.original.owner,
            dep.original.repo,
            dep.originalSha
          )
          sourceManifests.push({
            package_url: originalShaPurl,
            relationship: 'direct',
            scope: 'runtime'
          })
          dependencyCount++

          // Add version as indirect
          const originalVersionPurl = this.createPackageUrl(
            dep.original.owner,
            dep.original.repo,
            dep.ref
          )
          sourceManifests.push({
            package_url: originalVersionPurl,
            relationship: 'indirect',
            scope: 'runtime'
          })
          dependencyCount++
        } else {
          // No SHA resolution - just add the original as direct
          const originalPurl = this.createPackageUrl(
            dep.original.owner,
            dep.original.repo,
            dep.ref
          )
          sourceManifests.push({
            package_url: originalPurl,
            relationship: 'direct',
            scope: 'runtime'
          })
          dependencyCount++
        }

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
   * @returns Package URL string
   */
  private createPackageUrl(owner: string, repo: string, ref: string): string {
    // Convert version to wildcard format if applicable
    const version = this.convertToWildcardVersion(ref)
    // Package URL format for GitHub Actions
    return `pkg:githubactions/${owner}/${repo}@${version}`
  }
}
