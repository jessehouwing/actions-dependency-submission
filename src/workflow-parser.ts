import * as fs from 'fs'
import * as path from 'path'
import * as yaml from 'yaml'
import * as core from '@actions/core'
import { OctokitProvider } from './octokit-provider.js'

/**
 * Represents a GitHub Action dependency
 */
export interface ActionDependency {
  owner: string
  repo: string
  ref: string
  uses: string // Full 'uses' string from workflow
  sourcePath?: string // Path to the workflow/action file where this dependency was found
  isTransitive?: boolean // Whether this is a transitive/indirect dependency
  actionPath?: string // Path within the repository for actions in subfolders (e.g., 'subfolder' for owner/repo/subfolder@ref)
}

/**
 * Parses workflow files to extract action dependencies
 */
export class WorkflowParser {
  private octokitProvider?: OctokitProvider
  private processedRemoteActions: Set<string> = new Set()

  constructor(token?: string, publicGitHubToken?: string) {
    if (token) {
      this.octokitProvider = new OctokitProvider({
        token,
        publicGitHubToken
      })
    }
  }

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

    // Process root action.yml or action.yaml if it exists (for repositories authoring GitHub Actions)
    if (repoRoot) {
      const rootActionYml = this.findActionYml(repoRoot)
      if (rootActionYml && this.isCompositeAction(rootActionYml)) {
        filesToProcess.push(rootActionYml)
      }
    }

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
      const result = await this.parseWorkflowFile(filePath, repoRoot)
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

      // Process remote composite actions and callable workflows if octokit is available
      if (this.octokitProvider) {
        // Get relative path for source tracking
        const relativePath = repoRoot
          ? path.relative(repoRoot, filePath)
          : filePath

        // Process remote composite actions
        for (const dep of result.dependencies) {
          const remoteActionKey = `${dep.owner}/${dep.repo}@${dep.ref}`
          if (!this.processedRemoteActions.has(remoteActionKey)) {
            this.processedRemoteActions.add(remoteActionKey)
            const remoteDeps = await this.processRemoteCompositeAction(
              dep,
              relativePath
            )
            dependencies.push(...remoteDeps)
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
          const result = await this.parseWorkflowFile(file, repoRoot)
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
        const result = await this.parseWorkflowFile(filePath, repoRoot)
        dependencies.push(...result.dependencies)
      }
    }

    return dependencies
  }

  /**
   * Parses a single workflow file to extract action dependencies
   *
   * @param filePath Path to workflow file
   * @param repoRoot Optional repository root for computing relative paths
   * @returns Object with dependencies, local actions, and callable workflows
   */
  async parseWorkflowFile(
    filePath: string,
    repoRoot?: string
  ): Promise<{
    dependencies: ActionDependency[]
    localActions: string[]
    callableWorkflows: string[]
  }> {
    const dependencies: ActionDependency[] = []
    const localActions: string[] = []
    const callableWorkflows: string[] = []

    try {
      const content = fs.readFileSync(filePath, 'utf8')
      const workflow = yaml.parse(content, { merge: true })

      if (!workflow) {
        return { dependencies, localActions, callableWorkflows }
      }

      // Compute relative path from repo root if available
      const relativePath = repoRoot
        ? path.relative(repoRoot, filePath)
        : filePath

      core.debug(`Parsing file: ${relativePath}`)

      // Check if this is a composite action
      if (workflow.runs && workflow.runs.using === 'composite') {
        this.extractFromCompositeAction(
          workflow,
          dependencies,
          localActions,
          relativePath
        )
      }
      // Check if this is a workflow (has jobs)
      else if (workflow.jobs) {
        this.extractFromWorkflow(
          workflow,
          dependencies,
          localActions,
          callableWorkflows,
          relativePath
        )
      }

      // Log what was found in this file
      if (dependencies.length > 0) {
        const actionList = dependencies
          .map((d) => `${d.owner}/${d.repo}@${d.ref}`)
          .join(', ')
        core.debug(
          `Found ${dependencies.length} action(s) in ${relativePath}: ${actionList}`
        )
      }
      if (localActions.length > 0) {
        core.debug(
          `Found ${localActions.length} local action reference(s) in ${relativePath}: ${localActions.join(', ')}`
        )
      }
      if (callableWorkflows.length > 0) {
        core.debug(
          `Found ${callableWorkflows.length} callable workflow(s) in ${relativePath}: ${callableWorkflows.join(', ')}`
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
    localActions: string[],
    sourcePath: string
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
          dependencies.push({
            ...result.dependency,
            sourcePath
          })
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
    callableWorkflows: string[],
    sourcePath: string
  ): void {
    for (const jobName in workflow.jobs) {
      const job = workflow.jobs[jobName]

      // Check for callable workflows (uses at job level)
      if (job.uses) {
        const result = this.parseUsesString(job.uses)
        if (result.isLocal && result.path) {
          callableWorkflows.push(result.path)
        } else if (result.dependency) {
          dependencies.push({
            ...result.dependency,
            sourcePath
          })
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
                dependencies.push({
                  ...result.dependency,
                  sourcePath
                })
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
    const match = uses.match(/^([^/]+)\/([^/@]+)(?:\/([^@]+))?@(.+)$/)
    if (!match) {
      return {}
    }

    const [, owner, repo, actionPath, ref] = match
    return {
      dependency: {
        owner,
        repo,
        ref,
        uses,
        actionPath
      }
    }
  }

  /**
   * Check if a file is a composite action
   */
  private isCompositeAction(filePath: string): boolean {
    try {
      const content = fs.readFileSync(filePath, 'utf8')
      const parsed = yaml.parse(content, { merge: true })
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

  /**
   * Process remote composite action to extract transitive dependencies
   *
   * @param dependency Remote action dependency
   * @param callingWorkflowPath Path of the workflow that references this action
   * @returns Array of transitive dependencies from the remote action
   */
  private async processRemoteCompositeAction(
    dependency: ActionDependency,
    callingWorkflowPath: string
  ): Promise<ActionDependency[]> {
    if (!this.octokitProvider) {
      return []
    }

    try {
      // Try to fetch action.yml or action.yaml from the remote repository
      const actionContent = await this.fetchRemoteActionFile(
        dependency.owner,
        dependency.repo,
        dependency.ref,
        dependency.actionPath
      )

      if (!actionContent) {
        return []
      }

      // Parse the action file
      const actionYaml = yaml.parse(actionContent, { merge: true })

      if (!actionYaml) {
        return []
      }

      // Check if it's a composite action
      if (actionYaml.runs?.using === 'composite') {
        core.info(
          `Processing remote composite action: ${dependency.owner}/${dependency.repo}@${dependency.ref}`
        )

        const transitiveDeps: ActionDependency[] = []

        // Extract dependencies from composite action steps
        if (actionYaml.runs.steps && Array.isArray(actionYaml.runs.steps)) {
          for (const step of actionYaml.runs.steps) {
            if (step.uses) {
              const result = this.parseUsesString(step.uses)
              if (result.dependency) {
                // Mark as transitive and reference the calling workflow as manifest
                transitiveDeps.push({
                  ...result.dependency,
                  sourcePath: callingWorkflowPath,
                  isTransitive: true
                })
              }
            }
          }
        }

        return transitiveDeps
      }

      // Check if it's a callable workflow (uses pattern like owner/repo/path/to/workflow.yml@ref)
      // Callable workflows have a path component with a .yml or .yaml extension
      const callableWorkflowPattern = /^[^/]+\/[^/]+\/.+\.ya?ml@.+$/
      if (callableWorkflowPattern.test(dependency.uses)) {
        return await this.processRemoteCallableWorkflow(
          dependency,
          callingWorkflowPath
        )
      }
    } catch (error) {
      core.debug(
        `Failed to process remote action ${dependency.owner}/${dependency.repo}@${dependency.ref}: ${error}`
      )
    }

    return []
  }

  /**
   * Process remote callable workflow to extract transitive dependencies
   *
   * @param dependency Remote workflow dependency
   * @param callingWorkflowPath Path of the workflow that references this callable workflow
   * @returns Array of transitive dependencies from the remote workflow
   */
  private async processRemoteCallableWorkflow(
    dependency: ActionDependency,
    callingWorkflowPath: string
  ): Promise<ActionDependency[]> {
    if (!this.octokitProvider) {
      return []
    }

    try {
      // Extract workflow path from uses string (e.g., owner/repo/.github/workflows/file.yml@ref)
      // Pattern: owner/repo/path/to/workflow.yml@ref
      const workflowPathMatch = dependency.uses.match(
        /^[^/]+\/[^/]+\/(?<path>.+\.ya?ml)@.+$/
      )
      if (!workflowPathMatch || !workflowPathMatch.groups?.path) {
        return []
      }

      const workflowPath = workflowPathMatch.groups.path

      // Fetch the remote workflow file
      const workflowContent = await this.fetchRemoteFile(
        dependency.owner,
        dependency.repo,
        workflowPath,
        dependency.ref
      )

      if (!workflowContent) {
        return []
      }

      // Parse the workflow file
      const workflowYaml = yaml.parse(workflowContent, { merge: true })

      if (!workflowYaml) {
        return []
      }

      // Check if it's a callable workflow
      if (workflowYaml.on?.workflow_call) {
        core.info(
          `Processing remote callable workflow: ${dependency.owner}/${dependency.repo}/${workflowPath}@${dependency.ref}`
        )

        const transitiveDeps: ActionDependency[] = []

        // Extract dependencies from workflow jobs
        if (workflowYaml.jobs) {
          for (const jobName in workflowYaml.jobs) {
            const job = workflowYaml.jobs[jobName]

            // Check for callable workflows at job level
            if (job.uses) {
              const result = this.parseUsesString(job.uses)
              if (result.dependency) {
                transitiveDeps.push({
                  ...result.dependency,
                  sourcePath: callingWorkflowPath,
                  isTransitive: true
                })
              }
            }

            // Check steps for action dependencies
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
                    const result = this.parseUsesString(uses)
                    if (result.dependency) {
                      transitiveDeps.push({
                        ...result.dependency,
                        sourcePath: callingWorkflowPath,
                        isTransitive: true
                      })
                    }
                  }
                }
              }
            }
          }
        }

        return transitiveDeps
      }
    } catch (error) {
      core.debug(
        `Failed to process remote callable workflow ${dependency.owner}/${dependency.repo}: ${error}`
      )
    }

    return []
  }

  /**
   * Fetch action.yml or action.yaml from a remote repository
   *
   * @param owner Repository owner
   * @param repo Repository name
   * @param ref Git ref
   * @param actionPath Optional path within the repository (for actions in subfolders)
   * @returns Action file content or null if not found
   */
  private async fetchRemoteActionFile(
    owner: string,
    repo: string,
    ref: string,
    actionPath?: string
  ): Promise<string | null> {
    // Build the base path (subfolder or root)
    const basePath = actionPath ? `${actionPath}/` : ''

    // Try action.yml first
    let content = await this.fetchRemoteFile(
      owner,
      repo,
      `${basePath}action.yml`,
      ref
    )
    if (content) {
      return content
    }

    // Try action.yaml
    content = await this.fetchRemoteFile(
      owner,
      repo,
      `${basePath}action.yaml`,
      ref
    )
    return content
  }

  /**
   * Fetch a file from a remote repository
   *
   * @param owner Repository owner
   * @param repo Repository name
   * @param path File path
   * @param ref Git ref
   * @returns File content or null if not found
   */
  private async fetchRemoteFile(
    owner: string,
    repo: string,
    filePath: string,
    ref: string
  ): Promise<string | null> {
    if (!this.octokitProvider) {
      return null
    }

    try {
      const octokit = await this.octokitProvider.getOctokitForRepo(owner, repo)
      const { data } = await octokit.rest.repos.getContent({
        owner,
        repo,
        path: filePath,
        ref
      })

      // Check if it's a file (not a directory or submodule)
      if ('content' in data && typeof data.content === 'string') {
        // Content is base64 encoded
        return Buffer.from(data.content, 'base64').toString('utf-8')
      }
    } catch (error) {
      core.debug(
        `Failed to fetch ${filePath} from ${owner}/${repo}@${ref}: ${error}`
      )
    }

    return null
  }
}
