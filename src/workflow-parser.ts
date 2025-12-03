import * as fs from 'fs'
import * as path from 'path'
import * as yaml from 'yaml'

/**
 * Represents a GitHub Action dependency
 */
export interface ActionDependency {
  owner: string
  repo: string
  ref: string
  uses: string // Full 'uses' string from workflow
}

/**
 * Parses workflow files to extract action dependencies
 */
export class WorkflowParser {
  /**
   * Scans a directory for workflow files and extracts all action dependencies
   *
   * @param workflowDir Directory containing workflow files
   * @returns Array of action dependencies
   */
  async parseWorkflowDirectory(
    workflowDir: string
  ): Promise<ActionDependency[]> {
    const dependencies: ActionDependency[] = []

    if (!fs.existsSync(workflowDir)) {
      return dependencies
    }

    const files = fs.readdirSync(workflowDir)
    const workflowFiles = files.filter(
      (file) => file.endsWith('.yml') || file.endsWith('.yaml')
    )

    for (const file of workflowFiles) {
      const filePath = path.join(workflowDir, file)
      const deps = await this.parseWorkflowFile(filePath)
      dependencies.push(...deps)
    }

    return dependencies
  }

  /**
   * Parses a single workflow file to extract action dependencies
   *
   * @param filePath Path to workflow file
   * @returns Array of action dependencies
   */
  async parseWorkflowFile(filePath: string): Promise<ActionDependency[]> {
    const dependencies: ActionDependency[] = []

    try {
      const content = fs.readFileSync(filePath, 'utf8')
      const workflow = yaml.parse(content)

      if (workflow?.jobs) {
        for (const job of Object.values(workflow.jobs)) {
          if (typeof job === 'object' && job !== null && 'steps' in job) {
            const steps = (job as { steps?: unknown[] }).steps
            if (Array.isArray(steps)) {
              for (const step of steps) {
                if (
                  typeof step === 'object' &&
                  step !== null &&
                  'uses' in step
                ) {
                  const uses = (step as { uses: string }).uses
                  const dep = this.parseUsesString(uses)
                  if (dep) {
                    dependencies.push(dep)
                  }
                }
              }
            }
          }
        }
      }
    } catch {
      // Skip files that can't be parsed
    }

    return dependencies
  }

  /**
   * Parses a 'uses' string to extract dependency information
   *
   * @param uses The 'uses' string from a workflow step
   * @returns Action dependency or null if not a valid GitHub Action reference
   */
  parseUsesString(uses: string): ActionDependency | null {
    // Match pattern: owner/repo@ref or owner/repo/path@ref
    const match = uses.match(/^([^/]+)\/([^/@]+)(?:\/[^@]+)?@(.+)$/)
    if (!match) {
      return null
    }

    const [, owner, repo, ref] = match
    return {
      owner,
      repo,
      ref,
      uses
    }
  }
}
