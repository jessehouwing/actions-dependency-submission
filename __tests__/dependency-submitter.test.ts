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
        'pkg:githubactions/actions/checkout@v4'
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
        'pkg:githubactions/myorg/checkout@v4'
      )
      expect(Object.keys(manifests)).toContain(
        'pkg:githubactions/actions/checkout@v4'
      )
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
  })
})
