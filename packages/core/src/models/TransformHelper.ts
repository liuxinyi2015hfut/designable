import {
  Point,
  calcEdgeLinesOfRect,
  calcSpaceBlockOfRect,
  IRect,
  Rect,
  isLineSegment,
  ILineSegment,
  calcClosestEdges,
  calcCombineSnapLineSegment,
  ElementTransformer,
  ElementGroupTransformer,
  createElementTransformer,
  isEqualLineSegment,
  isEqualRect,
  PointTypes,
  ITransformApplier,
  IRectEdgeLines,
} from '@designable/shared'
import { observable, define, action } from '@formily/reactive'
import { SpaceBlock, AroundSpaceBlock } from './SpaceBlock'
import { Operation } from './Operation'
import { TreeNode } from './TreeNode'
import { SnapLine, ISnapLine } from './SnapLine'
import { CursorDragType } from './Cursor'

export interface ITransformHelperProps {
  operation: Operation
}

export interface IAroundSnapLines {
  shadowSnapLines: SnapLine[]
  realSnapLines: SnapLine[]
}

export type ResizeDirection =
  | 'left-top'
  | 'left-center'
  | 'left-bottom'
  | 'center-top'
  | 'center-bottom'
  | 'right-top'
  | 'right-bottom'
  | 'right-center'
  | (string & {})

export type TransformHelperType = 'translate' | 'resize' | 'rotate' | 'round'

export type ResizeCalcDirection = [number, number, PointTypes, string]

export type SnappingTransfer = {
  v?: { delta?: number }
  h?: { delta?: number }
}

export interface ITransformHelperDragStartProps {
  type: TransformHelperType
  direction?: ResizeDirection
  dragNodes?: TreeNode[]
}

function transformPointType(direction: ResizeDirection) {
  return String(direction).replace(
    /\b(\w)[^-_,+\s]*(?:[-_,+\s]+)?/g,
    (_, $0) => $0
  )
}

export class TransformHelper {
  operation: Operation

  type: TransformHelperType

  direction: PointTypes

  dragNodes: TreeNode[] = []

  rulerSnapLines: SnapLine[] = []

  aroundSnapLines: IAroundSnapLines = null

  aroundSpaceBlocks: AroundSpaceBlock = null

  viewportNodes: TreeNode[] = []

  dragNodesTransformer: ElementTransformer | ElementGroupTransformer = null

  dragNodesShadowTransformer: ElementTransformer | ElementGroupTransformer =
    null

  dragging = false

  snapped = false

  optionMode = 0

  commandMode = 0

  restrictMode = 0

  constructor(props: ITransformHelperProps) {
    this.operation = props.operation
    this.makeObservable()
  }

  get tree() {
    return this.operation.tree
  }

  get cursor() {
    return this.operation.engine.cursor
  }

  get viewport() {
    return this.operation.workspace.viewport
  }

  get deltaX() {
    return (
      this.cursor.dragStartToCurrentDelta.clientX +
      this.viewport.dragScrollXDelta
    )
  }

  get snapDeltaX() {
    const snapLine = this.prioritySnapLines
    if (snapLine.v) {
      if (snapLine.v.distance < TransformHelper.threshold) {
        return snapLine.v.offset
      }
    }
    return 0
  }

  get deltaY() {
    return (
      this.cursor.dragStartToCurrentDelta.clientY +
      this.viewport.dragScrollYDelta
    )
  }

  get snapDeltaY() {
    const snapLine = this.prioritySnapLines
    if (snapLine.h) {
      if (snapLine.h.distance < TransformHelper.threshold) {
        return snapLine.h.offset
      }
    }
    return 0
  }

  get dragNodesOffsetRect() {
    const clientRect = this.dragNodesTransformer?.boundingClientRect
    if (clientRect) {
      return this.viewport.getOffsetRect(clientRect)
    }
  }

  get dragNodesShadowOffsetRect() {
    const clientRect = this.dragNodesShadowTransformer?.boundingClientRect
    if (clientRect) {
      return this.viewport.getOffsetRect(clientRect)
    }
  }

  get dragNodesShadowEdgeLines() {
    return calcEdgeLinesOfRect(this.dragNodesShadowOffsetRect)
  }

  get dragNodesEdgeLines() {
    return calcEdgeLinesOfRect(this.dragNodesOffsetRect)
  }

  get dragStartCursor() {
    const position = this.operation.engine.cursor.dragStartPosition
    return this.operation.workspace.viewport.getOffsetPoint(
      new Point(position.clientX, position.clientY)
    )
  }

  get prioritySnapLines() {
    let minHDistance = Infinity
    let minVDistance = Infinity
    let lines: Record<string, SnapLine> = {}
    for (let i = 0; i < this.closestSnapLines.length; i++) {
      const snapLine = this.closestSnapLines[i]
      if (this.type === 'resize' && snapLine.distance === 0) continue
      if (snapLine.direction === 'h') {
        if (snapLine.distance < minHDistance) {
          minHDistance = snapLine.distance
          lines['h'] = snapLine
        }
      }
      if (snapLine.direction === 'v') {
        if (snapLine.distance < minVDistance) {
          minVDistance = snapLine.distance
          lines['v'] = snapLine
        }
      }
    }
    return lines
  }

  get closestSnapLines() {
    if (!this.dragging) return []
    const results = []
    this.aroundSnapLines?.shadowSnapLines.forEach((line) => {
      const { distance, offset } = calcClosestEdges(
        line,
        this.dragNodesShadowEdgeLines
      )
      if (distance < TransformHelper.threshold) {
        results.push(
          new SnapLine(this, {
            ...line,
            distance,
            offset,
          })
        )
      }
    })
    return results
  }

  get visibleSnapLines() {
    return (
      this.aroundSnapLines?.realSnapLines.filter(
        (line) => line.distance === 0
      ) ?? []
    )
  }

  get thresholdSpaceBlocks(): SpaceBlock[] {
    if (!this.dragging) return []
    const dragNodesEdgeLines = this.dragNodesEdgeLines
    return this.axisSpaceBlocks.filter((block) => {
      const line = block.snapLine
      if (!line) return false
      const { distance } = calcClosestEdges(line, dragNodesEdgeLines)
      return distance < TransformHelper.threshold
    })
  }

  get measurerSpaceBlocks(): SpaceBlock[] {
    const results: SpaceBlock[] = []
    const snapLines = this.closestSnapLines
    if (!this.dragging) return []
    let hasVSnapLine = false
    let hasHSnapLine = false
    snapLines.forEach((line) => {
      if (line.direction === 'v') {
        hasVSnapLine = true
      } else {
        hasHSnapLine = true
      }
    })
    for (let type in this.aroundSpaceBlocks) {
      const block = this.aroundSpaceBlocks[type]
      if (block.type === 'left' || block.type === 'right') {
        if (!hasHSnapLine) continue
      } else {
        if (!hasVSnapLine) continue
      }
      const refer = block.refer
      const referRect = block.refer.getElementOffsetRect()
      const origin = calcSpaceBlockOfRect(this.dragNodesOffsetRect, referRect)
      if (origin) {
        if (origin.distance < TransformHelper.threshold) continue
        results.push(
          new SpaceBlock(this, {
            refer,
            ...origin,
          })
        )
      }
    }
    return results
  }

  get measurerExtendsLines(): ILineSegment[] {
    const blocks = this.measurerSpaceBlocks
    const results: ILineSegment[] = []
    blocks.forEach(({ extendsLine }) => {
      if (results.find((line) => isEqualLineSegment(line, extendsLine))) return
      results.push(extendsLine)
    })
    return results
  }

  get axisSpaceBlocks() {
    const results = []
    if (!this.dragging) return []
    for (let type in this.aroundSpaceBlocks) {
      const block = this.aroundSpaceBlocks[type]
      if (!block.snapLine) continue
      if (block.snapLine.distance !== 0) continue
      if (block.isometrics.length) {
        const origin = calcSpaceBlockOfRect(
          this.dragNodesOffsetRect,
          block.referRect
        )
        if (origin) {
          results.push(new SpaceBlock(this, origin))
          results.push(...block.isometrics)
        }
      }
    }

    return results
  }

  calcDragStartStore(nodes: TreeNode[] = []) {
    this.dragNodesTransformer = createElementTransformer(nodes)
    this.dragNodesShadowTransformer = createElementTransformer(nodes)
  }

  calcAroundSnapLines(shadowRect: Rect, realRect: Rect): IAroundSnapLines {
    if (!this.dragging || !shadowRect) return
    const shadowEdgeLines = calcEdgeLinesOfRect(shadowRect)
    const realEdgeLines = calcEdgeLinesOfRect(realRect)
    const shadowSnapLines = {}
    const realSnapLines = {}
    const addSnapLine = (lines: any, snapLine: SnapLine, rect: Rect) => {
      if (!snapLine || snapLine.distance > TransformHelper.threshold) return

      const edge = snapLine.getClosestEdge(rect)
      if (this.type === 'resize') {
        if (edge === 'hc' || edge === 'vc') return
      }
      lines[edge] = lines[edge] || snapLine
      if (lines[edge].distance > snapLine.distance) {
        lines[edge] = snapLine
      }
    }

    const addShadowSnapLine = (snapLine: SnapLine) =>
      addSnapLine(shadowSnapLines, snapLine, shadowRect)
    const addRealSnapLine = (snapLine: SnapLine) =>
      addSnapLine(realSnapLines, snapLine, realRect)
    const createCombinedSnapLine = (
      line: ILineSegment,
      edgeLines: IRectEdgeLines
    ) => {
      if (!line) return
      const { distance, snap, offset, edge } = calcClosestEdges(line, edgeLines)
      if (!snap || distance > TransformHelper.threshold) return
      const combined = calcCombineSnapLineSegment(line, snap)
      return new SnapLine(this, {
        ...combined,
        offset,
        edge,
        distance,
      })
    }
    this.eachViewportNodes((refer) => {
      if (this.dragNodes.some((target) => target.contains(refer))) return
      const referLines = calcEdgeLinesOfRect(refer.getElementOffsetRect())
      const addAroundSnapLine = (line: ILineSegment) => {
        addShadowSnapLine(createCombinedSnapLine(line, shadowEdgeLines))
        addRealSnapLine(createCombinedSnapLine(line, realEdgeLines))
      }
      referLines.h.forEach(addAroundSnapLine)
      referLines.v.forEach(addAroundSnapLine)
    })

    this.rulerSnapLines.forEach((line) => {
      if (line.closest) {
        addShadowSnapLine(line)
      }
    })
    for (let type in this.aroundSpaceBlocks) {
      const block = this.aroundSpaceBlocks[type]
      const line = block.snapLine
      if (line) {
        addShadowSnapLine(line)
      }
    }
    return {
      shadowSnapLines: Object.values(shadowSnapLines),
      realSnapLines: Object.values(realSnapLines),
    }
  }

  calcAroundSpaceBlocks(dragNodesRect: IRect): AroundSpaceBlock {
    if (!dragNodesRect) return {} as any
    const aroundSpaces = {}
    this.eachViewportNodes((refer) => {
      if (this.dragNodes.some((target) => target.contains(refer))) return
      const referRect = refer.getElementOffsetRect()
      if (isEqualRect(dragNodesRect, referRect)) return
      const origin = calcSpaceBlockOfRect(dragNodesRect, referRect)
      if (origin) {
        const spaceBlock = new SpaceBlock(this, {
          refer,
          ...origin,
        })
        if (!aroundSpaces[origin.type]) {
          aroundSpaces[origin.type] = spaceBlock
        } else if (spaceBlock.distance < aroundSpaces[origin.type].distance) {
          aroundSpaces[origin.type] = spaceBlock
        }
      }
    })
    return aroundSpaces as any
  }

  calcAxisSpaceBlocks(aroundSpaceBlocks: AroundSpaceBlock): SpaceBlock[] {
    const results = []
    if (!this.dragging) return []
    for (let type in aroundSpaceBlocks) {
      const block = aroundSpaceBlocks[type]
      if (!block.snapLine) return []
      if (block.snapLine.distance !== 0) return []
      if (block.isometrics.length) {
        results.push(block)
        results.push(...block.isometrics)
      }
    }
    return results
  }

  calcViewportNodes() {
    this.tree.eachTree((node) => {
      const clientRect = node.getValidElementClientRect()
      if (this.dragNodes.includes(node)) return
      if (this.viewport.isRectIntersectionInViewport(clientRect)) {
        this.viewportNodes.push(node)
      }
    })
  }

  eachViewportNodes(visitor: (node: TreeNode) => void) {
    this.viewportNodes.forEach(visitor)
  }

  calcTransform(snapDeltaX = 0, snapDeltaY = 0) {
    return (applier: ITransformApplier) => {
      const restricting = !!this.restrictMode
      const deltaX = this.deltaX + snapDeltaX
      const deltaY = this.deltaY + snapDeltaY
      if (this.type === 'translate') {
        return applier.translate(deltaX, deltaY, { restricting })
      }
      if (this.type === 'resize') {
        const direction = this.direction
        return applier.resize(deltaX, deltaY, {
          direction,
          keepAspectRatio: restricting,
          symmetry: !!this.optionMode,
        })
      }
      if (this.type === 'rotate') {
        const cursor = this.cursor.position
        return applier.rotate(cursor.topClientX, cursor.topClientY, {
          restricting,
        })
      }
    }
  }

  calcGuideLines() {
    const dragNodesShadowRect = this.dragNodesShadowOffsetRect
    const dragNodesRect = this.dragNodesOffsetRect
    if (this.type === 'translate' || this.type === 'resize') {
      this.aroundSpaceBlocks = this.calcAroundSpaceBlocks(dragNodesRect)
      this.aroundSnapLines = this.calcAroundSnapLines(
        dragNodesShadowRect,
        dragNodesRect
      )
    }
  }

  findRulerSnapLine(id: string) {
    return this.rulerSnapLines.find((item) => item.id === id)
  }

  addRulerSnapLine(line: ISnapLine) {
    if (!isLineSegment(line)) return
    if (!this.findRulerSnapLine(line.id)) {
      this.rulerSnapLines.push(new SnapLine(this, { ...line, type: 'ruler' }))
    }
  }

  removeRulerSnapLine(id: string) {
    const matchedLineIndex = this.rulerSnapLines.findIndex(
      (item) => item.id === id
    )
    if (matchedLineIndex > -1) {
      this.rulerSnapLines.splice(matchedLineIndex, 1)
    }
  }

  dragStart(props: ITransformHelperDragStartProps) {
    const dragNodes = props?.dragNodes ?? this.operation.selection.selectedNodes
    const type = props?.type
    const direction = props?.direction

    if (type === 'resize') {
      const nodes = TreeNode.filterResizable(dragNodes)
      if (nodes.length) {
        this.dragging = true
        this.type = type
        this.direction = transformPointType(direction)
        this.dragNodes = nodes
        this.calcDragStartStore(nodes)
        this.cursor.setDragType(CursorDragType.Resize)
      }
    } else if (type === 'translate') {
      const nodes = TreeNode.filterTranslatable(dragNodes)
      if (nodes.length) {
        this.dragging = true
        this.type = type
        this.dragNodes = nodes
        this.calcDragStartStore(nodes)
        this.cursor.setDragType(CursorDragType.Translate)
      }
    } else if (type === 'rotate') {
      const nodes = TreeNode.filterRotatable(dragNodes)
      if (nodes.length) {
        this.dragging = true
        this.type = type
        this.dragNodes = nodes
        this.calcDragStartStore(nodes)
        this.cursor.setDragType(CursorDragType.Rotate)
      }
    } else if (type === 'round') {
      const nodes = TreeNode.filterRoundable(dragNodes)
      if (nodes.length) {
        this.dragging = true
        this.type = type
        this.dragNodes = nodes
        this.calcDragStartStore(nodes)
        this.cursor.setDragType(CursorDragType.Round)
      }
    }
    if (this.dragging) {
      this.calcViewportNodes()
    }
  }

  dragMove() {
    if (!this.dragging) return
    this.dragNodesShadowTransformer.transform(this.calcTransform())
    this.dragNodesTransformer.transform(
      this.calcTransform(this.snapDeltaX, this.snapDeltaY)
      // {
      //   getTranslateSnapOffset: () => {},
      //   getResizeSnapSize: () => {},
      //   getRotateSnapAngle: () => {},
      // }
    )()
    this.calcGuideLines()
  }

  startOptionMode() {
    this.optionMode = 1
  }

  startCommandMode() {
    this.commandMode = 1
  }

  cancelOptionMode() {
    this.optionMode = 0
  }

  startRestrictMode() {
    this.restrictMode = 1
  }

  cancelRestrictMode() {
    this.restrictMode = 0
  }

  cancelCommandMode() {
    this.commandMode = 0
  }

  dragEnd() {
    this.dragging = false
    this.viewportNodes = []
    this.aroundSnapLines = null
    this.aroundSpaceBlocks = null
    this.dragNodesTransformer = null
    this.dragNodesShadowTransformer = null
    this.dragNodes = []
    this.cursor.setDragType(CursorDragType.Move)
  }

  makeObservable() {
    define(this, {
      optionMode: observable.ref,
      restrictMode: observable.ref,
      snapped: observable.ref,
      dragging: observable.ref,
      dragNodes: observable.ref,
      aroundSnapLines: observable.ref,
      aroundSpaceBlocks: observable.ref,
      dragNodesTransformer: observable.ref,
      dragNodesShadowTransformer: observable.ref,
      rulerSnapLines: observable.shallow,
      closestSnapLines: observable.computed,
      thresholdSpaceBlocks: observable.computed,
      measurerSpaceBlocks: observable.computed,
      prioritySnapLines: observable.computed,
      axisSpaceBlocks: observable.computed,
      cursor: observable.computed,
      dragStartCursor: observable.computed,
      startOptionMode: action,
      startRestrictMode: action,
      cancelOptionMode: action,
      cancelRestrictMode: action,
      dragStart: action,
      dragMove: action,
      dragEnd: action,
    })
  }

  static threshold = 6
}