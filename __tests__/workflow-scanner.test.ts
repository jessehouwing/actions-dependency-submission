/**
 * Unit tests for the workflow scanner
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { WorkflowScanner } from '../src/workflow-scanner.js'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

describe('WorkflowScanner', () => {
  const fixturesDir = path.join(__dirname, '../__fixtures__/workflows')

  // Create test fixture directory and files
  beforeAll(() => {
    if (!fs.existsSync(fixturesDir)) {
      fs.mkdirSync(fixturesDir, { recursive: true })
    }

    // Create a simple workflow file
    const workflowContent = `
name: Test Workflow
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v3
      - uses: user/custom-action@abc1234567890123456789012345678901234567
`
    fs.writeFileSync(path.join(fixturesDir, 'test.yml'), workflowContent)
  })

  afterAll(() => {
    // Clean up
    if (fs.existsSync(fixturesDir)) {
      fs.rmSync(fixturesDir, { recursive: true, force: true })
    }
  })

  it('should scan workflow files and extract actions', async () => {
    const scanner = new WorkflowScanner(fixturesDir)
    const actions = await scanner.scanWorkflows()

    expect(actions).toHaveLength(3)
    expect(actions[0]).toMatchObject({
      owner: 'actions',
      repo: 'checkout',
      ref: 'v4'
    })
    expect(actions[1]).toMatchObject({
      owner: 'actions',
      repo: 'setup-node',
      ref: 'v3'
    })
    expect(actions[2]).toMatchObject({
      owner: 'user',
      repo: 'custom-action'
    })
  })

  it('should handle non-existent workflow directory', async () => {
    const scanner = new WorkflowScanner('/non/existent/path')
    const actions = await scanner.scanWorkflows()

    expect(actions).toHaveLength(0)
  })

  it('should skip local actions', async () => {
    const localWorkflowContent = `
name: Local Action Test
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: ./local-action
      - uses: actions/checkout@v4
`
    const localFixturesDir = path.join(
      __dirname,
      '../__fixtures__/local-workflows'
    )
    fs.mkdirSync(localFixturesDir, { recursive: true })
    fs.writeFileSync(
      path.join(localFixturesDir, 'local.yml'),
      localWorkflowContent
    )

    const scanner = new WorkflowScanner(localFixturesDir)
    const actions = await scanner.scanWorkflows()

    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({
      owner: 'actions',
      repo: 'checkout',
      ref: 'v4'
    })

    // Clean up
    fs.rmSync(localFixturesDir, { recursive: true, force: true })
  })
})
