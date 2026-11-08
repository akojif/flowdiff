/** One step in the path to a changed value. */
export type PathSegment =
  /** Object key. */
  | { key: string }
  /** Array position, for arrays matched by position. */
  | { index: number }
  /**
   * Array element matched by its `id` field. `label` is the element's name when
   * that name is unique, otherwise `#<id>`.
   */
  | { id: string; label: string };

export interface TextHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Unified-diff lines, each starting with ' ', '-' or '+'. */
  lines: string[];
}

export type ValueChange =
  | { type: 'added'; value: unknown }
  | { type: 'removed'; value: unknown }
  | { type: 'modified'; from: unknown; to: unknown }
  /** Multi-line strings get a line-level diff instead of a whole-value replacement. */
  | { type: 'text'; hunks: TextHunk[]; lineEndingsChanged: boolean }
  /** Same id-matched elements, different order. Labels as in PathSegment. */
  | { type: 'reordered'; from: string[]; to: string[] };

export interface NodeRef {
  id: string;
  name: string;
  type: string;
}

export interface ConnectionEnd {
  /** Undefined when the connection names a node that does not exist. */
  id: string | undefined;
  name: string;
}

export interface ConnectionRef {
  source: ConnectionEnd;
  /** Connection type, e.g. `main` or `ai_tool`. */
  type: string;
  output: number;
  /** Human name for the output, e.g. `true`/`false` on an IF node. */
  outputLabel: string | undefined;
  target: ConnectionEnd;
  input: number;
}

export interface GroupRef {
  id: string;
  name: string;
}

export type Change =
  | { kind: 'workflow-renamed'; from: string; to: string }
  | { kind: 'active-changed'; from: boolean; to: boolean }
  | { kind: 'tag-added'; tag: string }
  | { kind: 'tag-removed'; tag: string }
  | { kind: 'node-added'; node: NodeRef }
  | { kind: 'node-removed'; node: NodeRef }
  | { kind: 'node-renamed'; node: NodeRef; from: string; to: string }
  | {
      kind: 'node-type-changed';
      node: NodeRef;
      field: 'type' | 'typeVersion';
      from: unknown;
      to: unknown;
    }
  | {
      kind: 'parameter-changed';
      node: NodeRef;
      path: PathSegment[];
      change: ValueChange;
      /**
       * Present on one side and missing on the other. The n8n editor strips
       * parameters equal to their defaults on save, so this may not change
       * behaviour. Never hidden; renderers group these after real changes.
       */
      possibleDefault: boolean;
    }
  /** Credential references are compared by name; ids differ between instances. */
  | {
      kind: 'credential-changed';
      node: NodeRef;
      credentialType: string;
      from: string | null;
      to: string | null;
    }
  | { kind: 'node-property-changed'; node: NodeRef; path: PathSegment[]; change: ValueChange }
  /** Only reported with `includeLayout`. */
  | { kind: 'node-moved'; node: NodeRef; from: unknown; to: unknown }
  | { kind: 'connection-added'; connection: ConnectionRef }
  | { kind: 'connection-removed'; connection: ConnectionRef }
  | { kind: 'group-added'; group: GroupRef }
  | { kind: 'group-removed'; group: GroupRef }
  | { kind: 'group-renamed'; group: GroupRef; from: string; to: string }
  | { kind: 'group-description-changed'; group: GroupRef; change: ValueChange }
  | { kind: 'group-node-joined'; group: GroupRef; node: ConnectionEnd }
  | { kind: 'group-node-left'; group: GroupRef; node: ConnectionEnd }
  | { kind: 'setting-changed'; path: PathSegment[]; change: ValueChange }
  /** A top-level field flowdiff does not model. */
  | { kind: 'field-changed'; path: PathSegment[]; change: ValueChange };

export type ChangeKind = Change['kind'];
