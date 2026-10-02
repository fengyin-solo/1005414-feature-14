import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type {
  ActionResult,
  DrillMaterialResult,
  DrillMaterialSummary,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
} from '@/data/types'
import { buildZip, type ZipEntry } from '@/api/zip'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  // 状态只许沿登记的状态链一段一段往前推（如演练：待组织→已组织→已评估→已取消），倒序改动一律挡下。
  const currentIndex = meta.statuses.indexOf(current)
  const targetIndex = meta.statuses.indexOf(target)
  if (currentIndex >= 0 && targetIndex >= 0 && targetIndex < currentIndex) {
    return {
      ok: false,
      message: `${meta.entity}状态只许一段一段往前推（${meta.statuses.join('→')}），「${current}」倒回「${target}」的倒序改动已挡下`,
    }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

// —— 应急演练评估材料打包导出 ——
// 规则集中在这里，页面只负责触发与展示：
// 1. 只打包「当期（演练日期所在月份）且已评估」的演练，按参演队伍归沓；
// 2. 每沓放演练编号、演练主题、参演人数与评估结论，沓名带队伍名与演练日期（同队多场取最近一场）；
// 3. 参演队伍当期没有可打包演练的，给说明文件，不给空包；
// 4. 参演人数精度不足（不是整数人数）的先退回校准，不打入材料包；
// 5. 参演人数与评估结论打架时以评估结论为准，优先级判定写进材料；
// 6. 两处读到的参演人数必须一致：材料包合计与台账复读合计对不上就中止导出；
// 7. 导出办结在警示标识清单落一条演练复核项；重复导出沿用已有那条，不新增记录。

const DRILL_KEY = 'drill'
const SIGNBOARD_KEY = 'signboard'
const DRILL_REVIEW_PREFIX = 'DRILL-REVIEW'

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

function formatDate(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

function currentPeriod(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`
}

function safeFileName(text: string): string {
  return text.replace(/[\\/:*?"<>|]/g, '-')
}

// 参演人数只认整数人数；「约50」「50人左右」「50.5」这类都算精度不足。
function parseParticipants(value: string | number | boolean): number | null {
  const text = String(value ?? '').trim()
  if (!/^\d+$/.test(text)) {
    return null
  }
  return Number(text)
}

// 评估结论里的人数口径：优先取「实到N人」，其次任意「N人」。
function evaluationHeadcount(conclusion: string | number | boolean): number | null {
  const text = String(conclusion ?? '').trim()
  if (!text) {
    return null
  }
  const actual = text.match(/实到\s*(\d+)\s*人/)
  if (actual) {
    return Number(actual[1])
  }
  const any = text.match(/(\d+)\s*人/)
  return any ? Number(any[1]) : null
}

type ParticipantReading = {
  registered: number | null
  evaluated: number | null
  conflict: boolean
  effective: number | null
}

// 优先级判定：参演人数与评估结论打架时，以评估结论为准——评估是演练结束后的复核口径。
function readParticipants(row: EntryRow): ParticipantReading {
  const registered = parseParticipants(row['参演人数'])
  const evaluated = evaluationHeadcount(row['评估结论'])
  const conflict = registered !== null && evaluated !== null && registered !== evaluated
  return {
    registered,
    evaluated,
    conflict,
    effective: conflict ? evaluated : (registered ?? evaluated),
  }
}

function drillExportScope(rows: EntryRow[], period: string): EntryRow[] {
  return rows.filter(
    (row) => String(row.status) === '已评估' && String(row['演练日期'] ?? '').startsWith(period),
  )
}

function buildTeamBundle(
  team: string,
  period: string,
  latestDate: string,
  rows: EntryRow[],
): { content: string; total: number } {
  const lines = [
    '应急演练评估材料',
    `参演队伍：${team}`,
    `材料期次：${period}`,
    `沓名日期：${latestDate}（同队多场取最近一场演练日期）`,
    '优先级判定：参演人数与评估结论不一致时，以评估结论为准（评估是演练结束后的复核口径），冲突处在条目内标注。',
    '==============================',
  ]
  let total = 0
  rows.forEach((row, index) => {
    const reading = readParticipants(row)
    const participants = reading.effective ?? 0
    total += participants
    lines.push(`演练编号：${String(row['演练编号'] ?? '')}`)
    lines.push(`演练主题：${String(row['演练主题'] ?? '')}`)
    lines.push(`参演人数：${participants} 人`)
    lines.push(`评估结论：${String(row['评估结论'] ?? '').trim() || '—'}`)
    if (reading.conflict) {
      lines.push(
        `冲突标注：登记参演人数 ${reading.registered} 人，评估结论载明 ${reading.evaluated} 人；按优先级判定以评估结论为准，本材料参演人数记 ${reading.evaluated} 人。`,
      )
    }
    lines.push(index < rows.length - 1 ? '------------------------------' : '==============================')
  })
  lines.push(`参演人数合计：${total} 人`)
  return { content: `${lines.join('\n')}\n`, total }
}

function buildTeamNotice(team: string, period: string, withheld: boolean): string {
  const reason = withheld
    ? '该队伍本期演练的参演人数精度不足，已退回校准（见包内《退回校准清单》），校准前暂缓分发材料。'
    : '该队伍本期没有已评估的应急演练，无评估材料需要分发。'
  return `${[
    '应急演练评估材料分发说明',
    `参演队伍：${team}`,
    `材料期次：${period}`,
    `说明：${reason}按要求不附空材料包，特此说明。`,
  ].join('\n')}\n`
}

function buildReturnedList(period: string, returned: { row: EntryRow; reason: string }[]): string {
  const lines = [
    '参演人数退回校准清单',
    `材料期次：${period}`,
    '说明：以下演练的参演人数精度不足，未打入评估材料包；请校准参演人数后重新导出。',
    '==============================',
  ]
  returned.forEach(({ row, reason }, index) => {
    lines.push(`演练编号：${String(row['演练编号'] ?? '')}`)
    lines.push(`参演队伍：${String(row['参演队伍'] ?? '')}`)
    lines.push(`演练主题：${String(row['演练主题'] ?? '')}`)
    lines.push(`退回原因：${reason}`)
    lines.push(index < returned.length - 1 ? '------------------------------' : '==============================')
  })
  return `${lines.join('\n')}\n`
}

// 导出办结落到警示标识清单：每期一条演练复核项；重复导出沿用已有那条，不新增记录。
function recordDrillReview(
  period: string,
  participantTotal: number,
  today: Date,
): { code: string; reused: boolean } {
  const code = `${DRILL_REVIEW_PREFIX}-${period}`
  const rows = listRows(SIGNBOARD_KEY)
  if (rows.some((row) => String(row['标识编号']) === code)) {
    return { code, reused: true }
  }
  const nextId = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const dateText = formatDate(today)
  const reviewRow: EntryRow = {
    id: nextId,
    status: '待设置',
    pending: true,
    abnormal: false,
    标识编号: code,
    所属隐患点: '应急演练评估材料',
    标识类别: '演练复核',
    设置位置: `期次${period}·参演人数合计${participantTotal}人`,
    设置日期: dateText,
    责任人: '演练导出办结',
    更换日期: dateText,
    标识状态: '待设置',
  }
  saveRows(SIGNBOARD_KEY, [...rows, reviewRow])
  return { code, reused: false }
}

type DrillMaterialPackage = DrillMaterialResult & {
  filename?: string
  entries?: ZipEntry[]
}

export function buildDrillMaterialPackage(today: Date = new Date()): DrillMaterialPackage {
  const period = currentPeriod(today)
  const rows = listRows(DRILL_KEY)
  const scoped = drillExportScope(rows, period)

  // 精度校验：参演人数精度不足的先退回校准，不打入材料包。
  const packable: EntryRow[] = []
  const returned: { row: EntryRow; reason: string }[] = []
  for (const row of scoped) {
    if (parseParticipants(row['参演人数']) === null) {
      returned.push({
        row,
        reason: `登记的参演人数「${String(row['参演人数'] ?? '').trim() || '空'}」精度不足，需校准为整数人数`,
      })
    } else {
      packable.push(row)
    }
  }

  // 队伍名册来自全部演练记录；当期没有可打包演练的队伍给说明文件，不给空包。
  const teams = [
    ...new Set(rows.map((row) => String(row['参演队伍'] ?? '').trim()).filter((team) => team !== '')),
  ].sort((a, b) => a.localeCompare(b, 'zh'))

  const entries: ZipEntry[] = []
  let bundleCount = 0
  let noticeCount = 0
  let participantTotal = 0

  for (const team of teams) {
    const teamRows = packable.filter((row) => String(row['参演队伍']) === team)
    if (teamRows.length === 0) {
      noticeCount += 1
      const withheld = returned.some((item) => String(item.row['参演队伍']) === team)
      entries.push({
        name: `${safeFileName(team)}-${period}-无演练说明.txt`,
        content: buildTeamNotice(team, period, withheld),
      })
      continue
    }
    const dates = teamRows.map((row) => String(row['演练日期'] ?? '')).sort()
    const latestDate = dates[dates.length - 1] || period
    const bundle = buildTeamBundle(team, period, latestDate, teamRows)
    participantTotal += bundle.total
    bundleCount += 1
    entries.push({
      name: `${safeFileName(team)}-${latestDate}-评估材料.txt`,
      content: bundle.content,
    })
  }

  // 两处读到的参演人数要一致：材料包合计与按同一口径从台账复读的合计对不上就中止导出。
  const rereadTotal = drillExportScope(listRows(DRILL_KEY), period)
    .filter((row) => parseParticipants(row['参演人数']) !== null)
    .reduce((sum, row) => sum + (readParticipants(row).effective ?? 0), 0)
  if (rereadTotal !== participantTotal) {
    return {
      ok: false,
      message: `两处读到的参演人数不一致：材料包合计 ${participantTotal} 人，台账复读合计 ${rereadTotal} 人，已中止导出`,
    }
  }

  if (returned.length > 0) {
    entries.push({ name: `退回校准清单-${period}.txt`, content: buildReturnedList(period, returned) })
  }

  if (entries.length === 0) {
    return { ok: false, message: `${period} 期没有已评估的演练，也没有在册参演队伍，未生成材料包` }
  }

  const review = recordDrillReview(period, participantTotal, today)
  const summary: DrillMaterialSummary = {
    period,
    bundleCount,
    noticeCount,
    returnedCount: returned.length,
    participantTotal,
    reviewCode: review.code,
    reviewReused: review.reused,
  }
  const messageParts = [
    `已打包 ${bundleCount} 沓评估材料、${noticeCount} 份无演练说明，参演人数合计 ${participantTotal} 人`,
  ]
  if (returned.length > 0) {
    messageParts.push(`${returned.length} 条参演人数精度不足，已退回校准（见包内清单）`)
  }
  messageParts.push(
    review.reused
      ? `警示标识清单沿用已有演练复核项 ${review.code}，未新增记录`
      : `警示标识清单已新增演练复核项 ${review.code}`,
  )
  return {
    ok: true,
    message: messageParts.join('；'),
    filename: `应急演练评估材料-${period}.zip`,
    entries,
    summary,
  }
}

export function downloadDrillMaterials(today: Date = new Date()): DrillMaterialResult {
  const built = buildDrillMaterialPackage(today)
  if (!built.ok || !built.entries || !built.filename) {
    return { ok: false, message: built.message, summary: built.summary }
  }
  const blob = buildZip(built.entries)
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = built.filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
  return { ok: true, message: built.message, summary: built.summary }
}

// 演练页统计卡：与材料包同一口径读参演人数，两处读到的数一致。
export function drillSummary(): { label: string; value: number }[] {
  const rows = listRows(DRILL_KEY)
  const participantTotal = rows.reduce((sum, row) => sum + (readParticipants(row).effective ?? 0), 0)
  return [
    { label: '待组织演练', value: rows.filter((row) => String(row.status) === '待组织').length },
    { label: '已评估演练', value: rows.filter((row) => String(row.status) === '已评估').length },
    { label: '参演人数合计', value: participantTotal },
  ]
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
