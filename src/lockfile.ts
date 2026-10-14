import * as fs from 'fs'
import * as path from 'path'
import { execFile } from 'child_process'
import * as yaml from 'yaml'
import * as core from '@actions/core'

export const LOCKFILE_RELATIVE_PATH = '.github/workflows/actions.lock'

interface LockEntry {
  ref?: string
  commit?: string
  uses?: string[]
}

/**
 * Parsed `actions.lock` file as written by `gh actions-lock`.
 *
 * Entries in `dependencies` are keyed by the canonical `owner/repo@ref`;
 * action and workflow subpaths are NOT part of the key (`github/codeql-action@v4`,
 * not `github/codeql-action/analyze@v4`). Lookups therefore try the exact
 * string first and then the canonical form. Entries carry the immutable commit
 * the ref was pinned to, even when the ref (e.g. `main`) has since moved.
 */
export class LockFile {
  private dependencies: Map<string, LockEntry>
  private workflows: Set<string>

  constructor(content: string) {
    const parsed = yaml.parse(content)
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      (parsed.dependencies !== undefined &&
        (parsed.dependencies === null ||
          typeof parsed.dependencies !== 'object' ||
          Array.isArray(parsed.dependencies)))
    ) {
      throw new Error('lock file must be a mapping with a dependencies mapping')
    }
    this.workflows = new Set(Object.keys(parsed.workflows ?? {}))
    this.dependencies = new Map(
      Object.entries((parsed?.dependencies ?? {}) as Record<string, LockEntry>)
    )
  }

  /**
   * Whether the lock file covers the given workflow path (relative to the repository root).
   */
  coversWorkflow(workflowPath: string): boolean {
    return this.workflows.has(workflowPath)
  }

  /**
   * Looks up an entry by exact key, falling back to the canonical
   * `owner/repo@ref` key (lock keys carry no action or workflow subpath).
   */
  private lookup(uses: string): LockEntry | undefined {
    const exact = this.dependencies.get(uses)
    if (exact) return exact
    const match = uses.match(/^([^/@]+)\/([^/@]+)(?:\/[^@]+)?@(.+)$/)
    return match
      ? this.dependencies.get(`${match[1]}/${match[2]}@${match[3]}`)
      : undefined
  }

  /**
   * Returns the pinned commit SHA for a `uses` string, if locked.
   */
  getCommit(uses: string): string | undefined {
    const commit = this.lookup(uses)?.commit
    const match =
      typeof commit === 'string' && commit.match(/^sha1-([0-9a-f]{40})$/)
    return match ? match[1] : undefined
  }

  /**
   * Returns the `uses` keys of the locked transitive dependencies of an entry.
   */
  getTransitiveUses(uses: string): string[] {
    const entries = this.lookup(uses)?.uses
    return Array.isArray(entries)
      ? entries.filter((e): e is string => typeof e === 'string')
      : []
  }
}

const EXTENSION_REPO = 'github/gh-actions-lock'

function runGh(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout: number },
  callback: (error: Error | null, stdout: string, stderr: string) => void
): void {
  execFile('gh', args, options, (error, stdout, stderr) =>
    callback(error, String(stdout), String(stderr))
  )
}

function runGhAsync(
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<{ error: Error | null; stdout: string; stderr: string }> {
  return new Promise((resolve) =>
    runGh(args, { env, timeout: 120_000 }, (error, stdout, stderr) =>
      resolve({ error, stdout, stderr })
    )
  )
}

/**
 * Ensures the gh CLI and the gh-actions-lock extension are available.
 * A missing extension is installed (latest release unless a version is
 * requested); a different installed version is replaced by the requested one.
 *
 * @param extensionVersion Optional release tag to pin the extension to
 * @returns true if `gh actions-lock` can be run
 */
async function ensureActionsLockExtension(
  token: string,
  extensionVersion?: string
): Promise<boolean> {
  const env = { ...process.env, GH_TOKEN: token || process.env.GH_TOKEN }
  // An explicitly requested version is a hard requirement
  const fail = (message: string): false => {
    if (extensionVersion) {
      throw new Error(message)
    }
    core.warning(message)
    return false
  }

  const version = await runGhAsync(['--version'], env)
  if (version.error) {
    return fail(
      'The GitHub CLI (gh) was not found on PATH; lock file cannot be verified. Install gh to enable lock file support.'
    )
  }

  // `gh extension list` has no --json output; lines are tab separated:
  // name, repository, version
  const list = await runGhAsync(['extension', 'list'], env)
  const installedLine = list.error
    ? undefined
    : list.stdout
        .split(/\r?\n/)
        .map((line) => line.split(/\t/).map((part) => part.trim()))
        .find((parts) => parts.includes(EXTENSION_REPO))
  const installedVersion = installedLine?.[2]

  if (
    installedLine &&
    (!extensionVersion || installedVersion === extensionVersion)
  ) {
    return true
  }

  if (installedLine) {
    core.info(
      `Replacing ${EXTENSION_REPO} ${installedVersion ?? 'unknown'} with ${extensionVersion}`
    )
    const remove = await runGhAsync(
      ['extension', 'remove', 'actions-lock'],
      env
    )
    if (remove.error) {
      return fail(
        `Failed to remove ${EXTENSION_REPO}, lock file cannot be verified: ${remove.stderr.trim() || remove.error.message}`
      )
    }
  }

  core.info(
    `Installing the ${EXTENSION_REPO} gh extension${extensionVersion ? ` ${extensionVersion}` : ' (latest)'}`
  )
  const install = await runGhAsync(
    [
      'extension',
      'install',
      EXTENSION_REPO,
      ...(extensionVersion ? ['--pin', extensionVersion] : [])
    ],
    env
  )
  if (install.error) {
    return fail(
      `Failed to install ${EXTENSION_REPO}, lock file cannot be verified: ${install.stderr.trim() || install.error.message}`
    )
  }
  return true
}
/**
 * Runs `gh actions-lock --verify` against the repository.
 *
 * @returns true only if the lock file is complete and every pin is accepted
 */
function verifyLockFile(repoRoot: string, token: string): Promise<boolean> {
  return new Promise((resolve) => {
    runGh(
      ['actions-lock', '--verify', '--no-interactive'],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          GH_TOKEN: token || process.env.GH_TOKEN,
          GH_ACTIONS_LOCK_REPO_ROOT: repoRoot
        },
        timeout: 120_000
      },
      (error, _stdout, stderr) => {
        if (error) {
          core.warning(
            `actions.lock verification failed: ${stderr?.trim() || error.message}`
          )
          resolve(false)
          return
        }
        resolve(true)
      }
    )
  })
}

/**
 * Loads the repository's lock file. A malformed lock file (or an unmet
 * `extensionVersion` requirement) throws. If the lock file cannot be verified
 * with `gh actions-lock --verify` a warning is logged and its contents are
 * used anyway.
 *
 * @returns The lock file, or undefined if the repository has none
 */
export async function loadVerifiedLockFile(
  repoRoot: string,
  token: string,
  extensionVersion?: string
): Promise<LockFile | undefined> {
  const lockPath = path.join(repoRoot, LOCKFILE_RELATIVE_PATH)
  const exists = fs.existsSync(lockPath)

  let lock: LockFile | undefined
  if (exists) {
    try {
      lock = new LockFile(fs.readFileSync(lockPath, 'utf8'))
    } catch (error) {
      throw new Error(
        `Malformed ${LOCKFILE_RELATIVE_PATH}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      )
    }
  } else if (!extensionVersion) {
    return undefined
  }

  const extensionReady = await ensureActionsLockExtension(
    token,
    extensionVersion || undefined
  )
  if (!lock) {
    return undefined
  }

  if (extensionReady && (await verifyLockFile(repoRoot, token))) {
    core.info(
      `Using verified ${LOCKFILE_RELATIVE_PATH} to resolve dependencies`
    )
  } else {
    core.warning(
      `${LOCKFILE_RELATIVE_PATH} could not be verified; using its contents unverified`
    )
  }
  return lock
}
