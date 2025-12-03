import * as fs from 'fs'
import * as path from 'path'
import * as yaml from 'yaml'
import * as core from '@actions/core'

export interface ActionReference {
  owner: string
  repo: string
  ref: string
  fullReference: string
  workflow: string
}

/**
 * Scans workflow files for GitHub Actions references
 */
export class WorkflowScanner {
  private workflowPath: string

  constructor(workflowPath: string) {
    this.workflowPath = workflowPath
  }

  /**
   * Scans all workflow files in the specified directory
   * @returns Array of action references found in workflow files
   */
  async scanWorkflows(): Promise<ActionReference[]> {
    const actions: ActionReference[] = []

    if (!fs.existsSync(this.workflowPath)) {
      core.warning(`Workflow path does not exist: ${this.workflowPath}`)
      return actions
    }

    const files = fs.readdirSync(this.workflowPath)
    const workflowFiles = files.filter(
      (file) =>
        (file.endsWith('.yml') || file.endsWith('.yaml')) &&
        fs.statSync(path.join(this.workflowPath, file)).isFile()
    )

    core.info(`Found ${workflowFiles.length} workflow files`)

    for (const file of workflowFiles) {
      const filePath = path.join(this.workflowPath, file)
      core.debug(`Scanning workflow file: ${filePath}`)

      try {
        const content = fs.readFileSync(filePath, 'utf8')
        const workflow = yaml.parse(content)

        const fileActions = this.extractActionsFromWorkflow(workflow, file)
        actions.push(...fileActions)
      } catch (error) {
        if (error instanceof Error) {
          core.warning(
            `Failed to parse workflow file ${file}: ${error.message}`
          )
        }
      }
    }

    return actions
  }

  /**
   * Extracts action references from a parsed workflow object
   */
  private extractActionsFromWorkflow(
    workflow: any,
    workflowFile: string
  ): ActionReference[] {
    const actions: ActionReference[] = []

    if (!workflow || !workflow.jobs) {
      return actions
    }

    for (const [, job] of Object.entries(workflow.jobs)) {
      if (typeof job === 'object' && job !== null && 'steps' in job) {
        const jobSteps = (job as any).steps
        if (Array.isArray(jobSteps)) {
          for (const step of jobSteps) {
            if (step && step.uses) {
              const actionRef = this.parseActionReference(
                step.uses,
                workflowFile
              )
              if (actionRef) {
                actions.push(actionRef)
              }
            }
          }
        }
      }
    }

    return actions
  }

  /**
   * Parses an action reference string (e.g., "actions/checkout@v3")
   */
  private parseActionReference(
    uses: string,
    workflowFile: string
  ): ActionReference | null {
    // Skip local actions (start with ./)
    if (uses.startsWith('./') || uses.startsWith('.\\')) {
      core.debug(`Skipping local action: ${uses}`)
      return null
    }

    // Skip Docker actions
    if (uses.startsWith('docker://')) {
      core.debug(`Skipping Docker action: ${uses}`)
      return null
    }

    // Parse owner/repo@ref format
    const match = uses.match(/^([^/]+)\/([^@]+)@(.+)$/)
    if (!match) {
      core.warning(`Invalid action reference format: ${uses}`)
      return null
    }

    const [, owner, repo, ref] = match

    return {
      owner,
      repo,
      ref,
      fullReference: uses,
      workflow: workflowFile
    }
  }
}
