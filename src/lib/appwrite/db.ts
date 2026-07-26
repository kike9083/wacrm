export const DATABASE_ID = process.env.NEXT_PUBLIC_APPWRITE_DATABASE_ID!

export const COLLECTIONS = {
  profiles: 'profiles',
  contacts: 'contacts',
  tags: 'tags',
  contactTags: 'contact_tags',
  customFields: 'custom_fields',
  contactCustomValues: 'contact_custom_values',
  contactNotes: 'contact_notes',
  conversations: 'conversations',
  messages: 'messages',
  messageReactions: 'message_reactions',
  whatsappConfig: 'whatsapp_config',
  messageTemplates: 'message_templates',
  pipelines: 'pipelines',
  pipelineStages: 'pipeline_stages',
  deals: 'deals',
  broadcasts: 'broadcasts',
  broadcastRecipients: 'broadcast_recipients',
  automations: 'automations',
  automationSteps: 'automation_steps',
  automationLogs: 'automation_logs',
  automationPendingExecutions: 'automation_pending_executions',
  flows: 'flows',
  flowNodes: 'flow_nodes',
  flowRuns: 'flow_runs',
  flowRunEvents: 'flow_run_events',
} as const

export type CollectionName = keyof typeof COLLECTIONS
