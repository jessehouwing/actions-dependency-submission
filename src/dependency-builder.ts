import * as core from '@actions/core'
import { Manifest, PackageCache } from '@github/dependency-submission-toolkit'
import { PackageURL } from 'packageurl-js'
import { ResolvedAction } from './action-resolver.js'

/**
 * Builds dependency manifests from resolved actions
 */
export class DependencyBuilder {
  /**
   * Creates a manifest from resolved actions
   */
  createManifest(actions: ResolvedAction[], workflowPath: string): Manifest {
    core.info(`Creating manifest with ${actions.length} dependencies`)

    const manifest = new Manifest('github-actions-dependencies', workflowPath)
    const packageCache = new PackageCache()

    // Add dependencies for each action
    for (const action of actions) {
      try {
        // Create package URL in PURL format for GitHub Actions
        // See: https://github.com/package-url/purl-spec
        const purl = new PackageURL(
          'githubactions',
          action.owner,
          action.repo,
          action.resolvedVersion,
          null,
          null
        )

        // Add package to cache
        const pkg = packageCache.package(purl)

        // Add as direct dependency since actions are directly referenced in workflows
        manifest.addDirectDependency(pkg)

        core.debug(
          `Added dependency: ${action.owner}/${action.repo}@${action.resolvedVersion}`
        )
      } catch (error) {
        if (error instanceof Error) {
          core.warning(
            `Failed to add dependency for ${action.fullReference}: ${error.message}`
          )
        }
      }
    }

    return manifest
  }
}
