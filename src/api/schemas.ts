import { z } from 'zod';

// Schemas check only the fields flowdiff relies on. They are "loose" so that any
// other fields n8n returns are kept rather than silently dropped.

const connectionSchema = z.looseObject({
  node: z.string(),
  type: z.string(),
  index: z.number(),
});

// connections[sourceNodeName][connectionType][outputIndex] -> targets
export const connectionsSchema = z.record(
  z.string(),
  z.record(z.string(), z.array(z.array(connectionSchema).nullable())),
);

const credentialRefSchema = z.looseObject({
  id: z.string().nullable().optional(),
  name: z.string(),
});

export const nodeSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  typeVersion: z.number(),
  position: z.array(z.number()),
  parameters: z.record(z.string(), z.unknown()),
  credentials: z.record(z.string(), credentialRefSchema).optional(),
});

const tagSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
});

export const workflowSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  active: z.boolean(),
  nodes: z.array(nodeSchema),
  connections: connectionsSchema,
  settings: z.record(z.string(), z.unknown()).optional(),
  tags: z.array(tagSchema).optional(),
  versionId: z.string().nullable().optional(),
  updatedAt: z.string(),
  isArchived: z.boolean().optional(),
});

export const workflowListSchema = z.looseObject({
  data: z.array(workflowSchema),
  nextCursor: z.string().nullable().optional(),
});

export type ApiWorkflow = z.infer<typeof workflowSchema>;
export type ApiNode = z.infer<typeof nodeSchema>;
