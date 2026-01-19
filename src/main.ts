import * as core from '@actions/core'
import * as github from '@actions/github'
import { WorkflowParser } from './workflow-parser.js'
import { ForkResolver } from './fork-resolver.js'
import { DependencySubmitter } from './dependency-submitter.js'

/**
 * The main function for the action.
 *
 * @returns Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  try {
    // Get inputs
    const token = core.getInput('token', { required: true })
    const repository = core.getInput('repository', { required: true })
    const workflowDirectory = core.getInput('workflow-directory', {
      required: true
    })
    const additionalPathsInput = core.getInput('additional-paths')
    const forkOrgsInput = core.getInput('fork-organizations')
    const forkRegexInput = core.getInput('fork-regex')
    const publicGitHubToken = core.getInput('public-github-token')
    const reportTransitiveAsDirect =
      core.getInput('report-transitive-as-direct') === 'true'
    const detectDocker = core.getInput('detect-docker') === 'true'

    // Parse additional paths (comma or newline separated)
    const additionalPaths = additionalPathsInput
      ? additionalPathsInput
          .split(/[,\n]/)
          .map((p) => p.trim())
          .filter((p) => p.length > 0)
      : []

    // Parse fork organizations
    const forkOrganizations = forkOrgsInput
      ? forkOrgsInput
          .split(',')
          .map((org) => org.trim())
          .filter((org) => org)
      : []

    // Parse fork regex if provided
    let forkRegex: RegExp | undefined
    if (forkRegexInput) {
      try {
        forkRegex = new RegExp(forkRegexInput)
        // Validate that the regex contains the required named groups
        const hasOrg = forkRegex.source.includes('(?<org>')
        const hasRepo = forkRegex.source.includes('(?<repo>')

        if (!hasOrg || !hasRepo) {
          throw new Error('Regex must contain named captures "org" and "repo"')
        }
      } catch (error) {
        throw new Error(
          `Invalid fork-regex: ${error instanceof Error ? error.message : 'Unknown error'}`
        )
      }
    }

    core.info(`Scanning workflow directory: ${workflowDirectory}`)
    if (additionalPaths.length > 0) {
      core.info(`Additional paths: ${additionalPaths.join(', ')}`)
    }
    core.info(
      `Fork organizations: ${forkOrganizations.length > 0 ? forkOrganizations.join(', ') : 'none'}`
    )
    if (forkRegex) {
      core.info(`Fork regex pattern: ${forkRegexInput}`)
    }
    if (publicGitHubToken) {
      core.info('Public GitHub token provided for EMU/DR/GHES support')
    }

    // Get repository root for resolving local paths
    const repoRoot = process.env.GITHUB_WORKSPACE || process.cwd()

    // Parse workflow files (with composite actions and callable workflows support)
    const parser = new WorkflowParser(token, publicGitHubToken || undefined)
    const result = await parser.parseWorkflowDirectory(
      workflowDirectory,
      additionalPaths,
      repoRoot
    )
    const { actionDependencies, dockerDependencies } = result

    core.info(`Found ${actionDependencies.length} action dependencies`)

    // Log Docker dependencies
    if (dockerDependencies.length > 0) {
      const directDockerCount = dockerDependencies.filter(
        (d) => !d.isTransitive
      ).length
      const transitiveDockerCount = dockerDependencies.filter(
        (d) => d.isTransitive
      ).length
      const message = `Found ${dockerDependencies.length} Docker image dependencies${directDockerCount > 0 && transitiveDockerCount > 0 ? ` (${directDockerCount} direct, ${transitiveDockerCount} transitive)` : ''}`
      if (detectDocker) {
        core.info(message)
      } else {
        core.info(`${message} (skipped - enable with detect-docker: true)`)
      }
    }

    if (actionDependencies.length === 0) {
      core.warning('No action dependencies found in workflow files')
      core.setOutput('dependency-count', 0)
      return
    }

    // Resolve forks
    const resolver = new ForkResolver({
      forkOrganizations,
      forkRegex,
      token,
      publicGitHubToken: publicGitHubToken || undefined
    })
    const resolvedDependencies =
      await resolver.resolveDependencies(actionDependencies)

    // Determine the correct SHA and ref to use
    // For pull_request events, github.context.sha is the merge commit SHA (refs/pull/<pr>/merge),
    // but dependency-review-action expects the snapshot to be for the PR head SHA.
    // See: https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows#pull_request
    const isPullRequest =
      github.context.eventName === 'pull_request' ||
      github.context.eventName === 'pull_request_target'

    const pullRequest = github.context.payload.pull_request as
      | { head?: { sha?: string; ref?: string } }
      | undefined

    const sha =
      isPullRequest && pullRequest?.head?.sha
        ? pullRequest.head.sha
        : github.context.sha

    const ref =
      isPullRequest && pullRequest?.head?.ref
        ? `refs/heads/${pullRequest.head.ref}`
        : github.context.ref

    if (isPullRequest) {
      core.info(`Pull request detected, using head SHA: ${sha}`)
      core.info(`Pull request detected, using head ref: ${ref}`)
    }

    // Submit dependencies
    const submitter = new DependencySubmitter({
      token,
      repository,
      sha,
      ref,
      reportTransitiveAsDirect
    })
    const submittedCount = await submitter.submitDependencies(
      resolvedDependencies,
      detectDocker ? dockerDependencies : []
    )

    core.info(`Successfully submitted ${submittedCount} dependencies`)
    core.setOutput('dependency-count', submittedCount)
  } catch (error) {
    // Fail the workflow run if an error occurs
    if (error instanceof Error) core.setFailed(error.message)
  }
}
