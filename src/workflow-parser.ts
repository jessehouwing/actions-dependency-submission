import * as fs from 'fs'
import * as path from 'path'
import * as yaml from 'yaml'
import * as core from '@actions/core'
import { OctokitProvider } from './octokit-provider.js'
import { DockerfileParser } from 'dockerfile-ast'

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
 * Represents a Docker image dependency
 */
export interface DockerDependency {
  registry: string // e.g., "hub.docker.com", "ghcr.io"
  namespace?: string // e.g., "library", "owner"
  image: string // e.g., "alpine", "node"
  tag?: string // e.g., "latest", "18"
  digest?: string // e.g., "sha256:abc123..."
  originalReference: string // Full original string
  sourcePath?: string // Where this was found
  context?: string // Optional: "container" | "step" | "action" | "service"
  isTransitive?: boolean // Whether this is from a remote repository
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
   * Generates a unique key for an action dependency for tracking processed actions
   *
   * @param dependency Action dependency to generate key for
   * @returns Unique key in format "owner/repo@ref"
   */
  private getActionKey(dependency: ActionDependency): string {
    return `${dependency.owner}/${dependency.repo}@${dependency.ref}`
  }

  /**
   * Scans a directory for workflow files and extracts all action dependencies
   *
   * @param workflowDir Directory containing workflow files
   * @param additionalPaths Additional paths to scan for composite actions
   * @param repoRoot Root directory of the repository (required for additional paths and recursion)
   * @returns Object with action dependencies and docker dependencies
   */
  async parseWorkflowDirectory(
    workflowDir: string,
    additionalPaths: string[] = [],
    repoRoot?: string
  ): Promise<{
    actionDependencies: ActionDependency[]
    dockerDependencies: DockerDependency[]
  }> {
    const dependencies: ActionDependency[] = []
    const dockerDependencies: DockerDependency[] = []
    const processedFiles = new Set<string>()
    const filesToProcess: string[] = []

    // Process root action.yml or action.yaml if it exists (for repositories authoring GitHub Actions)
    if (repoRoot) {
      const rootActionYml = this.findActionYml(repoRoot)
      if (rootActionYml) {
        // Process if it's a composite or docker action
        const content = fs.readFileSync(rootActionYml, 'utf8')
        const parsed = yaml.parse(content, { merge: true })
        if (
          parsed?.runs?.using === 'composite' ||
          parsed?.runs?.using === 'docker'
        ) {
          filesToProcess.push(rootActionYml)
        }
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
      dockerDependencies.push(...result.dockerDependencies)

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

        // Process remote composite actions and callable workflows
        for (const dep of result.dependencies) {
          const remoteActionKey = this.getActionKey(dep)
          if (!this.processedRemoteActions.has(remoteActionKey)) {
            this.processedRemoteActions.add(remoteActionKey)
            const remoteDeps = await this.processRemoteActionOrWorkflow(
              dep,
              relativePath
            )
            dependencies.push(...remoteDeps.actionDependencies)
            dockerDependencies.push(...remoteDeps.dockerDependencies)
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
          dockerDependencies.push(...result.dockerDependencies)

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
        dockerDependencies.push(...result.dockerDependencies)
      }
    }

    return { actionDependencies: dependencies, dockerDependencies }
  }

  /**
   * Parses a single workflow file to extract action dependencies
   *
   * @param filePath Path to workflow file
   * @param repoRoot Optional repository root for computing relative paths
   * @returns Object with dependencies, local actions, callable workflows, and docker dependencies
   */
  async parseWorkflowFile(
    filePath: string,
    repoRoot?: string
  ): Promise<{
    dependencies: ActionDependency[]
    localActions: string[]
    callableWorkflows: string[]
    dockerDependencies: DockerDependency[]
  }> {
    const dependencies: ActionDependency[] = []
    const localActions: string[] = []
    const callableWorkflows: string[] = []
    const dockerDependencies: DockerDependency[] = []

    try {
      const content = fs.readFileSync(filePath, 'utf8')
      const workflow = yaml.parse(content, { merge: true })

      if (!workflow) {
        return {
          dependencies,
          localActions,
          callableWorkflows,
          dockerDependencies
        }
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
      // Check if this is a Docker action
      else if (workflow.runs && workflow.runs.using === 'docker') {
        this.extractFromDockerAction(workflow, dockerDependencies, relativePath)
      }
      // Check if this is a workflow (has jobs)
      else if (workflow.jobs) {
        this.extractFromWorkflow(
          workflow,
          dependencies,
          localActions,
          callableWorkflows,
          dockerDependencies,
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
      if (dockerDependencies.length > 0) {
        const dockerList = dockerDependencies
          .map((d) => d.originalReference)
          .join(', ')
        core.debug(
          `Found ${dockerDependencies.length} Docker image(s) in ${relativePath}: ${dockerList}`
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
    } catch (error) {
      core.debug(`Error parsing ${filePath}: ${error}`)
    }

    return { dependencies, localActions, callableWorkflows, dockerDependencies }
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
   * Extract Docker image from a Docker-based action
   */
  private extractFromDockerAction(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    action: any,
    dockerDependencies: DockerDependency[],
    sourcePath: string
  ): void {
    if (!action.runs || !action.runs.image) {
      return
    }

    const imageRef = action.runs.image

    // Parse docker:// references directly
    if (typeof imageRef === 'string' && imageRef.startsWith('docker://')) {
      const dockerDep = this.parseDockerImage(imageRef)
      if (dockerDep) {
        dockerDep.sourcePath = sourcePath
        dockerDep.context = 'action'
        dockerDependencies.push(dockerDep)
      }
      return
    }

    // Parse Dockerfile if it's a path reference
    if (typeof imageRef === 'string' && !imageRef.startsWith('docker://')) {
      this.parseDockerfile(imageRef, sourcePath, dockerDependencies)
    }
  }

  /**
   * Parse a Dockerfile to extract base images from FROM instructions
   */
  private parseDockerfile(
    dockerfilePath: string,
    sourcePath: string,
    dockerDependencies: DockerDependency[]
  ): void {
    try {
      // Resolve the Dockerfile path relative to the action.yml location
      const actionDir = path.dirname(sourcePath)
      const fullDockerfilePath = path.resolve(actionDir, dockerfilePath)

      // Check if file exists
      if (!fs.existsSync(fullDockerfilePath)) {
        core.warning(
          `Dockerfile not found: ${dockerfilePath} (resolved to ${fullDockerfilePath})`
        )
        return
      }

      // Read and parse the Dockerfile
      const dockerfileContent = fs.readFileSync(fullDockerfilePath, 'utf8')
      const dockerfile = DockerfileParser.parse(dockerfileContent)

      // Extract FROM instructions
      const fromInstructions = dockerfile.getFROMs()

      for (const fromInstruction of fromInstructions) {
        // Use getImage() which correctly returns the image reference without stage name
        const imageRef = fromInstruction.getImage()

        if (!imageRef) {
          continue
        }

        // Skip scratch images (no parent)
        if (imageRef.toLowerCase() === 'scratch') {
          continue
        }

        // Check for build args/variables
        if (imageRef.includes('$') || imageRef.includes('${')) {
          core.warning(
            `Dockerfile contains variable reference in FROM: ${imageRef}. Skipping variable substitution.`
          )
          continue
        }

        // Parse the image reference
        const dockerDep = this.parseDockerImage(imageRef)
        if (dockerDep) {
          dockerDep.sourcePath = sourcePath
          dockerDep.context = 'dockerfile'
          dockerDependencies.push(dockerDep)
        }
      }
    } catch (error) {
      core.warning(
        `Failed to parse Dockerfile ${dockerfilePath}: ${error instanceof Error ? error.message : String(error)}`
      )
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
    dockerDependencies: DockerDependency[],
    sourcePath: string
  ): void {
    for (const jobName in workflow.jobs) {
      const job = workflow.jobs[jobName]

      // Extract from job.container.image
      if (job.container && job.container.image) {
        const imageRef = job.container.image
        if (typeof imageRef === 'string') {
          const dockerDep = this.parseDockerImage(imageRef)
          if (dockerDep) {
            dockerDep.sourcePath = sourcePath
            dockerDep.context = 'container'
            dockerDependencies.push(dockerDep)
          }
        }
      }

      // Extract from job.services.<service>.image
      if (job.services && typeof job.services === 'object') {
        for (const serviceName in job.services) {
          const service = job.services[serviceName]
          if (service && service.image && typeof service.image === 'string') {
            const dockerDep = this.parseDockerImage(service.image)
            if (dockerDep) {
              dockerDep.sourcePath = sourcePath
              dockerDep.context = 'service'
              dockerDependencies.push(dockerDep)
            }
          }
        }
      }

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

      // Check steps for action dependencies and docker references
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
              } else if (result.dockerDependency) {
                result.dockerDependency.sourcePath = sourcePath
                result.dockerDependency.context = 'step'
                dockerDependencies.push(result.dockerDependency)
              }
            }
          }
        }
      }
    }
  }

  /**
   * Parses a Docker image reference into components
   *
   * @param imageRef Docker image reference (e.g., "node:18", "ghcr.io/owner/image:tag", "docker://alpine:3.18")
   * @returns DockerDependency object or null if parsing fails
   */
  parseDockerImage(imageRef: string): DockerDependency | null {
    try {
      // Remove docker:// prefix if present
      let cleanRef = imageRef.replace(/^docker:\/\//, '')

      // Handle empty or invalid references
      if (!cleanRef || cleanRef.trim() === '') {
        return null
      }

      let registry = 'hub.docker.com'
      let namespace: string | undefined
      let image: string
      let tag: string | undefined
      let digest: string | undefined

      // Check if there's a digest (@sha256:...)
      const digestMatch = cleanRef.match(/@(sha256:[a-f0-9]+)/)
      if (digestMatch) {
        digest = digestMatch[1]
        // Remove digest from the reference for further parsing
        cleanRef = cleanRef.substring(0, digestMatch.index)
      }

      // Check if there's a tag (:tag)
      // Tag is everything after the last : that's not part of a port or registry
      const tagMatch = cleanRef.match(/:([^:/]+)$/)
      if (tagMatch && !digestMatch) {
        // Only extract tag if there's no digest
        tag = tagMatch[1]
        cleanRef = cleanRef.substring(0, tagMatch.index)
      } else if (tagMatch && digestMatch) {
        // If both tag and digest, still extract the tag
        tag = tagMatch[1]
        cleanRef = cleanRef.substring(0, tagMatch.index)
      }

      // Parse registry, namespace, and image name
      const parts = cleanRef.split('/')

      if (parts.length === 1) {
        // Just image name: "alpine" -> hub.docker.com/library/alpine
        image = parts[0]
        namespace = 'library'
      } else if (parts.length === 2) {
        // Could be "owner/image" or "registry.com/image"
        // Check if first part looks like a registry (contains . or :)
        if (parts[0].includes('.') || parts[0].includes(':')) {
          // It's a registry: "registry.com/image"
          registry = parts[0]
          image = parts[1]
          // No namespace for single-level registry paths
        } else {
          // It's namespace/image: "owner/image"
          namespace = parts[0]
          image = parts[1]
        }
      } else if (parts.length >= 3) {
        // registry/namespace/image or registry/namespace/image/more
        // First part is registry if it contains . or :
        if (parts[0].includes('.') || parts[0].includes(':')) {
          registry = parts[0]
          namespace = parts.slice(1, -1).join('/')
          image = parts[parts.length - 1]
        } else {
          // No registry specified, treat first part as namespace
          namespace = parts[0]
          image = parts.slice(1).join('/')
        }
      } else {
        return null
      }

      // Log the found dependency to console
      const depString = `Docker image: ${registry}/${namespace || ''}${namespace ? '/' : ''}${image}${tag ? ':' + tag : ''}${digest ? '@' + digest : ''}`
      core.info(`📦 Found ${depString}`)

      return {
        registry,
        namespace,
        image,
        tag: tag || (digest ? undefined : 'latest'),
        digest,
        originalReference: imageRef
      }
    } catch (error) {
      core.debug(
        `Failed to parse Docker image reference "${imageRef}": ${error}`
      )
      return null
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
    dockerDependency?: DockerDependency
  } {
    // Parse docker actions
    if (uses.startsWith('docker://')) {
      const dockerDep = this.parseDockerImage(uses)
      if (dockerDep) {
        return {
          dockerDependency: dockerDep
        }
      }
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
   * Process remote action or workflow to extract transitive dependencies.
   * Determines if the dependency is a callable workflow or composite action and routes accordingly.
   *
   * @param dependency Remote action/workflow dependency
   * @param callingWorkflowPath Path of the workflow that references this action/workflow
   * @returns Object with action dependencies and docker dependencies
   */
  private async processRemoteActionOrWorkflow(
    dependency: ActionDependency,
    callingWorkflowPath: string
  ): Promise<{
    actionDependencies: ActionDependency[]
    dockerDependencies: DockerDependency[]
  }> {
    // Check if it's a callable workflow first (uses pattern like owner/repo/path/to/workflow.yml@ref)
    // Callable workflows have a path component with a .yml or .yaml extension
    const callableWorkflowPattern = /^[^/]+\/[^/]+\/.+\.ya?ml@.+$/
    if (callableWorkflowPattern.test(dependency.uses)) {
      return await this.processRemoteCallableWorkflow(
        dependency,
        callingWorkflowPath
      )
    }

    // Otherwise, process as a composite action
    return await this.processRemoteCompositeAction(
      dependency,
      callingWorkflowPath
    )
  }

  /**
   * Process remote composite action to extract transitive dependencies
   *
   * @param dependency Remote action dependency
   * @param callingWorkflowPath Path of the workflow that references this action
   * @returns Object with action dependencies and docker dependencies
   */
  private async processRemoteCompositeAction(
    dependency: ActionDependency,
    callingWorkflowPath: string
  ): Promise<{
    actionDependencies: ActionDependency[]
    dockerDependencies: DockerDependency[]
  }> {
    if (!this.octokitProvider) {
      return { actionDependencies: [], dockerDependencies: [] }
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
        return { actionDependencies: [], dockerDependencies: [] }
      }

      // Parse the action file
      const actionYaml = yaml.parse(actionContent, { merge: true })

      if (!actionYaml) {
        return { actionDependencies: [], dockerDependencies: [] }
      }

      // Check if it's a composite action
      if (actionYaml.runs?.using === 'composite') {
        core.info(
          `Processing remote composite action: ${dependency.owner}/${dependency.repo}@${dependency.ref}`
        )

        const transitiveDeps: ActionDependency[] = []
        const transitiveDockerDeps: DockerDependency[] = []

        // Extract dependencies from composite action steps
        if (actionYaml.runs.steps && Array.isArray(actionYaml.runs.steps)) {
          for (const step of actionYaml.runs.steps) {
            if (step.uses) {
              const result = this.parseUsesString(step.uses)
              if (result.dependency) {
                // Mark as transitive and reference the calling workflow as manifest
                const transitiveDep = {
                  ...result.dependency,
                  sourcePath: callingWorkflowPath,
                  isTransitive: true
                }
                transitiveDeps.push(transitiveDep)

                // Recursively process this transitive dependency if it hasn't been processed yet
                const transitiveKey = this.getActionKey(transitiveDep)
                if (!this.processedRemoteActions.has(transitiveKey)) {
                  this.processedRemoteActions.add(transitiveKey)
                  const nestedDeps = await this.processRemoteActionOrWorkflow(
                    transitiveDep,
                    callingWorkflowPath
                  )
                  transitiveDeps.push(...nestedDeps.actionDependencies)
                  transitiveDockerDeps.push(...nestedDeps.dockerDependencies)
                }
              } else if (result.dockerDependency) {
                // Docker dependency from remote composite action - mark as transitive
                const dockerDep = {
                  ...result.dockerDependency,
                  sourcePath: callingWorkflowPath,
                  isTransitive: true
                }
                transitiveDockerDeps.push(dockerDep)
              }
            }
          }
        }

        return {
          actionDependencies: transitiveDeps,
          dockerDependencies: transitiveDockerDeps
        }
      }

      // Check if it's a Docker action
      if (actionYaml.runs?.using === 'docker' && actionYaml.runs?.image) {
        const imageRef = actionYaml.runs.image
        if (typeof imageRef === 'string' && imageRef.startsWith('docker://')) {
          const dockerDep = this.parseDockerImage(imageRef)
          if (dockerDep) {
            dockerDep.sourcePath = callingWorkflowPath
            dockerDep.context = 'action'
            dockerDep.isTransitive = true
            return {
              actionDependencies: [],
              dockerDependencies: [dockerDep]
            }
          }
        }
      }
    } catch (error) {
      core.debug(
        `Failed to process remote action ${dependency.owner}/${dependency.repo}@${dependency.ref}: ${error}`
      )
    }

    return { actionDependencies: [], dockerDependencies: [] }
  }

  /**
   * Process remote callable workflow to extract transitive dependencies
   *
   * @param dependency Remote workflow dependency
   * @param callingWorkflowPath Path of the workflow that references this callable workflow
   * @returns Object with action dependencies and docker dependencies
   */
  private async processRemoteCallableWorkflow(
    dependency: ActionDependency,
    callingWorkflowPath: string
  ): Promise<{
    actionDependencies: ActionDependency[]
    dockerDependencies: DockerDependency[]
  }> {
    if (!this.octokitProvider) {
      return { actionDependencies: [], dockerDependencies: [] }
    }

    try {
      // Extract workflow path from uses string (e.g., owner/repo/.github/workflows/file.yml@ref)
      // Pattern: owner/repo/path/to/workflow.yml@ref
      const workflowPathMatch = dependency.uses.match(
        /^[^/]+\/[^/]+\/(?<path>.+\.ya?ml)@.+$/
      )
      if (!workflowPathMatch || !workflowPathMatch.groups?.path) {
        return { actionDependencies: [], dockerDependencies: [] }
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
        core.debug(
          `No workflow content fetched for ${dependency.owner}/${dependency.repo}/${workflowPath}@${dependency.ref}`
        )
        return { actionDependencies: [], dockerDependencies: [] }
      }

      // Parse the workflow file
      const workflowYaml = yaml.parse(workflowContent, { merge: true })

      if (!workflowYaml) {
        return { actionDependencies: [], dockerDependencies: [] }
      }

      // Check if it's a callable workflow
      // Note: workflow_call can be null/undefined if specified without inputs/secrets.
      // We use the `in` operator instead of optional chaining here so we can detect
      // the presence of the `workflow_call` key even when its value is null/undefined.
      if (workflowYaml.on && 'workflow_call' in workflowYaml.on) {
        core.info(
          `Processing remote callable workflow: ${dependency.owner}/${dependency.repo}/${workflowPath}@${dependency.ref}`
        )

        const transitiveDeps: ActionDependency[] = []
        const transitiveDockerDeps: DockerDependency[] = []

        // Extract dependencies from workflow jobs
        if (workflowYaml.jobs) {
          for (const jobName in workflowYaml.jobs) {
            const job = workflowYaml.jobs[jobName]

            // Extract from job.container.image
            if (job.container && job.container.image) {
              const imageRef = job.container.image
              if (typeof imageRef === 'string') {
                const dockerDep = this.parseDockerImage(imageRef)
                if (dockerDep) {
                  dockerDep.sourcePath = callingWorkflowPath
                  dockerDep.context = 'container'
                  dockerDep.isTransitive = true
                  transitiveDockerDeps.push(dockerDep)
                }
              }
            }

            // Extract from job.services.<service>.image
            if (job.services && typeof job.services === 'object') {
              for (const serviceName in job.services) {
                const service = job.services[serviceName]
                if (
                  service &&
                  service.image &&
                  typeof service.image === 'string'
                ) {
                  const dockerDep = this.parseDockerImage(service.image)
                  if (dockerDep) {
                    dockerDep.sourcePath = callingWorkflowPath
                    dockerDep.context = 'service'
                    dockerDep.isTransitive = true
                    transitiveDockerDeps.push(dockerDep)
                  }
                }
              }
            }

            // Check for callable workflows at job level
            if (job.uses) {
              const result = this.parseUsesString(job.uses)
              if (result.dependency) {
                const transitiveDep = {
                  ...result.dependency,
                  sourcePath: callingWorkflowPath,
                  isTransitive: true
                }
                transitiveDeps.push(transitiveDep)

                // Recursively process this transitive dependency if it hasn't been processed yet
                const transitiveKey = this.getActionKey(transitiveDep)
                if (!this.processedRemoteActions.has(transitiveKey)) {
                  this.processedRemoteActions.add(transitiveKey)
                  const nestedDeps = await this.processRemoteActionOrWorkflow(
                    transitiveDep,
                    callingWorkflowPath
                  )
                  transitiveDeps.push(...nestedDeps.actionDependencies)
                  transitiveDockerDeps.push(...nestedDeps.dockerDependencies)
                }
              }
            }

            // Check steps for action dependencies and docker references
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
                      const transitiveDep = {
                        ...result.dependency,
                        sourcePath: callingWorkflowPath,
                        isTransitive: true
                      }
                      transitiveDeps.push(transitiveDep)

                      // Recursively process this transitive dependency if it hasn't been processed yet
                      const transitiveKey = this.getActionKey(transitiveDep)
                      if (!this.processedRemoteActions.has(transitiveKey)) {
                        this.processedRemoteActions.add(transitiveKey)
                        const nestedDeps =
                          await this.processRemoteActionOrWorkflow(
                            transitiveDep,
                            callingWorkflowPath
                          )
                        transitiveDeps.push(...nestedDeps.actionDependencies)
                        transitiveDockerDeps.push(
                          ...nestedDeps.dockerDependencies
                        )
                      }
                    } else if (result.dockerDependency) {
                      // Docker dependency from remote workflow step - mark as transitive
                      const dockerDep = {
                        ...result.dockerDependency,
                        sourcePath: callingWorkflowPath,
                        isTransitive: true
                      }
                      transitiveDockerDeps.push(dockerDep)
                    }
                  }
                }
              }
            }
          }
        }

        return {
          actionDependencies: transitiveDeps,
          dockerDependencies: transitiveDockerDeps
        }
      }
    } catch (error) {
      core.debug(
        `Failed to process remote callable workflow ${dependency.owner}/${dependency.repo}: ${error}`
      )
    }

    return { actionDependencies: [], dockerDependencies: [] }
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
