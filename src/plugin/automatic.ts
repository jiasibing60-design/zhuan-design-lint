import type { RepairItem, RepairOption } from '../shared/types';
export function repairConflict(a: { item: RepairItem; option: RepairOption }, b: { item: RepairItem; option: RepairOption }): boolean {
  if (a.item.target === b.item.target) return true;
  const x = a.item.issue, y = b.item.issue;
  if (x.nodeId !== y.nodeId) return false;
  const wholePaint = (o: RepairOption) => o.action.kind === 'candidate' && o.action.candidate.kind === 'paintStyle';
  const wholeText = (o: RepairOption) => o.action.kind === 'candidate' && o.action.candidate.kind === 'textStyle';
  if ((wholePaint(a.option) || wholePaint(b.option)) && x.field === y.field && x.start === y.start && x.end === y.end) return true;
  return (wholeText(a.option) || wholeText(b.option)) && x.category === 'text' && y.category === 'text'
    && x.start! < y.end! && x.end! > y.start!;
}
export function automaticChoices(items: RepairItem[]) {
  const selected: { item: RepairItem; option: RepairOption }[] = [];
  for (const item of items) {
    const options = item.options.filter(o => o.automatic);
    if (options.length !== 1) continue;
    const next = { item, option: options[0] };
    if (!selected.some(other => repairConflict(other, next))) selected.push(next);
    if (selected.length === 100) break;
  }
  return selected.map(({ item, option }) => ({ issueId: item.issue.id, optionId: option.id }));
}
