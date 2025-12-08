import * as core from '@actions/core'
import { getOctokit } from '@actions/github'

/**
 * Public GitHub API base URL
 */
const PUBLIC_GITHUB_API_URL = 'https://api.github.com'

/**
 * Configuration for OctokitProvider
 */
export interface OctokitProviderConfig {
  token: string
  publicGitHubToken?: string
}

/**
 * Provides Octokit instances with automatic fallback from local to public GitHub
 * Caches decisions to avoid redundant API calls
 */
export class OctokitProvider {
  private octokit: ReturnType<typeof getOctokit>
  private publicOctokit?: ReturnType<typeof getOctokit>
  private publicRepoCache: Map<string, boolean> = new Map()

  constructor(config: OctokitProviderConfig) {
    this.octokit = getOctokit(config.token)

    // Create a separate Octokit instance for public GitHub if token provided
    if (config.publicGitHubToken) {
      this.publicOctokit = getOctokit(config.publicGitHubToken, {
        baseUrl: PUBLIC_GITHUB_API_URL
      })
    }
  }

  /**
   * Get the primary Octokit instance
   */
  getOctokit(): ReturnType<typeof getOctokit> {
    return this.octokit
  }

  /**
   * Get the public GitHub Octokit instance if available
   */
  getPublicOctokit(): ReturnType<typeof getOctokit> | undefined {
    return this.publicOctokit
  }

  /**
   * Determines which Octokit instance to use for a repository
   * Caches the decision to avoid redundant checks
   *
   * @param owner Repository owner
   * @param repo Repository name
   * @returns The appropriate Octokit instance
   */
  async getOctokitForRepo(
    owner: string,
    repo: string
  ): Promise<ReturnType<typeof getOctokit>> {
    const repoKey = `${owner}/${repo}`

    // Check cache first
    if (this.publicRepoCache.has(repoKey)) {
      const usePublic = this.publicRepoCache.get(repoKey)
      return usePublic && this.publicOctokit ? this.publicOctokit : this.octokit
    }

    // Try local instance first
    try {
      await this.octokit.rest.repos.get({ owner, repo })
      // Repository exists locally
      this.publicRepoCache.set(repoKey, false)
      core.debug(`Repository ${repoKey} found on local instance`)
      return this.octokit
    } catch (error) {
      core.debug(`Repository ${repoKey} not found on local instance: ${error}`)
    }

    // Try public GitHub if available
    if (this.publicOctokit) {
      try {
        await this.publicOctokit.rest.repos.get({ owner, repo })
        // Repository exists on public GitHub
        this.publicRepoCache.set(repoKey, true)
        core.info(
          `Repository ${repoKey} found on public GitHub - will use public API for all operations`
        )
        return this.publicOctokit
      } catch (error) {
        core.debug(`Repository ${repoKey} not found on public GitHub: ${error}`)
      }
    }

    // Default to local instance
    this.publicRepoCache.set(repoKey, false)
    return this.octokit
  }

  /**
   * Gets repository information using the appropriate API
   *
   * @param owner Repository owner
   * @param repo Repository name
   * @returns Repository data or undefined if not found
   */
  async getRepoInfo(
    owner: string,
    repo: string
  ): Promise<
    | {
        fork?: boolean
        parent?: { owner: { login: string }; name: string }
        [key: string]: unknown
      }
    | undefined
  > {
    const octokit = await this.getOctokitForRepo(owner, repo)

    try {
      const { data } = await octokit.rest.repos.get({ owner, repo })
      return data
    } catch (error) {
      core.debug(
        `Failed to fetch repository info for ${owner}/${repo}: ${error}`
      )
      return undefined
    }
  }

  /**
   * Checks if a repository exists and determines which API to use
   * This is a lighter-weight version that doesn't return full repo info
   *
   * @param owner Repository owner
   * @param repo Repository name
   * @returns True if repository exists, false otherwise
   */
  async repoExists(owner: string, repo: string): Promise<boolean> {
    try {
      await this.getOctokitForRepo(owner, repo)
      return true
    } catch {
      return false
    }
  }
}
