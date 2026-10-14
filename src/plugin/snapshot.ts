import { isSpecCollection } from '../shared/spec';
import type { NodeSnapshot, PaintSnapshot, ResolvedBinding } from '../shared/types';

export function createSnapshotReader() {
  const variables = new Map<string,Promise<Variable | null>>();
  const collections = new Map<string,Promise<VariableCollection | null>>();
  async function binding(alias: VariableAlias | undefined, node: SceneNode): Promise<ResolvedBinding | undefined> {
    if (!alias) return undefined;
    try {
      if (!variables.has(alias.id)) variables.set(alias.id,figma.variables.getVariableByIdAsync(alias.id));
      const v = await variables.get(alias.id)!;
      if (!v) throw new Error('Variable missing');
      if (!collections.has(v.variableCollectionId)) collections.set(v.variableCollectionId,figma.variables.getVariableCollectionByIdAsync(v.variableCollectionId));
      const collection = await collections.get(v.variableCollectionId)!;
      return { id:v.id,name:v.name,collection:collection?.name ?? '',verifiedCollection:!!collection && isSpecCollection(collection.name),value:v.resolveForConsumer(node).value };
    } catch { return { id:alias.id,name:alias.id,collection:'',verifiedCollection:false,unavailable:true }; }
  }
  async function paints(items: readonly Paint[] | symbol, node: SceneNode): Promise<PaintSnapshot[]> {
    if (typeof items === 'symbol') return [];
    return Promise.all(items.map(async p => ({ type:p.type,visible:p.visible,opacity:p.opacity,
      ...(p.type === 'SOLID' ? { color:p.color,binding:await binding(p.boundVariables?.color,node) } : {})
    })));
  }
  return async (node: SceneNode): Promise<NodeSnapshot> => {
    const ancestors: string[] = [];
    for (let p: BaseNode | null = node.parent; p && p.type !== 'DOCUMENT'; p = p.parent) ancestors.unshift(p.name);
    const snapshot: NodeSnapshot = { id:node.id,name:node.name,type:node.type,path:[...ancestors,node.name].join(' / ') };
    if ('fills' in node && node.type !== 'TEXT') {
      snapshot.fills = await paints(node.fills,node);
      snapshot.fillStyleId = typeof node.fillStyleId === 'string' ? node.fillStyleId : '';
    }
    if ('strokes' in node) {
      snapshot.strokes = await paints(node.strokes,node);
      snapshot.strokeStyleId = typeof node.strokeStyleId === 'string' ? node.strokeStyleId : '';
    }
    if (node.type === 'TEXT' && node.characters.length) {
      const runs = node.getStyledTextSegments(['textStyleId','fontName','fontSize','fills','fillStyleId']);
      snapshot.runs = await Promise.all(runs.map(async run => ({ start:run.start,end:run.end,text:run.characters,styleId:run.textStyleId,font:run.fontName,size:run.fontSize,fills:await paints(run.fills,node),fillStyleId:run.fillStyleId })));
    }
    if ('topLeftRadius' in node) {
      const fields = ['topLeftRadius','topRightRadius','bottomRightRadius','bottomLeftRadius'] as const;
      const labels = ['左上圆角','右上圆角','右下圆角','左下圆角'];
      snapshot.corners = await Promise.all(fields.map(async (field,i) => ({ field,label:labels[i],value:node[field],binding:await binding(node.boundVariables?.[field],node) })));
    }
    return snapshot;
  };
}
