import * as core from '@actions/core'
import * as github from '@actions/github'
import { Snapshot, submitSnapshot } from '@github/dependency-submission-toolkit'
import { WorkflowScanner } from './workflow-scanner.js'
import { ActionResolver } from './action-resolver.js'
import { DependencyBuilder } from './dependency-builder.js'

/**
 * The main function for the action.
 *
 * @returns Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  try {
    core.startGroup('📘 Reading input values')
    const token = core.getInput('token', { required: true })
    const workflowPath = core.getInput('workflow-path') || '.github/workflows'
    core.info(`Workflow path: ${workflowPath}`)
    core.endGroup()

    // Scan workflow files for action references
    core.startGroup('🔍 Scanning workflow files')
    const scanner = new WorkflowScanner(workflowPath)
    const actions = await scanner.scanWorkflows()
    core.info(`Found ${actions.length} GitHub Actions references`)

    // Remove duplicates
    const uniqueActions = Array.from(
      new Map(actions.map((a) => [a.fullReference, a])).values()
    )
    core.info(`Found ${uniqueActions.length} unique GitHub Actions references`)
    core.endGroup()

    if (uniqueActions.length === 0) {
      core.warning('No GitHub Actions found in workflow files')
      return
    }

    // Resolve action versions
    core.startGroup('🔧 Resolving action versions')
    const resolver = new ActionResolver(token)
    const resolvedActions = await Promise.all(
      uniqueActions.map((action) => resolver.resolveAction(action))
    )
    core.info(`Resolved ${resolvedActions.length} actions`)
    core.endGroup()

    // Build dependency manifest
    core.startGroup('📦 Building dependency manifest')
    const builder = new DependencyBuilder()
    const manifest = builder.createManifest(resolvedActions, workflowPath)
    core.endGroup()

    // Submit to Dependency Submission API
    core.startGroup('📤 Submitting to Dependency Submission API')
    const snapshot = new Snapshot(
      {
        name: 'actions-dependency-submission',
        url: 'https://github.com/jessehouwing/actions-dependency-submission',
        version: '1.0.0'
      },
      github.context,
      {
        correlator: `${github.context.job}-github-actions`,
        id: github.context.runId.toString()
      }
    )

    snapshot.addManifest(manifest)

    await submitSnapshot(snapshot)
    core.info('✅ Successfully submitted dependency snapshot')
    core.setOutput('snapshot-id', github.context.runId.toString())
    core.endGroup()
  } catch (error) {
    // Fail the workflow run if an error occurs
    if (error instanceof Error) {
      core.setFailed(error.message)
    }
  }
}
