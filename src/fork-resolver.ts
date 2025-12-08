import * as core from '@actions/core'
import type { ActionDependency } from './workflow-parser.js'
import { OctokitProvider } from './octokit-provider.js'

/**
 * Represents a resolved dependency with potential fork information
 */
export interface ResolvedDependency {
  owner: string
  repo: string
  ref: string
  sourcePath?: string
  originalSha?: string
  isTransitive?: boolean
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
  publicGitHubToken?: string
}

/**
 * Resolves forked action dependencies to their original sources
 */
export class ForkResolver {
  private forkOrganizations: Set<string>
  private forkRegex?: RegExp
  private octokitProvider: OctokitProvider

  constructor(config: ForkResolverConfig) {
    this.forkOrganizations = new Set(config.forkOrganizations)
    this.forkRegex = config.forkRegex
    this.octokitProvider = new OctokitProvider({
      token: config.token,
      publicGitHubToken: config.publicGitHubToken
    })
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
    // Resolve SHA to version if applicable
    let resolvedRef = dependency.ref
    let originalSha: string | undefined
    if (this.isShaReference(dependency.ref)) {
      const versionTag = await this.resolveShaToBestVersion(
        dependency.owner,
        dependency.repo,
        dependency.ref
      )
      if (versionTag) {
        originalSha = dependency.ref
        resolvedRef = versionTag
        core.info(
          `Resolved SHA ${dependency.ref} to version ${versionTag} for ${dependency.owner}/${dependency.repo}`
        )
      }
    }

    const base: ResolvedDependency = {
      owner: dependency.owner,
      repo: dependency.repo,
      ref: resolvedRef,
      sourcePath: dependency.sourcePath,
      originalSha,
      isTransitive: dependency.isTransitive
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

    // Try to get fork information using the appropriate instance
    const repoInfo = await this.octokitProvider.getRepoInfo(owner, repo)

    if (repoInfo?.fork && repoInfo.parent) {
      return {
        owner: repoInfo.parent.owner.login,
        repo: repoInfo.parent.name
      }
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
   * Checks if a reference is a SHA (40-character hex string)
   *
   * @param ref Reference string to check
   * @returns True if ref is a SHA
   */
  private isShaReference(ref: string): boolean {
    return /^[0-9a-f]{40}$/i.test(ref)
  }

  /**
   * Resolves a SHA to the most specific version tag
   *
   * @param owner Repository owner
   * @param repo Repository name
   * @param sha SHA to resolve
   * @returns Most specific version tag or undefined
   */
  private async resolveShaToBestVersion(
    owner: string,
    repo: string,
    sha: string
  ): Promise<string | undefined> {
    try {
      core.debug(`Resolving SHA ${sha} for ${owner}/${repo}`)

      // Fetch tags from the repository (using the appropriate Octokit instance)
      const tags = await this.fetchRepositoryTags(owner, repo)

      // Find tags that match this SHA
      const matchingTags = tags.filter((tag) => tag.sha === sha)

      if (matchingTags.length === 0) {
        core.debug(`No tags found matching SHA ${sha}`)

        // If this is a fork organization, try the parent repository
        if (this.forkOrganizations.has(owner)) {
          const original = await this.findOriginalRepository(owner, repo)
          if (original) {
            core.debug(
              `Trying parent repository ${original.owner}/${original.repo}`
            )
            const parentTags = await this.fetchRepositoryTags(
              original.owner,
              original.repo
            )
            const parentMatches = parentTags.filter((tag) => tag.sha === sha)
            if (parentMatches.length > 0) {
              return this.selectMostSpecificVersion(parentMatches)
            }
          }
        }

        return undefined
      }

      return this.selectMostSpecificVersion(matchingTags)
    } catch (error) {
      core.debug(`Failed to resolve SHA ${sha} for ${owner}/${repo}: ${error}`)
      return undefined
    }
  }

  /**
   * Maximum number of pages to fetch when retrieving tags (100 tags per page)
   * This limits the total to 500 tags, which should be sufficient for most repositories
   */
  private static readonly MAX_TAG_PAGES = 5

  /**
   * Semantic version pattern for matching version tags (e.g., v1, v1.2, v1.2.3)
   */
  private static readonly SEMVER_PATTERN = /^v(\d+)(?:\.(\d+))?(?:\.(\d+))?$/

  /**
   * Fetches tags for a repository
   *
   * @param owner Repository owner
   * @param repo Repository name
   * @returns Array of tags with name and SHA
   */
  private async fetchRepositoryTags(
    owner: string,
    repo: string
  ): Promise<Array<{ name: string; sha: string }>> {
    // Get the appropriate Octokit instance for this repository
    const octokit = await this.octokitProvider.getOctokitForRepo(owner, repo)

    try {
      const tags: Array<{ name: string; sha: string }> = []
      let page = 1
      const perPage = 100

      // Fetch tags up to MAX_TAG_PAGES
      while (page <= ForkResolver.MAX_TAG_PAGES) {
        const { data } = await octokit.rest.repos.listTags({
          owner,
          repo,
          per_page: perPage,
          page
        })

        if (data.length === 0) {
          break
        }

        for (const tag of data) {
          tags.push({
            name: tag.name,
            sha: tag.commit.sha
          })
        }

        if (data.length < perPage) {
          break
        }

        page++
      }

      return tags
    } catch (error) {
      core.debug(`Failed to fetch tags for ${owner}/${repo}: ${error}`)
      return []
    }
  }

  /**
   * Selects the most specific version from matching tags
   *
   * @param tags Array of tags matching the same SHA
   * @returns Most specific version with wildcards if needed, or undefined if no semver tags found
   */
  private selectMostSpecificVersion(
    tags: Array<{ name: string; sha: string }>
  ): string | undefined {
    // Parse version tags (v1.2.3, v1.2, v1)
    const versionTags = tags
      .map((tag) => {
        const match = tag.name.match(ForkResolver.SEMVER_PATTERN)
        if (!match) return null

        const [, major, minor, patch] = match
        return {
          name: tag.name,
          major: parseInt(major, 10),
          minor: minor ? parseInt(minor, 10) : undefined,
          patch: patch ? parseInt(patch, 10) : undefined
        }
      })
      .filter((v) => v !== null)

    if (versionTags.length === 0) {
      // No semantic version tags found, return undefined to keep SHA unchanged
      return undefined
    }

    // Sort by specificity and version numbers
    versionTags.sort(this.compareVersionTags)

    const mostSpecific = versionTags[0]

    // Build version string with wildcards for missing parts
    if (mostSpecific.patch !== undefined) {
      // v1.2.3 - fully specific
      return mostSpecific.name
    } else if (mostSpecific.minor !== undefined) {
      // v1.2 - add wildcard for patch
      return `v${mostSpecific.major}.${mostSpecific.minor}.*`
    } else {
      // v1 - add wildcards for minor and patch
      return `v${mostSpecific.major}.*.*`
    }
  }

  /**
   * Compares two version tags for sorting by specificity and version numbers
   * Prefers more specific versions (patch > minor > major), then higher version numbers
   *
   * @param a First version tag
   * @param b Second version tag
   * @returns Negative if a should come first, positive if b should come first, 0 if equal
   */
  private compareVersionTags(
    a: { major: number; minor?: number; patch?: number },
    b: { major: number; minor?: number; patch?: number }
  ): number {
    // Prefer tags with patch version
    if (a.patch !== undefined && b.patch === undefined) return -1
    if (a.patch === undefined && b.patch !== undefined) return 1

    // Prefer tags with minor version
    if (a.minor !== undefined && b.minor === undefined) return -1
    if (a.minor === undefined && b.minor !== undefined) return 1

    // Compare by version numbers (descending)
    if (a.major !== b.major) return b.major - a.major
    if (a.minor !== b.minor) {
      return (b.minor || 0) - (a.minor || 0)
    }
    if (a.patch !== b.patch) {
      return (b.patch || 0) - (a.patch || 0)
    }

    return 0
  }

  /**
   * Deduplicates dependencies by owner/repo/ref/sourcePath combination
   *
   * @param dependencies Array of dependencies
   * @returns Deduplicated array
   */
  private deduplicateDependencies(
    dependencies: ActionDependency[]
  ): ActionDependency[] {
    const seen = new Set<string>()
    return dependencies.filter((dep) => {
      const key = `${dep.owner}/${dep.repo}@${dep.ref}|${dep.sourcePath || ''}`
      if (seen.has(key)) {
        return false
      }
      seen.add(key)
      return true
    })
  }
}
