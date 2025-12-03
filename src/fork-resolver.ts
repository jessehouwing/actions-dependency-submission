import * as core from '@actions/core'
import { getOctokit } from '@actions/github'
import type { ActionDependency } from './workflow-parser.js'

/**
 * Represents a resolved dependency with potential fork information
 */
export interface ResolvedDependency {
  owner: string
  repo: string
  ref: string
  sourcePath?: string
  original?: {
    owner: string
    repo: string
  }
}

/**
 * Configuration for fork resolution
 */
export interface ForkResolverConfig {
  forkOrganizations: string[]
  forkRegex?: RegExp
  token: string
}

/**
 * Resolves forked action dependencies to their original sources
 */
export class ForkResolver {
  private forkOrganizations: Set<string>
  private forkRegex?: RegExp
  private octokit: ReturnType<typeof getOctokit>

  constructor(config: ForkResolverConfig) {
    this.forkOrganizations = new Set(config.forkOrganizations)
    this.forkRegex = config.forkRegex
    this.octokit = getOctokit(config.token)
  }

  /**
   * Resolves dependencies, identifying forked actions and their originals
   *
   * @param dependencies Array of action dependencies
   * @returns Array of resolved dependencies with fork information
   */
  async resolveDependencies(
    dependencies: ActionDependency[]
  ): Promise<ResolvedDependency[]> {
    const resolved: ResolvedDependency[] = []
    const uniqueDeps = this.deduplicateDependencies(dependencies)

    for (const dep of uniqueDeps) {
      const resolvedDep = await this.resolveDependency(dep)
      resolved.push(resolvedDep)
    }

    return resolved
  }

  /**
   * Resolves a single dependency
   *
   * @param dependency Action dependency to resolve
   * @returns Resolved dependency with potential fork information
   */
  private async resolveDependency(
    dependency: ActionDependency
  ): Promise<ResolvedDependency> {
    const base: ResolvedDependency = {
      owner: dependency.owner,
      repo: dependency.repo,
      ref: dependency.ref,
      sourcePath: dependency.sourcePath
    }

    // Check if this dependency is from a fork organization
    if (!this.forkOrganizations.has(dependency.owner)) {
      return base
    }

    core.debug(
      `Checking fork status for ${dependency.owner}/${dependency.repo}`
    )

    // Try to find the original repository
    const original = await this.findOriginalRepository(
      dependency.owner,
      dependency.repo
    )

    if (original) {
      base.original = original
      core.info(
        `Found original for ${dependency.owner}/${dependency.repo}: ${original.owner}/${original.repo}`
      )
    }

    return base
  }

  /**
   * Finds the original repository for a fork
   *
   * @param owner Fork owner
   * @param repo Fork repository name
   * @returns Original repository information or undefined
   */
  private async findOriginalRepository(
    owner: string,
    repo: string
  ): Promise<{ owner: string; repo: string } | undefined> {
    // First, try using the fork regex pattern if provided
    if (this.forkRegex) {
      const regexResult = this.applyForkRegex(owner, repo)
      if (regexResult) {
        return regexResult
      }
    }

    // Then, try to get fork information from GitHub API
    try {
      const { data } = await this.octokit.rest.repos.get({
        owner,
        repo
      })

      if (data.fork && data.parent) {
        return {
          owner: data.parent.owner.login,
          repo: data.parent.name
        }
      }
    } catch (error) {
      core.debug(
        `Failed to fetch repository info for ${owner}/${repo}: ${error}`
      )
    }

    return undefined
  }

  /**
   * Applies the fork regex pattern to extract original repository information
   *
   * @param owner Repository owner
   * @param repo Repository name
   * @returns Original repository information or undefined
   */
  private applyForkRegex(
    owner: string,
    repo: string
  ): { owner: string; repo: string } | undefined {
    if (!this.forkRegex) {
      return undefined
    }

    const fullName = `${owner}/${repo}`
    const match = fullName.match(this.forkRegex)

    if (match?.groups?.org && match?.groups?.repo) {
      return {
        owner: match.groups.org,
        repo: match.groups.repo
      }
    }

    return undefined
  }

  /**
   * Deduplicates dependencies by owner/repo/ref combination
   *
   * @param dependencies Array of dependencies
   * @returns Deduplicated array
   */
  private deduplicateDependencies(
    dependencies: ActionDependency[]
  ): ActionDependency[] {
    const seen = new Set<string>()
    return dependencies.filter((dep) => {
      const key = `${dep.owner}/${dep.repo}@${dep.ref}`
      if (seen.has(key)) {
        return false
      }
      seen.add(key)
      return true
    })
  }
}
