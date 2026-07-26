import { createAdminClient } from '@/lib/appwrite/server'
import { DATABASE_ID, COLLECTIONS } from '@/lib/appwrite/db'
import { Query } from 'node-appwrite'

export interface BuilderStepInput {
  id?: string
  step_type: string
  step_config: Record<string, unknown>
  branches?: { yes?: BuilderStepInput[]; no?: BuilderStepInput[] }
  branch?: 'yes' | 'no' | null
  parent_index?: number | null
}

interface InsertRow {
  id: string
  automation_id: string
  parent_step_id: string | null
  branch: 'yes' | 'no' | null
  step_type: string
  step_config: Record<string, unknown>
  position: number
}

const uid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36)

export async function replaceSteps(
  automationId: string,
  input: BuilderStepInput[],
): Promise<string | null> {
  const { databases } = createAdminClient()
  try {
    const { documents } = await databases.listDocuments(
      DATABASE_ID,
      COLLECTIONS.automationSteps,
      [Query.equal('automation_id', automationId)]
    )
    for (const doc of documents) {
      await databases.deleteDocument(DATABASE_ID, COLLECTIONS.automationSteps, doc.$id)
    }
  } catch (err) {
    return err instanceof Error ? err.message : 'delete failed'
  }
  return insertSteps(automationId, input)
}

export async function insertSteps(
  automationId: string,
  input: BuilderStepInput[],
): Promise<string | null> {
  if (!input || input.length === 0) return null

  const looksFlat = input.some(
    (s) => s.branch !== undefined || s.parent_index !== undefined,
  )
  const tree = looksFlat ? seedsToTree(input) : input

  const rows: InsertRow[] = []
  function walk(
    steps: BuilderStepInput[],
    parentId: string | null,
    branch: 'yes' | 'no' | null,
  ) {
    steps.forEach((s, idx) => {
      const id = s.id ?? uid()
      rows.push({
        id,
        automation_id: automationId,
        parent_step_id: parentId,
        branch,
        step_type: s.step_type,
        step_config: s.step_config ?? {},
        position: idx,
      })
      if (s.step_type === 'condition' && s.branches) {
        if (s.branches.yes) walk(s.branches.yes, id, 'yes')
        if (s.branches.no) walk(s.branches.no, id, 'no')
      }
    })
  }
  walk(tree, null, null)

  if (rows.length === 0) return null
  const { databases } = createAdminClient()
  try {
    for (const row of rows) {
      await databases.createDocument(
        DATABASE_ID,
        COLLECTIONS.automationSteps,
        row.id,
        row
      )
    }
    return null
  } catch (err) {
    return err instanceof Error ? err.message : 'insert failed'
  }
}

function seedsToTree(seeds: BuilderStepInput[]): BuilderStepInput[] {
  const nodes: BuilderStepInput[] = seeds.map((s) => ({
    ...s,
    branches: { yes: [], no: [] },
  }))
  const roots: BuilderStepInput[] = []
  nodes.forEach((n, i) => {
    const seed = seeds[i]
    if (seed.parent_index == null) {
      roots.push(n)
    } else {
      const parent = nodes[seed.parent_index]
      parent.branches = parent.branches ?? { yes: [], no: [] }
      const bucket = (seed.branch ?? 'yes') as 'yes' | 'no'
      ;(parent.branches[bucket] ??= []).push(n)
    }
  })
  return roots
}

export interface BuilderStepNode extends BuilderStepInput {
  id: string
  branches: { yes: BuilderStepNode[]; no: BuilderStepNode[] }
}

interface DbStep {
  id: string
  parent_step_id: string | null
  branch: 'yes' | 'no' | null
  step_type: string
  step_config: Record<string, unknown>
  position: number
}

export async function loadStepsTree(automationId: string): Promise<BuilderStepNode[]> {
  const { databases } = createAdminClient()
  const { documents } = await databases.listDocuments(
    DATABASE_ID,
    COLLECTIONS.automationSteps,
    [Query.equal('automation_id', automationId), Query.orderAsc('position')]
  )
  const rows = documents as unknown as DbStep[]

  const byId = new Map<string, BuilderStepNode>()
  for (const row of rows) {
    byId.set(row.id, {
      id: row.id,
      step_type: row.step_type,
      step_config: row.step_config ?? {},
      branches: { yes: [], no: [] },
    })
  }

  const roots: BuilderStepNode[] = []
  for (const row of rows) {
    const node = byId.get(row.id)!
    if (row.parent_step_id) {
      const parent = byId.get(row.parent_step_id)
      if (parent) {
        const bucket = (row.branch ?? 'yes') as 'yes' | 'no'
        parent.branches[bucket].push(node)
      }
    } else {
      roots.push(node)
    }
  }
  return roots
}
