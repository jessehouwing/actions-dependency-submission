import * as core from '@actions/core'
import * as github from '@actions/github'
import * as semver from 'semver'
import { ActionReference } from './workflow-scanner'

export interface ResolvedAction extends ActionReference {
  resolvedVersion: string
  packageUrl: string
}

/**
 * Resolves action references to their full versions
 */
export class ActionResolver {
  private octokit: ReturnType<typeof github.getOctokit>

  constructor(token: string) {
    this.octokit = github.getOctokit(token)
  }

  /**
   * Resolves an action reference to its full version
   */
  async resolveAction(action: ActionReference): Promise<ResolvedAction> {
    core.debug(`Resolving action: ${action.owner}/${action.repo}@${action.ref}`)

    let resolvedVersion = action.ref

    // Check if ref is already a full semantic version (e.g., v1.2.3)
    if (this.isFullSemanticVersion(action.ref)) {
      core.debug(`Action already has full semantic version: ${action.ref}`)
    }
    // Check if ref is a SHA (40 character hex string)
    else if (this.isSha(action.ref)) {
      core.debug(`Resolving SHA to version: ${action.ref}`)
      resolvedVersion = await this.resolveShaToVersion(
        action.owner,
        action.repo,
        action.ref
      )
    }
    // Check if ref is a partial version (e.g., v1, v2)
    else if (this.isPartialVersion(action.ref)) {
      core.debug(`Resolving partial version: ${action.ref}`)
      resolvedVersion = await this.resolvePartialVersion(
        action.owner,
        action.repo,
        action.ref
      )
    }

    const packageUrl = `pkg:githubactions/${action.owner}/${action.repo}@${resolvedVersion}`

    return {
      ...action,
      resolvedVersion,
      packageUrl
    }
  }

  /**
   * Checks if a reference is a full semantic version
   */
  private isFullSemanticVersion(ref: string): boolean {
    // Remove leading 'v' if present
    const version = ref.startsWith('v') ? ref.slice(1) : ref
    // Check if it's a valid semver with major.minor.patch
    const parsed = semver.parse(version)
    return parsed !== null && parsed.patch !== undefined
  }

  /**
   * Checks if a reference is a SHA
   */
  private isSha(ref: string): boolean {
    return /^[0-9a-f]{40}$/i.test(ref)
  }

  /**
   * Checks if a reference is a partial version
   */
  private isPartialVersion(ref: string): boolean {
    // Matches patterns like v1, v2, v1.2, etc.
    return /^v?\d+(\.\d+)?$/.test(ref)
  }

  /**
   * Resolves a SHA to a version tag
   */
  private async resolveShaToVersion(
    owner: string,
    repo: string,
    sha: string
  ): Promise<string> {
    try {
      // Get all tags for the repository with pagination
      const tags = await this.octokit.paginate(
        this.octokit.rest.repos.listTags,
        {
          owner,
          repo,
          per_page: 100
        }
      )

      // Find a tag that points to this commit
      for (const tag of tags) {
        if (tag.commit.sha === sha) {
          core.debug(`Found tag ${tag.name} for SHA ${sha}`)
          return tag.name
        }
      }

      // If no tag found, return the SHA as is
      core.warning(
        `No version tag found for SHA ${sha} in ${owner}/${repo}, using SHA`
      )
      return sha
    } catch (error) {
      if (error instanceof Error) {
        core.warning(`Failed to resolve SHA ${sha}: ${error.message}`)
      }
      return sha
    }
  }

  /**
   * Resolves a partial version to the latest full version
   */
  private async resolvePartialVersion(
    owner: string,
    repo: string,
    partialVersion: string
  ): Promise<string> {
    try {
      // Get all tags for the repository with pagination
      const tags = await this.octokit.paginate(
        this.octokit.rest.repos.listTags,
        {
          owner,
          repo,
          per_page: 100
        }
      )

      // Filter tags that match semantic versioning
      const versionTags = tags
        .map((tag) => tag.name)
        .filter((name) => {
          const version = name.startsWith('v') ? name.slice(1) : name
          return semver.valid(version) !== null
        })

      if (versionTags.length === 0) {
        core.warning(
          `No semantic version tags found for ${owner}/${repo}, using ${partialVersion}`
        )
        return partialVersion
      }

      // Remove 'v' prefix for comparison
      const cleanPartial = partialVersion.startsWith('v')
        ? partialVersion.slice(1)
        : partialVersion

      // Find the latest version that satisfies the partial version
      const matchingVersions = versionTags.filter((tag) => {
        const version = tag.startsWith('v') ? tag.slice(1) : tag
        return semver.satisfies(version, `^${cleanPartial}`)
      })

      if (matchingVersions.length === 0) {
        core.warning(
          `No matching versions found for ${partialVersion} in ${owner}/${repo}`
        )
        return partialVersion
      }

      // Sort and get the latest
      const sortedVersions = matchingVersions.sort((a, b) => {
        const versionA = a.startsWith('v') ? a.slice(1) : a
        const versionB = b.startsWith('v') ? b.slice(1) : b
        return semver.rcompare(versionA, versionB)
      })

      const latestVersion = sortedVersions[0]
      core.debug(`Resolved ${partialVersion} to ${latestVersion}`)
      return latestVersion
    } catch (error) {
      if (error instanceof Error) {
        core.warning(
          `Failed to resolve partial version ${partialVersion}: ${error.message}`
        )
      }
      return partialVersion
    }
  }
}
