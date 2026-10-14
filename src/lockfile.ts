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
   * Returns the pinned commit SHA for a `uses` string, if locked.
   */
  getCommit(uses: string): string | undefined {
    const commit = this.dependencies.get(uses)?.commit
    const match =
      typeof commit === 'string' && commit.match(/^sha1-([0-9a-f]{40})$/)
    return match ? match[1] : undefined
  }

  /**
   * Returns the `uses` keys of the locked transitive dependencies of an entry.
   */
  getTransitiveUses(uses: string): string[] {
    const entries = this.dependencies.get(uses)?.uses
    return Array.isArray(entries)
      ? entries.filter((e): e is string => typeof e === 'string')
      : []
  }
}

/**
 * Runs `gh actions-lock --verify` against the repository.
 *
 * @returns true only if the lock file is complete and every pin is accepted
 */
function verifyLockFile(repoRoot: string, token: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      'gh',
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
          core.info(
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
  token: string
): Promise<LockFile | undefined> {
  const lockPath = path.join(repoRoot, LOCKFILE_RELATIVE_PATH)
  if (!fs.existsSync(lockPath)) {
    return undefined
  }

  if (!(await verifyLockFile(repoRoot, token))) {
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
