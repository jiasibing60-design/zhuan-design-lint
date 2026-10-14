import type { CleanupItem, CleanupPlan } from '../shared/types';
import { repairGuard } from './repairs';

const componentTypes = new Set(['COMPONENT', 'COMPONENT_SET', 'INSTANCE']);
function children(node: SceneNode): readonly SceneNode[] { return 'children' in node ? node.children : []; }
function walk(roots: readonly SceneNode[]): SceneNode[] {
  const nodes: SceneNode[] = [], seen = new Set<string>(), stack = [...roots].reverse();
  while (stack.length) {
    const node = stack.pop()!;
    if (node.removed || seen.has(node.id)) continue;
    seen.add(node.id); nodes.push(node); stack.push(...[...children(node)].reverse());
  }
  return nodes;
}
export function prototypeReferences(pages: readonly PageNode[]): Set<string> {
  const ids = new Set<string>();
  function visit(value: unknown) {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (key === 'destinationId' && typeof item === 'string') ids.add(item);
      else visit(item);
    }
  }
  for (const page of pages) {
    for (const flow of page.flowStartingPoints ?? []) ids.add(flow.nodeId);
    for (const node of walk(page.children)) if ('reactions' in node) visit(node.reactions);
  }
  return ids;
}
function protectedNode(node: SceneNode, refs: Set<string>): boolean {
  return node.locked || componentTypes.has(node.type) || refs.has(node.id)
    || ('reactions' in node && node.reactions.length > 0)
    || !!node.boundVariables?.visible
    || !!('componentPropertyReferences' in node && node.componentPropertyReferences?.visible);
}
export function cleanupReason(node: SceneNode): CleanupItem['reason'] | undefined {
  if (!node.visible) return '隐藏图层';
  if (node.type === 'TEXT' && node.characters.length === 0) return '空文字';
  if (node.type === 'GROUP' && node.children.length === 0 && !node.effects?.length) return '空分组';
}
function eligible(node: SceneNode, refs: Set<string>): boolean {
  for (let p: BaseNode | null = node; p && p.type !== 'PAGE'; p = p.parent) {
    if ('locked' in p && (p.locked || componentTypes.has(p.type))) return false;
  }
  return !walk([node]).some(n => protectedNode(n, refs));
}
function path(node: SceneNode): string {
  const names: string[] = [];
  for (let p: BaseNode | null = node; p && p.type !== 'DOCUMENT'; p = p.parent) names.unshift(p.name);
  return names.join(' / ');
}
function depth(node: SceneNode): number {
  let count=0;
  for(let p:BaseNode|null=node;p;p=p.parent)count++;
  return count;
}
export async function cleanupGuard(node: SceneNode): Promise<string> {
  const records = [];
  for (const n of walk([node])) records.push([n.id, n.parent?.id, n.visible, n.locked, n.boundVariables,
    'componentPropertyReferences' in n ? n.componentPropertyReferences : null,
    n.x, n.y, n.width, n.height, 'opacity' in n ? n.opacity : null,
    'effects' in n ? n.effects : [], 'reactions' in n ? n.reactions : [], await repairGuard(n)]);
  return JSON.stringify(records);
}
export async function buildCleanupPlan(page: PageNode, roots: readonly SceneNode[], refs: Set<string>, id: string) {
  const plan: CleanupPlan = { id, pageId: page.id, items: [], scanned: 0, protected: 0 };
  const guards = new Map<string, string>(), covered = new Set<string>();
  // Parents first, even when an overlapping selection lists a child before its parent.
  const nodes = walk(roots).sort((a, b) => depth(a) - depth(b));
  for (const node of nodes) {
    plan.scanned++;
    if (covered.has(node.id)) continue;
    const reason = cleanupReason(node);
    if (!reason) continue;
    if (!eligible(node, refs)) { plan.protected++; continue; }
    const subtree = walk([node]);
    plan.items.push({ id: node.id, name: node.name, path: path(node), reason, descendants: subtree.length - 1 });
    guards.set(node.id, await cleanupGuard(node));
    subtree.forEach(n => covered.add(n.id));
    if (plan.items.length === 500) break;
    if (plan.scanned % 100 === 0) await new Promise(resolve => setTimeout(resolve, 0));
  }
  return { plan, guards };
}
export function cleanupStillEligible(item: CleanupItem, node: SceneNode, pageId: string, refs: Set<string>): boolean {
  let page: BaseNode | null = node;
  while (page && page.type !== 'PAGE') page = page.parent;
  return !node.removed && page?.id === pageId && cleanupReason(node) === item.reason && eligible(node, refs);
}
export async function validateCleanup(item: CleanupItem, node: SceneNode, pageId: string, refs: Set<string>, guard: string): Promise<boolean> {
  return cleanupStillEligible(item, node, pageId, refs) && await cleanupGuard(node) === guard;
}
