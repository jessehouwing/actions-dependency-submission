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
 * Entries in `dependencies` are keyed by the exact `uses` string (without
 * the `docker://` or local forms) and carry the immutable commit the ref was
 * pinned to, even when the ref (e.g. `main`) has since moved.
 */
export class LockFile {
  private dependencies: Map<string, LockEntry>

  constructor(content: string) {
    const parsed = yaml.parse(content)
    this.dependencies = new Map(
      Object.entries((parsed?.dependencies ?? {}) as Record<string, LockEntry>)
    )
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

  const version = await runGhAsync(['--version'], env)
  if (version.error) {
    core.warning(
      'The GitHub CLI (gh) was not found on PATH; ignoring actions.lock. Install gh to enable lock file support.'
    )
    return false
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
      core.warning(
        `Failed to remove ${EXTENSION_REPO}, ignoring actions.lock: ${remove.stderr.trim() || remove.error.message}`
      )
      return false
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
    core.warning(
      `Failed to install ${EXTENSION_REPO}, ignoring actions.lock: ${install.stderr.trim() || install.error.message}`
    )
    return false
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
            `actions.lock verification failed, ignoring lock file: ${stderr?.trim() || error.message}`
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
 * Loads the repository's lock file, trusting it only when `gh actions-lock
 * --verify` succeeds.
 *
 * @returns The lock file, or undefined if missing, unverifiable or invalid
 */
export async function loadVerifiedLockFile(
  repoRoot: string,
  token: string,
  extensionVersion?: string
): Promise<LockFile | undefined> {
  const lockPath = path.join(repoRoot, LOCKFILE_RELATIVE_PATH)
  if (!fs.existsSync(lockPath)) {
    return undefined
  }

  if (
    !(await ensureActionsLockExtension(token, extensionVersion || undefined)) ||
    !(await verifyLockFile(repoRoot, token))
  ) {
    return undefined
  }

  try {
    const lock = new LockFile(fs.readFileSync(lockPath, 'utf8'))
    core.info(
      `Using verified ${LOCKFILE_RELATIVE_PATH} to resolve dependencies`
    )
    return lock
  } catch (error) {
    core.warning(
      `Failed to parse ${LOCKFILE_RELATIVE_PATH}: ${error instanceof Error ? error.message : String(error)}`
    )
    return undefined
  }
}
