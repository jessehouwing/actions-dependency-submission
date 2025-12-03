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
    const manifests: Record<
      string,
      {
        package_url?: string
        relationship?: 'direct' | 'indirect'
        scope?: 'runtime' | 'development'
      }
    > = {}

    let dependencyCount = 0

    // Build dependency manifests
    for (const dep of dependencies) {
      // Add the forked repository
      const forkedPurl = this.createPackageUrl(dep.owner, dep.repo, dep.ref)
      manifests[forkedPurl] = {
        package_url: forkedPurl,
        relationship: 'direct',
        scope: 'runtime'
      }
      dependencyCount++

      // Also add the original repository if it exists
      if (dep.original) {
        const originalPurl = this.createPackageUrl(
          dep.original.owner,
          dep.original.repo,
          dep.ref
        )
        manifests[originalPurl] = {
          package_url: originalPurl,
          relationship: 'direct',
          scope: 'runtime'
        }
        dependencyCount++
        core.info(
          `Submitting both ${dep.owner}/${dep.repo} and original ${dep.original.owner}/${dep.original.repo}`
        )
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
        manifests: {
          'github-actions.yml': {
            name: 'github-actions.yml',
            resolved: manifests,
            // @ts-expect-error - ecosystem is supported by the API but not yet in Octokit types
            ecosystem: 'github-actions'
          }
        }
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
   * Creates a Package URL (purl) for a GitHub Action
   *
   * @param owner Repository owner
   * @param repo Repository name
   * @param ref Version/ref
   * @returns Package URL string
   */
  private createPackageUrl(owner: string, repo: string, ref: string): string {
    // Package URL format for GitHub Actions
    return `pkg:github/${owner}/${repo}@${ref}`
  }
}
