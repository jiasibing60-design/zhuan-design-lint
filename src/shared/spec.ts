import type { ColorToken } from './types';
export const SPEC_URL = 'https://zhuanspirit.feishu.cn/wiki/E3cHw2PV0iEMR4kCdOTcYLPqn5e';
export const SPEC_VERSION = '2026-10-13';
export const PRIMITIVES: ColorToken[] = [
  ['品牌/红','#FF0F27'], ['品牌/浅红','#FFF2F2'], ['中性色/强','#111111'],
  ['中性色/次级','#666666'], ['中性色/三级','#999999'], ['中性色/弱','#BBBBBB'],
  ['中性色/白','#FFFFFF'], ['中性色/页面背景','#F8F8F8'], ['中性色/分割线','#F0F0F0'],
  ['中性色/描边','#D8D8D8'], ['中性色/蒙层-70','#111111',0.7],
  ['反馈/警示','#FFA628'], ['反馈/警示背景','#FFFAED'], ['反馈/成功','#72D954'],
  ['链接/默认','#42A0FF'], ['链接/背景','#ECF5FF']
].map(([name,hex,alpha]) => ({ name: String(name), hex: String(hex), alpha: Number(alpha ?? 1) }));
export const SEMANTICS: ColorToken[] = [
  ['品牌/主色','品牌/红'], ['品牌/背景','品牌/浅红'],
  ['文字/一级','中性色/强'], ['文字/二级','中性色/次级'], ['文字/三级','中性色/三级'],
  ['文字/占位','中性色/弱'], ['文字/禁用','中性色/弱'], ['文字/白色','中性色/白'],
  ['背景/灰色','中性色/页面背景'], ['背景/白色','中性色/白'],
  ['边框/默认','中性色/描边'], ['边框/分割线','中性色/分割线'], ['边框/弱操作','中性色/弱'],
  ['蒙层/遮罩','中性色/蒙层-70'], ['反馈/成功','反馈/成功'],
  ['反馈/警示','反馈/警示'], ['反馈/警示背景','反馈/警示背景'],
  ['链接/默认','链接/默认'], ['链接/背景','链接/背景']
].map(([name, primitive]) => ({ ...PRIMITIVES.find(t => t.name === primitive)!, name, primitive }));
export const BODY_SIZES = [20,22,24,26,28,30,32,34,36,40];
export const PRICE_SIZES = [32,40,44,68,72];
export const BASE_SIZES = [20,22,24,26,28,30,32,34,36,40,44,68,72];
export const RADII = [4,8,12,16,24,32,999];
export const RADIUS_NAMES = ['radius/xxs','radius/xs','radius/sm','radius/md','radius/lg','radius/xl','radius/pill'];
export function tokenName(name: string) { return name.replace(/^ZHUAN\s*\/\s*(?:Color Primitives|Color|Typography|Dimension)\s*\/\s*/i, '').trim(); }
export function isSpecCollection(name: string) { return /^ZHUAN\s*\/\s*(Color Primitives|Color|Typography|Dimension)$/i.test(name.trim()); }
