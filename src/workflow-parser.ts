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
   * @param additionalPaths Additional paths to scan for composite actions
   * @param repoRoot Root directory of the repository (required for additional paths and recursion)
   * @returns Array of action dependencies
   */
  async parseWorkflowDirectory(
    workflowDir: string,
    additionalPaths: string[] = [],
    repoRoot?: string
  ): Promise<ActionDependency[]> {
    const dependencies: ActionDependency[] = []
    const processedFiles = new Set<string>()
    const filesToProcess: string[] = []

    // Process main workflow directory
    if (fs.existsSync(workflowDir)) {
      const files = fs.readdirSync(workflowDir)
      const workflowFiles = files.filter(
        (file) => file.endsWith('.yml') || file.endsWith('.yaml')
      )

      for (const file of workflowFiles) {
        const filePath = path.join(workflowDir, file)
        filesToProcess.push(filePath)
      }
    }

    // Process all files in queue (including discovered local actions and callable workflows)
    while (filesToProcess.length > 0) {
      const filePath = filesToProcess.shift()
      if (!filePath || processedFiles.has(filePath)) {
        continue
      }

      processedFiles.add(filePath)
      const result = await this.parseWorkflowFile(filePath)
      dependencies.push(...result.dependencies)

      // Add local actions to processing queue if repoRoot is provided
      if (repoRoot) {
        for (const localAction of result.localActions) {
          const resolvedPath = this.resolveLocalPath(
            filePath,
            localAction,
            repoRoot
          )
          if (resolvedPath) {
            const actionYml = this.findActionYml(resolvedPath)
            if (
              actionYml &&
              !processedFiles.has(actionYml) &&
              this.isCompositeAction(actionYml)
            ) {
              filesToProcess.push(actionYml)
            }
          }
        }

        // Add callable workflows to processing queue
        for (const callableWorkflow of result.callableWorkflows) {
          const resolvedPath = this.resolveLocalPath(
            filePath,
            callableWorkflow,
            repoRoot
          )
          if (resolvedPath && !processedFiles.has(resolvedPath)) {
            filesToProcess.push(resolvedPath)
          }
        }
      }
    }

    // Scan additional paths for composite actions
    if (repoRoot && additionalPaths.length > 0) {
      for (const additionalPath of additionalPaths) {
        const fullPath = path.join(repoRoot, additionalPath)
        const files = this.findWorkflowFiles(fullPath)

        for (const file of files) {
          if (processedFiles.has(file) || !this.isCompositeAction(file)) {
            continue
          }

          processedFiles.add(file)
          const result = await this.parseWorkflowFile(file)
          dependencies.push(...result.dependencies)

          // Process nested local actions
          for (const localAction of result.localActions) {
            const resolvedPath = this.resolveLocalPath(
              file,
              localAction,
              repoRoot
            )
            if (resolvedPath) {
              const actionYml = this.findActionYml(resolvedPath)
              if (
                actionYml &&
                !processedFiles.has(actionYml) &&
                this.isCompositeAction(actionYml)
              ) {
                filesToProcess.push(actionYml)
              }
            }
          }
        }
      }

      // Continue processing any newly discovered files
      while (filesToProcess.length > 0) {
        const filePath = filesToProcess.shift()
        if (!filePath || processedFiles.has(filePath)) {
          continue
        }

        processedFiles.add(filePath)
        const result = await this.parseWorkflowFile(filePath)
        dependencies.push(...result.dependencies)
      }
    }

    return dependencies
  }

  /**
   * Parses a single workflow file to extract action dependencies
   *
   * @param filePath Path to workflow file
   * @returns Object with dependencies, local actions, and callable workflows
   */
  async parseWorkflowFile(filePath: string): Promise<{
    dependencies: ActionDependency[]
    localActions: string[]
    callableWorkflows: string[]
  }> {
    const dependencies: ActionDependency[] = []
    const localActions: string[] = []
    const callableWorkflows: string[] = []

    try {
      const content = fs.readFileSync(filePath, 'utf8')
      const workflow = yaml.parse(content)

      if (!workflow) {
        return { dependencies, localActions, callableWorkflows }
      }

      // Check if this is a composite action
      if (workflow.runs && workflow.runs.using === 'composite') {
        this.extractFromCompositeAction(workflow, dependencies, localActions)
      }
      // Check if this is a workflow (has jobs)
      else if (workflow.jobs) {
        this.extractFromWorkflow(
          workflow,
          dependencies,
          localActions,
          callableWorkflows
        )
      }
    } catch {
      // Skip files that can't be parsed
    }

    return { dependencies, localActions, callableWorkflows }
  }

  /**
   * Extract dependencies from a composite action
   */
  private extractFromCompositeAction(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    action: any,
    dependencies: ActionDependency[],
    localActions: string[]
  ): void {
    if (!action.runs || !action.runs.steps) {
      return
    }

    for (const step of action.runs.steps) {
      if (step.uses) {
        const result = this.parseUsesString(step.uses)
        if (result.isLocal && result.path) {
          localActions.push(result.path)
        } else if (result.dependency) {
          dependencies.push(result.dependency)
        }
      }
    }
  }

  /**
   * Extract dependencies from a workflow file
   */
  private extractFromWorkflow(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    workflow: any,
    dependencies: ActionDependency[],
    localActions: string[],
    callableWorkflows: string[]
  ): void {
    for (const jobName in workflow.jobs) {
      const job = workflow.jobs[jobName]

      // Check for callable workflows (uses at job level)
      if (job.uses) {
        const result = this.parseUsesString(job.uses)
        if (result.isLocal && result.path) {
          callableWorkflows.push(result.path)
        } else if (result.dependency) {
          dependencies.push(result.dependency)
        }
      }

      // Check steps for action dependencies
      if (typeof job === 'object' && job !== null && 'steps' in job) {
        const steps = (job as { steps?: unknown[] }).steps
        if (Array.isArray(steps)) {
          for (const step of steps) {
            if (typeof step === 'object' && step !== null && 'uses' in step) {
              const uses = (step as { uses: string }).uses
              const result = this.parseUsesString(uses)
              if (result.isLocal && result.path) {
                localActions.push(result.path)
              } else if (result.dependency) {
                dependencies.push(result.dependency)
              }
            }
          }
        }
      }
    }
  }

  /**
   * Parses a 'uses' string to extract dependency information
   *
   * @param uses The 'uses' string from a workflow step
   * @returns Object with dependency info or local path info
   */
  parseUsesString(uses: string): {
    dependency?: ActionDependency
    isLocal?: boolean
    path?: string
  } {
    // Skip docker actions
    if (uses.startsWith('docker://')) {
      return {}
    }

    // Local action reference (starts with ./ or ../ or .\ or ..\)
    if (
      uses.startsWith('./') ||
      uses.startsWith('../') ||
      uses.startsWith('.\\') ||
      uses.startsWith('..\\')
    ) {
      return {
        isLocal: true,
        path: uses
      }
    }

    // Match pattern: owner/repo@ref or owner/repo/path@ref
    const match = uses.match(/^([^/]+)\/([^/@]+)(?:\/[^@]+)?@(.+)$/)
    if (!match) {
      return {}
    }

    const [, owner, repo, ref] = match
    return {
      dependency: {
        owner,
        repo,
        ref,
        uses
      }
    }
  }

  /**
   * Check if a file is a composite action
   */
  private isCompositeAction(filePath: string): boolean {
    try {
      const content = fs.readFileSync(filePath, 'utf8')
      const parsed = yaml.parse(content)
      return parsed?.runs?.using === 'composite'
    } catch {
      return false
    }
  }

  /**
   * Resolve a local path reference relative to a workflow file
   */
  private resolveLocalPath(
    workflowFile: string,
    localPath: string,
    repoRoot: string
  ): string | null {
    try {
      const workflowDir = path.dirname(workflowFile)
      const resolved = path.resolve(workflowDir, localPath)

      // Ensure the path is within the repository
      if (!resolved.startsWith(repoRoot)) {
        return null
      }

      return resolved
    } catch {
      return null
    }
  }

  /**
   * Find action.yml or action.yaml in a directory
   */
  private findActionYml(dirPath: string): string | null {
    try {
      const stats = fs.statSync(dirPath)

      // If it's a file and ends with .yml or .yaml, return it
      if (
        stats.isFile() &&
        (dirPath.endsWith('.yml') || dirPath.endsWith('.yaml'))
      ) {
        return dirPath
      }

      // If it's a directory, look for action.yml or action.yaml
      if (stats.isDirectory()) {
        const actionYml = path.join(dirPath, 'action.yml')
        const actionYaml = path.join(dirPath, 'action.yaml')

        if (fs.existsSync(actionYml)) {
          return actionYml
        }
        if (fs.existsSync(actionYaml)) {
          return actionYaml
        }
      }
    } catch {
      // Path doesn't exist
    }

    return null
  }

  /**
   * Recursively scan a directory for workflow files
   */
  private findWorkflowFiles(dirPath: string): string[] {
    const files: string[] = []

    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true })

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name)

        if (entry.isDirectory()) {
          const subFiles = this.findWorkflowFiles(fullPath)
          files.push(...subFiles)
        } else if (
          entry.isFile() &&
          (entry.name.endsWith('.yml') || entry.name.endsWith('.yaml'))
        ) {
          files.push(fullPath)
        }
      }
    } catch {
      // Directory doesn't exist or can't be read
    }

    return files
  }
}
