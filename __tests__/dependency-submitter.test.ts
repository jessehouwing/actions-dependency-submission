/**
 * Unit tests for src/dependency-submitter.ts
 */
import { jest } from '@jest/globals'
import * as github from '../__fixtures__/github.js'

jest.unstable_mockModule('@actions/github', () => github)

const { DependencySubmitter } = await import('../src/dependency-submitter.js')

describe('DependencySubmitter', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('submitDependencies', () => {
    it('Submits dependencies without fork information', async () => {
      github.mockOctokit.rest.dependencyGraph.createRepositorySnapshot.mockResolvedValueOnce(
        {}
      )

      const submitter = new DependencySubmitter({
        token: 'test-token',
        repository: 'test-owner/test-repo',
        sha: 'abc123',
        ref: 'refs/heads/main'
      })

      const dependencies = [
        {
          owner: 'actions',
          repo: 'checkout',
          ref: 'v4'
        }
      ]

      const count = await submitter.submitDependencies(dependencies)

      expect(count).toBe(1)
      expect(
        github.mockOctokit.rest.dependencyGraph.createRepositorySnapshot
      ).toHaveBeenCalledTimes(1)

      const call =
        github.mockOctokit.rest.dependencyGraph.createRepositorySnapshot.mock
          .calls[0][0]
      expect(call.owner).toBe('test-owner')
      expect(call.repo).toBe('test-repo')
      expect(call.sha).toBe('abc123')
      expect(call.ref).toBe('refs/heads/main')

      const manifests = call.manifests['github-actions.yml'].resolved
      expect(Object.keys(manifests)).toContain(
        'pkg:githubactions/actions/checkout@v4.*.*'
      )
    })

    it('Submits both fork and original repository', async () => {
      github.mockOctokit.rest.dependencyGraph.createRepositorySnapshot.mockResolvedValueOnce(
        {}
      )

      const submitter = new DependencySubmitter({
        token: 'test-token',
        repository: 'test-owner/test-repo',
        sha: 'abc123',
        ref: 'refs/heads/main'
      })

      const dependencies = [
        {
          owner: 'myorg',
          repo: 'checkout',
          ref: 'v4',
          original: {
            owner: 'actions',
            repo: 'checkout'
          }
        }
      ]

      const count = await submitter.submitDependencies(dependencies)

      expect(count).toBe(2)
      expect(
        github.mockOctokit.rest.dependencyGraph.createRepositorySnapshot
      ).toHaveBeenCalledTimes(1)

      const call =
        github.mockOctokit.rest.dependencyGraph.createRepositorySnapshot.mock
          .calls[0][0]
      const manifests = call.manifests['github-actions.yml'].resolved

      expect(Object.keys(manifests)).toContain(
        'pkg:githubactions/myorg/checkout@v4.*.*'
      )
      expect(Object.keys(manifests)).toContain(
        'pkg:githubactions/actions/checkout@v4.*.*'
      )

      // Check relationships - fork should be direct, original should be indirect
      expect(
        manifests['pkg:githubactions/myorg/checkout@v4.*.*'].relationship
      ).toBe('direct')
      expect(
        manifests['pkg:githubactions/actions/checkout@v4.*.*'].relationship
      ).toBe('indirect')
    })

    it('Handles submission errors', async () => {
      github.mockOctokit.rest.dependencyGraph.createRepositorySnapshot.mockRejectedValueOnce(
        new Error('API Error')
      )

      const submitter = new DependencySubmitter({
        token: 'test-token',
        repository: 'test-owner/test-repo',
        sha: 'abc123',
        ref: 'refs/heads/main'
      })

      const dependencies = [
        {
          owner: 'actions',
          repo: 'checkout',
          ref: 'v4'
        }
      ]

      await expect(submitter.submitDependencies(dependencies)).rejects.toThrow(
        'API Error'
      )
    })

    it('Creates correct package URLs', async () => {
      github.mockOctokit.rest.dependencyGraph.createRepositorySnapshot.mockResolvedValueOnce(
        {}
      )

      const submitter = new DependencySubmitter({
        token: 'test-token',
        repository: 'test-owner/test-repo',
        sha: 'abc123',
        ref: 'refs/heads/main'
      })

      const dependencies = [
        {
          owner: 'actions',
          repo: 'checkout',
          ref: 'v4.1.0'
        }
      ]

      await submitter.submitDependencies(dependencies)

      const call =
        github.mockOctokit.rest.dependencyGraph.createRepositorySnapshot.mock
          .calls[0][0]
      const manifests = call.manifests['github-actions.yml'].resolved

      expect(Object.keys(manifests)).toContain(
        'pkg:githubactions/actions/checkout@v4.1.0'
      )
    })

    it('Groups dependencies by source path', async () => {
      github.mockOctokit.rest.dependencyGraph.createRepositorySnapshot.mockResolvedValueOnce(
        {}
      )

      const submitter = new DependencySubmitter({
        token: 'test-token',
        repository: 'test-owner/test-repo',
        sha: 'abc123',
        ref: 'refs/heads/main'
      })

      const dependencies = [
        {
          owner: 'actions',
          repo: 'checkout',
          ref: 'v4',
          sourcePath: '.github/workflows/ci.yml'
        },
        {
          owner: 'actions',
          repo: 'setup-node',
          ref: 'v4',
          sourcePath: '.github/workflows/ci.yml'
        },
        {
          owner: 'actions',
          repo: 'cache',
          ref: 'v3',
          sourcePath: '.github/actions/my-action/action.yml'
        }
      ]

      await submitter.submitDependencies(dependencies)

      const call =
        github.mockOctokit.rest.dependencyGraph.createRepositorySnapshot.mock
          .calls[0][0]
      const manifests = call.manifests

      // Should have two separate manifests, one for each source file
      expect(Object.keys(manifests)).toContain('.github/workflows/ci.yml')
      expect(Object.keys(manifests)).toContain(
        '.github/actions/my-action/action.yml'
      )

      // First manifest should have 2 dependencies
      expect(
        Object.keys(manifests['.github/workflows/ci.yml'].resolved)
      ).toHaveLength(2)

      // Second manifest should have 1 dependency
      expect(
        Object.keys(manifests['.github/actions/my-action/action.yml'].resolved)
      ).toHaveLength(1)

      // Check that file location is set
      expect(manifests['.github/workflows/ci.yml'].file?.source_location).toBe(
        '.github/workflows/ci.yml'
      )
      expect(
        manifests['.github/actions/my-action/action.yml'].file?.source_location
      ).toBe('.github/actions/my-action/action.yml')
    })

    it('Converts v1 to v1.*.*', async () => {
      github.mockOctokit.rest.dependencyGraph.createRepositorySnapshot.mockResolvedValueOnce(
        {}
      )

      const submitter = new DependencySubmitter({
        token: 'test-token',
        repository: 'test-owner/test-repo',
        sha: 'abc123',
        ref: 'refs/heads/main'
      })

      const dependencies = [
        {
          owner: 'actions',
          repo: 'checkout',
          ref: 'v1'
        }
      ]

      await submitter.submitDependencies(dependencies)

      const call =
        github.mockOctokit.rest.dependencyGraph.createRepositorySnapshot.mock
          .calls[0][0]
      const manifests = call.manifests['github-actions.yml'].resolved

      expect(Object.keys(manifests)).toContain(
        'pkg:githubactions/actions/checkout@v1.*.*'
      )
    })

    it('Converts v1.2 to v1.2.*', async () => {
      github.mockOctokit.rest.dependencyGraph.createRepositorySnapshot.mockResolvedValueOnce(
        {}
      )

      const submitter = new DependencySubmitter({
        token: 'test-token',
        repository: 'test-owner/test-repo',
        sha: 'abc123',
        ref: 'refs/heads/main'
      })

      const dependencies = [
        {
          owner: 'actions',
          repo: 'setup-node',
          ref: 'v1.2'
        }
      ]

      await submitter.submitDependencies(dependencies)

      const call =
        github.mockOctokit.rest.dependencyGraph.createRepositorySnapshot.mock
          .calls[0][0]
      const manifests = call.manifests['github-actions.yml'].resolved

      expect(Object.keys(manifests)).toContain(
        'pkg:githubactions/actions/setup-node@v1.2.*'
      )
    })

    it('Keeps v1.2.3 unchanged', async () => {
      github.mockOctokit.rest.dependencyGraph.createRepositorySnapshot.mockResolvedValueOnce(
        {}
      )

      const submitter = new DependencySubmitter({
        token: 'test-token',
        repository: 'test-owner/test-repo',
        sha: 'abc123',
        ref: 'refs/heads/main'
      })

      const dependencies = [
        {
          owner: 'actions',
          repo: 'cache',
          ref: 'v1.2.3'
        }
      ]

      await submitter.submitDependencies(dependencies)

      const call =
        github.mockOctokit.rest.dependencyGraph.createRepositorySnapshot.mock
          .calls[0][0]
      const manifests = call.manifests['github-actions.yml'].resolved

      expect(Object.keys(manifests)).toContain(
        'pkg:githubactions/actions/cache@v1.2.3'
      )
    })

    it('Keeps SHA references unchanged', async () => {
      github.mockOctokit.rest.dependencyGraph.createRepositorySnapshot.mockResolvedValueOnce(
        {}
      )

      const submitter = new DependencySubmitter({
        token: 'test-token',
        repository: 'test-owner/test-repo',
        sha: 'abc123',
        ref: 'refs/heads/main'
      })

      const dependencies = [
        {
          owner: 'actions',
          repo: 'checkout',
          ref: 'abc123def456abc123def456abc123def456abcd'
        }
      ]

      await submitter.submitDependencies(dependencies)

      const call =
        github.mockOctokit.rest.dependencyGraph.createRepositorySnapshot.mock
          .calls[0][0]
      const manifests = call.manifests['github-actions.yml'].resolved

      expect(Object.keys(manifests)).toContain(
        'pkg:githubactions/actions/checkout@abc123def456abc123def456abc123def456abcd'
      )
    })

    it('Keeps branch references unchanged', async () => {
      github.mockOctokit.rest.dependencyGraph.createRepositorySnapshot.mockResolvedValueOnce(
        {}
      )

      const submitter = new DependencySubmitter({
        token: 'test-token',
        repository: 'test-owner/test-repo',
        sha: 'abc123',
        ref: 'refs/heads/main'
      })

      const dependencies = [
        {
          owner: 'actions',
          repo: 'checkout',
          ref: 'main'
        }
      ]

      await submitter.submitDependencies(dependencies)

      const call =
        github.mockOctokit.rest.dependencyGraph.createRepositorySnapshot.mock
          .calls[0][0]
      const manifests = call.manifests['github-actions.yml'].resolved

      expect(Object.keys(manifests)).toContain(
        'pkg:githubactions/actions/checkout@main'
      )
    })

    it('Submits both SHA and version when SHA is resolved to version', async () => {
      github.mockOctokit.rest.dependencyGraph.createRepositorySnapshot.mockResolvedValueOnce(
        {}
      )

      const submitter = new DependencySubmitter({
        token: 'test-token',
        repository: 'test-owner/test-repo',
        sha: 'abc123',
        ref: 'refs/heads/main'
      })

      const dependencies = [
        {
          owner: 'jessehouwing',
          repo: 'actions-semver-checker',
          ref: 'v1.0.7',
          originalSha: '3cb8b94e8a9f14b89c86702e5c8c7c3d95559c5e'
        }
      ]

      const count = await submitter.submitDependencies(dependencies)

      expect(count).toBe(2)
      expect(
        github.mockOctokit.rest.dependencyGraph.createRepositorySnapshot
      ).toHaveBeenCalledTimes(1)

      const call =
        github.mockOctokit.rest.dependencyGraph.createRepositorySnapshot.mock
          .calls[0][0]
      const manifests = call.manifests['github-actions.yml'].resolved

      // Should have both SHA (direct) and version (indirect)
      expect(Object.keys(manifests)).toContain(
        'pkg:githubactions/jessehouwing/actions-semver-checker@3cb8b94e8a9f14b89c86702e5c8c7c3d95559c5e'
      )
      expect(Object.keys(manifests)).toContain(
        'pkg:githubactions/jessehouwing/actions-semver-checker@v1.0.7'
      )

      // Check relationships
      expect(
        manifests[
          'pkg:githubactions/jessehouwing/actions-semver-checker@3cb8b94e8a9f14b89c86702e5c8c7c3d95559c5e'
        ].relationship
      ).toBe('direct')
      expect(
        manifests[
          'pkg:githubactions/jessehouwing/actions-semver-checker@v1.0.7'
        ].relationship
      ).toBe('indirect')
    })

    it('Submits both SHA and version for fork and original when SHA is resolved', async () => {
      github.mockOctokit.rest.dependencyGraph.createRepositorySnapshot.mockResolvedValueOnce(
        {}
      )

      const submitter = new DependencySubmitter({
        token: 'test-token',
        repository: 'test-owner/test-repo',
        sha: 'abc123',
        ref: 'refs/heads/main'
      })

      const dependencies = [
        {
          owner: 'myorg',
          repo: 'checkout',
          ref: 'v4.1.0',
          originalSha: '8e8c483db84b4bee98b60c0593521ed34d9990e8',
          original: {
            owner: 'actions',
            repo: 'checkout'
          }
        }
      ]

      const count = await submitter.submitDependencies(dependencies)

      expect(count).toBe(4)
      expect(
        github.mockOctokit.rest.dependencyGraph.createRepositorySnapshot
      ).toHaveBeenCalledTimes(1)

      const call =
        github.mockOctokit.rest.dependencyGraph.createRepositorySnapshot.mock
          .calls[0][0]
      const manifests = call.manifests['github-actions.yml'].resolved

      // Should have both SHA and version for fork
      expect(Object.keys(manifests)).toContain(
        'pkg:githubactions/myorg/checkout@8e8c483db84b4bee98b60c0593521ed34d9990e8'
      )
      expect(Object.keys(manifests)).toContain(
        'pkg:githubactions/myorg/checkout@v4.1.0'
      )

      // Should have both SHA and version for original
      expect(Object.keys(manifests)).toContain(
        'pkg:githubactions/actions/checkout@8e8c483db84b4bee98b60c0593521ed34d9990e8'
      )
      expect(Object.keys(manifests)).toContain(
        'pkg:githubactions/actions/checkout@v4.1.0'
      )

      // Check relationships - Fork SHA is direct, fork version is indirect
      // Original repo dependencies (both SHA and version) are indirect because they're transitive
      expect(
        manifests[
          'pkg:githubactions/myorg/checkout@8e8c483db84b4bee98b60c0593521ed34d9990e8'
        ].relationship
      ).toBe('direct')
      expect(
        manifests['pkg:githubactions/myorg/checkout@v4.1.0'].relationship
      ).toBe('indirect')
      expect(
        manifests[
          'pkg:githubactions/actions/checkout@8e8c483db84b4bee98b60c0593521ed34d9990e8'
        ].relationship
      ).toBe('indirect')
      expect(
        manifests['pkg:githubactions/actions/checkout@v4.1.0'].relationship
      ).toBe('indirect')
    })
  })
})
