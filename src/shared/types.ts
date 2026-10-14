export type Category = 'text' | 'fill' | 'stroke' | 'radius';
export type Severity = 'error' | 'warning';
export type Scope = 'selection' | 'page';
export interface Settings {
  text: boolean; fill: boolean; stroke: boolean; radius: boolean;
  checkSpec: boolean; semanticHints: boolean;
  includeHidden: boolean; includeLocked: boolean; includeVectors: boolean;
  live: boolean; scale: 1 | 0.5;
}
export const DEFAULT_SETTINGS: Settings = {
  text: true, fill: true, stroke: true, radius: true, checkSpec: true,
  semanticHints: true, includeHidden: false, includeLocked: false,
  includeVectors: true, live: true, scale: 1
};
export interface ColorToken { name: string; hex: string; alpha: number; primitive?: string }
export interface ResolvedBinding {
  id: string; name: string; collection: string; verifiedCollection: boolean;
  value?: unknown; unavailable?: boolean;
}
export interface PaintSnapshot {
  type: string; visible?: boolean; opacity?: number;
  color?: { r: number; g: number; b: number }; binding?: ResolvedBinding;
}
export interface TextRun {
  start: number; end: number; text: string; styleId: string;
  font: { family: string; style: string }; size: number;
  fills: PaintSnapshot[]; fillStyleId: string;
}
export interface NodeSnapshot {
  id: string; name: string; type: string; path: string;
  fills?: PaintSnapshot[]; fillStyleId?: string;
  strokes?: PaintSnapshot[]; strokeStyleId?: string;
  runs?: TextRun[];
  corners?: { field: string; label: string; value: number; binding?: ResolvedBinding }[];
}
export interface FixCandidate {
  id: string; name: string; kind: 'textStyle' | 'paintStyle' | 'colorVariable';
  key?: string; remote?: boolean;
}
export interface Issue {
  id: string; fingerprint: string; nodeId: string; nodeName: string; nodeType: string;
  path: string; category: Category; severity: Severity; rule: string;
  title: string; actual: string; expected: string;
  field: string; paintIndex?: number; start?: number; end?: number;
  suggestions: string[]; fixes?: FixCandidate[]; swatch?: string;
}
export interface IgnoreEntry { fingerprint: string; reason: string; at: string }
export type RepairAction =
  | { kind:'candidate'; candidate:FixCandidate }
  | { kind:'color'; hex:string; alpha:number; token:string }
  | { kind:'fontSize'; value:number }
  | { kind:'radius'; value:number }
  | { kind:'font'; font:{ family:string; style:string } };
export interface RepairOption {
  id:string; label:string; detail:string; action:RepairAction;
  recommended?:boolean; automatic?:boolean;
}
export interface RepairItem {
  issue:Issue; options:RepairOption[]; note:string; target:string;
}
export interface RepairPlan {
  id:string; pageId:string; items:RepairItem[]; at:string;
}
export interface RepairLog {
  at:string; entries:{ nodeId:string; nodeName:string; issueId:string; before:string; after:string; status:'applied'|'skipped'|'failed'; message?:string }[];
}
export interface CleanupItem { id:string; name:string; path:string; reason:'空文字'|'空分组'|'隐藏图层'; descendants:number }
export interface CleanupPlan { id:string; pageId:string; items:CleanupItem[]; scanned:number; protected:number }
export interface ScanResult {
  issues: Issue[]; ignored: (Issue & { ignore: IgnoreEntry })[];
  scanned: number; skipped: number; unreadable: number; complete: boolean;
  scope: Scope; scopeNames: string[]; pageName: string; pageId: string;
  at: string; duration: number; settings: Settings; notices: string[];
  repairHistory?:RepairLog[];
}
export type UIMessage =
  | { type: 'ready' }
  | { type: 'scan'; scope: Scope }
  | { type: 'cancel' }
  | { type: 'settings'; settings: Settings }
  | { type: 'locate'; nodeIds: string[] }
  | { type: 'ignore'; fingerprint: string; reason: string }
  | { type: 'restore'; fingerprint: string }
  | { type: 'clear-ignored' }
  | { type: 'candidates'; issueId: string }
  | { type: 'apply'; issueId: string; candidateId: string }
  | { type:'repair-preview'; issueIds:string[]; requestId:string }
  | { type:'repair-apply'; planId:string; choices:{ issueId:string; optionId:string }[] }
  | { type:'auto-repair' }
  | { type:'cleanup-preview'; scope:Scope }
  | { type:'cleanup-apply'; planId:string; nodeIds:string[] }
  | { type: 'close' };
