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

// 应急演练评估材料打包的办结汇总：期次、沓数、说明份数、退回校准条数与复核项落账情况。
export type DrillMaterialSummary = {
  period: string
  bundleCount: number
  noticeCount: number
  returnedCount: number
  participantTotal: number
  reviewCode: string
  reviewReused: boolean
}

export type DrillMaterialResult = {
  ok: boolean
  message: string
  summary?: DrillMaterialSummary
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
