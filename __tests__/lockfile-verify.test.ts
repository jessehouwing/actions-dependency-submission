import {
  jest,
  describe,
  it,
  expect,
  beforeEach,
  afterEach
} from '@jest/globals'
import * as core from '../__fixtures__/core.js'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

type Cb = (error: Error | null, stdout: string, stderr: string) => void
const execFile =
  jest.fn<(cmd: string, args: string[], opts: unknown, cb: Cb) => void>()

jest.unstable_mockModule('@actions/core', () => core)
jest.unstable_mockModule('child_process', () => ({ execFile }))

const { loadVerifiedLockFile } = await import('../src/lockfile.js')

const validLock = `dependencies:\n  'a/b@v1':\n    commit: 'sha1-${'a'.repeat(40)}'\n`

describe('loadVerifiedLockFile verification', () => {
  let dir: string

  function setup(
    verify: Error | null,
    lock: string = validLock,
    extensions = 'gh actions-lock\tgithub/gh-actions-lock\tv0.2.0'
  ) {
    fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, '.github', 'workflows', 'actions.lock'),
      lock
    )
    execFile.mockImplementation((_cmd, args, _opts, cb) => {
      if (args[0] === '--version') cb(null, 'gh version', '')
      else if (args[0] === 'extension' && args[1] === 'list')
        cb(null, extensions, '')
      else if (args[0] === 'extension') cb(null, '', '')
      else if (verify) cb(verify, '', 'verify failed')
      else cb(null, '', '')
    })
  }

  beforeEach(() => {
    jest.clearAllMocks()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-'))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('Returns the lock only after successful verification', async () => {
    setup(null)
    const lock = await loadVerifiedLockFile(dir, 't')
    expect(lock?.getCommit('a/b@v1')).toBe('a'.repeat(40))
    expect(execFile).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining(['actions-lock', '--verify']),
      expect.anything(),
      expect.anything()
    )
  })

  it('Ignores the lock when verification exits non-zero', async () => {
    setup(new Error('exit 1'))
    expect(await loadVerifiedLockFile(dir, 't')).toBeUndefined()
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('verification failed')
    )
  })

  it('Ignores the lock when verification times out', async () => {
    setup(Object.assign(new Error('timed out'), { killed: true }))
    expect(await loadVerifiedLockFile(dir, 't')).toBeUndefined()
  })

  it('Ignores malformed lock content even if verification succeeds', async () => {
    setup(null, 'dependencies: [unclosed')
    expect(await loadVerifiedLockFile(dir, 't')).toBeUndefined()
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Failed to parse')
    )
  })

  it('Installs the extension when missing', async () => {
    setup(null, validLock, '')
    expect(await loadVerifiedLockFile(dir, 't')).toBeDefined()
    expect(execFile).toHaveBeenCalledWith(
      'gh',
      ['extension', 'install', 'github/gh-actions-lock'],
      expect.anything(),
      expect.anything()
    )
  })

  it('Replaces a mismatching extension version with the pinned one', async () => {
    setup(null)
    await loadVerifiedLockFile(dir, 't', 'v0.3.0')
    const calls = execFile.mock.calls.map((c) => c[1].join(' '))
    expect(calls).toContain('extension remove actions-lock')
    expect(calls).toContain(
      'extension install github/gh-actions-lock --pin v0.3.0'
    )
  })

  it('Keeps the installed extension when it matches the pinned version', async () => {
    setup(null)
    await loadVerifiedLockFile(dir, 't', 'v0.2.0')
    const calls = execFile.mock.calls.map((c) => c[1].join(' '))
    expect(calls.some((c) => c.startsWith('extension remove'))).toBe(false)
    expect(calls.some((c) => c.startsWith('extension install'))).toBe(false)
  })

  it('Fails when gh is missing and a version is requested', async () => {
    setup(null)
    execFile.mockImplementation((_cmd, _args, _opts, cb) =>
      cb(new Error('ENOENT'), '', '')
    )
    await expect(loadVerifiedLockFile(dir, 't', 'v0.2.0')).rejects.toThrow(
      'GitHub CLI (gh) was not found'
    )
  })

  it('Fails when pinned installation fails', async () => {
    setup(null, validLock, '')
    execFile.mockImplementation((_cmd, args, _opts, cb) =>
      args[0] === 'extension' && args[1] === 'install'
        ? cb(new Error('boom'), '', 'boom')
        : cb(null, '', '')
    )
    await expect(loadVerifiedLockFile(dir, 't', 'v0.2.0')).rejects.toThrow(
      'Failed to install'
    )
  })
})
