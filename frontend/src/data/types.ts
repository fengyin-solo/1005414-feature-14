/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
  // 可选的状态流转表：当前状态 → 允许到达的下一状态。登记后状态只能一段一段往前推，
  // 倒序改动、跳段改动都会被拦下；没登记的模块维持原来的宽松流转。
  transitions?: Record<string, string[]>
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 演练评估材料分包的导出结果：页面拿 message 直接展示，entries 是打进 zip 的文件清单。 */
export type DrillExportResult = {
  ok: boolean
  message: string
  filename: string
  entries: { name: string; content: string }[]
  stacks: number
  notices: number
  returned: number
  conflicts: number
  headcount: number
  reviewItem: string
  reviewReused: boolean
}
