import type { NodeType } from '../constants/index';

export interface ElementInfo {
  id: string;
  indexId: number;
  nodeHashId: string;
  xpaths?: string[];
  attributes: {
    nodeType: NodeType;
    [key: string]: string;
  };
  nodeType: NodeType;
  content: string;
  rect: { left: number; top: number; width: number; height: number };
  center: [number, number];
  isVisible: boolean;
}

export interface ElementNode {
  node: ElementInfo | null;
  children: ElementNode[];
}

export {
  descriptionOfTree,
  traverseTree,
  treeToList,
  truncateText,
  trimAttributes,
} from './tree';

export { extractTextWithPosition as webExtractTextWithPosition } from './web-extractor';

export { extractTreeNode as webExtractNodeTree } from './web-extractor';

export { extractTreeNodeAsString as webExtractNodeTreeAsString } from './web-extractor';

export {
  getXpathsByPoint,
  getXpathsById,
  getNodeInfoByXpath,
  getElementInfoByXpath,
  getElementXpath,
} from './locator';

export {
  TREE_ONLY_BROWSER_COLLECTOR,
  TREE_ONLY_BROWSER_DEFAULT_MAX_NODES,
  TREE_ONLY_BROWSER_SNAPSHOT_SCHEMA_VERSION,
  collectTreeOnlyBrowserSnapshot,
  serializeTreeOnlyBrowserSnapshot,
} from './tree-only-collector';
export type {
  TreeOnlyBackendRef,
  TreeOnlyBrowserCollectOptions,
  TreeOnlyBrowserCollectResult,
  TreeOnlyBrowserCollectViewport,
} from './tree-only-collector';

export { isNotContainerElement } from './dom-util';
