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

const validLock = `version: v0.0.3\ndependencies:\n  'a/b@v1':\n    commit: 'sha1-${'a'.repeat(40)}'\n`

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

  it('Throws when verification rejects the lock', async () => {
    setup(Object.assign(new Error('exit 1'), { code: 1 }))
    await expect(loadVerifiedLockFile(dir, 't')).rejects.toThrow(
      'failed verification'
    )
  })

  it('Throws when verification times out', async () => {
    setup(Object.assign(new Error('timed out'), { killed: true }))
    await expect(loadVerifiedLockFile(dir, 't')).rejects.toThrow(
      'failed verification'
    )
  })

  it('Treats a lock file without a version as malformed', async () => {
    setup(null, 'dependencies: {}\n')
    await expect(loadVerifiedLockFile(dir, 't')).rejects.toThrow('Malformed')
    setup(null, '')
    await expect(loadVerifiedLockFile(dir, 't')).rejects.toThrow('Malformed')
  })
  it('Fails on malformed lock content even if verification succeeds', async () => {
    setup(null, 'dependencies: [unclosed')
    await expect(loadVerifiedLockFile(dir, 't')).rejects.toThrow('Malformed')
  })

  it('Fails on structurally invalid lock content', async () => {
    setup(null, '- just\n- a list\n')
    await expect(loadVerifiedLockFile(dir, 't')).rejects.toThrow('Malformed')
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

  it('Ignores the requested version when there is no lock file', async () => {
    execFile.mockImplementation((_cmd, _args, _opts, cb) =>
      cb(new Error('ENOENT'), '', '')
    )
    expect(await loadVerifiedLockFile(dir, 't', 'v0.2.0')).toBeUndefined()
    expect(execFile).not.toHaveBeenCalled()
  })

  it('Fails when removing a mismatching pinned version fails', async () => {
    setup(null)
    execFile.mockImplementation((_cmd, args, _opts, cb) => {
      if (args[0] === 'extension' && args[1] === 'list')
        cb(null, 'gh actions-lock\tgithub/gh-actions-lock\tv0.2.0', '')
      else if (args[0] === 'extension' && args[1] === 'remove')
        cb(new Error('boom'), '', 'boom')
      else cb(null, '', '')
    })
    await expect(loadVerifiedLockFile(dir, 't', 'v0.3.0')).rejects.toThrow(
      'Failed to remove'
    )
  })

  it('Warns and uses the lock unverified when installation fails without a version', async () => {
    setup(null, validLock, '')
    execFile.mockImplementation((_cmd, args, _opts, cb) =>
      args[0] === 'extension' && args[1] === 'install'
        ? cb(new Error('boom'), '', 'boom')
        : cb(null, '', '')
    )
    expect((await loadVerifiedLockFile(dir, 't'))?.getCommit('a/b@v1')).toBe(
      'a'.repeat(40)
    )
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('using its contents unverified')
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
